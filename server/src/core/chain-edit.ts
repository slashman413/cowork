/**
 * One write path for every agent fallback chain the Routing and Agents pages edit:
 * the global default, per-division and per-persona overrides, the special role
 * executors (orchestrator, generalist, …) and the work-role tiers.
 *
 * Rules, shared by every chain kind so the pages stay in sync with the Agents
 * registry:
 *  - an id that is not registered is rejected;
 *  - a DISABLED agent can stay where it already is (reorder / remove keep working)
 *    but cannot be newly added — the dispatcher strips it, so adding it is a no-op
 *    that only looks like it worked;
 *  - duplicates collapse to their first position.
 */
import type { OrchestrationConfig } from '../types.js';

export const EDITABLE_TIERS = ['mechanical', 'standard', 'judgment'] as const;
export type ChainKind = 'default' | 'division' | 'persona' | 'role' | 'tier';

export class ChainEditError extends Error {}

/** Current agents of a chain (a copy), or [] when it is unset. */
export function chainOf(orch: OrchestrationConfig, kind: ChainKind, key = ''): string[] {
  switch (kind) {
    case 'default': return [...(orch.defaultChain || [])];
    case 'division': return [...(orch.divisionChains?.[key] || [])];
    case 'persona': return [...(orch.personaChains?.[key] || [])];
    case 'role': return [...(orch.roleChains?.[key]?.agents || [])];
    case 'tier': return [...(orch.tiers?.[key] || [])];
  }
}

/** Validate `agents` as the next value of a chain; returns the cleaned list. */
export function validateChain(orch: OrchestrationConfig, agents: unknown, current: string[] = []): string[] {
  if (!Array.isArray(agents) || agents.some(a => typeof a !== 'string')) {
    throw new ChainEditError('agents (string[]) required');
  }
  const reg = orch.agents || {};
  const unknown = agents.filter(id => !reg[id]);
  if (unknown.length) throw new ChainEditError(`unknown agent(s): ${unknown.join(', ')}`);
  const added = agents.filter(id => !current.includes(id) && reg[id]?.disabled);
  if (added.length) {
    throw new ChainEditError(`disabled agent(s) cannot be added: ${added.join(', ')} — enable them on the Agents page first`);
  }
  return [...new Set(agents as string[])];
}

/**
 * Replace one chain. An empty list clears a division / persona override (it falls
 * back to the division, then the default chain); default, role and tier chains
 * keep an empty list. Mutates `orch`; the caller persists.
 */
export function setChain(orch: OrchestrationConfig, kind: ChainKind, key: string, agents: unknown, description?: string): string[] {
  const next = validateChain(orch, agents, chainOf(orch, kind, key));
  switch (kind) {
    case 'default':
      orch.defaultChain = next;
      break;
    case 'division':
    case 'persona': {
      const field = kind === 'division' ? 'divisionChains' : 'personaChains';
      const map = (orch[field] ||= {});
      if (next.length) map[key] = next; else delete map[key];
      break;
    }
    case 'role': {
      if (!key) throw new ChainEditError('role name required');
      orch.roleChains ||= {};
      const prev = orch.roleChains[key];
      orch.roleChains[key] = { ...prev, description: String(description || prev?.description || key), agents: next };
      break;
    }
    case 'tier': {
      if (!(EDITABLE_TIERS as readonly string[]).includes(key)) {
        throw new ChainEditError(`tier must be one of ${EDITABLE_TIERS.join(', ')}`);
      }
      (orch.tiers ||= {})[key] = next;
      break;
    }
  }
  return next;
}
