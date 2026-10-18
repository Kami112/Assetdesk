'use strict';
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { requireRole, audit } = require('../auth');
const { transaction, nextAssetTag, getMeta, CATEGORIES } = require('../db');
const { cleanAsset, ValidationError, text, EMAIL_RE } = require('../validate');
const { ASSET_SELECT, assetFilters, orderBy, bookValue, today } = require('../services');

const MAX_ROWS = 5000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

const STATUS_LABELS = { in_use: 'In use', in_stock: 'In stock', in_repair: 'In repair', retired: 'Retired', lost: 'Lost' };

// Column headers people actually use in inventory spreadsheets, per field.
const HEADER_SYNONYMS = {
  tag: ['asset tag', 'tag', 'asset id', 'asset no', 'asset number', 'asset', 'inventory number', 'inventory no', 'tag number', 'barcode'],
  name: ['name', 'asset name', 'description', 'item', 'item name', 'device name', 'hostname', 'computer name', 'device', 'title'],
  category: ['category', 'type', 'asset type', 'device type', 'class', 'asset class', 'equipment type'],
  manufacturer: ['manufacturer', 'make', 'brand', 'vendor', 'oem'],
  model: ['model', 'model name', 'model number', 'model no'],
  serial: ['serial', 'serial number', 'serial no', 's n', 'sn', 'service tag', 'imei', 'serial num'],
  status: ['status', 'state', 'condition', 'asset status'],
  assignee: ['assigned to', 'user', 'owner', 'employee', 'assignee', 'holder', 'custodian', 'checked out to', 'employee name', 'user name', 'assigned user'],
  assignee_email: ['assigned email', 'email', 'user email', 'employee email', 'owner email', 'assignee email', 'e mail'],
  department: ['department', 'dept', 'team', 'division', 'business unit', 'cost center'],
  location: ['location', 'site', 'office', 'room', 'building', 'branch', 'city'],
  purchase_date: ['purchase date', 'purchased', 'date purchased', 'bought', 'acquired', 'acquisition date', 'purchased on', 'invoice date'],
  purchase_cost: ['purchase cost', 'cost', 'price', 'purchase price', 'value', 'amount', 'unit cost', 'unit price'],
  supplier: ['supplier', 'seller', 'reseller', 'purchased from', 'distributor'],
  warranty_end: ['warranty end', 'warranty', 'warranty expiry', 'warranty expires', 'warranty until', 'warranty date', 'warranty expiration', 'warranty end date'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
};
const IGNORED_HEADERS = ['book value', 'current value'];

const squashHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Maps each spreadsheet header to a field, preferring exact synonym matches, then whole-word containment. */
function mapHeaders(headers) {
  const mapping = new Array(headers.length).fill(null);
  const used = new Set();
  const norm = headers.map(squashHeader);
  // Pass 1: exact matches.
  norm.forEach((h, i) => {
    if (!h || IGNORED_HEADERS.includes(h)) return;
    for (const [field, words] of Object.entries(HEADER_SYNONYMS)) {
      if (!used.has(field) && words.includes(h)) { mapping[i] = field; used.add(field); return; }
    }
  });
  // Pass 2: the header contains a synonym as whole words (longest synonym wins).
  norm.forEach((h, i) => {
    if (mapping[i] || !h || IGNORED_HEADERS.includes(h)) return;
    let best = null;
    for (const [field, words] of Object.entries(HEADER_SYNONYMS)) {
      if (used.has(field)) continue;
      for (const w of words) {
        if (w.length > 2 && new RegExp(`(^| )${w}( |$)`).test(h) && (!best || w.length > best.len)) best = { field, len: w.length };
      }
    }
    if (best) { mapping[i] = best.field; used.add(best.field); }
  });
  return mapping;
}

/** RFC 4180 CSV parser with delimiter detection (comma, semicolon or tab) and BOM handling. */
function parseCsv(input) {
  const s = input.replace(/^﻿/, '');
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
    return String(v);
  }
  return v;
}

async function readSpreadsheet(file) {
  const name = (file.originalname || '').toLowerCase();
  let rows;
  if (name.endsWith('.csv') || name.endsWith('.txt') || file.mimetype === 'text/csv') {
    rows = parseCsv(file.buffer.toString('utf8'));
  } else if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(file.buffer); } catch {
      throw new ValidationError({ file: 'This file could not be read as an Excel workbook.' });
    }
    // Use the first sheet that has data, skipping instruction sheets.
    const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 1 && !/instruction|help|readme/i.test(ws.name))
      || wb.worksheets[0];
    rows = [];
    sheet?.eachRow({ includeEmpty: false }, (r) => {
      const values = [];
      r.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cellValue(cell.value); });
      rows.push(Array.from(values, (v) => (v === undefined ? null : v)));
    });
  } else {
    throw new ValidationError({ file: 'Upload an .xlsx or .csv file.' });
  }
  const isBlank = (r) => r.every((v) => v == null || String(v).trim() === '');
  // The header row is the first row with at least two filled cells (skips title rows above the table).
  const headerIdx = rows.findIndex((r) => r.filter((v) => v != null && String(v).trim() !== '').length >= 2);
  if (headerIdx < 0) throw new ValidationError({ file: 'No table with column headers was found in this file.' });
  const headers = rows[headerIdx].map((h) => (h == null ? '' : String(h).trim()));
  const body = rows.slice(headerIdx + 1).map((r, i) => ({ line: headerIdx + i + 2, cells: r })).filter((r) => !isBlank(r.cells));
  if (body.length > MAX_ROWS) throw new ValidationError({ file: `Files are limited to ${MAX_ROWS} rows.` });
  return { headers, body };
}

module.exports = function ioRoutes({ db }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  const previews = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of previews) if (v.expires < now) previews.delete(k);
  };

  /** Validates every row and decides create/update without writing anything. */
  function buildPreview(headers, body, options) {
    const mapping = mapHeaders(headers);
    if (!mapping.includes('name') && !mapping.includes('tag')) {
      throw new ValidationError({ file: 'Could not find a "Name" or "Asset tag" column. Check the header row or use the template.' });
    }
    const employees = db.prepare('SELECT id, name, email, status FROM employees').all();
    const byEmail = new Map(employees.filter((e) => e.email).map((e) => [e.email.toLowerCase(), e]));
    const byName = new Map();
    for (const e of employees) {
      const k = e.name.toLowerCase();
      byName.set(k, byName.has(k) ? 'ambiguous' : e);
    }
    const findByTag = db.prepare('SELECT * FROM assets WHERE tag = ?');
    const findBySerial = db.prepare(`SELECT * FROM assets WHERE serial = ? AND serial <> ''`);
    const seenTags = new Map();
    const seenSerials = new Map();
    const newEmployees = new Map();
    const rows = [];

    for (const { line, cells } of body) {
      const raw = {};
      mapping.forEach((field, i) => {
        if (!field) return;
        const v = cells[i];
        if (v != null && String(v).trim() !== '') raw[field] = typeof v === 'string' ? v.trim() : v;
      });
      const errors = [];
      const warnings = [];
      const tag = raw.tag != null ? String(raw.tag).trim() : null;
      const serial = raw.serial != null ? String(raw.serial).trim() : null;

      let existing = tag ? findByTag.get(tag) : null;
      if (!existing && serial) existing = findBySerial.get(serial);
      if (tag) {
        const k = tag.toLowerCase();
        if (seenTags.has(k)) errors.push(`Asset tag ${tag} also appears on row ${seenTags.get(k)}.`);
        else seenTags.set(k, line);
      }
      if (serial) {
        const k = serial.toLowerCase();
        if (seenSerials.has(k)) errors.push(`Serial ${serial} also appears on row ${seenSerials.get(k)}.`);
        else seenSerials.set(k, line);
      }

      // Resolve the assignee by email first, then by exact name.
      let employee = null;
      let newEmployee = null;
      let email = raw.assignee_email ? String(raw.assignee_email).toLowerCase().trim() : null;
      let name = raw.assignee ? text(raw.assignee, 120) : null;
      // Many sheets put an email address in the "Owner"/"User" column.
      if (name && EMAIL_RE.test(name)) {
        email = email || name.toLowerCase();
        name = null;
      }
      if (email && !EMAIL_RE.test(email)) warnings.push(`"${email}" is not a valid email and was ignored.`);
      const validEmail = email && EMAIL_RE.test(email) ? email : null;
      if (validEmail && byEmail.has(validEmail)) employee = byEmail.get(validEmail);
      else if (name && byName.get(name.toLowerCase()) === 'ambiguous') {
        errors.push(`More than one employee is named "${name}". Add an email column to tell them apart.`);
      } else if (name && byName.has(name.toLowerCase())) employee = byName.get(name.toLowerCase());
      else if (name || validEmail) {
        const label = name || validEmail;
        if (options.createEmployees) {
          const key = (validEmail || name).toLowerCase();
          if (!newEmployees.has(key)) newEmployees.set(key, { name: name || validEmail.split('@')[0], email: validEmail });
          newEmployee = key;
          warnings.push(`New employee "${label}" will be created.`);
        } else {
          warnings.push(`No employee "${label}" found, so the asset will be left unassigned.`);
        }
      }
      if (employee && employee.status === 'offboarded') {
        warnings.push(`${employee.name} is offboarded.`);
      }

      const input = { ...raw };
      delete input.assignee;
      delete input.assignee_email;
      const assigned = !!(employee || newEmployee);
      if (assigned && !input.status) input.status = 'in_use';
      let data = null;
      try {
        data = cleanAsset(input, { partial: !!existing });
        if (!existing && !data.name) throw new ValidationError({ name: 'Name is required.' });
        if (assigned && ['in_stock', 'retired', 'lost'].includes(data.status)) {
          warnings.push(`Status "${STATUS_LABELS[data.status]}" conflicts with an assignee, so the assignee was ignored.`);
          employee = null;
          newEmployee = null;
        }
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push(...Object.values(err.errors));
      }
      if (existing && serial && (existing.serial || '').toLowerCase() !== serial.toLowerCase()) {
        const other = findBySerial.get(serial);
        if (other && other.id !== existing.id) errors.push(`Serial ${serial} already belongs to ${other.tag}.`);
      }

      rows.push({
        line,
        action: errors.length ? 'error' : existing ? 'update' : 'create',
        existingId: existing?.id ?? null,
        tag: tag || existing?.tag || null,
        name: data?.name || existing?.name || raw.name || null,
        category: data?.category || existing?.category || null,
        employeeId: employee?.id ?? null,
        employeeName: employee?.name ?? (newEmployee ? newEmployees.get(newEmployee).name : null),
        newEmployee,
        data,
        errors,
        warnings,
      });
    }
    return {
      mapping: headers.map((h, i) => ({ header: h, field: mapping[i] })),
      rows,
      newEmployees: [...newEmployees.entries()].map(([key, e]) => ({ key, ...e })),
      summary: {
        total: rows.length,
        create: rows.filter((r) => r.action === 'create').length,
        update: rows.filter((r) => r.action === 'update').length,
        error: rows.filter((r) => r.action === 'error').length,
        warnings: rows.filter((r) => r.warnings.length).length,
        newEmployees: newEmployees.size,
      },
    };
  }

  router.post('/import/preview', requireRole('editor'), upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new ValidationError({ file: 'Choose a file to upload.' });
      const options = { createEmployees: req.body.createEmployees !== 'false' };
      const { headers, body } = await readSpreadsheet(req.file);
      if (!body.length) throw new ValidationError({ file: 'The file has headers but no data rows.' });
      const preview = buildPreview(headers, body, options);
      sweep();
      const token = crypto.randomBytes(16).toString('hex');
      previews.set(token, { userId: req.user.id, expires: Date.now() + PREVIEW_TTL_MS, preview, fileName: req.file.originalname });
      res.json({
        token,
        fileName: req.file.originalname,
        mapping: preview.mapping,
        summary: preview.summary,
        newEmployees: preview.newEmployees,
        rows: preview.rows.slice(0, 1000).map(({ data, ...r }) => r),
      });
    } catch (err) { next(err); }
  });

  router.post('/import/commit', requireRole('editor'), (req, res) => {
    sweep();
    const entry = previews.get(String(req.body.token || ''));
    if (!entry || entry.userId !== req.user.id) {
      throw new ValidationError({ token: 'This preview has expired. Upload the file again.' });
    }
    previews.delete(req.body.token);
    const { preview, fileName } = entry;
    const skipErrors = req.body.skipErrors !== false;
    if (!skipErrors && preview.summary.error) {
      throw new ValidationError({ rows: 'Fix the rows with errors, or choose to skip them.' });
    }
    const result = transaction(db, () => {
      const empIds = new Map();
      for (const e of preview.newEmployees) {
        const found = e.email ? db.prepare('SELECT id FROM employees WHERE email = ?').get(e.email) : null;
        if (found) { empIds.set(e.key, found.id); continue; }
        const r = db.prepare('INSERT INTO employees (name, email) VALUES (?, ?)').run(e.name, e.email);
        empIds.set(e.key, r.lastInsertRowid);
        audit(db, req.user, 'employee', r.lastInsertRowid, 'create', `Added employee ${e.name} from import`);
      }
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      const now = new Date().toISOString();
      for (const row of preview.rows) {
        if (row.action === 'error') continue;
        const data = { ...row.data };
        const empId = row.employeeId ?? (row.newEmployee ? empIds.get(row.newEmployee) : null);
        if (empId) data.employee_id = empId;
        if (row.action === 'create') {
          if (!data.tag) data.tag = nextAssetTag(db);
          const cols = Object.keys(data);
          const r = db.prepare(`INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => data[c]));
          audit(db, req.user, 'asset', r.lastInsertRowid, 'create', `Created ${data.tag} (${data.name}) from ${fileName}`);
          created += 1;
        } else {
          const before = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.existingId);
          if (!before) continue;
          const changes = {};
          for (const [k, v] of Object.entries(data)) if ((before[k] ?? null) !== (v ?? null)) changes[k] = [before[k] ?? null, v ?? null];
          if (!Object.keys(changes).length) { unchanged += 1; continue; }
          const cols = Object.keys(changes);
          db.prepare(`UPDATE assets SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
            .run(...cols.map((c) => data[c]), now, before.id);
          audit(db, req.user, 'asset', before.id, 'update', `Updated ${before.tag} from ${fileName}`, changes);
          updated += 1;
        }
      }
      audit(db, req.user, 'import', null, 'import',
        `Imported ${fileName}: ${created} created, ${updated} updated, ${preview.summary.error} skipped`);
      return { created, updated, unchanged, skipped: preview.summary.error, employeesCreated: preview.newEmployees.length };
    });
    res.json({ ok: true, ...result });
  });

  /* ---------------- Export ---------------- */
  const EXPORT_COLUMNS = [
    ['Asset tag', 'tag', 14], ['Name', 'name', 28], ['Category', 'category', 12], ['Manufacturer', 'manufacturer', 14],
    ['Model', 'model', 22], ['Serial number', 'serial', 18], ['Status', 'status', 11], ['Assigned to', 'employee_name', 22],
    ['Assigned email', 'employee_email', 26], ['Department', 'department', 14], ['Location', 'location', 18],
    ['Purchase date', 'purchase_date', 13], ['Purchase cost', 'purchase_cost', 13], ['Supplier', 'supplier', 18],
    ['Warranty end', 'warranty_end', 13], ['Book value', 'book_value', 12], ['Notes', 'notes', 40],
  ];
  const DATE_COLS = new Set(['purchase_date', 'warranty_end']);
  const MONEY_COLS = new Set(['purchase_cost', 'book_value']);

  // Cells starting with these characters are executed as formulas by Excel/Sheets when a CSV is opened.
  const csvSafe = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  router.get('/export/assets.:format(csv|xlsx)', requireRole('viewer'), async (req, res, next) => {
    try {
      const { where, params } = assetFilters(req.query);
      const rows = db.prepare(`${ASSET_SELECT} ${where} ${orderBy(req.query)}`).all(...params)
        .map((a) => ({ ...a, book_value: bookValue(a), status: STATUS_LABELS[a.status] || a.status }));
      const stamp = today();
      if (req.params.format === 'csv') {
        const lines = [EXPORT_COLUMNS.map((c) => csvSafe(c[0])).join(',')];
        for (const r of rows) lines.push(EXPORT_COLUMNS.map(([, k]) => csvSafe(r[k])).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="assets-${stamp}.csv"`);
        return res.send('﻿' + lines.join('\r\n'));
      }
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AssetDesk';
      const ws = wb.addWorksheet('Assets', { views: [{ state: 'frozen', ySplit: 1 }] });
      const currency = getMeta(db, 'currency', 'USD');
      ws.columns = EXPORT_COLUMNS.map(([header, key, width]) => ({
        header: MONEY_COLS.has(key) ? `${header} (${currency})` : header, key, width,
        style: DATE_COLS.has(key) ? { numFmt: 'yyyy-mm-dd' } : MONEY_COLS.has(key) ? { numFmt: '#,##0.00' } : {},
      }));
      for (const r of rows) {
        ws.addRow(Object.fromEntries(EXPORT_COLUMNS.map(([, k]) => [k,
          DATE_COLS.has(k) && r[k] ? new Date(`${r[k]}T00:00:00Z`) : r[k] ?? null])));
      }
      const header = ws.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="assets-${stamp}.xlsx"`);
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    } catch (err) { next(err); }
  });

  router.get('/export/template.xlsx', requireRole('viewer'), async (_req, res, next) => {
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Assets');
      const cols = EXPORT_COLUMNS.filter(([, k]) => k !== 'book_value');
      ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
      ws.addRow({ tag: '', name: 'Dell Latitude 7440', category: 'Laptop', manufacturer: 'Dell', model: 'Latitude 7440',
        serial: 'ABC1234', status: 'In use', employee_name: 'Sara Ahmed', employee_email: 'sara.ahmed@example.com',
        department: 'Finance', location: 'Riyadh HQ', purchase_date: '2025-03-15', purchase_cost: 5400, supplier: 'Jarir',
        warranty_end: '2028-03-15', notes: 'Leave Asset tag empty to auto-generate one' });
      ws.addRow({ name: 'HP LaserJet M507', category: 'Printer', status: 'In stock', location: 'Jeddah Office',
        purchase_date: '15/01/2024', purchase_cost: 'SAR 2,150' });
      ws.getRow(1).font = { bold: true };
      const help = wb.addWorksheet('Instructions');
      help.columns = [{ width: 24 }, { width: 90 }];
      [
        ['Required', 'Name and Category. Everything else is optional.'],
        ['Asset tag', 'Leave empty to auto-generate. If a tag or serial number already exists, that asset is updated.'],
        ['Category', CATEGORIES.join(', ') + '. Common words like "notebook" or "switch" are recognised.'],
        ['Status', 'In use, In stock, In repair, Retired, Lost. Words like "assigned" or "spare" also work.'],
        ['Assigned to', 'Employee name or email. New employees can be created during import.'],
        ['Dates', 'YYYY-MM-DD, DD/MM/YYYY, "15 Mar 2025", or Excel dates.'],
        ['Costs', 'Plain numbers or text like "SAR 1,200.50".'],
        ['Column names', 'Your own headers usually work too (e.g. "Serial No", "Owner", "Site").'],
      ].forEach((r) => help.addRow(r));
      help.getColumn(1).font = { bold: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="assetdesk-import-template.xlsx"');
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    } catch (err) { next(err); }
  });

  return router;
};

module.exports.mapHeaders = mapHeaders;
module.exports.parseCsv = parseCsv;
