const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { activeSessions } = require('../middleware/auth');

const router = express.Router();

router.get('/users', (req, res) => {
  const users = getDb().prepare('SELECT id, username, display_name FROM users ORDER BY id').all();
  res.json(users);
});

router.post('/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const user = getDb().prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const sessionToken = crypto.randomUUID();
  activeSessions.set(sessionToken, { userId: user.id, username: user.username, displayName: user.display_name });

  res.cookie('session', sessionToken, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: false
  });
  res.json(user);
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) activeSessions.delete(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.session;
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const session = activeSessions.get(token);
  const user = getDb().prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
