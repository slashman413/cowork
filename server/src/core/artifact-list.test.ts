import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listArtifactFiles, boundTaskArtifacts, TASK_ARTIFACT_LIST_MAX } from './artifact-list.js';

test('listArtifactFiles skips dotfiles, dependency dirs and the skipped top-level entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'artlist-'));
  try {
    writeFileSync(join(root, 'report.md'), 'x');
    writeFileSync(join(root, '.hidden'), 'x');
    for (const d of ['node_modules/pkg', '__pycache__', '.git', 'outputs', 'sub/deep']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'node_modules/pkg/index.js'), 'x');
    writeFileSync(join(root, '__pycache__/a.pyc'), 'x');
    writeFileSync(join(root, '.git/HEAD'), 'x');
    writeFileSync(join(root, 'outputs/final.mp4'), 'x');
    writeFileSync(join(root, 'sub/deep/notes.txt'), 'x');
    const { files, total } = listArtifactFiles(root, { skipTop: 'outputs' });
    assert.deepEqual(files, ['report.md', 'sub/deep/notes.txt']);
    assert.equal(total, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listArtifactFiles caps the list, keeping shallow files over deep ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'artlist-'));
  try {
    mkdirSync(join(root, 'aaa/repo'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `aaa/repo/f${i}.py`), 'x');
    writeFileSync(join(root, 'zz-report.md'), 'x');
    const { files, total } = listArtifactFiles(root, { max: 5 });
    assert.equal(total, 21);
    assert.equal(files.length, 5);
    assert.ok(files.includes('zz-report.md'), 'top-level deliverable survives the cap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listArtifactFiles on a missing dir is empty, not a throw', () => {
  assert.deepEqual(listArtifactFiles('/nonexistent/cowork-artlist'), { files: [], total: 0 });
});

test('boundTaskArtifacts trims only over-long lists and records the real count', () => {
  const small: any = { id: 'a', artifacts: ['x.md'] };
  assert.equal(boundTaskArtifacts(small), small);
  const big: any = { id: 'b', artifacts: Array.from({ length: TASK_ARTIFACT_LIST_MAX + 50 }, (_, i) => `f${i}`) };
  const out: any = boundTaskArtifacts(big);
  assert.equal(out.artifacts.length, TASK_ARTIFACT_LIST_MAX);
  assert.equal(out.artifactsTotal, TASK_ARTIFACT_LIST_MAX + 50);
  assert.equal(big.artifacts.length, TASK_ARTIFACT_LIST_MAX + 50, 'stored task is not mutated');
});
