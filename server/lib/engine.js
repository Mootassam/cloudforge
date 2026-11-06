'use strict';
// The work engine. Reuses the proven desktop modules in ../../src unchanged.
const { testConnection, runCommand } = require('../../src/ssh');
const { httpCheck, serverHealth, containerLogs } = require('../../src/monitor');
const { checkCert } = require('../../src/certs');
const { sendMessage } = require('../../src/telegram');
const jobs = require('./jobs');

/* ---- auto-build deploy commands from a stack preset (button/dropdown, no typing) ---- */
function defaultCmds(method, remotePath, containers, backupDir) {
  const cd = remotePath ? `cd "${remotePath}" && ` : '';
  const names = (containers || []).filter(Boolean).join(' ');
  const svc = names ? ' ' + names : '';
  const out = { deployFullCmd: '', deployContainersCmd: '', backupCmd: '', restoreCmd: '' };
  switch (method) {
    case 'compose-git':
      out.deployFullCmd = `${cd}git pull && docker compose up -d --build`;
      out.deployContainersCmd = `${cd}git pull && docker compose up -d --build${svc}`;
      break;
    case 'compose':
      out.deployFullCmd = `${cd}docker compose up -d --build`;
      out.deployContainersCmd = `${cd}docker compose up -d --build${svc}`;
      break;
    case 'pm2':
      out.deployFullCmd = `${cd}git pull && npm ci && npm run build && pm2 restart all`;
      out.deployContainersCmd = `${cd}git pull && npm ci && pm2 restart all`;
      break;
    default: // custom — leave blank, admin fills in
      break;
  }
  // buildCmd = rebuild FROM THE LOCAL FILES (no git pull) — installs any new
  // packages and rebuilds. Used when the AI applies edits made on the server.
  if (method === 'pm2') out.buildCmd = `${cd}npm install && npm run build && pm2 restart all`;
  else if (method === 'compose' || method === 'compose-git') out.buildCmd = `${cd}docker compose up -d --build`;
  if (backupDir) {
    // --exclude MUST come before "-C path ." or GNU tar ignores/erorrs on them
    out.backupCmd = `mkdir -p "${backupDir}" && tar --exclude=node_modules --exclude=.git --exclude='*.tgz' --exclude='*.tar.gz' -czf "${backupDir}/backup-$(date +%Y%m%d-%H%M%S).tgz" -C "${remotePath || '.'}" .`;
    out.restoreCmd = `tar -xzf "{file}" -C "${remotePath || '.'}"`;
  }
  return out;
}

async function notify(settings, text) {
  const tg = (settings && settings.telegram) || {};
  if (tg.botToken && tg.chatId) { try { await sendMessage(tg.botToken, tg.chatId, text); } catch {} }
}

// Run deploy (backup first, then the chosen command) on the CLIENT VPS.
async function deploy({ project, vps, mode, job, settings }) {
  const cmd = mode === 'containers' ? project.deployContainersCmd : project.deployFullCmd;
  const label = mode === 'containers' ? 'Deploy containers (backend + admin + server)' : 'Deploy full website';
  if (!cmd || !String(cmd).trim()) throw new Error(`No "${mode}" deploy command set for this project.`);

  job.status = 'running';
  const send = (t) => jobs.append(job, t);
  const steps = [];
  if (project.backupCmd && String(project.backupCmd).trim()) steps.push({ label: 'Backup first (safety)', cmd: project.backupCmd });
  steps.push({ label, cmd });

  let ok = true;
  for (const s of steps) {
    send(`\n$ ── ${s.label} ──`);
    const r = await runCommand(vps, s.cmd, send);
    if (r.code !== 0) { ok = false; send(`\n✖ "${s.label}" exited with code ${r.code}. Stopping.`); break; }
  }
  if (ok) send(`\n✔ Deploy finished successfully.`);
  jobs.finish(job, ok);
  if (!ok) await notify(settings, `🚨 <b>CloudForge</b> — deploy FAILED\nProject: <b>${project.name}</b>\n${label}`);
  return ok;
}

async function restore({ project, vps, file, job, settings }) {
  if (!project.restoreCmd || !String(project.restoreCmd).trim()) throw new Error('No restore command set for this project.');
  const dir = (project.backupDir || '').replace(/\/$/, '');
  const full = dir ? `${dir}/${file}` : file;
  const cmd = project.restoreCmd.replace(/{file}/g, full).replace(/{dir}/g, dir);
  job.status = 'running';
  const send = (t) => jobs.append(job, t);
  send(`\n$ Rolling back to ${file} …`);
  const r = await runCommand(vps, cmd, send);
  const ok = r.code === 0;
  send(ok ? `\n✔ Rollback finished.` : `\n✖ Rollback exited with code ${r.code}.`);
  jobs.finish(job, ok);
  if (!ok) await notify(settings, `🚨 <b>CloudForge</b> — rollback FAILED\nProject: <b>${project.name}</b>\nFile: ${file}`);
  return ok;
}

async function issueSsl({ project, vps, domain, job }) {
  if (!domain) throw new Error('No domain.');
  const email = project.sslEmail || '';
  const cmd = (project.sslCmd && String(project.sslCmd).trim())
    ? project.sslCmd.replace(/{domain}/g, domain).replace(/{email}/g, email)
    : `certbot --nginx --non-interactive --agree-tos ${email ? '-m ' + email : '--register-unsafely-without-email'} --redirect -d ${domain}`;
  job.status = 'running';
  const send = (t) => jobs.append(job, t);
  send(`\n$ Issuing SSL for ${domain} …`);
  const r = await runCommand(vps, cmd, send);
  const ok = r.code === 0;
  send(ok ? `\n✔ SSL command finished.` : `\n✖ SSL command exited with code ${r.code}.`);
  jobs.finish(job, ok);
  return ok;
}

async function listBackups(vps, dir) {
  if (!dir || !String(dir).trim()) throw new Error('No backup folder set for this project.');
  const r = await runCommand(vps, `ls -lt --time-style=+%Y-%m-%d_%H:%M "${dir}" 2>/dev/null | grep -iE '\\.(tgz|tar\\.gz|zip|sql|gz)$'`);
  const items = [];
  (r.stdout || '').split('\n').forEach(line => {
    const p = line.trim().split(/\s+/);
    if (p.length >= 7) items.push({ size: p[4], date: p[5], name: p.slice(6).join(' ') });
  });
  return items;
}

module.exports = {
  defaultCmds, deploy, restore, issueSsl, listBackups, notify,
  testConnection, httpCheck, serverHealth, containerLogs, checkCert
};
