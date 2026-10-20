/**
 * Brief contract (P0-3, ported from pstack `orchestrate` "The brief").
 *
 * A worker can't cheaply ask a question, so the brief has to carry how the work
 * will be judged. Four optional fields, all stored on `task.context` (the one
 * free-form, already-persisted bag that rerun / run-child / handover copy as-is):
 *
 *   context.acceptance  string[]   checkable "done means" criteria
 *   context.verify      string[]   commands / URLs / checks that prove them
 *   context.timeboxMin  number     minutes the worker should spend before returning partial
 *   context.scope       { write?: string[], forbid?: string[] }  paths/systems it may / must not touch
 *
 * Callers set them inside `context` on POST /api/inbox and MCP create_task;
 * workflow steps declare them at the step level and expansion copies them into
 * the created task's context. The dispatcher renders them as their own prompt
 * sections (renderBriefSections), never inside the raw context JSON dump.
 */
import type { TaskBrief } from '../types.js';

/** Context keys owned by the brief — the dispatcher drops these from the JSON dump. */
export const BRIEF_KEYS = ['acceptance', 'verify', 'timeboxMin', 'scope'] as const;

function stringList(v: unknown, field: string, errors: string[]): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')) {
    errors.push(`${field} must be an array of strings`);
    return undefined;
  }
  const out = arr.map(s => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Validate + normalize the brief fields of a raw object (a task context or a
 * workflow step). A lone string is accepted where a list is expected; blank
 * entries are dropped. Returns the clean brief (only present fields) and any
 * shape errors — callers decide whether an error rejects (API) or skips (load).
 */
export function parseBrief(raw: Record<string, any> | undefined, prefix = ''): { brief: TaskBrief; errors: string[] } {
  const errors: string[] = [];
  const brief: TaskBrief = {};
  if (!raw || typeof raw !== 'object') return { brief, errors };
  const acceptance = stringList(raw.acceptance, `${prefix}acceptance`, errors);
  if (acceptance) brief.acceptance = acceptance;
  const verify = stringList(raw.verify, `${prefix}verify`, errors);
  if (verify) brief.verify = verify;
  if (raw.timeboxMin !== undefined && raw.timeboxMin !== null) {
    const n = Number(raw.timeboxMin);
    if (typeof raw.timeboxMin === 'boolean' || !Number.isFinite(n) || n <= 0) errors.push(`${prefix}timeboxMin must be a positive number of minutes`);
    else brief.timeboxMin = n;
  }
  if (raw.scope !== undefined && raw.scope !== null) {
    if (typeof raw.scope !== 'object' || Array.isArray(raw.scope)) {
      errors.push(`${prefix}scope must be an object {write?: string[], forbid?: string[]}`);
    } else {
      const write = stringList(raw.scope.write, `${prefix}scope.write`, errors);
      const forbid = stringList(raw.scope.forbid, `${prefix}scope.forbid`, errors);
      if (write || forbid) brief.scope = { ...(write ? { write } : {}), ...(forbid ? { forbid } : {}) };
    }
  }
  return { brief, errors };
}

/**
 * Normalize the brief fields INSIDE a task context (no mutation of the input):
 * returns a new context with the cleaned values (absent keys removed). Throws
 * on a malformed field so POST /api/inbox and MCP create_task answer 400.
 */
export function normalizeContextBrief(ctx: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!ctx || !BRIEF_KEYS.some(k => k in ctx)) return ctx;
  const { brief, errors } = parseBrief(ctx, 'context.');
  if (errors.length) throw new Error(errors.join('; '));
  const out: Record<string, any> = { ...ctx };
  for (const k of BRIEF_KEYS) delete out[k];
  return { ...out, ...brief };
}

/** The brief prompt sections, in a fixed order. [] when the task carries none. */
export function renderBriefSections(ctx: Record<string, any> | undefined): string[] {
  const { brief } = parseBrief(ctx);
  const lines: string[] = [];
  if (brief.acceptance) {
    lines.push(`# Acceptance criteria`,
      `The task is done only when every item below holds. Check each one before you finish.`,
      ...brief.acceptance.map(a => `- [ ] ${a}`), ``);
  }
  if (brief.verify) {
    lines.push(`# How to verify`,
      `Run these checks and paste what you observed into your EVIDENCE lines.`,
      ...brief.verify.map(v => `- ${v}`), ``);
  }
  if (brief.timeboxMin) {
    lines.push(`# Timebox`,
      `Spend at most ${brief.timeboxMin} min on this task. At T-5 min, write \`progress.md\` in your artifacts dir and return what you have: emit "WAITING_ON_BACKGROUND:" if work is still running, or "STATUS: BLOCKED" with the reason. A partial result clearly marked as partial is better than none.`, ``);
  }
  if (brief.scope) {
    lines.push(`# Scope`);
    if (brief.scope.write) lines.push(`You may write to:`, ...brief.scope.write.map(w => `- ${w}`));
    if (brief.scope.forbid) lines.push(`Do NOT touch:`, ...brief.scope.forbid.map(f => `- ${f}`));
    lines.push(``);
  }
  return lines;
}
