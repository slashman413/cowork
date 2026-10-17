import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

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

/** agy's rejection is the whole of its output (a line or two, maybe a short
 *  banner). Matching the regex anywhere would also catch a normal deliverable
 *  that merely QUOTES the error (a review/report about agy), turning its genuine
 *  verify-fail into a transient re-run — so require a short output with the
 *  error in its first lines. */
const AGY_ERROR_MAX_CHARS = 800;
const AGY_ERROR_MAX_LINES = 6;
export function isAgyModelRejection(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length > AGY_ERROR_MAX_CHARS) return false;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > AGY_ERROR_MAX_LINES) return false;
  return lines.slice(0, 3).some(l => AGY_MODEL_REJECTED_RE.test(l));
}

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; models: string[] } | null = null;
let inflight: Promise<string[] | null> | null = null;

/** Parse `agy models` output: one `<slug>\t<display name>` per line. */
export function parseAgyModels(stdout: string): string[] {
  return stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('\t'))
    .map(l => l.split('\t')[0].trim())
    .filter(s => /^[a-z0-9][a-z0-9.\-]*$/i.test(s));
}

type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/** Live agy model slugs, or null when the catalog can't be fetched. Only a
 *  non-empty listing from a run that exited on its own with code 0 is cached
 *  (a non-zero exit may have printed a partial list before failing): after a
 *  timeout (or spawn error) the child's late 'close' still fires with partial
 *  stdout, and caching that truncated list would mark valid models "retired"
 *  for CACHE_MS — so the first outcome settles the probe and later events are
 *  ignored. `spawner` is injectable for tests. */
export function listAgyModels(timeoutMs = 60000, spawner: Spawner = spawn): Promise<string[] | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.models);
  // A burst of failing agy tasks shares one `agy models` probe instead of each spawning its own.
  if (inflight) return inflight;
  inflight = new Promise<string[] | null>((resolve) => {
    let out = '';
    let settled = false;
    const settle = (models: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (models) cache = { at: Date.now(), models };
      resolve(models);
    };
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { child = spawner('agy', ['models'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    timer = setTimeout(() => { settle(null); child.kill('SIGTERM'); }, timeoutMs);
    child.stdout?.on('data', d => { if (!settled) out += d.toString(); });
    child.on('error', () => settle(null));
    child.on('close', (code: number | null) => {
      const models = code === 0 ? parseAgyModels(out) : [];
      settle(models.length ? models : null);
    });
  }).finally(() => { inflight = null; });
  return inflight;
}

/**
 * Rewrite an agy "model not recognized" failure into an actionable reason.
 * `models` is the live catalog (null = unavailable). Returns null when `text`
 * isn't that failure.
 */
export function diagnoseAgyModelFailure(model: string, text: string, models: string[] | null): string | null {
  if (!isAgyModelRejection(text)) return null;
  if (model && models && !models.includes(model)) {
    return `agy model "${model}" is retired — not in \`agy models\` (available: ${models.join(', ')}). ` +
      `Update this brain's model or re-register the agy brain client.`;
  }
  return `agy could not load its model catalog (Antigravity fetchAvailableModels failed: service overloaded / resource exhausted), ` +
    `so "${model || 'default'}" was rejected as unknown — transient, the model is ${models ? 'listed' : 'not verifiable right now'}.`;
}

/** Test hook. */
export function _resetAgyModelCache(): void { cache = null; inflight = null; }

/** Test hook: the cached catalog, if any. */
export function _agyModelCache(): string[] | null { return cache?.models ?? null; }
