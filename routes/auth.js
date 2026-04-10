const express = require('express');
const { getDb } = require('../db');
const { loadSession, requireAuth } = require('../middleware/auth');
const {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_PIN_ATTEMPTS,
  SESSION_TTL_MS,
  createSessionToken,
  futureIso,
  getCookieOptions,
  hashPin,
  isValidPin,
  verifyPin
} = require('../lib/auth-utils');

const router = express.Router();

router.get('/users', (req, res) => {
  const users = getDb().prepare('SELECT id, username, display_name FROM users ORDER BY id').all();
  res.json(users);
});

router.post('/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !isValidPin(pin)) {
    return res.status(400).json({ error: 'Kullanıcı adı ve 6 haneli PIN gerekli' });
  }

  const db = getDb();
  const user = db.prepare(`
    SELECT
      id,
      username,
      display_name,
      role,
      pin_hash,
      must_change_pin,
      failed_pin_attempts,
      locked_until
    FROM users
    WHERE username = ?
  `).get(username);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  if (!user.pin_hash) {
    return res.status(403).json({ error: 'Bu hesap için PIN tanımlanmamış' });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return res.status(423).json({ error: 'Hesap geçici olarak kilitlendi', locked_until: user.locked_until });
  }

  if (!verifyPin(pin, user.pin_hash)) {
    const failedAttempts = (user.failed_pin_attempts || 0) + 1;
    const lockAccount = failedAttempts >= MAX_FAILED_PIN_ATTEMPTS;
    db.prepare(`
      UPDATE users
      SET failed_pin_attempts = ?,
          locked_until = ?,
          must_change_pin = must_change_pin
      WHERE id = ?
    `).run(
      lockAccount ? 0 : failedAttempts,
      lockAccount ? futureIso(LOCKOUT_DURATION_MS) : null,
      user.id
    );

    return res.status(lockAccount ? 423 : 401).json({
      error: lockAccount ? 'Hesap geçici olarak kilitlendi' : 'Geçersiz PIN'
    });
  }

  db.prepare('UPDATE users SET failed_pin_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  const sessionToken = createSessionToken();
  db.prepare(`
    INSERT INTO auth_sessions (token, user_id, expires_at, last_seen_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(sessionToken, user.id, futureIso(SESSION_TTL_MS));

  res.cookie('session', sessionToken, getCookieOptions(req));
  res.json({
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    must_change_pin: !!user.must_change_pin
  });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }
  res.clearCookie('session', getCookieOptions(req));
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.userId,
    username: req.user.username,
    display_name: req.user.displayName,
    role: req.user.role,
    must_change_pin: !!req.user.mustChangePin
  });
});

router.post('/change-pin', requireAuth, (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (!isValidPin(currentPin) || !isValidPin(newPin)) {
    return res.status(400).json({ error: 'Mevcut PIN ve yeni PIN 6 haneli olmalıdır' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, pin_hash FROM users WHERE id = ?').get(req.user.userId);
  if (!user || !verifyPin(currentPin, user.pin_hash)) {
    return res.status(401).json({ error: 'Mevcut PIN geçersiz' });
  }

  db.prepare(`
    UPDATE users
    SET pin_hash = ?,
        must_change_pin = 0,
        pin_changed_at = datetime('now'),
        failed_pin_attempts = 0,
        locked_until = NULL
    WHERE id = ?
  `).run(hashPin(newPin), req.user.userId);

  const refreshed = loadSession(req.cookies?.session);
  res.json({
    ok: true,
    user: {
      id: req.user.userId,
      username: req.user.username,
      display_name: req.user.displayName,
      role: req.user.role,
      must_change_pin: refreshed ? !!refreshed.mustChangePin : false
    }
  });
});

module.exports = router;
