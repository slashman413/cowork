/**
 * Real failure reason for a dsh (DeepSeek Harness) run.
 *
 * dsh exits non-zero after a turn ends in an error, but its stdout is just the
 * agent's last chat text, so `firstLine(stdout)` put lines like
 * "[08:24:36] ⚙ Step 1 started" on the task card while the real cause, e.g.
 * CONTEXT_WINDOW_EXCEEDED, sat in the session log (task 8a5c0189, 2026-11-12).
 *
 * Sources, in order:
 *   1. stderr: the dsh-cowork-progress plugin prints
 *      `✗ dsh turn/end error code=<CODE>: <message>` (deploy/dsh/dsh-progress-plugin.mjs);
 *   2. the session log: $DSH_HOME/sessions/<cwd-key>/session-<uuid>/session.v4.jsonl.zstd,
 *      newest session touched since the attempt started, last `turn/end` event.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

export interface DshTurnError { code: string; message: string }

const STDERR_RE = /dsh turn\/end error code=([A-Z0-9_]+)(?::[ \t]*([^\n]*))?/g;

/** Last turn/end error the progress plugin reported on stderr, if any. */
export function dshErrorFromStderr(stderr: string | undefined): DshTurnError | null {
  if (!stderr) return null;
  let last: DshTurnError | null = null;
  for (const m of stderr.matchAll(STDERR_RE)) last = { code: m[1], message: (m[2] || '').trim() };
  return last;
}

/** dsh's session-dir key for a cwd: `/tmp` → `--tmp--`. */
export function dshSessionKey(cwd: string): string {
  return `--${cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')}--`;
}

/** The final `turn/end` of a session's JSONL, when it ended in an error. */
export function dshErrorFromSessionJsonl(jsonl: string): DshTurnError | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"turn/end"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type !== 'turn/end') continue;
      const reason = ev.data?.reason;
      if (reason?.kind !== 'error') return null;              // last turn ended cleanly
      const err = reason.error || reason.failure || {};
      return { code: String(err.code || 'ERROR'), message: String(err.message || '') };
    } catch { /* torn line — keep scanning */ }
  }
  return null;
}

/** Newest main session for `cwd` touched at/after `sinceMs`, read for its last turn/end error. */
export function dshErrorFromSession(cwd: string, sinceMs = 0, dshHome = join(process.env.HOME || '', '.dsh')): DshTurnError | null {
  try {
    const dir = join(dshHome, 'sessions', dshSessionKey(cwd));
    if (!existsSync(dir)) return null;
    const candidates = readdirSync(dir)
      .filter(n => n.startsWith('session-'))
      .map(n => join(dir, n, 'session.v4.jsonl.zstd'))
      .filter(f => existsSync(f))
      .map(f => ({ f, m: statSync(f).mtimeMs }))
      .filter(c => c.m >= sinceMs - 1000)
      .sort((a, b) => b.m - a.m);
    if (!candidates.length) return null;
    return dshErrorFromSessionJsonl(readZstd(candidates[0].f));
  } catch {
    return null;
  }
}

/**
 * dsh appends a zstd frame per flush; node's zlib decoders stop after the first
 * frame ("Unknown frame descriptor"), so use the zstd CLI and fall back to zlib.
 */
function readZstd(file: string): string {
  try {
    return execFileSync('zstd', ['-dcq', file], { maxBuffer: 256 * 1024 * 1024, timeout: 15_000 }).toString('utf-8');
  } catch {
    return zstdDecompressSync(readFileSync(file)).toString('utf-8');
  }
}

/** Compact one-line card reason, e.g. `dsh CONTEXT_WINDOW_EXCEEDED: 99409 input + 32768 output > 131072 tokens`. */
export function formatDshError(e: DshTurnError): string {
  const msg = e.message.replace(/\s+/g, ' ').trim();
  const ctx = /maximum context length of (\d+) tokens.*?(\d+) tokens from the input messages and (\d+) tokens for the completion/i.exec(msg);
  if (ctx) return `dsh ${e.code}: ${ctx[2]} input + ${ctx[3]} output > ${ctx[1]} tokens`;
  return `dsh ${e.code}${msg ? `: ${msg.slice(0, 240)}` : ''}`;
}

/** Real reason for a failed dsh attempt, or null when neither source has a turn error. */
export function dshFailureReason(run: { stderr?: string; cwd?: string; startedMs?: number }, dshHome?: string): string | null {
  const e = dshErrorFromStderr(run.stderr) || (run.cwd ? dshErrorFromSession(run.cwd, run.startedMs ?? 0, dshHome) : null);
  return e ? formatDshError(e) : null;
}
