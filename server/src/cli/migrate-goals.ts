/**
 * Upgrade goals/*.json to the compact record shape. One-way and idempotent; the
 * originals are copied to goals/.backup-<time>/ first. The server also runs this
 * at startup, so this CLI is only needed to upgrade a store while it is stopped.
 *
 *   npx tsx src/cli/migrate-goals.ts
 */
import { loadConfig } from '../config.js';
import { Goals } from '../core/goals.js';

const config = loadConfig();
// Migration never touches tasks.
const goals = new Goals(config, { createTask() { throw new Error('unused'); }, listTasks: () => [], getTask: () => null });
const { migrated, backupDir } = goals.migrateAll();
console.log(migrated.length ? `Migrated ${migrated.length}: ${migrated.join(', ')}\nOriginals in ${backupDir}` : 'Nothing to migrate.');
