import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { briefPersona } from './persona-brief.js';

const pad = (n: number) => 'x'.repeat(n);
const persona = [
  '# Dev Agent', 'intro line',
  '## 🧠 Your Identity & Memory', '- Role: dev',
  '## 🚨 Critical Rules You Must Follow', '- never do X',
  '## 📋 Your Technical Deliverables', '```md', '## not a heading', pad(4000), '```',
  '## 🔄 Your Workflow Process', pad(2000),
  '## 💭 Your Communication Style', '- be terse',
].join('\n');

test('brief keeps identity/rules/style inline and points to the file for the rest', () => {
  const b = briefPersona(persona, '/abs/dev.md');
  assert.ok(b.text.includes('never do X'));
  assert.ok(b.text.includes('be terse'));
  assert.ok(b.text.includes('intro line'));
  assert.ok(!b.text.includes(pad(2000)));
  assert.ok(b.text.includes('`/abs/dev.md`'));
  assert.deepEqual(b.dropped, ['📋 Your Technical Deliverables', '🔄 Your Workflow Process']);
  assert.ok(b.text.includes('Your Technical Deliverables; Your Workflow Process'));
});

test('a `##` line inside a code fence is not treated as a section', () => {
  const b = briefPersona(persona, '/abs/dev.md');
  assert.ok(!b.dropped.includes('not a heading'));
});

test('short personas, missing path, or small savings return the full text', () => {
  assert.deepEqual(briefPersona('## Identity\nshort', '/p').dropped, []);
  assert.equal(briefPersona(persona, undefined).text, persona);
  const allKept = `## Identity\n${pad(3000)}\n## Critical Rules\n${pad(3000)}\n## Notes\nsmall`;
  assert.equal(briefPersona(allKept, '/p').text, allKept);
});

test('real roster: every brief keeps its critical rules and saves tokens overall', () => {
  const root = join(import.meta.dirname, '..', '..', '..', 'agency-agents');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.md')) files.push(p);
    }
  };
  try { walk(root); } catch { return; }
  let before = 0, after = 0;
  for (const f of files) {
    const raw = readFileSync(f, 'utf-8');
    if (!raw.startsWith('---')) continue;
    const body = raw.replace(/^---[\s\S]*?\n---\n/, '').trim();
    const b = briefPersona(body, f);
    before += body.length; after += b.text.length;
    const rules = body.match(/^## .*critical rules.*$/im);
    if (rules) assert.ok(b.text.includes(rules[0]), `${f} lost its critical rules`);
  }
  if (before) assert.ok(after < before * 0.75, `expected >25% saving, got ${(1 - after / before).toFixed(2)}`);
});
