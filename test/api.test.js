'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { parseDate, parseMoney, normalizeCategory, normalizeStatus } = require('../src/validate');
const { mapHeaders, parseCsv } = require('../src/routes/io');
const { seedDemo } = require('../src/seed');

const PASSWORD = 'correct horse battery';

function setup() {
  const db = openDatabase(':memory:');
  const hash = hashPassword(PASSWORD);
  for (const [name, email, role] of [['Ada Admin', 'admin@test.local', 'admin'], ['Eddie Editor', 'editor@test.local', 'editor'], ['Vera Viewer', 'viewer@test.local', 'viewer']]) {
    db.prepare('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)').run(name, email, role, hash);
  }
  const app = createApp({ db });
  return { db, app };
}

async function login(app, email) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'AssetDesk').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  // Wrap so every call carries the CSRF header.
  const h = (r) => r.set('X-Requested-With', 'AssetDesk');
  return {
    get: (u) => h(agent.get(u)),
    post: (u) => h(agent.post(u)),
    patch: (u) => h(agent.patch(u)),
    delete: (u) => h(agent.delete(u)),
  };
}

describe('parsing helpers', () => {
  test('dates in common formats', () => {
    assert.equal(parseDate('2025-03-15'), '2025-03-15');
    assert.equal(parseDate('15/03/2025'), '2025-03-15');
    assert.equal(parseDate('03/25/2025'), '2025-03-25'); // only valid as month/day
    assert.equal(parseDate('15 Mar 2025'), '2025-03-15');
    assert.equal(parseDate('March 5, 2025'), '2025-03-05');
    assert.equal(parseDate(45731), '2025-03-15'); // Excel serial
    assert.equal(parseDate(''), null);
    assert.equal(parseDate('31/02/2025'), undefined);
    assert.equal(parseDate('soon'), undefined);
  });
  test('money with currency text and separators', () => {
    assert.equal(parseMoney('SAR 1,299.50'), 1299.5);
    assert.equal(parseMoney('1.299,50'), 1299.5);
    assert.equal(parseMoney('$800'), 800);
    assert.equal(parseMoney(''), null);
    assert.equal(parseMoney('-5'), undefined);
  });
  test('category and status synonyms', () => {
    assert.equal(normalizeCategory('notebook'), 'Laptop');
    assert.equal(normalizeCategory('Cisco switch'), 'Network');
    assert.equal(normalizeCategory('toaster'), undefined);
    assert.equal(normalizeStatus('Assigned'), 'in_use');
    assert.equal(normalizeStatus('spare'), 'in_stock');
    assert.equal(normalizeStatus('RMA'), 'in_repair');
  });
  test('header mapping understands real-world column names', () => {
    const m = mapHeaders(['Asset #', 'Device Name', 'Type', 'S/N', 'Owner', 'Owner Email', 'Site', 'Date Purchased', 'Price (SAR)', 'Warranty Expiry', 'Random']);
    assert.deepEqual(m, ['tag', 'name', 'category', 'serial', 'assignee', 'assignee_email', 'location', 'purchase_date', 'purchase_cost', 'warranty_end', null]);
  });
  test('CSV parser handles quotes, embedded newlines and semicolons', () => {
    assert.deepEqual(parseCsv('a;b\r\n"x;1";"he said ""hi""\nthere"\r\n'), [['a', 'b'], ['x;1', 'he said "hi"\nthere']]);
  });
});

describe('security', () => {
  const { app } = setup();
  test('rejects wrong password with a generic message', async () => {
    const res = await request(app).post('/api/auth/login').set('X-Requested-With', 'AssetDesk').send({ email: 'admin@test.local', password: 'nope' });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /incorrect/);
  });
  test('API requires sign-in', async () => {
    assert.equal((await request(app).get('/api/assets')).status, 401);
  });
  test('state-changing requests need the CSRF header', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD });
    assert.equal(res.status, 403);
  });
  test('session cookie is httpOnly', async () => {
    const res = await request(app).post('/api/auth/login').set('X-Requested-With', 'AssetDesk').send({ email: 'admin@test.local', password: PASSWORD });
    assert.match(res.headers['set-cookie'][0], /HttpOnly/);
  });
  test('sends security headers', async () => {
    const res = await request(app).get('/');
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });
});

describe('roles and assets', () => {
  const { app } = setup();
  let admin, editor, viewer;
  before(async () => {
    [admin, editor, viewer] = await Promise.all(['admin', 'editor', 'viewer'].map((r) => login(app, `${r}@test.local`)));
  });

  test('viewer cannot create assets', async () => {
    assert.equal((await viewer.post('/api/assets').send({ name: 'X', category: 'Laptop' })).status, 403);
  });

  test('editor creates an asset with an auto tag; duplicate serial is rejected', async () => {
    const a = await editor.post('/api/assets').send({ name: 'ThinkPad T14', category: 'notebook', serial: 'SN-1', purchase_cost: 'SAR 4,500' });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.tag, 'AST-00001');
    assert.equal(a.body.category, 'Laptop');
    assert.equal(a.body.purchase_cost, 4500);
    const dup = await editor.post('/api/assets').send({ name: 'Other', category: 'Laptop', serial: 'sn-1' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.errors.serial, /serial/);
  });

  test('check-out and check-in keep status in sync and are audited', async () => {
    const emp = (await editor.post('/api/employees').send({ name: 'Sara Ahmed', email: 'sara@x.com', department: 'Finance', location: 'Riyadh' })).body;
    const out = await editor.post('/api/assets/1/checkout').send({ employee_id: emp.id });
    assert.equal(out.body.status, 'in_use');
    assert.equal(out.body.employee_name, 'Sara Ahmed');
    assert.equal(out.body.location, 'Riyadh');
    const back = await editor.post('/api/assets/1/checkin').send({ status: 'in_repair', note: 'cracked screen' });
    assert.equal(back.body.status, 'in_repair');
    assert.equal(back.body.employee_id, null);
    const detail = (await viewer.get('/api/assets/1')).body;
    assert.deepEqual(detail.history.map((h) => h.action), ['checkin', 'checkout', 'create']);
    assert.match(detail.history[0].summary, /cracked screen/);
  });

  test('an assigned asset cannot be "In stock"', async () => {
    const res = await editor.patch('/api/assets/1').send({ employee_id: 1, status: 'in_stock' });
    assert.equal(res.status, 400);
  });

  test('editors cannot delete; admins can', async () => {
    assert.equal((await editor.delete('/api/assets/1')).status, 403);
    assert.equal((await admin.delete('/api/assets/1')).status, 200);
  });

  test('viewers see masked license keys', async () => {
    const lic = (await editor.post('/api/licenses').send({ name: 'M365', seats: 1, license_key: 'AAAA-BBBB-CCCC' })).body;
    assert.equal((await viewer.get(`/api/licenses/${lic.id}`)).body.license_key, '••••CCCC');
    assert.equal((await editor.get(`/api/licenses/${lic.id}`)).body.license_key, 'AAAA-BBBB-CCCC');
  });

  test('license seats cannot be over-allocated by accident', async () => {
    const e2 = (await editor.post('/api/employees').send({ name: 'Omar Khan' })).body;
    assert.equal((await editor.post('/api/licenses/1/seats').send({ employee_id: 1 })).status, 200);
    const over = await editor.post('/api/licenses/1/seats').send({ employee_id: e2.id });
    assert.equal(over.status, 400);
    assert.equal((await editor.post('/api/licenses/1/seats').send({ employee_id: e2.id, allow_over: true })).status, 200);
  });

  test('the last admin cannot be demoted', async () => {
    const res = await admin.patch('/api/users/1').send({ role: 'editor' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least one active admin/);
  });
});

describe('offboarding', () => {
  const { app } = setup();
  test('returns assets, marks unreturned ones lost and frees seats in one step', async () => {
    const ed = await login(app, 'editor@test.local');
    const emp = (await ed.post('/api/employees').send({ name: 'Leaving Person' })).body;
    const a1 = (await ed.post('/api/assets').send({ name: 'Laptop', category: 'Laptop', employee_id: emp.id })).body;
    const a2 = (await ed.post('/api/assets').send({ name: 'Phone', category: 'Phone', employee_id: emp.id })).body;
    assert.equal(a1.status, 'in_use');
    const lic = (await ed.post('/api/licenses').send({ name: 'Zoom', seats: 5 })).body;
    await ed.post(`/api/licenses/${lic.id}/seats`).send({ employee_id: emp.id });

    const r = await ed.post(`/api/employees/${emp.id}/offboard`).send({ lost_asset_ids: [a2.id] });
    assert.deepEqual({ assets: r.body.assets, lost: r.body.lost, seats: r.body.seats }, { assets: 2, lost: 1, seats: 1 });
    assert.equal((await ed.get(`/api/assets/${a1.id}`)).body.status, 'in_stock');
    assert.equal((await ed.get(`/api/assets/${a2.id}`)).body.status, 'lost');
    assert.equal((await ed.get(`/api/licenses/${lic.id}`)).body.seats_used, 0);
    assert.equal((await ed.get(`/api/employees/${emp.id}`)).body.status, 'offboarded');
  });
});

describe('import and export', () => {
  const { app, db } = setup();
  let ed;
  before(async () => {
    ed = await login(app, 'editor@test.local');
    await ed.post('/api/employees').send({ name: 'Existing Person', email: 'existing@corp.com' });
  });

  const messyCsv = [
    'IT Inventory 2025;;;;;;;',                                   // title row above the table
    'Asset #;Device Name;Type;S/N;Owner;Site;Date Purchased;Price (SAR)',
    ';Dell Latitude 7440;notebook;DL-1;existing@corp.com;Riyadh HQ;15/03/2025;SAR 5,400',
    'LEG-7;HP Monitor;display;HP-9;New Hire;Jeddah;2024-01-10;1.299,50',
    ';Mystery box;toaster;MB-1;;;;',                               // unknown category -> error
    ';Second Dell;laptop;DL-1;;;;',                                // duplicate serial in file -> error
    ';Cisco switch 48p;switch;CS-1;;Dammam;Jan 5, 2023;18000',
  ].join('\r\n');

  test('preview reads messy headers, dates and costs without writing anything', async () => {
    const res = await ed.post('/api/import/preview').attach('file', Buffer.from(messyCsv), 'inventory.csv');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.summary, { total: 5, create: 3, update: 0, error: 2, warnings: 1, newEmployees: 1 });
    const errs = res.body.rows.filter((r) => r.action === 'error').map((r) => r.errors.join(' '));
    assert.match(errs[0], /Category/);
    assert.match(errs[1], /also appears on row 3/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  });

  test('commit creates assets, resolves and creates employees', async () => {
    const pre = await ed.post('/api/import/preview').attach('file', Buffer.from(messyCsv), 'inventory.csv');
    const res = await ed.post('/api/import/commit').send({ token: pre.body.token });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual({ c: res.body.created, s: res.body.skipped, e: res.body.employeesCreated }, { c: 3, s: 2, e: 1 });
    const dell = db.prepare(`SELECT a.*, e.name AS emp FROM assets a LEFT JOIN employees e ON e.id = a.employee_id WHERE serial = 'DL-1'`).get();
    assert.deepEqual([dell.emp, dell.status, dell.purchase_date, dell.purchase_cost], ['Existing Person', 'in_use', '2025-03-15', 5400]);
    const mon = db.prepare(`SELECT * FROM assets WHERE tag = 'LEG-7'`).get();
    assert.deepEqual([mon.category, mon.purchase_cost, mon.location], ['Monitor', 1299.5, 'Jeddah']);
    assert.equal(db.prepare(`SELECT category FROM assets WHERE serial = 'CS-1'`).get().category, 'Network');
    // A preview token can only be used once.
    assert.equal((await ed.post('/api/import/commit').send({ token: pre.body.token })).status, 400);
  });

  test('exported Excel imports back as updates, not duplicates', async () => {
    const xlsx = await ed.get('/api/export/assets.xlsx').buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(xlsx.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    assert.equal(wb.worksheets[0].actualRowCount, 4);
    const res = await ed.post('/api/import/preview').attach('file', xlsx.body, 'assets.xlsx');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.summary.create, 0);
    assert.equal(res.body.summary.update, 3);
    assert.equal(res.body.summary.error, 0);
  });

  test('CSV export neutralises spreadsheet formulas', async () => {
    await ed.post('/api/assets').send({ name: '=HYPERLINK("http://evil")', category: 'Other' });
    const csv = (await ed.get('/api/export/assets.csv')).text;
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  });
});

describe('demo data', () => {
  test('seeds a realistic, consistent data set', async () => {
    const db = openDatabase(':memory:');
    seedDemo(db);
    const n = (sql) => db.prepare(sql).get().n;
    assert.ok(n('SELECT COUNT(*) AS n FROM assets') > 150);
    assert.equal(n(`SELECT COUNT(*) AS n FROM assets WHERE status = 'in_use' AND employee_id IS NOT NULL
      AND employee_id IN (SELECT id FROM employees WHERE status = 'offboarded')`), 0);
    assert.equal(n(`SELECT COUNT(*) AS n FROM assets WHERE employee_id IS NOT NULL AND status NOT IN ('in_use', 'in_repair')`), 0);
    const app = createApp({ db, demo: true });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'AssetDesk').send({ email: 'admin@demo.assetdesk', password: 'demo-password' }).expect(200);
    const blocked = await agent.post('/api/users').set('X-Requested-With', 'AssetDesk').send({});
    assert.equal(blocked.status, 403);
  });
});
