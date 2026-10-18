'use strict';
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  SESSION_COOKIE, verifyPassword, hashPassword, passwordProblem, createSession, destroySession,
  sessionCookieOptions, requireRole, audit,
} = require('../auth');
const { ValidationError, text, EMAIL_RE } = require('../validate');
const { settings } = require('../services');
const { setMeta, getMeta } = require('../db');

const ROLES = ['admin', 'editor', 'viewer'];

module.exports = function authRoutes({ db, demo }) {
  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });

  router.post('/auth/login', loginLimiter, (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!verifyPassword(password, user?.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const { token, expires } = createSession(db, user.id);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req, expires));
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  router.post('/auth/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const noUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    res.json({
      user: req.user,
      demo,
      setupNeeded: noUsers,
      demoAccounts: demo ? [
        { role: 'Admin', email: 'admin@demo.assetdesk', password: 'demo-password' },
        { role: 'Editor', email: 'editor@demo.assetdesk', password: 'demo-password' },
        { role: 'Viewer', email: 'viewer@demo.assetdesk', password: 'demo-password' },
      ] : undefined,
      settings: req.user ? settings(db) : { company_name: getMeta(db, 'company_name', 'My Company') },
    });
  });

  const blockInDemo = (req, res, next) => (demo
    ? res.status(403).json({ error: 'This is disabled in the public demo.' }) : next());

  router.post('/auth/password', requireRole('viewer'), blockInDemo, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body?.current_password || ''), user.password_hash)) {
      throw new ValidationError({ current_password: 'Current password is incorrect.' });
    }
    const problem = passwordProblem(req.body?.new_password);
    if (problem) throw new ValidationError({ new_password: problem });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.new_password), user.id);
    // Sign out other devices.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    const { token, expires } = createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req, expires));
    audit(db, req.user, 'user', user.id, 'password', `${user.name} changed their password`);
    res.json({ ok: true });
  });

  /* ---------- User management (admin) ---------- */
  const publicUser = 'id, email, name, role, active, created_at, last_login_at';

  router.get('/users', requireRole('admin'), (_req, res) => {
    res.json({ items: db.prepare(`SELECT ${publicUser} FROM users ORDER BY name`).all() });
  });

  router.post('/users', requireRole('admin'), blockInDemo, (req, res) => {
    const name = text(req.body?.name, 120);
    const email = text(req.body?.email, 160)?.toLowerCase();
    const role = req.body?.role;
    const errors = {};
    if (!name) errors.name = 'Name is required.';
    if (!email || !EMAIL_RE.test(email)) errors.email = 'A valid email is required.';
    if (!ROLES.includes(role)) errors.role = 'Choose a role.';
    const problem = passwordProblem(req.body?.password);
    if (problem) errors.password = problem;
    if (Object.keys(errors).length) throw new ValidationError(errors);
    const r = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(email, name, role, hashPassword(req.body.password));
    audit(db, req.user, 'user', r.lastInsertRowid, 'create', `Created user ${name} (${role})`);
    res.status(201).json(db.prepare(`SELECT ${publicUser} FROM users WHERE id = ?`).get(r.lastInsertRowid));
  });

  router.patch('/users/:id', requireRole('admin'), blockInDemo, (req, res) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const next = {
      name: req.body.name !== undefined ? text(req.body.name, 120) : target.name,
      role: req.body.role !== undefined ? req.body.role : target.role,
      active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : target.active,
    };
    if (!next.name) throw new ValidationError({ name: 'Name is required.' });
    if (!ROLES.includes(next.role)) throw new ValidationError({ role: 'Choose a role.' });
    const losingAdmin = target.role === 'admin' && target.active && (next.role !== 'admin' || !next.active);
    if (losingAdmin) {
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get().n;
      if (admins <= 1) throw new ValidationError({ role: 'There must always be at least one active admin.' });
    }
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?')
      .run(next.name, next.role, next.active, target.id);
    if (!next.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(db, req.user, 'user', target.id, 'update', `Updated user ${next.name}`, {
      ...(target.role !== next.role ? { role: [target.role, next.role] } : {}),
      ...(target.active !== next.active ? { active: [!!target.active, !!next.active] } : {}),
    });
    res.json(db.prepare(`SELECT ${publicUser} FROM users WHERE id = ?`).get(target.id));
  });

  router.post('/users/:id/password', requireRole('admin'), blockInDemo, (req, res) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new ValidationError({ password: problem });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(db, req.user, 'user', target.id, 'password', `Reset password for ${target.name}`);
    res.json({ ok: true });
  });

  /* ---------- Settings ---------- */
  router.get('/settings', requireRole('viewer'), (_req, res) => res.json(settings(db)));

  router.patch('/settings', requireRole('admin'), blockInDemo, (req, res) => {
    const before = settings(db);
    const errors = {};
    const company = req.body.company_name !== undefined ? text(req.body.company_name, 80) : before.company_name;
    const currency = req.body.currency !== undefined ? String(req.body.currency).toUpperCase().trim() : before.currency;
    const prefix = req.body.tag_prefix !== undefined ? String(req.body.tag_prefix).trim() : before.tag_prefix;
    if (!company) errors.company_name = 'Company name is required.';
    if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a 3-letter currency code, e.g. SAR or USD.';
    if (!/^[A-Za-z0-9-]{1,10}$/.test(prefix)) errors.tag_prefix = 'Use up to 10 letters, numbers or dashes.';
    if (Object.keys(errors).length) throw new ValidationError(errors);
    setMeta(db, 'company_name', company);
    setMeta(db, 'currency', currency);
    setMeta(db, 'tag_prefix', prefix);
    const after = settings(db);
    audit(db, req.user, 'settings', null, 'update', 'Updated settings',
      Object.fromEntries(Object.keys(after).filter((k) => after[k] !== before[k]).map((k) => [k, [before[k], after[k]]])));
    res.json(after);
  });

  return router;
};
