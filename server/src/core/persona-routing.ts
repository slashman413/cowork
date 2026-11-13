import type { AgentConfig } from '../types.js';

/**
 * Persona routing for pinned agents.
 *
 * An unpinned task always goes through the two-stage router (division → persona).
 * A task PINNED to an agent used to skip it and run with no persona at all. Frontier
 * models cope with a bare brief; a small local model (qwen3.8-27b, …) does much
 * better with a specialist persona framing the job. So when the pinned agent runs a
 * small model, the dispatcher routes the task first (the router only writes
 * context.persona/division + work role; the agent pin is untouched) and then runs it
 * on the pinned agent with that persona.
 *
 * Per-agent override: AgentConfig.personaRouting = 'always' | 'never'.
 */

/** Models at or under this many billion parameters count as "small". */
export const SMALL_MODEL_MAX_B = 70;

/** Parameter count in billions parsed from a model id ("qwen3.8-27b" → 27), or null. */
export function modelParamsB(model: string | undefined): number | null {
  const ms = [...String(model || '').matchAll(/(?<![\d.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi)];
  if (!ms.length) return null;
  const n = Number(ms[ms.length - 1][1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether a task pinned to this agent should still get a router-picked persona. */
export function wantsPersonaRouting(agent: Pick<AgentConfig, 'model' | 'personaRouting'> | undefined): boolean {
  if (!agent) return false;
  if (agent.personaRouting === 'always') return true;
  if (agent.personaRouting === 'never') return false;
  const b = modelParamsB(agent.model);
  return b !== null && b <= SMALL_MODEL_MAX_B;
}
