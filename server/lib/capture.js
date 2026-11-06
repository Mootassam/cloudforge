'use strict';
// SERVER-BROWSER — we run a real browser for the customer so they can point at
// the exact page and the exact element they want changed, WITHOUT pasting any
// URL and WITHOUT the cross-domain limits of an <iframe>. The customer sees live
// screenshots and clicks on them; because the browser is ours we always know the
// real URL and can read the element they clicked. They can only ever open THEIR
// OWN app addresses (allowHosts) — anything else is blocked (anti-abuse).
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch { /* reported at use */ }

const VIEW = { width: 1536, height: 864 }; // 16:9 — matches typical screens, fills the space
const MAX_SESSIONS = 2;                 // keep a weak host happy
const IDLE_MS = 5 * 60 * 1000;          // close an idle browser after 5 min

const sessions = new Map();             // id -> session
let reaper = null;

function rid() { return 'cap_' + Math.random().toString(36).slice(2, 10); }

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > IDLE_MS) closeSession(id).catch(() => {});
  }, 60 * 1000);
  if (reaper.unref) reaper.unref();
}

async function launch() {
  if (!chromium) throw new Error('The in-app browser engine is not installed (playwright-core).');
  // use the browser already on the machine — no heavy download
  const tries = [
    { channel: 'msedge' }, { channel: 'chrome' }, {}
  ];
  let lastErr;
  for (const opt of tries) {
    try { return await chromium.launch({ headless: true, args: ['--no-sandbox'], ...opt }); }
    catch (e) { lastErr = e; }
  }
  throw new Error('Could not start the in-app browser: ' + (lastErr && lastErr.message ? lastErr.message.split('\n')[0] : 'unknown'));
}

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function allowed(url, allowHosts) {
  const h = hostOf(url);
  if (!h) return false;
  if (!allowHosts || !allowHosts.length) return true; // no list → caller already trusts baseUrl
  return allowHosts.includes(h);
}

// read the element at a point, in the page
const PICK_FN = `(function(px,py){
  var e=document.elementFromPoint(px,py); if(!e) return null;
  function sel(n){ var p=[]; while(n && n.nodeType===1 && p.length<4){ var s=n.tagName.toLowerCase();
    if(n.id){ s+='#'+n.id; p.unshift(s); break; }
    if(n.className && typeof n.className==='string'){ var c=n.className.trim().split(/\\s+/)[0]; if(c) s+='.'+c; }
    var par=n.parentNode, i=1, sib=n; if(par){ while((sib=sib.previousElementSibling)) if(sib.tagName===n.tagName) i++; if(i>1) s+=':nth-of-type('+i+')'; }
    p.unshift(s); n=par; } return p.join(' > '); }
  var r=e.getBoundingClientRect();
  return { tag:e.tagName.toLowerCase(), id:e.id||'', cls:(typeof e.className==='string'?e.className:'')||'',
    name:e.getAttribute&&e.getAttribute('name')||'', placeholder:e.getAttribute&&e.getAttribute('placeholder')||'',
    href:e.getAttribute&&e.getAttribute('href')||'', type:e.getAttribute&&e.getAttribute('type')||'',
    text:(e.innerText||e.textContent||'').trim().slice(0,160), selector:sel(e),
    html:(e.outerHTML||'').slice(0,500), rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)} };
})`;

// Wait for the page to actually paint before we screenshot it — SPAs (React/Vue)
// render AFTER domcontentloaded, so capturing too early showed a white page.
async function settle(page) {
  await page.waitForLoadState('load', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  // give client-side frameworks a moment to draw their first content
  await page.waitForFunction(() => {
    const b = document.body;
    return b && (b.innerText.trim().length > 0 || b.querySelectorAll('img,canvas,svg,input,button').length > 0);
  }, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function shot(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    screenshot: 'data:image/jpeg;base64,' + buf.toString('base64'),
    viewport: VIEW
  };
}

// map a click on the displayed image (size dispW×dispH) to real viewport coords
function toViewport(x, y, dispW, dispH) {
  const sx = dispW ? VIEW.width / dispW : 1;
  const sy = dispH ? VIEW.height / dispH : 1;
  return { vx: Math.max(0, Math.min(VIEW.width - 1, Math.round(x * sx))), vy: Math.max(0, Math.min(VIEW.height - 1, Math.round(y * sy))) };
}

async function openSession({ ownerProjectId, baseUrl, allowHosts }) {
  if (sessions.size >= MAX_SESSIONS) {
    // evict the oldest idle one to make room
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) await closeSession(oldest[0]).catch(() => {});
  }
  if (!allowed(baseUrl, allowHosts)) throw new Error('That address is not allowed for this project.');
  const browser = await launch();
  const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(25000);
  try { await page.goto(baseUrl, { waitUntil: 'commit' }); }
  catch (e) { await browser.close().catch(() => {}); throw new Error('Could not open your page: ' + e.message.split('\n')[0]); }
  await settle(page);
  const id = rid();
  sessions.set(id, { id, browser, context, page, ownerProjectId, allowHosts, baseUrl, lastUsed: Date.now(), lastElement: null });
  startReaper();
  return { sessionId: id, ...(await shot(page)) };
}

function get(id, ownerProjectId) {
  const s = sessions.get(id);
  if (!s || s.ownerProjectId !== ownerProjectId) return null;
  s.lastUsed = Date.now();
  return s;
}

async function enforceHost(s) {
  // if a click navigated off the customer's own hosts, go back and flag it
  if (!allowed(s.page.url(), s.allowHosts)) {
    try { await s.page.goBack({ waitUntil: 'domcontentloaded' }); } catch { /* ignore */ }
    return true;
  }
  return false;
}

// POINT ONLY — read the element at a spot, no clicking (final "this is the spot")
async function point(s, x, y, dispW, dispH) {
  const { vx, vy } = toViewport(x, y, dispW, dispH);
  const el = await s.page.evaluate(PICK_FN + `(${vx},${vy})`).catch(() => null);
  s.lastElement = el;
  return { element: el, ...(await shot(s.page)) };
}

// CLICK — move through the app (and remember what was clicked)
async function click(s, x, y, dispW, dispH) {
  const { vx, vy } = toViewport(x, y, dispW, dispH);
  const el = await s.page.evaluate(PICK_FN + `(${vx},${vy})`).catch(() => null);
  s.lastElement = el;
  try {
    await Promise.all([
      s.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {}),
      s.page.mouse.click(vx, vy)
    ]);
    await settle(s.page);
  } catch { /* click of a non-navigating element is fine */ }
  const blocked = await enforceHost(s);
  return { element: el, blocked, ...(await shot(s.page)) };
}

async function type(s, text) {
  await s.page.keyboard.type(String(text || ''), { delay: 15 });
  return shot(s.page);
}
async function press(s, key) {
  await s.page.keyboard.press(String(key || 'Enter'));
  await settle(s.page);
  await enforceHost(s);
  return shot(s.page);
}
async function back(s) {
  try { await s.page.goBack({ waitUntil: 'commit' }); await settle(s.page); } catch { /* ignore */ }
  return shot(s.page);
}
async function reload(s) {
  try { await s.page.reload({ waitUntil: 'commit' }); await settle(s.page); } catch { /* ignore */ }
  return shot(s.page);
}

// list the fillable form fields on the current page (for the Type / Log in modal)
const FIELDS_FN = `(function(){
  var list=[].slice.call(document.querySelectorAll('input,textarea'));
  return list.map(function(e,i){
    if(e.type==='hidden'||e.type==='submit'||e.type==='button'||e.type==='image') return null;
    var r=e.getBoundingClientRect(); if(r.width<2||r.height<2) return null;
    var label='';
    try{ if(e.id){ var l=document.querySelector('label[for="'+(window.CSS&&CSS.escape?CSS.escape(e.id):e.id)+'"]'); if(l) label=(l.innerText||'').trim(); } }catch(_){}
    if(!label && e.getAttribute('aria-label')) label=e.getAttribute('aria-label');
    if(!label && e.placeholder) label=e.placeholder;
    if(!label && e.name) label=e.name;
    var isPw=e.type==='password';
    return { i:i, type:(e.type||'text'), label:(label||('Field '+(i+1))).slice(0,48), isPassword:isPw, value:isPw?'':((e.value||'').slice(0,160)) };
  }).filter(Boolean);
})()`;

async function fields(s) {
  const list = await s.page.evaluate(FIELDS_FN).catch(() => []);
  return { fields: list || [], ...(await shot(s.page)) };
}

// fill one field by its DOM index (Playwright handles React/Vue inputs properly)
async function fill(s, index, value) {
  const i = Number(index) || 0, v = String(value == null ? '' : value);
  try { await s.page.locator('input, textarea').nth(i).fill(v, { timeout: 5000 }); }
  catch {
    await s.page.evaluate(({ i, v }) => {
      const el = document.querySelectorAll('input,textarea')[i];
      if (el) { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { i, v }).catch(() => {});
  }
  return shot(s.page);
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.browser.close(); } catch { /* ignore */ }
}

function available() { return !!chromium; }

module.exports = { openSession, get, point, click, type, press, back, reload, fields, fill, closeSession, available, _sessions: sessions };
