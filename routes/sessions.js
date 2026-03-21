const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// List user's sessions
router.get('/', (req, res) => {
  const sessions = getDb().prepare(
    'SELECT id, title, description, status, created_at, updated_at FROM work_sessions WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.userId);
  res.json(sessions);
});

// Create new session
router.post('/', (req, res) => {
  const id = uuidv4();
  const { title } = req.body;
  getDb().prepare(
    'INSERT INTO work_sessions (id, user_id, title) VALUES (?, ?, ?)'
  ).run(id, req.user.userId, title || '');
  const session = getDb().prepare('SELECT * FROM work_sessions WHERE id = ?').get(id);
  res.json(session);
});

// Get full session with devices + components + units
router.get('/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const devices = db.prepare('SELECT * FROM session_devices WHERE session_id = ? ORDER BY position').all(session.id);

  for (const device of devices) {
    device.components_only = !!device.components_only;
    const components = db.prepare('SELECT * FROM session_components WHERE device_id = ? ORDER BY position').all(device.id);
    device.takilanComponents = [];
    device.components = [];

    for (const comp of components) {
      comp.units = db.prepare('SELECT * FROM session_component_units WHERE component_id = ? ORDER BY position').all(comp.id);
      if (comp.list_type === 'takilan') {
        device.takilanComponents.push(comp);
      } else {
        device.components.push(comp);
      }
    }
  }

  session.devices = devices;
  res.json(session);
});

// Update session metadata
router.put('/:id', (req, res) => {
  const { title, description, status } = req.body;
  const db = getDb();
  const session = db.prepare('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare("UPDATE work_sessions SET title = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title ?? session.title, description ?? session.description, status ?? session.status, req.params.id);

  res.json({ ok: true });
});

// Delete session
router.delete('/:id', (req, res) => {
  const db = getDb();
  // Delete devices first (cascade handles components and units)
  db.prepare('DELETE FROM session_devices WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM work_sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  res.json({ ok: true });
});

// Bulk save entire session state
router.post('/:id/save-all', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM work_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { description, devices } = req.body;

  const saveAll = db.transaction(() => {
    // Update session metadata
    db.prepare("UPDATE work_sessions SET description = ?, updated_at = datetime('now') WHERE id = ?")
      .run(description || '', req.params.id);

    // Clear existing devices (cascade deletes components and units)
    const existingDevices = db.prepare('SELECT id FROM session_devices WHERE session_id = ?').all(req.params.id);
    for (const ed of existingDevices) {
      const existingComps = db.prepare('SELECT id FROM session_components WHERE device_id = ?').all(ed.id);
      for (const ec of existingComps) {
        db.prepare('DELETE FROM session_component_units WHERE component_id = ?').run(ec.id);
      }
      db.prepare('DELETE FROM session_components WHERE device_id = ?').run(ed.id);
    }
    db.prepare('DELETE FROM session_devices WHERE session_id = ?').run(req.params.id);

    // Re-insert all devices
    if (!devices || !Array.isArray(devices)) return;

    const insertDevice = db.prepare(
      'INSERT INTO session_devices (session_id, position, model, etiket, seri, not_text, components_only) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertComp = db.prepare(
      'INSERT INTO session_components (device_id, list_type, position, type, qty, name, serial, health) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertUnit = db.prepare(
      'INSERT INTO session_component_units (component_id, position, name, serial, health) VALUES (?, ?, ?, ?, ?)'
    );

    devices.forEach((d, di) => {
      const deviceResult = insertDevice.run(
        req.params.id, di, d.model || '', d.etiket || '', d.seri || '',
        d.not || '', d.componentsOnly ? 1 : 0
      );
      const deviceId = deviceResult.lastInsertRowid;

      // Insert takilan components
      if (d.takilanComponents) {
        d.takilanComponents.forEach((c, ci) => {
          const compResult = insertComp.run(deviceId, 'takilan', ci, c.type || 'CPU', c.qty || 1, c.name || '', c.serial || '', c.health ?? '');
          if (c.units && c.units.length > 0) {
            c.units.forEach((u, ui) => {
              insertUnit.run(compResult.lastInsertRowid, ui, u.name || '', u.serial || '', u.health ?? '');
            });
          }
        });
      }

      // Insert cikarilan components
      if (d.components) {
        d.components.forEach((c, ci) => {
          const compResult = insertComp.run(deviceId, 'cikarilan', ci, c.type || 'CPU', c.qty || 1, c.name || '', c.serial || '', c.health ?? '');
          if (c.units && c.units.length > 0) {
            c.units.forEach((u, ui) => {
              insertUnit.run(compResult.lastInsertRowid, ui, u.name || '', u.serial || '', u.health ?? '');
            });
          }
        });
      }
    });
  });

  saveAll();

  const updated = db.prepare('SELECT updated_at FROM work_sessions WHERE id = ?').get(req.params.id);
  res.json({ ok: true, updated_at: updated.updated_at });
});

// Get session updated_at for sync polling
router.get('/:id/check', (req, res) => {
  const session = getDb().prepare('SELECT updated_at FROM work_sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ updated_at: session.updated_at });
});

module.exports = router;
