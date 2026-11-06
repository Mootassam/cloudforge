'use strict';
let ME = null, TAB = 'ai';
let pendingImage = null;   // {data, mediaType, preview}
let aiBusy = false;
let PF = null;             // Point & Fix server-browser state
let capturedPage = null;   // {url, element} handed from Point & Fix to the AI
let pfCtx = null, pfDrawing = false;

el('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };

async function load() {
  ME = await api('/api/client/me');
  el('proj-name').textContent = ME.project.name;
  el('proj-sub').textContent = (ME.project.customer || '') + (ME.project.domains[0] ? ' · ' + ME.project.domains[0] : '');
  document.querySelectorAll('.cnav[data-t]').forEach(n => n.onclick = () => setTab(n.dataset.t));
  checkSite();
  setTab(TAB);
}

function setTab(t) {
  TAB = t;
  document.querySelectorAll('.cnav[data-t]').forEach(n => n.classList.toggle('on', n.dataset.t === t));
  render();
}

function render() {
  el('view').className = 'appmain'; // reset (renderAI re-adds chat-mode)
  if (TAB === 'ai') return renderAI();
  if (TAB === 'point') return renderPoint();
  if (TAB === 'deploy') return renderDeploy();
  if (TAB === 'backups') return renderBackups();
  if (TAB === 'activity') return renderActivity();
}
function page(html) { el('view').innerHTML = `<div class="container">${html}</div>`; }

/* ================= AI DEVELOPER ================= */
async function renderAI() {
  const v = el('view');
  if (ME.project.aiBlocked) {
    v.className = 'appmain';
    v.innerHTML = `<div class="blocked"><div class="inner">
      <div style="font-size:44px">🤖</div><h3 style="margin:14px 0 8px;font-size:19px">AI Developer</h3>
      <div class="sub">${esc(ME.project.aiBlocked)}</div></div></div>`;
    return;
  }
  v.className = 'appmain chat-mode';
  v.innerHTML = `
    <div class="chatshell">
      <div class="chathead">
        <div><b>🤖 AI Developer</b><div class="faint" style="font-size:12px">Describe a change or attach a screenshot — nothing goes live until you approve.</div></div>
        <button class="btn sm ghost" id="ai-reset" title="Clear chat">⟲ Clear</button>
      </div>
      <div class="chatscroll">
        <div class="chat" id="chat"></div>
        <div id="proposed"></div>
        <div id="thinkwrap"></div>
      </div>
      <div class="composer">
        <div style="flex:1">
          <div id="thumbwrap"></div>
          <textarea id="ai-text" placeholder="Describe the change… you can also paste a screenshot (Ctrl+V) or drag an image here"></textarea>
        </div>
        <button class="btn iconbtn" id="ai-attach" title="Attach image">📎</button>
        <button class="btn primary iconbtn" id="ai-send" title="Send">➤</button>
      </div>
    </div>`;
  el('ai-reset').onclick = async () => { if (!confirm('Clear the conversation and any pending changes?')) return; await api('/api/client/ai/discard', { method: 'POST' }); location.reload(); };
  // drag & drop an image onto the chat
  const shell = document.querySelector('.chatshell');
  if (shell) {
    shell.addEventListener('dragover', e => { e.preventDefault(); });
    shell.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && attachImageFile(f)) toast('Image added ✓', 'good');
    });
  }
  el('ai-attach').onclick = () => el('file-input').click();
  el('ai-send').onclick = sendAI;
  el('ai-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAI(); });

  const st = await api('/api/client/ai/state');
  renderChat(st.transcript);
  renderProposed(st.changes);
  if (!st.transcript.length) {
    el('chat').innerHTML = `<div class="msg sys">👋 Hi! I'm your AI developer. Tell me what to change on your site in plain words — and you can <b>paste a screenshot (Ctrl+V)</b> or drag an image in, with a description. I'll show you exactly what I'll change, and nothing goes live until you approve.</div>`;
  }
}

function chatBottom() { const s = document.querySelector('.chatscroll'); if (s) s.scrollTop = s.scrollHeight; }
function renderChat(transcript) {
  const c = el('chat'); if (!c) return;
  c.innerHTML = transcript.map(m => m.role === 'user'
    ? `<div class="msg user"><div class="who">You</div>${m.image ? '🖼️ <i>(screenshot)</i>\n' : ''}${esc(m.text)}</div>`
    : `<div class="msg ai"><div class="who">AI developer</div>${esc(m.text)}</div>`).join('');
  chatBottom();
}

function renderProposed(changes) {
  const box = el('proposed'); if (!box) return;
  if (!changes || !changes.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="changes">
      <div class="chead"><div><b>📝 ${changes.length} change${changes.length > 1 ? 's' : ''} ready to review</b>
        <div class="faint" style="font-size:12px">A safety backup is taken before anything is applied.</div></div></div>
      ${changes.map((ch, i) => changeHtml(ch, i)).join('')}
      <div class="cfoot">
        <button class="btn good" id="ai-approve">✓ Approve & deploy</button>
        <button class="btn danger" id="ai-discard">Discard</button>
      </div>
    </div>`;
  changes.forEach((ch, i) => {
    const fh = el('fh-' + i); if (fh) fh.onclick = () => { const d = el('df-' + i); d.style.display = d.style.display === 'none' ? 'block' : 'none'; };
  });
  el('ai-approve').onclick = approveAI;
  el('ai-discard').onclick = async () => { if (!confirm('Discard these proposed changes?')) return; await api('/api/client/ai/discard', { method: 'POST' }); renderAI(); };
}

function changeHtml(ch, i) {
  return `<div class="change">
    <div class="fhead" id="fh-${i}">
      <span>${ch.isNew ? '🆕' : '✏️'}</span>
      <div style="flex:1"><div class="fn">${esc(ch.path)}</div><div class="summary">${esc(ch.summary)}</div></div>
      <span class="faint" style="font-size:12px">view ▾</span>
    </div>
    <div class="diff" id="df-${i}" style="display:none">${diffHtml(ch.oldContent || '', ch.newContent || '')}</div>
  </div>`;
}

function diffHtml(oldS, newS) {
  const a = oldS.split('\n'), b = newS.split('\n');
  if (a.length > 600 || b.length > 600) return `<div class="dl ctx"><span class="g"></span>(large file — ${b.length} lines)</div>`;
  const d = lcsDiff(a, b);
  return d.map(x => `<div class="dl ${x.t}"><span class="g">${x.t === 'add' ? '+' : x.t === 'del' ? '−' : ''}</span>${esc(x.line) || ' '}</div>`).join('');
}
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', line: a[i] }); i++; }
    else { out.push({ t: 'add', line: b[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', line: a[i++] });
  while (j < m) out.push({ t: 'add', line: b[j++] });
  return out;
}

// one place that accepts an image from the file picker, paste, or drag-drop
function attachImageFile(file) {
  if (!file || !/^image\//.test(file.type || '')) return false;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { data: reader.result.split(',')[1], mediaType: file.type || 'image/png', preview: reader.result };
    showThumb();
  };
  reader.readAsDataURL(file);
  return true;
}
function showThumb() {
  const w = el('thumbwrap'); if (!w || !pendingImage) return;
  w.innerHTML = `<div class="thumb"><img src="${pendingImage.preview}"><span>image attached</span><span style="cursor:pointer" id="thumb-x">✕</span></div>`;
  const x = el('thumb-x'); if (x) x.onclick = () => { pendingImage = null; el('thumbwrap').innerHTML = ''; };
}
el('file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (attachImageFile(f)) toast('Image attached ✓', 'good'); e.target.value = ''; });

// paste a screenshot anywhere while on the AI tab (Ctrl/Cmd+V)
document.addEventListener('paste', (e) => {
  if (TAB !== 'ai' || !ME || (ME.project && ME.project.aiBlocked)) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); attachImageFile(f); toast('Screenshot pasted ✓', 'good'); }
      return;
    }
  }
});

async function sendAI() {
  if (aiBusy) return;
  const text = el('ai-text').value.trim();
  if (!text && !pendingImage) return;
  aiBusy = true;
  // optimistic echo (show the actual image the customer attached)
  const c = el('chat');
  if (c.querySelector('.sys')) c.innerHTML = '';
  const imgPrev = pendingImage ? pendingImage.preview : null;
  c.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="who">You</div>${imgPrev ? `<img src="${imgPrev}" class="msgimg">` : ''}${esc(text)}</div>`);
  chatBottom();
  const body = { text }; if (pendingImage) { body.imageBase64 = pendingImage.data; body.imageMediaType = pendingImage.mediaType; }
  if (capturedPage) { body.page = capturedPage; capturedPage = null; }
  el('ai-text').value = ''; pendingImage = null; el('thumbwrap').innerHTML = '';
  el('ai-send').disabled = true; el('ai-attach').disabled = true;
  showThinking('Thinking…');
  try {
    const { jobId } = await api('/api/client/ai/chat', { method: 'POST', body });
    const j = await pollJob('/api/client', jobId, x => { if (x.log) showThinking(x.log.split('\n').filter(Boolean).slice(-1)[0] || 'Working…'); });
    clearThinking();
    const res = j.result || {};
    if (res.error) { toast(res.error, 'bad'); c.insertAdjacentHTML('beforeend', `<div class="msg sys">✖ ${esc(res.error)}</div>`); }
    else {
      c.insertAdjacentHTML('beforeend', `<div class="msg ai"><div class="who">AI developer</div>${esc(res.reply || 'Done.')}</div>`);
      renderProposed(res.changes || []);
    }
    chatBottom();
  } catch (e) { clearThinking(); toast(e.message, 'bad'); }
  finally { aiBusy = false; el('ai-send').disabled = false; el('ai-attach').disabled = false; }
}
function showThinking(t) { const w = el('thinkwrap'); if (w) w.innerHTML = `<div class="thinking"><span class="spin"></span>${esc(t)}</div>`; }
function clearThinking() { const w = el('thinkwrap'); if (w) w.innerHTML = ''; }

async function approveAI() {
  if (!confirm('Apply these changes to your live site? A backup is taken first.')) return;
  const box = el('proposed');
  box.insertAdjacentHTML('beforeend', `<div class="logbox" id="ai-applylog" style="margin-top:10px">Starting…</div>`);
  try {
    const { jobId } = await api('/api/client/ai/approve', { method: 'POST', body: { mode: 'full' } });
    const j = await pollJob('/api/client', jobId, x => { const l = el('ai-applylog'); if (l) { l.textContent = x.log; l.scrollTop = l.scrollHeight; } });
    toast(j.ok ? '✅ Changes are live!' : '✖ Failed — your site was not changed.', j.ok ? 'good' : 'bad');
    if (j.ok) { ME = await api('/api/client/me'); renderAI(); }
  } catch (e) { toast(e.message, 'bad'); }
}

/* ================= POINT & FIX (server-browser) ================= */
function renderPoint() {
  if (PF && PF.stage === 'browse') return pfBrowse();
  if (PF && PF.stage === 'describe') return pfDescribe();
  return pfTargets();
}
function pfPath(u) { try { return new URL(u).pathname || '/'; } catch { return u || ''; } }
function pfElDesc(e) {
  if (!e) return '';
  if (e.text) return '“' + e.text + '”';
  if (e.placeholder) return '(placeholder “' + e.placeholder + '”)';
  if (e.id) return '#' + e.id;
  return e.selector || '';
}

async function pfTargets() {
  el('view').className = 'appmain';
  page(`<div class="card">
    <h3>🎯 Point &amp; Fix</h3>
    <div class="sub pf-intro">Open your own website or admin panel right here, go to the exact page, click the thing you want changed — then send it to the AI. No links to copy, nothing to install.</div>
    <div id="pf-list"><span class="faint">Looking at your setup…</span></div>
  </div>`);
  let info;
  try { info = await api('/api/client/targets'); }
  catch (e) { el('pf-list').innerHTML = emptyHint(e.message); return; }
  const targets = info.targets || [], svc = info.services || [];
  let html = '';
  if (targets.length) {
    html += `<div class="pf-targets">` + targets.map(t => `
      <div class="pf-target" data-id="${esc(t.id)}">
        <div class="ic">${t.kind === 'admin' ? '🛠️' : t.kind === 'other' ? '🔗' : '🌐'}</div>
        <div><div class="tl">${esc(t.label)}</div><div class="ts">${t.kind === 'admin' ? 'Your admin panel' : t.kind === 'other' ? 'Open this page' : 'Your public website'}</div></div>
      </div>`).join('') + `</div>`;
  } else {
    html += emptyHint(info.note || 'No pages detected yet — you can still use the 🤖 AI Developer tab to describe changes.');
  }
  if (svc.length) {
    html += `<div class="faint" style="margin-top:6px;font-size:12px">What we found on your server:</div><div class="pf-have">` +
      svc.map(s => `<span class="pf-chip ${esc(s.kind)}">${esc(s.name)} · ${esc(s.kind)}</span>`).join('') + `</div>`;
  }
  el('pf-list').innerHTML = html;
  document.querySelectorAll('.pf-target').forEach(n => n.onclick = () => pfStart(n.dataset.id));
}

async function pfStart(targetId) {
  el('pf-list').innerHTML = '<span class="faint">Opening your page… (this can take a few seconds)</span>';
  try {
    const out = await api('/api/client/capture/start', { method: 'POST', body: { targetId } });
    PF = { stage: 'browse', sessionId: out.sessionId, target: out.target, url: out.url, mode: 'nav', img: out.screenshot, element: null };
    renderPoint();
  } catch (e) { toast(e.message, 'bad'); pfTargets(); }
}

function pfFull(html) { const v = el('view'); v.className = 'appmain pf-full-mode'; v.innerHTML = html; }

function pfBrowse() {
  pfFull(`<div class="pf-framewrap">
      <div class="pf-toolbar">
        <button class="btn sm ghost" id="pf-back" title="Back">◀</button>
        <button class="btn sm ghost" id="pf-reload" title="Reload the page">⟳</button>
        <span class="pf-url" id="pf-url"></span>
        <button class="btn sm" id="pf-type">⌨ Type / Log in</button>
        <button class="btn sm good" id="pf-pick">🎯 This is the spot</button>
        <button class="btn sm danger" id="pf-close">✕ Close</button>
      </div>
      <div class="pf-stage nav" id="pf-stage"><img id="pf-img" src="${PF.img}"><div class="pf-busy" id="pf-busy" style="display:none"><span class="spin"></span>&nbsp;working…</div></div>
      <div class="pf-hint" id="pf-hint"></div>
    </div>`);
  el('pf-url').textContent = (PF.target ? PF.target.label + '  ·  ' : '') + pfPath(PF.url);
  el('pf-img').onclick = pfStageClick;
  el('pf-back').onclick = () => pfCall('/api/client/capture/back', {});
  el('pf-reload').onclick = () => pfCall('/api/client/capture/reload', {});
  el('pf-close').onclick = pfClose;
  el('pf-pick').onclick = () => { PF.mode = PF.mode === 'pick' ? 'nav' : 'pick'; pfApplyMode(); };
  el('pf-type').onclick = pfOpenType;
  pfApplyMode();
}

function pfApplyMode() {
  const stage = el('pf-stage'); if (!stage) return;
  const pick = PF.mode === 'pick';
  stage.classList.toggle('pick', pick);
  stage.classList.toggle('nav', !pick);
  const b = el('pf-pick'); if (b) b.textContent = pick ? '↩ Keep browsing' : '🎯 This is the spot';
  const h = el('pf-hint'); if (h) h.innerHTML = pick
    ? `<b class="pf-mode">Pick the spot:</b> click the exact thing on the page you want changed (a button, some text, an image…).`
    : `<b class="pf-mode">Browsing:</b> click links and buttons to move around, like a normal browser. On the right page, click <b>🎯 This is the spot</b>.`;
}

function pfCoords(e) {
  const img = el('pf-img'), r = img.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
}
async function pfStageClick(e) {
  const c = pfCoords(e);
  if (PF.mode === 'pick') {
    const out = await pfCall('/api/client/capture/point', c, true);
    if (out) { PF.element = out.element; PF.img = out.screenshot; PF.url = out.url; PF.stage = 'describe'; renderPoint(); }
  } else {
    await pfCall('/api/client/capture/click', c);
  }
}

// call a capture endpoint, refresh the frame; returns the data (or null on error)
async function pfCall(url, extra, silent) {
  const busy = el('pf-busy'); if (busy) busy.style.display = 'flex';
  try {
    const out = await api(url, { method: 'POST', body: Object.assign({ sessionId: PF.sessionId }, extra || {}) });
    if (!silent) {
      if (out.screenshot) { PF.img = out.screenshot; const im = el('pf-img'); if (im) im.src = out.screenshot; }
      if (out.url) { PF.url = out.url; const u = el('pf-url'); if (u) u.textContent = (PF.target ? PF.target.label + '  ·  ' : '') + pfPath(out.url); }
      if (out.blocked) toast('That link leaves your own site, so I stayed on your app.', 'bad');
    }
    return out;
  } catch (e) {
    toast(e.message, 'bad');
    if (/expired|session/i.test(e.message)) { PF = null; renderPoint(); }
    return null;
  } finally { const b = el('pf-busy'); if (b) b.style.display = 'none'; }
}

async function pfClose() {
  const sid = PF && PF.sessionId; PF = null;
  if (sid) { try { await api('/api/client/capture/close', { method: 'POST', body: { sessionId: sid } }); } catch { } }
  renderPoint();
}

/* ---- Type / Log in modal ---- */
async function pfOpenType() {
  let data;
  try { data = await api('/api/client/capture/fields', { method: 'POST', body: { sessionId: PF.sessionId } }); }
  catch (e) { toast(e.message, 'bad'); return; }
  if (data.screenshot) { PF.img = data.screenshot; const im = el('pf-img'); if (im) im.src = data.screenshot; }
  const fields = data.fields || [];
  const rows = fields.length
    ? fields.map(f => `<div class="pf-frow">
        <label>${esc(f.label)} ${f.isPassword ? '🔒' : ''}</label>
        <input id="pf-f-${f.i}" type="${f.isPassword ? 'password' : 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.label)}">
      </div>`).join('')
    : `<div class="faint" style="font-size:13px">No typing boxes were found on this page. Use the box below to type into whatever you last clicked.</div>`;
  const html = `
    <div class="pf-mhead"><b>⌨ Type / Log in</b><span class="pf-x" id="pf-m-x">✕</span></div>
    <div class="pf-mbody">
      <div class="faint" style="font-size:12.5px;margin-bottom:10px">Fill the boxes (for example your username and password), then press <b>Log in</b>. You can edit anything.</div>
      ${rows}
      <details class="pf-free"><summary>Type something else manually</summary>
        <textarea id="pf-free" placeholder="Type any text — it goes where you last clicked on the page."></textarea>
        <button class="btn sm" id="pf-free-go" style="margin-top:6px">Type it</button>
      </details>
    </div>
    <div class="pf-mfoot">
      <button class="btn ghost" id="pf-m-close">Close</button>
      <div style="flex:1"></div>
      ${fields.length ? `<button class="btn" id="pf-m-fill">✍ Fill boxes</button><button class="btn good" id="pf-m-login">➜ Log in</button>` : ''}
    </div>`;
  pfModal(html);
  el('pf-m-x').onclick = pfCloseModal;
  el('pf-m-close').onclick = pfCloseModal;
  const fg = el('pf-free-go'); if (fg) fg.onclick = async () => { const tx = el('pf-free').value; if (tx) { await pfCall('/api/client/capture/type', { text: tx }); toast('Typed ✓', 'good'); } };
  if (fields.length) {
    el('pf-m-fill').onclick = async () => { await pfFillAll(fields); };
    el('pf-m-login').onclick = async () => { await pfFillAll(fields); await pfCall('/api/client/capture/press', { key: 'Enter' }); toast('Logging you in…', 'good'); pfCloseModal(); };
  }
}
async function pfFillAll(fields) {
  for (const f of fields) {
    const inp = el('pf-f-' + f.i); if (!inp) continue;
    const v = inp.value;
    if (f.isPassword ? v !== '' : v !== (f.value || '')) await pfCall('/api/client/capture/fill', { index: f.i, value: v });
  }
  toast('Boxes filled ✓', 'good');
}
function pfModal(html) {
  let m = el('pf-modal');
  if (!m) { m = document.createElement('div'); m.id = 'pf-modal'; m.className = 'pf-ov'; document.body.appendChild(m); }
  m.innerHTML = `<div class="pf-dialog">${html}</div>`;
  m.onclick = (e) => { if (e.target === m) pfCloseModal(); };
}
function pfCloseModal() { const m = el('pf-modal'); if (m) m.remove(); }

function pfDescribe() {
  const e0 = PF.element;
  pfFull(`<div class="pf-describe">
    <div class="pf-framewrap" style="flex:1;min-height:0">
      <div class="pf-toolbar">
        ${e0 ? `<span class="pf-elchip sm">📍 &lt;${esc(e0.tag || 'element')}&gt; ${esc(pfElDesc(e0))}</span>` : ''}
        <span class="faint" style="font-size:12px;flex:1">✏️ Drag on the image to circle what you mean (red).</span>
        <button class="btn sm ghost" id="pf-clear">Clear drawing</button>
        <button class="btn sm" id="pf-reopen">↩ Keep browsing</button>
      </div>
      <div class="pf-stage draw" id="pf-stage">
        <img id="pf-img" src="${PF.img}"><canvas class="pf-canvas" id="pf-canvas"></canvas>
      </div>
    </div>
    <div class="composer pf-composer">
      <textarea id="pf-task" placeholder="What should change here? e.g. “make this button green and say Order Now”"></textarea>
      <button class="btn primary iconbtn" id="pf-send" title="Send to AI">➤</button>
    </div>
  </div>`);
  pfSetupDraw(el('pf-img'), el('pf-canvas'));
  el('pf-clear').onclick = () => { const c = el('pf-canvas'); if (pfCtx) pfCtx.clearRect(0, 0, c.width, c.height); };
  el('pf-reopen').onclick = () => { PF.stage = 'browse'; PF.mode = 'nav'; renderPoint(); };
  el('pf-send').onclick = () => pfSend(el('pf-img'), el('pf-canvas'));
}

function pfSetupDraw(img, canvas) {
  function fit() {
    canvas.width = img.clientWidth; canvas.height = img.clientHeight;
    canvas.style.width = img.clientWidth + 'px'; canvas.style.height = img.clientHeight + 'px';
    pfCtx = canvas.getContext('2d');
    pfCtx.strokeStyle = '#ff2d2d'; pfCtx.lineWidth = 4; pfCtx.lineCap = 'round'; pfCtx.lineJoin = 'round';
  }
  if (img.complete && img.clientWidth) fit(); else img.onload = fit;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { if (!pfCtx) return; pfDrawing = true; const q = pos(e); pfCtx.beginPath(); pfCtx.moveTo(q.x, q.y); e.preventDefault(); };
  const move = (e) => { if (!pfDrawing || !pfCtx) return; const q = pos(e); pfCtx.lineTo(q.x, q.y); pfCtx.stroke(); e.preventDefault(); };
  const end = () => { pfDrawing = false; };
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
}

async function pfSend(img, canvas) {
  const task = el('pf-task').value.trim();
  if (!task) { toast('Tell the AI what to change here.', 'bad'); return; }
  const w = img.clientWidth, h = img.clientHeight;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  try { ctx.drawImage(img, 0, 0, w, h); ctx.drawImage(canvas, 0, 0, w, h); } catch { }
  const dataURL = out.toDataURL('image/jpeg', 0.82);
  pendingImage = { data: dataURL.split(',')[1], mediaType: 'image/jpeg', preview: dataURL };
  capturedPage = { url: PF.url, element: PF.element };
  const sid = PF.sessionId; PF = null;
  if (sid) { try { await api('/api/client/capture/close', { method: 'POST', body: { sessionId: sid } }); } catch { } }
  setTab('ai');
  setTimeout(() => { const ta = el('ai-text'); if (ta) ta.value = task; sendAI(); }, 80);
}

/* ================= DEPLOY ================= */
function renderDeploy() {
  const p = ME.project;
  const used = p.usageLimit > 0 ? `${p.usageToday}/${p.usageLimit} deploys used today` : `${p.usageToday} deploys today`;
  page(`
    <div class="card">
      <h3>🚀 Deploy</h3>
      <div class="sub">Push your latest changes live. A safety backup is taken automatically first.</div>
      <div class="wrap" style="margin-top:14px">
        ${p.canFull ? '<button class="btn good" id="d-full">🚀 Deploy full website</button>' : ''}
        ${p.canContainers ? '<button class="btn primary" id="d-cont">📦 Update backend / server</button>' : ''}
        ${(!p.canFull && !p.canContainers) ? '<div class="faint">Deploy isn\'t set up yet. Contact your provider.</div>' : ''}
      </div>
      <div class="faint" style="margin-top:10px">${used}${ME.queue.active || ME.queue.queued ? ` · queue: ${ME.queue.active} running, ${ME.queue.queued} waiting` : ''}</div>
      <div class="logbox" id="log" style="margin-top:14px;display:none"></div>
    </div>
    ${p.github ? `<div class="card" style="margin-top:14px">
      <h3>↩ Undo last change</h3>
      <div class="sub">Made a change you don't like? This safely rolls back to the previous version (your history is kept).</div>
      <div style="margin-top:12px"><button class="btn danger" id="d-undo">↩ Undo the last change</button></div>
      <div class="logbox" id="undo-log" style="margin-top:12px;display:none"></div>
    </div>` : ''}`);
  if (el('d-full')) el('d-full').onclick = () => deploy('full');
  if (el('d-cont')) el('d-cont').onclick = () => deploy('containers');
  if (el('d-undo')) el('d-undo').onclick = async () => {
    if (!confirm('Undo the last change and go back to the previous version?')) return;
    const log = el('undo-log'); log.style.display = 'block'; log.textContent = 'Undoing…';
    try {
      const { jobId } = await api('/api/client/ai/rollback', { method: 'POST' });
      const j = await pollJob('/api/client', jobId, x => { log.textContent = x.log || x.status; log.scrollTop = log.scrollHeight; });
      toast(j.ok ? '✅ Undone — previous version is being published.' : '✖ Could not undo.', j.ok ? 'good' : 'bad');
    } catch (e) { toast(e.message, 'bad'); }
  };
}
async function deploy(mode) {
  const log = el('log'); log.style.display = 'block'; log.textContent = 'Starting… (a backup is taken first)';
  document.querySelectorAll('#d-full,#d-cont').forEach(b => b.disabled = true);
  try {
    const { jobId } = await api('/api/client/deploy', { method: 'POST', body: { mode } });
    const j = await pollJob('/api/client', jobId, x => { log.textContent = x.log || x.status; log.scrollTop = log.scrollHeight; });
    toast(j.ok ? '✅ Done! Your site is updated.' : '✖ Something failed — your site was not changed.', j.ok ? 'good' : 'bad');
    ME = await api('/api/client/me');
  } catch (e) { toast(e.message, 'bad'); log.textContent += '\n✖ ' + e.message; }
  finally { document.querySelectorAll('#d-full,#d-cont').forEach(b => b.disabled = false); }
}

/* ================= BACKUPS ================= */
function renderBackups() {
  const p = ME.project;
  if (!p.hasBackups) { page(`<div class="card"><h3>💾 Backups</h3><div class="sub" style="margin-top:8px">Backups aren't set up for this project yet. Contact your provider.</div></div>`); return; }
  page(`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center"><h3>💾 Backups & undo</h3><button class="btn sm" id="bk-go">⟳ Show backups</button></div>
    <div class="sub">Something went wrong? Restore an earlier backup of your site.</div>
    <div id="bk-body" style="margin-top:12px"></div><div class="logbox" id="bk-log" style="margin-top:12px;display:none"></div></div>`);
  el('bk-go').onclick = loadBackups;
  loadBackups();
}
async function loadBackups() {
  el('bk-body').innerHTML = '<span class="faint">Loading…</span>';
  try {
    const items = await api('/api/client/backups');
    if (!items.length) { el('bk-body').innerHTML = emptyHint('No backups yet.'); return; }
    el('bk-body').innerHTML = `<table class="tbl"><tr><th>Backup</th><th>When</th><th></th></tr>${items.map(it => `<tr>
      <td class="mono">${esc(it.name)}</td><td class="faint">${esc(it.date)}</td>
      <td><button class="btn sm danger" data-f="${esc(it.name)}">Restore</button></td></tr>`).join('')}</table>`;
    el('bk-body').querySelectorAll('button[data-f]').forEach(btn => btn.onclick = () => rollback(btn.dataset.f));
  } catch (e) { el('bk-body').innerHTML = '<span class="muted">✖ ' + esc(e.message) + '</span>'; }
}
async function rollback(file) {
  if (!confirm('Restore ' + file + '? This replaces the current files on your site.')) return;
  const log = el('bk-log'); log.style.display = 'block'; log.textContent = 'Restoring…';
  try {
    const { jobId } = await api('/api/client/restore', { method: 'POST', body: { file } });
    const j = await pollJob('/api/client', jobId, x => { log.textContent = x.log; log.scrollTop = log.scrollHeight; });
    toast(j.ok ? 'Restored ✅' : 'Restore failed ✖', j.ok ? 'good' : 'bad');
  } catch (e) { toast(e.message, 'bad'); }
}

/* ================= ACTIVITY ================= */
function renderActivity() {
  page(`<div class="card"><h3>🕘 Recent activity</h3><div class="sep"></div>
    ${ME.history.length ? ME.history.map(h => `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line)">
      <span>${h.by === 'ai' ? '🤖 ' : h.by === 'client' ? '👤 ' : ''}${esc(h.label || h.mode)}</span>
      <span class="faint">${new Date(h.at).toLocaleString()} ${h.ok ? '✅' : '✖'}</span></div>`).join('') : emptyHint('Nothing yet.')}</div>`);
}

async function checkSite() {
  const dot = el('site-dot'); if (!dot) return;
  if (!ME.project.domains[0]) { dot.style.display = 'none'; return; }
  try {
    const r = await api('/api/client/http');
    dot.textContent = r.ok ? '🟢 online' : '🔴 offline';
    dot.className = 'badge ' + (r.ok ? 'ok' : 'off');
  } catch { dot.style.display = 'none'; }
}

(async function init() {
  try {
    const st = await api('/api/auth/state');
    if (!st.client) return location.href = '/';
    await load();
  } catch (e) { toast(e.message, 'bad'); }
})();
