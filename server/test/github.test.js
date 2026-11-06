'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../lib/github');

test('parseRepo: accepts owner/name, https, and ssh forms; rejects junk', () => {
  assert.deepStrictEqual(g.parseRepo('Mootassam/tabletap'), { owner: 'Mootassam', name: 'tabletap' });
  assert.deepStrictEqual(g.parseRepo('https://github.com/Mootassam/tabletap.git'), { owner: 'Mootassam', name: 'tabletap' });
  assert.deepStrictEqual(g.parseRepo('git@github.com:owner/name.git'), { owner: 'owner', name: 'name' });
  assert.strictEqual(g.parseRepo('not valid'), null);
  assert.strictEqual(g.parseRepo('a/b/c'), null);
  assert.strictEqual(g.parseRepo(''), null);
});

test('authRemoteUrl embeds the token, and redact() hides it', () => {
  const url = g.authRemoteUrl('owner/name', 'ghp_SECRETTOKEN1234567890abcdefghij');
  assert.ok(url.includes('ghp_SECRETTOKEN1234567890abcdefghij'), 'token should be in the raw url for push');
  const safe = g.redact(url);
  assert.ok(!safe.includes('ghp_SECRETTOKEN1234567890abcdefghij'), 'redacted url must not leak the token');
  assert.ok(safe.includes('x-access-token:***@'));
});
