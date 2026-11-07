import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { normalizeThinking, splitThinkingSuffix } from './core/thinking.js';

/**
 * Old-contract clients. The retired names live in ../legacy-aliases.json, not in
 * code, and this is the only reader. Everything an old client sends is translated
 * at the door, so the rest of the server only ever sees the current contract.
 */
interface LegacyAliases {
  contextKey: string;
  contextKeys: Record<string, string>;
  bodyKeys: Record<string, string>;
  routes: Record<string, string>;
  registerKey: string;
}
const legacy: LegacyAliases = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../legacy-aliases.json', import.meta.url)), 'utf-8'));

/** The retired name of register_agent's agents array. */
export const LEGACY_REGISTER_KEY = legacy.registerKey;

const AGENT_ID_RE = /^(local|remote)-/;
const uses = { context: 0, body: 0, route: 0, register: 0 };
export function legacyWireUses() { return { ...uses }; }
export function noteLegacyRegister() { uses.register++; }

/**
 * Bring a task context to the current contract. Safe to run on an already current one.
 * - The retired pin key moves to `agent`, and whatever `agent` held was the persona.
 * - A bare `agent` that isn't an agent id is an old client naming a persona.
 * - A level left in the id moves to `thinking`, unless one was set explicitly.
 */
export function normalizeTaskContext(ctx: Record<string, any> | undefined, isAgent: (id: string) => boolean = () => false): Record<string, any> | undefined {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const out: Record<string, any> = { ...ctx };
  if (legacy.contextKey in out) {
    uses.context++;
    const pin = out[legacy.contextKey];
    delete out[legacy.contextKey];
    if (typeof out.agent === 'string' && out.agent && out.persona === undefined) out.persona = out.agent;
    delete out.agent;
    if (pin !== undefined && pin !== null) out.agent = pin;
  } else if (typeof out.agent === 'string' && out.agent && out.persona === undefined && !AGENT_ID_RE.test(out.agent) && !isAgent(out.agent)) {
    uses.context++;
    out.persona = out.agent;
    delete out.agent;
  }
  for (const [from, to] of Object.entries(legacy.contextKeys)) {
    if (from in out) { out[to] = out[from]; delete out[from]; }
  }
  if (typeof out.agent === 'string') {
    const { base, level } = splitThinkingSuffix(out.agent);
    if (level && AGENT_ID_RE.test(base)) {
      out.agent = base;
      if (out.thinking === undefined) out.thinking = level;
    }
  }
  if ('thinking' in out) {
    const level = normalizeThinking(out.thinking);
    if (level) out.thinking = level; else delete out.thinking;
  }
  return out;
}

/** Express middleware: retired routes and top-level body keys → current names. */
export function legacyWireMiddleware(req: Request, _res: Response, next: NextFunction): void {
  for (const [from, to] of Object.entries(legacy.routes)) {
    if (req.url === from || req.url.startsWith(from + '/') || req.url.startsWith(from + '?')) {
      req.url = to + req.url.slice(from.length);
      uses.route++;
      break;
    }
  }
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [from, to] of Object.entries(legacy.bodyKeys)) {
      if (from in body) {
        if (!(to in body)) body[to] = body[from];
        delete body[from];
        uses.body++;
      }
    }
  }
  next();
}

/** A worker view of a task an old client can still read. */
export function withLegacyPin<T extends { context?: Record<string, any> }>(task: T): T {
  const id = task?.context?.agent;
  if (typeof id !== 'string') return task;
  return { ...task, context: { ...task.context, [legacy.contextKey]: id } };
}
