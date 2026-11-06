'use strict';
// Encrypt secrets at rest (SSH passwords/keys, the AI key).
// AES-256-GCM. The master key lives in data/master.key (auto-created, 0600)
// or in the CF_MASTER_KEY env var (base64, 32 bytes) for production.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
let KEY = null;

function loadKey(dataDir) {
  if (KEY) return KEY;
  const env = process.env.CF_MASTER_KEY;
  if (env && env.trim()) {
    const b = Buffer.from(env.trim(), 'base64');
    if (b.length !== 32) throw new Error('CF_MASTER_KEY must be base64 of exactly 32 bytes.');
    KEY = b;
    return KEY;
  }
  const file = path.join(dataDir, 'master.key');
  try {
    if (fs.existsSync(file)) {
      KEY = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      if (KEY.length !== 32) throw new Error('master.key is corrupt (wrong length).');
      return KEY;
    }
  } catch (e) { throw new Error('Could not read master.key: ' + e.message); }
  // first run — create one
  KEY = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, KEY.toString('base64'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return KEY;
}

// value -> "iv.tag.ciphertext" (all base64). null/'' stays null.
function enc(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!KEY) throw new Error('Crypto not initialised — call loadKey() first.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function dec(blob) {
  if (blob === undefined || blob === null || blob === '') return '';
  if (!KEY) throw new Error('Crypto not initialised — call loadKey() first.');
  try {
    const [ivb, tagb, ctb] = String(blob).split('.');
    const iv = Buffer.from(ivb, 'base64');
    const tag = Buffer.from(tagb, 'base64');
    const ct = Buffer.from(ctb, 'base64');
    const d = crypto.createDecipheriv(ALGO, KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}

function token(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }

module.exports = { loadKey, enc, dec, token };
