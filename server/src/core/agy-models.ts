import { spawn } from 'node:child_process';

/**
 * agy (Antigravity CLI) resolves `--model <slug>` against a model catalog it
 * fetches from the Code Assist backend (`fetchAvailableModels`) at startup. When
 * that fetch fails — a 503 "service is currently unavailable" or a 429
 * RESOURCE_EXHAUSTED — the catalog is empty and agy rejects EVERY model, valid or
 * not, with the same message:
 *
 *   invalid model selection (--model "gemini-3.8-flash-high" --effort ""):
 *   model gemini-3.8-flash-high is not recognized as a known model or custom model in settings
 *
 * That reads like a misconfigured brain, so the dispatcher handled it as an
 * ordinary failure: no rate-limit classification, no auto re-run on reset (Oct
 * 10: ~400 runs died this way during a quota exhaustion). This module tells the
 * two cases apart by asking `agy models` whether the slug exists:
 *   - listed, or the catalog is unavailable right now → transient capacity
 *     failure, worded so isRateLimitFailure() matches it;
 *   - catalog loads but the slug is missing → the model was retired upstream and
 *     the brain needs updating (see BRAIN_ID_ALIASES for renamed agy ids).
 */

export const AGY_MODEL_REJECTED_RE = /is not recognized as a known model|invalid model selection/i;

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; models: string[] } | null = null;

/** Parse `agy models` output: one `<slug>\t<display name>` per line. */
export function parseAgyModels(stdout: string): string[] {
  return stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('\t'))
    .map(l => l.split('\t')[0].trim())
    .filter(s => /^[a-z0-9][a-z0-9.\-]*$/i.test(s));
}

/** Live agy model slugs, or null when the catalog can't be fetched. Only a
 *  non-empty listing is cached, so an outage is re-checked on the next failure. */
export function listAgyModels(timeoutMs = 60000): Promise<string[] | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.models);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('agy', ['models'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(null); }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const models = parseAgyModels(out);
      if (!models.length) return resolve(null);
      cache = { at: Date.now(), models };
      resolve(models);
    });
  });
}

/**
 * Rewrite an agy "model not recognized" failure into an actionable reason.
 * `models` is the live catalog (null = unavailable). Returns null when `text`
 * isn't that failure.
 */
export function diagnoseAgyModelFailure(model: string, text: string, models: string[] | null): string | null {
  if (!AGY_MODEL_REJECTED_RE.test(text)) return null;
  if (model && models && !models.includes(model)) {
    return `agy model "${model}" is retired — not in \`agy models\` (available: ${models.join(', ')}). ` +
      `Update this brain's model or re-register the agy brain client.`;
  }
  return `agy could not load its model catalog (Antigravity fetchAvailableModels failed: service overloaded / resource exhausted), ` +
    `so "${model || 'default'}" was rejected as unknown — transient, the model is ${models ? 'listed' : 'not verifiable right now'}.`;
}

/** Test hook. */
export function _resetAgyModelCache(): void { cache = null; }
