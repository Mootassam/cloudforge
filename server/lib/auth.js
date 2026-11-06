'use strict';
// Sessions + access control.
//  - Admin logs in with a password (bcrypt-hashed).
//  - A client logs in with their KEY (CF-XXXX-...). The key maps to EXACTLY one
//    project; the session is locked to that projectId. A client can never see
//    or act on another project — enforced here, on the server, not in the UI.
//
// Sessions are PERSISTED to disk (sessions.json) so they survive a server
// restart — on a low-memory PC the process gets killed and restarted often, and
// without this you'd have to log in every single time. Sessions also SLIDE:
// every time you use the app the clock resets, so an active owner is never
// logged out mid-work. Only genuine inactivity for TTL_MS ends a session.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const COOKIE = 'cf_sid';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days of inactivity before logout
const sessions = new Map();              // token -> { role, projectId, expires }

let FILE = null;              // where sessions are persisted (set by initSessions)
let saveTimer = null;         // debounce handle for disk writes

function newToken() { return crypto.randomBytes(24).toString('base64url'); }

// Wire persistence to a data folder. Called once at startup (index.js). If it's
// never called (e.g. in unit tests) sessions simply stay in memory.
function initSessions(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    FILE = path.join(dataDir, 'sessions.json');
    loadSessions();
  } catch (e) {
    FILE = null; // fall back to memory-only; never block startup over this
  }
}

function loadSessions() {
  if (!FILE || !fs.existsSync(FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const [token, s] of Object.entries(raw || {})) {
      if (s && typeof s.expires === 'number' && s.expires > now) sessions.set(token, s);
    }
  } catch { /* corrupt/empty file — ignore, start fresh */ }
}

function scheduleSave() {
  if (!FILE || saveTimer) return;
  // debounce: at most one write per second even under heavy sliding
  saveTimer = setTimeout(saveSessions, 1000);
  if (saveTimer.unref) saveTimer.unref(); // don't keep the process alive just for this
}

function saveSessions() {
  saveTimer = null;
  if (!FILE) return;
  try {
    const now = Date.now();
    const out = {};
    for (const [token, s] of sessions) if (s.expires > now) out[token] = s;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, FILE); // atomic on same volume
  } catch { /* disk hiccup — keep running, try again next change */ }
}

function createSession(role, projectId = null) {
  const token = newToken();
  sessions.set(token, { role, projectId, expires: Date.now() + TTL_MS });
  scheduleSave();
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); scheduleSave(); return null; }
  // sliding expiry: using the app keeps you signed in
  s.expires = Date.now() + TTL_MS;
  scheduleSave();
  return s;
}
function destroy(token) { if (sessions.delete(token)) scheduleSave(); }

function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: TTL_MS,
    secure: !!process.env.CF_HTTPS // on when served over https in production
  });
}
function clearCookie(res) { res.clearCookie(COOKIE); }

function sessionFrom(req) { return getSession(req.cookies && req.cookies[COOKIE]); }

function requireAdmin(req, res, next) {
  const s = sessionFrom(req);
  if (!s || s.role !== 'admin') return res.status(401).json({ error: 'Not signed in as admin.' });
  req.session = s; next();
}
function requireClient(req, res, next) {
  const s = sessionFrom(req);
  if (!s || s.role !== 'client' || !s.projectId) return res.status(401).json({ error: 'Not signed in.' });
  req.session = s; next();
}

/* ---- password & key hashing ---- */
function hashPassword(pw) { return bcrypt.hashSync(String(pw), 10); }
function checkPassword(pw, hash) { try { return bcrypt.compareSync(String(pw), hash || ''); } catch { return false; } }
function hashKey(key) { return bcrypt.hashSync(String(key), 10); }
function checkKey(key, hash) { try { return bcrypt.compareSync(String(key), hash || ''); } catch { return false; } }

module.exports = {
  COOKIE, TTL_MS, initSessions, createSession, getSession, destroy, setCookie, clearCookie, sessionFrom,
  requireAdmin, requireClient, hashPassword, checkPassword, hashKey, checkKey
};
