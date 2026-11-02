import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo-root `vendor/pstack/skills` (works from src/ under tsx and from dist/). */
export const DEFAULT_PSTACK_SKILLS_DIR = path.resolve(__dirname, '../../../vendor/pstack/skills');

/**
 * Method playbook keys a task can carry in `context.playbook` (PS-4 / G4).
 * Each key has a card in `methods/<key>.md`. The dashboard Create form's
 * "Method" select and the `/pstack` command both draw from this list.
 */
export const PLAYBOOK_KEYS = [
  'investigation', 'bug-fix', 'feature', 'research-report', 'content', 'ops-change',
  'technical-writing', 'perf-issue', 'refactoring', 'prototype', 'runtime-forensics',
  'eval', 'opening-a-pr', 'babysit',
] as const;

export type PlaybookKey = typeof PLAYBOOK_KEYS[number];

export function isPlaybookKey(k: unknown): k is PlaybookKey {
  return typeof k === 'string' && (PLAYBOOK_KEYS as readonly string[]).includes(k);
}

export type PstackParse =
  | { ok: true; playbook?: PlaybookKey; skill?: string; text: string }
  | { ok: false; error: string };

/**
 * Parse `/pstack <name> <text>` (G9). Returns null when `input` is not a
 * /pstack command. A known playbook key wins over a same-named skill; otherwise
 * `<name>` must be a vendored skill dir with a SKILL.md.
 */
export function parsePstackCommand(input: string, skillsDir: string = DEFAULT_PSTACK_SKILLS_DIR): PstackParse | null {
  if (typeof input !== 'string') return null;
  const m = /^\s*\/pstack(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/.exec(input);
  if (!m) return null;
  const name = (m[1] || '').trim();
  const text = (m[2] || '').trim();
  if (!name) return { ok: false, error: 'usage: /pstack <playbook|skill> <text>' };
  if (!text) return { ok: false, error: `usage: /pstack ${name} <text> — the task text is missing` };
  if (isPlaybookKey(name)) return { ok: true, playbook: name, text };
  if (/^[a-z0-9-]+$/.test(name) && fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) {
    return { ok: true, skill: name, text };
  }
  return { ok: false, error: `unknown pstack playbook or skill: ${name}` };
}

/**
 * Apply a `/pstack` prefix found in a task's description (or title) to a
 * create-task input: strips the command, sets context.playbook / context.skill.
 * Throws on a malformed /pstack command so the caller can 400.
 */
export function applyPstackCommand<T extends { title: string; description: string; context?: Record<string, any> }>(
  input: T, skillsDir?: string,
): T {
  for (const field of ['description', 'title'] as const) {
    const parsed = parsePstackCommand(input[field], skillsDir);
    if (!parsed) continue;
    if (!parsed.ok) throw new Error(parsed.error);
    const context = { ...(input.context || {}) };
    if (parsed.playbook) context.playbook = parsed.playbook;
    if (parsed.skill) context.skill = parsed.skill;
    const out = { ...input, context, [field]: parsed.text };
    if (field === 'title' && !input.description) out.description = parsed.text;
    return out;
  }
  return input;
}
