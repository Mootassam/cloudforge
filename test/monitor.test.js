'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseHealth } = require('../src/monitor');

test('parseHealth reads cpu/mem/disk/containers from combined output', () => {
  const out = [
    '===UPTIME===',
    ' 12:00:00 up 3 days,  2:11,  1 user,  load average: 0.50, 0.40, 0.30',
    '===MEM===',
    'Mem:           1988         512        900          10         576        1200',
    '===DISK===',
    '/dev/sda1       50331648 12582912  35651584  27% /',
    '===CPU===',
    '2',
    '0.50 0.40 0.30 1/234 5678',
    '===DOCKER===',
    'backend|Up 2 hours',
    'admin|Exited (0) 5 minutes ago'
  ].join('\n');

  const h = parseHealth(out);
  assert.equal(h.memTotal, 1988);
  assert.equal(h.memUsed, 512);
  assert.equal(h.memPct, Math.round(512 / 1988 * 100));
  assert.equal(h.diskPct, 27);
  assert.equal(h.cores, 2);
  assert.equal(h.load1, 0.5);
  assert.equal(h.containers.length, 2);
  assert.equal(h.containers[0].name, 'backend');
  assert.equal(h.containers[0].up, true);
  assert.equal(h.containers[1].up, false);
});

test('parseHealth flags missing docker', () => {
  const h = parseHealth('===DOCKER===\nno-docker');
  assert.equal(h.dockerMissing, true);
  assert.equal(h.containers.length, 0);
});
