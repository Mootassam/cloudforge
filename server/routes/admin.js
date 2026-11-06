'use strict';
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const auth = require('../lib/auth');
const engine = require('../lib/engine');
const jobs = require('../lib/jobs');
const views = require('../lib/views');
const explore = require('../lib/explore');
const targets = require('../lib/targets');
const ai = require('../lib/ai');
const aiOpenai = require('../lib/ai_openai');
const aiGemini = require('../lib/ai_gemini');
const github = require('../lib/github');
const gitwork = require('../lib/gitwork');
const workflow = require('../lib/workflow');
const path = require('path');
const { deployQueue } = require('../lib/runtime');
const { generateCode } = require('../../src/codes');

router.use(auth.requireAdmin);

function findProject(id) { return db.raw().projects.find(p => p.id === id); }

// resolve a browse target ('source' or a clientServer id) to a decrypted vps
function resolveTargetVps(target) {
  const d = db.raw();
  if (target === 'source') {
    if (!d.sourceServer) throw new Error('Add your source VPS first (Servers tab).');
    return db.decVps(d.sourceServer.vps);
  }
  const cs = d.clientServers.find(s => s.id === target);
  if (!cs) throw new Error('Server not found.');
  return db.decVps(cs.vps);
}

/* ---------------- explorer (browse & select, no typing) ---------------- */
router.post('/explore/dirs', async (req, res) => {
  try {
    const vps = resolveTargetVps((req.body || {}).target);
    res.json(await explore.browse(vps, (req.body || {}).path || ''));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.post('/explore/containers', async (req, res) => {
  try {
    const vps = resolveTargetVps((req.body || {}).target);
    res.json(await explore.containers(vps));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------------- overview ---------------- */
router.get('/overview', (req, res) => {
  const d = db.raw();
  res.json({
    sourceServer: d.sourceServer ? { name: d.sourceServer.name, vps: db.pubVps(d.sourceServer.vps) } : null,
    clientServers: d.clientServers.map(s => ({ id: s.id, name: s.name, vps: db.pubVps(s.vps) })),
    projects: d.projects.map(p => views.projectPublic(p, d)),
    settings: {
      aiProvider: d.settings.aiProvider || 'claude',
      aiModel: d.settings.aiModel || 'claude-opus-5-5',
      aiKeySet: !!d.settings.aiKeyEnc,
      openaiModel: d.settings.openaiModel || 'gpt-4o',
      openaiKeySet: !!d.settings.openaiKeyEnc,
      geminiModel: d.settings.geminiModel || 'gemini-2.5-flash',
      geminiKeySet: !!d.settings.geminiKeyEnc,
      githubSet: !!d.settings.githubTokenEnc,
      globalRules: d.settings.globalRules || '',
      telegram: { botToken: d.settings.telegram.botToken || '', chatId: d.settings.telegram.chatId || '' }
    },
    queue: deployQueue.stats()
  });
});

/* ---------------- settings (AI key hidden, encrypted) ---------------- */
// Estimated AI spend (we track it ourselves — Anthropic has no live-balance API).
router.get('/usage', (req, res) => {
  const d = db.raw();
  const u = d.usage || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byMonth: {}, byProject: {} };
  const month = new Date().toISOString().slice(0, 7);
  const prov = d.settings.aiProvider || 'claude';
  const hasKey = prov === 'openai' ? !!d.settings.openaiKeyEnc : prov === 'gemini' ? !!d.settings.geminiKeyEnc : !!d.settings.aiKeyEnc;
  const model = prov === 'openai' ? (d.settings.openaiModel || aiOpenai.DEFAULT_MODEL) : prov === 'gemini' ? (d.settings.geminiModel || aiGemini.DEFAULT_MODEL) : (d.settings.aiModel || ai.DEFAULT_MODEL);
  res.json({
    ok: true,
    provider: prov,
    hasKey,
    model,
    totals: { calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd },
    thisMonth: u.byMonth[month] || 0,
    byMonth: u.byMonth, updatedAt: u.updatedAt || null
  });
});

// Check the stored AI key is valid (costs nothing) — checks the ACTIVE provider.
router.post('/check-key', async (req, res) => {
  const d = db.raw();
  const prov = d.settings.aiProvider || 'claude';
  if (prov === 'openai') return res.json(await aiOpenai.checkKey(db.dec(d.settings.openaiKeyEnc)));
  if (prov === 'gemini') return res.json(await aiGemini.checkKey(db.dec(d.settings.geminiKeyEnc)));
  res.json(await ai.checkKey(db.dec(d.settings.aiKeyEnc), d.settings.aiModel));
});

router.post('/settings', async (req, res) => {
  const b = req.body || {};
  await db.mutate(d => {
    if (typeof b.aiProvider === 'string') d.settings.aiProvider = ['openai', 'gemini', 'claude'].includes(b.aiProvider) ? b.aiProvider : 'claude';
    if (typeof b.aiModel === 'string' && b.aiModel.trim()) d.settings.aiModel = b.aiModel.trim();
    if (typeof b.openaiModel === 'string' && b.openaiModel.trim()) d.settings.openaiModel = b.openaiModel.trim();
    if (typeof b.openaiKey === 'string' && b.openaiKey.trim()) d.settings.openaiKeyEnc = db.enc(b.openaiKey.trim());
    if (b.clearOpenaiKey) d.settings.openaiKeyEnc = null;
    if (typeof b.geminiModel === 'string' && b.geminiModel.trim()) d.settings.geminiModel = b.geminiModel.trim();
    if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) d.settings.geminiKeyEnc = db.enc(b.geminiKey.trim());
    if (b.clearGeminiKey) d.settings.geminiKeyEnc = null;
    if (typeof b.globalRules === 'string') d.settings.globalRules = b.globalRules;
    if (b.telegram) d.settings.telegram = { botToken: b.telegram.botToken || '', chatId: b.telegram.chatId || '' };
    // only overwrite the AI key when a new non-empty one is sent
    if (typeof b.aiKey === 'string' && b.aiKey.trim()) d.settings.aiKeyEnc = db.enc(b.aiKey.trim());
    if (b.clearAiKey) d.settings.aiKeyEnc = null;
    // GitHub token (code storage) — same hidden/encrypted treatment
    if (typeof b.githubToken === 'string' && b.githubToken.trim()) d.settings.githubTokenEnc = db.enc(b.githubToken.trim());
    if (b.clearGithubToken) d.settings.githubTokenEnc = null;
  });
  res.json({ ok: true });
});

// Check the saved GitHub token is valid → returns the GitHub username.
router.post('/github-check', async (req, res) => {
  const token = db.dec(db.raw().settings.githubTokenEnc);
  res.json(await github.checkToken(token));
});

// Test access to a specific repo (owner/name) with the saved token.
router.post('/github-test-repo', async (req, res) => {
  const token = db.dec(db.raw().settings.githubTokenEnc);
  res.json(await github.testRepo(token, (req.body && req.body.repo) || ''));
});

router.post('/telegram-test', async (req, res) => {
  const tg = db.raw().settings.telegram;
  if (!tg.botToken || !tg.chatId) return res.json({ ok: false, error: 'Fill bot token and chat id first.' });
  const r = await engine.notify(db.raw().settings, '✅ <b>CloudForge</b> test alert — Telegram is connected.');
  res.json({ ok: true });
});

/* ---------------- OUR source VPS (added once) ---------------- */
router.put('/source-server', async (req, res) => {
  const b = req.body || {};
  if (!b.vps || !b.vps.host || !b.vps.user) return res.status(400).json({ error: 'Host and SSH user are required.' });
  await db.mutate(d => {
    const prev = d.sourceServer && d.sourceServer.vps;
    const vps = db.encVps(b.vps);
    // keep existing secret if the form left it blank (editing without re-typing)
    if (prev) {
      if (!b.vps.password) vps.passwordEnc = prev.passwordEnc;
      if (!b.vps.privateKey) vps.privateKeyEnc = prev.privateKeyEnc;
      if (!b.vps.passphrase) vps.passphraseEnc = prev.passphraseEnc;
    }
    d.sourceServer = { name: b.name || 'My source VPS', vps };
  });
  res.json({ ok: true });
});
router.post('/source-server/test', async (req, res) => {
  const d = db.raw();
  if (!d.sourceServer) return res.json({ ok: false, message: 'Add the source VPS first.' });
  res.json(await engine.testConnection(db.decVps(d.sourceServer.vps)));
});

/* ---------------- client VPSs ---------------- */
router.post('/client-servers', async (req, res) => {
  const b = req.body || {};
  if (!b.vps || !b.vps.host || !b.vps.user) return res.status(400).json({ error: 'Host and SSH user are required.' });
  const id = db.uid('srv');
  await db.mutate(d => { d.clientServers.push({ id, name: b.name || b.vps.host, vps: db.encVps(b.vps) }); });
  res.json({ ok: true, id });
});
router.put('/client-servers/:id', async (req, res) => {
  const b = req.body || {};
  let found = false;
  await db.mutate(d => {
    const s = d.clientServers.find(x => x.id === req.params.id);
    if (!s) return;
    found = true;
    const prev = s.vps;
    const vps = db.encVps(b.vps || {});
    if (!b.vps || !b.vps.password) vps.passwordEnc = prev.passwordEnc;
    if (!b.vps || !b.vps.privateKey) vps.privateKeyEnc = prev.privateKeyEnc;
    if (!b.vps || !b.vps.passphrase) vps.passphraseEnc = prev.passphraseEnc;
    s.vps = vps;
    if (b.name) s.name = b.name;
  });
  if (!found) return res.status(404).json({ error: 'Server not found.' });
  res.json({ ok: true });
});
router.delete('/client-servers/:id', async (req, res) => {
  const inUse = db.raw().projects.some(p => p.clientServerId === req.params.id);
  if (inUse) return res.status(400).json({ error: 'A project still uses this server. Move or delete it first.' });
  await db.mutate(d => { d.clientServers = d.clientServers.filter(x => x.id !== req.params.id); });
  res.json({ ok: true });
});
router.post('/client-servers/:id/test', async (req, res) => {
  const s = db.raw().clientServers.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found.' });
  res.json(await engine.testConnection(db.decVps(s.vps)));
});

/* ---------------- projects (websites) ---------------- */
function applyProjectFields(p, b) {
  const f = ['name', 'customer', 'sourcePath', 'clientServerId', 'remotePath',
    'deployMethod', 'deployFullCmd', 'deployContainersCmd', 'buildCmd', 'buildScript', 'backupCmd', 'restoreCmd',
    'backupDir', 'sslEmail', 'sslCmd', 'rules'];
  f.forEach(k => { if (b[k] !== undefined) p[k] = b[k]; });
  if (b.github !== undefined) p.github = { repo: String((b.github && b.github.repo) || '').trim(), branch: String((b.github && b.github.branch) || '').trim() || 'main' };
  if (b.containers !== undefined) p.containers = Array.isArray(b.containers) ? b.containers : String(b.containers).split(/[\s,]+/).filter(Boolean);
  if (b.domains !== undefined) p.domains = Array.isArray(b.domains) ? b.domains : String(b.domains).split(/[\s,]+/).filter(Boolean);
  if (b.usageLimit !== undefined) p.usageLimit = Number(b.usageLimit) || 0;
  // regenerate commands from the chosen stack so they always match the current
  // folder/containers (only when NOT using custom commands)
  if (p.deployMethod && p.deployMethod !== 'custom') {
    const gen = engine.defaultCmds(p.deployMethod, p.remotePath, p.containers, p.backupDir);
    ['deployFullCmd', 'deployContainersCmd', 'buildCmd', 'backupCmd', 'restoreCmd'].forEach(k => { p[k] = gen[k]; });
  }
}

router.post('/projects', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Project name is required.' });
  const key = generateCode();
  const id = db.uid('prj');
  await db.mutate(d => {
    const p = { id, createdAt: new Date().toISOString(), containers: [], domains: [], usageLimit: 0, usage: { day: views.today(), count: 0 } };
    applyProjectFields(p, b);
    p.accessKeyHash = auth.hashKey(key);
    p.accessKeyHint = key.slice(-4);
    d.projects.push(p);
  });
  // key is shown exactly ONCE — we only keep its hash
  res.json({ ok: true, id, accessKey: key });
});

router.put('/projects/:id', async (req, res) => {
  let found = false;
  await db.mutate(d => {
    const p = d.projects.find(x => x.id === req.params.id);
    if (!p) return;
    found = true;
    applyProjectFields(p, req.body || {});
  });
  if (!found) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true });
});

router.delete('/projects/:id', async (req, res) => {
  await db.mutate(d => {
    d.projects = d.projects.filter(x => x.id !== req.params.id);
    delete d.history[req.params.id];
  });
  res.json({ ok: true });
});

router.post('/projects/:id/regenerate-key', async (req, res) => {
  const key = generateCode();
  let found = false;
  await db.mutate(d => {
    const p = d.projects.find(x => x.id === req.params.id);
    if (!p) return;
    found = true;
    p.accessKeyHash = auth.hashKey(key);
    p.accessKeyHint = key.slice(-4);
    p.disabled = false;
  });
  if (!found) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true, accessKey: key });
});

router.post('/projects/:id/disable', async (req, res) => {
  await db.mutate(d => { const p = d.projects.find(x => x.id === req.params.id); if (p) p.disabled = !!(req.body && req.body.disabled); });
  res.json({ ok: true });
});

router.get('/projects/:id', (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: views.projectPublic(p, d), history: d.history[p.id] || [] });
});

// suggest pages from the customer's docker-compose (owner confirms/renames them)
router.post('/projects/:id/detect-targets', async (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let vps;
  try { vps = views.resolveClientVps(p, d); } catch (e) { return res.status(400).json({ error: 'Add a client server to this project first.' }); }
  try {
    const info = await targets.analyze(vps, p);                 // this project's compose
    const host = await targets.hostScan(vps);                   // EVERY running app on the server
    // merge, de-duplicated by URL (so a second app in another folder shows up too)
    const seen = new Set(); const suggestions = [];
    const push = (label, kind, url) => { const u = String(url || '').replace(/\/+$/, ''); if (u && !seen.has(u)) { seen.add(u); suggestions.push({ label, kind, url: u }); } };
    (info.targets || []).forEach(t => push(t.kind === 'admin' ? 'Admin Panel' : 'Website', t.kind === 'admin' ? 'admin' : 'website', t.baseUrl));
    (host.suggestions || []).forEach(s => push(s.label, s.kind, s.url));
    res.json({ ok: true, suggestions, services: info.services || [], containers: host.containers || [], note: info.note || '' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// save the owner-labeled pages the customer will see in Point & Fix
router.put('/projects/:id/edit-targets', async (req, res) => {
  const arr = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  const clean = arr.map(targets.cleanTarget).filter(Boolean).slice(0, 12)
    .map((t, i) => ({ id: 'et_' + Date.now().toString(36) + i, ...t }));
  let found = false;
  await db.mutate(d => { const p = d.projects.find(x => x.id === req.params.id); if (!p) return; found = true; p.editTargets = clean; });
  if (!found) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true, editTargets: clean });
});

router.post('/projects/:id/test', async (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  try { res.json(await engine.testConnection(views.resolveClientVps(p, d))); }
  catch (e) { res.json({ ok: false, message: e.message }); }
});

// Prove the full GitHub pipeline (clone → commit → push) with a tiny real commit.
// Uses NO AI credit — the AI only writes edits; this is plain git.
router.post('/projects/:id/github-test-push', async (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!p.github || !p.github.repo) return res.status(400).json({ error: 'Set a repository first (owner/name) and Save.' });
  const token = db.dec(d.settings.githubTokenEnc);
  if (!token) return res.status(400).json({ error: 'Connect a GitHub token first in Settings.' });
  const branch = p.github.branch || 'main';
  const dir = path.join(db.dataDir(), 'repos', p.id);
  const s = await gitwork.sync({ dir, repo: p.github.repo, branch, token });
  if (!s.ok) return res.json({ ok: false, error: s.error });
  gitwork.writeFile(dir, 'cloudforge-test.md',
    '# CloudForge connection test\n\nCreated by CloudForge to confirm it can push to this repo. Safe to delete.\n\nLast test: ' + new Date().toISOString() + '\n');
  const r = await gitwork.commitPush({ dir, repo: p.github.repo, branch, token, message: 'CloudForge: connection test' });
  res.json(r.ok ? { ok: true, pushed: r.pushed, branch } : { ok: false, error: r.error });
});

// Write the GitHub Actions auto-deploy workflow into the repo (build on GitHub →
// GHCR image → deploy to the VPS). Commits .github/workflows/cloudforge-deploy.yml.
router.post('/projects/:id/github-setup-deploy', async (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!p.github || !p.github.repo) return res.status(400).json({ error: 'Set a repository first (owner/name) and Save.' });
  const token = db.dec(d.settings.githubTokenEnc);
  if (!token) return res.status(400).json({ error: 'Connect a GitHub token first in Settings.' });
  const branch = p.github.branch || 'main';
  const dir = path.join(db.dataDir(), 'repos', p.id);
  const s = await gitwork.sync({ dir, repo: p.github.repo, branch, token });
  if (!s.ok) return res.json({ ok: false, error: s.error });
  gitwork.writeFile(dir, '.github/workflows/cloudforge-deploy.yml', workflow.deployWorkflow({ branch }));
  const r = await gitwork.commitPush({ dir, repo: p.github.repo, branch, token, message: 'CloudForge: add auto-deploy workflow' });
  res.json(r.ok ? { ok: true, pushed: r.pushed, branch } : { ok: false, error: r.error });
});

/* ---- deploy / health / backups / ssl (admin can run anything) ---- */
function enqueueDeploy(p, d, mode) {
  const label = mode === 'containers' ? 'Deploy containers' : 'Deploy full website';
  const job = jobs.create({ projectId: p.id, mode, label });
  const vps = views.resolveClientVps(p, d);
  deployQueue(() => engine.deploy({ project: p, vps, mode, job, settings: d.settings }))
    .then(ok => db.mutate(x => {
      (x.history[p.id] = x.history[p.id] || []).unshift({ at: new Date().toISOString(), mode, ok, label });
      x.history[p.id] = x.history[p.id].slice(0, 50);
    }))
    .catch(err => { jobs.append(job, '\n✖ ' + err.message); jobs.finish(job, false); });
  return job;
}

router.post('/projects/:id/deploy', (req, res) => {
  const d = db.raw();
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const mode = (req.body && req.body.mode) === 'containers' ? 'containers' : 'full';
  try { res.json({ jobId: enqueueDeploy(p, d, mode).id }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/projects/:id/health', async (req, res) => {
  const d = db.raw(); const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  try { res.json(await engine.serverHealth(views.resolveClientVps(p, d))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/projects/:id/http', async (req, res) => {
  const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(await engine.httpCheck((p.domains && p.domains[0]) || ''));
});
router.get('/projects/:id/backups', async (req, res) => {
  const d = db.raw(); const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  try { res.json(await engine.listBackups(views.resolveClientVps(p, d), p.backupDir)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/projects/:id/restore', (req, res) => {
  const d = db.raw(); const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const file = (req.body && req.body.file) || '';
  if (!file) return res.status(400).json({ error: 'Pick a backup file.' });
  try {
    const job = jobs.create({ projectId: p.id, label: 'Rollback ' + file });
    const vps = views.resolveClientVps(p, d);
    deployQueue(() => engine.restore({ project: p, vps, file, job, settings: d.settings }))
      .catch(err => { jobs.append(job, '\n✖ ' + err.message); jobs.finish(job, false); });
    res.json({ jobId: job.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/projects/:id/ssl', (req, res) => {
  const d = db.raw(); const p = findProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const domain = (req.body && req.body.domain) || (p.domains && p.domains[0]);
  if (!domain) return res.status(400).json({ error: 'No domain.' });
  try {
    const job = jobs.create({ projectId: p.id, label: 'SSL ' + domain });
    const vps = views.resolveClientVps(p, d);
    deployQueue(() => engine.issueSsl({ project: p, vps, domain, job }))
      .catch(err => { jobs.append(job, '\n✖ ' + err.message); jobs.finish(job, false); });
    res.json({ jobId: job.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/check-cert', async (req, res) => res.json(await engine.checkCert(req.query.domain)));

router.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found (it may have expired).' });
  res.json(jobs.view(j));
});

module.exports = router;
