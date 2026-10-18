'use strict';
// Usage: npm run create-admin -- <email> "<full name>"
// Prompts for the password so it never lands in shell history.
const path = require('node:path');
const readline = require('node:readline');
const { openDatabase } = require('../src/db');
const { hashPassword, passwordProblem, audit } = require('../src/auth');

const [email, name = 'Administrator'] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run create-admin -- <email> "<full name>"');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.stdoutMuted = false;
rl._writeToOutput = function write(s) { this.output.write(this.stdoutMuted && s.trim() ? '*' : s); };
rl.question('Password (10+ characters): ', (password) => {
  rl.close();
  process.stdout.write('\n');
  const problem = passwordProblem(password);
  if (problem) { console.error(problem); process.exit(1); }
  const db = openDatabase(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'assetdesk.db'));
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`UPDATE users SET password_hash = ?, role = 'admin', active = 1 WHERE id = ?`).run(hashPassword(password), existing.id);
    audit(db, null, 'user', existing.id, 'password', `Reset ${email} to admin from the command line`);
    console.log(`Updated ${email}: now an active admin with the new password.`);
  } else {
    const r = db.prepare(`INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)`)
      .run(email.toLowerCase(), name, hashPassword(password));
    audit(db, null, 'user', r.lastInsertRowid, 'create', `Created admin ${name} from the command line`);
    console.log(`Created admin ${email}.`);
  }
  db.close();
});
rl.stdoutMuted = true;
