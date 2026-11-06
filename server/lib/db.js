'use strict';
// CloudForge server database: a single JSON file, loaded into memory,
// written back ATOMICALLY (temp file + rename) through a serialized queue so
// concurrent clients can never corrupt it. VPS creds + AI key are encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadKey, enc, dec } = require('./crypto');

let FILE = null;
let DATA = null;
let chain = Promise.resolve(); // write serializer

function uid(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

function blank() {
  return {
    meta: { version: 1, createdAt: new Date().toISOString() },
    admin: { passwordHash: null },
    settings: { aiProvider: 'claude', aiKeyEnc: null, aiModel: 'claude-opus-5-5', openaiKeyEnc: null, openaiModel: 'gpt-4o', geminiKeyEnc: null, geminiModel: 'gemini-2.5-flash', githubTokenEnc: null, globalRules: '', telegram: { botToken: '', chatId: '' } },
    sourceServer: null,          // OUR VPS (holds all source code) — added once
    clientServers: [],           // client VPSs — each hosts many websites
    projects: [],                // website = source path -> client server + folder
    history: {},                 // projectId -> [ deploy entries ]
    usage: blankUsage()          // estimated AI spend (we track it ourselves)
  };
}

function blankUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byMonth: {}, byProject: {}, updatedAt: null };
}

function load(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  loadKey(dataDir);
  FILE = path.join(dataDir, 'db.json');
  try {
    if (fs.existsSync(FILE)) {
      DATA = Object.assign(blank(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } else {
      DATA = blank();
      persistSync();
    }
  } catch (e) {
    throw new Error('Could not read db.json (' + e.message + '). Fix or remove the file and restart.');
  }
  migrate();
  return DATA;
}

// one-time fixups for data written by older versions
function migrate() {
  let changed = false;
  for (const p of DATA.projects || []) {
    if (p.backupCmd && / -C ("[^"]*"|\S+) \. --exclude=node_modules --exclude=\.git/.test(p.backupCmd)) {
      p.backupCmd = p.backupCmd.replace(/ -C ("[^"]*"|\S+) \. --exclude=node_modules --exclude=\.git/, ' --exclude=node_modules --exclude=.git -C $1 .');
      changed = true;
    }
    // give older projects a build command (rebuild + install packages from local files)
    if (!p.buildCmd && p.deployMethod && p.deployMethod !== 'custom') {
      const cd = p.remotePath ? `cd "${p.remotePath}" && ` : '';
      p.buildCmd = p.deployMethod === 'pm2'
        ? `${cd}npm install && npm run build && pm2 restart all`
        : `${cd}docker compose up -d --build`;
      changed = true;
    }
  }
  if (changed) persistSync();
}

function persistSync() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DATA, null, 2));
  fs.renameSync(tmp, FILE); // atomic on same volume
}

// All mutations funnel through here so writes never interleave.
function mutate(fn) {
  chain = chain.then(() => {
    const result = fn(DATA);
    persistSync();
    return result;
  });
  return chain;
}

function raw() { return DATA; }
function dataDir() { return FILE ? path.dirname(FILE) : null; }

// Record one AI call's estimated cost + tokens (accumulates; never resets).
function recordUsage({ model, usage, cost, projectId }) {
  const u = usage || {};
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  return mutate(d => {
    if (!d.usage) d.usage = blankUsage();
    const g = d.usage;
    g.calls += 1;
    g.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    g.outputTokens += (u.output_tokens || 0);
    g.costUsd += cost || 0;
    g.byMonth[month] = (g.byMonth[month] || 0) + (cost || 0);
    if (projectId) g.byProject[projectId] = (g.byProject[projectId] || 0) + (cost || 0);
    g.updatedAt = new Date().toISOString();
  });
}

/* ---------- VPS credential helpers (encrypt in / decrypt out) ---------- */
function encVps(v = {}) {
  return {
    host: (v.host || '').trim(),
    port: Number(v.port) || 22,
    user: (v.user || '').trim(),
    passwordEnc: enc(v.password),
    privateKeyEnc: enc(v.privateKey),
    passphraseEnc: enc(v.passphrase)
  };
}
// returns a plain vps usable by src/ssh.js
function decVps(stored) {
  if (!stored) return {};
  return {
    host: stored.host, port: stored.port, user: stored.user,
    password: dec(stored.passwordEnc),
    privateKey: dec(stored.privateKeyEnc),
    passphrase: dec(stored.passphraseEnc)
  };
}
// safe view for the UI — host/port/user only, never secrets
function pubVps(stored) {
  if (!stored) return null;
  return {
    host: stored.host, port: stored.port, user: stored.user,
    hasPassword: !!stored.passwordEnc, hasKey: !!stored.privateKeyEnc
  };
}

module.exports = { load, raw, dataDir, mutate, recordUsage, uid, encVps, decVps, pubVps, enc, dec };
