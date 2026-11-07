#!/usr/bin/env node
// One-shot migration of persisted state to the agent naming (2026-11). Run it with the
// server STOPPED: a live server would overwrite the result. Safe to run twice.
//
//   node scripts/migrate-agent-naming.mjs [--repo <dir>] [--config <file>] [--dry-run]
//
// Old vocabulary → new:
//   brain  → agent    (context.brain, orchestration.brains, chains, usage, lessons…)
//   agent  → persona  (context.agent, ranAgent, agentChains: a roster slug)
//   orchestration.agents → orchestration.roleChains  (named role → agent chain)
//   agents.json / agentName → workers.json / workerName  (a connected client)
//   x-high / x-medium / x-low → agent x + context.thinking
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg('--repo', path.join(path.dirname(new URL(import.meta.url).pathname), '..')));
const CONFIG = path.resolve(arg('--config', process.env.COWORK_CONFIG || path.join(os.homedir(), '.cowork', 'config.json')));
const DRY = process.argv.includes('--dry-run');

const LEVEL = /-(low|medium|high)$/;
const ID = /^(local|remote)-[A-Za-z0-9.{}<>-]+$/;
const isId = (s) => typeof s === 'string' && ID.test(s);
const stripId = (s) => (isId(s) ? s.replace(LEVEL, '') : s);
const renameKey = (k) => (/^[A-Za-z_]+$/.test(k) ? k.replace(/brain/g, 'agent').replace(/Brain/g, 'Agent') : k);
const count = {};
const bump = (k, n = 1) => { count[k] = (count[k] || 0) + n; };

/** Rename keys and strip level suffixes from ids, everywhere below `o`. */
function walk(o) {
  if (Array.isArray(o)) {
    const mapped = o.map(walk);
    if (mapped.length && mapped.every(isId)) return [...new Set(mapped)];   // a chain: x-high + x-low → x
    return mapped;
  }
  if (o && typeof o === 'object') {
    const hasOld = 'brain' in o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (hasOld && k === 'agent') { out.persona = v; continue; }           // {agent, brain} → {persona, agent}
      if (k === 'ranAgent' && 'ranBrain' in o) { out.ranPersona = v; continue; }
      if (k === 'type' && v === 'brain-available') { out.type = 'agent-available'; continue; }
      out[renameKey(k)] = walk(v);
    }
    return out;
  }
  return stripId(o);
}

/** A task context, a recipe's carry, or anything else where `agent` means the persona slug. */
function migrateContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const level = typeof ctx.brain === 'string' ? LEVEL.exec(ctx.brain)?.[1] : (isId(ctx.agent) ? LEVEL.exec(ctx.agent)?.[1] : undefined);
  const c = { ...ctx };
  if (typeof c.persona === 'string' && c.personaPrompt === undefined && (c.persona.includes('\n') || c.persona.length > 80)) {
    c.personaPrompt = c.persona; delete c.persona;                          // the stamped prompt text
  }
  if ('agentName' in c) { c.personaName = c.agentName; delete c.agentName; }
  if (typeof c.agent === 'string' && !isId(c.agent)) {                      // old persona slug
    if (c.persona === undefined) c.persona = c.agent;
    delete c.agent;
  }
  if (typeof c.ranAgent === 'string' && !isId(c.ranAgent)) { c.ranPersona = c.ranAgent; delete c.ranAgent; }
  const out = walk(c);
  if (level && out.thinking === undefined) out.thinking = level;
  return out;
}

function migrateTask(t) {
  const { context, carry, ...rest } = t;
  const from = rest.from, to = rest.to;                                     // from/to.agent keep their meaning
  const out = walk(rest);
  if (from) out.from = from;
  if (to) out.to = to;
  if (context) out.context = migrateContext(context);
  if (carry) out.carry = migrateContext(carry);
  return out;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function write(f, text) {
  if (DRY) return;
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}
const writeJson = (f, o) => write(f, JSON.stringify(o, null, 2) + '\n');

function migrateDir(dir, fn, label) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const f = path.join(dir, name);
    let before;
    try { before = fs.readFileSync(f, 'utf8'); JSON.parse(before); } catch { bump(`${label}:unreadable`); continue; }
    const after = JSON.stringify(fn(JSON.parse(before)), null, 2) + '\n';
    if (after !== before) { write(f, after); bump(label); }
  }
}

function migrateConfig(file) {
  const c = readJson(file);
  const o = c.orchestration || {};
  if (o.brains || o.agentChains || (o.agents && Object.values(o.agents).some(a => a && Array.isArray(a.brains)))) {
    // A new server run on the old config before this migration can have written empty
    // roleChains/personaChains, and registered clients' agents among the role chains.
    const registry = {};
    const roleChains = { ...(o.roleChains || {}) };
    for (const [k, v] of Object.entries(o.agents || {})) {
      if (v && Array.isArray(v.brains ?? v.agents)) roleChains[k] = v; else registry[k] = v;
    }
    delete o.agents;
    o.roleChains = roleChains;
    if (o.agentChains) { o.personaChains = { ...o.agentChains, ...(o.personaChains || {}) }; delete o.agentChains; }
    for (const [id, a] of Object.entries(o.brains || {})) {
      const canon = stripId(id);
      if (registry[canon]) { bump('config:merged-agents'); continue; }      // x-high, x-medium, x-low → first wins
      const { effort, clientId, ...entry } = a;
      if (effort) entry.thinking = effort;
      if (entry.exec === 'agy' && typeof entry.model === 'string') entry.model = entry.model.replace(LEVEL, '');
      if (typeof entry.description === 'string') {
        entry.description = entry.description.replace(/-(?:low|medium|high)( \(auto-registered)/, '$1').replace(/brains/g, 'agents').replace(/brain/g, 'agent');
      }
      registry[canon] = entry;
    }
    delete o.brains;
    for (const [k, v] of Object.entries(walk(o))) { delete o[k]; o[k] = v; }
    for (const k of Object.keys(o)) if (/[bB]rain/.test(k)) delete o[k];
    for (const k of Object.keys(o)) {                                       // config's own prose comments
      if (/_comment$/.test(k) && typeof o[k] === 'string') {
        o[k] = o[k].replace(/\bbrains\b/g, 'agents').replace(/\bbrain\b/g, 'agent').replace(/defaultBrainConcurrency/g, 'defaultAgentConcurrency').replace(/-(?:brain)\b/g, '-agent');
      }
    }
    o.agents = registry;
    if (!o.defaultThinking) o.defaultThinking = 'medium';
    c.orchestration = o;
    for (const k of Object.keys(c)) if (k !== 'orchestration') c[k] = walk(c[k]);
    writeJson(file, c);
    bump('config');
  }
}

/** A rename + rewrite under .status/ (old file wins only if the new one isn't there yet). */
function migrateStatus(dir, oldName, newName, fn) {
  const src = path.join(dir, oldName), dst = path.join(dir, newName);
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) { bump(`status:${oldName}:kept-existing`); return; }
  writeJson(dst, fn(readJson(src)));
  if (!DRY) fs.unlinkSync(src);
  bump(`status:${newName}`);
}

function mergeById(map) {
  const out = {};
  for (const [id, v] of Object.entries(map || {})) {
    const canon = stripId(id);
    if (!(canon in out)) out[canon] = v;
    else if (typeof v === 'number' && v > out[canon]) out[canon] = v;
  }
  return out;
}

function migrateLines(file, fn) {
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.split('\n').map(l => {
    if (!l.trim()) return l;
    try { return JSON.stringify(fn(JSON.parse(l))); } catch { return l; }
  }).join('\n');
  if (after !== before) { write(file, after); bump(path.basename(file)); }
}

migrateConfig(CONFIG);
migrateDir(path.join(REPO, 'inbox'), migrateTask, 'tasks');
migrateDir(path.join(REPO, 'goals'), walk, 'goals');
migrateDir(path.join(REPO, 'recipes'), migrateTask, 'recipes');
for (const entry of fs.existsSync(path.join(REPO, 'recipes')) ? fs.readdirSync(path.join(REPO, 'recipes')) : []) {
  migrateDir(path.join(REPO, 'recipes', entry, 'versions'), migrateTask, 'recipe-versions');
}

const status = path.join(REPO, '.status');
migrateStatus(status, 'agents.json', 'workers.json', list => (Array.isArray(list) ? list : []).map(({ agentName, ...w }) => ({ ...w, workerName: w.workerName ?? agentName })));
migrateStatus(status, 'brain-cooldowns.json', 'agent-cooldowns.json', mergeById);
migrateStatus(status, 'brain-usage.json', 'agent-usage.json', mergeById);

const decisions = path.join(REPO, 'decisions');
migrateLines(path.join(decisions, 'lessons.jsonl'), l => walk(l));
const rulings = path.join(decisions, 'rulings.tsv');
if (fs.existsSync(rulings)) {
  const before = fs.readFileSync(rulings, 'utf8');
  const after = before.replace(/^date\tid\tagent\tbrain\truling/m, 'date\tid\tpersona\tagent\truling').replace(/^date\ttask\tagent\tbrain\truling/m, 'date\ttask\tpersona\tagent\truling')
    .split('\n').map(l => { const c = l.split('\t'); if (c.length > 3) c[3] = stripId(c[3]); return c.join('\t'); }).join('\n');
  if (after !== before) { write(rulings, after); bump('rulings.tsv'); }
}

console.log(JSON.stringify({ dryRun: DRY, repo: REPO, config: CONFIG, migrated: count }, null, 2));
