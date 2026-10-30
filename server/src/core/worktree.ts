import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Task, TaskWorktree } from '../types.js';

/**
 * Per-task git worktrees for CODE tasks.
 *
 * Code-task rule: a task is a code task when `context.repo` (aliases `repoPath`,
 * `workdir`, `cwd`) names a directory inside a git repository. `context.worktree:
 * false` opts out; `context.worktree: true` forces it (still needs a repo path to
 * know which repo). The brain then runs with cwd = <repo>/.worktrees/<task-id> on
 * branch cowork/<task-id>; COWORK_ARTIFACTS_DIR / COWORK_OUTPUTS_DIR are unchanged.
 */

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

const tryGit = (cwd: string, args: string[]): string | null => { try { return git(cwd, args); } catch { return null; } };

/** Git toplevel of `dir`, or null if it isn't inside a repository. */
export function gitToplevel(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null;
  const out = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

/** The repo a task's brain should be isolated in, or null if not a code task. */
export function codeTaskRepo(task: Pick<Task, 'context'>): string | null {
  const c = task.context || {};
  if (c.worktree === false) return null;
  const raw = [c.repo, c.repoPath, c.workdir, c.cwd].find(v => typeof v === 'string' && v.trim());
  return raw ? gitToplevel(resolve(String(raw))) : null;
}

/** Create (or reuse) <repo>/.worktrees/<taskId> on branch cowork/<taskId>. Throws on failure. */
export function ensureWorktree(repo: string, taskId: string): TaskWorktree {
  const path = join(repo, '.worktrees', taskId);
  const branch = `cowork/${taskId}`;
  const branchExists = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const baseOf = () => (branchExists ? tryGit(repo, ['merge-base', 'HEAD', branch])?.trim() : '') || head;
  if (existsSync(join(path, '.git'))) return { path, branch, base: baseOf() }; // reuse on re-run/continue
  // Keep .worktrees/ out of `git status` without touching tracked files.
  try {
    const common = resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
    const exclude = join(common, 'info', 'exclude');
    mkdirSync(join(common, 'info'), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!/^\/?\.worktrees\/?$/m.test(cur)) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.worktrees/\n`);
  } catch { /* best-effort */ }
  if (branchExists) git(repo, ['worktree', 'add', path, branch]);
  else git(repo, ['worktree', 'add', path, '-b', branch, head]);
  return { path, branch, base: baseOf() };
}

/** Write `outFile` = diff of the worktree (committed + uncommitted + untracked) vs base. */
export function writeWorktreeDiff(wt: TaskWorktree, outFile: string): void {
  tryGit(wt.path, ['add', '-N', '.']); // intent-to-add so untracked files show up
  writeFileSync(outFile, tryGit(wt.path, ['diff', wt.base]) ?? '');
}

export interface WorktreeResult { ok: boolean; message: string }

const repoOf = (wt: TaskWorktree): string => resolve(wt.path, '..', '..');
const errText = (e: any): string => String(e?.stderr || e?.stdout || e?.message || e).trim();

/** Merge the task branch into whatever branch the main checkout has checked out. */
export function mergeWorktree(wt: TaskWorktree): WorktreeResult {
  const repo = repoOf(wt);
  try {
    if (!existsSync(wt.path)) return { ok: false, message: 'worktree no longer exists (pruned?)' };
    if (git(repo, ['status', '--porcelain', '--untracked-files=no']).trim())
      return { ok: false, message: 'main checkout has uncommitted changes; commit or stash them first' };
    const target = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (target === 'HEAD') return { ok: false, message: 'main checkout is on a detached HEAD' };
    const ident = ['-c', 'user.name=cowork', '-c', 'user.email=cowork@localhost'];
    // Commit any leftover work in the worktree so it is included.
    if (git(wt.path, ['status', '--porcelain']).trim()) {
      git(wt.path, ['add', '-A']);
      git(wt.path, [...ident, 'commit', '-m', `cowork: uncommitted work from ${wt.branch}`]);
    }
    if (tryGit(repo, ['merge', '--ff-only', wt.branch]) !== null) return { ok: true, message: `fast-forwarded ${target} to ${wt.branch}` };
    try {
      git(repo, [...ident, 'merge', '--no-ff', '-m', `Merge ${wt.branch}`, wt.branch]);
      return { ok: true, message: `merged ${wt.branch} into ${target}` };
    } catch (e: any) {
      tryGit(repo, ['merge', '--abort']);
      return { ok: false, message: `merge conflicts; nothing was merged (${errText(e).split('\n')[0]})` };
    }
  } catch (e: any) {
    return { ok: false, message: errText(e) };
  }
}

/** Remove the worktree dir; optionally delete the branch too. */
export function removeWorktree(wt: TaskWorktree, deleteBranch: boolean): WorktreeResult {
  const repo = repoOf(wt);
  try {
    if (existsSync(wt.path)) git(repo, ['worktree', 'remove', '--force', wt.path]);
    tryGit(repo, ['worktree', 'prune']);
    if (deleteBranch) tryGit(repo, ['branch', '-D', wt.branch]);
    return { ok: true, message: deleteBranch ? 'worktree removed and branch deleted' : 'worktree removed (branch kept)' };
  } catch (e: any) {
    return { ok: false, message: errText(e) };
  }
}

export const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

/** Remove worktrees (keep branches) of tasks finished > 7 days ago and never merged. Returns pruned task ids. */
export function pruneStaleWorktrees(tasks: Task[], save: (t: Task) => void, now = Date.now()): string[] {
  const pruned: string[] = [];
  for (const t of tasks) {
    const wt = t.worktree;
    if (!wt || wt.merged || wt.discarded || wt.pruned || !t.completedAt) continue;
    if (now - Date.parse(t.completedAt) < PRUNE_AFTER_MS) continue;
    if (removeWorktree(wt, false).ok) { wt.pruned = true; save(t); pruned.push(t.id); }
  }
  return pruned;
}
