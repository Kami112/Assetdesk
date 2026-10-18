'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { requireRole, audit } = require('../auth');
const { CATEGORIES, STATUSES } = require('../db');
const { ASSET_SELECT, END_OF_LIFE_SQL, assetFilters, bookValue, today, addDays, likeEscape } = require('../services');

module.exports = function reportRoutes({ db, demo, publicUrl }) {
  const router = express.Router();

  router.get('/dashboard', requireRole('viewer'), (_req, res) => {
    const t = today();
    const in90 = addDays(t, 90);
    const active = `a.status NOT IN ('retired', 'lost')`;
    const one = (sql, ...p) => db.prepare(sql).get(...p);

    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM assets GROUP BY status').all()) byStatus[r.status] = r.n;

    const byCategory = db.prepare(`SELECT category, COUNT(*) AS n FROM assets a WHERE ${active}
      GROUP BY category ORDER BY n DESC`).all();

    // Book value needs per-row depreciation, so compute it in JS.
    let purchaseValue = 0;
    let currentValue = 0;
    for (const a of db.prepare(`SELECT category, purchase_cost, purchase_date FROM assets a WHERE ${active}`).all()) {
      purchaseValue += a.purchase_cost || 0;
      currentValue += bookValue(a) || 0;
    }

    // Spend per month for the last 12 months, including months with no purchases.
    const months = [];
    const d = new Date();
    d.setUTCDate(1);
    for (let i = 11; i >= 0; i--) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      months.push(m.toISOString().slice(0, 7));
    }
    const spendRows = Object.fromEntries(db.prepare(`SELECT substr(purchase_date, 1, 7) AS month, SUM(purchase_cost) AS total,
      COUNT(*) AS n FROM assets WHERE purchase_date >= ? GROUP BY month`).all(`${months[0]}-01`).map((r) => [r.month, r]));
    const spend = months.map((m) => ({ month: m, total: spendRows[m]?.total || 0, count: spendRows[m]?.n || 0 }));

    const warrantySoon = db.prepare(`${ASSET_SELECT} WHERE a.warranty_end BETWEEN ? AND ? AND ${active}
      ORDER BY a.warranty_end LIMIT 8`).all(t, in90);
    const refreshDue = one(`SELECT COUNT(*) AS n FROM assets a WHERE a.purchase_date IS NOT NULL
      AND ${END_OF_LIFE_SQL} <= ? AND ${active}`, in90).n;

    const licenses = db.prepare(`SELECT l.id, l.name, l.vendor, l.seats, l.expires_on, l.annual_cost,
      (SELECT COUNT(*) FROM license_seats s WHERE s.license_id = l.id) AS seats_used FROM licenses l`).all();
    const licensesExpiring = licenses.filter((l) => l.expires_on && l.expires_on >= t && l.expires_on <= in90)
      .sort((a, b) => a.expires_on.localeCompare(b.expires_on));
    const overAllocated = licenses.filter((l) => l.seats_used > l.seats);
    const unusedSeats = licenses.reduce((n, l) => n + Math.max(0, l.seats - l.seats_used), 0);
    // Estimated yearly cost of seats nobody is using.
    const unusedSeatCost = licenses.reduce((sum, l) => (l.annual_cost && l.seats
      ? sum + (Math.max(0, l.seats - l.seats_used) / l.seats) * l.annual_cost : sum), 0);

    const recent = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT 10').all();

    res.json({
      totals: {
        assets: one('SELECT COUNT(*) AS n FROM assets').n,
        active: one(`SELECT COUNT(*) AS n FROM assets a WHERE ${active}`).n,
        employees: one(`SELECT COUNT(*) AS n FROM employees WHERE status = 'active'`).n,
        licenses: licenses.length,
        purchaseValue: Math.round(purchaseValue),
        currentValue: Math.round(currentValue),
        warrantySoon: one(`SELECT COUNT(*) AS n FROM assets a WHERE a.warranty_end BETWEEN ? AND ? AND ${active}`, t, in90).n,
        warrantyExpired: one(`SELECT COUNT(*) AS n FROM assets a WHERE a.warranty_end < ? AND ${active}`, t).n,
        refreshDue,
        unusedSeats,
        unusedSeatCost: Math.round(unusedSeatCost),
      },
      byStatus,
      byCategory,
      spend,
      warrantySoon,
      licensesExpiring,
      overAllocated,
      recent,
    });
  });

  router.get('/audit', requireRole('viewer'), (req, res) => {
    const where = [];
    const params = [];
    if (req.query.entity) { where.push('entity = ?'); params.push(String(req.query.entity)); }
    if (req.query.q) {
      const like = `%${likeEscape(String(req.query.q))}%`;
      where.push(`(summary LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const pageSize = 50;
    const page = Math.max(1, Number(req.query.page) || 1);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${w}`).get(...params).n;
    const items = db.prepare(`SELECT * FROM audit_log ${w} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));
    res.json({ items, total, page, pageSize });
  });

  /** QR label data for printing. Each QR code links to /a/<tag>, which opens the asset after sign-in. */
  router.get('/labels', requireRole('viewer'), async (req, res, next) => {
    try {
      const { where, params } = assetFilters({ ...req.query, ids: req.query.ids || '' });
      const assets = db.prepare(`${ASSET_SELECT} ${where} ORDER BY a.tag LIMIT 500`).all(...params);
      const base = publicUrl || `${req.protocol}://${req.get('host')}`;
      const items = await Promise.all(assets.map(async (a) => ({
        id: a.id, tag: a.tag, name: a.name, serial: a.serial, category: a.category,
        qr: await QRCode.toString(`${base}/a/${encodeURIComponent(a.tag)}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
      })));
      res.json({ items });
    } catch (err) { next(err); }
  });

  /** Consistent point-in-time copy of the whole database, for admins to keep off-site. */
  router.get('/admin/backup', requireRole('admin'), (req, res, next) => {
    if (demo) return res.status(403).json({ error: 'This is disabled in the public demo.' });
    const file = path.join(os.tmpdir(), `assetdesk-backup-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      audit(db, req.user, 'settings', null, 'backup', 'Downloaded a database backup');
      res.download(file, `assetdesk-backup-${today()}.db`, (err) => {
        fs.rm(file, { force: true }, () => {});
        if (err && !res.headersSent) next(err);
      });
    } catch (err) {
      fs.rm(file, { force: true }, () => {});
      next(err);
    }
  });

  router.get('/meta', requireRole('viewer'), (_req, res) => res.json({ categories: CATEGORIES, statuses: STATUSES }));

  return router;
};
