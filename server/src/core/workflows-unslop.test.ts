import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflows } from './workflows.js';

// PS-8: the unslop criterion applies to public-facing content steps only.
// 4% of done results carry stock AI words, so there is no global lint.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const CRITERION = 'Passes the unslop rules listed in `methods/content.md`';

const PUBLIC_STEPS = new Set([
  'content-pipeline/publish',
  'gtm-campaign/email-system',
  'gtm-campaign/content',
  'gtm-campaign/sales-enablement'
]);

function loadWorkflows() {
  const store = { tasks: [], createTask() { throw new Error('unused'); }, listTasks() { return []; }, getTask() { return null; } };
  return new Workflows({ paths: { workflows: path.join(repoRoot, 'workflows') } } as any, store as any);
}

test('unslop criterion sits on public-facing content steps and nowhere else', () => {
  const workflows = loadWorkflows();
  assert.deepEqual(workflows.listInvalid(), []);
  const carrying: string[] = [];
  for (const def of workflows.list()) {
    for (const step of workflows.get(def.id)!.steps) {
      if ((step.acceptance || []).includes(CRITERION)) carrying.push(`${def.id}/${step.key}`);
    }
  }
  assert.deepEqual(carrying.sort(), [...PUBLIC_STEPS].sort());
});

test('methods/content.md holds the trimmed unslop list within 1.2 KB', () => {
  const card = fs.readFileSync(path.join(repoRoot, 'methods/content.md'), 'utf8');
  assert.ok(Buffer.byteLength(card) <= 1200, `content.md is ${Buffer.byteLength(card)} bytes`);
  assert.match(card, /## Unslop rules/);
  for (const id of ['3', '7', '13', '27']) assert.match(card, new RegExp(`^- ${id}\\b`, 'm'));
  const tw = fs.readFileSync(path.join(repoRoot, 'methods/technical-writing.md'), 'utf8');
  assert.ok(Buffer.byteLength(tw) <= 1200, `technical-writing.md is ${Buffer.byteLength(tw)} bytes`);
  assert.match(tw, /methods\/content\.md/);
});
