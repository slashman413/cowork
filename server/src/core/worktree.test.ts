import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeTaskRepo, ensureWorktree, writeWorktreeDiff, mergeWorktree, removeWorktree, pruneStaleWorktrees } from './worktree.js';
import type { Task } from '../types.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function tempRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wt-test-')));
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@t');
  writeFileSync(join(d, 'a.txt'), 'one\n');
  git(d, 'add', '.'); git(d, 'commit', '-qm', 'init');
  return d;
}
const task = (context: any): Pick<Task, 'context'> => ({ context });

test('detection: repo path is a code task; opt-out / non-repo is not', () => {
  const repo = tempRepo();
  assert.equal(codeTaskRepo(task({ repo })), repo);
  assert.equal(codeTaskRepo(task({ workdir: join(repo, '.') })), repo);
  assert.equal(codeTaskRepo(task({ repo, worktree: false })), null);
  assert.equal(codeTaskRepo(task({ repo, worktree: true })), repo);
  assert.equal(codeTaskRepo(task({})), null);
  assert.equal(codeTaskRepo(task({ repo: join(tmpdir(), 'does-not-exist-xyz') })), null);
});

test('create + reuse worktree, ignored in main status', () => {
  const repo = tempRepo();
  const wt = ensureWorktree(repo, 't1');
  assert.equal(wt.branch, 'cowork/t1');
  assert.equal(wt.base, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(existsSync(join(wt.path, 'a.txt')));
  assert.equal(git(repo, 'status', '--porcelain'), '');
  writeFileSync(join(wt.path, 'b.txt'), 'x');
  const again = ensureWorktree(repo, 't1');
  assert.deepEqual(again, wt);
  assert.ok(existsSync(join(again.path, 'b.txt')));
});

test('diff includes committed and uncommitted/untracked changes', () => {
  const repo = tempRepo();
  const wt = ensureWorktree(repo, 't2');
  writeFileSync(join(wt.path, 'a.txt'), 'two\n');
  git(wt.path, 'commit', '-qam', 'c');
  writeFileSync(join(wt.path, 'new.txt'), 'fresh\n');
  const out = join(repo, 'worktree.diff.out');
  writeWorktreeDiff(wt, out);
  const d = readFileSync(out, 'utf8');
  assert.match(d, /\+two/);
  assert.match(d, /new\.txt/);
});

test('merge fast-forwards; refuses on dirty main', () => {
  const repo = tempRepo();
  const wt = ensureWorktree(repo, 't3');
  writeFileSync(join(wt.path, 'f.txt'), 'f\n');
  git(wt.path, 'add', '.'); git(wt.path, 'commit', '-qm', 'f');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  const refused = mergeWorktree(wt);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /uncommitted/);
  git(repo, 'checkout', '--', 'a.txt');
  const ok = mergeWorktree(wt);
  assert.equal(ok.ok, true, ok.message);
  assert.ok(existsSync(join(repo, 'f.txt')));
});

test('merge refuses (and aborts) on conflicts', () => {
  const repo = tempRepo();
  const wt = ensureWorktree(repo, 't4');
  writeFileSync(join(wt.path, 'a.txt'), 'branch\n');
  git(wt.path, 'commit', '-qam', 'b');
  writeFileSync(join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'm');
  const r = mergeWorktree(wt);
  assert.equal(r.ok, false);
  assert.match(r.message, /conflict/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('discard removes worktree and branch; prune keeps branch', () => {
  const repo = tempRepo();
  const wt = ensureWorktree(repo, 't5');
  assert.equal(removeWorktree(wt, true).ok, true);
  assert.equal(existsSync(wt.path), false);
  assert.equal(git(repo, 'branch', '--list', 'cowork/t5'), '');

  const wt2 = ensureWorktree(repo, 't6');
  const old = { id: 't6', worktree: { ...wt2 }, completedAt: new Date(Date.now() - 8 * 86400_000).toISOString() } as Task;
  const fresh = { id: 't7', worktree: { ...wt2 }, completedAt: new Date().toISOString() } as Task;
  const pruned = pruneStaleWorktrees([old, fresh], () => {});
  assert.deepEqual(pruned, ['t6']);
  assert.equal(existsSync(wt2.path), false);
  assert.notEqual(git(repo, 'branch', '--list', 'cowork/t6'), '');
  assert.equal(old.worktree!.pruned, true);
});
