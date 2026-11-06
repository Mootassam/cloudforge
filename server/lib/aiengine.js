'use strict';
// AI developer engine: gives Claude safe tools to read a project's files over
// SSH and PROPOSE edits. Nothing is written until the customer clicks Approve;
// then we back up, write the files, and deploy. Conversation + staged changes
// are kept per project (in memory).
const { runCommand } = require('../../src/ssh');
const aiClaude = require('./ai');
const aiOpenai = require('./ai_openai');
const aiGemini = require('./ai_gemini');
const ENGINES = { claude: aiClaude, openai: aiOpenai, gemini: aiGemini };
const { DEFAULT_MODEL } = aiClaude;
const jobs = require('./jobs');
const gitwork = require('./gitwork');

const convos = new Map(); // projectId -> { messages:[], changes: Map(path->{...}) }
function convo(id) { if (!convos.has(id)) convos.set(id, { messages: [], changes: new Map() }); return convos.get(id); }
function reset(id) { convos.delete(id); }

// keep a relative path safe (no escaping the project folder)
function safeRel(p) {
  let s = String(p || '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || /[`"'\n\r]/.test(s) || s.split('/').some(seg => seg === '..')) throw new Error('Unsafe path: ' + p);
  return s;
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // single-quote for shell

const TOOLS = [
  { name: 'list_files', description: 'List the project files (relative paths). Call this first to see what exists.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_file', description: 'Read a file in the project.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'find_text', description: 'Search the whole project for a piece of text and get matching files + line numbers. Use this to locate the right file from a page route (e.g. "/menu") or from the exact words/attributes of the element the customer pointed at (e.g. a button label or an id). Fastest way to find WHERE a page or section lives.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'propose_edit', description: 'Propose the new full contents of a file (created if missing). Does NOT apply until the customer approves. Provide a one-line summary of the change.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, summary: { type: 'string' } }, required: ['path', 'content', 'summary'], additionalProperties: false } }
];

function makeExec(vps, root, changes) {
  const base = `cd ${q(root)} 2>/dev/null`;
  return async (name, input) => {
    if (name === 'list_files') {
      const r = await runCommand(vps, `${base} && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/vendor/*' 2>/dev/null | sed 's|^\\./||' | head -400`);
      return r.stdout.trim() || '(no files found — is the folder correct?)';
    }
    if (name === 'read_file') {
      const rel = safeRel(input.path);
      const r = await runCommand(vps, `${base} && [ -f ${q(rel)} ] && head -c 60000 -- ${q(rel)} || echo '__CF_NO_FILE__'`);
      if (r.stdout.includes('__CF_NO_FILE__')) return 'File does not exist: ' + rel;
      return r.stdout;
    }
    if (name === 'find_text') {
      const query = String(input.query || '').trim();
      if (!query) return 'Give a non-empty search text.';
      const r = await runCommand(vps, `${base} && grep -rnI -F --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=vendor -- ${q(query)} . 2>/dev/null | sed 's|^\\./||' | head -40`);
      return r.stdout.trim() || '(no matches for: ' + query + ')';
    }
    if (name === 'propose_edit') {
      const rel = safeRel(input.path);
      const r = await runCommand(vps, `${base} && [ -f ${q(rel)} ] && head -c 60000 -- ${q(rel)} || echo '__CF_NEW__'`);
      const oldContent = r.stdout.includes('__CF_NEW__') ? '' : r.stdout;
      changes.set(rel, { path: rel, newContent: String(input.content), oldContent, summary: input.summary || 'edit', isNew: !oldContent });
      return `Staged change to ${rel} (awaiting customer approval).`;
    }
    return 'Unknown tool.';
  };
}

// GitHub mode: the same tools, but over a LOCAL working copy of the repo
// (fast, and find_text is a real local search). Edits are staged, then committed
// + pushed on approve.
function makeLocalExec(dir, changes) {
  return async (name, input) => {
    if (name === 'list_files') { const f = gitwork.listFiles(dir); return f.length ? f.join('\n') : '(no files found — is the repo empty?)'; }
    if (name === 'read_file') { const r = gitwork.readFile(dir, input.path); return r == null ? ('File does not exist: ' + input.path) : r; }
    if (name === 'find_text') { const q = String(input.query || '').trim(); if (!q) return 'Give a non-empty search text.'; const h = gitwork.findText(dir, q); return h.length ? h.join('\n') : ('(no matches for: ' + q + ')'); }
    if (name === 'propose_edit') {
      const rel = gitwork.safeRel(input.path);
      const old = gitwork.readFile(dir, rel);
      changes.set(rel, { path: rel, newContent: String(input.content), oldContent: old || '', summary: input.summary || 'edit', isNew: old == null });
      return `Staged change to ${rel} (awaiting customer approval).`;
    }
    return 'Unknown tool.';
  };
}

// From changed file paths, find the distinct nearest folders that contain a
// package.json (the "build roots"). '' means the project root.
async function touchedBuildRoots(vps, root, changedPaths) {
  const dirs = [...new Set(changedPaths.map(p => p.includes('/') ? p.replace(/\/[^/]+$/, '') : '.'))];
  if (!dirs.length) return [];
  const list = dirs.map(d => q(d)).join(' ');
  const script = `cd ${q(root)} 2>/dev/null && for d in ${list}; do cur="$d"; while :; do ` +
    `if [ -f "$cur/package.json" ]; then echo "$cur"; break; fi; ` +
    `if [ "$cur" = "." ] || [ -z "$cur" ]; then break; fi; cur=$(dirname "$cur"); done; done | sort -u`;
  const r = await runCommand(vps, script);
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean).map(s => s === '.' ? '' : s);
}

// For Docker: which compose services match the changed top-level folders.
async function touchedServices(vps, root, changedPaths) {
  const tops = [...new Set(changedPaths.map(p => p.split('/')[0]).filter(x => x && x !== '.'))];
  if (!tops.length) return [];
  const r = await runCommand(vps, `cd ${q(root)} && docker compose config --services 2>/dev/null`);
  const svcs = new Set(r.stdout.split('\n').map(s => s.trim()).filter(Boolean));
  return tops.filter(t => svcs.has(t));
}

// Build ONLY what changed, install new packages, then restart. Robust + fast.
async function smartBuild({ project, vps, changedPaths, send }) {
  const root = project.remotePath;
  const method = project.deployMethod;

  if (method === 'pm2') {
    const script = (project.buildScript && project.buildScript.trim()) || 'build';
    const roots = await touchedBuildRoots(vps, root, changedPaths);
    if (!roots.length) send('No package.json in the changed folders — skipping build.');
    for (const r of roots) {
      const dir = r ? `${root.replace(/\/$/, '')}/${r}` : root;
      send(`\n$ Building ${r || '(root)'} …`);
      // install new deps (ci if lockfile is in sync, else install), then the build script if it exists
      const res = await runCommand(vps, `cd ${q(dir)} && (npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund) && npm run ${script} --if-present`, send);
      if (res.code !== 0) return false;
    }
    send('\n$ Restarting the app …');
    const rr = await runCommand(vps, `cd ${q(root)} && pm2 restart all`, send);
    return rr.code === 0;
  }

  // Docker: rebuild only the changed service(s); Docker's layer cache keeps
  // untouched ones fast. If service names don't match folders, rebuild all.
  const services = await touchedServices(vps, root, changedPaths);
  const svc = services.length ? ' ' + services.join(' ') : '';
  send(services.length ? `\n$ Rebuilding changed service(s):${svc}` : '\n$ Rebuilding & starting containers …');
  const r = await runCommand(vps, `cd ${q(root)} && docker compose up -d --build${svc}`, send);
  if (r.code !== 0 && services.length) {
    send('\n(Service names didn’t match the folders — rebuilding everything to be safe.)');
    const r2 = await runCommand(vps, `cd ${q(root)} && docker compose up -d --build`, send);
    return r2.code === 0;
  }
  return r.code === 0;
}

function systemPrompt(project, globalRules) {
  return [
    `You are the AI developer for the website "${project.name}" (customer: ${project.customer || 'n/a'}).`,
    `The customer is NOT technical. They cannot use a terminal, SSH, git, npm, or Docker. Talk to them in plain, friendly language.`,

    `\n=== HOW DEPLOYMENT WORKS (VERY IMPORTANT) ===`,
    `You are working inside the customer's live project folder on their server. Everything you can browse with the tools is their real project — app folders, source code, Dockerfiles, docker-compose.yml, config files. You may READ and PROPOSE EDITS to ANY file here, including Dockerfiles and docker-compose.yml.`,
    `When the customer clicks "Approve & deploy", CloudForge AUTOMATICALLY does ALL of this for them:`,
    `  1) takes a safety backup,`,
    `  2) writes your proposed file changes to the server,`,
    `  3) installs any new packages,`,
    `  4) rebuilds ONLY the parts that changed,`,
    `  5) restarts the site so the change goes live.`,
    `So to make ANYTHING happen, you ONLY need to propose the file edits. That's it.`,

    `\n=== HARD RULES ON INSTRUCTIONS ===`,
    `• NEVER tell the customer to run commands, open a terminal, SSH in, run git/npm/docker, or do any manual server step. That is all automatic on Approve. Giving manual commands is a failure.`,
    `• NEVER say "you'll need to do this yourself" or "ask your provider to run…". If something needs doing, express it as a FILE EDIT you propose.`,
    `• If a change requires different build behavior, PROPOSE the edit to the Dockerfile / docker-compose.yml / build config yourself — do not ask the customer to run build commands.`,
    `• If a file or folder you truly need is NOT visible in the tools, say exactly: "I can't see that part of your project yet — please ask your provider to point me at the right project folder." Do NOT give a manual workaround.`,

    `\n=== HOW TO WORK ===`,
    `• If the customer's message includes a "[Context]" block (the page URL they were on and the exact element they pointed at), USE IT to find the right place fast: call find_text with the page path (e.g. "/menu") or with the element's words/id/selector, then read_file the matches. That is the section they mean — don't guess elsewhere.`,
    `• Use list_files, find_text and read_file to understand the code FIRST.`,
    `• Then call propose_edit for each file to change. Edits are NOT applied until the customer approves — propose freely.`,
    `• Keep changes minimal and safe. Preserve the existing style. Never delete features unless explicitly asked.`,
    `• End with a short, plain-language summary of what you changed, and finish with: "Click Approve & deploy and I'll build and publish it for you." (No command lists, ever.)`,

    project.rules ? `\n=== PROJECT RULES (MUST FOLLOW) ===\n${project.rules}` : '',
    globalRules ? `\n=== GLOBAL RULES (MUST FOLLOW) ===\n${globalRules}` : '',

    `\n=== SAFETY ===`,
    `This may be a live business/trading site. If a request touches payments, authentication, or trading logic, warn the customer and make the smallest safe change (or decline per the rules).`
  ].filter(Boolean).join('\n');
}

// one chat turn
async function chat({ project, vps, apiKey, model, provider, userText, imageBase64, imageMediaType, globalRules, github, onStep }) {
  const c = convo(project.id);
  const content = [];
  if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/png', data: imageBase64 } });
  content.push({ type: 'text', text: userText || 'Please help.' });
  c.messages.push({ role: 'user', content });

  let exec;
  if (github && github.repo) {
    if (onStep) onStep('list_files', {}); // shows "looking at the project files…" while we sync
    const s = await gitwork.sync({ dir: github.workdir, repo: github.repo, branch: github.branch, token: github.token });
    if (!s.ok) { c.messages.pop(); throw new Error('Couldn’t open your code from GitHub: ' + s.error); }
    c.source = 'github'; c.workdir = github.workdir; c.branch = s.branch;
    exec = makeLocalExec(github.workdir, c.changes);
  } else {
    c.source = 'vps';
    exec = makeExec(vps, project.remotePath, c.changes);
  }
  const aiEngine = ENGINES[provider] || aiClaude;
  let out;
  try {
    out = await aiEngine.runAgent({
      apiKey, model: model || aiEngine.DEFAULT_MODEL,
      system: systemPrompt(project, globalRules),
      messages: c.messages, tools: TOOLS, exec, onStep
    });
  } catch (e) {
    c.messages.pop(); // remove the failed user turn so a retry starts clean
    throw e;
  }
  c.messages = out.messages;
  return { reply: out.text, changes: [...c.changes.values()], usage: out.usage, model: out.model };
}

// apply staged changes: backup -> write files -> deploy (streamed into a job)
async function apply({ project, vps, job, settings, deployMode, github }) {
  const c = convo(project.id);
  const changes = [...c.changes.values()];
  if (!changes.length) throw new Error('No changes to apply.');
  job.status = 'running';
  const send = (t) => jobs.append(job, t);

  // GitHub mode: save the edits into the working copy, commit, and push.
  // (GitHub history IS the backup; the build/deploy happens from GitHub.)
  if (github && github.repo) {
    const dir = github.workdir || c.workdir;
    send('\n$ ── Saving your changes to GitHub ──');
    for (const ch of changes) {
      try { gitwork.writeFile(dir, ch.path, ch.newContent); send('  ✓ ' + ch.path); }
      catch (e) { send('  ✖ ' + ch.path + ' (' + e.message + ')'); jobs.finish(job, false); return false; }
    }
    const msg = 'CloudForge: ' + changes.map(x => x.summary).join('; ').slice(0, 180);
    send('\n$ ── Committing & pushing to GitHub ──');
    const r = await gitwork.commitPush({ dir, repo: github.repo, branch: github.branch, token: github.token, message: msg });
    if (!r.ok) { send('\n✖ ' + (r.error || 'Push failed.')); jobs.finish(job, false); return false; }
    send(r.pushed ? ('\n✔ Pushed ' + changes.length + ' file(s) to GitHub. Your build & deploy will publish it.') : '\n(Nothing changed — nothing to push.)');
    c.changes.clear();
    jobs.finish(job, true);
    return true;
  }

  if (project.backupDir && String(project.backupDir).trim() && project.backupCmd) {
    send('\n$ ── Safety backup (so we can undo) ──');
    const b = await runCommand(vps, project.backupCmd, send);
    if (b.code !== 0) { send('\n✖ Backup failed — stopping, nothing was changed.'); jobs.finish(job, false); return false; }
  }

  send('\n$ ── Writing ' + changes.length + ' file(s) ──');
  const root = project.remotePath;
  for (const ch of changes) {
    const b64 = Buffer.from(ch.newContent, 'utf8').toString('base64');
    const dir = ch.path.includes('/') ? ch.path.replace(/\/[^/]+$/, '') : '';
    const cmd = `cd ${q(root)} && ${dir ? `mkdir -p ${q(dir)} && ` : ''}printf '%s' '${b64}' | base64 -d > ${q(ch.path)}`;
    const r = await runCommand(vps, cmd);
    send(r.code === 0 ? `  ✓ ${ch.path}` : `  ✖ ${ch.path} (exit ${r.code})`);
    if (r.code !== 0) { send('\n✖ Write failed — stopping.'); jobs.finish(job, false); return false; }
  }

  // smart build & deploy: only rebuild the folders that changed, install any
  // new packages, then restart.
  send('\n$ ── Building & deploying (only what changed) ──');
  let built;
  if (project.deployMethod === 'custom') {
    const cmd = (project.buildCmd && String(project.buildCmd).trim())
      ? project.buildCmd
      : (deployMode === 'containers' ? project.deployContainersCmd : project.deployFullCmd);
    if (cmd && String(cmd).trim()) { const r = await runCommand(vps, cmd, send); built = r.code === 0; }
    else built = true;
  } else {
    built = await smartBuild({ project, vps, changedPaths: changes.map(x => x.path), send });
  }
  if (!built) { send('\n✖ Build/deploy failed — check the log above. Nothing else was changed.'); jobs.finish(job, false); return false; }
  send('\n✔ Changes applied, built, and deployed successfully.');
  c.changes.clear();
  jobs.finish(job, true);
  return true;
}

function state(projectId) {
  const c = convo(projectId);
  // return a UI-friendly transcript (user text + assistant text only)
  const transcript = [];
  for (const m of c.messages) {
    if (m.role === 'user') {
      const t = Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : (Array.isArray(m.content) ? '' : m.content);
      const hasImg = Array.isArray(m.content) && m.content.some(b => b.type === 'image');
      if (t || hasImg) transcript.push({ role: 'user', text: t, image: hasImg });
    } else if (m.role === 'assistant') {
      const t = Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : m.content;
      if (t && t.trim()) transcript.push({ role: 'assistant', text: t });
    }
  }
  return { transcript, changes: [...c.changes.values()] };
}

function discard(projectId) { convo(projectId).changes.clear(); }

module.exports = { chat, apply, state, discard, reset };
