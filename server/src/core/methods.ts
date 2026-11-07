import fs from 'fs';
import path from 'path';
import type { MethodsConfig } from '../types.js';

/**
 * Mapping of method playbook keys to their corresponding vendored pstack skill.
 * Local agents receive this path as optional reading (CONVENTIONS §6).
 */
export const VENDORED_SKILL_MAP: Record<string, string> = {
  'investigation': 'vendor/pstack/skills/how/SKILL.md',
  'bug-fix': 'vendor/pstack/skills/poteto-mode/playbooks/bug-fix.md',
  'feature': 'vendor/pstack/skills/poteto-mode/playbooks/feature.md',
  'research-report': 'vendor/pstack/skills/principle-explain-the-number/SKILL.md',
  'content': 'vendor/pstack/skills/unslop/SKILL.md',
  'ops-change': 'vendor/pstack/skills/blast-radius/SKILL.md',
  'technical-writing': 'vendor/pstack/skills/technical-writing/SKILL.md',
  'perf-issue': 'vendor/pstack/skills/poteto-mode/playbooks/perf-issue.md',
  'refactoring': 'vendor/pstack/skills/poteto-mode/playbooks/refactoring.md',
  'prototype': 'vendor/pstack/skills/poteto-mode/playbooks/prototype.md',
  'runtime-forensics': 'vendor/pstack/skills/poteto-mode/playbooks/runtime-forensics.md',
  'eval': 'vendor/pstack/skills/poteto-mode/playbooks/eval.md',
  'opening-a-pr': 'vendor/pstack/skills/poteto-mode/playbooks/opening-a-pr.md',
  'babysit': 'vendor/pstack/skills/poteto-mode/playbooks/babysit.md',
};

/** Known playbook keys — the single source for the sharpener vocabulary and UI selects. */
export const METHOD_PLAYBOOKS: readonly string[] = Object.freeze(Object.keys(VENDORED_SKILL_MAP));

/** True when `key` is a known playbook (a card in methods/ + a vendored skill). */
export function isKnownPlaybook(key: unknown): key is string {
  return typeof key === 'string' && METHOD_PLAYBOOKS.includes(key);
}

/**
 * Check whether a method card should be injected.
 * Requires orchestration.methods.enabled === true AND orchestration.methods.cards[key] === 'on'.
 * Cards default to 'shadow' (not injected) until an eval shows a positive delta.
 */
export function isMethodCardActive(methodsCfg: MethodsConfig | undefined, playbook: string | undefined): boolean {
  if (!methodsCfg?.enabled || !playbook) return false;
  return methodsCfg.cards?.[playbook] === 'on';
}

/**
 * Read the method card markdown file from the methods directory.
 */
export function loadMethodCard(methodsDir: string, playbook: string): string | null {
  if (!playbook || !/^[a-z0-9-]+$/.test(playbook)) return null;
  const filePath = path.join(methodsDir, `${playbook}.md`);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Render the prompt lines for `# Method`.
 * Local agents get the path to the full vendored skill as optional reading;
 * remote agents get only the inline card (CONVENTIONS §6).
 */
export function renderMethodPrompt(options: {
  repoRoot: string;
  methodsDir: string;
  playbook: string;
  isLocal: boolean;
  methodsCfg?: MethodsConfig;
}): string[] {
  const { repoRoot, methodsDir, playbook, isLocal, methodsCfg } = options;
  if (!isMethodCardActive(methodsCfg, playbook)) return [];

  const card = loadMethodCard(methodsDir, playbook);
  if (!card) return [];

  const lines: string[] = [
    `# Method`,
    card,
  ];

  if (isLocal) {
    const relPath = VENDORED_SKILL_MAP[playbook];
    if (relPath) {
      const fullPath = path.join(repoRoot, relPath);
      if (fs.existsSync(fullPath)) {
        lines.push(
          ``,
          `Optional reading (full skill): ${fullPath}`
        );
      }
    }
  }

  lines.push(``);
  return lines;
}
