import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** G1: a live config written before PS-1..PS-8 (no methods/tiers/spec/panel)
 *  must still get the pstack features via loadConfig's default merge. */
function withConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-cfg-'));
  process.env.COWORK_CONFIG = join(dir, 'config.json');
  writeFileSync(process.env.COWORK_CONFIG, JSON.stringify(obj));
  return dir;
}

test('loadConfig: missing methods falls back to defaults (G1)', async () => {
  const dir = withConfig({ orchestration: { enabled: true, verifier: { enabled: true, minLength: 3 } } });
  try {
    const { loadConfig, PS_DEFAULTS } = await import('./config.js');
    const c = loadConfig();
    assert.equal(c.orchestration.methods?.enabled, true);
    assert.equal(c.orchestration.methods?.cards?.['research-report'], 'on');
    assert.equal(c.orchestration.methods?.cards?.['technical-writing'], 'shadow');
    assert.deepEqual(c.orchestration.tiers, PS_DEFAULTS.tiers);
    assert.equal(c.orchestration.verifier?.spec?.mode, 'shadow');
    assert.equal(c.orchestration.verifier?.panel?.size, 2);
    assert.equal(c.orchestration.verifier?.minLength, 3, 'existing verifier keys preserved');
    assert.equal(c.orchestration.prAutomation?.mode, 'shadow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig: live values win over PS defaults', async () => {
  const dir = withConfig({ orchestration: {
    methods: { enabled: false, cards: { 'bug-fix': 'on' } },
    tiers: { judgment: ['x'] },
    verifier: { spec: { enabled: false }, panel: { enabled: false } },
    prAutomation: { mode: 'merge' }
  } });
  try {
    const { loadConfig } = await import('./config.js');
    const c = loadConfig();
    assert.equal(c.orchestration.methods?.enabled, false);
    assert.equal(c.orchestration.methods?.cards?.['bug-fix'], 'on');
    assert.equal(c.orchestration.methods?.cards?.['feature'], 'shadow');
    assert.deepEqual(c.orchestration.tiers, { judgment: ['x'] });
    assert.equal(c.orchestration.verifier?.spec?.enabled, false);
    assert.equal(c.orchestration.verifier?.panel?.enabled, false);
    assert.equal(c.orchestration.prAutomation?.mode, 'merge');
    assert.equal(c.orchestration.prAutomation?.mergeMethod, 'squash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
