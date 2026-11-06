'use strict';
const db = require('./db');

function today() { return new Date().toISOString().slice(0, 10); }

// Reset a project's daily deploy counter if the day rolled over.
function usageToday(p) {
  if (!p.usage || p.usage.day !== today()) return { day: today(), count: 0 };
  return p.usage;
}

// Safe project view — NEVER includes the key hash or secrets.
function projectPublic(p, data) {
  const cs = (data.clientServers || []).find(s => s.id === p.clientServerId);
  const u = usageToday(p);
  return {
    id: p.id, name: p.name, customer: p.customer || '',
    sourcePath: p.sourcePath || '',
    clientServerId: p.clientServerId || null,
    clientServerName: cs ? cs.name : null,
    clientServerHost: cs ? cs.vps.host : null,
    remotePath: p.remotePath || '',
    containers: p.containers || [],
    domains: p.domains || [],
    deployMethod: p.deployMethod || 'compose-git',
    deployFullCmd: p.deployFullCmd || '',
    deployContainersCmd: p.deployContainersCmd || '',
    buildCmd: p.buildCmd || '',
    buildScript: p.buildScript || 'build',
    backupCmd: p.backupCmd || '', restoreCmd: p.restoreCmd || '',
    backupDir: p.backupDir || '', sslEmail: p.sslEmail || '', sslCmd: p.sslCmd || '',
    rules: p.rules || '',
    github: p.github || { repo: '', branch: 'main' },
    editTargets: p.editTargets || [],
    disabled: !!p.disabled,
    accessKeyHint: p.accessKeyHint || null,
    usageLimit: p.usageLimit || 0,
    usageToday: u.count,
    createdAt: p.createdAt
  };
}

// Decrypted client VPS for a project, ready for src/ssh.js.
function resolveClientVps(p, data) {
  const cs = (data.clientServers || []).find(s => s.id === p.clientServerId);
  if (!cs) throw new Error('This project is not linked to a client VPS yet. Edit the project and pick one.');
  return db.decVps(cs.vps);
}

module.exports = { today, usageToday, projectPublic, resolveClientVps };
