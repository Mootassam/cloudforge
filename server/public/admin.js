'use strict';
let OV = null;          // overview data
let route = 'dashboard';
let curId = null;       // open project id
let ptab = 'deploy';

async function reload() { OV = await api('/api/admin/overview'); }

function setRoute(r) {
  route = r;
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', n.dataset.r === r));
  render();
}
document.querySelectorAll('.nav[data-r]').forEach(n => n.onclick = () => setRoute(n.dataset.r));
el('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };

function render() {
  if (route === 'dashboard') return renderDashboard();
  if (route === 'servers') return renderServers();
  if (route === 'projects') return curId ? renderProjectDetail() : renderProjects();
  if (route === 'settings') return renderSettings();
}

/* ============ DASHBOARD ============ */
function renderDashboard() {
  const src = OV.sourceServer;
  const v = el('view');
  v.innerHTML = `
    <div class="top"><div><div class="title">Dashboard</div><div class="sub">Your CloudForge at a glance</div></div></div>
    <div class="grid">
      <div class="card stat"><div class="muted">Projects (websites)</div><div class="n">${OV.projects.length}</div></div>
      <div class="card stat"><div class="muted">Client servers</div><div class="n">${OV.clientServers.length}</div></div>
      <div class="card stat"><div class="muted">AI developer key</div><div class="n">${OV.settings.aiKeySet ? '✅' : '—'}</div>
        <div class="faint" style="font-size:12px">${OV.settings.aiKeySet ? 'Set (hidden)' : 'Not set'}</div></div>
      <div class="card stat"><div class="muted">Source VPS</div><div class="n">${src ? '🟢' : '—'}</div>
        <div class="faint" style="font-size:12px">${src ? esc(src.vps.host) : 'Not added'}</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>Live site status</h3>
        <button class="btn sm" id="refresh">⟳ Check all</button>
      </div>
      <div class="sep"></div>
      <div id="statlist">${OV.projects.length ? OV.projects.map(p => statRow(p)).join('') : emptyHint('No projects yet. Add one in <b>Projects</b>.')}</div>
    </div>
    <div class="faint" style="margin-top:14px">Build queue: ${OV.queue.active} running · ${OV.queue.queued} waiting · max ${OV.queue.concurrency} at once</div>`;
  el('refresh') && (el('refresh').onclick = checkAll);
}
function statRow(p) {
  const d = (p.domains && p.domains[0]) || '';
  return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)">
    <span class="dot" id="dot-${p.id}"></span>
    <div style="flex:1"><b>${esc(p.name)}</b> <span class="faint">${esc(p.customer || '')}</span>
      <div class="faint" style="font-size:12px">${d ? esc(d) : 'no domain set'}</div></div>
    <span class="faint" id="st-${p.id}"></span>
  </div>`;
}
async function checkAll() {
  for (const p of OV.projects) {
    const dot = el('dot-' + p.id), st = el('st-' + p.id);
    if (!(p.domains && p.domains[0])) { if (st) st.textContent = 'skip'; continue; }
    if (st) st.textContent = '…';
    try {
      const r = await api(`/api/admin/projects/${p.id}/http`);
      if (dot) dot.className = 'dot ' + (r.ok ? 'up' : 'down');
      if (st) st.textContent = r.ok ? (r.ms + 'ms') : (r.error || ('HTTP ' + r.status));
    } catch (e) { if (st) st.textContent = 'err'; }
  }
}

/* ============ SERVERS ============ */
function renderServers() {
  const src = OV.sourceServer;
  el('view').innerHTML = `
    <div class="top"><div><div class="title">Servers</div><div class="sub">Add your source VPS once, then your client VPSs</div></div></div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h3>① Source VPS <span class="pill">holds all source code</span></h3>
          <div class="sub">${src ? esc(src.name) + ' · ' + esc(src.vps.user) + '@' + esc(src.vps.host) + ':' + src.vps.port : 'Not added yet'}</div></div>
        <div class="wrap">
          ${src ? '<button class="btn sm" id="src-test">Test</button>' : ''}
          <button class="btn sm primary" id="src-edit">${src ? 'Edit' : '+ Add source VPS'}</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h3>② Client VPSs <span class="pill">each hosts many websites</span></h3>
          <div class="sub">The servers where your customers' sites actually run</div></div>
        <button class="btn sm primary" id="cs-add">+ Add client VPS</button>
      </div>
      <div class="sep"></div>
      <div>${OV.clientServers.length ? OV.clientServers.map(csRow).join('') : emptyHint('No client servers yet.')}</div>
    </div>`;
  el('src-edit').onclick = () => serverDrawer('source', src);
  el('src-test') && (el('src-test').onclick = () => testServer('source'));
  el('cs-add').onclick = () => serverDrawer('client', null);
  OV.clientServers.forEach(s => {
    el('csb-' + s.id).onclick = () => openServerExplorer(s);
    el('cst-' + s.id).onclick = () => testServer('client', s.id);
    el('cse-' + s.id).onclick = () => serverDrawer('client', s);
    el('csd-' + s.id).onclick = () => delServer(s.id);
  });
}
function csRow(s) {
  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="flex:1"><b>${esc(s.name)}</b><div class="faint" style="font-size:12px">${esc(s.vps.user)}@${esc(s.vps.host)}:${s.vps.port}</div></div>
    <button class="btn sm primary" id="csb-${s.id}">🔎 Browse</button>
    <button class="btn sm" id="cst-${s.id}">Test</button>
    <button class="btn sm" id="cse-${s.id}">Edit</button>
    <button class="btn sm danger" id="csd-${s.id}">✕</button>
  </div>`;
}
async function testServer(kind, id) {
  toast('Testing connection…');
  try {
    const r = kind === 'source'
      ? await api('/api/admin/source-server/test', { method: 'POST' })
      : await api(`/api/admin/client-servers/${id}/test`, { method: 'POST' });
    toast(r.ok ? '✅ ' + (r.message || 'Connected') : '✖ ' + (r.message || 'Failed'), r.ok ? 'good' : 'bad');
  } catch (e) { toast(e.message, 'bad'); }
}
async function delServer(id) {
  if (!confirm('Delete this client VPS?')) return;
  try { await api('/api/admin/client-servers/' + id, { method: 'DELETE' }); await reload(); render(); toast('Deleted', 'good'); }
  catch (e) { toast(e.message, 'bad'); }
}

function vpsFields(v) {
  v = v || {};
  return `
    <label class="f">IP / hostname *</label><input id="v-host" value="${esc(v.host || '')}" placeholder="203.0.113.10">
    <div class="row">
      <div><label class="f">SSH port</label><input id="v-port" value="${v.port || 22}"></div>
      <div><label class="f">SSH user *</label><input id="v-user" value="${esc(v.user || '')}" placeholder="root or ubuntu"></div>
    </div>
    <label class="f">Password ${v.hasPassword ? '<span class="faint">(leave blank = keep)</span>' : ''}</label>
    <input id="v-pass" type="password" placeholder="${v.hasPassword ? '•••••• saved' : 'SSH password'}">
    <label class="f">…or private key ${v.hasKey ? '<span class="faint">(saved)</span>' : ''}</label>
    <textarea id="v-key" placeholder="paste private key (optional, instead of password)"></textarea>
    <label class="f">Key passphrase (if the key has one)</label><input id="v-pp" type="password" placeholder="optional">`;
}
function readVps() {
  return {
    host: el('v-host').value.trim(), port: el('v-port').value.trim(),
    user: el('v-user').value.trim(), password: el('v-pass').value,
    privateKey: el('v-key').value.trim(), passphrase: el('v-pp').value
  };
}
function serverDrawer(kind, existing) {
  const title = kind === 'source' ? 'Source VPS (your code lives here)' : (existing ? 'Edit client VPS' : 'Add client VPS');
  openDrawer(`
    <div class="title">${title}</div>
    <div class="sub">Works with Oracle or any VPS — normal SSH login.</div>
    <label class="f">Name</label><input id="v-name" value="${esc(existing ? existing.name : '')}" placeholder="${kind === 'source' ? 'My Oracle source' : 'Client A server'}">
    ${vpsFields(existing && existing.vps)}
    <div class="wrap" style="margin-top:18px">
      <button class="btn primary" id="sv-save">Save</button>
      <button class="btn ghost" id="sv-cancel">Cancel</button>
    </div>`);
  el('sv-cancel').onclick = closeDrawer;
  el('sv-save').onclick = async () => {
    const body = { name: el('v-name').value.trim(), vps: readVps() };
    if (!body.vps.host || !body.vps.user) return toast('Host and SSH user are required.', 'bad');
    try {
      if (kind === 'source') await api('/api/admin/source-server', { method: 'PUT', body });
      else if (existing) await api('/api/admin/client-servers/' + existing.id, { method: 'PUT', body });
      else await api('/api/admin/client-servers', { method: 'POST', body });
      closeDrawer(); await reload(); render(); toast('Saved', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  };
}

/* ============ PROJECTS ============ */
function renderProjects() {
  el('view').innerHTML = `
    <div class="top"><div><div class="title">Projects</div><div class="sub">One project = one customer's website</div></div>
      <button class="btn primary" id="p-add">+ New project</button></div>
    <div class="grid">${OV.projects.length ? OV.projects.map(projCard).join('') : emptyHint('No projects yet. Click <b>New project</b>.')}</div>`;
  el('p-add').onclick = () => projectDrawer(null);
  OV.projects.forEach(p => el('pc-' + p.id).onclick = () => { curId = p.id; ptab = 'deploy'; render(); });
}
function projCard(p) {
  return `<div class="card" id="pc-${p.id}" style="cursor:pointer">
    <div style="display:flex;justify-content:space-between;align-items:start">
      <div><b>${esc(p.name)}</b><div class="faint" style="font-size:12px">${esc(p.customer || '—')}</div></div>
      ${p.disabled ? '<span class="badge off">disabled</span>' : '<span class="badge ok">active</span>'}
    </div>
    <div class="sep" style="margin:12px 0"></div>
    <div class="faint" style="font-size:12px">${p.clientServerName ? '🖥️ ' + esc(p.clientServerName) : '⚠️ no server linked'}</div>
    <div class="faint" style="font-size:12px">${(p.domains[0]) ? '🌐 ' + esc(p.domains[0]) : 'no domain'}</div>
  </div>`;
}

/* ===== reusable server explorer (browse & select, no typing) ===== */
function joinPath(base, name) { return base === '/' ? '/' + name : base + '/' + name; }
function crumbHtml(path) {
  const segs = path.split('/').filter(Boolean);
  let acc = '', out = `<span class="seg" data-nav="/">🏠 /</span>`;
  segs.forEach(s => { acc += '/' + s; out += `<span class="sepc">›</span><span class="seg" data-nav="${esc(acc)}">${esc(s)}</span>`; });
  return out;
}
function flagBadges(flags) {
  const b = [];
  if (flags.compose) b.push('<span class="badge ok">🐳 docker-compose</span>');
  if (flags.docker) b.push('<span class="badge">📦 Dockerfile</span>');
  if (flags.git) b.push('<span class="badge">🔁 git</span>');
  if (flags.node) b.push('<span class="badge">🟢 package.json</span>');
  return b.length ? `<div class="flagrow">${b.join('')}</div>` : '';
}
// mount a live folder browser into host; onSelect(path, flags) fires on "Use this folder"
async function mountExplorer(host, target, startPath, onSelect) {
  async function go(p) {
    host.innerHTML = '<div class="faint" style="padding:16px">Connecting & reading folder…</div>';
    let r;
    try { r = await api('/api/admin/explore/dirs', { method: 'POST', body: { target, path: p } }); }
    catch (e) { host.innerHTML = `<div class="muted" style="padding:16px">✖ ${esc(e.message)}</div>`; return; }
    if (!r.ok) { host.innerHTML = `<div class="muted" style="padding:16px">✖ ${esc(r.error || 'Cannot open')}</div>`; return; }
    const rows = [];
    if (r.parent) rows.push(`<div class="frow" data-nav="${esc(r.parent)}"><span class="ic">↩️</span><span>.. (up a level)</span></div>`);
    r.dirs.forEach(d => rows.push(`<div class="frow" data-nav="${esc(joinPath(r.path, d))}"><span class="ic">📁</span><span>${esc(d)}</span></div>`));
    r.files.forEach(f => rows.push(`<div class="frow file"><span class="ic">📄</span><span>${esc(f)}</span></div>`));
    host.innerHTML = `
      <div class="explorer">
        <div class="crumb">${crumbHtml(r.path)}</div>
        <div class="flist">${rows.join('') || '<div class="faint" style="padding:14px">empty folder</div>'}</div>
        ${flagBadges(r.flags)}
        ${onSelect ? `<div class="selectbar"><span class="cur">📍 ${esc(r.path)}</span><button class="btn primary sm" data-select>✓ Use this folder</button></div>` : ''}
      </div>`;
    host.querySelectorAll('[data-nav]').forEach(x => x.onclick = () => go(x.dataset.nav));
    const sel = host.querySelector('[data-select]');
    if (sel) sel.onclick = () => onSelect(r.path, r.flags);
  }
  go(startPath || '');
}

// standalone "look at everything" modal from the Servers tab
function openServerExplorer(server) {
  openDrawer(`<div class="title">🔎 ${esc(server.name)}</div>
    <div class="sub">${esc(server.vps.user)}@${esc(server.vps.host)} — browse, no typing.</div>
    <div class="ptabs" style="margin:14px 0"><div class="ptab on" data-x="folders">📁 Folders</div><div class="ptab" data-x="containers">🐳 Containers</div></div>
    <div id="x-body"></div>
    <div class="wizfoot"><span></span><button class="btn ghost" id="x-close">Close</button></div>`);
  el('x-close').onclick = closeDrawer;
  const show = (which) => {
    document.querySelectorAll('[data-x]').forEach(t => t.classList.toggle('on', t.dataset.x === which));
    if (which === 'folders') mountExplorer(el('x-body'), server.id, '', null);
    else loadContainers(el('x-body'), server.id, null);
  };
  document.querySelectorAll('[data-x]').forEach(t => t.onclick = () => show(t.dataset.x));
  show('folders');
}

// render container list; if onToggle given, rows are selectable checkboxes
async function loadContainers(host, target, selectedSet) {
  host.innerHTML = '<div class="faint" style="padding:14px">Reading Docker…</div>';
  let r;
  try { r = await api('/api/admin/explore/containers', { method: 'POST', body: { target } }); }
  catch (e) { host.innerHTML = `<div class="muted" style="padding:14px">✖ ${esc(e.message)}</div>`; return; }
  if (r.dockerMissing) { host.innerHTML = '<div class="faint" style="padding:14px">No Docker on this server.</div>'; return; }
  if (!r.items.length) { host.innerHTML = '<div class="faint" style="padding:14px">No containers found.</div>'; return; }
  host.innerHTML = r.items.map(c => {
    const on = selectedSet && selectedSet.has(c.name);
    const check = selectedSet ? `<div class="chkbox">${on ? '✓' : ''}</div>` : `<span class="dot ${c.up ? 'up' : 'down'}"></span>`;
    return `<div class="chkrow ${on ? 'on' : ''}" data-n="${esc(c.name)}" ${selectedSet ? '' : 'style="cursor:default"'}>
      ${check}<div style="flex:1"><b>${esc(c.name)}</b><div class="faint" style="font-size:12px">${esc(c.image)} · ${esc(c.status)}</div></div></div>`;
  }).join('');
  if (selectedSet) host.querySelectorAll('.chkrow').forEach(row => row.onclick = () => {
    const n = row.dataset.n;
    if (selectedSet.has(n)) selectedSet.delete(n); else selectedSet.add(n);
    row.classList.toggle('on'); row.querySelector('.chkbox').textContent = selectedSet.has(n) ? '✓' : '';
  });
}

/* ===== project wizard (browse & select) ===== */
let wiz = null;
function projectDrawer(p) {
  wiz = {
    edit: p || null, step: 1, maxStep: p ? 4 : 1,
    serverId: p ? p.clientServerId : '', remotePath: p ? p.remotePath : '',
    sourcePath: p ? p.sourcePath : '', flags: {},
    method: p ? p.deployMethod : 'compose-git',
    containers: new Set(p ? (p.containers || []) : []),
    name: p ? p.name : '', customer: p ? p.customer : '',
    domains: p ? (p.domains || []).join(' ') : '', backupDir: p ? p.backupDir : '',
    sslEmail: p ? p.sslEmail : '', usageLimit: p ? p.usageLimit : 0, rules: p ? p.rules : '',
    buildScript: p ? (p.buildScript || 'build') : 'build'
  };
  if (p) wiz.step = 1;
  renderWizard();
}
function goStep(n) { if (n < 1 || n > 4) return; wiz.step = n; wiz.maxStep = Math.max(wiz.maxStep, n); renderWizard(); }

function renderWizard() {
  const steps = [[1, 'Server'], [2, 'Folder'], [3, 'Containers'], [4, 'Finish']];
  const head = `<div class="title">${wiz.edit ? 'Edit project' : 'New project'}</div>
    <div class="sub">Click to select — no typing needed for paths or containers.</div>
    <div class="stepper">${steps.map(([n, l]) => `<div class="step ${wiz.step === n ? 'on' : (wiz.maxStep >= n ? 'done' : '')}" data-step="${n}">
      <span class="num">${wiz.maxStep > n && wiz.step !== n ? '✓' : n}</span>${l}</div>`).join('')}</div>`;
  openDrawer(head + `<div id="wz"></div>`);
  document.querySelectorAll('[data-step]').forEach(s => s.onclick = () => { const n = +s.dataset.step; if (n <= wiz.maxStep) goStep(n); });
  const wz = el('wz');
  if (wiz.step === 1) stepServer(wz);
  else if (wiz.step === 2) stepFolder(wz);
  else if (wiz.step === 3) stepContainers(wz);
  else stepFinish(wz);
}

function foot(leftBtn, rightBtn) { return `<div class="wizfoot">${leftBtn || '<span></span>'}${rightBtn || ''}</div>`; }

function stepServer(wz) {
  if (!OV.clientServers.length) {
    wz.innerHTML = `<div class="card" style="text-align:center;padding:26px">
      <div style="font-size:30px">🖥️</div><h3 style="margin:8px 0">No client servers yet</h3>
      <div class="sub">Add the VPS where this customer's site runs. Works with Oracle or any VPS.</div>
      <div style="margin-top:14px"><button class="btn primary" id="w-addsrv">+ Add client VPS</button></div></div>` + foot('<button class="btn ghost" id="w-cancel">Cancel</button>');
    el('w-cancel').onclick = closeDrawer;
    el('w-addsrv').onclick = () => serverDrawer('client', null);
    return;
  }
  wz.innerHTML = `<div class="sub" style="margin-bottom:10px">Which server does this website run on?</div>
    <div class="pickwrap">${OV.clientServers.map(s => `<div class="pickcard ${wiz.serverId === s.id ? 'on' : ''}" data-sid="${s.id}">
      <div class="nm">🖥️ ${esc(s.name)}</div><div class="meta">${esc(s.vps.user)}@${esc(s.vps.host)}</div></div>`).join('')}</div>
    <div style="margin-top:10px"><button class="btn sm ghost" id="w-addsrv">+ Add another</button></div>`
    + foot('<button class="btn ghost" id="w-cancel">Cancel</button>',
           `<button class="btn primary" id="w-next" ${wiz.serverId ? '' : 'disabled'}>Next: pick folder →</button>`);
  el('w-cancel').onclick = closeDrawer;
  el('w-addsrv').onclick = () => serverDrawer('client', null);
  wz.querySelectorAll('[data-sid]').forEach(c => c.onclick = () => { wiz.serverId = c.dataset.sid; renderWizard(); });
  el('w-next') && (el('w-next').onclick = () => goStep(2));
}

function stepFolder(wz) {
  wz.innerHTML = `<div class="sub" style="margin-bottom:10px">Open the folder where this site lives on the server, then click <b>Use this folder</b>.</div>
    <div id="w-exp"></div>
    ${wiz.remotePath ? `<div class="hint" style="margin-top:10px">✓ Selected: <span class="mono">${esc(wiz.remotePath)}</span></div>` : ''}`
    + foot('<button class="btn ghost" id="w-back">← Back</button>',
           `<button class="btn primary" id="w-next" ${wiz.remotePath ? '' : 'disabled'}>Next: containers →</button>`);
  el('w-back').onclick = () => goStep(1);
  el('w-next') && (el('w-next').onclick = () => goStep(3));
  mountExplorer(el('w-exp'), wiz.serverId, wiz.remotePath || '', (path, flags) => {
    wiz.remotePath = path; wiz.flags = flags;
    // auto-pick the deploy stack from what we detected
    wiz.method = flags.compose ? 'compose-git' : flags.node ? 'pm2' : 'compose-git';
    if (!wiz.backupDir) wiz.backupDir = joinPath(path.replace(/\/[^/]+$/, '') || path, 'cf-backups');
    toast('Folder selected ✓', 'good');
    renderWizard();
  });
}

function stepContainers(wz) {
  const detected = wiz.flags.compose ? 'Docker Compose detected 🐳' : wiz.flags.node ? 'Node project detected 🟢' : 'No compose file detected';
  wz.innerHTML = `<div class="sub" style="margin-bottom:6px">Tick the containers that make up the <b>backend / admin / server</b> (used by "Deploy containers only"). Leave all unticked to rebuild everything.</div>
    <div class="hint" style="margin-bottom:12px">${detected} — deploy stack: <b>${wiz.method}</b></div>
    <div id="w-cons"></div>`
    + foot('<button class="btn ghost" id="w-back">← Back</button>', `<button class="btn primary" id="w-next">Next: finish →</button>`);
  el('w-back').onclick = () => goStep(2);
  el('w-next').onclick = () => goStep(4);
  loadContainers(el('w-cons'), wiz.serverId, wiz.containers);
}

function stepFinish(wz) {
  wz.innerHTML = `
    <label class="f">Project / website name *</label><input id="w-name" value="${esc(wiz.name)}" placeholder="Client A — trading site">
    <label class="f">Customer name</label><input id="w-cust" value="${esc(wiz.customer)}" placeholder="Client A">
    <label class="f">Domain(s) <span class="faint">(space separated, optional)</span></label><input id="w-domains" value="${esc(wiz.domains)}" placeholder="clienta.com">

    <div class="card" style="margin-top:14px;background:#0c1320">
      <div class="muted" style="font-weight:700;margin-bottom:8px">Review (all selected by clicking)</div>
      <div class="faint" style="font-size:12.5px;line-height:1.9">
        🖥️ Server: <b>${esc((OV.clientServers.find(s => s.id === wiz.serverId) || {}).name || '—')}</b><br>
        📁 Folder: <span class="mono">${esc(wiz.remotePath || '—')}</span><br>
        🚀 Stack: <b>${esc(wiz.method)}</b><br>
        📦 Containers: <b>${wiz.containers.size ? esc([...wiz.containers].join(', ')) : 'all'}</b><br>
        💾 Backups: <span class="mono">${esc(wiz.backupDir || '—')}</span>
      </div>
    </div>

    <details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Advanced (optional)</summary>
      <label class="f">Build script <span class="faint">(npm script to run, e.g. build or build:production)</span></label>
      <input id="w-buildscript" value="${esc(wiz.buildScript || 'build')}" placeholder="build">
      <div class="hint">Only the folders the AI edits are rebuilt, each running <b>npm run &lt;this&gt;</b>. Leave as "build" for most apps.</div>
      <label class="f">SSL email (for free certbot SSL)</label><input id="w-ssl" value="${esc(wiz.sslEmail)}" placeholder="you@email.com">
      <label class="f">Backup folder <button class="btn sm ghost" id="w-pickbk" type="button">📁 Browse</button></label>
      <input id="w-backup" value="${esc(wiz.backupDir)}" placeholder="/opt/backups">
      <label class="f">Daily deploy limit (0 = unlimited)</label><input id="w-limit" value="${wiz.usageLimit}">
      <label class="f">Rules for the AI developer</label><textarea id="w-rules" placeholder="e.g. Never touch payment/trading-engine files.">${esc(wiz.rules)}</textarea>
    </details>`
    + foot('<button class="btn ghost" id="w-back">← Back</button>',
           `<button class="btn primary" id="w-save">${wiz.edit ? '✓ Save changes' : '✓ Create project'}</button>`);
  el('w-back').onclick = () => { saveFinishInputs(); goStep(3); };
  el('w-pickbk').onclick = () => {
    saveFinishInputs();
    openDrawer(`<div class="title">📁 Pick backup folder</div><div id="bk-exp"></div>
      <div class="wizfoot"><button class="btn ghost" id="bk-cancel">Cancel</button></div>`);
    el('bk-cancel').onclick = renderWizard;
    mountExplorer(el('bk-exp'), wiz.serverId, wiz.backupDir || wiz.remotePath || '', (path) => { wiz.backupDir = path; toast('Backup folder set ✓', 'good'); renderWizard(); });
  };
  el('w-save').onclick = saveProject;
}
function saveFinishInputs() {
  if (el('w-name')) wiz.name = el('w-name').value.trim();
  if (el('w-cust')) wiz.customer = el('w-cust').value.trim();
  if (el('w-domains')) wiz.domains = el('w-domains').value.trim();
  if (el('w-ssl')) wiz.sslEmail = el('w-ssl').value.trim();
  if (el('w-backup')) wiz.backupDir = el('w-backup').value.trim();
  if (el('w-limit')) wiz.usageLimit = el('w-limit').value;
  if (el('w-rules')) wiz.rules = el('w-rules').value;
  if (el('w-buildscript')) wiz.buildScript = el('w-buildscript').value.trim() || 'build';
}
async function saveProject() {
  saveFinishInputs();
  if (!wiz.name) return toast('Please type a project name.', 'bad');
  const body = {
    name: wiz.name, customer: wiz.customer, sourcePath: wiz.sourcePath,
    clientServerId: wiz.serverId, remotePath: wiz.remotePath,
    deployMethod: wiz.method, containers: [...wiz.containers], domains: wiz.domains,
    sslEmail: wiz.sslEmail, backupDir: wiz.backupDir, usageLimit: wiz.usageLimit, rules: wiz.rules,
    buildScript: wiz.buildScript
  };
  try {
    if (wiz.edit) { await api('/api/admin/projects/' + wiz.edit.id, { method: 'PUT', body }); toast('Saved', 'good'); closeDrawer(); await reload(); render(); }
    else {
      const r = await api('/api/admin/projects', { method: 'POST', body });
      closeDrawer(); await reload();
      showKey(r.accessKey, 'Project created! Give this key to your customer:');
    }
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---- project detail ---- */
async function renderProjectDetail() {
  let detail;
  try { detail = await api('/api/admin/projects/' + curId); }
  catch (e) { curId = null; toast(e.message, 'bad'); return renderProjects(); }
  const p = detail.project;
  const tabs = ['deploy', 'pages', 'health', 'backups', 'domains', 'access', 'rules'];
  const labels = { deploy: '🚀 Deploy', pages: '🎯 Pages', health: '💓 Health', backups: '💾 Backups', domains: '🌐 Domains & SSL', access: '🔑 Access key', rules: '📋 Rules' };
  el('view').innerHTML = `
    <div class="top">
      <div><div class="title">${esc(p.name)} <span class="faint" style="font-size:14px">${esc(p.customer || '')}</span></div>
        <div class="sub">${p.clientServerName ? '🖥️ ' + esc(p.clientServerName) : '⚠️ no server linked'} ${p.domains[0] ? '· 🌐 ' + esc(p.domains[0]) : ''}</div></div>
      <div class="wrap">
        <button class="btn sm" id="p-back">← All projects</button>
        <button class="btn sm" id="p-edit">Edit</button>
        <button class="btn sm danger" id="p-del">Delete</button>
      </div>
    </div>
    <div class="ptabs">${tabs.map(t => `<div class="ptab ${t === ptab ? 'on' : ''}" data-pt="${t}">${labels[t]}</div>`).join('')}</div>
    <div id="pbody"></div>`;
  el('p-back').onclick = () => { curId = null; render(); };
  el('p-edit').onclick = () => projectDrawer(p);
  el('p-del').onclick = async () => { if (!confirm('Delete this project?')) return; await api('/api/admin/projects/' + p.id, { method: 'DELETE' }); curId = null; await reload(); render(); toast('Deleted', 'good'); };
  document.querySelectorAll('.ptab').forEach(t => t.onclick = () => { ptab = t.dataset.pt; renderPTab(p, detail.history); });
  renderPTab(p, detail.history);
}

function renderPTab(p, history) {
  const b = el('pbody');
  if (ptab === 'deploy') {
    b.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h3>📦 Code source — GitHub</h3>
        <div class="sub">Link this project to a GitHub repo. The AI developer will edit that repo and <b>push</b> the changes (GitHub = the code store). Leave empty to use the old mode (edit the VPS directly).</div>
        <label class="f">Repository (owner/name)</label>
        <input id="gh-repo" value="${esc((p.github && p.github.repo) || '')}" placeholder="e.g. Mootassam/customer-site">
        <label class="f">Branch</label>
        <input id="gh-branch" value="${esc((p.github && p.github.branch) || 'main')}" placeholder="main">
        <div class="wrap" style="margin-top:12px"><button class="btn primary" id="gh-save">Save code source</button><button class="btn" id="gh-test">Test access</button><button class="btn good" id="gh-push">📤 Test push (no AI)</button></div>
        <div class="hint" style="margin-top:8px">“Test push” makes one tiny real commit (a <span class="mono">cloudforge-test.md</span> file) so you can confirm pushing works — it uses <b>no AI credit</b>.</div>
        <div class="sep" style="margin:14px 0"></div>
        <label class="f">Auto-deploy (GitHub Actions)</label>
        <div class="sub" style="font-size:12.5px">Adds a workflow that builds the app on GitHub and ships it to the VPS on every push. After it's added, set the repo secrets (the button explains which).</div>
        <div class="wrap" style="margin-top:10px"><button class="btn" id="gh-wf">⚙️ Set up auto-deploy</button></div>
        <div id="gh-res" class="sub" style="margin-top:8px"></div>
      </div>
      <div class="card">
        <h3>Deploy</h3><div class="sub">Runs a safety backup first (if a backup folder is set), then deploys.</div>
        <div class="wrap" style="margin-top:14px">
          <button class="btn good" id="d-full">🚀 Deploy full website</button>
          <button class="btn primary" id="d-cont">📦 Deploy containers only</button>
          <button class="btn sm" id="d-test">Test connection</button>
        </div>
        <div class="logbox" id="d-log" style="margin-top:14px;display:none"></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Recent deploys</h3><div class="sep"></div>
        ${history.length ? historyRows(history) : emptyHint('No deploys yet.')}</div>`;
    el('gh-save').onclick = async () => { await api('/api/admin/projects/' + p.id, { method: 'PUT', body: { github: { repo: el('gh-repo').value.trim(), branch: el('gh-branch').value.trim() || 'main' } } }); await reload(); toast('Code source saved', 'good'); };
    el('gh-test').onclick = async () => {
      const box = el('gh-res'); box.innerHTML = 'Checking…';
      try {
        const r = await api('/api/admin/github-test-repo', { method: 'POST', body: { repo: el('gh-repo').value.trim() } });
        box.innerHTML = r.ok
          ? `<span class="badge ok">OK</span> ${esc(r.fullName)} · ${r.private ? '🔒 private' : '🌍 public'} · default branch <b>${esc(r.defaultBranch)}</b> · ${r.canPush ? 'can push ✅' : '⚠️ read-only (token can’t push)'}`
          : `<span class="muted">✖ ${esc(r.error)}</span>`;
      } catch (e) { box.innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
    };
    el('gh-push').onclick = async () => {
      const box = el('gh-res'); box.innerHTML = 'Pushing a tiny test commit… (first time clones the repo, can take a few seconds)';
      try {
        const r = await api('/api/admin/projects/' + p.id + '/github-test-push', { method: 'POST' });
        box.innerHTML = r.ok
          ? `<span class="badge ok">✓ Pushed</span> Added <span class="mono">cloudforge-test.md</span> to branch <b>${esc(r.branch)}</b>. Check your repo on github.com — you’ll see the commit.`
          : `<span class="muted">✖ ${esc(r.error)}</span>`;
      } catch (e) { box.innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
    };
    el('gh-wf').onclick = async () => {
      const box = el('gh-res'); box.innerHTML = 'Adding the auto-deploy workflow to your repo…';
      try {
        const r = await api('/api/admin/projects/' + p.id + '/github-setup-deploy', { method: 'POST' });
        box.innerHTML = r.ok
          ? `<span class="badge ok">✓ Added</span> <span class="mono">.github/workflows/cloudforge-deploy.yml</span> is in your repo. Next: add the repo <b>Secrets</b> (VPS_HOST, VPS_USER, VPS_SSH_KEY, VPS_PORT, VPS_PATH, GHCR_TOKEN) in GitHub → Settings → Secrets → Actions. The file's top comments list them.`
          : `<span class="muted">✖ ${esc(r.error)}</span>`;
      } catch (e) { box.innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
    };
    el('d-full').onclick = () => runDeploy(p, 'full');
    el('d-cont').onclick = () => runDeploy(p, 'containers');
    el('d-test').onclick = async () => { toast('Testing…'); try { const r = await api('/api/admin/projects/' + p.id + '/test', { method: 'POST' }); toast(r.ok ? '✅ ' + (r.message || 'Connected') : '✖ ' + r.message, r.ok ? 'good' : 'bad'); } catch (e) { toast(e.message, 'bad'); } };
  }
  else if (ptab === 'pages') { renderPagesTab(p); }
  else if (ptab === 'health') {
    b.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between"><h3>Server health</h3><button class="btn sm" id="h-go">⟳ Check</button></div><div id="h-body" class="sub" style="margin-top:10px">Click Check.</div></div>`;
    el('h-go').onclick = () => loadHealth(p);
  }
  else if (ptab === 'backups') {
    b.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between"><h3>Backups & rollback</h3><button class="btn sm" id="bk-go">⟳ List</button></div>
      <div class="sub" style="margin-top:6px">${p.backupDir ? 'Folder: <span class="mono">' + esc(p.backupDir) + '</span>' : '⚠️ Set a backup folder in Edit first.'}</div>
      <div id="bk-body" style="margin-top:12px"></div><div class="logbox" id="bk-log" style="margin-top:12px;display:none"></div></div>`;
    el('bk-go').onclick = () => loadBackups(p);
  }
  else if (ptab === 'domains') {
    b.innerHTML = `<div class="card"><h3>Domains & SSL</h3><div class="sep"></div>
      ${(p.domains.length ? p.domains : []).map(d => domainRow(p, d)).join('') || emptyHint('No domains. Add them in Edit.')}
      <div class="logbox" id="ssl-log" style="margin-top:12px;display:none"></div></div>`;
    p.domains.forEach(d => {
      el('dck-' + cssId(d)).onclick = () => checkCert(d);
      el('ssl-' + cssId(d)).onclick = () => issueSsl(p, d);
    });
  }
  else if (ptab === 'access') {
    b.innerHTML = `<div class="card"><h3>Customer access key</h3>
      <div class="sub">The key opens ONLY this project in the customer app. For safety the full key is shown once at creation; regenerate to get a new one.</div>
      <div style="margin:14px 0" class="keybox">CF-••••-••••-${esc(p.accessKeyHint || '????')}</div>
      <div class="wrap">
        <button class="btn primary" id="ak-regen">↻ Regenerate key</button>
        <button class="btn ${p.disabled ? 'good' : 'danger'}" id="ak-toggle">${p.disabled ? 'Enable access' : 'Disable access'}</button>
      </div>
      <div class="hint">Customer logs in at <b>${location.origin}/app</b></div></div>`;
    el('ak-regen').onclick = async () => { if (!confirm('Regenerate? The old key stops working.')) return; const r = await api('/api/admin/projects/' + p.id + '/regenerate-key', { method: 'POST' }); showKey(r.accessKey, 'New key — give it to your customer:'); await reload(); render(); };
    el('ak-toggle').onclick = async () => { await api('/api/admin/projects/' + p.id + '/disable', { method: 'POST', body: { disabled: !p.disabled } }); await reload(); render(); toast('Updated', 'good'); };
  }
  else if (ptab === 'rules') {
    b.innerHTML = `<div class="card"><h3>Project rules</h3><div class="sub">Shown to the AI developer for this project (on top of your global rules).</div>
      <textarea id="r-txt" style="min-height:160px;margin-top:10px">${esc(p.rules || '')}</textarea>
      <div style="margin-top:12px"><button class="btn primary" id="r-save">Save rules</button></div></div>`;
    el('r-save').onclick = async () => { await api('/api/admin/projects/' + p.id, { method: 'PUT', body: { rules: el('r-txt').value } }); toast('Saved', 'good'); };
  }
}
/* ---- Pages the customer can edit (owner-defined, clear names) ---- */
let PAGES = [];
function renderPagesTab(p) {
  PAGES = (p.editTargets || []).map(t => ({ label: t.label || '', kind: t.kind || 'website', url: t.url || '' }));
  drawPages(p);
}
function pagesSync() {
  PAGES = PAGES.map((_, i) => ({
    label: el('pg-l-' + i) ? el('pg-l-' + i).value : '',
    kind: el('pg-k-' + i) ? el('pg-k-' + i).value : 'website',
    url: el('pg-u-' + i) ? el('pg-u-' + i).value : ''
  }));
}
function drawPages(p) {
  const rows = PAGES.map((t, i) => `
    <div class="pg-row">
      <input id="pg-l-${i}" class="pg-l" value="${esc(t.label)}" placeholder="Name e.g. Your Website">
      <select id="pg-k-${i}" class="pg-k">
        <option value="website" ${t.kind === 'website' ? 'selected' : ''}>🌐 Website</option>
        <option value="admin" ${t.kind === 'admin' ? 'selected' : ''}>🛠️ Admin panel</option>
        <option value="other" ${t.kind === 'other' ? 'selected' : ''}>🔗 Other</option>
      </select>
      <input id="pg-u-${i}" class="pg-u mono" value="${esc(t.url)}" placeholder="http://IP:port or https://domain.com">
      <button class="btn sm danger" data-rm="${i}" title="Remove">✕</button>
    </div>`).join('');
  el('pbody').innerHTML = `
    <div class="card">
      <h3>🎯 Pages the customer can open</h3>
      <div class="sub">These are the exact pages your customer sees in <b>Point &amp; Fix</b>. Give each a clear name (like “Your Website” or “Admin Panel”) so they never have to guess from service names.</div>
      <div class="wrap" style="margin:12px 0">
        <button class="btn sm" id="pg-detect">🔍 Detect from server</button>
        <button class="btn sm" id="pg-add">➕ Add page</button>
      </div>
      <div class="pg-list">${rows || emptyHint('No pages yet — click “Detect from server” or “Add page”.')}</div>
      <div style="margin-top:14px"><button class="btn primary" id="pg-save">💾 Save pages</button></div>
      <div class="hint" style="margin-top:8px">Tip: the public website is usually a domain (https://…); an admin panel is often an IP + port (http://…:8080). If you set none, the customer sees an automatic best-guess.</div>
    </div>`;
  el('pg-add').onclick = () => { pagesSync(); PAGES.push({ label: '', kind: 'website', url: '' }); drawPages(p); };
  el('pg-detect').onclick = () => pagesDetect(p);
  el('pg-save').onclick = () => pagesSave(p);
  document.querySelectorAll('[data-rm]').forEach(btn => btn.onclick = () => { pagesSync(); PAGES.splice(Number(btn.dataset.rm), 1); drawPages(p); });
}
async function pagesDetect(p) {
  toast('Looking at the server…');
  try {
    const r = await api('/api/admin/projects/' + p.id + '/detect-targets', { method: 'POST' });
    pagesSync();
    const have = new Set(PAGES.map(x => (x.url || '').replace(/\/+$/, '')));
    (r.suggestions || []).forEach(s => { const u = (s.url || '').replace(/\/+$/, ''); if (u && !have.has(u)) { PAGES.push({ label: s.label || '', kind: s.kind || 'website', url: u }); have.add(u); } });
    drawPages(p);
    const n = (r.suggestions || []).length;
    toast(n ? `Found ${n} page(s) — rename them clearly, then Save.` : (r.note || 'Nothing detected — add pages manually.'), n ? 'good' : 'bad');
  } catch (e) { toast(e.message, 'bad'); }
}
async function pagesSave(p) {
  pagesSync();
  const targets = PAGES.filter(t => t.url && t.url.trim());
  try {
    await api('/api/admin/projects/' + p.id + '/edit-targets', { method: 'PUT', body: { targets } });
    toast('Saved ✓ — your customer now sees these pages.', 'good');
    await reload();
  } catch (e) { toast(e.message, 'bad'); }
}

function historyRows(h) {
  return `<table class="tbl"><tr><th>When</th><th>Action</th><th>Result</th></tr>${h.map(e => `<tr>
    <td class="faint">${new Date(e.at).toLocaleString()}</td><td>${esc(e.label || e.mode)}${e.by === 'client' ? ' <span class="pill">by customer</span>' : ''}</td>
    <td>${e.ok ? '<span class="badge ok">ok</span>' : '<span class="badge off">failed</span>'}</td></tr>`).join('')}</table>`;
}
function domainRow(p, d) {
  return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
    <div style="flex:1"><b>${esc(d)}</b> <span id="cert-${cssId(d)}" class="faint" style="font-size:12px"></span></div>
    <button class="btn sm" id="dck-${cssId(d)}">Check SSL</button>
    <button class="btn sm primary" id="ssl-${cssId(d)}">Issue SSL</button></div>`;
}
function cssId(s) { return String(s).replace(/[^a-z0-9]/gi, '_'); }

async function runDeploy(p, mode) {
  const log = el('d-log'); log.style.display = 'block'; log.textContent = 'Starting…';
  try {
    const { jobId } = await api('/api/admin/projects/' + p.id + '/deploy', { method: 'POST', body: { mode } });
    await pollJob('/api/admin', jobId, j => { log.textContent = j.log || j.status; log.scrollTop = log.scrollHeight; });
    toast('Deploy finished', 'good');
    const d = await api('/api/admin/projects/' + p.id); renderPTab(d.project, d.history);
  } catch (e) { toast(e.message, 'bad'); log.textContent += '\n✖ ' + e.message; }
}
async function loadHealth(p) {
  el('h-body').innerHTML = 'Checking…';
  try {
    const h = await api('/api/admin/projects/' + p.id + '/health');
    el('h-body').innerHTML = healthHtml(h);
  } catch (e) { el('h-body').innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
}
function meter(label, pct) {
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return `<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span class="muted">${label}</span><span>${pct == null ? '—' : pct + '%'}</span></div>
    <div class="meter ${cls}"><i style="width:${pct || 0}%"></i></div></div>`;
}
function healthHtml(h) {
  const c = (h.containers || []).map(ct => `<div style="display:flex;gap:8px;align-items:center;padding:4px 0"><span class="dot ${ct.up ? 'up' : 'down'}"></span>${esc(ct.name)} <span class="faint">${esc(ct.status)}</span></div>`).join('');
  return `${meter('CPU load', h.cpuPct)}${meter('Memory', h.memPct)}${meter('Disk', h.diskPct)}
    <div class="faint" style="margin-top:6px">${esc(h.uptime || '')}</div>
    <div class="sep"></div><div class="muted">Containers</div>${c || '<div class="faint">' + (h.dockerMissing ? 'Docker not found on server.' : 'none') + '</div>'}`;
}
async function loadBackups(p) {
  el('bk-body').innerHTML = 'Loading…';
  try {
    const items = await api('/api/admin/projects/' + p.id + '/backups');
    if (!items.length) { el('bk-body').innerHTML = emptyHint('No backups found in that folder yet.'); return; }
    el('bk-body').innerHTML = `<table class="tbl"><tr><th>Backup file</th><th>Date</th><th></th></tr>${items.map(it => `<tr>
      <td class="mono">${esc(it.name)}</td><td class="faint">${esc(it.date)}</td>
      <td><button class="btn sm danger" data-f="${esc(it.name)}">Rollback</button></td></tr>`).join('')}</table>`;
    el('bk-body').querySelectorAll('button[data-f]').forEach(btn => btn.onclick = () => rollback(p, btn.dataset.f));
  } catch (e) { el('bk-body').innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
}
async function rollback(p, file) {
  if (!confirm('Roll back to ' + file + '? This replaces the current files.')) return;
  const log = el('bk-log'); log.style.display = 'block'; log.textContent = 'Starting…';
  try {
    const { jobId } = await api('/api/admin/projects/' + p.id + '/restore', { method: 'POST', body: { file } });
    await pollJob('/api/admin', jobId, j => { log.textContent = j.log; log.scrollTop = log.scrollHeight; });
    toast('Rollback done', 'good');
  } catch (e) { toast(e.message, 'bad'); }
}
async function checkCert(d) {
  const span = el('cert-' + cssId(d)); span.textContent = ' checking…';
  try { const r = await api('/api/admin/check-cert?domain=' + encodeURIComponent(d)); span.textContent = r.ok ? ` 🔒 ${r.daysLeft} days left (${r.issuer || ''})` : ' ✖ ' + (r.error || 'no cert'); }
  catch (e) { span.textContent = ' ✖ ' + e.message; }
}
async function issueSsl(p, d) {
  const log = el('ssl-log'); log.style.display = 'block'; log.textContent = 'Starting…';
  try { const { jobId } = await api('/api/admin/projects/' + p.id + '/ssl', { method: 'POST', body: { domain: d } });
    await pollJob('/api/admin', jobId, j => { log.textContent = j.log; log.scrollTop = log.scrollHeight; });
    toast('SSL command finished', 'good');
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============ SETTINGS ============ */
function renderSettings() {
  const s = OV.settings;
  el('view').innerHTML = `
    <div class="top"><div><div class="title">Settings</div><div class="sub">AI developer key, global rules, alerts</div></div></div>
    <div class="card">
      <h3>AI developer key <span class="pill">hidden from customers</span></h3>
      <div class="sub">You add it once here and pay for all customers. They never see it.</div>
      <label class="f">Which AI to use</label>
      <select id="s-prov">
        <option value="claude" ${(s.aiProvider || 'claude') === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
        <option value="openai" ${s.aiProvider === 'openai' ? 'selected' : ''}>OpenAI (ChatGPT)</option>
        <option value="gemini" ${s.aiProvider === 'gemini' ? 'selected' : ''}>Google Gemini (free tier available)</option>
      </select>
      <div class="hint">Pick the one you have credit for. You only need a key for the one you choose. Gemini has a free tier to start.</div>

      <div class="sep" style="margin:14px 0"></div>
      <div style="font-weight:700;margin-bottom:6px">Claude</div>
      <label class="f">Model</label>
      <select id="s-model">
        ${['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(m => `<option value="${m}" ${(s.aiModel || 'claude-opus-5-5') === m ? 'selected' : ''}>${m}${m === 'claude-opus-5-5' ? ' (most capable)' : m === 'claude-sonnet-5-5' ? ' (balanced, cheaper)' : ' (fastest, cheapest)'}</option>`).join('')}
      </select>
      <label class="f">Claude API key ${s.aiKeySet ? '<span class="badge ok">set</span>' : '<span class="badge off">not set</span>'}</label>
      <input id="s-aikey" type="password" placeholder="${s.aiKeySet ? '•••••• saved — leave blank to keep' : 'paste your Claude key (sk-ant-...)'}">
      <div class="hint">From console.anthropic.com → API Keys.</div>

      <div class="sep" style="margin:14px 0"></div>
      <div style="font-weight:700;margin-bottom:6px">OpenAI</div>
      <label class="f">Model</label>
      <input id="s-omodel" value="${esc(s.openaiModel || 'gpt-4o')}" placeholder="gpt-4o">
      <label class="f">OpenAI API key ${s.openaiKeySet ? '<span class="badge ok">set</span>' : '<span class="badge off">not set</span>'}</label>
      <input id="s-okey" type="password" placeholder="${s.openaiKeySet ? '•••••• saved — leave blank to keep' : 'paste your OpenAI key (sk-...)'}">
      <div class="hint">From platform.openai.com → API keys.</div>

      <div class="sep" style="margin:14px 0"></div>
      <div style="font-weight:700;margin-bottom:6px">Google Gemini <span class="pill">free tier</span></div>
      <label class="f">Model</label>
      <input id="s-gmodel" value="${esc(s.geminiModel || 'gemini-2.5-flash')}" placeholder="gemini-2.5-flash">
      <label class="f">Gemini API key ${s.geminiKeySet ? '<span class="badge ok">set</span>' : '<span class="badge off">not set</span>'}</label>
      <input id="s-gkey" type="password" placeholder="${s.geminiKeySet ? '•••••• saved — leave blank to keep' : 'paste your Gemini key'}">
      <div class="hint">Free key from aistudio.google.com → Get API key.</div>

      <div class="wrap" style="margin-top:14px"><button class="btn primary" id="s-ai">Save AI settings</button><button class="btn" id="s-aicheck">💳 Check active key</button></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>AI usage & credit</h3>
      <div class="sub">What your shared API key has cost so far. These are CloudForge's estimates from the tokens each request used.</div>
      <div id="usage-body" class="sub" style="margin-top:12px">Loading…</div>
      <div class="hint" style="margin-top:10px">⚠️ Anthropic has no live "credit remaining" for a normal key. For your real prepaid balance, open <b>console.anthropic.com → Billing</b>. Set a hard spend limit there too so you can never be overcharged.</div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>GitHub (code storage) <span class="pill">hidden from customers</span></h3>
      <div class="sub">Instead of hosting a server for the code, CloudForge keeps each project's code in your GitHub. Paste a GitHub token once — it stays hidden and encrypted.</div>
      <label class="f">GitHub token ${s.githubSet ? '<span class="badge ok">set</span>' : '<span class="badge off">not set</span>'}</label>
      <input id="s-ghtoken" type="password" placeholder="${s.githubSet ? '•••••• saved — leave blank to keep' : 'paste a GitHub token (github_pat_... or ghp_...)'}">
      <div class="hint">Make one at github.com → Settings → Developer settings → <b>Fine-grained tokens</b>, with <b>Contents: Read &amp; write</b> on your repos. Keep customer repos <b>private</b>.</div>
      <div class="wrap" style="margin-top:12px"><button class="btn primary" id="s-ghsave">Save GitHub token</button><button class="btn" id="s-ghcheck">🔗 Check connection</button></div>
      <div class="sep" style="margin:14px 0"></div>
      <label class="f">Test a repo (owner/name)</label>
      <div class="wrap"><input id="s-ghrepo" placeholder="e.g. Mootassam/customer-site" style="flex:1;min-width:160px"><button class="btn" id="s-ghtest">Test access</button></div>
      <div id="s-ghres" class="sub" style="margin-top:8px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Global rules</h3><div class="sub">Applied to every project's AI developer.</div>
      <textarea id="s-rules" style="min-height:140px;margin-top:10px">${esc(s.globalRules)}</textarea>
      <div style="margin-top:12px"><button class="btn primary" id="s-rsave">Save rules</button></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Telegram alerts</h3><div class="sub">Get a message when a deploy fails or a site goes down.</div>
      <label class="f">Bot token</label><input id="s-tgt" value="${esc(s.telegram.botToken)}" placeholder="123456:ABC...">
      <label class="f">Chat id</label><input id="s-tgc" value="${esc(s.telegram.chatId)}" placeholder="your chat id">
      <div class="wrap" style="margin-top:12px"><button class="btn primary" id="s-tgsave">Save</button><button class="btn" id="s-tgtest">Send test</button></div>
    </div>`;
  el('s-ai').onclick = async () => { await api('/api/admin/settings', { method: 'POST', body: { aiProvider: el('s-prov').value, aiModel: el('s-model').value, aiKey: el('s-aikey').value, openaiModel: el('s-omodel').value, openaiKey: el('s-okey').value, geminiModel: el('s-gmodel').value, geminiKey: el('s-gkey').value } }); await reload(); render(); toast('Saved', 'good'); };
  el('s-aicheck').onclick = async () => {
    toast('Checking the key…');
    try { const r = await api('/api/admin/check-key', { method: 'POST' }); toast(r.valid ? '✅ Key works' + (r.note ? ' — ' + r.note : '') : '✖ ' + (r.error || 'Invalid key'), r.valid ? 'good' : 'bad'); }
    catch (e) { toast(e.message, 'bad'); }
  };
  loadUsage();
  el('s-ghsave').onclick = async () => { await api('/api/admin/settings', { method: 'POST', body: { githubToken: el('s-ghtoken').value } }); el('s-ghtoken').value = ''; await reload(); render(); toast('GitHub token saved', 'good'); };
  el('s-ghcheck').onclick = async () => {
    toast('Checking GitHub…');
    try { const r = await api('/api/admin/github-check', { method: 'POST' }); toast(r.ok ? '✅ Connected as ' + r.login : '✖ ' + (r.error || 'Not connected'), r.ok ? 'good' : 'bad'); }
    catch (e) { toast(e.message, 'bad'); }
  };
  el('s-ghtest').onclick = async () => {
    const box = el('s-ghres'); box.innerHTML = 'Checking…';
    try {
      const r = await api('/api/admin/github-test-repo', { method: 'POST', body: { repo: el('s-ghrepo').value } });
      box.innerHTML = r.ok
        ? `<span class="badge ok">OK</span> ${esc(r.fullName)} · ${r.private ? '🔒 private' : '🌍 public'} · default branch <b>${esc(r.defaultBranch)}</b> · ${r.canPush ? 'can push ✅' : '⚠️ read-only (token can’t push)'}`
        : `<span class="muted">✖ ${esc(r.error)}</span>`;
    } catch (e) { box.innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
  };
  el('s-rsave').onclick = async () => { await api('/api/admin/settings', { method: 'POST', body: { globalRules: el('s-rules').value } }); toast('Saved', 'good'); };
  el('s-tgsave').onclick = async () => { await api('/api/admin/settings', { method: 'POST', body: { telegram: { botToken: el('s-tgt').value.trim(), chatId: el('s-tgc').value.trim() } } }); await reload(); toast('Saved', 'good'); };
  el('s-tgtest').onclick = async () => { const r = await api('/api/admin/telegram-test', { method: 'POST' }); toast(r.ok ? 'Sent ✅' : '✖ ' + r.error, r.ok ? 'good' : 'bad'); };
}

async function loadUsage() {
  const box = el('usage-body'); if (!box) return;
  try {
    const u = await api('/api/admin/usage');
    const money = (n) => '$' + (Number(n) || 0).toFixed(n < 0.01 ? 4 : 2);
    const tokens = (n) => (Number(n) || 0) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (Number(n) || 0) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
    box.innerHTML = `
      <div class="usage-grid">
        <div class="ucard"><div class="un">${money(u.thisMonth)}</div><div class="ul">spent this month</div></div>
        <div class="ucard"><div class="un">${money(u.totals.costUsd)}</div><div class="ul">spent all-time</div></div>
        <div class="ucard"><div class="un">${u.totals.calls}</div><div class="ul">AI requests</div></div>
        <div class="ucard"><div class="un">${tokens(u.totals.inputTokens + u.totals.outputTokens)}</div><div class="ul">tokens used</div></div>
      </div>
      <div class="faint" style="font-size:12px;margin-top:10px">Current model: <b>${esc(u.model)}</b>${u.updatedAt ? ' · last used ' + new Date(u.updatedAt).toLocaleString() : ' · no usage yet'}</div>`;
  } catch (e) { box.innerHTML = '<span class="muted">Couldn’t load usage: ' + esc(e.message) + '</span>'; }
}

/* ============ shared ============ */
function openDrawer(html) { el('drawer').innerHTML = html; el('overlay').hidden = false; }
function closeDrawer() { el('overlay').hidden = true; }
el('overlay').onclick = (e) => { if (e.target === el('overlay')) closeDrawer(); };
function showKey(key, msg) {
  openDrawer(`<div class="title">🔑 Access key</div><div class="sub">${esc(msg)}</div>
    <div class="keybox" style="margin:18px 0">${esc(key)}</div>
    <div class="hint">⚠️ Copy it now — for security it will never be shown in full again.</div>
    <div class="wrap" style="margin-top:16px"><button class="btn primary" id="k-copy">📋 Copy</button><button class="btn ghost" id="k-done">Done</button></div>`);
  el('k-copy').onclick = () => { navigator.clipboard.writeText(key).then(() => toast('Copied', 'good')); };
  el('k-done').onclick = closeDrawer;
}

/* ============ boot ============ */
(async function init() {
  try {
    const st = await api('/api/auth/state');
    if (!st.admin) return location.href = '/';
    await reload();
    setRoute('dashboard');
  } catch (e) { toast(e.message, 'bad'); }
})();
