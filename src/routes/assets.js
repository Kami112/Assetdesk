'use strict';
const express = require('express');
const { requireRole, audit, diff } = require('../auth');
const { transaction, nextAssetTag, STATUSES } = require('../db');
const { cleanAsset, ValidationError, text } = require('../validate');
const { ASSET_SELECT, assetFilters, orderBy, bookValue } = require('../services');

const FIELDS = ['tag', 'name', 'category', 'manufacturer', 'model', 'serial', 'status', 'employee_id',
  'department', 'location', 'purchase_date', 'purchase_cost', 'supplier', 'warranty_end', 'notes'];

module.exports = function assetRoutes({ db }) {
  const router = express.Router();
  const getAsset = (id) => db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(Number(id));
  const employeeExists = (id) => id == null || !!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(id);

  router.get('/assets', requireRole('viewer'), (req, res) => {
    const { where, params } = assetFilters(req.query);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const from = 'FROM assets a LEFT JOIN employees e ON e.id = a.employee_id';
    const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params).n;
    const items = db.prepare(`${ASSET_SELECT} ${where} ${orderBy(req.query)} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map((a) => ({ ...a, book_value: bookValue(a) }));
    const facet = (col) => db.prepare(`SELECT DISTINCT ${col} AS v FROM assets WHERE ${col} IS NOT NULL ORDER BY 1`)
      .all().map((r) => r.v);
    res.json({ items, total, page, pageSize, facets: { locations: facet('location'), departments: facet('department') } });
  });

  router.get('/assets/next-tag', requireRole('editor'), (_req, res) => res.json({ tag: nextAssetTag(db) }));

  router.get('/assets/by-tag/:tag', requireRole('viewer'), (req, res) => {
    const row = db.prepare('SELECT id FROM assets WHERE tag = ? OR serial = ?').get(req.params.tag, req.params.tag);
    if (!row) return res.status(404).json({ error: 'No asset with that tag or serial number.' });
    res.json(row);
  });

  router.get('/assets/:id', requireRole('viewer'), (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    const history = db.prepare(`SELECT * FROM audit_log WHERE entity = 'asset' AND entity_id = ? ORDER BY at DESC, id DESC LIMIT 100`)
      .all(asset.id).map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));
    res.json({ ...asset, book_value: bookValue(asset), history });
  });

  function saveAsset(req, existing) {
    const data = cleanAsset(req.body, { partial: !!existing });
    if (!existing && !data.tag) data.tag = nextAssetTag(db);
    if (existing && 'tag' in data && !data.tag) throw new ValidationError({ tag: 'Asset tag is required.' });
    if ('employee_id' in data && !employeeExists(data.employee_id)) {
      throw new ValidationError({ employee_id: 'That employee does not exist.' });
    }
    // Keep status and assignment consistent: assigning someone means the asset is in use.
    if (data.employee_id && !('status' in req.body)) data.status = 'in_use';
    if (['in_stock', 'retired', 'lost'].includes(data.status) && !data.employee_id) data.employee_id = null;
    if (data.employee_id && ['in_stock', 'retired', 'lost'].includes(data.status)) {
      throw new ValidationError({ status: 'An asset assigned to someone must be "In use" or "In repair".' });
    }
    return data;
  }

  router.post('/assets', requireRole('editor'), (req, res) => {
    const data = saveAsset(req, null);
    const cols = FIELDS.filter((f) => f in data);
    const id = transaction(db, () => {
      const r = db.prepare(`INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => data[c]));
      audit(db, req.user, 'asset', r.lastInsertRowid, 'create', `Created ${data.tag} (${data.name})`);
      return r.lastInsertRowid;
    });
    res.status(201).json(getAsset(id));
  });

  router.patch('/assets/:id', requireRole('editor'), (req, res) => {
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });
    const data = saveAsset(req, existing);
    const changes = diff(existing, data);
    if (Object.keys(changes).length) {
      transaction(db, () => {
        const cols = Object.keys(changes);
        db.prepare(`UPDATE assets SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...cols.map((c) => data[c]), new Date().toISOString(), existing.id);
        audit(db, req.user, 'asset', existing.id, 'update', `Updated ${existing.tag}`, changes);
      });
    }
    res.json(getAsset(existing.id));
  });

  router.delete('/assets/:id', requireRole('admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });
    transaction(db, () => {
      db.prepare('DELETE FROM assets WHERE id = ?').run(existing.id);
      audit(db, req.user, 'asset', existing.id, 'delete', `Deleted ${existing.tag} (${existing.name})`);
    });
    res.json({ ok: true });
  });

  router.post('/assets/:id/checkout', requireRole('editor'), (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    if (['retired', 'lost'].includes(asset.status)) {
      throw new ValidationError({ status: 'Retired or lost assets cannot be checked out.' });
    }
    const emp = db.prepare(`SELECT * FROM employees WHERE id = ? AND status = 'active'`).get(Number(req.body.employee_id));
    if (!emp) throw new ValidationError({ employee_id: 'Choose an active employee.' });
    const note = text(req.body.note, 500);
    transaction(db, () => {
      db.prepare(`UPDATE assets SET employee_id = ?, status = 'in_use', department = COALESCE(?, department),
                  location = COALESCE(?, location), updated_at = ? WHERE id = ?`)
        .run(emp.id, emp.department, emp.location, new Date().toISOString(), asset.id);
      audit(db, req.user, 'asset', asset.id, 'checkout',
        `Checked out ${asset.tag} to ${emp.name}${note ? ` (${note})` : ''}`,
        { employee: [asset.employee_name, emp.name], status: [asset.status, 'in_use'] });
    });
    res.json(getAsset(asset.id));
  });

  router.post('/assets/:id/checkin', requireRole('editor'), (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    const status = ['in_stock', 'in_repair', 'retired', 'lost'].includes(req.body.status) ? req.body.status : 'in_stock';
    const note = text(req.body.note, 500);
    transaction(db, () => {
      db.prepare('UPDATE assets SET employee_id = NULL, status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), asset.id);
      audit(db, req.user, 'asset', asset.id, 'checkin',
        `Checked in ${asset.tag}${asset.employee_name ? ` from ${asset.employee_name}` : ''}${note ? ` (${note})` : ''}`,
        { employee: [asset.employee_name, null], status: [asset.status, status] });
    });
    res.json(getAsset(asset.id));
  });

  router.post('/assets/bulk', requireRole('editor'), (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 1000) : [];
    if (!ids.length) throw new ValidationError({ ids: 'Select at least one asset.' });
    const { action } = req.body;
    if (action === 'delete' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete assets.' });
    }
    let value = null;
    if (action === 'status') {
      if (!STATUSES.includes(req.body.value)) throw new ValidationError({ value: 'Choose a status.' });
      value = req.body.value;
    } else if (action === 'location') {
      value = text(req.body.value, 120);
      if (!value) throw new ValidationError({ value: 'Enter a location.' });
    } else if (action !== 'delete') {
      throw new ValidationError({ action: 'Unknown bulk action.' });
    }
    let count = 0;
    transaction(db, () => {
      const now = new Date().toISOString();
      for (const id of ids) {
        const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
        if (!a) continue;
        count += 1;
        if (action === 'delete') {
          db.prepare('DELETE FROM assets WHERE id = ?').run(id);
          audit(db, req.user, 'asset', id, 'delete', `Deleted ${a.tag} (${a.name}) in bulk`);
        } else if (action === 'status' && a.status !== value) {
          const clear = ['in_stock', 'retired', 'lost'].includes(value);
          db.prepare(`UPDATE assets SET status = ?, employee_id = ${clear ? 'NULL' : 'employee_id'}, updated_at = ? WHERE id = ?`)
            .run(value, now, id);
          audit(db, req.user, 'asset', id, 'update', `Changed ${a.tag} status in bulk`, { status: [a.status, value] });
        } else if (action === 'location' && a.location !== value) {
          db.prepare('UPDATE assets SET location = ?, updated_at = ? WHERE id = ?').run(value, now, id);
          audit(db, req.user, 'asset', id, 'update', `Moved ${a.tag} in bulk`, { location: [a.location, value] });
        }
      }
    });
    res.json({ ok: true, count });
  });

  return router;
};
