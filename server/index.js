'use strict';
// CloudForge Server — the always-on brain.
// Runs on your PC now for testing, and on the Oracle VPS later (same code).
//
//   npm run server            → http://localhost:3000
//   CF_PORT=8080 npm run server
//
const path = require('path');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { createApp } = require('./app');

const DATA_DIR = process.env.CF_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.CF_PORT) || 3000;
const HOST = process.env.CF_HOST || '0.0.0.0';

try {
  db.load(DATA_DIR);
  auth.initSessions(DATA_DIR); // load saved logins so a restart doesn't sign you out
} catch (e) {
  console.error('\n✖ Could not start — ' + e.message + '\n');
  process.exit(1);
}

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  const data = db.raw();
  console.log('\n  ┌─────────────────────────────────────────────┐');
  console.log('  │   CloudForge Server is running                │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`   Admin panel : http://localhost:${PORT}/        (sign in as owner)`);
  console.log(`   Client app  : http://localhost:${PORT}/app     (your customers)`);
  console.log(`   Data folder : ${DATA_DIR}`);
  if (!data.admin.passwordHash) console.log('   First run   : open the admin panel to set your owner password.');
  console.log('');
});

process.on('SIGINT', () => { console.log('\nShutting down…'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
