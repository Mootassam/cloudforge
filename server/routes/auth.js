'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const auth = require('../lib/auth');

// What login state are we in?
router.get('/state', (req, res) => {
  const data = db.raw();
  const s = auth.sessionFrom(req);
  res.json({
    needsSetup: !data.admin.passwordHash,                 // first run — set admin password
    admin: !!(s && s.role === 'admin'),
    client: !!(s && s.role === 'client'),
    projectId: s && s.role === 'client' ? s.projectId : null
  });
});

// First-run: set the admin password (only allowed when none exists yet)
router.post('/setup', async (req, res) => {
  const data = db.raw();
  if (data.admin.passwordHash) return res.status(400).json({ error: 'Admin already set up.' });
  const pw = (req.body && req.body.password) || '';
  if (String(pw).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  await db.mutate(d => { d.admin.passwordHash = auth.hashPassword(pw); });
  const token = auth.createSession('admin');
  auth.setCookie(res, token);
  res.json({ ok: true });
});

router.post('/admin-login', (req, res) => {
  const data = db.raw();
  if (!data.admin.passwordHash) return res.status(400).json({ error: 'Not set up yet.' });
  const pw = (req.body && req.body.password) || '';
  if (!auth.checkPassword(pw, data.admin.passwordHash)) return res.status(401).json({ error: 'Wrong password.' });
  const token = auth.createSession('admin');
  auth.setCookie(res, token);
  res.json({ ok: true });
});

// Client logs in with their key — matched against every project's hashed key.
router.post('/client-login', (req, res) => {
  const key = ((req.body && req.body.key) || '').trim();
  if (!key) return res.status(400).json({ error: 'Enter your access key.' });
  const data = db.raw();
  const project = data.projects.find(p => p.accessKeyHash && auth.checkKey(key, p.accessKeyHash));
  if (!project) return res.status(401).json({ error: 'Invalid or expired key.' });
  if (project.disabled) return res.status(403).json({ error: 'This access key has been disabled. Contact your provider.' });
  const token = auth.createSession('client', project.id);
  auth.setCookie(res, token);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const t = req.cookies && req.cookies[auth.COOKIE];
  if (t) auth.destroy(t);
  auth.clearCookie(res);
  res.json({ ok: true });
});

module.exports = router;
