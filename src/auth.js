'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'assetdesk_sid';
const SESSION_HOURS = 12;
const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 10;
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// Compared against when the email is unknown, so response time doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash || DUMMY_HASH) && Boolean(hash);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password is too long.';
  return null;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
  // Only a hash of the token is stored, so a leaked database backup can't be used to hijack sessions.
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), expires.toISOString());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  return { token, expires };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookieOptions(req, expires) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

/** Attaches req.user (or null) from the session cookie. */
function loadUser(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    req.sessionToken = token;
    req.user = token ? stmt.get(sha256(token), new Date().toISOString()) || null : null;
    next();
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) {
      return res.status(403).json({ error: 'You do not have permission to do this.' });
    }
    next();
  };
}

/**
 * CSRF defence: state-changing API calls must carry a custom header. Browsers only send custom
 * headers cross-origin after a CORS preflight, which this app never approves.
 */
function requireAjaxHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'AssetDesk') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

/** Records an audit entry. `changes` is an optional { field: [before, after] } map. */
function audit(db, user, entity, entityId, action, summary, changes = null) {
  db.prepare(`INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, summary, changes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(user ? user.id : null, user ? user.name : 'System', entity, entityId ?? null, action, summary,
      changes && Object.keys(changes).length ? JSON.stringify(changes) : null);
}

/** Returns { field: [before, after] } for the fields in `after` whose values differ from `before`. */
function diff(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    const a = before ? before[key] ?? null : null;
    const b = after[key] ?? null;
    if (a !== b) changes[key] = [a, b];
  }
  return changes;
}

module.exports = {
  SESSION_COOKIE, ROLE_RANK, hashPassword, verifyPassword, passwordProblem, createSession, destroySession,
  sessionCookieOptions, loadUser, requireRole, requireAjaxHeader, audit, diff,
};
