const { getDb } = require('../db');

function loadSession(token) {
  if (!token) {
    return null;
  }

  const db = getDb();
  const session = db.prepare(`
    SELECT
      auth_sessions.token,
      auth_sessions.user_id,
      auth_sessions.expires_at,
      users.username,
      users.display_name,
      users.role,
      users.must_change_pin
    FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token = ?
      AND datetime(auth_sessions.expires_at) > datetime('now')
  `).get(token);

  if (!session) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return null;
  }

  db.prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token = ?").run(token);

  return {
    token: session.token,
    userId: session.user_id,
    username: session.username,
    displayName: session.display_name,
    role: session.role,
    mustChangePin: !!session.must_change_pin
  };
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  const session = loadSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.user = session;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role !== role) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    });
  };
}

function requireFreshPin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.mustChangePin) {
      return res.status(403).json({ error: 'PIN change required' });
    }
    next();
  });
}

function requireSessionOwnerOrManager(getSessionId) {
  const resolver = typeof getSessionId === 'function'
    ? getSessionId
    : (req) => req.params.id;

  return (req, res, next) => {
    requireAuth(req, res, () => {
      const sessionId = resolver(req);
      const session = getDb().prepare('SELECT id, user_id, status FROM work_sessions WHERE id = ?').get(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (req.user.role !== 'manager' && session.user_id !== req.user.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.targetSession = session;
      next();
    });
  };
}

module.exports = {
  loadSession,
  requireAuth,
  requireFreshPin,
  requireRole,
  requireSessionOwnerOrManager
};
