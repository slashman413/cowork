import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlService } from './service-control.js';
import type { ServiceConfig } from '../types.js';

/**
 * controlService is the write path behind POST /api/services/:key/:action. Every
 * guard below returns BEFORE systemctl is ever invoked, so these run without a
 * host systemd session and pin the security-critical refusals: control disabled,
 * bad action, missing apiKey, unknown/uncontrollable/protected units. The unit
 * that reaches systemctl is only ever the one named in server config for `key`,
 * never a request string — so the request cannot inject a unit.
 */

const services: Record<string, ServiceConfig> = {
  filebrowser: { url: 'http://localhost:8082', enabled: true, unit: 'filebrowser.service', controllable: true },
  firecrawl: { url: 'http://localhost:3002', enabled: true, unit: 'firecrawl.service' }, // controllable:false
  noUnit: { url: 'http://localhost:9000', enabled: true }, // monitored, but no lifecycle
  selfKill: { url: 'http://localhost:6868', enabled: true, unit: 'cowork-mcp.service' },
  brain: { url: 'http://localhost:1', enabled: true, unit: 'cowork-local-brain@claude.service' },
  badUnit: { url: 'http://localhost:1', enabled: true, unit: 'not a unit; rm -rf' },
};

const on = { controlEnabled: true, apiKeySet: true, services };

test('control disabled → 403 before any systemctl', async () => {
  const out = await controlService('filebrowser', 'start', { ...on, controlEnabled: false });
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /disabled/);
});

test('invalid action → 400', async () => {
  const out = await controlService('filebrowser', 'obliterate', on);
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /invalid action/);
});

test('no apiKey → 403 (mutations refused on anonymous API)', async () => {
  const out = await controlService('filebrowser', 'start', { ...on, apiKeySet: false });
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /apiKey/);
});

test('unknown key / no configured unit → 404', async () => {
  assert.equal((await controlService('ghost', 'start', on)).status, 404);
  assert.equal((await controlService('noUnit', 'start', on)).status, 404);
});

test('enable on a non-controllable service → 403', async () => {
  const out = await controlService('firecrawl', 'enable', on);
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /autostart/);
});

test('protected units (server + brains) → 423, never executed', async () => {
  assert.equal((await controlService('selfKill', 'stop', on)).status, 423);
  assert.equal((await controlService('brain', 'restart', on)).status, 423);
});

test('malformed unit name in config → 400 (never reaches systemctl)', async () => {
  const out = await controlService('badUnit', 'start', on);
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /invalid unit/);
});

test('guard order: disabled beats a protected unit (403 before 423)', async () => {
  // With control off, we must refuse generically without leaking that the unit
  // is protected — the master switch is checked first.
  const out = await controlService('selfKill', 'stop', { ...on, controlEnabled: false });
  assert.equal(out.status, 403);
});
