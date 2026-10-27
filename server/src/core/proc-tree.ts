import { readdirSync, readFileSync } from 'node:fs';

/**
 * Kill a brain process AND everything it started.
 *
 * `child.kill()` only signals the direct child. Brains are process trees — the
 * `env` wrapper exec()s into `dsh`/`claude`/`codex`, which in turn run tool
 * shells, curl loops, python scripts… — so killing the top pid (or nothing at
 * all, as task delete used to do) left the tree running, still hammering the
 * local SGLang engine at ~96 % GPU long after its task was deleted.
 *
 * Strategy (Linux):
 *   1. snapshot the descendant tree from /proc (pid + start time, so a recycled
 *      pid is never signalled later);
 *   2. SIGTERM the process group (the brain is spawned `detached`, so its pgid is
 *      its own pid) and every snapshotted descendant — this also catches tool
 *      shells that moved to their own group/session;
 *   3. after `graceMs`, SIGKILL whatever of the group / snapshot is still alive.
 *
 * Every step is best-effort and never throws. Resolves once the final sweep ran.
 */
export interface KillTreeOptions {
  /** Delay between SIGTERM and the SIGKILL sweep. */
  graceMs?: number;
}

/** /proc/<pid>/stat → { ppid, start } (start = field 22, clock ticks since boot). */
function readStat(pid: number): { ppid: number; start: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesised and may contain spaces/parens — split after the LAST ')'.
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    // rest[0] = state (field 3), rest[1] = ppid (field 4), rest[19] = starttime (field 22)
    return { ppid: Number(rest[1]), start: rest[19] };
  } catch {
    return null;
  }
}

/** All live descendants of `root` (not including root), with their start times. */
export function descendants(root: number): Map<number, string> {
  const children = new Map<number, number[]>();
  const starts = new Map<number, string>();
  let entries: string[] = [];
  try { entries = readdirSync('/proc'); } catch { return new Map(); }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    const st = readStat(pid);
    if (!st) continue;
    starts.set(pid, st.start);
    const list = children.get(st.ppid);
    if (list) list.push(pid); else children.set(st.ppid, [pid]);
  }
  const out = new Map<number, string>();
  const queue = [...(children.get(root) || [])];
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.has(pid)) continue;
    out.set(pid, starts.get(pid) || '');
    queue.push(...(children.get(pid) || []));
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try { process.kill(pid, sig); return true; } catch { return false; }
}

/** True while `pid` exists and is still the same process (start time unchanged). */
function sameProcess(pid: number, start: string): boolean {
  const st = readStat(pid);
  return !!st && (!start || st.start === start);
}

/** True while any member of process group `pgid` is alive. */
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

export function killProcessTree(pid: number | undefined, opts: KillTreeOptions = {}): Promise<void> {
  if (!pid || pid <= 1) return Promise.resolve();
  const graceMs = opts.graceMs ?? 5000;
  const rootStart = readStat(pid)?.start || '';
  const tree = descendants(pid);

  signal(-pid, 'SIGTERM');          // whole group (detached spawn → pgid = pid)
  signal(pid, 'SIGTERM');           // root, in case it is not a group leader
  for (const [p, start] of tree) if (sameProcess(p, start)) signal(p, 'SIGTERM');

  return new Promise((resolve) => {
    setTimeout(() => {
      // Re-scan from the survivors: a descendant may have forked after the snapshot.
      const survivors = new Map(tree);
      if (sameProcess(pid, rootStart)) for (const [p, s] of descendants(pid)) survivors.set(p, s);
      for (const [p, s] of [...survivors]) if (sameProcess(p, s)) for (const [q, qs] of descendants(p)) survivors.set(q, qs);
      if (groupAlive(pid)) signal(-pid, 'SIGKILL');
      if (sameProcess(pid, rootStart)) signal(pid, 'SIGKILL');
      for (const [p, start] of survivors) if (sameProcess(p, start)) signal(p, 'SIGKILL');
      resolve();
    }, graceMs);
  });
}
