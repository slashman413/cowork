import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AudioOverview, AUDIO_OVERVIEW_TAG, RENDER_SCRIPT, readTaskSourceFile, htmlToText } from './audio-overview.js';

const render: any = await import(RENDER_SCRIPT);

test('parseScript: dialogue lines map to HOST_A / HOST_B and skip noise', () => {
  const segs = render.parseScript('# Title\nLANG: en\n\n<!-- c -->\nHOST_A: Hello there.\n**HOST_B:** Hi!\nhost a：中文也行。\n---\n');
  assert.deepEqual(segs, [
    { speaker: 'A', text: 'Hello there.' },
    { speaker: 'B', text: 'Hi!' },
    { speaker: 'A', text: '中文也行。' },
  ]);
});

test('parseScript: narrator paragraphs and long-text splitting at sentence ends', () => {
  const long = Array.from({ length: 60 }, (_, i) => `這是第${i}句話，內容夠長。`).join('');
  const segs = render.parseScript(`NARRATOR: 開場。\n${long}`);
  assert.equal(segs[0].text, '開場。');
  assert.ok(segs.length > 2);
  assert.ok(segs.every((s: any) => s.speaker === 'A' && s.text.length <= 420));
  assert.equal(segs.slice(1).map((s: any) => s.text).join(''), long);
});

test('voiceFor maps language + speaker', () => {
  assert.equal(render.voiceFor('zh-TW', 'A'), 'zh-TW-HsiaoChenNeural');
  assert.equal(render.voiceFor('zh-TW', 'B'), 'zh-TW-YunJheNeural');
  assert.equal(render.voiceFor('en', 'A'), 'en-US-AriaNeural');
  assert.equal(render.voiceFor('en', 'B'), 'en-US-GuyNeural');
  assert.equal(render.voiceFor('xx', 'B'), 'zh-TW-YunJheNeural');
});

test('parseBrief validates sources and falls back to defaults', () => {
  const ao = new AudioOverview({ defaultBrain: 'b1', brains: ['b1', 'b2'] });
  assert.throws(() => ao.parseBrief({ source: { kind: 'text', text: 'short' } }), /too short/);
  assert.throws(() => ao.parseBrief({ source: { kind: 'x' } }), /unknown source/);
  assert.throws(() => ao.parseBrief({ source: { kind: 'note' } }), /note/);
  const b = ao.parseBrief({ source: { kind: 'task', taskId: '../abc', file: 'outputs/r.md' }, style: 'dialogue', lang: 'en', length: 'medium', brain: 'nope' });
  assert.deepEqual([b.style, b.lang, b.length, b.brain], ['dialogue', 'en', 'medium', 'b1']);
  assert.equal((b.source as any).taskId, 'abc');
  assert.equal(ao.parseBrief({ source: { kind: 'text', text: 'x'.repeat(30) } }).lang, 'zh-TW');
});

test('buildTask: tagged, tells the brain to use the render script and tag turns', () => {
  const ao = new AudioOverview();
  const t = ao.buildTask(ao.parseBrief({ source: { kind: 'text', text: 'y'.repeat(50) }, style: 'dialogue', lang: 'en' }), 'SRC BODY', 'pasted text');
  assert.deepEqual(t.tags, [AUDIO_OVERVIEW_TAG]);
  assert.match(t.description, /HOST_A:/);
  assert.match(t.description, /audio-overview-render\.mjs/);
  assert.match(t.description, /en-US-GuyNeural/);
  assert.match(t.description, /SRC BODY/);
  assert.equal(t.context.audioOverview.style, 'dialogue');
});

test('readTaskSourceFile: guards traversal, extension and strips html', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
  fs.mkdirSync(path.join(root, 't1', 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(root, 't1', 'outputs', 'r.md'), '# hi');
  fs.writeFileSync(path.join(root, 't1', 'p.html'), '<style>a{}</style><p>Hello &amp; bye</p>');
  fs.writeFileSync(path.join(root, 'secret.md'), 'secret');
  fs.writeFileSync(path.join(root, 't1', 'x.mp4'), 'bin');
  assert.equal(readTaskSourceFile(root, 't1', 'outputs/r.md'), '# hi');
  assert.equal(readTaskSourceFile(root, 't1', 'p.html'), 'Hello & bye');
  assert.throws(() => readTaskSourceFile(root, 't1', '../secret.md'), /forbidden/);
  assert.throws(() => readTaskSourceFile(root, 't1', 'x.mp4'), /only/);
  assert.throws(() => readTaskSourceFile(root, 't1', 'nope.md'), /not found/);
  assert.equal(htmlToText('a  b', false), 'a  b');
});
