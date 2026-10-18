'use strict';
const { CATEGORIES, STATUSES } = require('./db');

class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.errors = errors;
    this.status = 400;
  }
}

const STATUS_SYNONYMS = {
  in_use: ['in use', 'inuse', 'assigned', 'deployed', 'active', 'checked out', 'in service'],
  in_stock: ['in stock', 'instock', 'stock', 'available', 'spare', 'unassigned', 'storage', 'ready'],
  in_repair: ['in repair', 'repair', 'broken', 'faulty', 'maintenance', 'rma', 'service'],
  retired: ['retired', 'disposed', 'decommissioned', 'scrapped', 'end of life', 'eol', 'sold', 'recycled'],
  lost: ['lost', 'stolen', 'missing'],
};

const CATEGORY_SYNONYMS = {
  Laptop: ['laptop', 'notebook', 'macbook', 'ultrabook', 'thinkpad'],
  Desktop: ['desktop', 'pc', 'workstation', 'imac', 'tower', 'mini pc'],
  Monitor: ['monitor', 'display', 'screen', 'lcd'],
  Server: ['server', 'nas', 'san', 'storage server', 'host'],
  Network: ['network', 'switch', 'router', 'firewall', 'access point', 'ap', 'wifi', 'modem', 'networking'],
  Phone: ['phone', 'mobile', 'smartphone', 'iphone', 'android', 'cell', 'desk phone', 'ip phone'],
  Tablet: ['tablet', 'ipad'],
  Printer: ['printer', 'scanner', 'copier', 'mfp', 'plotter'],
  Peripheral: ['peripheral', 'keyboard', 'mouse', 'headset', 'dock', 'docking station', 'webcam', 'accessory'],
  Other: ['other', 'misc', 'miscellaneous'],
};

const squash = (s) => String(s).toLowerCase().replace(/[_\-./]+/g, ' ').replace(/\s+/g, ' ').trim();

function normalizeStatus(value) {
  if (value == null || value === '') return null;
  const v = squash(value);
  if (STATUSES.includes(v.replace(/ /g, '_'))) return v.replace(/ /g, '_');
  for (const [status, words] of Object.entries(STATUS_SYNONYMS)) if (words.includes(v)) return status;
  return undefined;
}

function normalizeCategory(value) {
  if (value == null || value === '') return null;
  const v = squash(value);
  const exact = CATEGORIES.find((c) => c.toLowerCase() === v);
  if (exact) return exact;
  for (const [cat, words] of Object.entries(CATEGORY_SYNONYMS)) if (words.includes(v)) return cat;
  // Last resort: a synonym appearing as a whole word, e.g. "Dell Latitude laptop".
  for (const [cat, words] of Object.entries(CATEGORY_SYNONYMS)) {
    if (words.some((w) => w.length > 2 && new RegExp(`\\b${w}s?\\b`).test(v))) return cat;
  }
  return undefined;
}

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  if (y < 1980 || y > 2100) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses common date inputs to YYYY-MM-DD. Accepts ISO dates, Date objects, Excel serial numbers,
 * "12 Mar 2024" / "Mar 12, 2024", and slash dates. Slash dates are read as day/month/year unless
 * the first number can only be a month (e.g. 03/25/2024). Returns null for empty, undefined for invalid.
 */
function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined
      : isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (value > 20000 && value < 80000) { // Excel serial date
      const d = new Date(Math.round((value - 25569) * 86400 * 1000));
      return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return undefined;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    return a <= 12 && b > 12 ? isoDate(+m[3], a, b) : isoDate(+m[3], b, a);
  }
  m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,})[\s,-]+(\d{4})$/i);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi < 0 ? undefined : isoDate(+m[3], mi + 1, +m[1]);
  }
  m = s.match(/^([a-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi < 0 ? undefined : isoDate(+m[3], mi + 1, +m[2]);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));
  return undefined;
}

/** Parses amounts like "SAR 1,299.50", "$800" or 1200. Returns null for empty, undefined for invalid. */
function parseMoney(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : undefined;
  const cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!cleaned) return undefined;
  // "1.299,50" (comma decimal) vs "1,299.50" (dot decimal)
  const normalized = /,\d{1,2}$/.test(cleaned) && !/\.\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

function text(value, max = 200) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates and cleans an asset payload. With partial=true, only provided fields are checked. */
function cleanAsset(input, { partial = false } = {}) {
  const errors = {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const take = (k, fn) => { if (!partial || has(k)) out[k] = fn(input[k]); };

  take('tag', (v) => text(v, 40));
  take('name', (v) => text(v, 120));
  take('manufacturer', (v) => text(v, 80));
  take('model', (v) => text(v, 120));
  take('serial', (v) => text(v, 80));
  take('department', (v) => text(v, 80));
  take('location', (v) => text(v, 120));
  take('supplier', (v) => text(v, 120));
  take('notes', (v) => text(v, 4000));

  if (!partial || has('name')) if (!out.name) errors.name = 'Name is required.';
  if (!partial || has('category')) {
    const c = normalizeCategory(input.category);
    if (!c) errors.category = `Category must be one of: ${CATEGORIES.join(', ')}.`;
    else out.category = c;
  }
  if (!partial || has('status')) {
    let s = normalizeStatus(input.status);
    if (s === null && !partial) s = 'in_stock';
    if (!s) errors.status = 'Status is not recognised.';
    else out.status = s;
  }
  for (const k of ['purchase_date', 'warranty_end']) {
    if (!partial || has(k)) {
      const d = parseDate(input[k]);
      if (d === undefined) errors[k] = 'Use a valid date (YYYY-MM-DD).';
      else out[k] = d;
    }
  }
  if (!partial || has('purchase_cost')) {
    const c = parseMoney(input.purchase_cost);
    if (c === undefined) errors.purchase_cost = 'Cost must be a positive number.';
    else out.purchase_cost = c;
  }
  if (!partial || has('employee_id')) {
    const v = input.employee_id;
    if (v == null || v === '') out.employee_id = null;
    else if (!Number.isInteger(Number(v)) || Number(v) <= 0) errors.employee_id = 'Invalid employee.';
    else out.employee_id = Number(v);
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

function cleanEmployee(input) {
  const errors = {};
  const out = {
    name: text(input.name, 120),
    email: text(input.email, 160),
    department: text(input.department, 80),
    title: text(input.title, 120),
    location: text(input.location, 120),
  };
  if (!out.name) errors.name = 'Name is required.';
  if (out.email && !EMAIL_RE.test(out.email)) errors.email = 'Email address is not valid.';
  if (out.email) out.email = out.email.toLowerCase();
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

function cleanLicense(input) {
  const errors = {};
  const out = {
    name: text(input.name, 120),
    vendor: text(input.vendor, 120),
    license_key: text(input.license_key, 500),
    notes: text(input.notes, 4000),
  };
  if (!out.name) errors.name = 'Name is required.';
  const seats = Number(input.seats);
  if (!Number.isInteger(seats) || seats < 0 || seats > 1000000) errors.seats = 'Seats must be a whole number.';
  else out.seats = seats;
  const exp = parseDate(input.expires_on);
  if (exp === undefined) errors.expires_on = 'Use a valid date (YYYY-MM-DD).';
  else out.expires_on = exp;
  const cost = parseMoney(input.annual_cost);
  if (cost === undefined) errors.annual_cost = 'Cost must be a positive number.';
  else out.annual_cost = cost;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

module.exports = {
  ValidationError, normalizeStatus, normalizeCategory, parseDate, parseMoney, text, EMAIL_RE,
  cleanAsset, cleanEmployee, cleanLicense,
};
