const activeSessions = new Map();

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = activeSessions.get(token);
  next();
}

module.exports = { requireAuth, activeSessions };
