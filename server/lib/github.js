'use strict';
// GitHub integration — lets CloudForge use GitHub as the code store instead of
// a source VPS. Step 1: connect + verify. The token is stored encrypted and
// stays server-side (customers never see it). Later steps use this to clone,
// commit, push, and trigger builds/deploys.
//
// Uses the GitHub REST API over HTTPS (Node 18+ global fetch) — no git binary
// needed just to connect and verify.
const API = 'https://api.github.com';

// Accept "owner/name", a browser URL, or an SSH URL → { owner, name }.
function parseRepo(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/\.git$/i, '');
  // https://github.com/owner/name  or  git@github.com:owner/name
  let m = s.match(/github\.com[/:]+([^/]+)\/([^/]+)/i);
  if (!m) m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/); // bare owner/name
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

// Build an HTTPS remote that carries the token (used later for git push). Never
// log this — use redact() on anything that might contain it.
function authRemoteUrl(repo, token) {
  const r = typeof repo === 'string' ? parseRepo(repo) : repo;
  if (!r) throw new Error('Invalid repository.');
  return `https://x-access-token:${token}@github.com/${r.owner}/${r.name}.git`;
}

// Strip any token from a string before it goes to a log or the UI.
function redact(str) {
  return String(str == null ? '' : str).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***');
}

async function ghFetch(token, path) {
  const res = await fetch(API + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CloudForge'
    }
  });
  let body = null; try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

// Is the token valid? → { ok, login } or { ok:false, error }
async function checkToken(token) {
  if (!token) return { ok: false, error: 'No GitHub token saved yet.' };
  try {
    const r = await ghFetch(token, '/user');
    if (r.status === 200 && r.body) return { ok: true, login: r.body.login };
    if (r.status === 401) return { ok: false, error: 'The GitHub token is invalid or expired.' };
    return { ok: false, error: 'GitHub said: ' + (r.body && r.body.message ? r.body.message : 'HTTP ' + r.status) };
  } catch (e) { return { ok: false, error: 'Could not reach GitHub: ' + (e.message || e) }; }
}

// Can we reach this specific repo with this token? → { ok, private, defaultBranch, canPush }
async function testRepo(token, repoInput) {
  const repo = parseRepo(repoInput);
  if (!repo) return { ok: false, error: 'That doesn’t look like a repo. Use the form owner/name.' };
  if (!token) return { ok: false, error: 'Connect a GitHub token first.' };
  try {
    const r = await ghFetch(token, `/repos/${repo.owner}/${repo.name}`);
    if (r.status === 200 && r.body) {
      const canPush = !!(r.body.permissions && (r.body.permissions.push || r.body.permissions.admin));
      return { ok: true, fullName: r.body.full_name, private: !!r.body.private, defaultBranch: r.body.default_branch || 'main', canPush };
    }
    if (r.status === 404) return { ok: false, error: 'Repo not found, or your token can’t access it. Check the name and the token’s access.' };
    if (r.status === 401) return { ok: false, error: 'The GitHub token is invalid or expired.' };
    return { ok: false, error: 'GitHub said: ' + (r.body && r.body.message ? r.body.message : 'HTTP ' + r.status) };
  } catch (e) { return { ok: false, error: 'Could not reach GitHub: ' + (e.message || e) }; }
}

module.exports = { parseRepo, authRemoteUrl, redact, checkToken, testRepo };
