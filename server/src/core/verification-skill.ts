/**
 * S1 (GitHub-trending plan, 2026-11-23): point tasks that carry a verify list
 * at obra/superpowers' `verification-before-completion` skill.
 *
 * Lean claude runs skip user skills (claude-profile.ts), so the installed skill
 * never reaches a cowork task on its own, and switching to the full profile costs
 * ~12.7k tokens per run. Instead, a task with `context.verify` gets one pointer
 * line (local agents, which can read the file) or the skill's 3-line Iron Law
 * (remote agents). Off unless `orchestration.verificationSkill.enabled` is true.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface VerificationSkillConfig {
  /** Default false. */
  enabled?: boolean;
  /** SKILL.md path; `~` expands. Default ~/.agents/skills/verification-before-completion/SKILL.md */
  path?: string;
}

export const DEFAULT_VERIFICATION_SKILL_PATH = '~/.agents/skills/verification-before-completion/SKILL.md';

/** The pstack card that covers the same ground; a task that asked for it already has it. */
const OVERLAPPING_PSTACK_SKILL = 'principle-prove-it-works';

const IRON_LAW = [
  'NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.',
  'Before claiming anything passes or is done: run the full command that proves it now, read its output and exit code, then state the claim with that evidence.',
  'If the output does not confirm it, report the actual status instead. "Should work" is not evidence.',
];

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** Prompt lines for S1, or [] when off, the task has no verify list, it already
 *  asked for the overlapping pstack card, or (local only) the skill file is missing. */
export function renderVerificationSkillPrompt(opts: {
  context: Record<string, unknown> | undefined;
  isLocal: boolean;
  cfg?: VerificationSkillConfig;
  home?: string;
}): string[] {
  if (opts.cfg?.enabled !== true) return [];
  const ctx = opts.context || {};
  const verify = ctx.verify;
  const hasVerify = typeof verify === 'string' ? verify.trim() !== ''
    : Array.isArray(verify) && verify.some(v => typeof v === 'string' && v.trim() !== '');
  if (!hasVerify) return [];
  if (ctx.skill === OVERLAPPING_PSTACK_SKILL) return [];
  if (!opts.isLocal) return [`# Before you claim completion`, ...IRON_LAW, ``];
  const file = expandHome(opts.cfg.path || DEFAULT_VERIFICATION_SKILL_PATH, opts.home ?? os.homedir());
  if (!fs.existsSync(file)) return [];
  return [`# Before you claim completion`, `Read and follow \`${file}\` before you report this task done: every completion claim needs fresh command output as evidence.`, ``];
}
