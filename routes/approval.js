const express = require('express');
const { asyncHandler } = require('../lib/async-handler');
const { getDb } = require('../db');
const { fetchCurrentDeviceStateSnapshot } = require('../lib/current-device-state');
const { createNotification } = require('../lib/notifications');
const { getSnipeItClient } = require('../lib/snipeit-client');
const { revertApprovedSession, syncApprovedSession } = require('../lib/snipeit-sync');
const { insertSessionEvent, loadSessionWithDevices, parseJsonColumn } = require('../lib/work-sessions');
const { requireFreshPin, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireFreshPin);
router.use(requireRole('manager'));

function loadReviewSession(sessionId) {
  const session = loadSessionWithDevices(getDb(), sessionId);
  if (!session || session.archived_at) {
    return null;
  }
  return session;
}

function loadSyncAuditLog(sessionId) {
  return getDb().prepare(`
    SELECT
      id,
      created_at,
      operation,
      snipeit_endpoint,
      request_payload,
      response_status,
      response_body,
      success,
      idempotency_key
    FROM sync_audit_log
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(sessionId).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    operation: row.operation,
    endpoint: row.snipeit_endpoint,
    request_payload: parseJsonColumn(row.request_payload, null),
    response_status: row.response_status,
    response_body: parseJsonColumn(row.response_body, row.response_body || null),
    success: !!row.success,
    idempotency_key: row.idempotency_key
  }));
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  const db = getDb();
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM work_sessions
    WHERE archived_at IS NULL
    GROUP BY status
  `).all();
  const recent = db.prepare(`
    SELECT
      id,
      title,
      status,
      updated_at,
      snipeit_sync_status
    FROM work_sessions
    WHERE archived_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 8
  `).all();

  const client = getSnipeItClient();
  let snipe = { configured: client.isConfigured(), healthy: false, dry_run: client.dryRun };
  if (client.isConfigured()) {
    try {
      await client.request('GET', 'statuslabels', { query: { limit: 1 } });
      snipe.healthy = true;
    } catch (error) {
      snipe.error = error.message;
    }
  }

  res.json({
    counts: counts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {}),
    recent,
    snipe
  });
}));

router.get('/queue', (req, res) => {
  const status = String(req.query.status || 'pending').trim();
  const allowedStatuses = new Set(['pending', 'approved', 'rejected']);
  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ error: 'Desteklenmeyen kuyruk durumu' });
  }

  const rows = getDb().prepare(`
    SELECT
      ws.id,
      ws.title,
      ws.description,
      ws.status,
      ws.created_at,
      ws.updated_at,
      ws.submitted_at,
      ws.reviewed_at,
      ws.review_comment,
      ws.snipeit_sync_status,
      ws.snipeit_sync_summary,
      ws.source_session_id,
      source.title AS source_title,
      source.status AS source_status,
      users.id AS owner_id,
      users.username AS owner_username,
      users.display_name AS owner_display_name
    FROM work_sessions ws
    JOIN users ON users.id = ws.user_id
    LEFT JOIN work_sessions source ON source.id = ws.source_session_id
    WHERE ws.status = ?
      AND ws.archived_at IS NULL
    ORDER BY COALESCE(ws.submitted_at, ws.updated_at) ASC
  `).all(status).map((row) => ({
    ...row,
    owner: {
      id: row.owner_id,
      username: row.owner_username,
      display_name: row.owner_display_name
    },
    sourceSession: row.source_session_id ? {
      id: row.source_session_id,
      title: row.source_title || '',
      status: row.source_status || 'draft'
    } : null,
    snipeit_sync_summary: parseJsonColumn(row.snipeit_sync_summary, null)
  }));

  res.json(rows);
});

router.get('/:id', (req, res) => {
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }

  res.json({
    ...session,
    auditLog: loadSyncAuditLog(req.params.id)
  });
});

router.post('/:id/approve', asyncHandler(async (req, res) => {
  const db = getDb();
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'pending') {
    return res.status(409).json({ error: 'Sadece bekleyen oturumlar onaylanabilir', status: session.status });
  }

  const reviewComment = String(req.body?.comment || '').trim();
  const managerOverrides = req.body?.managerOverrides && typeof req.body.managerOverrides === 'object'
    ? req.body.managerOverrides
    : [];

  db.prepare(`
    UPDATE work_sessions
    SET status = 'approved',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        review_comment = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.userId, reviewComment, req.params.id);
  insertSessionEvent(db, req.params.id, req.user.userId, 'approved', {
    comment: reviewComment
  });

  const summary = await syncApprovedSession(req.params.id, {
    actorUserId: req.user.userId,
    managerOverrides
  });

  createNotification(session.owner.id, {
    type: 'session_approved',
    title: 'Talep onaylandı',
    body: session.title || session.id,
    data: { sessionId: session.id, sync_status: summary.status }
  });

  res.json({
    session: {
      ...loadReviewSession(req.params.id),
      auditLog: loadSyncAuditLog(req.params.id)
    },
    sync: summary
  });
}));

router.post('/:id/unapprove', asyncHandler(async (req, res) => {
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'approved') {
    return res.status(409).json({ error: 'Sadece onaylı oturumların onayı geri alınabilir', status: session.status });
  }
  if (session.snipeit_sync_status === 'running') {
    return res.status(409).json({ error: 'Geri alma başlamadan önce eşitleme tamamlanmalı', sync_status: session.snipeit_sync_status });
  }

  const comment = String(req.body?.comment || '').trim();
  const rollback = await revertApprovedSession(req.params.id, {
    actorUserId: req.user.userId,
    comment
  });

  if (rollback.status !== 'success') {
    return res.status(502).json({
      error: rollback.issues?.[0] || 'Envanter değişiklikleri tamamen geri alınamadı',
      rollback,
      session: {
        ...loadReviewSession(req.params.id),
        auditLog: loadSyncAuditLog(req.params.id)
      }
    });
  }

  res.json({
    session: {
      ...loadReviewSession(req.params.id),
      auditLog: loadSyncAuditLog(req.params.id)
    },
    rollback
  });
}));

router.post('/:id/reject', (req, res) => {
  const db = getDb();
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'pending') {
    return res.status(409).json({ error: 'Sadece bekleyen oturumlar reddedilebilir', status: session.status });
  }

  const reviewComment = String(req.body?.comment || '').trim();
  if (!reviewComment) {
    return res.status(400).json({ error: 'Ret notu zorunludur' });
  }

  db.prepare(`
    UPDATE work_sessions
    SET status = 'rejected',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        review_comment = ?,
        snipeit_sync_status = NULL,
        snipeit_sync_started_at = NULL,
        snipeit_sync_finished_at = NULL,
        snipeit_sync_summary = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.userId, reviewComment, req.params.id);
  insertSessionEvent(db, req.params.id, req.user.userId, 'rejected', {
    comment: reviewComment
  });

  createNotification(session.owner.id, {
    type: 'session_rejected',
    title: 'Talep reddedildi',
    body: session.title || session.id,
    data: { sessionId: session.id, comment: reviewComment }
  });

  res.json(loadReviewSession(req.params.id));
});

router.post('/:id/retry-sync', asyncHandler(async (req, res) => {
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (session.status !== 'approved') {
    return res.status(409).json({ error: 'Sadece onaylı oturumlar eşitlemeyi yeniden deneyebilir', status: session.status });
  }
  if (!['failed', 'partial'].includes(session.snipeit_sync_status)) {
    return res.status(409).json({ error: 'Eşitlemeyi yeniden deneme yalnızca başarısız veya kısmi oturumlarda kullanılabilir', sync_status: session.snipeit_sync_status });
  }

  const summary = await syncApprovedSession(req.params.id, {
    actorUserId: req.user.userId,
    isRetry: true
  });

  res.json({
    session: {
      ...loadReviewSession(req.params.id),
      auditLog: loadSyncAuditLog(req.params.id)
    },
    sync: summary
  });
}));

router.post('/:id/devices/:deviceId/current-state/refresh', asyncHandler(async (req, res) => {
  const db = getDb();
  const session = loadReviewSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Oturum bulunamadı' });
  }
  if (!['pending', 'approved'].includes(session.status)) {
    return res.status(409).json({ error: 'Mevcut durum yalnızca bekleyen veya onaylı oturumlarda yenilenebilir', status: session.status });
  }

  const device = (session.devices || []).find((item) => Number(item.id) === Number(req.params.deviceId));
  if (!device) {
    return res.status(404).json({ error: 'Cihaz bulunamadı' });
  }
  if (device.assetResolutionMode !== 'matched' || !device.snipeitAssetId) {
    return res.status(409).json({ error: 'Yalnızca eşleşmiş sunucular için mevcut durum yenilenebilir' });
  }

  const fetchedAt = new Date().toISOString();
  const snapshot = await fetchCurrentDeviceStateSnapshot(device.snipeitAssetId, getSnipeItClient());

  db.prepare(`
    UPDATE session_devices
    SET current_state_snapshot = ?,
        current_state_fetched_at = ?
    WHERE id = ?
  `).run(JSON.stringify(snapshot), fetchedAt, device.id);

  insertSessionEvent(db, req.params.id, req.user.userId, 'current_state_refreshed', {
    device_id: device.id,
    asset_id: device.snipeitAssetId
  });

  res.json({
    session: {
      ...loadReviewSession(req.params.id),
      auditLog: loadSyncAuditLog(req.params.id)
    },
    fetched_at: fetchedAt,
    refreshed_device_id: device.id
  });
}));

module.exports = router;
