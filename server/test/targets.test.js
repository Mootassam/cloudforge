'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../lib/targets');

test('classify: databases, admin, platform, backend', () => {
  assert.strictEqual(t.classify('mongo', 'mongo:6'), 'database');
  assert.strictEqual(t.classify('db', 'postgres:16'), 'database');
  assert.strictEqual(t.classify('admin', 'node:18'), 'admin');
  assert.strictEqual(t.classify('dashboard', ''), 'admin');
  assert.strictEqual(t.classify('web', 'nginx'), 'platform');
  assert.strictEqual(t.classify('frontend', 'node:18'), 'platform');
  assert.strictEqual(t.classify('api', 'node:18'), 'backend');
  assert.strictEqual(t.classify('something', 'busybox'), 'service');
});

test('hostPorts: string and object forms, ignores bare container ports', () => {
  assert.deepStrictEqual(t.hostPorts({ ports: ['8080:3000'] }), ['8080']);
  assert.deepStrictEqual(t.hostPorts({ ports: ['127.0.0.1:9000:80'] }), ['9000']);
  assert.deepStrictEqual(t.hostPorts({ ports: ['80'] }), []); // not published to host
  assert.deepStrictEqual(t.hostPorts({ ports: [{ published: 8081, target: 80 }] }), ['8081']);
  assert.deepStrictEqual(t.hostPorts({ ports: ['8080:3000/tcp'] }), ['8080']);
  assert.deepStrictEqual(t.hostPorts({}), []);
});

test('parseComposeJson: extracts services, images, host ports', () => {
  const json = JSON.stringify({
    services: {
      admin: { image: 'myadmin', ports: ['8080:3000'] },
      mongo: { image: 'mongo:6' }
    }
  });
  const svcs = t.parseComposeJson(json);
  assert.strictEqual(svcs.length, 2);
  const admin = svcs.find(s => s.name === 'admin');
  assert.deepStrictEqual(admin.ports, ['8080']);
});

test('buildTargets: admin-only compose → admin button on its port, db ignored', () => {
  const services = [
    { name: 'admin', image: 'node:18', ports: ['8080'] },
    { name: 'mongo', image: 'mongo:6', ports: [] }
  ];
  const r = t.buildTargets({ services, host: '1.2.3.4', domain: '' });
  assert.strictEqual(r.targets.length, 1);
  assert.strictEqual(r.targets[0].kind, 'admin');
  assert.strictEqual(r.targets[0].baseUrl, 'http://1.2.3.4:8080');
  assert.ok(r.has.admin && r.has.database);
  assert.ok(!r.has.platform);
});

test('buildTargets: platform behind a domain (no published web port) still gets a button', () => {
  const services = [
    { name: 'api', image: 'node:18', ports: [] },
    { name: 'mongo', image: 'mongo:6', ports: [] }
  ];
  const r = t.buildTargets({ services, host: '1.2.3.4', domain: 'shop.example.com' });
  const dom = r.targets.find(x => x.source === 'domain');
  assert.ok(dom, 'expected a domain target');
  assert.strictEqual(dom.baseUrl, 'https://shop.example.com');
  assert.strictEqual(dom.kind, 'platform');
});

test('buildTargets: full stack → website(domain) + admin(port), backend/db reported not offered', () => {
  const services = [
    { name: 'web', image: 'nginx', ports: [] },          // behind domain
    { name: 'admin', image: 'node:18', ports: ['9443'] },
    { name: 'api', image: 'node:18', ports: [] },
    { name: 'mongo', image: 'mongo:6', ports: [] }
  ];
  const r = t.buildTargets({ services, host: '10.0.0.9', domain: 'https://my-site.com/' });
  const urls = r.targets.map(x => x.baseUrl).sort();
  assert.deepStrictEqual(urls, ['http://10.0.0.9:9443', 'https://my-site.com']);
  assert.ok(r.has.platform && r.has.admin && r.has.backend && r.has.database);
});

test('parseDockerPorts: pulls published host ports from docker ps, ignores unpublished', () => {
  assert.deepStrictEqual(t.parseDockerPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp'), ['8080']);
  assert.deepStrictEqual(t.parseDockerPorts('3000/tcp'), []); // not published to host
  assert.deepStrictEqual(t.parseDockerPorts('127.0.0.1:9000->9000/tcp, 0.0.0.0:443->443/tcp'), ['9000', '443']);
  assert.deepStrictEqual(t.parseDockerPorts(''), []);
});

test('allowedHosts: only the target hosts are allowed', () => {
  const r = t.buildTargets({ services: [{ name: 'admin', image: '', ports: ['8080'] }], host: '1.2.3.4', domain: 'a.com' });
  const hosts = t.allowedHosts(r.targets).sort();
  assert.deepStrictEqual(hosts, ['1.2.3.4', 'a.com']);
});
