/**
 * Brief sharpener at intake (PS-1, port of pstack `sharpen`, shadow mode).
 *
 * When a task arrives without `context.acceptance`, a pre-pass on a cheap brain
 * (mechanical tier) sharpens it into 2-5 checkable criteria, 1-3 verification
 * checks, one outside check, deliverable shape, and open choices.
 *
 * Skip rules:
 *   - already has `context.acceptance`
 *   - `tier: mechanical`
 *   - gate / review / verifier / eval tasks
 *   - explicit opt-out: `context.sharpen === false`
 *   - orchestration.sharpener.enabled === false
 *
 * Timing:
 *   - in the BACKGROUND at creation (sharpenInBackground — the create call must
 *     not wait up to 60 s on the cheap brain), or just before first dispatch for
 *     tasks that skipped intake; never both (context.sharpenStartedAt)
 *   - 60 s cap
 *   - on failure or bad JSON: dispatch unsharpened (fail-open) and log
 *     `kind: "sharpen-failed"` to decisions/lessons.jsonl
 *
 * Stored as:
 *   context.acceptance, context.verify, context.outsideCheck, context.deliverable,
 *   context.playbook, context.openChoices, context.acceptanceSource = "sharpened".
 */

import { spawn } from 'node:child_process';
import type { BrainConfig, Config, RoleConfig, Task } from '../types.js';
import { buildLesson, appendLesson } from './lessons.js';

export const SHARPEN_CORE_PARAGRAPH =
  `Before starting, ask how a top expert would approach this task (their raw sources, their real methods, an outside check that the result is right), what the user is really after, and whether the task is over- or underspecified. Loosen constraints that don't serve the goal as readily as you add ones that do, and leave choices that are the user's to make open instead of deciding them. Fold in only what makes the work better, not bigger, but always keep one outside check that the result is right, without narrating the framing, then do the work.`;

export interface SharpenResult {
  acceptance: string[];
  verify: string[];
  outsideCheck: string;
  deliverable?: string;
  playbook?: string;
  openChoices?: string[];
}

/** Remove ANSI escape sequences and carriage returns. */
// eslint-disable-next-line no-control-regex
const OSC_CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
function stripAnsi(s: string): string {
  return (s || '').replace(OSC_CSI_RE, '').replace(/\r/g, '');
}

/** Check if a task is a gate, review, verifier, or eval task that must not be sharpened. */
export function isGateOrReviewOrVerifierOrEvalTask(task: Task): boolean {
  const ctx = (task.context || {}) as Record<string, any>;

  // Gate review task
  if (ctx.gateReviewFor || ctx.gateStepKey) return true;

  // Review task
  if (ctx.tier === 'review' || ctx.reviewOf || ctx.isReview) return true;
  const fromAgent = task.from?.agent?.toLowerCase() || '';
  if (fromAgent === 'reviewer' || fromAgent === 'engineering-code-reviewer' || fromAgent === 'code-reviewer') return true;
  const targetAgent = (ctx.agent || '').toLowerCase();
  if (targetAgent === 'reviewer' || targetAgent === 'engineering-code-reviewer' || targetAgent === 'code-reviewer') return true;
  if (typeof task.title === 'string' && /^review\b/i.test(task.title)) return true;

  // Verifier task
  if (ctx.verifier || fromAgent === 'verifier' || fromAgent === 'spec-verifier') return true;

  // Eval task
  if (ctx.brain === 'local-script-eval-harness') return true;
  if (ctx.workflowId === 'eval-prompt-change') return true;
  if (fromAgent === 'eval-harness') return true;
  if (typeof ctx.stepKey === 'string' && ctx.stepKey.toLowerCase().startsWith('eval')) return true;
  if (Array.isArray(task.tags) && task.tags.some(t => String(t).toLowerCase() === 'eval')) return true;
  if (typeof task.title === 'string' && /^eval\b/i.test(task.title.trim())) return true;

  return false;
}

/** Check whether a task qualifies for intake sharpening. */
export function shouldSharpenTask(task: Task, cfg?: Config): boolean {
  if (cfg?.orchestration?.sharpener?.enabled === false) return false;
  if (task.context?.sharpen === false) return false;
  if (Array.isArray(task.context?.acceptance) && task.context.acceptance.length > 0) return false;
  // Already sharpened (or being sharpened) at intake — don't spawn a second pass.
  if (task.context?.sharpenStartedAt) return false;
  if (task.context?.tier === 'mechanical') return false;
  if (isGateOrReviewOrVerifierOrEvalTask(task)) return false;
  return true;
}

/** Construct the sharpener prompt conforming to pstack sharpen + guards. */
export function buildSharpenerPrompt(task: { title: string; description?: string }): string {
  return [
    SHARPEN_CORE_PARAGRAPH,
    ``,
    `You are the brief sharpener. Sharpen the following task into clear, falsifiable acceptance criteria and verification commands before dispatch.`,
    ``,
    `TASK TITLE: ${task.title}`,
    `TASK DESCRIPTION:`,
    task.description || '(no description)',
    ``,
    `Guards:`,
    `- "Better, not bigger": add NO scope beyond what was requested.`,
    `- Every criterion must be checkable from artifacts on disk, a shell command, or a URL.`,
    `- Leave choices that are the user's to make in openChoices, not decided by you.`,
    `- Keep exactly one outside check that the result is right.`,
    ``,
    `Return ONLY a JSON object with this exact shape:`,
    `{`,
    `  "acceptance": ["2-5 checkable criteria"],`,
    `  "verify": ["1-3 commands or checks that prove them"],`,
    `  "outsideCheck": "exactly one outside check that the result is right",`,
    `  "deliverable": "expected file names or shape",`,
    `  "playbook": "suggested playbook key, e.g. bug-fix, feature, research-report, content, ops-change",`,
    `  "openChoices": ["unresolved choices that belong to the user"]`,
    `}`,
  ].join('\n');
}

/** Parse and validate sharpener output. Returns null on invalid JSON or out-of-spec criteria. */
export function parseSharpenOutput(rawText: string): SharpenResult | null {
  if (!rawText || !rawText.trim()) return null;
  let text = stripAnsi(rawText).trim();

  // Strip code block wrappers if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    text = fenced[1].trim();
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }

  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // acceptance: [2-5] checkable criteria
  if (!Array.isArray(obj.acceptance)) return null;
  const acceptance = obj.acceptance.map((x: any) => String(x || '').trim()).filter(Boolean);
  if (acceptance.length < 2 || acceptance.length > 5) return null;

  // verify: [1-3] checks
  if (!Array.isArray(obj.verify)) return null;
  const verify = obj.verify.map((x: any) => String(x || '').trim()).filter(Boolean);
  if (verify.length < 1 || verify.length > 3) return null;

  // outsideCheck: exactly one outside check
  const outsideCheck = typeof obj.outsideCheck === 'string' && obj.outsideCheck.trim() ? obj.outsideCheck.trim() : '';
  if (!outsideCheck) return null;

  const deliverable = typeof obj.deliverable === 'string' && obj.deliverable.trim() ? obj.deliverable.trim() : undefined;
  const playbook = typeof obj.playbook === 'string' && obj.playbook.trim() ? obj.playbook.trim() : undefined;
  const openChoices = Array.isArray(obj.openChoices)
    ? obj.openChoices.map((x: any) => String(x || '').trim()).filter(Boolean)
    : [];

  return {
    acceptance,
    verify,
    outsideCheck,
    ...(deliverable ? { deliverable } : {}),
    ...(playbook ? { playbook } : {}),
    openChoices,
  };
}

/** Pick the cheap brain to run the sharpener on (default: mechanical tier). */
export function selectSharpenerBrain(cfg: Config): { brainId: string; brain: BrainConfig } | null {
  const orch = cfg.orchestration || {};
  const brains = orch.brains || {};

  // Configured override
  const configured = orch.sharpener?.brain;
  if (configured && brains[configured] && !brains[configured].disabled && brains[configured].location === 'local') {
    return { brainId: configured, brain: brains[configured] };
  }

  // Mechanical tier from config (e.g. local-dsh-qwen3-8-27b, local-agy-gemini-3.8-flash-high)
  const mechanical = orch.tiers?.mechanical || [];
  for (const id of mechanical) {
    const b = brains[id];
    if (b && !b.disabled && b.location === 'local' && b.exec) {
      return { brainId: id, brain: b };
    }
  }

  // Fallback to local-agy-gemini-3.8-flash-high or any enabled local brain
  const fallback = 'local-agy-gemini-3.8-flash-high';
  if (brains[fallback] && !brains[fallback].disabled && brains[fallback].location === 'local') {
    return { brainId: fallback, brain: brains[fallback] };
  }

  for (const [id, b] of Object.entries(brains)) {
    if (!b.disabled && b.location === 'local' && b.exec) {
      return { brainId: id, brain: b };
    }
  }

  return null;
}

/** Construct command argv for one-shot execution of the sharpener brain. */
export function buildSharpenerArgv(brain: BrainConfig, prompt: string, timeoutMs: number): string[] {
  if (brain.command && brain.command.length) {
    return [...brain.command, prompt];
  }
  switch (brain.exec) {
    case 'claude':
      return ['claude', '-p', prompt, ...(brain.model ? ['--model', brain.model] : []), '--dangerously-skip-permissions'];
    case 'agy':
      return ['agy', '-p', prompt, '--print-timeout', `${timeoutMs}ms`, ...(brain.model ? ['--model', brain.model] : []), '--dangerously-skip-permissions'];
    case 'codex':
      return ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(brain.model ? ['-m', brain.model] : []), prompt];
    case 'hermes':
      return brain.model ? ['hermes', '-m', brain.model, '-z', prompt] : ['hermes', '-z', prompt];
    case 'ollama':
      return ['ollama', 'run', brain.model || 'qwen2.5:latest', prompt];
    case 'dsh':
      return ['env', `DSH_HOME=${process.env.HOME}/.dsh`, 'SGLANG_API_KEY=dummy', 'dsh', '--profile', 'headless', prompt];
    default:
      return ['hermes', '-z', prompt];
  }
}

/** Spawn the brain process with a timeout. */
export function runSharpenerBrain(
  brain: BrainConfig,
  prompt: string,
  timeoutMs: number
): Promise<{ ok: boolean; text: string }> {
  const argv = buildSharpenerArgv(brain, prompt, timeoutMs);
  return new Promise((resolve) => {
    try {
      const child = spawn(argv[0], argv.slice(1), {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', e => {
        clearTimeout(timer);
        resolve({ ok: false, text: `SPAWN ERROR: ${e.message}` });
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, text: `TIMEOUT after ${timeoutMs}ms` });
          return;
        }
        const clean = stripAnsi(out).trim();
        if (code === 0 && clean) resolve({ ok: true, text: clean });
        else resolve({ ok: false, text: clean || stripAnsi(err).trim() || `exit code ${code}` });
      });
    } catch (e: any) {
      resolve({ ok: false, text: `SPAWN ERROR: ${e?.message || e}` });
    }
  });
}

export interface SharpenTaskOptions {
  config: Config;
  decisionsDir?: string;
  runner?: (prompt: string, timeoutMs: number) => Promise<{ ok: boolean; text: string }>;
}

/**
 * Run the intake sharpener on a task (fail-open, 60s cap).
 * Updates `task.context` in-place and returns `{ sharpened: true, result }` on success.
 * On failure or bad JSON, logs `kind: "sharpen-failed"` to lessons.jsonl and returns `{ sharpened: false, error }`.
 */
export async function sharpenTask(
  task: Task,
  opts: SharpenTaskOptions
): Promise<{ sharpened: boolean; result?: SharpenResult; error?: string }> {
  const timeoutMs = opts.config.orchestration?.sharpener?.timeoutMs || 60_000;
  const decisionsDir = opts.decisionsDir || opts.config.paths?.decisions;

  const brainSelect = selectSharpenerBrain(opts.config);
  if (!brainSelect && !opts.runner) {
    const reason = 'no local cheap brain available in mechanical tier';
    if (decisionsDir) {
      appendLesson(decisionsDir, buildLesson({
        kind: 'sharpen-failed',
        task: task.id,
        title: task.title,
        agent: 'sharpener',
        brain: 'none',
        attempt: 1,
        reason
      }));
    }
    return { sharpened: false, error: reason };
  }

  const prompt = buildSharpenerPrompt(task);
  let brainOutput: { ok: boolean; text: string };

  try {
    if (opts.runner) {
      brainOutput = await opts.runner(prompt, timeoutMs);
    } else {
      brainOutput = await runSharpenerBrain(brainSelect!.brain, prompt, timeoutMs);
    }
  } catch (e: any) {
    brainOutput = { ok: false, text: `SHARPENER ERROR: ${e?.message || e}` };
  }

  if (!brainOutput.ok) {
    const reason = `sharpener brain call failed: ${brainOutput.text.slice(0, 200)}`;
    if (decisionsDir) {
      appendLesson(decisionsDir, buildLesson({
        kind: 'sharpen-failed',
        task: task.id,
        title: task.title,
        agent: 'sharpener',
        brain: brainSelect?.brainId || 'unknown',
        attempt: 1,
        reason
      }));
    }
    return { sharpened: false, error: reason };
  }

  const parsed = parseSharpenOutput(brainOutput.text);
  if (!parsed) {
    const reason = `sharpener returned bad JSON or invalid criteria: ${brainOutput.text.slice(0, 200)}`;
    if (decisionsDir) {
      appendLesson(decisionsDir, buildLesson({
        kind: 'sharpen-failed',
        task: task.id,
        title: task.title,
        agent: 'sharpener',
        brain: brainSelect?.brainId || 'unknown',
        attempt: 1,
        reason
      }));
    }
    return { sharpened: false, error: reason };
  }

  task.context = {
    ...(task.context || {}),
    acceptance: parsed.acceptance,
    verify: parsed.verify,
    outsideCheck: parsed.outsideCheck,
    ...(parsed.deliverable ? { deliverable: parsed.deliverable } : {}),
    ...(parsed.playbook ? { playbook: parsed.playbook } : {}),
    openChoices: parsed.openChoices || [],
    acceptanceSource: 'sharpened',
  };

  return { sharpened: true, result: parsed };
}

/** Context keys a sharpen pass writes — the only ones a caller may merge back. */
export const SHARPEN_CONTEXT_KEYS = ['acceptance', 'verify', 'outsideCheck', 'deliverable', 'playbook', 'openChoices', 'acceptanceSource'] as const;

/** Copy the sharpened fields from `from` onto `into` (never status, claim, or other context). */
export function mergeSharpenedContext(into: Task, from: Task): void {
  const src = (from.context || {}) as Record<string, any>;
  if (src.acceptanceSource !== 'sharpened') return;
  const ctx: Record<string, any> = { ...(into.context || {}) };
  // A brief the person (or another pass) already gave criteria to wins.
  if (Array.isArray(ctx.acceptance) && ctx.acceptance.length > 0) return;
  for (const k of SHARPEN_CONTEXT_KEYS) if (src[k] !== undefined) ctx[k] = src[k];
  into.context = ctx;
}

/**
 * Intake sharpening without blocking the caller (POST /inbox, MCP create_task).
 * Stamps `context.sharpenStartedAt` so the dispatcher skips its own pass, then
 * merges the result into a FRESH read of the task. The old synchronous version
 * held the create response for up to 60 s and then saved its stale `pending`
 * snapshot over the dispatcher's claim, so the task was claimed and run twice.
 */
export function sharpenInBackground(
  store: { getTask(id: string): Task | null; saveTask(t: Task): void },
  taskId: string,
  opts: SharpenTaskOptions
): Promise<void> {
  const fresh = store.getTask(taskId);
  if (!fresh || !shouldSharpenTask(fresh, opts.config)) return Promise.resolve();
  fresh.context = { ...(fresh.context || {}), sharpenStartedAt: new Date().toISOString() };
  store.saveTask(fresh);
  const work = structuredClone(fresh);
  return sharpenTask(work, opts).then(r => {
    if (!r.sharpened) return;
    const latest = store.getTask(taskId);
    if (!latest) return;
    mergeSharpenedContext(latest, work);
    store.saveTask(latest);
  }).catch(e => { console.error(`Sharpener: background pass for ${taskId} failed:`, e); });
}
