// tiny shared helpers
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await fetch(path, init);
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
  return data;
}
function toast(msg, kind) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4200);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function el(id) { return document.getElementById(id); }
function emptyHint(html) { return `<div class="faint" style="padding:18px 0">${html}</div>`; }

// poll a job until it finishes; onLine(fullLogText), returns the final job
async function pollJob(base, jobId, onUpdate) {
  for (;;) {
    const j = await api(`${base}/jobs/${jobId}`);
    if (onUpdate) onUpdate(j);
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise(r => setTimeout(r, 900));
  }
}
