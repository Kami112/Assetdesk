'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CATEGORIES = [
  'Laptop', 'Desktop', 'Monitor', 'Server', 'Network', 'Phone', 'Tablet', 'Printer', 'Peripheral', 'Other',
];
const STATUSES = ['in_use', 'in_stock', 'in_repair', 'retired', 'lost'];
// Expected useful life in years, used for straight-line depreciation and refresh planning.
const LIFESPAN_YEARS = {
  Laptop: 3, Desktop: 4, Monitor: 5, Server: 5, Network: 5, Phone: 2, Tablet: 3, Printer: 5, Peripheral: 3, Other: 4,
};

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE COLLATE NOCASE,
    department TEXT,
    title TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'offboarded')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    manufacturer TEXT,
    model TEXT,
    serial TEXT COLLATE NOCASE,
    status TEXT NOT NULL CHECK (status IN ('in_use', 'in_stock', 'in_repair', 'retired', 'lost')),
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    department TEXT,
    location TEXT,
    purchase_date TEXT,
    purchase_cost REAL,
    supplier TEXT,
    warranty_end TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX assets_serial ON assets(serial) WHERE serial IS NOT NULL AND serial <> '';
  CREATE INDEX assets_employee ON assets(employee_id);
  CREATE INDEX assets_status ON assets(status);

  CREATE TABLE licenses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    vendor TEXT,
    seats INTEGER NOT NULL CHECK (seats >= 0),
    license_key TEXT,
    expires_on TEXT,
    annual_cost REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE license_seats (
    id INTEGER PRIMARY KEY,
    license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (license_id, employee_id)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user_id INTEGER,
    user_name TEXT,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    changes TEXT
  );
  CREATE INDEX audit_entity ON audit_log(entity, entity_id);
  CREATE INDEX audit_at ON audit_log(at);
  `,
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let version = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
    });
  }
  return db;
}

/** Runs fn inside a transaction, rolling back if it throws. Nested calls join the outer transaction. */
function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** Next free asset tag such as AST-00042, based on the highest numeric tag with the configured prefix. */
function nextAssetTag(db) {
  const prefix = getMeta(db, 'tag_prefix', 'AST-');
  const rows = db.prepare('SELECT tag FROM assets WHERE tag LIKE ? ESCAPE \'\\\'')
    .all(prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  let max = 0;
  for (const { tag } of rows) {
    const n = Number(tag.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(5, '0');
}

module.exports = {
  openDatabase, transaction, getMeta, setMeta, nextAssetTag, CATEGORIES, STATUSES, LIFESPAN_YEARS,
};
