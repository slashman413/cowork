import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizePortal, PortalStore, PORTAL_TEMPLATE } from './portal-config.js';

/**
 * portal.json is operator-edited by hand and hot-reloaded, so the loader must
 * (a) keep good cards when one entry is bad, (b) never let a malformed unit /
 * url / icon through to the UI or systemctl, and (c) keep serving the last good
 * catalog when the file is mid-edit and fails to parse.
 */

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-')), 'portal.json');

test('repo default portal.json is valid and lists the DGX Spark services', () => {
  const view = normalizePortal(JSON.parse(fs.readFileSync(PORTAL_TEMPLATE, 'utf-8')), PORTAL_TEMPLATE);
  assert.deepEqual(view.errors, []);
  for (const k of ['obsidian', 'mautic', 'filebrowser', 'forgejo', 'sglang38', 'comfyui', 'firecrawl', 'godseye']) {
    assert.ok(view.services[k], `missing default service ${k}`);
  }
  assert.equal(view.services.firecrawl.enabled, false);
  assert.equal(view.services.godseye.unit, 'gods-eye-view.service');
});

test('bad entries are dropped or stripped with an error; good ones survive', () => {
  const view = normalizePortal({
    accent: 'red',
    categories: ['Dev', 42, ''],
    services: {
      good: { url: 'http://localhost:1', icon: 'git-fork', order: 2, probe: false },
      self: { url: '/obsidian.html' },
      evil: { url: 'javascript:alert(1)' },
      nourl: { label: 'x' },
      badunit: { url: 'http://localhost:2', unit: 'x; rm -rf /', icon: '<svg>' },
      'bad key!': { url: 'http://localhost:3' },
    },
  }, 'mem');
  assert.equal(view.accent, '#2563EB');
  assert.deepEqual(view.categories, ['Dev']);
  assert.deepEqual(Object.keys(view.services).sort(), ['badunit', 'good', 'self']);
  assert.equal(view.services.good.order, 2);
  assert.equal(view.services.good.probe, false);
  assert.equal(view.services.badunit.unit, undefined);
  assert.equal(view.services.badunit.icon, undefined);
  assert.equal(view.errors.length, 6);
});

test('store seeds from the template + legacy config.services, then hot-reloads', () => {
  const file = tmpFile();
  const store = new PortalStore(file, { mautic: { url: 'http://localhost:9999', enabled: true } });
  const first = store.get();
  assert.equal(first.services.mautic.url, 'http://localhost:9999'); // legacy wins
  assert.equal(first.services.mautic.label, 'Mautic');              // template fields kept
  assert.ok(first.services.forgejo);

  fs.writeFileSync(file, JSON.stringify({ services: { only: { url: 'http://localhost:1' } } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // force an mtime change
  assert.deepEqual(Object.keys(store.get().services), ['only']);
});

test('a parse error keeps serving the last good catalog and reports it', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ services: { a: { url: 'http://localhost:1' } } }));
  const store = new PortalStore(file);
  assert.ok(store.get().services.a);
  fs.writeFileSync(file, '{ "services": ');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const view = store.get();
  assert.ok(view.services.a);
  assert.equal(view.errors.length, 1);
});
