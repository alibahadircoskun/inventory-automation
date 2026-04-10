const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { asyncHandler } = require('../lib/async-handler');
const { createNotification, notifyManagers } = require('../lib/notifications');
const { revalidateSessionAgainstSnipe } = require('../lib/snipeit-sync');
const {
  canEditSession,
  cloneDevicesForDraft,
  insertSessionEvent,
  listSessionsForUser,
  loadSessionWithDevices,
  replaceSessionData
} = require('../lib/work-sessions');
const { requireFreshPin } = require('../middleware/auth');

const router = express.Router();
router.use(requireFreshPin);

function loadOwnedSession(sessionId, userId, { includeArchived = false } = {}) {
  const session = loadSessionWithDevices(getDb(), sessionId);
  if (!session || session.user_id !== userId) {
    return null;
  }
  if (!includeArchived && session.archived_at) {
    return null;
  }
  return session;
}

function ensureDraft(session, res) {
  if (!canEditSession(session)) {
    res.status(409).json({ error: 'Oturum mevcut durumunda düzenlemeye kilitli', status: session.status });
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  res.json(listSessionsForUser(getDb(), req.user.userId));
});

router.post('/', (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const title = String(req.body?.title || '').trim();
  db.prepare(`
    INSERT INTO work_sessions (id, user_id, title, status)
    VALUES (?, ?, ?, 'draft')
  `).run(id, req.user.userId, title);

  res.json(loadSessionWithDevices(db, id));
});

router.get('/:id', (req, res) => {
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }

  res.json(session);
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (!ensureDraft(session, res)) {
    return;
  }

  const title = req.body?.title ?? session.title;
  const description = req.body?.description ?? session.description;
  db.prepare(`
    UPDATE work_sessions
    SET title = ?, description = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, description, req.params.id);

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }

  if (session.status === 'draft') {
    db.prepare('DELETE FROM work_sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
    return res.json({ ok: true, deleted: true });
  }

  if (session.status === 'approved') {
    db.prepare(`
      UPDATE work_sessions
      SET archived_at = datetime('now'),
          archived_by_user_id = ?,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(req.user.userId, req.params.id, req.user.userId);
    insertSessionEvent(db, req.params.id, req.user.userId, 'archived', {});
    return res.json({ ok: true, archived: true });
  }

  return res.status(409).json({ error: 'Sadece taslak veya onaylı oturumlar silinebilir', status: session.status });
});

router.post('/:id/save-all', (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (!ensureDraft(session, res)) {
    return;
  }

  replaceSessionData(db, req.params.id, req.body?.description || '', req.body?.devices || []);
  const updated = db.prepare('SELECT updated_at FROM work_sessions WHERE id = ?').get(req.params.id);
  res.json({ ok: true, updated_at: updated.updated_at });
});

router.post('/:id/submit', asyncHandler(async (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (!ensureDraft(session, res)) {
    return;
  }

  const validation = await revalidateSessionAgainstSnipe(session);
  replaceSessionData(db, req.params.id, validation.session.description, validation.session.devices);
  if (!validation.ok) {
    return res.status(422).json({
      error: 'Oturum canlı envanter doğrulamasını geçemedi',
      issues: validation.issues
    });
  }

  db.prepare(`
    UPDATE work_sessions
    SET status = 'pending',
        submitted_at = datetime('now'),
        submitted_by = ?,
        reviewed_by = NULL,
        reviewed_at = NULL,
        review_comment = '',
        snipeit_sync_status = NULL,
        snipeit_sync_started_at = NULL,
        snipeit_sync_finished_at = NULL,
        snipeit_sync_summary = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.userId, req.params.id);
  insertSessionEvent(db, req.params.id, req.user.userId, 'submitted', {});

  notifyManagers({
    type: 'session_submitted',
    title: 'Yeni onay talebi',
    body: validation.session.title || req.params.id,
    data: { sessionId: req.params.id }
  });

  res.json(loadSessionWithDevices(db, req.params.id));
}));

router.post('/:id/reopen', (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'rejected') {
    return res.status(409).json({ error: 'Sadece reddedilen oturumlar yeniden açılabilir', status: session.status });
  }

  db.prepare(`
    UPDATE work_sessions
    SET status = 'draft',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(req.params.id);
  insertSessionEvent(db, req.params.id, req.user.userId, 'reopened', {});
  createNotification(req.user.userId, {
    type: 'session_reopened',
    title: 'Talep tekrar düzenlemeye açıldı',
    body: session.title || session.id,
    data: { sessionId: session.id }
  });

  res.json(loadSessionWithDevices(db, req.params.id));
});

router.post('/:id/edit-as-new', (req, res) => {
  const db = getDb();
  const session = loadOwnedSession(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'approved') {
    return res.status(409).json({ error: 'Sadece onaylı oturumlar yeni taslağa kopyalanabilir', status: session.status });
  }

  const newSessionId = uuidv4();
  const clonedDevices = cloneDevicesForDraft(session.devices || []);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO work_sessions (id, user_id, title, description, status, source_session_id)
      VALUES (?, ?, ?, '', 'draft', ?)
    `).run(newSessionId, req.user.userId, session.title || '', session.id);

    replaceSessionData(db, newSessionId, session.description || '', clonedDevices);
    insertSessionEvent(db, newSessionId, req.user.userId, 'created_from_approved', {
      source_session_id: session.id,
      source_title: session.title || ''
    });
    insertSessionEvent(db, session.id, req.user.userId, 'cloned_to_new_draft', {
      new_session_id: newSessionId
    });
  });

  tx();

  res.json(loadOwnedSession(newSessionId, req.user.userId));
});

router.get('/:id/check', (req, res) => {
  const session = getDb().prepare(`
    SELECT updated_at, status
    FROM work_sessions
    WHERE id = ? AND user_id = ? AND archived_at IS NULL
  `).get(req.params.id, req.user.userId);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  res.json(session);
});

module.exports = router;
