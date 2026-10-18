import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KeylessLog, isLoopbackHost, keyMatches, readCookie, resolveApiKey } from './auth.js';

const tmpKeyFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-auth-')), 'api-key');

test('loopback hosts', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5', '100.64.0.1']) assert.equal(isLoopbackHost(h), false, h);
});

test('configured key wins; loopback without key stays open', () => {
  const keyFile = tmpKeyFile();
  assert.deepEqual(resolveApiKey({ apiKey: 'k', host: '0.0.0.0', keyFile }), { key: 'k', source: 'config' });
  assert.equal(resolveApiKey({ apiKey: null, host: '127.0.0.1', keyFile }).key, null);
  assert.equal(fs.existsSync(keyFile), false);
});

test('network host without key generates one, persists it 0600, reuses it', () => {
  const keyFile = tmpKeyFile();
  const first = resolveApiKey({ apiKey: null, host: '0.0.0.0', keyFile });
  assert.equal(first.source, 'generated');
  assert.ok(first.key && first.key.length >= 40);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const second = resolveApiKey({ apiKey: null, host: '0.0.0.0', keyFile });
  assert.deepEqual([second.source, second.key], ['file', first.key]);
});

test('explicit opt-out runs open', () => {
  const keyFile = tmpKeyFile();
  const r = resolveApiKey({ apiKey: null, host: '0.0.0.0', allowUnauthenticated: true, keyFile });
  assert.deepEqual(r, { key: null, source: 'none', openOptOut: true });
  assert.equal(fs.existsSync(keyFile), false);
});

test('keyMatches', () => {
  assert.equal(keyMatches('secret', 'secret'), true);
  assert.equal(keyMatches('secreT', 'secret'), false);
  assert.equal(keyMatches('s', 'secret'), false);
  assert.equal(keyMatches(undefined, 'secret'), false);
  assert.equal(keyMatches(['secret'], 'secret'), false);
});

test('readCookie', () => {
  assert.equal(readCookie('a=1; cowork_key=x%2Fy; b=2', 'cowork_key'), 'x/y');
  assert.equal(readCookie('a=1', 'cowork_key'), undefined);
  assert.equal(readCookie(undefined, 'cowork_key'), undefined);
});

test('key plus opt-out is soft (migration) mode', () => {
  const keyFile = tmpKeyFile();
  const r = resolveApiKey({ apiKey: 'k', host: '0.0.0.0', allowUnauthenticated: true, keyFile });
  assert.deepEqual(r, { key: 'k', source: 'config', soft: true });
  assert.equal(resolveApiKey({ apiKey: 'k', host: '0.0.0.0', keyFile }).soft, undefined);
});

test('KeylessLog groups by ip + user agent and reports new callers once', () => {
  const seen: string[] = [];
  const log = new KeylessLog((c) => seen.push(c.ip));
  log.record('1.1.1.1', 'curl', '/api/status', new Date('2026-01-01T00:00:00Z'));
  log.record('1.1.1.1', 'curl', '/api/inbox', new Date('2026-01-01T00:01:00Z'));
  log.record('2.2.2.2', 'node', '/mcp', new Date('2026-01-01T00:00:30Z'));
  assert.deepEqual(seen, ['1.1.1.1', '2.2.2.2']);
  const [first, second] = log.list();
  assert.deepEqual([first.ip, first.count, first.lastPath], ['1.1.1.1', 2, '/api/inbox']);
  assert.equal(second.ip, '2.2.2.2');
});
