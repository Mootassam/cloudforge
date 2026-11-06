'use strict';
// EDIT TARGETS — figure out WHAT a customer has and WHERE to open it.
//
// The customer is not technical and must never paste a URL. So we read their
// docker-compose over SSH and work out which services are their public Website,
// which is the Admin Panel, which is the backend/API, and which is the database.
// We turn that into simple buttons ("Edit my Website", "Edit my Admin Panel")
// each pointing at a real address:
//   • a service that PUBLISHES a port  → http://<their-vps>:<port>
//   • the public site is often NOT a published port (it sits behind a domain
//     via a reverse proxy) → we use the project's domain → https://<domain>
// The database/backend are never offered as "edit here" targets (nothing to
// click on), but we still report them so the owner sees the full picture.
const { runCommand } = require('../../src/ssh');

const DB_IMG = /(^|[^a-z])(mongo|mongodb|postgres|postgresql|mysql|mariadb|redis|memcached|rabbitmq|elasticsearch|clickhouse)([^a-z]|$)/i;

// Decide what a service IS from its name + image.
function classify(name, image) {
  const s = (String(name || '') + ' ' + String(image || '')).toLowerCase();
  if (DB_IMG.test(s)) return 'database';
  if (/\b(admin|panel|dashboard|backoffice|back-office|cms|manage)\b/.test(s)) return 'admin';
  if (/\b(front|frontend|web|website|platform|client|storefront|shop|site|public|landing|nginx|ui|vue|next|react)\b/.test(s)) return 'platform';
  if (/\b(api|backend|server|worker|service|graphql|gateway|php|django|rails|express)\b/.test(s)) return 'backend';
  return 'service';
}

// Host ports a compose service publishes (both the JSON object form and the
// short "8080:80" / "127.0.0.1:8080:80" string form). A bare "80" is only a
// container port (not reachable from outside) → ignored.
function hostPorts(svc) {
  const out = [];
  const ports = svc && svc.ports;
  if (!Array.isArray(ports)) return out;
  for (const p of ports) {
    if (p == null) continue;
    if (typeof p === 'object') {
      if (p.published != null && String(p.published) !== '') out.push(String(p.published).split('/')[0]);
    } else {
      const str = String(p).replace(/\/(tcp|udp)$/i, '');
      const parts = str.split(':');
      if (parts.length >= 2) out.push(parts[parts.length - 2]); // host side of host:container
    }
  }
  return [...new Set(out.filter(Boolean))];
}

// `docker compose config --format json` → normalized services[]
function parseComposeJson(text) {
  const cfg = JSON.parse(text);
  const svcs = (cfg && cfg.services) || {};
  return Object.keys(svcs).map(name => {
    const s = svcs[name] || {};
    return { name, image: s.image || '', ports: hostPorts(s) };
  });
}

// Build the clickable edit targets. Pure function → easy to unit-test.
function buildTargets({ services = [], domain = '', host = '' }) {
  const summary = services.map(s => ({ name: s.name, image: s.image, kind: classify(s.name, s.image), ports: s.ports || [] }));
  const targets = [];
  const seen = new Set();
  const add = (t) => { if (t.baseUrl && !seen.has(t.baseUrl)) { seen.add(t.baseUrl); targets.push(t); } };

  // 1) the public website — usually behind a domain, not a published port
  const dom = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (dom) add({ id: 'platform-domain', kind: 'platform', label: 'Your Website (live)', baseUrl: 'https://' + dom, source: 'domain' });

  // 2) services that publish a port AND are a website or admin panel → openable
  for (const s of summary) {
    if (s.kind !== 'admin' && s.kind !== 'platform') continue;
    for (const port of s.ports) {
      if (!host) continue;
      const label = s.kind === 'admin' ? 'Admin Panel' : 'Website';
      add({ id: `${s.name}-${port}`, kind: s.kind, label: `${label} (${s.name})`, baseUrl: `http://${host}:${port}`, source: 'port', service: s.name, port });
    }
  }

  return {
    targets,
    services: summary,
    has: {
      platform: summary.some(s => s.kind === 'platform'),
      admin: summary.some(s => s.kind === 'admin'),
      backend: summary.some(s => s.kind === 'backend'),
      database: summary.some(s => s.kind === 'database')
    }
  };
}

// Hostnames the server-browser is allowed to open for this customer — their VPS
// IP and their domain(s) only. Everything else is blocked (anti-abuse).
function allowedHosts(targets) {
  const hosts = new Set();
  for (const t of targets) {
    try { hosts.add(new URL(t.baseUrl).hostname); } catch { /* skip */ }
  }
  return [...hosts];
}

// Published host ports from a `docker ps` Ports column, e.g.
// "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 3000/tcp" → ["8080"] (3000 is not published).
function parseDockerPorts(portsStr) {
  const out = new Set();
  const s = String(portsStr || '');
  let m; const re = /:(\d+)->/g;
  while ((m = re.exec(s))) out.add(m[1]);
  return [...out];
}

// Scan EVERY running container on the server (not just this project's compose),
// so a SECOND app in another folder / standalone containers still show up.
async function hostScan(vps) {
  const host = (vps && vps.host) || '';
  let items = [];
  try {
    const r = await runCommand(vps, `docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null; true`);
    items = (r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [name, image, ports] = l.split('|');
      return { name: name || '', image: image || '', kind: classify(name, image), ports: parseDockerPorts(ports) };
    });
  } catch { /* docker missing / unreachable */ }
  const suggestions = [];
  const seen = new Set();
  for (const c of items) {
    if (c.kind === 'database') continue;        // nothing to open on a DB
    for (const port of c.ports) {
      const url = `http://${host}:${port}`;
      if (!host || seen.has(url)) continue; seen.add(url);
      suggestions.push({
        label: c.kind === 'admin' ? 'Admin Panel' : c.kind === 'platform' ? 'Website' : c.name,
        kind: c.kind === 'admin' ? 'admin' : c.kind === 'platform' ? 'website' : 'other',
        url, service: c.name
      });
    }
  }
  return { suggestions, containers: items };
}

// Owner-defined pages: the reliable source. The owner labels each page once in
// the admin panel (name + website/admin + its URL), so the customer always sees
// clear names regardless of how the docker-compose services are named.
function fromOwner(editTargets) {
  const targets = (editTargets || []).filter(t => t && t.url).map(t => ({
    id: t.id, label: t.label || t.url, kind: t.kind || 'website',
    baseUrl: String(t.url).replace(/\/+$/, ''), source: 'owner'
  }));
  return { targets, allowedHosts: allowedHosts(targets) };
}

// Validate + normalize one owner page entry (used when saving from the admin UI).
function cleanTarget(t) {
  const url = String((t && t.url) || '').trim();
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const kind = ['website', 'admin', 'other'].includes(t && t.kind) ? t.kind : 'website';
  const label = (String((t && t.label) || '').trim().slice(0, 60)) || (kind === 'admin' ? 'Admin Panel' : 'Website');
  return { label, kind, url: url.replace(/\/+$/, '') };
}

// Read the compose on the client VPS and build the targets.
async function analyze(vps, project) {
  const root = project && project.remotePath;
  if (!root) return { ok: false, error: 'This project has no project folder set yet.' };
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = `cd ${q(root)} 2>/dev/null && (docker compose config --format json 2>/dev/null || docker-compose config --format json 2>/dev/null); echo '__CF_END__'`;

  let services = [];
  let parsedPorts = false, note = '';
  try {
    const r = await runCommand(vps, cmd);
    const text = (r.stdout || '').split('__CF_END__')[0].trim();
    if (text && text.startsWith('{')) { services = parseComposeJson(text); parsedPorts = true; }
  } catch (e) { note = e.message; }

  if (!parsedPorts) {
    // fallback: at least the service names, so the owner still sees what exists
    try {
      const r2 = await runCommand(vps, `cd ${q(root)} && (docker compose config --services 2>/dev/null || docker-compose config --services 2>/dev/null)`);
      services = (r2.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, image: '', ports: [] }));
      if (services.length) note = 'Could not read ports from the compose file — showing service names only.';
    } catch (e) { if (!note) note = e.message; }
  }

  const host = (vps && vps.host) || '';
  const domain = (project.domains && project.domains[0]) || project.domain || '';
  const built = buildTargets({ services, domain, host });
  built.allowedHosts = allowedHosts(built.targets);
  return { ok: true, parsedPorts, note, ...built };
}

module.exports = { classify, hostPorts, parseDockerPorts, parseComposeJson, buildTargets, allowedHosts, analyze, hostScan, fromOwner, cleanTarget };
