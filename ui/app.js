'use strict';
/* CloudForge Admin — renderer */

window.addEventListener('error', (e) => {
  const v = document.getElementById('view');
  if (v) v.innerHTML = `<div class="warnline" style="color:var(--red);background:var(--red-bg);border-color:#5a2230">⚠ Startup error: ${(e.message || 'unknown')}<br><span class="muted">${(e.filename || '')}:${e.lineno || ''}</span></div>`;
});

const api = window.cf;
let DATA = { projects: [], globalRules: '', settings: {}, history: {} };
let route = 'dashboard';
let currentId = null;
let editing = null;
let projTab = 'overview';
const STATUS = {}; // id -> {ok,status,ms}

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (kb) => kb ? (kb / 1048576).toFixed(1) + ' GB' : '—';
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

// Auto-build deploy/backup/restore commands from the stack + fields (no typing needed).
function buildCommands(method, src, cont, backupDir) {
  src = src || '.'; backupDir = backupDir || '/root/cloudforge-backups';
  const names = [cont.backend, cont.admin, cont.server].filter(Boolean).join(' ');
  const T = {
    'compose-git': {
      full: `cd ${src} && git pull && docker compose up -d --build`,
      containers: `cd ${src} && git pull && docker compose up -d --build ${names}`,
      restore: `cd ${src} && tar xzf {file} -C ${src} && docker compose up -d`
    },
    'compose': {
      full: `cd ${src} && docker compose up -d --build`,
      containers: `cd ${src} && docker compose up -d --build ${names}`,
      restore: `cd ${src} && tar xzf {file} -C ${src} && docker compose up -d`
    },
    'pm2': {
      full: `cd ${src} && git pull && npm install && pm2 restart all`,
      containers: `cd ${src} && git pull && npm install && pm2 restart all`,
      restore: `cd ${src} && tar xzf {file} -C ${src} && pm2 restart all`
    }
  };
  const t = T[method] || T['compose-git'];
  return {
    deployFullCmd: t.full,
    deployContainersCmd: (t.containers || t.full).trim(),
    backupCmd: `mkdir -p ${backupDir} && cd ${src} && tar czf ${backupDir}/backup-$(date +%F-%H%M).tgz .`,
    restoreCmd: t.restore
  };
}

function toast(msg, type = 'info') {
  const t = el('div', `toast ${type}`, `<span class="ti">${type === 'ok' ? '✔' : type === 'err' ? '✖' : 'ℹ'}</span><span>${esc(msg)}</span>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 200); }, 3400);
}

async function reload() { DATA = await api.getData(); }
function proj() { return DATA.projects.find(x => x.id === currentId); }

function setRoute(r, id = null) {
  route = r; currentId = id;
  if (r === 'project') projTab = 'overview';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === r || (r === 'project' && n.dataset.route === 'projects')));
  render();
}
function setTop(crumb, title, actionsHtml = '') {
  $('#crumb').textContent = crumb; $('#page-title').textContent = title; $('#topbar-actions').innerHTML = actionsHtml;
}

/* ================= views ================= */
function render() {
  if (route === 'dashboard') return renderDashboard();
  if (route === 'projects') return renderProjects();
  if (route === 'project') return renderProjectDetail();
  if (route === 'rules') return renderRules();
  if (route === 'settings') return renderSettings();
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  setTop('Dashboard', 'Overview', `<button class="btn" id="refresh-status">⟳ Refresh status</button><button class="btn primary" id="add-top">+ New project</button>`);
  $('#add-top').onclick = () => openDrawer();
  $('#refresh-status').onclick = refreshStatus;

  const ps = DATA.projects;
  const keys = ps.filter(p => p.apiKeySet).length;
  const up = ps.filter(p => STATUS[p.id] && STATUS[p.id].ok === true).length;
  const down = ps.filter(p => STATUS[p.id] && STATUS[p.id].ok === false).length;

  $('#view').innerHTML = `
    <div class="stat-grid">
      ${stat('Projects', ps.length, 'customers on your cloud', 'var(--brand)')}
      ${stat('Sites up', up, down ? `${down} down — check now` : 'from last status check', down ? 'var(--red)' : 'var(--green)')}
      ${stat('AI key connected', `${keys}/${ps.length}`, 'customers with their key', keys === ps.length && ps.length ? 'var(--green)' : 'var(--amber)')}
      ${stat('Codes issued', `${ps.filter(p => p.accessCode).length}/${ps.length}`, 'access codes given', 'var(--cyan)')}
    </div>
    <div class="section-head"><h3>Projects</h3><span class="hint">click a card to manage · ⟳ to check up/down</span></div>
    <div id="list"></div>`;
  const list = $('#list');
  if (!ps.length) { list.appendChild(emptyState()); return; }
  const grid = el('div', 'proj-grid');
  ps.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(p => grid.appendChild(projCard(p)));
  list.appendChild(grid);
}

async function refreshStatus() {
  const btn = $('#refresh-status'); if (btn) { btn.disabled = true; btn.textContent = '⟳ Checking…'; }
  try {
    const res = await api.statusAll();
    res.forEach(r => { STATUS[r.id] = r; });
    toast('Status updated', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  if (route === 'dashboard') renderDashboard();
}

function stat(label, value, sub, dot) {
  return `<div class="stat"><div class="stat-top"><span class="stat-label">${esc(label)}</span><span class="stat-dot" style="background:${dot}"></span></div>
    <div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub)}</div></div>`;
}

function renderProjects() {
  setTop('Projects', 'All projects', `<button class="btn" id="refresh-status">⟳ Refresh status</button><button class="btn primary" id="add-top">+ New project</button>`);
  $('#add-top').onclick = () => openDrawer();
  $('#refresh-status').onclick = refreshStatus;
  const v = $('#view'); v.innerHTML = '';
  if (!DATA.projects.length) { v.appendChild(emptyState()); return; }
  const grid = el('div', 'proj-grid');
  DATA.projects.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(p => grid.appendChild(projCard(p)));
  v.appendChild(grid);
}

function emptyState() {
  const e = el('div', 'empty', `<div class="big">🗂️</div><h3>No projects yet</h3><p>Add your first customer project hosted on your Oracle cloud.</p>
    <div style="margin-top:16px"><button class="btn primary" id="empty-add">+ New project</button></div>`);
  setTimeout(() => { const b = $('#empty-add'); if (b) b.onclick = () => openDrawer(); }, 0);
  return e;
}

function projCard(p) {
  const s = STATUS[p.id];
  const dot = !s || s.ok == null ? 'unknown' : s.ok ? 'up' : 'down';
  const stTxt = !s || s.ok == null ? 'not checked' : s.ok ? `up · ${s.ms}ms` : `DOWN${s.error ? ' · ' + s.error : ' · HTTP ' + s.status}`;
  const c = el('div', 'proj-card');
  c.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px"><span class="dot ${dot}"></span><h4 style="margin:0">${esc(p.name || 'Untitled')}</h4></div>
    <div class="proj-customer" style="margin-top:4px">${esc(p.customerName || 'No customer name')}</div>
    <div class="proj-meta">
      <div class="row">🌐 <b>${esc((p.domains && p.domains[0]) || p.domain || '—')}</b></div>
      <div class="row">🖥️ <b>${esc(p.vps && p.vps.host ? p.vps.host : 'no VPS set')}</b></div>
      <div class="row">📶 <span class="status-chip">${esc(stTxt)}</span></div>
    </div>
    <div class="proj-badges">
      ${p.apiKeySet ? badge('ok', 'AI key set') : badge('warn', 'No AI key')}
      ${p.accessCode ? badge('info', 'Code issued') : badge('off', 'No code')}
      ${p.rules && p.rules.trim() ? badge('ok', 'Rules ✓') : badge('off', 'No rules')}
    </div>`;
  c.onclick = () => setRoute('project', p.id);
  return c;
}
function badge(kind, text) { return `<span class="badge ${kind}"><span class="d"></span>${esc(text)}</span>`; }

/* ================= project detail (tabbed) ================= */
const TABS = [['overview', 'Overview'], ['deploy', 'Deploy'], ['health', 'Health'], ['backups', 'Backups'], ['domains', 'Domains & SSL'], ['rules', 'Rules'], ['console', 'Console']];

function renderProjectDetail() {
  const p = proj();
  if (!p) { setRoute('projects'); return; }
  setTop('Projects', p.name || 'Project', `<button class="btn" id="edit-proj">✎ Edit</button><button class="btn danger" id="del-proj">Delete</button>`);
  $('#view').innerHTML = `
    <button class="back" id="back">← All projects</button>
    <div class="ptabs" id="ptabs">${TABS.map(([k, l]) => `<button class="ptab ${k === projTab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="ptab-content"></div>`;
  $('#back').onclick = () => setRoute('projects');
  $('#edit-proj').onclick = () => openDrawer(p);
  $('#del-proj').onclick = async () => {
    if (!confirm(`Delete project "${p.name}"? This only removes it from CloudForge, not from the server.`)) return;
    await api.deleteProject(p.id); await reload(); toast('Project deleted', 'ok'); setRoute('projects');
  };
  document.querySelectorAll('.ptab').forEach(t => t.onclick = () => { projTab = t.dataset.tab; renderProjectDetail(); });
  showTab();
}

function showTab() {
  const p = proj(); if (!p) return;
  const box = $('#ptab-content');
  if (projTab === 'overview') return tabOverview(p, box);
  if (projTab === 'deploy') return tabDeploy(p, box);
  if (projTab === 'health') return tabHealth(p, box);
  if (projTab === 'backups') return tabBackups(p, box);
  if (projTab === 'domains') return tabDomains(p, box);
  if (projTab === 'rules') return tabRules(p, box);
  if (projTab === 'console') return tabConsole(p, box);
}

/* ---- Overview ---- */
function tabOverview(p, box) {
  box.innerHTML = `
    <div class="detail-grid">
      <div>
        <div class="panel">
          <h3>Customer & project</h3>
          <div class="kv">
            <div class="k">Customer</div><div class="v">${esc(p.customerName || '—')}</div>
            <div class="k">Contact</div><div class="v">${esc(p.customerEmail || '—')}</div>
            <div class="k">Primary domain</div><div class="v mono">${esc((p.domains && p.domains[0]) || p.domain || '—')}</div>
            <div class="k">Source path</div><div class="v mono">${esc(p.sourcePath || '—')}</div>
            <div class="k">Containers</div><div class="v mono">${esc([p.containers && p.containers.backend, p.containers && p.containers.admin, p.containers && p.containers.server].filter(Boolean).join(', ') || '—')}</div>
          </div>
        </div>
        <div class="panel">
          <h3>Connection</h3>
          <div class="kv">
            <div class="k">VPS host</div><div class="v mono">${esc(p.vps && p.vps.host || '—')}${p.vps && p.vps.port ? ':' + esc(p.vps.port) : ''}</div>
            <div class="k">SSH user</div><div class="v mono">${esc(p.vps && p.vps.user || '—')}</div>
            <div class="k">Auth</div><div class="v">${p.vps && p.vps.privateKey ? 'SSH key' : (p.vps && p.vps.password ? 'Password' : '—')}</div>
          </div>
          <div class="row-gap" style="margin-top:14px"><button class="btn" id="test-conn">⚡ Test connection</button></div>
          <div id="conn-result"></div>
        </div>
      </div>
      <div>
        <div class="panel">
          <h3>Customer access</h3>
          <div class="desc">The code the customer enters in their client app to reach this project.</div>
          <div class="code-box" id="code-box">${esc(p.accessCode || '— not generated —')}</div>
          <div class="row-gap" style="margin-top:12px">
            <button class="btn" id="gen-code">${p.accessCode ? '↻ Regenerate' : '+ Generate code'}</button>
            <button class="btn ghost" id="copy-code" ${p.accessCode ? '' : 'disabled'}>Copy</button>
          </div>
          <div style="margin-top:16px">
            <label class="toggle"><input type="checkbox" id="apikey-toggle" ${p.apiKeySet ? 'checked' : ''}/><span class="track"></span><span>Customer's AI API key is connected</span></label>
          </div>
        </div>
      </div>
    </div>`;
  $('#test-conn').onclick = async () => {
    const b = $('#conn-result'); b.innerHTML = info('Connecting…');
    try { const r = await api.testConnection(p.id); b.innerHTML = r.ok ? okBox('✔ Connected', r.message) : errBox(r.message); }
    catch (e) { b.innerHTML = errBox(e.message); }
  };
  $('#gen-code').onclick = async () => { await api.generateCode(p.id); await reload(); toast('Access code generated', 'ok'); showTab(); };
  $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(p.accessCode); toast('Code copied', 'ok'); } catch { toast('Copy failed', 'err'); } };
  $('#apikey-toggle').onchange = async (e) => { await api.setApiKeyStatus(p.id, e.target.checked); await reload(); toast('Saved', 'ok'); };
}

/* ---- Deploy ---- */
function tabDeploy(p, box) {
  const hist = (DATA.history && DATA.history[p.id]) || [];
  box.innerHTML = `
    <div class="panel">
      <h3>Upload project to VPS <span class="muted" style="font-weight:400">— first time / fresh server</span></h3>
      <div class="desc">Push your local folder up to <span class="mono">${esc(p.sourcePath || '(set source path)')}</span>, then deploy. ${p.localPath ? 'Local: <span class="mono">' + esc(p.localPath) + '</span>' : '<b style="color:var(--amber)">Set a local folder in Edit project first.</b>'}<br>Tip: after uploading, use deploy method <b>“Docker Compose — rebuild only”</b> if the project has no git on the server.</div>
      <div class="row-gap"><button class="btn cyan" id="upload-proj" ${p.localPath ? '' : 'disabled'}>⬆ Upload project now</button></div>
      <div class="console" id="upload-console" style="height:160px;margin-top:12px;display:none"></div>
    </div>
    <div class="panel">
      <h3>Deploy to ${esc(p.vps && p.vps.host || 'customer VPS')}</h3>
      <div class="desc">A backup runs first if you set a backup command. Live output below.</div>
      <div class="deploy-row">
        <button class="deploy-btn full" id="deploy-full"><div class="dt">🟢 Deploy Full Website</div><div class="dd">frontend + backend + admin + server</div></button>
        <button class="deploy-btn cont" id="deploy-cont"><div class="dt">🔵 Deploy Containers</div><div class="dd">backend + admin + server only (faster)</div></button>
      </div>
      <div class="console" id="deploy-console"></div>
    </div>
    <div class="panel">
      <h3>Deploy history</h3>
      ${hist.length ? hist.map(h => `<div class="hist-item"><span class="dot ${h.ok ? 'up' : 'down'}"></span><b>${esc(h.label || h.mode)}</b><span class="spacer"></span><span class="when">${esc(fmtTime(h.at))}</span></div>`).join('') : '<div class="muted">No deploys yet.</div>'}
    </div>`;
  $('#deploy-full').onclick = () => runDeploy(p.id, 'full');
  $('#deploy-cont').onclick = () => runDeploy(p.id, 'containers');
  const ub = $('#upload-proj');
  if (ub) ub.onclick = async () => {
    if (!confirm(`Upload your local project to ${p.sourcePath || 'the VPS'}? Files there may be overwritten.`)) return;
    const con = $('#upload-console'); con.style.display = 'block'; con.textContent = '';
    ub.disabled = true;
    try { const r = await api.uploadProject(p.id); toast(r.ok ? 'Upload finished ✔' : 'Upload failed', r.ok ? 'ok' : 'err'); }
    catch (e) { con.textContent += '✖ ' + e.message + '\n'; toast(e.message, 'err'); }
    finally { ub.disabled = false; }
  };
}
async function runDeploy(id, mode) {
  const con = $('#deploy-console'); if (con) con.textContent = '';
  const bf = $('#deploy-full'), bc = $('#deploy-cont'); if (bf) bf.disabled = true; if (bc) bc.disabled = true;
  try { const r = await api.deploy(id, mode); toast(r.ok ? 'Deploy finished ✔' : 'Deploy stopped — check log', r.ok ? 'ok' : 'err'); await reload(); }
  catch (e) { if (con) con.textContent += `\n✖ ${e.message}\n`; toast(e.message, 'err'); }
  finally { if (bf) bf.disabled = false; if (bc) bc.disabled = false; if (projTab === 'deploy') { const h = (DATA.history && DATA.history[id]) || []; /* refresh history lazily */ } }
}

/* ---- Health ---- */
function tabHealth(p, box) {
  box.innerHTML = `
    <div class="panel">
      <h3>Server health</h3>
      <div class="desc">Live CPU / memory / disk and running containers on ${esc(p.vps && p.vps.host || 'the VPS')}.</div>
      <div class="row-gap"><button class="btn primary" id="check-health">📡 Check health</button></div>
      <div id="health-out" style="margin-top:14px"></div>
    </div>
    <div class="panel">
      <h3>Container logs</h3>
      <div class="console" id="logs-console" style="height:220px"></div>
    </div>`;
  $('#check-health').onclick = async () => {
    const out = $('#health-out'); out.innerHTML = info('Reading server…');
    try {
      const h = await api.serverHealth(p.id);
      out.innerHTML = `
        <div class="kv" style="margin-bottom:6px"><div class="k">Uptime</div><div class="v mono">${esc(h.uptime || '—')}</div></div>
        ${meter('CPU load', h.cpuPct, h.cpuPct == null ? '—' : `${h.cpuPct}% (load ${h.load1 ?? '?'} / ${h.cores ?? '?'} cores)`)}
        ${meter('Memory', h.memPct, h.memTotal ? `${h.memUsed} / ${h.memTotal} MB` : '—')}
        ${meter('Disk (/)', h.diskPct, h.diskTotalKb ? `${gb(h.diskUsedKb)} / ${gb(h.diskTotalKb)}` : '—')}
        <h3 style="font-size:13px;margin:16px 0 10px">Containers</h3>
        ${h.dockerMissing ? '<div class="muted">Docker not found on this server.</div>'
          : (h.containers.length ? h.containers.map(c => `
            <div class="row-item"><div class="left"><span class="dot ${c.up ? 'up' : 'down'}"></span><div><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.status)}</div></div></div>
            <button class="btn sm" data-logs="${esc(c.name)}">View logs</button></div>`).join('')
            : '<div class="muted">No running containers.</div>')}`;
      out.querySelectorAll('[data-logs]').forEach(b => b.onclick = async () => {
        const con = $('#logs-console'); con.textContent = `$ docker logs ${b.dataset.logs}\n`;
        try { const r = await api.containerLogs(p.id, b.dataset.logs, 150); con.textContent += (r.stdout || r.stderr || '(empty)'); con.scrollTop = con.scrollHeight; }
        catch (e) { con.textContent += '✖ ' + e.message; }
      });
    } catch (e) { out.innerHTML = errBox(e.message); }
  };
}

/* ---- Backups & rollback ---- */
function tabBackups(p, box) {
  box.innerHTML = `
    <div class="panel">
      <h3>Backups & rollback</h3>
      <div class="desc">Backup folder: <span class="mono">${esc(p.backupDir || '— not set (Edit project) —')}</span></div>
      <div class="row-gap"><button class="btn" id="list-backups" ${p.backupDir ? '' : 'disabled'}>📂 List backups</button></div>
      <div id="backups-out" style="margin-top:14px"></div>
      <div class="console" id="restore-console" style="height:150px;margin-top:14px;display:none"></div>
    </div>`;
  $('#list-backups').onclick = async () => {
    const out = $('#backups-out'); out.innerHTML = info('Listing…');
    try {
      const items = await api.listBackups(p.id);
      if (!items.length) { out.innerHTML = '<div class="muted">No backup files found in that folder.</div>'; return; }
      out.innerHTML = `<table class="tbl"><thead><tr><th>File</th><th>Size</th><th>Date</th><th></th></tr></thead><tbody>
        ${items.map(b => `<tr><td class="mono">${esc(b.name)}</td><td>${esc(b.size)}</td><td class="mono">${esc(b.date)}</td>
        <td><button class="btn sm" data-restore="${esc(b.name)}">Restore</button></td></tr>`).join('')}</tbody></table>`;
      out.querySelectorAll('[data-restore]').forEach(btn => btn.onclick = async () => {
        if (!confirm(`Restore "${btn.dataset.restore}"? This overwrites the current site on the VPS.`)) return;
        const con = $('#restore-console'); con.style.display = 'block'; con.textContent = '';
        try { const r = await api.restoreBackup(p.id, btn.dataset.restore); toast(r.ok ? 'Restore finished ✔' : 'Restore failed', r.ok ? 'ok' : 'err'); }
        catch (e) { con.textContent += '✖ ' + e.message; toast(e.message, 'err'); }
      });
    } catch (e) { out.innerHTML = errBox(e.message); }
  };
}

/* ---- Domains & SSL ---- */
function tabDomains(p, box) {
  const domains = p.domains && p.domains.length ? p.domains : (p.domain ? [p.domain] : []);
  box.innerHTML = `
    <div class="panel">
      <h3>Domains & SSL</h3>
      <div class="desc">All domains pointing at this project. Check the SSL certificate or issue a free one with certbot.</div>
      <div id="dom-list">
        ${domains.length ? domains.map(d => `
          <div class="row-item" data-dom="${esc(d)}">
            <div class="left"><span class="dot unknown" data-dot></span><div><div class="nm">${esc(d)}</div><div class="sub" data-ssl>SSL: not checked</div></div></div>
            <div class="row-gap">
              <button class="btn sm" data-check>Check SSL</button>
              <button class="btn sm cyan" data-issue>Issue SSL</button>
              <button class="btn sm danger" data-remove>✕</button>
            </div>
          </div>`).join('') : '<div class="muted">No domains yet.</div>'}
      </div>
      <div class="add-row"><input id="new-dom" placeholder="add a domain e.g. kingtrading.com"/><button class="btn primary" id="add-dom">+ Add</button></div>
      <div class="console" id="ssl-console" style="height:160px;margin-top:14px;display:none"></div>
    </div>`;

  $('#add-dom').onclick = async () => {
    const d = $('#new-dom').value.trim(); if (!d) return;
    const list = (p.domains && p.domains.slice()) || [];
    if (list.includes(d)) { toast('Already added', 'info'); return; }
    list.push(d); await api.saveProject({ id: p.id, domains: list }); await reload(); toast('Domain added', 'ok'); showTab();
  };
  box.querySelectorAll('[data-dom]').forEach(row => {
    const d = row.dataset.dom;
    row.querySelector('[data-check]').onclick = async () => {
      const sub = row.querySelector('[data-ssl]'), dot = row.querySelector('[data-dot]');
      sub.textContent = 'SSL: checking…';
      try {
        const r = await api.checkCert(d);
        if (r.ok) { sub.textContent = `SSL: valid ${r.daysLeft} days (${r.issuer})`; dot.className = 'dot ' + (r.daysLeft < 15 ? 'down' : 'up'); }
        else { sub.textContent = 'SSL: ' + r.error; dot.className = 'dot down'; }
      } catch (e) { sub.textContent = 'SSL: ' + e.message; }
    };
    row.querySelector('[data-issue]').onclick = async () => {
      if (!confirm(`Run certbot to issue/renew SSL for ${d}? (needs certbot + nginx on the VPS)`)) return;
      const con = $('#ssl-console'); con.style.display = 'block'; con.textContent = '';
      try { const r = await api.issueSsl(p.id, d); toast(r.ok ? 'SSL command finished ✔' : 'SSL command failed', r.ok ? 'ok' : 'err'); }
      catch (e) { con.textContent += '✖ ' + e.message; toast(e.message, 'err'); }
    };
    row.querySelector('[data-remove]').onclick = async () => {
      if (!confirm(`Remove domain ${d} from CloudForge? (does not touch DNS)`)) return;
      const list = (p.domains || []).filter(x => x !== d);
      await api.saveProject({ id: p.id, domains: list }); await reload(); toast('Domain removed', 'ok'); showTab();
    };
  });
}

/* ---- Rules ---- */
function tabRules(p, box) {
  box.innerHTML = `
    <div class="panel">
      <h3>Project rules (AI guide)</h3>
      <div class="desc">What the AI may and may not touch in THIS project. Shown to the customer's AI along with the global rules.</div>
      <textarea id="proj-rules" class="mono" style="min-height:260px" placeholder="You may edit text, pages and styles.&#10;NEVER touch payment or withdrawal logic, the database, or login without asking first.">${esc(p.rules || '')}</textarea>
      <div class="row-gap" style="margin-top:10px"><button class="btn primary" id="save-rules">Save rules</button></div>
    </div>`;
  $('#save-rules').onclick = async () => { await api.saveProject({ id: p.id, rules: $('#proj-rules').value }); await reload(); toast('Rules saved', 'ok'); };
}

/* ---- Console ---- */
function tabConsole(p, box) {
  box.innerHTML = `
    <div class="panel">
      <h3>Admin console <span class="muted" style="font-weight:400">— full control</span></h3>
      <div class="desc">Run any command on the customer VPS over SSH. Owner-only.</div>
      <div class="console" id="cmd-console" style="height:300px"></div>
      <div class="cmd-row"><input id="cmd-input" placeholder="e.g. docker ps   /   df -h   /   cd ${esc(p.sourcePath || '/path')} && git log -1"/><button class="btn primary" id="cmd-run">Run</button></div>
    </div>`;
  $('#cmd-run').onclick = () => runAdminCmd(p.id);
  $('#cmd-input').addEventListener('keydown', e => { if (e.key === 'Enter') runAdminCmd(p.id); });
}
async function runAdminCmd(id) {
  const input = $('#cmd-input'), con = $('#cmd-console'); const cmd = input.value.trim(); if (!cmd) return;
  con.textContent += `$ ${cmd}\n`; input.value = ''; $('#cmd-run').disabled = true;
  try { const r = await api.runCommand(id, cmd); con.textContent += `[exit ${r.code}]\n`; }
  catch (e) { con.textContent += `✖ ${e.message}\n`; }
  finally { $('#cmd-run').disabled = false; con.scrollTop = con.scrollHeight; }
}

/* small result boxes */
function info(t) { return `<div class="warnline" style="color:var(--muted);background:#121a2a;border-color:var(--line)">${esc(t)}</div>`; }
function okBox(t, sub) { return `<div class="warnline" style="color:var(--green);background:var(--green-bg);border-color:#1b5a3f">${esc(t)}${sub ? `<br><span style="color:var(--muted);font-family:var(--mono)">${esc(sub)}</span>` : ''}</div>`; }
function errBox(t) { return `<div class="warnline" style="color:var(--red);background:var(--red-bg);border-color:#5a2230">✖ ${esc(t)}</div>`; }
function meter(label, pct, valText) {
  const cls = pct == null ? 'good' : pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : 'good';
  const w = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  return `<div class="meter"><div class="meter-top"><span class="lbl">${esc(label)}</span><span class="val">${esc(valText)}</span></div><div class="meter-bar"><div class="meter-fill ${cls}" style="width:${w}%"></div></div></div>`;
}

/* ---------- global rules ---------- */
function renderRules() {
  setTop('Global Rules', 'Rules for every project', '');
  $('#view').innerHTML = `
    <div class="rules-wrap"><div class="panel">
      <h3>Global AI rules</h3>
      <div class="desc">Given to <b>every</b> customer's AI, on top of each project's own rules. Your safety limits that must always apply.</div>
      <textarea id="global-rules" class="mono" placeholder="- Always take a backup before deploying.&#10;- Never touch payment, withdrawal or database code without the customer approving first.&#10;- Never expose secrets, API keys or passwords.&#10;- Keep every change inside this customer's own project folder.">${esc(DATA.globalRules || '')}</textarea>
      <div class="row-gap" style="margin-top:12px"><button class="btn primary" id="save-global">Save global rules</button></div>
      <div class="warnline">These rules protect your reputation when an AI edits a live money platform.</div>
    </div></div>`;
  $('#save-global').onclick = async () => { await api.saveGlobalRules($('#global-rules').value); await reload(); toast('Global rules saved', 'ok'); };
}

/* ---------- settings ---------- */
function renderSettings() {
  setTop('Settings', 'Settings', '');
  const tg = (DATA.settings && DATA.settings.telegram) || {};
  $('#view').innerHTML = `
    <div class="rules-wrap">
      <div class="panel">
        <h3>Telegram alerts</h3>
        <div class="desc">Get a message when a site is down or a deploy fails. Create a bot with @BotFather, then get your chat id from @userinfobot.</div>
        <label class="field"><span>Bot token</span><input id="tg-token" value="${esc(tg.botToken || '')}" placeholder="123456:ABC-DEF…"/></label>
        <label class="field"><span>Chat ID</span><input id="tg-chat" value="${esc(tg.chatId || '')}" placeholder="your numeric chat id"/></label>
        <div class="row-gap"><button class="btn primary" id="save-tg">Save</button><button class="btn" id="test-tg">Send test alert</button></div>
        <div id="tg-result"></div>
      </div>
      <div class="panel">
        <h3>About CloudForge Admin</h3>
        <div class="kv">
          <div class="k">Version</div><div class="v">0.2.0</div>
          <div class="k">Projects</div><div class="v">${DATA.projects.length}</div>
          <div class="k">Data</div><div class="v">stored locally on this PC (per-user app data)</div>
        </div>
        <div class="warnline">v0.2 still stores VPS passwords/keys unencrypted locally. Encrypting them is the next hardening step.</div>
      </div>
    </div>`;
  $('#save-tg').onclick = async () => { await api.saveSettings({ telegram: { botToken: $('#tg-token').value.trim(), chatId: $('#tg-chat').value.trim() } }); await reload(); toast('Telegram settings saved', 'ok'); };
  $('#test-tg').onclick = async () => {
    const b = $('#tg-result'); b.innerHTML = info('Sending…');
    try { const r = await api.telegramTest(); b.innerHTML = r.ok ? okBox('✔ Sent — check Telegram') : errBox(r.error || 'Failed'); }
    catch (e) { b.innerHTML = errBox(e.message); }
  };
}

/* ================= drawer (add/edit) ================= */
function openDrawer(p = null) {
  editing = p ? JSON.parse(JSON.stringify(p)) : {};
  const v = editing.vps || {}, c = editing.containers || {};
  $('#drawer-title').textContent = p ? `Edit — ${p.name || 'project'}` : 'New project';
  $('#drawer-body').innerHTML = `
    <div class="form-section-title">Customer</div>
    <div class="grid-2">${field('Project name', 'name', editing.name, 'King Trading')}${field('Customer name', 'customerName', editing.customerName, 'Mr. King')}</div>
    ${field('Customer email / contact', 'customerEmail', editing.customerEmail, 'king@example.com')}

    <div class="form-section-title">Project on your cloud</div>
    ${field('Source path on the VPS (where the project will live)', 'sourcePath', editing.sourcePath, '/home/forge/king')}
    <div class="inline-field">
      <label class="field" style="flex:1"><span>Local project folder on this PC (to upload from)</span><input id="f_localPath" value="${esc(editing.localPath || '')}" placeholder="D:\\KingFriend\\web2"/></label>
      <button class="btn" id="pick-folder" style="margin-bottom:0">📁 Browse</button>
    </div>
    ${field('Primary domain', 'domain', (editing.domains && editing.domains[0]) || editing.domain, 'kingtrading.com')}
    <div class="grid-3">${field('Backend container', 'c_backend', c.backend, 'backend')}${field('Admin container', 'c_admin', c.admin, 'admin')}${field('Server container', 'c_server', c.server, 'server')}</div>

    <div class="form-section-title">Customer VPS (deploy target, SSH)</div>
    <div class="grid-2">${field('Host / IP', 'v_host', v.host, '201.18.203.164')}${field('Port', 'v_port', v.port || '22', '22')}</div>
    ${field('SSH user', 'v_user', v.user, 'root')}
    ${field('Password (blank if using a key)', 'v_password', v.password, '', 'password')}
    <label class="field"><span>SSH private key (optional — more secure)</span><textarea id="f_v_privateKey" class="mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ...">${esc(v.privateKey || '')}</textarea></label>
    <div class="inline-field">
      <label class="field" style="flex:1"><span>Key passphrase (if any)</span><input id="f_v_passphrase" value="${esc(v.passphrase || '')}" type="password"/></label>
      <button class="btn" id="pick-key" style="margin-bottom:0">📁 Load key file</button>
    </div>

    <div class="form-section-title">Deploy method</div>
    <div class="muted" style="font-size:12px;margin:-4px 0 12px">No command typing — CloudForge builds the deploy, backup and restore commands for you from the source path + container names above. Just pick your stack:</div>
    <label class="field"><span>Stack / deploy method</span>
      <select id="f_deployMethod">
        <option value="compose-git">🐳 Docker Compose — git pull + rebuild (recommended)</option>
        <option value="compose">🐳 Docker Compose — rebuild only (no git)</option>
        <option value="pm2">🟩 PM2 / Node — git pull + npm install + restart</option>
        <option value="custom">⚙️ Custom — I'll write the commands myself</option>
      </select>
    </label>

    <div class="form-section-title">Backups & SSL</div>
    ${field('Backup folder on VPS', 'backupDir', editing.backupDir, '/root/cloudforge-backups')}
    ${field('SSL email (for certbot)', 'sslEmail', editing.sslEmail, 'you@email.com')}

    <div id="custom-cmds" style="display:none">
      <div class="form-section-title">Custom commands (advanced)</div>
      <label class="field"><span>Backup command</span><textarea id="f_backupCmd" class="mono" placeholder="cd /path && tar czf /root/backups/backup-$(date +%F-%H%M).tgz .">${esc(editing.backupCmd || '')}</textarea></label>
      <label class="field"><span>🟢 Deploy Full Website</span><textarea id="f_deployFullCmd" class="mono" placeholder="cd /path && git pull && docker compose up -d --build">${esc(editing.deployFullCmd || '')}</textarea></label>
      <label class="field"><span>🔵 Deploy Containers</span><textarea id="f_deployContainersCmd" class="mono" placeholder="cd /path && git pull && docker compose up -d --build backend admin server">${esc(editing.deployContainersCmd || '')}</textarea></label>
      <label class="field"><span>Restore command (use {file} for the chosen backup)</span><textarea id="f_restoreCmd" class="mono" placeholder="cd /path && tar xzf {file} -C /path && docker compose up -d">${esc(editing.restoreCmd || '')}</textarea></label>
    </div>
  `;
  $('#pick-key').onclick = async () => { try { const k = await api.pickKeyFile(); if (k) { $('#f_v_privateKey').value = k; toast('Key loaded', 'ok'); } } catch (e) { toast(e.message, 'err'); } };

  const pf = $('#pick-folder');
  if (pf) pf.onclick = async () => { try { const d = await api.pickFolder(); if (d) $('#f_localPath').value = d; } catch (e) { toast(e.message, 'err'); } };

  const methodSel = $('#f_deployMethod');
  methodSel.value = editing.deployMethod || 'compose-git';
  const syncMethod = () => { $('#custom-cmds').style.display = methodSel.value === 'custom' ? 'block' : 'none'; };
  methodSel.onchange = syncMethod; syncMethod();

  $('#drawer-overlay').hidden = false;
}
function field(label, id, val, ph, type = 'text') {
  return `<label class="field"><span>${esc(label)}</span><input id="f_${id}" type="${type}" value="${esc(val || '')}" placeholder="${esc(ph || '')}"/></label>`;
}
function closeDrawer() { $('#drawer-overlay').hidden = true; editing = null; }

async function saveDrawer() {
  const g = (id) => { const e = $('#f_' + id); return e ? e.value.trim() : ''; };
  const name = g('name'); if (!name) { toast('Project name is required', 'err'); return; }
  const domain = g('domain');
  const existing = (editing && editing.domains) || [];
  const domains = domain ? [domain, ...existing.filter(d => d !== domain)] : existing;

  const method = $('#f_deployMethod') ? $('#f_deployMethod').value : 'compose-git';
  const src = g('sourcePath');
  const containers = { backend: g('c_backend'), admin: g('c_admin'), server: g('c_server') };
  let backupDir = g('backupDir');
  let cmds;
  if (method === 'custom') {
    cmds = { backupCmd: g('backupCmd'), deployFullCmd: g('deployFullCmd'), deployContainersCmd: g('deployContainersCmd'), restoreCmd: g('restoreCmd') };
  } else {
    if (!backupDir) backupDir = '/root/cloudforge-backups';
    cmds = buildCommands(method, src, containers, backupDir);
  }

  const project = {
    id: editing && editing.id ? editing.id : undefined,
    name, customerName: g('customerName'), customerEmail: g('customerEmail'),
    sourcePath: src, localPath: g('localPath'), domain, domains, containers,
    vps: { host: g('v_host'), port: g('v_port') || '22', user: g('v_user'), password: g('v_password'), privateKey: g('v_privateKey'), passphrase: g('v_passphrase') },
    deployMethod: method, ...cmds, backupDir, sslEmail: g('sslEmail')
  };
  const saved = await api.saveProject(project); await reload(); closeDrawer(); toast('Project saved', 'ok'); setRoute('project', saved.id);
}

/* ================= wiring ================= */
document.querySelectorAll('.nav-item').forEach(n => n.onclick = () => setRoute(n.dataset.route));
$('#drawer-close').onclick = closeDrawer;
$('#drawer-cancel').onclick = closeDrawer;
$('#drawer-save').onclick = saveDrawer;
$('#drawer-overlay').onclick = (e) => { if (e.target.id === 'drawer-overlay') closeDrawer(); };

function appendTo(sel, line) { const c = $(sel); if (c) { c.textContent += line; c.scrollTop = c.scrollHeight; } }
api.onDeployProgress(({ id, line }) => { if (route === 'project' && currentId === id) appendTo('#deploy-console', line); });
api.onConsoleProgress(({ id, line }) => { if (route === 'project' && currentId === id) appendTo('#cmd-console', line); });
api.onRestoreProgress(({ id, line }) => { if (route === 'project' && currentId === id) appendTo('#restore-console', line); });
api.onSslProgress(({ id, line }) => { if (route === 'project' && currentId === id) appendTo('#ssl-console', line); });
api.onUploadProgress(({ id, line }) => { if (route === 'project' && currentId === id) appendTo('#upload-console', line); });

(async function init() { await reload(); setRoute('dashboard'); })();
