import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Config, Task, GoalRecord } from '../types.js';

/**
 * Voice assistant — a spoken thinking partner on the Chat page that takes a new
 * idea from "fuzzy" to "done" in three gated phases:
 *
 *   1. GRILLING   — the brain runs the grill-me (/grilling) skill: one question
 *                   at a time, each with a recommended answer, until zero
 *                   ambiguity remains.
 *   2. PLAN-READY — it presents a concrete plan (binary success criterion +
 *                   kebab-case phases) and asks for permission.
 *   3. EXECUTING  — ONLY after the user approves (button, or a clear spoken
 *                   "go ahead" while a plan is on the table) the plan becomes an
 *                   active Goal, which the dispatcher's Achiever/Judger loop
 *                   drives — emitting tasks to the company — until the success
 *                   criterion is met (→ DONE).
 *
 * Every turn is a real task (tags chat+voice) PINNED to the best available brain:
 * enabled, not cooling down on a rate limit, ranked by capability. Turns carry
 * context.conversational so the dispatcher treats a question as a complete reply
 * (never parked on wait-input). If a turn's brain gets rate-limited, the turn is
 * moved/retried on the next available brain.
 *
 * State is filesystem JSON (voice-sessions/<id>.json beside goals/), like
 * inbox/, goals/ and workflow-runs/.
 */

export type VoicePhase = 'grilling' | 'plan-ready' | 'executing' | 'done';

export interface VoicePlanPhase { key: string; title: string; detail?: string }
export interface VoicePlan {
  title: string;
  summary: string;
  deliverable?: string;
  successCriteria: string;
  phases: VoicePlanPhase[];
}

export interface VoiceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  taskId?: string;
  brain?: string;
}

export interface VoiceSession {
  id: string;
  title: string;
  phase: VoicePhase;
  messages: VoiceMessage[];
  /** Open questions the assistant still sees (last reported). */
  ambiguities: string[];
  plan?: VoicePlan;
  /** The in-flight turn, if any. `tried` = brains already attempted for it. */
  pending?: { taskId: string; brain: string; tried: string[]; startedAt: string };
  goalId?: string;
  /** Last goal progress fingerprint, so status changes are announced once. */
  goalSnapshot?: string;
  createdAt: string;
  updatedAt: string;
}

/** The slice of Store the assistant touches (structural, so tests can fake it). */
export interface VoiceStore {
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task;
  getTask(id: string): Task | null;
  saveTask(task: Task): void;
  deleteTask?(id: string): unknown;
  brainCooldownUntil(brainId: string): string | undefined;
  getActiveAgents(): Array<{ capabilities?: string[]; lastHeartbeat: string }>;
}

/** The slice of Goals the assistant touches. */
export interface VoiceGoals {
  create(input: {
    title: string; description?: string; successCriteria: string; reportBrief?: string;
    phases?: { key: string; title: string }[]; achieverBrainChain?: string[]; judgerBrainChain?: string[]; stepBudget?: number;
  }): GoalRecord;
  activate(goalId: string): GoalRecord;
  get(goalId: string): GoalRecord | null;
}

export interface BrainChoice { id: string; exec: string; model: string; location: string }

/** Higher = more capable for open-ended reasoning. Unknown execs rank lowest. */
const EXEC_RANK: Record<string, number> = { claude: 6, codex: 5, agy: 4, hermes: 3, dsh: 3, ollama: 1 };
const RUNNABLE_EXECS = new Set(Object.keys(EXEC_RANK));
/** A turn is abandoned (with an honest error) after this many brains failed it. */
const MAX_TURN_BRAINS = 3;

/** Built-in copy of the grill-me → /grilling skill, used when the skill file is
 *  not installed on this host. */
const GRILLING_FALLBACK = `Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.`;

/** Load the grill-me skill's instructions (grill-me delegates to /grilling). */
export function loadGrillingSkill(home = os.homedir()): string {
  const candidates = [
    path.join(home, '.claude', 'skills', 'grilling', 'SKILL.md'),
    path.join(home, '.agents', 'skills', 'grilling', 'SKILL.md'),
  ];
  for (const f of candidates) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const body = raw.replace(/^---[\s\S]*?\n---\s*\n/, '').trim();   // drop frontmatter
      if (body) return body;
    } catch { /* not installed here */ }
  }
  return GRILLING_FALLBACK;
}

/** Parsed brain reply: the spoken part + the machine-readable state block. */
export interface ParsedReply {
  speech: string;
  state: {
    phase?: 'grilling' | 'plan-ready';
    ambiguities?: string[];
    plan?: VoicePlan | null;
    userApproved?: boolean;
  } | null;
}

/** Split a brain reply into speech and its trailing ```voice-state JSON block.
 *  Tolerant: accepts a ```json block carrying "phase", or a bare trailing JSON
 *  object; with no parsable block the whole text is speech and state is null. */
export function parseVoiceReply(text: string): ParsedReply {
  const raw = String(text || '').trim();
  const fence = /```(?:voice-state|json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: { start: number; end: number; json: string } | null = null;
  while ((m = fence.exec(raw))) {
    if (/"phase"\s*:/.test(m[1])) last = { start: m.index, end: m.index + m[0].length, json: m[1] };
  }
  if (!last) {
    // Bare trailing object, e.g. a brain that dropped the fence.
    const i = raw.lastIndexOf('\n{');
    if (i >= 0 && /"phase"\s*:/.test(raw.slice(i))) last = { start: i, end: raw.length, json: raw.slice(i) };
  }
  if (!last) return { speech: cleanSpeech(raw), state: null };
  let state: ParsedReply['state'] = null;
  try { state = JSON.parse(last.json.trim()); } catch { state = null; }
  const speech = cleanSpeech(raw.slice(0, last.start) + raw.slice(last.end));
  return { speech: speech || (state ? '' : cleanSpeech(raw)), state };
}

function cleanSpeech(s: string): string {
  return s.replace(/^\s*(NEEDS[_ -]?INPUT|WAITING[_ -]ON[_ -]BACKGROUND)\s*:?/gim, '').trim();
}

/** Coerce a brain-proposed plan into a valid one, or null when unusable. */
export function normalizePlan(p: any): VoicePlan | null {
  if (!p || typeof p !== 'object') return null;
  const title = String(p.title || '').trim();
  const successCriteria = String(p.successCriteria || '').trim();
  const seen = new Set<string>();
  const phases: VoicePlanPhase[] = [];
  for (const ph of Array.isArray(p.phases) ? p.phases : []) {
    const t = String(ph?.title || '').trim();
    let key = String(ph?.key || t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!key || !t) continue;
    while (seen.has(key)) key += '-x';
    seen.add(key);
    phases.push({ key, title: t, ...(ph.detail ? { detail: String(ph.detail).trim() } : {}) });
  }
  if (!title || !successCriteria || !phases.length) return null;
  return {
    title,
    summary: String(p.summary || '').trim(),
    ...(p.deliverable ? { deliverable: String(p.deliverable).trim() } : {}),
    successCriteria,
    phases,
  };
}

/** Does the user's text approve a plan? Used only as a guard alongside the
 *  brain's own userApproved flag — never on its own. */
export function looksLikeApproval(text: string): boolean {
  const t = String(text || '').toLowerCase();
  if (/\b(no|not yet|don'?t|do not|wait|hold on|change|instead|but)\b/.test(t) || /不|別|等等|等一下|改/.test(t)) return false;
  return /\b(yes|yep|yeah|sure|ok(ay)?|go( ahead| for it)?|do it|approve[d]?|execute|start|proceed|ship it|sounds good|let'?s go|make it so)\b/.test(t)
    || /好|可以|開始|执行|執行|同意|沒問題|没问题|批准|進行|进行/.test(t);
}

export class VoiceAssistant {
  constructor(
    private config: Config,
    private store: VoiceStore,
    private goals: VoiceGoals,
    private kick: () => void = () => {},
    private home: string = os.homedir(),
  ) {}

  // ── Persistence ─────────────────────────────────────────────────────────────

  private dir(): string {
    const d = path.join(path.dirname(this.config.paths.goals), 'voice-sessions');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private file(id: string): string {
    if (!/^v-[a-z0-9-]+$/.test(id)) throw new Error('invalid session id');
    return path.join(this.dir(), `${id}.json`);
  }

  private save(s: VoiceSession): VoiceSession {
    s.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file(s.id), JSON.stringify(s, null, 2));
    return s;
  }

  private load(id: string): VoiceSession | null {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  list(): Array<Pick<VoiceSession, 'id' | 'title' | 'phase' | 'goalId' | 'createdAt' | 'updatedAt'> & { messages: number }> {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir()).filter(f => f.endsWith('.json')); } catch { /* none */ }
    return files.map(f => this.load(f.slice(0, -5))).filter((s): s is VoiceSession => !!s)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(s => ({ id: s.id, title: s.title, phase: s.phase, goalId: s.goalId, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages.length }));
  }

  create(title?: string): VoiceSession {
    const now = new Date().toISOString();
    return this.save({
      id: 'v-' + uuidv4().slice(0, 12), title: String(title || '').trim().slice(0, 80) || 'New idea',
      phase: 'grilling', messages: [], ambiguities: [], createdAt: now, updatedAt: now,
    });
  }

  delete(id: string): void {
    const s = this.load(id);
    if (!s) throw new Error('session not found');
    if (s.pending) this.store.deleteTask?.(s.pending.taskId);
    fs.unlinkSync(this.file(id));
  }

  // ── Brain selection ───────────────────────────────────────────────────────────

  /** Brains that can take a turn RIGHT NOW: enabled, a runnable exec, not cooling
   *  down on a rate limit, and (for remote brains) advertised by a live client.
   *  Order: orchestration.voice.brains (if set) first, then capability rank, then
   *  the default chain order. */
  availableBrains(): { available: BrainChoice[]; cooling: Array<{ id: string; until: string }> } {
    const orch = this.config.orchestration;
    const brains = orch.brains || {};
    const pref: string[] = ((orch as any).voice?.brains as string[]) || [];
    const chain = orch.defaultChain || [];
    const liveCaps = new Set<string>();
    for (const a of this.store.getActiveAgents()) {
      if (Date.now() - new Date(a.lastHeartbeat).getTime() < 600_000) for (const c of a.capabilities || []) liveCaps.add(c);
    }
    const available: BrainChoice[] = [];
    const cooling: Array<{ id: string; until: string }> = [];
    for (const [id, b] of Object.entries(brains)) {
      if (b.disabled) continue;
      const exec = b.exec || '';
      if (!RUNNABLE_EXECS.has(exec)) continue;
      if (b.location === 'remote' && !liveCaps.has(id)) continue;
      const until = this.store.brainCooldownUntil(id);
      if (until) { cooling.push({ id, until }); continue; }
      available.push({ id, exec, model: b.model || '', location: b.location });
    }
    const idx = (arr: string[], id: string) => { const i = arr.indexOf(id); return i < 0 ? 1e6 : i; };
    available.sort((a, b) =>
      idx(pref, a.id) - idx(pref, b.id)
      || (EXEC_RANK[b.exec] || 0) - (EXEC_RANK[a.exec] || 0)
      || (a.location === 'local' ? 0 : 1) - (b.location === 'local' ? 0 : 1)
      || idx(chain, a.id) - idx(chain, b.id)
      || a.id.localeCompare(b.id));
    return { available, cooling };
  }

  private pickBrain(exclude: string[] = []): BrainChoice | null {
    return this.availableBrains().available.find(b => !exclude.includes(b.id)) || null;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────────

  /** Send the user's message (typed or transcribed speech). Returns at once; the
   *  reply lands via get()/reconcile once the brain's task completes. */
  turn(id: string, text: string): VoiceSession {
    const s = this.load(id);
    if (!s) throw new Error('session not found');
    const msg = String(text || '').trim();
    if (!msg) throw new Error('text is required');
    this.reconcile(s);
    if (s.pending) throw Object.assign(new Error('the assistant is still thinking about your last message'), { status: 409 });
    if (!s.messages.some(m => m.role === 'user')) s.title = msg.replace(/\s+/g, ' ').slice(0, 80);
    s.messages.push({ role: 'user', content: msg, at: new Date().toISOString() });
    const brain = this.pickBrain();
    if (!brain) {
      s.messages.push({ role: 'system', content: 'No brain is available right now — every enabled brain is disabled or cooling down on a rate limit. Try again when one resets.', at: new Date().toISOString() });
      return this.save(s);
    }
    this.enqueue(s, brain, []);
    return this.save(s);
  }

  private enqueue(s: VoiceSession, brain: BrainChoice, tried: string[]): void {
    const task = this.store.createTask({
      title: `🎙 Voice: ${s.title}`.slice(0, 90),
      description: this.buildPrompt(s),
      from: { platform: 'voice', agent: 'dashboard' },
      to: {},
      priority: 'high',
      context: { brain: brain.id, conversational: true, voiceSessionId: s.id },
      tags: ['chat', 'voice'],
    } as any);
    s.pending = { taskId: task.id, brain: brain.id, tried: [...tried, brain.id], startedAt: new Date().toISOString() };
    this.kick();
  }

  /** Fetch a session, folding in a finished turn / goal progress first. */
  get(id: string): (VoiceSession & { goal?: ReturnType<VoiceAssistant['goalView']> }) | null {
    const s = this.load(id);
    if (!s) return null;
    const changed = this.reconcile(s);
    if (changed) this.save(s);
    return { ...s, ...(s.goalId ? { goal: this.goalView(s.goalId) } : {}) };
  }

  /** Advance a session from the world's state. Returns true when it changed. */
  reconcile(s: VoiceSession): boolean {
    let changed = false;
    if (s.pending) changed = this.reconcileTurn(s) || changed;
    if (s.goalId && (s.phase === 'executing' || s.phase === 'done')) changed = this.reconcileGoal(s) || changed;
    return changed;
  }

  private reconcileTurn(s: VoiceSession): boolean {
    const p = s.pending!;
    const task = this.store.getTask(p.taskId);
    const now = new Date().toISOString();
    if (!task) {
      delete s.pending;
      s.messages.push({ role: 'system', content: 'That turn was cancelled (its task was deleted). Say it again when ready.', at: now });
      return true;
    }
    if (task.status === 'pending' || task.status === 'claimed') {
      // The pinned brain started cooling on a rate limit before it ran → move the
      // turn to the next available brain instead of waiting for the reset.
      const pinned = String(task.context?.brain || '');
      if (task.status === 'pending' && pinned && this.store.brainCooldownUntil(pinned)) {
        const next = this.pickBrain(p.tried);
        if (next) {
          task.context = { ...(task.context || {}), brain: next.id };
          this.store.saveTask(task);
          p.brain = next.id;
          p.tried = [...p.tried, next.id];
          this.kick();
          return true;
        }
      }
      return false;
    }
    if (task.status === 'in-progress') return false;
    // Anything else is finished (done/rejected — or wait-input, which conversational
    // turns never hit; if one does, its question is still the reply).
    const result = String(task.result || '');
    const failed = task.status === 'rejected' || (task as any).failed === true;
    if (failed) {
      const next = p.tried.length < MAX_TURN_BRAINS ? this.pickBrain(p.tried) : null;
      if (next) {
        // Retry the same turn on the next brain (the failed one is usually cooling now).
        this.enqueue(s, next, p.tried);
        return true;
      }
      delete s.pending;
      s.messages.push({ role: 'system', content: `The assistant couldn't answer (${p.tried.join(' → ')} failed): ${result.slice(0, 300) || 'no output'}`, at: now, taskId: task.id });
      return true;
    }
    delete s.pending;
    const prevPhase = s.phase;
    const { speech, state } = parseVoiceReply(result);
    const ranBrain = String(task.context?.ranBrain || p.brain);
    s.messages.push({ role: 'assistant', content: speech || '(no reply)', at: now, taskId: task.id, brain: ranBrain });
    if (state && (prevPhase === 'grilling' || prevPhase === 'plan-ready')) {
      if (Array.isArray(state.ambiguities)) s.ambiguities = state.ambiguities.map(String).slice(0, 20);
      const plan = normalizePlan(state.plan);
      if (state.phase === 'plan-ready' && plan) {
        s.plan = plan;
        s.phase = 'plan-ready';
      } else if (state.phase === 'grilling') {
        s.phase = 'grilling';   // user asked for changes → back to questions; old plan kept for reference
      }
      // Execute ONLY on an explicit go-ahead to a plan that was ALREADY on the
      // table before this turn — the brain's flag AND the user's own words agree.
      const lastUser = [...s.messages].reverse().find(m => m.role === 'user')?.content || '';
      if (state.userApproved === true && prevPhase === 'plan-ready' && s.plan && looksLikeApproval(lastUser)) {
        try { this.startExecution(s); }
        catch (e: any) { s.messages.push({ role: 'system', content: `Couldn't start execution: ${e.message}`, at: now }); }
      }
    }
    return true;
  }

  // ── Execution ─────────────────────────────────────────────────────────────────

  /** User-permitted execution (Approve button). */
  execute(id: string): VoiceSession {
    const s = this.load(id);
    if (!s) throw new Error('session not found');
    this.reconcile(s);
    if (s.goalId) throw new Error('this plan is already executing');
    if (!s.plan || s.phase !== 'plan-ready') throw new Error('there is no agreed plan yet — finish answering the questions first');
    this.startExecution(s);
    return this.save(s);
  }

  private startExecution(s: VoiceSession): void {
    const plan = s.plan!;
    const brains = this.availableBrains().available.map(b => b.id);
    const goal = this.goals.create({
      title: plan.title,
      description: this.goalDescription(s),
      successCriteria: plan.successCriteria,
      reportBrief: 'What was produced in this phase, where the deliverables are (artifact/output paths), what was verified and how, and any risks or open issues.',
      phases: plan.phases.map(p => ({ key: p.key, title: p.title })),
      ...(brains.length ? { achieverBrainChain: brains, judgerBrainChain: brains } : {}),
      stepBudget: Math.max(24, plan.phases.length * 8),
    });
    this.goals.activate(goal.goalId);
    s.goalId = goal.goalId;
    s.phase = 'executing';
    s.messages.push({
      role: 'assistant',
      content: `Approved. I've started executing "${plan.title}" as goal ${goal.goalId} with ${plan.phases.length} phase${plan.phases.length === 1 ? '' : 's'}. I'll keep you posted as each phase completes.`,
      at: new Date().toISOString(),
    });
    this.kick();
  }

  private goalDescription(s: VoiceSession): string {
    const plan = s.plan!;
    const qa = s.messages.filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'CEO' : 'Assistant'}: ${m.content}`).join('\n');
    return [
      `Origin: an idea the CEO worked through with the voice assistant (session ${s.id}). Every ambiguity was resolved with the CEO before this plan was approved — honour those decisions; do not re-ask them.`,
      ``,
      `## Plan summary`, plan.summary || plan.title,
      ...(plan.deliverable ? [``, `## Final deliverable`, plan.deliverable] : []),
      ``, `## Phases`,
      ...plan.phases.map((p, i) => `${i + 1}. [${p.key}] ${p.title}${p.detail ? ` — ${p.detail}` : ''}`),
      ``, `## How to execute`,
      `Think deeply and thoroughly before each step. Break each phase into concrete, standalone tasks for the right specialists; verify every deliverable actually works (run it, test it, open it) before marking a phase done; put final deliverables in the task outputs/ folder. Keep going until the success criterion is genuinely met — the final product exists or the requested actions are done.`,
      ``, `## Agreed decisions (conversation transcript)`, qa.slice(-12000),
    ].join('\n');
  }

  goalView(goalId: string) {
    const g = this.goals.get(goalId);
    if (!g) return null;
    return {
      goalId: g.goalId, title: g.title, status: g.status, closedReason: g.closedReason,
      blockReason: g.blockReason, successCriteria: g.successCriteria,
      phases: g.phases.map(p => ({ key: p.key, title: p.title, status: p.status, tasks: p.taskIds.length })),
    };
  }

  private reconcileGoal(s: VoiceSession): boolean {
    const g = this.goalView(s.goalId!);
    if (!g) return false;
    const snap = `${g.status}|${g.phases.map(p => `${p.key}:${p.status}`).join(',')}`;
    if (snap === s.goalSnapshot) return false;
    const prev = new Map((s.goalSnapshot || '').split('|')[1]?.split(',').map(x => x.split(':') as [string, string]) || []);
    const now = new Date().toISOString();
    const notes: string[] = [];
    for (const p of g.phases) {
      const was = prev.get(p.key);
      if (p.status === was || !s.goalSnapshot) continue;
      if (p.status === 'active') notes.push(`Phase "${p.title}" is under way.`);
      else if (p.status === 'audited' || p.status === 'done') notes.push(`Phase "${p.title}" is complete.`);
    }
    const prevStatus = (s.goalSnapshot || '').split('|')[0];
    if (g.status !== prevStatus && s.goalSnapshot) {
      if (g.status === 'achieved') notes.push(`Done — the goal is achieved. ${g.closedReason || ''}`.trim());
      else if (g.status === 'blocked') notes.push(`The goal is blocked: ${g.blockReason || 'unknown reason'}. It will retry automatically; you can also unblock it from the Goals page.`);
      else if (g.status === 'paused') notes.push('The goal was paused.');
      else if (g.status === 'active' && prevStatus) notes.push('The goal is running again.');
    }
    if (g.status === 'achieved') s.phase = 'done';
    s.goalSnapshot = snap;
    if (notes.length) s.messages.push({ role: 'assistant', content: notes.join(' '), at: now });
    return true;
  }

  // ── Prompt ────────────────────────────────────────────────────────────────────

  buildPrompt(s: VoiceSession): string {
    const transcript = s.messages.filter(m => m.role !== 'system');
    const latest = transcript[transcript.length - 1];
    const history = transcript.slice(0, -1).slice(-40)
      .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n');
    const goal = s.goalId ? this.goalView(s.goalId) : null;
    const phaseRules = s.phase === 'executing' || s.phase === 'done'
      ? [
          `The plan is ALREADY APPROVED and executing as goal ${s.goalId}. Do not re-plan or re-grill. Answer the user's question about progress or next steps using the live goal status below. If they ask for changes to the running work, acknowledge and tell them to adjust the goal on the Goals page.`,
          `Live goal status: ${JSON.stringify(goal)}`,
        ]
      : [
          `## Your process (follow strictly)`,
          `PHASE 1 — GRILL. Use the **grill-me** skill (it runs /grilling), whose instructions are:`,
          `<grill-me-skill>`, loadGrillingSkill(this.home), `</grill-me-skill>`,
          `Whenever ANY ambiguity remains — goal, target user, scope and non-goals, deliverable form, quality bar, tech/tool choices, constraints (time, budget, accounts, credentials), where outputs go, how success is measured — ask exactly ONE question this turn, and give your recommended answer. Look facts up yourself (you can read the filesystem / run tools) instead of asking. Keep a running list of the remaining open questions.`,
          ``,
          `PHASE 2 — PLAN. Only when ZERO ambiguity remains, present a concrete plan: a binary yes/no success criterion and 1–8 ordered phases. Briefly speak the plan, then ask for permission to execute it ("say go ahead, or tap Approve").`,
          ``,
          `PHASE 3 — PERMISSION. You never execute anything yourself. If a plan is ALREADY on the table (current phase "plan-ready") and the user's latest message clearly approves it, set "userApproved": true and say you're starting. If they want changes, revise: either ask the next question (phase "grilling") or present the revised plan (phase "plan-ready").`,
        ];
    return [
      `You are the Cowork VOICE ASSISTANT — a sharp, warm product-thinking partner talking with the CEO by VOICE about a new idea. Your reply is read aloud by text-to-speech and shown in a chat.`,
      ``,
      ...phaseRules,
      ``,
      `## Current state`,
      `phase: ${s.phase}`,
      `open questions you listed last turn: ${JSON.stringify(s.ambiguities)}`,
      `current plan: ${s.plan ? JSON.stringify(s.plan) : 'none yet'}`,
      ``,
      `## Conversation so far`,
      history || '(this is the first message)',
      ``,
      `## The user's latest message`,
      latest ? latest.content : '',
      ``,
      `## Output format (exactly)`,
      `First, 1–4 short natural spoken sentences — no markdown, no bullet lists, no code, no emoji (it is spoken aloud). When you ask a question, state your recommended answer in the same breath.`,
      `Then, on a new line, ONE fenced block tagged voice-state containing only JSON:`,
      '```voice-state',
      `{"phase":"grilling" | "plan-ready", "ambiguities":["remaining open question", "..."], "plan": null | {"title":"short name","summary":"2-3 sentences","deliverable":"the final product","successCriteria":"binary yes/no question","phases":[{"key":"kebab-case","title":"what this phase produces","detail":"how"}]}, "userApproved": false}`,
      '```',
      `Rules: "plan-ready" REQUIRES "ambiguities": [] and a complete plan. Never put file-system paths in the plan — the executing tasks save deliverables in their own outputs/ folders. While grilling, keep "plan": null unless revising an existing one. "userApproved" is true ONLY per PHASE 3. ${s.phase === 'executing' || s.phase === 'done' ? `Since the plan is executing, always output {"phase":"plan-ready","ambiguities":[],"plan":null,"userApproved":false}.` : ''}`,
    ].join('\n');
  }
}
