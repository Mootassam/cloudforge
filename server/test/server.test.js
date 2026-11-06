'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const crypto = require('../lib/crypto');
const { createQueue } = require('../lib/queue');
const jobs = require('../lib/jobs');
const engine = require('../lib/engine');

test('crypto: encrypt → decrypt round-trips, and ciphertext hides the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-crypto-'));
  crypto.loadKey(dir);
  const secret = 'super-secret-password-123';
  const blob = crypto.enc(secret);
  assert.ok(blob && !blob.includes(secret), 'ciphertext must not contain the plaintext');
  assert.strictEqual(crypto.dec(blob), secret);
  assert.strictEqual(crypto.enc(''), null);
  assert.strictEqual(crypto.dec(null), '');
  assert.strictEqual(crypto.dec('garbage'), ''); // never throws on bad input
});

test('queue: never runs more than the concurrency limit at once', async () => {
  const q = createQueue(2);
  let running = 0, peak = 0;
  const task = () => new Promise(res => { running++; peak = Math.max(peak, running); setTimeout(() => { running--; res(); }, 20); });
  await Promise.all(Array.from({ length: 8 }, () => q(task)));
  assert.ok(peak <= 2, 'peak concurrency was ' + peak);
});

test('jobs: lifecycle queued → running → done, log trimmed', () => {
  const j = jobs.create({ projectId: 'p1', label: 'x' });
  assert.strictEqual(j.status, 'queued');
  jobs.append(j, 'line one\nline two');
  assert.strictEqual(j.log.length, 2);
  jobs.finish(j, true);
  assert.strictEqual(jobs.view(j).ok, true);
  assert.strictEqual(jobs.view(j).status, 'done');
});

test('engine.defaultCmds: compose-git builds a git-pull + rebuild command', () => {
  const c = engine.defaultCmds('compose-git', '/opt/app', ['backend', 'server'], '/opt/backups');
  assert.match(c.deployFullCmd, /git pull && docker compose up -d --build/);
  assert.match(c.deployContainersCmd, /backend server/);
  assert.match(c.backupCmd, /tar\b.*-czf/);
  assert.match(c.restoreCmd, /\{file\}/);
});

test('engine.defaultCmds: custom leaves commands blank for the admin', () => {
  const c = engine.defaultCmds('custom', '/opt/app', [], '');
  assert.strictEqual(c.deployFullCmd, '');
});
