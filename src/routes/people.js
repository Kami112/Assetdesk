'use strict';
const express = require('express');
const { requireRole, audit, diff } = require('../auth');
const { transaction } = require('../db');
const { cleanEmployee, cleanLicense, ValidationError } = require('../validate');
const { ASSET_SELECT, likeEscape, bookValue } = require('../services');

const parseHistory = (rows) => rows.map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));

module.exports = function peopleRoutes({ db }) {
  const router = express.Router();

  /* ---------------- Employees ---------------- */
  router.get('/employees', requireRole('viewer'), (req, res) => {
    const where = [];
    const params = [];
    if (req.query.q) {
      const like = `%${likeEscape(String(req.query.q).trim())}%`;
      where.push(`(e.name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\' OR e.department LIKE ? ESCAPE '\\' OR e.title LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (['active', 'offboarded'].includes(req.query.status)) { where.push('e.status = ?'); params.push(req.query.status); }
    const items = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM assets a WHERE a.employee_id = e.id) AS asset_count,
        (SELECT COUNT(*) FROM license_seats s WHERE s.employee_id = e.id) AS license_count
      FROM employees e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.status, e.name`).all(...params);
    res.json({ items });
  });

  router.get('/employees/:id', requireRole('viewer'), (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const assets = db.prepare(`${ASSET_SELECT} WHERE a.employee_id = ? ORDER BY a.category, a.tag`).all(emp.id)
      .map((a) => ({ ...a, book_value: bookValue(a) }));
    const licenses = db.prepare(`SELECT l.id, l.name, l.vendor, l.expires_on, s.assigned_at
      FROM license_seats s JOIN licenses l ON l.id = s.license_id WHERE s.employee_id = ? ORDER BY l.name`).all(emp.id);
    // Includes asset events that mention this employee, so the timeline survives check-ins.
    const history = parseHistory(db.prepare(`
      SELECT * FROM audit_log
      WHERE (entity = 'employee' AND entity_id = ?)
         OR (entity IN ('asset', 'license') AND (summary LIKE ? ESCAPE '\\'))
      ORDER BY at DESC, id DESC LIMIT 100`).all(emp.id, `% ${likeEscape(emp.name)}%`));
    res.json({ ...emp, assets, licenses, history });
  });

  router.post('/employees', requireRole('editor'), (req, res) => {
    const data = cleanEmployee(req.body);
    const r = db.prepare('INSERT INTO employees (name, email, department, title, location) VALUES (?, ?, ?, ?, ?)')
      .run(data.name, data.email, data.department, data.title, data.location);
    audit(db, req.user, 'employee', r.lastInsertRowid, 'create', `Added employee ${data.name}`);
    res.status(201).json(db.prepare('SELECT * FROM employees WHERE id = ?').get(r.lastInsertRowid));
  });

  router.patch('/employees/:id', requireRole('editor'), (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const data = cleanEmployee({ ...emp, ...req.body });
    if (req.body.status === 'active' && emp.status === 'offboarded') data.status = 'active';
    const changes = diff(emp, data);
    if (Object.keys(changes).length) {
      const cols = Object.keys(changes);
      db.prepare(`UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((c) => data[c]), new Date().toISOString(), emp.id);
      audit(db, req.user, 'employee', emp.id, 'update', `Updated employee ${data.name}`, changes);
    }
    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(emp.id));
  });

  router.delete('/employees/:id', requireRole('admin'), (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const held = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE employee_id = ?').get(emp.id).n;
    if (held) throw new ValidationError({ employee: `${emp.name} still has ${held} asset(s). Offboard them first.` });
    transaction(db, () => {
      db.prepare('DELETE FROM employees WHERE id = ?').run(emp.id);
      audit(db, req.user, 'employee', emp.id, 'delete', `Deleted employee ${emp.name}`);
    });
    res.json({ ok: true });
  });

  /**
   * Offboarding: returns every asset to stock (or marks selected ones lost) and frees license seats,
   * all in one transaction so nothing is half-done.
   */
  router.post('/employees/:id/offboard', requireRole('editor'), (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const lostIds = new Set((Array.isArray(req.body.lost_asset_ids) ? req.body.lost_asset_ids : []).map(Number));
    const result = transaction(db, () => {
      const now = new Date().toISOString();
      const assets = db.prepare('SELECT * FROM assets WHERE employee_id = ?').all(emp.id);
      for (const a of assets) {
        const status = lostIds.has(a.id) ? 'lost' : 'in_stock';
        db.prepare('UPDATE assets SET employee_id = NULL, status = ?, updated_at = ? WHERE id = ?').run(status, now, a.id);
        audit(db, req.user, 'asset', a.id, 'checkin',
          `${status === 'lost' ? 'Marked lost' : 'Returned'} ${a.tag} from ${emp.name} during offboarding`,
          { employee: [emp.name, null], status: [a.status, status] });
      }
      const seats = db.prepare(`SELECT s.license_id, l.name FROM license_seats s JOIN licenses l ON l.id = s.license_id
        WHERE s.employee_id = ?`).all(emp.id);
      db.prepare('DELETE FROM license_seats WHERE employee_id = ?').run(emp.id);
      for (const s of seats) {
        audit(db, req.user, 'license', s.license_id, 'unassign', `Released ${s.name} seat from ${emp.name} during offboarding`);
      }
      db.prepare(`UPDATE employees SET status = 'offboarded', updated_at = ? WHERE id = ?`).run(now, emp.id);
      audit(db, req.user, 'employee', emp.id, 'offboard',
        `Offboarded ${emp.name}: ${assets.length} asset(s) returned, ${seats.length} license seat(s) released`);
      return { assets: assets.length, lost: assets.filter((a) => lostIds.has(a.id)).length, seats: seats.length };
    });
    res.json({ ok: true, ...result });
  });

  /* ---------------- Licenses ---------------- */
  const LICENSE_SELECT = `
    SELECT l.*, (SELECT COUNT(*) FROM license_seats s WHERE s.license_id = l.id) AS seats_used FROM licenses l`;
  // Viewers can see licenses but not the keys.
  const maskKey = (l, user) => (user.role === 'viewer' && l.license_key
    ? { ...l, license_key: `••••${l.license_key.slice(-4)}` } : l);

  router.get('/licenses', requireRole('viewer'), (req, res) => {
    const items = db.prepare(`${LICENSE_SELECT} ORDER BY l.expires_on IS NULL, l.expires_on, l.name`).all()
      .map((l) => maskKey(l, req.user));
    res.json({ items });
  });

  router.get('/licenses/:id', requireRole('viewer'), (req, res) => {
    const lic = db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).get(Number(req.params.id));
    if (!lic) return res.status(404).json({ error: 'License not found.' });
    const holders = db.prepare(`SELECT e.id, e.name, e.email, e.department, e.status, s.assigned_at
      FROM license_seats s JOIN employees e ON e.id = s.employee_id WHERE s.license_id = ? ORDER BY e.name`).all(lic.id);
    const history = parseHistory(db.prepare(`SELECT * FROM audit_log WHERE entity = 'license' AND entity_id = ?
      ORDER BY at DESC, id DESC LIMIT 100`).all(lic.id));
    res.json({ ...maskKey(lic, req.user), holders, history });
  });

  router.post('/licenses', requireRole('editor'), (req, res) => {
    const d = cleanLicense(req.body);
    const r = db.prepare(`INSERT INTO licenses (name, vendor, seats, license_key, expires_on, annual_cost, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(d.name, d.vendor, d.seats, d.license_key, d.expires_on, d.annual_cost, d.notes);
    audit(db, req.user, 'license', r.lastInsertRowid, 'create', `Added license ${d.name} (${d.seats} seats)`);
    res.status(201).json(db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).get(r.lastInsertRowid));
  });

  router.patch('/licenses/:id', requireRole('editor'), (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!lic) return res.status(404).json({ error: 'License not found.' });
    const d = cleanLicense({ ...lic, ...req.body });
    const changes = diff(lic, d);
    if (changes.license_key) changes.license_key = ['(hidden)', '(changed)'];
    if (Object.keys(changes).length) {
      const cols = Object.keys(changes);
      db.prepare(`UPDATE licenses SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((c) => d[c]), new Date().toISOString(), lic.id);
      audit(db, req.user, 'license', lic.id, 'update', `Updated license ${d.name}`, changes);
    }
    res.json(db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).get(lic.id));
  });

  router.delete('/licenses/:id', requireRole('admin'), (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!lic) return res.status(404).json({ error: 'License not found.' });
    transaction(db, () => {
      db.prepare('DELETE FROM licenses WHERE id = ?').run(lic.id);
      audit(db, req.user, 'license', lic.id, 'delete', `Deleted license ${lic.name}`);
    });
    res.json({ ok: true });
  });

  router.post('/licenses/:id/seats', requireRole('editor'), (req, res) => {
    const lic = db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).get(Number(req.params.id));
    if (!lic) return res.status(404).json({ error: 'License not found.' });
    const emp = db.prepare(`SELECT * FROM employees WHERE id = ? AND status = 'active'`).get(Number(req.body.employee_id));
    if (!emp) throw new ValidationError({ employee_id: 'Choose an active employee.' });
    if (lic.seats_used >= lic.seats && !req.body.allow_over) {
      throw new ValidationError({ seats: `All ${lic.seats} seats are in use. Add seats or free one up first.` });
    }
    const r = db.prepare('INSERT OR IGNORE INTO license_seats (license_id, employee_id) VALUES (?, ?)').run(lic.id, emp.id);
    if (r.changes) audit(db, req.user, 'license', lic.id, 'assign', `Assigned ${lic.name} seat to ${emp.name}`);
    res.json({ ok: true });
  });

  router.delete('/licenses/:id/seats/:employeeId', requireRole('editor'), (req, res) => {
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.employeeId));
    if (!lic || !emp) return res.status(404).json({ error: 'Not found.' });
    const r = db.prepare('DELETE FROM license_seats WHERE license_id = ? AND employee_id = ?').run(lic.id, emp.id);
    if (r.changes) audit(db, req.user, 'license', lic.id, 'unassign', `Released ${lic.name} seat from ${emp.name}`);
    res.json({ ok: true });
  });

  return router;
};
