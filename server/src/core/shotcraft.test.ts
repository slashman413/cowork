import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Shotcraft, SHOTCRAFT_TAG, GALLERY_URL } from './shotcraft.js';

/**
 * The Shotcraft page trusts this module for a clean shot-card index, a BGM
 * lookup that can't escape assets/audio/bgm, and ONE brief that names the skill
 * (so the lean claude profile loads it), answers the mode question, and lands
 * deliverables at the artifacts root.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shotcraft-'));
  const dir = path.join(root, 'video-shotcraft');
  fs.mkdirSync(path.join(dir, 'gallery', 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'audio', 'bgm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: video-shotcraft\n---\n');
  fs.writeFileSync(path.join(dir, 'gallery', 'api', 'library.json'), JSON.stringify({
    categories: { camera: { zh: '运镜与空间', en: 'Camera & Space' }, 'bad key': { en: 'x' } },
    cards: [
      { name: 'deck-deal-flyin', category: 'ui-entrance', summary: '发牌', energy: '高',
        styles: [{ key: 'deck-deal-flyin', label: 'Deal', media: { url: './media/deck-deal-flyin.mp4?v=1' } }] },
      { name: 'space-camera-moves', category: 'camera',
        styles: [{ key: 'exploded-view', label: 'Exploded' }, { key: '../evil', label: 'x' }] },
      { name: '../evil', category: 'camera', styles: [] },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'assets', 'audio', 'bgm', 'house-vibez.mp3'), 'mp3');
  fs.writeFileSync(path.join(dir, 'assets', 'audio', 'bgm', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(root, 'secret.mp3'), 'secret');
  return new Shotcraft({ skillDir: dir, brains: ['b-opus', 'b-sonnet'], defaultBrain: 'b-opus' });
}

const base = { product: 'Acme Notes', message: 'Show how fast search is.' };

test('catalog: bad names dropped, previews point at the public gallery', () => {
  const sc = fixture();
  assert.equal(sc.available(), true);
  const { cards, categories } = sc.catalog();
  assert.deepEqual(cards.map(c => c.name), ['deck-deal-flyin', 'space-camera-moves']);
  assert.equal(cards[0].styles[0].preview, `${GALLERY_URL}media/deck-deal-flyin.mp4?v=1`);
  assert.deepEqual(cards[1].styles.map(s => s.key), ['exploded-view']);
  assert.deepEqual(Object.keys(categories), ['camera']);
});

test('bgm: only listed mp3s, never outside the bgm dir', () => {
  const sc = fixture();
  assert.deepEqual(sc.bgm(), ['house-vibez.mp3']);
  assert.ok(sc.bgmFile('house-vibez.mp3'));
  assert.equal(sc.bgmFile('../../secret.mp3'), null);
  assert.equal(sc.bgmFile('notes.txt'), null);
});

test('parseBrief: validates shots, clamps choices, template locks the spec', () => {
  const sc = fixture();
  assert.throws(() => sc.parseBrief({ message: 'x y z' }), /product/);
  assert.throws(() => sc.parseBrief({ ...base, shots: ['nope'] }), /unknown shot/);
  assert.throws(() => sc.parseBrief({ ...base, shots: ['space-camera-moves · nope'] }), /unknown shot/);
  assert.throws(() => sc.parseBrief({ ...base, mode: 'shot' }), /at least one shot/);

  const b = sc.parseBrief({ ...base, shots: ['space-camera-moves · exploded-view', 'deck-deal-flyin', 'deck-deal-flyin'],
    aspect: '7:3', seconds: 999, music: '../x.mp3', brain: 'evil', mode: 'weird' });
  assert.deepEqual(b.shots, ['space-camera-moves · exploded-view', 'deck-deal-flyin']);
  assert.equal(b.aspect, '16:9');
  assert.equal(b.seconds, 30);
  assert.equal(b.music, 'auto');
  assert.equal(b.brain, 'b-opus');
  assert.equal(b.mode, 'auto');

  const t = sc.parseBrief({ ...base, mode: 'template', aspect: '9:16', seconds: 15, music: 'house-vibez.mp3' });
  assert.equal(t.aspect, '16:9');
  assert.equal(t.seconds, 36);
  assert.equal(t.music, 'house-vibez.mp3');
});

test('buildTask: names the skill, full profile, fixed deliverables; guided parks for a human', () => {
  const sc = fixture();
  const auto = sc.buildTask(sc.parseBrief({ ...base, aspect: '9:16', seconds: 15 }), ['shot.png']);
  assert.match(auto.description, /\/video-shotcraft/);
  assert.match(auto.description, /1080×1920, 30 fps, 15 s/);
  assert.match(auto.description, /Do not stop for confirmation/);
  assert.match(auto.description, /`film\.mp4`/);
  assert.match(auto.description, /shot\.png/);
  assert.deepEqual(auto.tags, [SHOTCRAFT_TAG]);
  assert.equal(auto.context.claudeProfile, 'full');

  const guided = sc.buildTask(sc.parseBrief({ ...base, mode: 'guided' }));
  assert.match(guided.description, /NEEDS_INPUT:/);
  assert.deepEqual(guided.tags, [SHOTCRAFT_TAG, 'human-only']);
  const delegated = sc.buildTask(sc.parseBrief({ ...base, mode: 'guided', autoAnswer: true }));
  assert.deepEqual(delegated.tags, [SHOTCRAFT_TAG]);
});

test('buildGoal + buildWorkflow: unattended modes, params, review step depends on produce', () => {
  const sc = fixture();
  const brief = sc.parseBrief({ ...base, mode: 'guided', shots: ['deck-deal-flyin'] });
  const goal = sc.buildGoal(brief);
  assert.equal(goal.phases.length, 4);
  assert.match(goal.description, /autonomous free creation/);
  assert.deepEqual(goal.achieverBrainChain, ['b-opus']);

  assert.throws(() => sc.buildWorkflow(brief, 'Bad Id', '/art'), /workflow id/);
  const wf = sc.buildWorkflow(brief, 'shotcraft-acme', '/art');
  assert.deepEqual(wf.params, ['product', 'source', 'message', 'notes']);
  assert.match(wf.steps[0].description!, /\{\{product\}\}/);
  assert.match(wf.steps[0].description!, /deck-deal-flyin/);
  assert.doesNotMatch(wf.steps[0].description!, /Acme Notes/);
  assert.deepEqual(wf.steps[1].dependsOn, ['produce']);
  assert.match(wf.steps[1].description!, /\/art\/<that id>/);
});
