'use strict';
// Server explorer — lets the owner BROWSE a VPS instead of typing paths:
// list folders (navigate in/out), detect the stack (compose/git/node/Dockerfile),
// and list Docker containers. All read-only.
const { runCommand } = require('../../src/ssh');

// strip anything that could break out of the quoted path (owner is trusted,
// but we stay safe anyway)
function safePath(p) {
  return String(p || '').replace(/[\n\r"`$;|&<>]/g, '').trim();
}
function section(out, name) {
  const m = out.match(new RegExp('===' + name + '===\\n([\\s\\S]*?)(?=\\n===|$)'));
  return m ? m[1] : '';
}

// Browse one folder. path '' / '~' means the SSH user's home.
async function browse(vps, path) {
  const P = safePath(path);
  const cmd =
    `P="${P}"; cd "\${P:-$HOME}" 2>/dev/null || { echo '===ERR==='; echo 'Cannot open this folder'; exit 0; }; ` +
    `echo '===PWD==='; pwd; ` +
    `echo '===ENTRIES==='; ls -1Ap 2>/dev/null; ` +
    `echo '===FLAGS==='; ` +
    `for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f "$f" ] && { echo compose; break; }; done; ` +
    `[ -d .git ] && echo git; [ -f package.json ] && echo node; [ -f Dockerfile ] && echo docker; true`;
  const r = await runCommand(vps, cmd);
  const out = r.stdout || '';
  if (section(out, 'ERR')) return { ok: false, error: section(out, 'ERR').trim() || 'Cannot open this folder', path: P };
  const pwd = section(out, 'PWD').trim();
  const entries = section(out, 'ENTRIES').split('\n').map(s => s.trim()).filter(Boolean);
  const dirs = [], files = [];
  entries.forEach(e => { if (e.endsWith('/')) dirs.push(e.slice(0, -1)); else files.push(e); });
  const flags = section(out, 'FLAGS').split('\n').map(s => s.trim()).filter(Boolean);
  return {
    ok: true, path: pwd, parent: pwd === '/' ? null : (pwd.replace(/\/[^/]+\/?$/, '') || '/'),
    dirs: dirs.sort((a, b) => a.localeCompare(b)),
    files: files.sort((a, b) => a.localeCompare(b)),
    flags: { compose: flags.includes('compose'), git: flags.includes('git'), node: flags.includes('node'), docker: flags.includes('docker') }
  };
}

async function containers(vps) {
  const cmd =
    `command -v docker >/dev/null 2>&1 || { echo '===NODOCKER==='; exit 0; }; ` +
    `docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null; true`;
  const r = await runCommand(vps, cmd);
  const out = r.stdout || '';
  if (out.includes('===NODOCKER===')) return { ok: true, dockerMissing: true, items: [] };
  const items = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [name, state, status, image] = l.split('|');
    return { name, state: state || '', status: status || '', image: image || '', up: /running|^up/i.test((state || '') + (status || '')) };
  });
  return { ok: true, dockerMissing: false, items };
}

module.exports = { browse, containers };
