'use strict';
const path = require('node:path');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { hashPassword, passwordProblem, audit } = require('./src/auth');
const { seedDemo } = require('./src/seed');

const demo = process.env.DEMO_MODE === 'true' || process.argv.includes('--demo');
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = openDatabase(demo ? ':memory:' : path.join(dataDir, 'assetdesk.db'));

if (demo) {
  seedDemo(db);
  // The public demo resets itself every 6 hours so visitors always find a tidy data set.
  setInterval(() => seedDemo(db), 6 * 3600 * 1000).unref();
  console.log('Demo mode: in-memory database seeded with sample data.');
} else if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_NAME: name = 'Administrator' } = process.env;
  if (email && password && !passwordProblem(password)) {
    const r = db.prepare(`INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)`)
      .run(email.toLowerCase(), name, hashPassword(password));
    audit(db, null, 'user', r.lastInsertRowid, 'create', `Created first admin ${name} from environment`);
    console.log(`Created first admin account ${email}.`);
  } else {
    console.warn('No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart, '
      + 'or run: npm run create-admin -- <email> <name>');
  }
}

const app = createApp({ db, demo, publicUrl: process.env.PUBLIC_URL || null });
const server = app.listen(port, () => console.log(`AssetDesk listening on http://localhost:${port}`));

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
