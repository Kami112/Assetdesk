'use strict';
const { transaction, setMeta, LIFESPAN_YEARS } = require('./db');
const { hashPassword } = require('./auth');

/** Small deterministic PRNG so every demo reset produces the same data set. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ahmed', 'Sara', 'Mohammed', 'Fatimah', 'Omar', 'Noura', 'Khalid', 'Aisha', 'Faisal', 'Layla', 'Yousef',
  'Reem', 'Abdullah', 'Huda', 'Tariq', 'Maha', 'Saad', 'Dana', 'Hassan', 'Lina', 'Rakan', 'Joud', 'Bilal', 'Ruba',
  'Ibrahim', 'Hana', 'Nasser', 'Amal', 'Majed', 'Shahad', 'Ali', 'Mariam', 'Kamran', 'Priya', 'James', 'Elena',
  'Arjun', 'Grace', 'Daniel', 'Zainab', 'Hamza', 'Lujain', 'Sultan', 'Rania', 'Waleed'];
const LAST = ['Al-Harbi', 'Al-Qahtani', 'Al-Otaibi', 'Al-Ghamdi', 'Al-Zahrani', 'Al-Shehri', 'Al-Dosari', 'Khan',
  'Al-Mutairi', 'Al-Anazi', 'Haddad', 'Nasser', 'Rahman', 'Siddiqui', 'Fernandes', 'Mathew', 'Al-Saud', 'Hussain'];
const DEPARTMENTS = [['Finance', 6], ['Sales', 9], ['Operations', 8], ['IT', 5], ['HR', 4], ['Marketing', 5], ['Legal', 3], ['Procurement', 5]];
const LOCATIONS = ['Riyadh HQ', 'Riyadh HQ', 'Riyadh HQ', 'Jeddah Office', 'Jeddah Office', 'Dammam Warehouse', 'Remote'];
const TITLES = {
  Finance: ['Accountant', 'Financial Analyst', 'Finance Manager'], Sales: ['Account Executive', 'Sales Manager', 'Sales Coordinator'],
  Operations: ['Operations Specialist', 'Logistics Coordinator', 'Operations Manager'], IT: ['Systems Administrator', 'IT Support Specialist', 'Network Engineer', 'IT Manager'],
  HR: ['HR Generalist', 'Recruiter', 'HR Manager'], Marketing: ['Marketing Specialist', 'Designer', 'Content Lead'],
  Legal: ['Legal Counsel', 'Paralegal'], Procurement: ['Buyer', 'Procurement Officer', 'Procurement Manager'],
};
// [manufacturer, model, minCost, maxCost] in SAR
const MODELS = {
  Laptop: [['Dell', 'Latitude 7440', 4800, 6200], ['Lenovo', 'ThinkPad T14 Gen 4', 4500, 5900], ['Apple', 'MacBook Pro 14" M3', 7800, 9800],
    ['HP', 'EliteBook 840 G10', 4600, 6000], ['Apple', 'MacBook Air 13" M2', 4800, 5600]],
  Desktop: [['Dell', 'OptiPlex 7010', 3200, 4100], ['HP', 'EliteDesk 800 G9', 3300, 4300], ['Lenovo', 'ThinkCentre M90q', 3000, 3900]],
  Monitor: [['Dell', 'P2723D 27"', 1100, 1450], ['LG', '27UP850 4K', 1500, 1900], ['Samsung', 'S24R650 24"', 650, 850]],
  Server: [['Dell', 'PowerEdge R750', 38000, 52000], ['HPE', 'ProLiant DL380 Gen10', 34000, 47000], ['Synology', 'RackStation RS1221+', 6500, 8200]],
  Network: [['Cisco', 'Catalyst 9200L 48P', 14500, 18500], ['Fortinet', 'FortiGate 100F', 16000, 21000], ['Ubiquiti', 'UniFi U6 Pro AP', 650, 850], ['Cisco', 'ISR 1100 Router', 4200, 5600]],
  Phone: [['Apple', 'iPhone 15', 3400, 3900], ['Samsung', 'Galaxy S24', 3100, 3600], ['Cisco', 'IP Phone 8845', 1400, 1700]],
  Tablet: [['Apple', 'iPad Air 11"', 2600, 3200], ['Samsung', 'Galaxy Tab S9', 2700, 3300]],
  Printer: [['HP', 'LaserJet Pro M404dn', 1300, 1700], ['Canon', 'imageRUNNER C3226i', 14000, 17500], ['Brother', 'HL-L8360CDW', 1900, 2400]],
  Peripheral: [['Logitech', 'MX Keys + MX Master 3S', 650, 800], ['Dell', 'WD22TB4 Dock', 1100, 1350], ['Jabra', 'Evolve2 65 Headset', 850, 1050], ['Logitech', 'Brio 4K Webcam', 700, 900]],
};
const SUPPLIERS = ['Jarir Bookstore', 'eXtra', 'Dell Direct KSA', 'SITE Technology', 'Al Moammar Information Systems', 'Amazon.sa'];

function seedDemo(db) {
  const rand = mulberry32(20261018);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + rand() * (b - a);
  const now = Date.now();
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString();
  const dateOnly = (ms) => iso(ms).slice(0, 10);

  transaction(db, () => {
    for (const t of ['audit_log', 'license_seats', 'licenses', 'assets', 'employees', 'sessions', 'users', 'meta']) {
      db.exec(`DELETE FROM ${t}`);
    }
    setMeta(db, 'company_name', 'Acme Arabia (Demo)');
    setMeta(db, 'currency', 'SAR');
    setMeta(db, 'tag_prefix', 'AST-');

    const hash = hashPassword('demo-password');
    const users = [['Demo Admin', 'admin@demo.assetdesk', 'admin'], ['Demo Editor', 'editor@demo.assetdesk', 'editor'],
      ['Demo Viewer', 'viewer@demo.assetdesk', 'viewer']].map(([name, email, role]) => {
      const r = db.prepare('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)').run(name, email, role, hash);
      return { id: Number(r.lastInsertRowid), name };
    });
    const [admin, editor] = users;
    const insAudit = db.prepare(`INSERT INTO audit_log (at, user_id, user_name, entity, entity_id, action, summary, changes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const log = (ms, user, entity, id, action, summary, changes = null) =>
      insAudit.run(iso(ms), user.id, user.name, entity, id, action, summary, changes ? JSON.stringify(changes) : null);

    // Employees
    const employees = [];
    const usedNames = new Set();
    const insEmp = db.prepare(`INSERT INTO employees (name, email, department, title, location, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [dept, count] of DEPARTMENTS) {
      for (let i = 0; i < count; i++) {
        let name;
        do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(name));
        usedNames.add(name);
        const email = `${name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '.')}@acme-arabia.example`;
        const offboarded = rand() < 0.06;
        const created = now - between(60, 1500) * day;
        const r = insEmp.run(name, email, dept, pick(TITLES[dept]), dept === 'Operations' && rand() < 0.5 ? 'Dammam Warehouse' : pick(LOCATIONS),
          offboarded ? 'offboarded' : 'active', iso(created));
        employees.push({ id: Number(r.lastInsertRowid), name, dept, offboarded, created });
      }
    }
    const activeEmployees = employees.filter((e) => !e.offboarded);
    const empById = new Map(employees.map((e) => [e.id, e]));

    // Assets
    let tagNo = 0;
    const insAsset = db.prepare(`INSERT INTO assets (tag, name, category, manufacturer, model, serial, status, employee_id,
      department, location, purchase_date, purchase_cost, supplier, warranty_end, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const serialChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    const serial = () => Array.from({ length: 10 }, () => pick(serialChars)).join('');

    function addAsset(category, { employee = null, status, location, ageDays, note = null, dept = null } = {}) {
      const [make, model, lo, hi] = pick(MODELS[category]);
      const age = ageDays ?? between(20, LIFESPAN_YEARS[category] * 365 * 1.25);
      const purchased = now - age * day;
      const warrantyYears = category === 'Server' || category === 'Network' ? 3 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 3);
      const st = status || (employee ? 'in_use' : 'in_stock');
      tagNo += 1;
      const tag = `AST-${String(tagNo).padStart(5, '0')}`;
      const emp = employee ? empById.get(employee) : null;
      const loc = location || (emp ? db.prepare('SELECT location FROM employees WHERE id = ?').get(emp.id).location : pick(LOCATIONS.slice(0, 6)));
      const r = insAsset.run(tag, `${make} ${model}`, category, make, model, serial(), st, employee, dept || emp?.dept || null, loc,
        dateOnly(purchased), Math.round(between(lo, hi)), pick(SUPPLIERS), dateOnly(purchased + warrantyYears * 365 * day), note,
        iso(purchased), iso(Math.max(purchased, now - between(1, 120) * day)));
      const id = Number(r.lastInsertRowid);
      log(purchased + 3600000, pick([admin, editor]), 'asset', id, 'create', `Created ${tag} (${make} ${model})`);
      if (emp) {
        const when = Math.min(now - day, purchased + between(1, 14) * day);
        log(when, pick([admin, editor]), 'asset', id, 'checkout', `Checked out ${tag} to ${emp.name}`,
          { employee: [null, emp.name], status: ['in_stock', 'in_use'] });
      }
      if (st === 'in_repair') log(now - between(1, 20) * day, editor, 'asset', id, 'update', `Sent ${tag} for repair`, { status: ['in_use', 'in_repair'] });
      if (st === 'retired') log(now - between(5, 200) * day, admin, 'asset', id, 'update', `Retired ${tag}`, { status: ['in_stock', 'retired'] });
      if (st === 'lost') log(now - between(5, 90) * day, admin, 'asset', id, 'update', `Reported ${tag} lost`, { status: ['in_use', 'lost'] });
      return id;
    }

    for (const e of activeEmployees) {
      const isDesigner = e.dept === 'Marketing' || e.dept === 'IT';
      addAsset(rand() < 0.85 ? 'Laptop' : 'Desktop', { employee: e.id, ageDays: between(30, 1500) });
      addAsset('Monitor', { employee: e.id });
      if (isDesigner || rand() < 0.3) addAsset('Monitor', { employee: e.id });
      if (e.dept === 'Sales' || e.dept === 'Operations' || rand() < 0.25) addAsset('Phone', { employee: e.id, ageDays: between(30, 900) });
      if (rand() < 0.5) addAsset('Peripheral', { employee: e.id });
      if (rand() < 0.12) addAsset('Tablet', { employee: e.id });
    }
    // Shared infrastructure and stock
    for (let i = 0; i < 6; i++) addAsset('Server', { location: i < 4 ? 'Riyadh HQ' : 'Jeddah Office', status: 'in_use', dept: 'IT', note: i === 0 ? 'Primary domain controller' : null });
    for (let i = 0; i < 12; i++) addAsset('Network', { location: pick(LOCATIONS.slice(0, 6)), status: 'in_use', dept: 'IT' });
    for (let i = 0; i < 8; i++) addAsset('Printer', { location: pick(LOCATIONS.slice(0, 6)), status: 'in_use' });
    for (let i = 0; i < 14; i++) addAsset(pick(['Laptop', 'Laptop', 'Monitor', 'Peripheral', 'Phone']), { location: 'Riyadh HQ', ageDays: between(10, 300), note: 'Spare stock' });
    for (let i = 0; i < 5; i++) addAsset(pick(['Laptop', 'Monitor', 'Printer']), { status: 'in_repair', location: 'Riyadh HQ', note: 'With vendor for warranty repair' });
    for (let i = 0; i < 12; i++) addAsset(pick(['Laptop', 'Desktop', 'Monitor', 'Phone']), { status: 'retired', ageDays: between(1500, 2200), location: 'Dammam Warehouse' });
    for (let i = 0; i < 2; i++) addAsset(pick(['Laptop', 'Phone']), { status: 'lost', ageDays: between(200, 700), note: 'Police report filed' });
    // A few warranties ending soon so the dashboard has something to show.
    const soon = db.prepare(`SELECT id FROM assets WHERE status = 'in_use' AND id % 23 = 0 LIMIT 7`).all();
    soon.forEach(({ id }, i) => db.prepare('UPDATE assets SET warranty_end = ? WHERE id = ?').run(dateOnly(now + (6 + i * 11) * day), id));

    // Offboarding history for the offboarded employees
    for (const e of employees.filter((x) => x.offboarded)) {
      log(now - between(10, 120) * day, admin, 'employee', e.id, 'offboard', `Offboarded ${e.name}: 2 asset(s) returned, 1 license seat(s) released`);
    }

    // Licenses
    const LICENSES = [
      ['Microsoft 365 Business Premium', 'Microsoft', 50, 380, 52000, 'all'],
      ['Adobe Creative Cloud for Teams', 'Adobe', 6, 70, 21500, 'Marketing'],
      ['Zoom Workplace Pro', 'Zoom', 15, 25, 9000, 'all'],
      ['Atlassian Jira Software', 'Atlassian', 12, 160, 8400, 'IT'],
      ['Autodesk AutoCAD LT', 'Autodesk', 3, 40, 7200, 'Operations'],
      ['Kaspersky Endpoint Security', 'Kaspersky', 60, 300, 11000, 'all'],
      ['Microsoft Power BI Pro', 'Microsoft', 8, 18, 4300, 'Finance'],
      ['FortiGuard UTP Bundle', 'Fortinet', 2, 120, 9800, null],
      ['DocuSign Business Pro', 'DocuSign', 4, 12, 6100, 'Legal'],
      ['1Password Business', '1Password', 10, 200, 3200, 'IT'],
    ];
    const insLic = db.prepare(`INSERT INTO licenses (name, vendor, seats, license_key, expires_on, annual_cost, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insSeat = db.prepare('INSERT OR IGNORE INTO license_seats (license_id, employee_id, assigned_at) VALUES (?, ?, ?)');
    for (const [name, vendor, seats, expiresIn, cost, who] of LICENSES) {
      const created = now - between(200, 900) * day;
      const key = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => pick(serialChars)).join('')).join('-');
      const r = insLic.run(name, vendor, seats, key, dateOnly(now + expiresIn * day), cost, null, iso(created));
      const id = Number(r.lastInsertRowid);
      log(created, admin, 'license', id, 'create', `Added license ${name} (${seats} seats)`);
      const pool = who === 'all' ? activeEmployees : activeEmployees.filter((e) => e.dept === who || (who && e.dept === 'IT'));
      // Mostly well-used licenses; Zoom is deliberately over-allocated to show the warning.
      const target = name.startsWith('Zoom') ? seats + 2 : Math.min(pool.length, Math.max(1, Math.round(seats * between(0.6, 0.95))));
      const shuffled = [...pool].sort(() => rand() - 0.5).slice(0, target);
      for (const e of shuffled) {
        const at = Math.max(created, e.created) + between(1, 30) * day;
        insSeat.run(id, e.id, iso(Math.min(at, now - day)));
        log(Math.min(at, now - day), pick([admin, editor]), 'license', id, 'assign', `Assigned ${name} seat to ${e.name}`);
      }
    }
  });
}

module.exports = { seedDemo };
