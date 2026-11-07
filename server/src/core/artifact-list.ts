/**
 * Bounds on a task's stored `artifacts` file list.
 *
 * The list is display metadata for the task card — the files themselves stay on
 * disk and every consumer that needs the full set (verifier, recipes, workflow
 * gates, downloads) reads the directory directly. Unbounded, one run that cloned
 * a few repos into its artifacts dir stored 61,720 paths (5 MB of JSON) on its
 * task; the Tasks page re-fetched and re-rendered all of them on every SSE event,
 * freezing the dashboard for seconds per refresh.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import type { Task } from '../types.js';

/** Max artifact paths kept on a task (and served per task by the inbox API). */
export const TASK_ARTIFACT_LIST_MAX = 300;

/** Directory names never descended into when listing a run's artifacts. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'site-packages', 'dist-packages']);

/**
 * Recursively list files under `root` as sorted relative paths, skipping dotfiles,
 * dependency/cache dirs and the top-level `skipTop` entry (outputs/, listed on its
 * own). Shallow paths are kept before deep ones so the top-level deliverables
 * survive the cap. `total` is the number of files seen (≥ files.length).
 */
export function listArtifactFiles(root: string, opts: { skipTop?: string; max?: number } = {}): { files: string[]; total: number } {
  const max = opts.max ?? TASK_ARTIFACT_LIST_MAX;
  const all: Array<{ rel: string; depth: number }> = [];
  const walk = (cur: string, base: string, depth: number) => {
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (depth === 0 && opts.skipTop && entry.name === opts.skipTop) continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(cur, entry.name), rel, depth + 1);
      else if (entry.isFile()) all.push({ rel, depth });
    }
  };
  walk(root, '', 0);
  const total = all.length;
  let picked = all;
  if (total > max) picked = [...all].sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel)).slice(0, max);
  return { files: picked.map(f => f.rel).sort(), total };
}

/**
 * Shallow copy of `task` with an over-long `artifacts` list cut to the cap and
 * `artifactsTotal` set to the real count — for API responses, so tasks stored
 * before the cap existed (or reported by remote agents) can't bloat the list.
 * Returns the task itself when nothing needs trimming.
 */
export function boundTaskArtifacts<T extends Task>(task: T, max = TASK_ARTIFACT_LIST_MAX): T {
  const arts = (task as any)?.artifacts;
  if (!Array.isArray(arts) || arts.length <= max) return task;
  return { ...task, artifacts: arts.slice(0, max), artifactsTotal: Math.max(arts.length, Number((task as any).artifactsTotal) || 0) };
}
