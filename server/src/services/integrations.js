// Thin entry point for scripts / one-liners (`node -e "require('./src/services/integrations')…"`).
// The implementation is core/integrations.ts; this loads the BUILT copy (npm run build),
// bound to the live config, so it reports exactly what the running server sees.
import { loadConfig } from '../../dist/config.js';
import { sharedIntegrations, DEFAULT_INTEGRATIONS } from '../../dist/core/integrations.js';

const integrations = () => sharedIntegrations(loadConfig().integrations);

/** Status of every default integration (no network). Resolves to { ok, defaults }. */
export async function verifyDefaults() {
  const defaults = integrations().verifyDefaults();
  return { ok: defaults.every(d => d.ok), defaults };
}

/** Provision the defaults that were never seeded on this host (clones + installs). */
export async function ensureDefaults() {
  const defaults = await integrations().ensureDefaults({ log: m => console.error(m) });
  return { ok: defaults.every(d => d.ok), defaults };
}

export { DEFAULT_INTEGRATIONS };
