const { getDb } = require('../db');
const { parseJsonColumn, stringifyJson } = require('./work-sessions');

function createNotification(userId, { type, title, body = '', data = null }) {
  return getDb().prepare(`
    INSERT INTO notifications (user_id, type, title, body, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, title, body, stringifyJson(data));
}

function notifyManagers(payload) {
  const managers = getDb().prepare("SELECT id FROM users WHERE role = 'manager'").all();
  for (const manager of managers) {
    createNotification(manager.id, payload);
  }
}

function listNotificationsForUser(userId, limit = 20) {
  const rows = getDb().prepare(`
    SELECT id, type, title, body, data, read_at, created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, limit);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body || '',
    data: parseJsonColumn(row.data, null),
    read_at: row.read_at,
    created_at: row.created_at
  }));
}

function unreadNotificationCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).count;
}

function markNotificationRead(userId, notificationId) {
  return getDb().prepare(`
    UPDATE notifications
    SET read_at = COALESCE(read_at, datetime('now'))
    WHERE id = ? AND user_id = ?
  `).run(notificationId, userId);
}

function markAllNotificationsRead(userId) {
  return getDb().prepare(`
    UPDATE notifications
    SET read_at = COALESCE(read_at, datetime('now'))
    WHERE user_id = ? AND read_at IS NULL
  `).run(userId);
}

module.exports = {
  createNotification,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  notifyManagers,
  unreadNotificationCount
};
