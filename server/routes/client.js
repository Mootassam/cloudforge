'use strict';
// Everything here is locked to req.session.projectId. A client can NEVER reach
// another project — the id comes from their session, never from the URL/body.
const express = require('express');
const path = require('path');
const router = express.Router();
const db = require('../lib/db');
const auth = require('../lib/auth');
const engine = require('../lib/engine');
const jobs = require('../lib/jobs');
const views = require('../lib/views');
const aiengine = require('../lib/aiengine');
const pricing = require('../lib/pricing');
const gitwork = require('../lib/gitwork');
const targets = require('../lib/targets');
const capture = require('../lib/capture');
const { deployQueue } = require('../lib/runtime');

router.use(auth.requireClient);

function myProject(req) { return db.raw().projects.find(p => p.id === req.session.projectId); }

// Fold the captured page + pointed element into a short context block the AI reads.
function buildUserText(page, text) {
  const t = String(text || '').trim();
  if (!page || !page.url) return t || 'Please help.';
  let path = '';
  try { path = new URL(page.url).pathname || '/'; } catch { /* ignore */ }
  const el = page.element || null;
  const lines = ['[Context — the customer pointed at a specific place on their live site]'];
  lines.push('Page URL: ' + page.url);
  if (path) lines.push('Page path (use this with find_text): ' + path);
  if (el) {
    const bits = [];
    if (el.text) bits.push('text "' + el.text + '"');
    if (el.id) bits.push('id "' + el.id + '"');
    if (el.name) bits.push('name "' + el.name + '"');
    if (el.placeholder) bits.push('placeholder "' + el.placeholder + '"');
    if (el.selector) bits.push('selector ' + el.selector);
    lines.push('They pointed at a <' + (el.tag || 'element') + '> — ' + (bits.join(', ') || '(no details)') + '.');
    if (el.html) lines.push('Element HTML: ' + el.html);
  }
  lines.push('A screenshot is attached; the red marks show the spot they mean.');
  return lines.join('\n') + '\n\n--- What they want ---\n' + (t || '(see the screenshot)');
}
function aiBlocker(project, data) {
  const prov = data.settings.aiProvider || 'claude';
  const keySet = prov === 'openai' ? !!data.settings.openaiKeyEnc : prov === 'gemini' ? !!data.settings.geminiKeyEnc : !!data.settings.aiKeyEnc;
  if (!keySet) return 'The AI developer is being set up by your provider.';
  const hasGithub = project.github && project.github.repo && data.settings.githubTokenEnc;
  if (!hasGithub && (!project.clientServerId || !project.remotePath)) return 'This project isn’t fully set up for AI yet. Contact your provider.';
  return null;
}
// If this project is linked to a GitHub repo (and a token is saved), build the
// info the AI engine needs to clone/commit/push. Otherwise null → VPS mode.
function githubFor(project, data) {
  if (!project.github || !project.github.repo) return null;
  const token = db.dec(data.settings.githubTokenEnc);
  if (!token) return null;
  const base = db.dataDir();
  return { repo: project.github.repo, branch: project.github.branch || 'main', token, workdir: path.join(base, 'repos', project.id) };
}
// Turn any technical/API error into a clean message a customer can understand.
function friendlyAiError(e) {
  const m = ((e && e.message) || String(e)).toLowerCase();
  // 1) free-tier / rate limits → just wait (NOT a money problem)
  if (/free_tier_limit|free.?tier|resource.?exhausted|rate.?limit|rate_limit|too many requests|overloaded|at capacity/.test(m)) return 'The AI hit its free/rate limit. Please wait about a minute and try again.';
  // 2) a paid-only model was chosen → needs billing enabled
  if (/needs_billing/.test(m)) return 'That AI model needs billing enabled. In Settings, use a free model like gemini-2.5-flash — or enable billing.';
  // 3) bad / missing key
  if (/bad_key|invalid x-api-key|authentication|\bapi[ _-]?key\b|unauthorized|\b401\b/.test(m)) return 'The AI key isn’t valid. Please re-check it in Settings.';
  // 4) model not available
  if (/bad_model|not found|no longer available|not supported for generatecontent/.test(m)) return 'That AI model isn’t available. In Settings, use gemini-2.5-flash (free) or a current model.';
  // 5) genuinely out of money (OpenAI insufficient_quota carries "billing")
  if (/insufficient_quota|insufficient funds|out of credit|billing|payment|\bcredit\b/.test(m)) return 'The AI account is out of credit (or billing isn’t set up). Add credit, or switch to Gemini’s free tier in Settings.';
  if (/timeout|timed out|econn|network|socket|fetch failed/.test(m)) return 'Couldn’t reach the AI or your server. Please try again in a moment.';
  if (/host or ssh|connection refused|not linked|folder/.test(m)) return 'Couldn’t reach your project files. Please contact your provider.';
  return 'Something went wrong while working on your request. Please try again — if it keeps happening, contact your provider.';
}

router.get('/me', (req, res) => {
  const d = db.raw();
  const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Your project no longer exists. Contact your provider.' });
  const v = views.projectPublic(p, d);
  // the client sees only what they need — no server host, no commands, no rules editor
  res.json({
    project: {
      id: v.id, name: v.name, customer: v.customer,
      domains: v.domains, usageLimit: v.usageLimit, usageToday: v.usageToday,
      canFull: !!p.deployFullCmd, canContainers: !!p.deployContainersCmd,
      hasBackups: !!p.backupDir,
      github: !!(p.github && p.github.repo),
      aiBlocked: aiBlocker(p, d)
    },
    history: (d.history[p.id] || []).slice(0, 20),
    queue: deployQueue.stats()
  });
});

// deploy — counts against the daily limit
router.post('/deploy', async (req, res) => {
  const d = db.raw();
  const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const mode = (req.body && req.body.mode) === 'containers' ? 'containers' : 'full';

  const u = views.usageToday(p);
  if (p.usageLimit > 0 && u.count >= p.usageLimit)
    return res.status(429).json({ error: `Daily deploy limit reached (${p.usageLimit}). Try again tomorrow or contact your provider.` });

  let vps;
  try { vps = views.resolveClientVps(p, d); }
  catch (e) { return res.status(400).json({ error: 'Deploy is not ready yet. Contact your provider.' }); }

  await db.mutate(x => {
    const pp = x.projects.find(y => y.id === p.id);
    pp.usage = { day: views.today(), count: u.count + 1 };
  });

  const label = mode === 'containers' ? 'Deploy containers' : 'Deploy full website';
  const job = jobs.create({ projectId: p.id, mode, label });
  deployQueue(() => engine.deploy({ project: p, vps, mode, job, settings: d.settings }))
    .then(ok => db.mutate(x => {
      (x.history[p.id] = x.history[p.id] || []).unshift({ at: new Date().toISOString(), mode, ok, label, by: 'client' });
      x.history[p.id] = x.history[p.id].slice(0, 50);
    }))
    .catch(err => { jobs.append(job, '\n✖ ' + err.message); jobs.finish(job, false); });
  res.json({ jobId: job.id });
});

router.get('/http', async (req, res) => {
  const p = myProject(req);
  res.json(await engine.httpCheck((p.domains && p.domains[0]) || ''));
});

router.get('/backups', async (req, res) => {
  const d = db.raw(); const p = myProject(req);
  try { res.json(await engine.listBackups(views.resolveClientVps(p, d), p.backupDir)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/restore', (req, res) => {
  const d = db.raw(); const p = myProject(req);
  const file = (req.body && req.body.file) || '';
  if (!file) return res.status(400).json({ error: 'Pick a backup.' });
  try {
    const vps = views.resolveClientVps(p, d);
    const job = jobs.create({ projectId: p.id, label: 'Rollback ' + file });
    deployQueue(() => engine.restore({ project: p, vps, file, job, settings: d.settings }))
      .catch(err => { jobs.append(job, '\n✖ ' + err.message); jobs.finish(job, false); });
    res.json({ jobId: job.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- Point & Fix (server-browser) ---------------- */
// What the customer HAS and WHERE to open it (reads their docker-compose).
router.get('/targets', async (req, res) => {
  const d = db.raw(); const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  // Owner-defined pages are the reliable source — use them when set.
  if (Array.isArray(p.editTargets) && p.editTargets.length) {
    const o = targets.fromOwner(p.editTargets);
    return res.json({ ok: true, owner: true, targets: o.targets, allowedHosts: o.allowedHosts, services: [], note: '' });
  }
  if (!p.clientServerId || !p.remotePath) return res.json({ ok: true, targets: [], services: [], note: 'This project isn’t fully set up yet. Contact your provider.' });
  let vps;
  try { vps = views.resolveClientVps(p, d); } catch (e) { return res.json({ ok: true, targets: [], services: [], note: 'Couldn’t reach your server right now.' }); }
  try { res.json(await targets.analyze(vps, p)); }
  catch (e) { res.json({ ok: true, targets: [], services: [], note: 'Couldn’t read your setup right now.' }); }
});

function capSession(req) { return capture.get((req.body && req.body.sessionId) || '', req.session.projectId); }
function capXY(req) {
  const b = req.body || {};
  return { x: Number(b.x) || 0, y: Number(b.y) || 0, w: Number(b.w) || 1280, h: Number(b.h) || 800 };
}

// open a chosen target in our server-browser
router.post('/capture/start', async (req, res) => {
  if (!capture.available()) return res.status(400).json({ error: 'The point-and-click browser isn’t available on the server yet. You can still type your request to the AI.' });
  const d = db.raw(); const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let vps;
  try { vps = views.resolveClientVps(p, d); } catch (e) { return res.status(400).json({ error: 'Your server isn’t set up yet. Contact your provider.' }); }
  let info;
  if (Array.isArray(p.editTargets) && p.editTargets.length) info = targets.fromOwner(p.editTargets);
  else { try { info = await targets.analyze(vps, p); } catch (e) { return res.status(400).json({ error: 'Couldn’t read your setup. Contact your provider.' }); } }
  const target = (info.targets || []).find(t => t.id === (req.body && req.body.targetId));
  if (!target) return res.status(400).json({ error: 'That page option is no longer available. Refresh and try again.' });
  try {
    const out = await capture.openSession({ ownerProjectId: p.id, baseUrl: target.baseUrl, allowHosts: info.allowedHosts });
    res.json({ ...out, target: { id: target.id, label: target.label, kind: target.kind } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/capture/click', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  const { x, y, w, h } = capXY(req);
  try { res.json(await capture.click(s, x, y, w, h)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/point', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  const { x, y, w, h } = capXY(req);
  try { res.json(await capture.point(s, x, y, w, h)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/type', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  try { res.json(await capture.type(s, (req.body && req.body.text) || '')); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/press', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  try { res.json(await capture.press(s, (req.body && req.body.key) || 'Enter')); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/back', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  try { res.json(await capture.back(s)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/reload', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  try { res.json(await capture.reload(s)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/fields', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  try { res.json(await capture.fields(s)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/fill', async (req, res) => {
  const s = capSession(req); if (!s) return res.status(404).json({ error: 'Session expired — reopen the page.' });
  const b = req.body || {};
  try { res.json(await capture.fill(s, b.index, b.value)); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/capture/close', async (req, res) => {
  const b = req.body || {};
  // only close your own session
  if (capture.get(b.sessionId || '', req.session.projectId)) await capture.closeSession(b.sessionId).catch(() => {});
  res.json({ ok: true });
});

/* ---------------- AI developer ---------------- */
router.get('/ai/state', (req, res) => {
  const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(aiengine.state(p.id));
});

router.post('/ai/chat', (req, res) => {
  const d = db.raw();
  const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const blocked = aiBlocker(p, d);
  if (blocked) return res.status(400).json({ error: blocked });

  const gh = githubFor(p, d);
  let vps = null;
  try { vps = views.resolveClientVps(p, d); } catch (e) { if (!gh) return res.status(400).json({ error: e.message }); }
  const provider = ['openai', 'gemini', 'claude'].includes(d.settings.aiProvider) ? d.settings.aiProvider : 'claude';
  const apiKey = provider === 'openai' ? db.dec(d.settings.openaiKeyEnc) : provider === 'gemini' ? db.dec(d.settings.geminiKeyEnc) : db.dec(d.settings.aiKeyEnc);
  const model = (provider === 'openai' ? d.settings.openaiModel : provider === 'gemini' ? d.settings.geminiModel : d.settings.aiModel) || undefined;
  const { text, imageBase64, imageMediaType, page } = req.body || {};

  // If the customer pointed at a spot on their live site, hand the AI the page
  // URL + the exact element so it can find the right file (via find_text).
  const userText = buildUserText(page, text);

  const job = jobs.create({ projectId: p.id, label: 'AI developer' });
  job.status = 'running';
  (async () => {
    try {
      const out = await aiengine.chat({
        project: p, vps, apiKey, model, provider, userText,
        imageBase64, imageMediaType, globalRules: d.settings.globalRules, github: gh,
        onStep: (name, inp) => jobs.append(job,
          name === 'list_files' ? '📂 looking at the project files…' :
          name === 'read_file' ? ('📖 reading ' + (inp.path || '')) :
          name === 'propose_edit' ? ('✏️ preparing a change to ' + (inp.path || '')) : name)
      });
      job.result = out;
      // record estimated AI spend (owner sees it in the admin panel)
      try { if (out.usage) await db.recordUsage({ model: out.model, usage: out.usage, cost: pricing.costOf(out.model, out.usage), projectId: p.id }); } catch { }
      jobs.finish(job, true);
    } catch (e) {
      console.error('[ai/chat]', e && e.message);   // real error stays in the server log
      job.result = { error: friendlyAiError(e) };    // customer sees a clean message
      jobs.finish(job, false);
    }
  })();
  res.json({ jobId: job.id });
});

router.post('/ai/approve', (req, res) => {
  const d = db.raw();
  const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const gh = githubFor(p, d);
  let vps = null;
  try { vps = views.resolveClientVps(p, d); } catch (e) { if (!gh) return res.status(400).json({ error: e.message }); }
  const mode = (req.body && req.body.mode) === 'containers' ? 'containers' : 'full';
  const job = jobs.create({ projectId: p.id, label: gh ? 'Push AI changes to GitHub' : 'Apply AI changes' });
  deployQueue(() => aiengine.apply({ project: p, vps, job, settings: d.settings, deployMode: mode, github: gh }))
    .then(ok => db.mutate(x => {
      (x.history[p.id] = x.history[p.id] || []).unshift({ at: new Date().toISOString(), mode, ok, label: gh ? 'AI changes pushed to GitHub' : 'AI changes applied + deployed', by: 'ai' });
      x.history[p.id] = x.history[p.id].slice(0, 50);
    }))
    .catch(err => { jobs.append(job, '✖ ' + err.message); jobs.finish(job, false); });
  res.json({ jobId: job.id });
});

router.post('/ai/discard', (req, res) => { const p = myProject(req); if (p) aiengine.discard(p.id); res.json({ ok: true }); });

// Undo the last change (GitHub projects) — reverts the last commit and pushes.
router.post('/ai/rollback', (req, res) => {
  const d = db.raw(); const p = myProject(req);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const gh = githubFor(p, d);
  if (!gh) return res.status(400).json({ error: 'Undo is available for GitHub-connected projects.' });
  const job = jobs.create({ projectId: p.id, label: 'Undo last change' });
  job.status = 'running';
  deployQueue(async () => {
    jobs.append(job, 'Undoing the last change on GitHub…');
    const r = await gitwork.revertLast({ dir: gh.workdir, repo: gh.repo, branch: gh.branch, token: gh.token });
    if (r.ok) { jobs.append(job, '✔ Undone — the previous version will be rebuilt & published.'); jobs.finish(job, true); }
    else { jobs.append(job, '✖ ' + r.error); jobs.finish(job, false); }
  })
    .then(() => db.mutate(x => { (x.history[p.id] = x.history[p.id] || []).unshift({ at: new Date().toISOString(), ok: true, label: 'Undo last change', by: 'client' }); x.history[p.id] = x.history[p.id].slice(0, 50); }))
    .catch(err => { jobs.append(job, '✖ ' + err.message); jobs.finish(job, false); });
  res.json({ jobId: job.id });
});

// job polling — ownership enforced: a client only sees their own project's jobs
router.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.projectId !== req.session.projectId) return res.status(404).json({ error: 'Job not found.' });
  res.json(jobs.view(j));
});

module.exports = router;
