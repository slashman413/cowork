import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VideoStudio, VIDEO_STUDIO_TAG } from './video-studio.js';

/**
 * The Video Studio page trusts this module for three things: a clean style
 * list (library + the user's own styles), a poster lookup that can't escape
 * its roots, and ONE fixed brief that always tells the brain to drop the
 * deliverables at the artifacts root under fixed names.
 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vstudio-'));
  const lib = path.join(root, 'lib'), my = path.join(root, 'my');
  fs.mkdirSync(path.join(lib, 'styleboard'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'docs', 'frames'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'styleboard', 'catalog.json'), JSON.stringify([
    { slug: 'watercolor', en: 'Watercolor Brush', cn: '水彩笔刷', cat: '手绘与绘画', cat_en: 'Hand-drawn & Painting', uses: ['Travel', 3], dur: 113.6 },
    { slug: '../evil', en: 'Bad' },
    { slug: 'teardown', en: 'Exploded Teardown', cat_en: 'Evidence Films' },
  ]));
  fs.writeFileSync(path.join(lib, 'docs', 'frames', 'watercolor.jpg'), 'jpg');
  fs.mkdirSync(path.join(my, 'my-ink'), { recursive: true });
  fs.writeFileSync(path.join(my, 'my-ink', 'style.json'), JSON.stringify({ slug: 'my-ink', en: 'My Ink', cn: '我的墨', size: '1080x1440' }));
  fs.writeFileSync(path.join(root, 'secret.jpg'), 'secret');
  return { root, studio: new VideoStudio({ libDir: lib, myStylesDir: my, brains: ['b-sonnet', 'b-opus'], defaultBrain: 'b-sonnet' }) };
}

test('styles: my styles first, bad slugs dropped, non-string uses filtered', () => {
  const { studio } = fixture();
  const s = studio.styles();
  assert.deepEqual(s.map(x => x.slug), ['my-ink', 'watercolor', 'teardown']);
  assert.equal(s[0].my, true);
  assert.equal(s[0].size, '1080x1440');
  assert.deepEqual(s[1].uses, ['Travel']);
  assert.equal(s[1].poster, true);
  assert.equal(s[2].poster, false);
});

test('posterFile never resolves outside the library / my-styles roots', () => {
  const { studio } = fixture();
  assert.ok(studio.posterFile('watercolor')?.endsWith('watercolor.jpg'));
  for (const bad of ['../secret', '..', '/etc/passwd', 'a/b', '']) assert.equal(studio.posterFile(bad), null);
});

test('parseBrief: validates style + topic, clamps the rest to known values', () => {
  const { studio } = fixture();
  assert.throws(() => studio.parseBrief({ slug: 'nope', topic: 'bees' }), /unknown style/);
  assert.throws(() => studio.parseBrief({ slug: 'watercolor', topic: ' ' }), /topic/);
  const b = studio.parseBrief({ slug: 'watercolor', topic: 'Bees in Taipei', seconds: 7, aspect: '1:1', voice: 'fr', brain: 'evil-brain' });
  assert.equal(b.seconds, 45);
  assert.equal(b.aspect, '16:9');
  assert.equal(b.voice, 'none');
  assert.equal(b.brain, 'b-sonnet');
  assert.equal(b.music, true);
  assert.equal(b.storyboard, false);
  assert.equal(studio.parseBrief({ slug: 'watercolor', topic: 'x y z', brain: 'b-opus' }).brain, 'b-opus');
});

test('buildTask: pinned brain, tag, fixed deliverable names, storyboard gate only when asked', () => {
  const { studio } = fixture();
  const brief = studio.parseBrief({ slug: 'watercolor', topic: 'Rain over Taipei', seconds: 30, aspect: '9:16', voice: 'zh' });
  const t = studio.buildTask(brief, ['logo.png']);
  assert.deepEqual(t.tags, [VIDEO_STUDIO_TAG]);
  assert.equal(t.context.brain, 'b-sonnet');
  assert.equal(t.context.videoStudio.slug, 'watercolor');
  for (const s of ['1080×1920', '--size 1080x1920', 'film.mp4', 'poster.jpg', 'film.vtt', 'contact.jpg', 'RENDER_SLOTS=1', 'logo.png', 'zh-TW']) {
    assert.ok(t.description.includes(s), `description mentions ${s}`);
  }
  assert.ok(!t.description.includes('NEEDS_INPUT'));
  const gated = studio.buildTask({ ...brief, storyboard: true });
  assert.ok(gated.description.includes('NEEDS_INPUT: Approve this storyboard'));
  assert.ok(studio.buildTask(studio.parseBrief({ slug: 'my-ink', topic: 'abc' })).description.includes('MY-STYLES.md'));
});
