'use strict';
// Live monitoring & health for a project's VPS.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { runCommand } = require('./ssh');

// Is the public site up? (any non-5xx answer counts as up)
function httpCheck(target, timeout = 10000) {
  return new Promise((resolve) => {
    if (!target) return resolve({ ok: false, status: 0, ms: 0, error: 'No domain' });
    let urlStr = String(target).trim();
    if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, status: 0, ms: 0, error: 'Bad URL' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const start = Date.now();
    const req = lib.request(u, { method: 'GET', timeout, rejectUnauthorized: false }, (res) => {
      const ms = Date.now() - start;
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode, ms, url: urlStr });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - start, error: 'Timeout', url: urlStr }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - start, error: e.message, url: urlStr }));
    req.end();
  });
}

function section(out, name) {
  const m = out.match(new RegExp('===' + name + '===\\n([\\s\\S]*?)(?=\\n===|$)'));
  return m ? m[1].trim() : '';
}

function parseHealth(out) {
  const h = { raw: out, containers: [] };
  h.uptime = section(out, 'UPTIME');

  const memLine = (section(out, 'MEM').split('\n')[0] || '').trim().split(/\s+/);
  if (/mem/i.test(memLine[0] || '') && memLine[1]) {
    h.memTotal = +memLine[1]; h.memUsed = +memLine[2];
    h.memPct = h.memTotal ? Math.round(h.memUsed / h.memTotal * 100) : null;
  }

  const disk = (section(out, 'DISK').split('\n')[0] || '').trim().split(/\s+/);
  if (disk.length >= 5) { h.diskTotalKb = +disk[1]; h.diskUsedKb = +disk[2]; h.diskPct = parseInt(disk[4]); }

  const cpu = section(out, 'CPU').split('\n').map(s => s.trim()).filter(Boolean);
  if (cpu[0]) h.cores = +cpu[0];
  if (cpu[1]) { h.load1 = parseFloat(cpu[1].split(/\s+/)[0]); h.cpuPct = h.cores ? Math.min(100, Math.round(h.load1 / h.cores * 100)) : null; }

  const dock = section(out, 'DOCKER');
  if (dock && !/no-docker/.test(dock)) {
    dock.split('\n').forEach(l => {
      const [n, s] = l.split('|');
      if (n && n.trim()) h.containers.push({ name: n.trim(), status: (s || '').trim(), up: /^Up/i.test((s || '').trim()) });
    });
  } else h.dockerMissing = true;
  return h;
}

async function serverHealth(vps) {
  const cmd = [
    'echo "===UPTIME==="; uptime',
    'echo "===MEM==="; free -m | grep -i "^Mem:"',
    'echo "===DISK==="; df -P / | tail -1',
    'echo "===CPU==="; nproc; cat /proc/loadavg',
    'echo "===DOCKER==="; docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null || echo no-docker'
  ].join('; ');
  const r = await runCommand(vps, cmd);
  return parseHealth(r.stdout || '');
}

function containerLogs(vps, container, lines = 150) {
  const safe = String(container).replace(/[^a-zA-Z0-9_.\-]/g, '');
  const n = Number(lines) || 150;
  return runCommand(vps, `docker logs --tail ${n} ${safe} 2>&1 | tail -n ${n}`);
}

module.exports = { httpCheck, serverHealth, containerLogs, parseHealth };
