'use strict';
// A local working copy of a customer's GitHub repo on the brain. The AI reads,
// searches, and edits files here (plain local filesystem — fast, and find_text
// is a real local search), then we commit + push back to GitHub. No files touch
// the customer VPS during editing; GitHub is the source of truth.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const github = require('./github');

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'vendor', 'build', '.cache', '.turbo']);

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// keep a relative path inside the working copy
function safeRel(p) {
  let s = String(p || '').trim().replace(/^\.\//, '').replace(/^[\\/]+/, '');
  if (!s || /[`"'\n\r]/.test(s) || s.split(/[\\/]/).some(seg => seg === '..')) throw new Error('Unsafe path: ' + p);
  return s;
}

// Make the working copy match GitHub exactly (clone first time, then hard-reset).
async function sync({ dir, repo, branch, token }) {
  const b = branch || 'main';
  const url = github.authRemoteUrl(repo, token);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      let r = await git(['clone', '--depth', '1', '--branch', b, url, '.'], dir);
      if (r.code !== 0) { // branch may not exist yet → clone default branch
        r = await git(['clone', '--depth', '1', url, '.'], dir);
        if (r.code !== 0) return { ok: false, error: github.redact(r.stderr) || 'Could not clone the repo.' };
      }
    } else {
      await git(['remote', 'set-url', 'origin', url], dir);
      const f = await git(['fetch', '--depth', '1', 'origin', b], dir);
      if (f.code === 0) {
        const co = await git(['checkout', b], dir);
        if (co.code !== 0) await git(['checkout', '-B', b, 'origin/' + b], dir);
        await git(['reset', '--hard', 'origin/' + b], dir);
      }
      await git(['clean', '-fd'], dir);
    }
    return { ok: true, branch: b };
  } catch (e) { return { ok: false, error: github.redact(e.message || String(e)) }; }
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (out.length < 400) walk(abs, r); }
      else if (e.isFile()) { if (out.length < 400) out.push(r); }
    }
  })(dir, '');
  return out;
}

function readFile(dir, rel) {
  const p = path.join(dir, safeRel(rel));
  try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
  return fs.readFileSync(p, 'utf8').slice(0, 60000);
}

function findText(dir, query) {
  const q = String(query || '');
  if (!q) return [];
  const hits = [];
  for (const f of listFiles(dir)) {
    let txt; try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (txt.indexOf(q) === -1) continue;
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(q)) { hits.push(f + ':' + (i + 1) + ':' + lines[i].trim().slice(0, 160)); if (hits.length >= 40) return hits; }
    }
  }
  return hits;
}

function writeFile(dir, rel, content) {
  const p = path.join(dir, safeRel(rel));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content == null ? '' : content), 'utf8');
}

async function commitPush({ dir, repo, branch, token, message }) {
  const b = branch || 'main';
  await git(['remote', 'set-url', 'origin', github.authRemoteUrl(repo, token)], dir);
  await git(['add', '-A'], dir);
  const status = await git(['status', '--porcelain'], dir);
  if (!status.stdout.trim()) return { ok: true, pushed: false, note: 'No changes to commit.' };
  const c = await git(['-c', 'user.email=cloudforge@local', '-c', 'user.name=CloudForge', 'commit', '-m', message || 'Update from CloudForge'], dir);
  if (c.code !== 0) return { ok: false, error: github.redact(c.stderr) || 'Commit failed.' };
  const p = await git(['push', 'origin', 'HEAD:' + b], dir);
  if (p.code !== 0) return { ok: false, error: github.redact(p.stderr) || 'Push failed — check the token can push to this repo.' };
  return { ok: true, pushed: true };
}

// Undo the most recent change: revert the last commit (keeps full history) and
// push. GitHub's build/deploy then publishes the previous version.
async function revertLast({ dir, repo, branch, token }) {
  const b = branch || 'main';
  try {
    await git(['remote', 'set-url', 'origin', github.authRemoteUrl(repo, token)], dir);
    await git(['fetch', '--depth', '5', 'origin', b], dir);
    await git(['checkout', '-B', b, 'origin/' + b], dir);
    await git(['reset', '--hard', 'origin/' + b], dir);
    const cnt = await git(['rev-list', '--count', 'HEAD'], dir);
    if (parseInt((cnt.stdout || '0').trim(), 10) < 2) return { ok: false, error: 'Nothing to undo yet — there’s only the first version.' };
    const r = await git(['-c', 'user.email=cloudforge@local', '-c', 'user.name=CloudForge', 'revert', '--no-edit', 'HEAD'], dir);
    if (r.code !== 0) return { ok: false, error: github.redact(r.stderr) || 'Could not undo the last change.' };
    const p = await git(['push', 'origin', 'HEAD:' + b], dir);
    if (p.code !== 0) return { ok: false, error: github.redact(p.stderr) || 'Undo push failed.' };
    return { ok: true };
  } catch (e) { return { ok: false, error: github.redact(e.message || String(e)) }; }
}

module.exports = { sync, listFiles, readFile, findText, writeFile, commitPush, revertLast, safeRel };
