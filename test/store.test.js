'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createStore } = require('../src/store');
const { generateCode } = require('../src/codes');

function tmp() {
  return path.join(os.tmpdir(), 'cf-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
}

test('upsert creates then updates a project', () => {
  const f = tmp(); const s = createStore(f);
  const p = s.upsertProject({ name: 'King', customerName: 'A' });
  assert.ok(p.id, 'should get an id');
  assert.equal(p.name, 'King');
  assert.equal(p.apiKeySet, false);
  const up = s.upsertProject({ id: p.id, name: 'King2' });
  assert.equal(up.name, 'King2');
  assert.equal(up.customerName, 'A', 'other fields preserved');
  assert.equal(s.read().projects.length, 1);
  fs.unlinkSync(f);
});

test('delete removes a project', () => {
  const f = tmp(); const s = createStore(f);
  const p = s.upsertProject({ name: 'X' });
  s.deleteProject(p.id);
  assert.equal(s.read().projects.length, 0);
  fs.unlinkSync(f);
});

test('access code has the expected shape', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(generateCode(), /^CF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  }
});

test('global rules, api-key status and access code persist', () => {
  const f = tmp(); const s = createStore(f);
  s.setGlobalRules('be safe');
  assert.equal(s.read().globalRules, 'be safe');
  const p = s.upsertProject({ name: 'Y' });
  s.setApiKeyStatus(p.id, true);
  assert.equal(s.getProject(p.id).apiKeySet, true);
  s.setAccessCode(p.id, 'CF-ABCD-EFGH-JKLM');
  assert.equal(s.getProject(p.id).accessCode, 'CF-ABCD-EFGH-JKLM');
  fs.unlinkSync(f);
});

test('reading a missing file returns an empty, valid shape', () => {
  const s = createStore(tmp());
  const d = s.read();
  assert.deepEqual(d.projects, []);
  assert.equal(d.globalRules, '');
  assert.equal(typeof d.settings, 'object');
});
