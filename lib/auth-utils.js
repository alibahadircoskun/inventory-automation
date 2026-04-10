const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PIN_PATTERN = /^\d{6}$/;

function nowIso() {
  return new Date().toISOString();
}

function futureIso(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function isValidPin(pin) {
  return PIN_PATTERN.test(String(pin || ''));
}

function hashPin(pin) {
  if (!isValidPin(pin)) {
    throw new Error('PIN must be exactly 6 digits');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPin(pin, storedHash) {
  if (!storedHash || !isValidPin(pin)) {
    return false;
  }

  const [salt, stored] = String(storedHash).split(':');
  if (!salt || !stored) {
    return false;
  }

  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(stored, 'hex'));
}

function createSessionToken() {
  return crypto.randomUUID();
}

function generateTemporaryPin() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function getCookieOptions(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const secure = process.env.COOKIE_SECURE === 'true'
    || req.secure
    || forwardedProto === 'https';

  return {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: 'lax',
    secure
  };
}

module.exports = {
  SESSION_TTL_MS,
  MAX_FAILED_PIN_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  createSessionToken,
  futureIso,
  generateTemporaryPin,
  getCookieOptions,
  hashPin,
  isValidPin,
  nowIso,
  verifyPin
};
