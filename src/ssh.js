'use strict';
// Thin ssh2 wrapper: works with ANY VPS (Oracle or other) via normal login —
// IP/host, port, and password OR private key. Also handles servers that require
// keyboard-interactive password auth.
const { Client } = require('ssh2');

function buildAuth(vps) {
  const cfg = {
    host: vps.host,
    port: Number(vps.port) || 22,
    username: vps.user,
    readyTimeout: 25000,
    keepaliveInterval: 10000,
    tryKeyboard: true // many VPS providers need this for password login
  };
  if (vps.privateKey && String(vps.privateKey).trim()) {
    cfg.privateKey = vps.privateKey;
    if (vps.passphrase) cfg.passphrase = vps.passphrase;
  } else {
    cfg.password = vps.password || '';
  }
  return cfg;
}

// attach keyboard-interactive so password logins work everywhere
function attach(conn, vps) {
  conn.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => finish([vps.password || '']));
  return conn;
}

function testConnection(vps) {
  return new Promise((resolve) => {
    if (!vps || !vps.host || !vps.user) return resolve({ ok: false, message: 'Missing host or SSH user.' });
    const conn = attach(new Client(), vps);
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { conn.end(); } catch {} resolve(r); } };
    conn.on('ready', () => {
      conn.exec('echo cloudforge-ok; uname -a; docker --version 2>/dev/null', (err, stream) => {
        if (err) return finish({ ok: true, message: 'Connected.' });
        let out = '';
        stream.on('data', d => { out += d.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => finish({ ok: true, message: out.trim() || 'Connected.' }));
      });
    });
    conn.on('error', (e) => finish({ ok: false, message: friendly(e) }));
    try { conn.connect(buildAuth(vps)); } catch (e) { finish({ ok: false, message: friendly(e) }); }
  });
}

function runCommand(vps, cmd, onData) {
  return new Promise((resolve, reject) => {
    if (!vps || !vps.host || !vps.user) return reject(new Error('Missing host or SSH user.'));
    const conn = attach(new Client(), vps);
    let stdout = '', stderr = '';
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { try { conn.end(); } catch {} return reject(err); }
        stream.on('data', d => { const s = d.toString(); stdout += s; if (onData) onData(s); });
        stream.stderr.on('data', d => { const s = d.toString(); stderr += s; if (onData) onData(s); });
        stream.on('close', (code) => { try { conn.end(); } catch {} resolve({ code: code == null ? 0 : code, stdout, stderr }); });
      });
    });
    conn.on('error', (e) => reject(new Error(friendly(e))));
    try { conn.connect(buildAuth(vps)); } catch (e) { reject(new Error(friendly(e))); }
  });
}

function friendly(e) {
  const m = (e && e.message) || String(e);
  if (/All configured authentication methods failed/i.test(m)) return 'Login failed — wrong password/key or SSH user.';
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused — wrong port, or SSH not running on that IP.';
  if (/ETIMEDOUT|timed out/i.test(m)) return 'Timed out — wrong IP, firewall blocking the port, or server offline.';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Host not found — check the IP / hostname.';
  return m;
}

module.exports = { testConnection, runCommand, buildAuth, attach };
