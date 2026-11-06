'use strict';
// In-memory job tracker. A long task (deploy, upload, restore, SSL) becomes a
// job with a growing log; the browser polls GET /api/jobs/:id to show progress.
// Works over plain HTTP — no websockets needed, robust across reconnects.
const crypto = require('crypto');

const JOBS = new Map();
const MAX_LINES = 2000;
const TTL_MS = 60 * 60 * 1000; // keep finished jobs 1h

function create(meta = {}) {
  const id = 'job_' + crypto.randomBytes(8).toString('hex');
  const job = {
    id, ...meta,
    status: 'queued',            // queued -> running -> done | failed
    ok: null,
    log: [],
    startedAt: Date.now(),
    finishedAt: null
  };
  JOBS.set(id, job);
  return job;
}

function append(job, text) {
  if (!job) return;
  String(text).split(/\r?\n/).forEach(line => {
    job.log.push(line);
  });
  if (job.log.length > MAX_LINES) job.log.splice(0, job.log.length - MAX_LINES);
}

function finish(job, ok) {
  if (!job) return;
  job.status = ok ? 'done' : 'failed';
  job.ok = ok;
  job.finishedAt = Date.now();
  sweep();
}

function get(id) { return JOBS.get(id) || null; }

// public view for a specific owner (projectId) — hides other projects' jobs
function view(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, ok: job.ok,
    label: job.label, mode: job.mode, projectId: job.projectId,
    log: job.log.join('\n'),
    result: job.result || null,
    startedAt: job.startedAt, finishedAt: job.finishedAt
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    if (j.finishedAt && now - j.finishedAt > TTL_MS) JOBS.delete(id);
  }
}

module.exports = { create, append, finish, get, view };
