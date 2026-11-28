/**
 * Workspaces & Continuous Working Sessions (`core/workspaces.ts`).
 *
 * Layered on top of Cowork's Task Store and Dispatcher, modeled on dsh-web's
 * workspace + continuous session UX:
 *   - A Workspace is a durable container with a stable UUID, display name/title,
 *     optional canonical host directory path, default agent/thinking, automatic
 *     pstack skill settings, and an ordered list of sessions.
 *   - A WorkspaceSession is a continuously working, resumable, multi-turn thread
 *     inside a workspace. Each user message creates a linked workspace-scoped
 *     Task with carried-over transcript context and automatically resolved
 *     vendored pstack skills (`vendor/pstack/skills/<name>/SKILL.md`).
 *   - Tasks can be created directly inside a workspace or spawned by a session;
 *     every query (`GET /api/workspaces/:id/tasks`, `GET /api/inbox?workspaceId=…`,
 *     `GET /api/sessions?workspaceId=…`) scopes cleanly by `workspaceId`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionStatus,
  SessionTurn,
  Task,
  Workspace,
  WorkspaceSession,
} from '../types.js';
import type { EventBus } from './events.js';
import { isFailedTask, type Store } from './store.js';
import {
  listVendoredPstackSkills,
  resolveWorkspaceSessionPstackSkills,
  type ResolvedPstackSkill,
} from './pstack-gates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COWORK_REPO_ROOT = path.resolve(__dirname, '../../..');

export interface WorkspaceWithStats extends Workspace {
  sessionCount: number;
  activeSessionCount: number;
  taskCount: number;
  openTaskCount: number;
  sessions: Array<{
    id: string;
    title: string;
    status: SessionStatus;
    pinned?: boolean;
    archived?: boolean;
    turnCount: number;
    activeTaskId?: string | null;
    agent?: string;
    pstackSkills: string[];
    updatedAt: string;
  }>;
}

export interface CreateWorkspaceInput {
  name?: string;
  title?: string;
  path?: string;
  description?: string;
  defaultAgent?: string;
  defaultThinking?: string;
  pstackAutoSkills?: boolean;
  pinnedSkills?: string[];
}

export interface UpdateWorkspaceInput {
  name?: string;
  title?: string;
  path?: string | null;
  description?: string | null;
  defaultAgent?: string | null;
  defaultThinking?: string | null;
  pstackAutoSkills?: boolean;
  pinnedSkills?: string[];
  archived?: boolean;
}

export interface CreateSessionInput {
  title?: string;
  agent?: string;
  thinking?: string;
  autoPstackSkills?: boolean;
  pinnedSkills?: string[];
  /** Optional initial prompt: immediately starts Turn 1 in the session. */
  prompt?: string;
  inputs?: Array<{ token?: string; name?: string }>;
  priority?: Task['priority'];
}

export interface SendSessionMessageInput {
  prompt: string;
  agent?: string;
  thinking?: string;
  inputs?: Array<{ token?: string; name?: string }>;
  skills?: string[];
  priority?: Task['priority'];
  isResume?: boolean;
}

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function safeId(id: string): string {
  const s = String(id || '').trim();
  if (!s || !VALID_ID.test(s)) throw new Error(`Invalid id: ${id}`);
  return s;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function normalizeWorkspacePath(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}

function sanitizeSkillList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean = [...new Set(
    raw
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .filter(v => /^[a-z0-9][a-z0-9-]*$/.test(v))
  )];
  return clean;
}

function deriveSessionTitleFromPrompt(prompt: string): string {
  const firstLine = String(prompt || '').trim().split(/\r?\n/)[0] || '';
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, '').trim();
  if (!cleaned) return 'New session';
  return cleaned.length > 64 ? `${cleaned.slice(0, 61).trimEnd()}…` : cleaned;
}

function taskStatusToTurnStatus(task: Task): SessionTurn['status'] {
  if (isFailedTask(task)) return 'failed';
  switch (task.status) {
    case 'done': return 'done';
    case 'in-progress':
    case 'claimed': return 'running';
    case 'wait-input': return 'wait-input';
    case 'paused': return 'paused';
    case 'rejected': return 'failed';
    case 'pending':
    case 'scheduled':
    default:
      return 'pending';
  }
}

function deriveSessionStatus(session: WorkspaceSession): SessionStatus {
  if (session.archived) return 'archived';
  const last = session.turns[session.turns.length - 1];
  if (!last) return 'idle';
  switch (last.status) {
    case 'pending':
    case 'running':
      return 'working';
    case 'wait-input':
      return 'wait-input';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'error';
    case 'done':
    default:
      return 'idle';
  }
}

const OPEN_TASK_STATUSES = new Set(['pending', 'claimed', 'in-progress', 'wait-input', 'scheduled', 'paused']);

export class Workspaces {
  private readonly dir: string;
  private readonly sessionsDir: string;
  private readonly store: Store;
  private readonly eventBus: EventBus;
  private readonly repoRoot: string;

  constructor(
    workspacesDir: string,
    store: Store,
    eventBus: EventBus,
    opts?: { repoRoot?: string },
  ) {
    this.dir = path.resolve(workspacesDir);
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.store = store;
    this.eventBus = eventBus;
    this.repoRoot = opts?.repoRoot || this.detectRepoRoot();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private detectRepoRoot(): string {
    const cfgArt = this.store.getConfig?.()?.paths?.artifacts;
    if (cfgArt) {
      const candidate = path.resolve(cfgArt, '..');
      if (fs.existsSync(path.join(candidate, 'vendor', 'pstack', 'skills'))) {
        return candidate;
      }
    }
    return DEFAULT_COWORK_REPO_ROOT;
  }

  public getRepoRoot(): string {
    return this.repoRoot;
  }

  private workspaceFile(id: string): string {
    return path.join(this.dir, `${safeId(id)}.json`);
  }

  private sessionFile(id: string): string {
    return path.join(this.sessionsDir, `${safeId(id)}.json`);
  }

  private saveWorkspace(ws: Workspace): void {
    atomicWriteJson(this.workspaceFile(ws.id), ws);
  }

  private saveSession(session: WorkspaceSession): void {
    atomicWriteJson(this.sessionFile(session.id), session);
  }

  /** Hook into EventBus so task lifecycle transitions keep sessions continuously synced. */
  public attachToEventBus(): void {
    const onTaskEvent = (evt: any) => {
      const task: Task | undefined = evt?.payload?.task;
      const taskId: string | undefined = task?.id || evt?.payload?.taskId;
      if (!taskId) return;
      const sessionId = task?.sessionId || task?.context?.sessionId;
      if (typeof sessionId === 'string' && sessionId) {
        this.syncSessionById(sessionId);
        return;
      }
      // Deletion events only carry taskId: sync any session referencing this task.
      if (evt?.type === 'taskDeleted') {
        for (const s of this.readAllSessionsRaw()) {
          if (s.activeTaskId === taskId || s.turns.some(t => t.taskId === taskId)) {
            this.syncSessionById(s.id);
          }
        }
      }
    };
    this.eventBus.on('taskClaimed', onTaskEvent);
    this.eventBus.on('taskCompleted', onTaskEvent);
    this.eventBus.on('taskPaused', onTaskEvent);
    this.eventBus.on('taskResumed', onTaskEvent);
    this.eventBus.on('taskDeleted', onTaskEvent);
  }

  private readAllWorkspacesRaw(): Workspace[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    const list: Workspace[] = [];
    for (const f of files) {
      const ws = readJsonFile<Workspace>(path.join(this.dir, f));
      if (ws && typeof ws.id === 'string') {
        // Normalize older or minimal records cleanly
        ws.name = ws.name || ws.title || ws.id;
        ws.title = ws.title || ws.name;
        ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
        if (typeof ws.pstackAutoSkills !== 'boolean') ws.pstackAutoSkills = true;
        list.push(ws);
      }
    }
    list.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''));
    return list;
  }

  private readAllSessionsRaw(): WorkspaceSession[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    const list: WorkspaceSession[] = [];
    for (const f of files) {
      const s = readJsonFile<WorkspaceSession>(path.join(this.sessionsDir, f));
      if (s && typeof s.id === 'string' && typeof s.workspaceId === 'string') {
        s.turns = Array.isArray(s.turns) ? s.turns : [];
        if (typeof s.autoPstackSkills !== 'boolean') s.autoPstackSkills = true;
        list.push(s);
      }
    }
    return list;
  }

  /** Reconcile a session's turns against the live Task store. Persists if anything changed. */
  public reconcileSession(session: WorkspaceSession): { session: WorkspaceSession; changed: boolean } {
    let changed = false;
    for (const turn of session.turns) {
      if (!turn.taskId) continue;
      const task = this.store.getTask(turn.taskId);
      if (!task) continue;
      const nextStatus = taskStatusToTurnStatus(task);
      if (turn.status !== nextStatus) {
        turn.status = nextStatus;
        changed = true;
      }
      const actualAgent = task.context?.ranAgent || task.context?.liveAgent || task.context?.agent;
      if (typeof actualAgent === 'string' && actualAgent && turn.agent !== actualAgent) {
        turn.agent = actualAgent;
        changed = true;
      }
      if (typeof task.result === 'string' && task.result !== turn.response) {
        turn.response = task.result;
        changed = true;
      }
      if (task.completedAt && task.completedAt !== turn.completedAt) {
        turn.completedAt = task.completedAt;
        changed = true;
      }
      if (Array.isArray(task.artifacts) && JSON.stringify(task.artifacts) !== JSON.stringify(turn.artifacts || [])) {
        turn.artifacts = [...task.artifacts];
        changed = true;
      }
      if (Array.isArray(task.outputs) && JSON.stringify(task.outputs) !== JSON.stringify(turn.outputs || [])) {
        turn.outputs = [...task.outputs];
        changed = true;
      }
    }

    const lastTurn = session.turns[session.turns.length - 1];
    const nextStatus = deriveSessionStatus(session);
    if (session.status !== nextStatus) {
      session.status = nextStatus;
      changed = true;
    }

    const nextActiveTaskId = lastTurn && (lastTurn.status === 'pending' || lastTurn.status === 'running' || lastTurn.status === 'wait-input' || lastTurn.status === 'paused')
      ? (lastTurn.taskId || null)
      : null;
    if ((session.activeTaskId || null) !== nextActiveTaskId) {
      session.activeTaskId = nextActiveTaskId;
      changed = true;
    }

    const lastDone = [...session.turns].reverse().find(t => t.status === 'done' && t.taskId);
    const nextLastTaskId = lastDone?.taskId || session.lastTaskId || null;
    if ((session.lastTaskId || null) !== nextLastTaskId) {
      session.lastTaskId = nextLastTaskId;
      changed = true;
    }

    if (changed) {
      session.updatedAt = new Date().toISOString();
      this.saveSession(session);
    }
    return { session, changed };
  }

  private syncSessionById(sessionId: string): WorkspaceSession | null {
    let raw: WorkspaceSession | null = null;
    try { raw = readJsonFile<WorkspaceSession>(this.sessionFile(sessionId)); } catch { return null; }
    if (!raw) return null;
    const { session, changed } = this.reconcileSession(raw);
    if (changed) {
      this.eventBus.emitSessionUpdated(session.workspaceId, session.id);
      this.eventBus.emitWorkspaceUpdated(session.workspaceId);
    }
    return session;
  }

  // ── Workspace CRUD ────────────────────────────────────────────────────────

  public listWorkspaces(opts?: { includeArchived?: boolean }): WorkspaceWithStats[] {
    const allWorkspaces = this.readAllWorkspacesRaw().filter(ws => opts?.includeArchived || !ws.archived);
    const allTasks = this.store.listTasks({});
    const tasksByWs = new Map<string, Task[]>();
    for (const t of allTasks) {
      const wsId = t.workspaceId || (typeof t.context?.workspaceId === 'string' ? t.context.workspaceId : '');
      if (!wsId) continue;
      const arr = tasksByWs.get(wsId) || [];
      arr.push(t);
      tasksByWs.set(wsId, arr);
    }

    return allWorkspaces.map(ws => {
      const sessions = this.listSessions(ws.id, { includeArchived: opts?.includeArchived });
      const wsTasks = tasksByWs.get(ws.id) || [];
      const openTaskCount = wsTasks.filter(t => OPEN_TASK_STATUSES.has(t.status)).length;
      const activeSessionCount = sessions.filter(s => s.status === 'working' || s.status === 'wait-input').length;
      return {
        ...ws,
        sessionCount: sessions.length,
        activeSessionCount,
        taskCount: wsTasks.length,
        openTaskCount,
        sessions: sessions.map(s => {
          const last = s.turns[s.turns.length - 1];
          return {
            id: s.id,
            title: s.title,
            status: s.status,
            pinned: s.pinned,
            archived: s.archived,
            turnCount: s.turns.length,
            activeTaskId: s.activeTaskId,
            agent: s.agent,
            pstackSkills: last?.pstackSkills || [],
            updatedAt: s.updatedAt,
          };
        }),
      };
    });
  }

  public getWorkspace(id: string): Workspace | null {
    try {
      const ws = readJsonFile<Workspace>(this.workspaceFile(id));
      if (!ws) return null;
      ws.name = ws.name || ws.title || ws.id;
      ws.title = ws.title || ws.name;
      ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      if (typeof ws.pstackAutoSkills !== 'boolean') ws.pstackAutoSkills = true;
      return ws;
    } catch {
      return null;
    }
  }

  public getWorkspaceDetail(id: string): (WorkspaceWithStats & { tasks: Task[] }) | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const sessions = this.listSessions(ws.id);
    const tasks = this.listWorkspaceTasks(ws.id);
    const openTaskCount = tasks.filter(t => OPEN_TASK_STATUSES.has(t.status)).length;
    const activeSessionCount = sessions.filter(s => s.status === 'working' || s.status === 'wait-input').length;
    return {
      ...ws,
      sessionCount: sessions.length,
      activeSessionCount,
      taskCount: tasks.length,
      openTaskCount,
      sessions: sessions.map(s => {
        const last = s.turns[s.turns.length - 1];
        return {
          id: s.id,
          title: s.title,
          status: s.status,
          pinned: s.pinned,
          archived: s.archived,
          turnCount: s.turns.length,
          activeTaskId: s.activeTaskId,
          agent: s.agent,
          pstackSkills: last?.pstackSkills || [],
          updatedAt: s.updatedAt,
        };
      }),
      tasks,
    };
  }

  public createWorkspace(input: CreateWorkspaceInput): Workspace {
    const normPath = normalizeWorkspacePath(input.path);
    const rawName = (typeof input.name === 'string' && input.name.trim())
      || (typeof input.title === 'string' && input.title.trim())
      || (normPath ? (path.basename(normPath) || normPath) : '');
    if (!rawName) {
      throw new Error('Workspace name (or title/path) is required');
    }
    const name = rawName.slice(0, 120);
    const now = new Date().toISOString();
    const ws: Workspace = {
      id: uuidv4(),
      name,
      title: name,
      ...(normPath ? { path: normPath } : {}),
      ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim().slice(0, 2000) } : {}),
      ...(typeof input.defaultAgent === 'string' && input.defaultAgent.trim() ? { defaultAgent: input.defaultAgent.trim() } : {}),
      ...(typeof input.defaultThinking === 'string' && input.defaultThinking.trim() ? { defaultThinking: input.defaultThinking.trim() } : {}),
      pstackAutoSkills: input.pstackAutoSkills !== false,
      ...(sanitizeSkillList(input.pinnedSkills)?.length ? { pinnedSkills: sanitizeSkillList(input.pinnedSkills) } : {}),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.saveWorkspace(ws);
    this.eventBus.emitWorkspaceUpdated(ws.id);
    return ws;
  }

  public updateWorkspace(id: string, patch: UpdateWorkspaceInput): Workspace | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const nextName = (typeof patch.name === 'string' && patch.name.trim())
      || (typeof patch.title === 'string' && patch.title.trim());
    if (nextName) {
      ws.name = nextName.slice(0, 120);
      ws.title = ws.name;
    }
    if (patch.path !== undefined) {
      const p = normalizeWorkspacePath(patch.path);
      if (p) ws.path = p;
      else delete ws.path;
    }
    if (patch.description !== undefined) {
      if (typeof patch.description === 'string' && patch.description.trim()) {
        ws.description = patch.description.trim().slice(0, 2000);
      } else {
        delete ws.description;
      }
    }
    if (patch.defaultAgent !== undefined) {
      if (typeof patch.defaultAgent === 'string' && patch.defaultAgent.trim()) ws.defaultAgent = patch.defaultAgent.trim();
      else delete ws.defaultAgent;
    }
    if (patch.defaultThinking !== undefined) {
      if (typeof patch.defaultThinking === 'string' && patch.defaultThinking.trim()) ws.defaultThinking = patch.defaultThinking.trim();
      else delete ws.defaultThinking;
    }
    if (typeof patch.pstackAutoSkills === 'boolean') {
      ws.pstackAutoSkills = patch.pstackAutoSkills;
    }
    if (patch.pinnedSkills !== undefined) {
      const skills = sanitizeSkillList(patch.pinnedSkills);
      if (skills && skills.length) ws.pinnedSkills = skills;
      else delete ws.pinnedSkills;
    }
    if (typeof patch.archived === 'boolean') {
      ws.archived = patch.archived;
    }
    ws.updatedAt = new Date().toISOString();
    this.saveWorkspace(ws);
    this.eventBus.emitWorkspaceUpdated(ws.id);
    return ws;
  }

  public deleteWorkspace(id: string): { deleted: boolean; deletedSessions: number; detachedTasks: number } {
    const ws = this.getWorkspace(id);
    if (!ws) return { deleted: false, deletedSessions: 0, detachedTasks: 0 };

    let deletedSessions = 0;
    for (const s of this.readAllSessionsRaw()) {
      if (s.workspaceId === ws.id) {
        try { fs.rmSync(this.sessionFile(s.id), { force: true }); deletedSessions++; } catch { /* ignore */ }
      }
    }

    let detachedTasks = 0;
    for (const t of this.listWorkspaceTasks(ws.id)) {
      delete t.workspaceId;
      delete t.sessionId;
      if (t.context) {
        delete t.context.workspaceId;
        delete t.context.sessionId;
      }
      this.store.saveTask(t);
      detachedTasks++;
    }

    try { fs.rmSync(this.workspaceFile(ws.id), { force: true }); } catch { /* ignore */ }
    this.eventBus.emitWorkspaceUpdated(ws.id);
    return { deleted: true, deletedSessions, detachedTasks };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  public listSessions(workspaceId?: string, opts?: { includeArchived?: boolean }): WorkspaceSession[] {
    const all = this.readAllSessionsRaw()
      .filter(s => (!workspaceId || s.workspaceId === workspaceId) && (opts?.includeArchived || !s.archived))
      .map(s => this.reconcileSession(s).session);

    if (workspaceId) {
      const ws = this.getWorkspace(workspaceId);
      const order = new Map((ws?.sessionIds || []).map((sid, idx) => [sid, idx]));
      all.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        const oa = order.has(a.id) ? order.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const ob = order.has(b.id) ? order.get(b.id)! : Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        return Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
      });
    } else {
      all.sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    }
    return all;
  }

  public getSession(sessionId: string): WorkspaceSession | null {
    try {
      const raw = readJsonFile<WorkspaceSession>(this.sessionFile(sessionId));
      if (!raw) return null;
      return this.reconcileSession(raw).session;
    } catch {
      return null;
    }
  }

  public createSession(workspaceId: string, input: CreateSessionInput = {}): { session: WorkspaceSession; task?: Task; turn?: SessionTurn } {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

    const now = new Date().toISOString();
    const initialTitle = (typeof input.title === 'string' && input.title.trim())
      ? input.title.trim().slice(0, 120)
      : (typeof input.prompt === 'string' && input.prompt.trim()
        ? deriveSessionTitleFromPrompt(input.prompt)
        : 'New session');

    const session: WorkspaceSession = {
      id: uuidv4(),
      workspaceId: ws.id,
      title: initialTitle,
      status: 'idle',
      agent: (typeof input.agent === 'string' && input.agent.trim()) ? input.agent.trim() : ws.defaultAgent,
      thinking: (typeof input.thinking === 'string' && input.thinking.trim()) ? input.thinking.trim() : ws.defaultThinking,
      autoPstackSkills: input.autoPstackSkills !== undefined ? !!input.autoPstackSkills : ws.pstackAutoSkills !== false,
      ...(sanitizeSkillList(input.pinnedSkills)?.length ? { pinnedSkills: sanitizeSkillList(input.pinnedSkills) } : {}),
      turns: [],
      activeTaskId: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.saveSession(session);
    ws.sessionIds = [session.id, ...ws.sessionIds.filter(id => id !== session.id)];
    ws.updatedAt = now;
    this.saveWorkspace(ws);
    this.eventBus.emitSessionUpdated(ws.id, session.id);
    this.eventBus.emitWorkspaceUpdated(ws.id);

    if (typeof input.prompt === 'string' && input.prompt.trim()) {
      const sent = this.sendMessage(session.id, {
        prompt: input.prompt,
        agent: input.agent,
        thinking: input.thinking,
        inputs: input.inputs,
        priority: input.priority,
      });
      return { session: sent.session, task: sent.task, turn: sent.turn };
    }

    return { session };
  }

  public updateSession(sessionId: string, patch: {
    title?: string;
    pinned?: boolean;
    archived?: boolean;
    agent?: string | null;
    thinking?: string | null;
    autoPstackSkills?: boolean;
    pinnedSkills?: string[];
    beforeSessionId?: string | null;
  }): WorkspaceSession | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    if (typeof patch.title === 'string' && patch.title.trim()) {
      session.title = patch.title.trim().slice(0, 120);
    }
    if (typeof patch.pinned === 'boolean') session.pinned = patch.pinned;
    if (typeof patch.archived === 'boolean') {
      session.archived = patch.archived;
      session.status = deriveSessionStatus(session);
    }
    if (patch.agent !== undefined) {
      if (typeof patch.agent === 'string' && patch.agent.trim()) session.agent = patch.agent.trim();
      else delete session.agent;
    }
    if (patch.thinking !== undefined) {
      if (typeof patch.thinking === 'string' && patch.thinking.trim()) session.thinking = patch.thinking.trim();
      else delete session.thinking;
    }
    if (typeof patch.autoPstackSkills === 'boolean') session.autoPstackSkills = patch.autoPstackSkills;
    if (patch.pinnedSkills !== undefined) {
      const skills = sanitizeSkillList(patch.pinnedSkills);
      if (skills && skills.length) session.pinnedSkills = skills;
      else delete session.pinnedSkills;
    }

    if (patch.beforeSessionId !== undefined) {
      const ws = this.getWorkspace(session.workspaceId);
      if (ws) {
        const filtered = ws.sessionIds.filter(id => id !== session.id);
        if (patch.beforeSessionId && filtered.includes(patch.beforeSessionId)) {
          const idx = filtered.indexOf(patch.beforeSessionId);
          filtered.splice(idx, 0, session.id);
        } else {
          filtered.push(session.id);
        }
        ws.sessionIds = filtered;
        ws.updatedAt = new Date().toISOString();
        this.saveWorkspace(ws);
      }
    }

    session.updatedAt = new Date().toISOString();
    this.saveSession(session);
    this.eventBus.emitSessionUpdated(session.workspaceId, session.id);
    this.eventBus.emitWorkspaceUpdated(session.workspaceId);
    return session;
  }

  public forkSession(sessionId: string, opts?: { title?: string; upToTurnIndex?: number }): WorkspaceSession | null {
    const src = this.getSession(sessionId);
    if (!src) return null;
    const ws = this.getWorkspace(src.workspaceId);
    if (!ws) return null;

    const now = new Date().toISOString();
    const limit = typeof opts?.upToTurnIndex === 'number' && opts.upToTurnIndex > 0
      ? opts.upToTurnIndex
      : src.turns.length;

    const copiedTurns: SessionTurn[] = src.turns
      .filter(t => t.index <= limit)
      .map((t, idx) => ({
        ...t,
        id: uuidv4(),
        index: idx + 1,
        status: t.status === 'done' ? 'done' : (t.status === 'failed' ? 'failed' : 'done'),
      }));

    const forked: WorkspaceSession = {
      id: uuidv4(),
      workspaceId: ws.id,
      title: (typeof opts?.title === 'string' && opts.title.trim()) ? opts.title.trim().slice(0, 120) : `Fork: ${src.title}`.slice(0, 120),
      status: 'idle',
      agent: src.agent,
      thinking: src.thinking,
      autoPstackSkills: src.autoPstackSkills,
      ...(src.pinnedSkills?.length ? { pinnedSkills: [...src.pinnedSkills] } : {}),
      turns: copiedTurns,
      activeTaskId: null,
      lastTaskId: [...copiedTurns].reverse().find(t => t.taskId)?.taskId || null,
      forkedFromSessionId: src.id,
      createdAt: now,
      updatedAt: now,
    };

    this.saveSession(forked);
    ws.sessionIds = [forked.id, ...ws.sessionIds.filter(id => id !== forked.id)];
    ws.updatedAt = now;
    this.saveWorkspace(ws);
    this.eventBus.emitSessionUpdated(ws.id, forked.id);
    this.eventBus.emitWorkspaceUpdated(ws.id);
    return forked;
  }

  public deleteSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    const ws = this.getWorkspace(session.workspaceId);
    if (ws) {
      ws.sessionIds = ws.sessionIds.filter(id => id !== session.id);
      ws.updatedAt = new Date().toISOString();
      this.saveWorkspace(ws);
    }

    try { fs.rmSync(this.sessionFile(session.id), { force: true }); } catch { /* ignore */ }
    this.eventBus.emitWorkspaceUpdated(session.workspaceId);
    return true;
  }

  /**
   * Resolve applicable vendored pstack skills for a workspace session turn.
   */
  public resolvePstackSkillsForTurn(
    ws: Workspace,
    session: WorkspaceSession,
    opts: { prompt: string; title?: string; turnIndex: number; isResume?: boolean; extraSkills?: string[] },
  ): ResolvedPstackSkill[] {
    const autoEnabled = ws.pstackAutoSkills !== false && session.autoPstackSkills !== false;
    const pinnedSkills = [
      ...(ws.pinnedSkills || []),
      ...(session.pinnedSkills || []),
      ...(sanitizeSkillList(opts.extraSkills) || []),
    ];
    return resolveWorkspaceSessionPstackSkills({
      repoRoot: this.repoRoot,
      prompt: opts.prompt,
      title: opts.title,
      turnIndex: opts.turnIndex,
      isResume: opts.isResume,
      workspacePath: ws.path,
      pinnedSkills,
      autoSkills: autoEnabled,
    });
  }

  /**
   * Send a user message into a continuous workspace session.
   * - Automatically resolves & attaches vendored pstack skills.
   * - Carries forward recent session transcript & workspace context.
   * - If the active turn is parked on `wait-input` with interaction fields, answers it in place.
   */
  public sendMessage(sessionId: string, input: SendSessionMessageInput): { session: WorkspaceSession; turn: SessionTurn; task: Task } {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new Error('prompt (non-empty string) is required');

    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const ws = this.getWorkspace(session.workspaceId);
    if (!ws) throw new Error(`Workspace ${session.workspaceId} not found`);

    // If the active turn is waiting on human input and has an interaction packet,
    // submit the user's message directly so the task immediately resumes.
    if (session.activeTaskId) {
      const activeTask = this.store.getTask(session.activeTaskId);
      if (activeTask && activeTask.status === 'wait-input' && activeTask.interaction?.fields?.length) {
        const responses: Record<string, string> = {};
        for (const field of activeTask.interaction.fields) {
          responses[field.id] = prompt;
        }
        const updatedTask = this.store.submitInteraction({
          taskId: activeTask.id,
          responses,
          submittedBy: `workspace:${ws.name}`,
        });
        if (updatedTask) {
          const activeTurn = session.turns[session.turns.length - 1];
          if (activeTurn) {
            activeTurn.prompt = `${activeTurn.prompt}\n\n[User reply]: ${prompt}`;
            activeTurn.status = 'pending';
          }
          session.status = 'working';
          session.updatedAt = new Date().toISOString();
          this.saveSession(session);
          this.eventBus.emitSessionUpdated(ws.id, session.id);
          this.eventBus.emitWorkspaceUpdated(ws.id);
          return { session, turn: activeTurn, task: updatedTask };
        }
      }
    }

    const turnIndex = session.turns.length + 1;
    const isFirstTurn = session.turns.length === 0;
    if (isFirstTurn && (!session.title || session.title === 'New session')) {
      session.title = deriveSessionTitleFromPrompt(prompt);
    }

    const chosenAgent = (typeof input.agent === 'string' && input.agent.trim())
      ? input.agent.trim()
      : (session.agent || ws.defaultAgent);
    const chosenThinking = (typeof input.thinking === 'string' && input.thinking.trim())
      ? input.thinking.trim()
      : (session.thinking || ws.defaultThinking);

    if (chosenAgent) session.agent = chosenAgent;
    if (chosenThinking) session.thinking = chosenThinking;

    const resolvedSkills = this.resolvePstackSkillsForTurn(ws, session, {
      prompt,
      title: session.title,
      turnIndex,
      isResume: input.isResume,
      extraSkills: input.skills,
    });
    const pstackSkills = resolvedSkills.map(s => s.name);
    const pstackReasons = Object.fromEntries(resolvedSkills.map(s => [s.name, `${s.source}: ${s.reason}`]));

    // Build continuous session brief carrying workspace context + recent turns
    const transcriptTurns = session.turns.slice(-6);
    const descLines: string[] = [];
    descLines.push(`## Workspace Session Context`);
    descLines.push(`- Workspace: ${ws.name} (\`${ws.id}\`)`);
    if (ws.path) descLines.push(`- Workspace path: \`${ws.path}\``);
    if (ws.description) descLines.push(`- Workspace brief: ${ws.description}`);
    descLines.push(`- Session: ${session.title} (\`${session.id}\`, turn #${turnIndex})`);
    if (pstackSkills.length) {
      descLines.push(`- Auto-applied pstack skills: ${pstackSkills.map(s => `\`${s}\``).join(', ')}`);
    }
    descLines.push('');

    if (transcriptTurns.length > 0) {
      descLines.push(`## Prior Session History (continue seamlessly from here)`);
      for (const prev of transcriptTurns) {
        const snippetPrompt = prev.prompt.length > 500 ? `${prev.prompt.slice(0, 500)}…` : prev.prompt;
        descLines.push(`### Turn ${prev.index} — User`);
        descLines.push(snippetPrompt);
        if (prev.response) {
          const snippetResp = prev.response.length > 900 ? `${prev.response.slice(0, 900)}…` : prev.response;
          descLines.push(`### Turn ${prev.index} — Assistant (${prev.status})`);
          descLines.push(snippetResp);
        }
        if (prev.outputs?.length) {
          descLines.push(`Outputs produced: ${prev.outputs.join(', ')}`);
        }
        descLines.push('');
      }
    }

    descLines.push(`## Current Turn (#${turnIndex}) — User Request`);
    descLines.push(prompt);

    const turnId = uuidv4();
    const taskContext: Record<string, any> = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      ...(ws.path ? { workspacePath: ws.path } : {}),
      sessionId: session.id,
      sessionTitle: session.title,
      sessionTurnId: turnId,
      sessionTurnIndex: turnIndex,
      autoPstackSkills: ws.pstackAutoSkills !== false && session.autoPstackSkills !== false,
      pstackSkills,
      pstackSkillReasons: pstackReasons,
      ...(session.lastTaskId ? { continuedFrom: session.lastTaskId } : {}),
      ...(chosenAgent ? { agent: chosenAgent } : {}),
      ...(chosenThinking ? { thinking: chosenThinking } : {}),
    };

    const task = this.store.createTask({
      title: `[${ws.name}] ${session.title} (turn ${turnIndex})`,
      description: descLines.join('\n'),
      from: { platform: 'workspace-session', agent: `workspace:${ws.name}` },
      to: chosenAgent ? { agent: chosenAgent } : {},
      priority: input.priority || 'normal',
      workspaceId: ws.id,
      sessionId: session.id,
      context: taskContext,
      tags: ['workspace-session', `ws:${ws.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32)}`],
    }, {
      inputs: input.inputs,
    });

    const now = new Date().toISOString();
    const turn: SessionTurn = {
      id: turnId,
      index: turnIndex,
      prompt,
      taskId: task.id,
      status: 'pending',
      agent: chosenAgent,
      thinking: chosenThinking,
      pstackSkills,
      pstackReasons,
      createdAt: now,
    };

    session.turns.push(turn);
    session.activeTaskId = task.id;
    session.status = 'working';
    session.archived = false;
    session.updatedAt = now;
    this.saveSession(session);

    ws.updatedAt = now;
    this.saveWorkspace(ws);
    this.eventBus.emitSessionUpdated(ws.id, session.id);
    this.eventBus.emitWorkspaceUpdated(ws.id);

    return { session, turn, task };
  }

  /**
   * Pause the currently active turn in a session.
   */
  public pauseSession(sessionId: string): { session: WorkspaceSession; pausedTask?: Task } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    let pausedTask: Task | undefined;
    if (session.activeTaskId) {
      const res = this.store.pauseTask(session.activeTaskId, { by: 'workspace-session', reason: 'Paused from workspace session' });
      if (res?.task) pausedTask = res.task;
    }
    const last = session.turns[session.turns.length - 1];
    if (last && (last.status === 'pending' || last.status === 'running')) {
      last.status = 'paused';
    }
    session.status = 'paused';
    session.updatedAt = new Date().toISOString();
    this.saveSession(session);
    this.eventBus.emitSessionUpdated(session.workspaceId, session.id);
    this.eventBus.emitWorkspaceUpdated(session.workspaceId);
    return { session, pausedTask };
  }

  /**
   * Resume a paused, failed, wait-input, or idle session continuously.
   */
  public resumeSession(
    sessionId: string,
    opts?: { prompt?: string; agent?: string; thinking?: string },
  ): { session: WorkspaceSession; task?: Task; action: 'resumed-task' | 'reran-turn' | 'continued-turn' } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const last = session.turns[session.turns.length - 1];
    if (session.activeTaskId && !opts?.prompt) {
      const activeTask = this.store.getTask(session.activeTaskId);
      if (activeTask && activeTask.status === 'paused') {
        const resumed = this.store.resumeTask(activeTask.id, { by: 'workspace-session' });
        if (resumed) {
          if (last) last.status = 'pending';
          session.status = 'working';
          session.updatedAt = new Date().toISOString();
          this.saveSession(session);
          this.eventBus.emitSessionUpdated(session.workspaceId, session.id);
          this.eventBus.emitWorkspaceUpdated(session.workspaceId);
          return { session, task: resumed, action: 'resumed-task' };
        }
      }
    }

    if (last && last.status === 'failed' && last.taskId && !opts?.prompt) {
      const rerun = this.store.rerunTask(last.taskId, opts?.agent);
      if (rerun) {
        last.status = 'pending';
        delete last.response;
        delete last.completedAt;
        session.activeTaskId = rerun.id;
        session.status = 'working';
        session.updatedAt = new Date().toISOString();
        this.saveSession(session);
        this.eventBus.emitSessionUpdated(session.workspaceId, session.id);
        this.eventBus.emitWorkspaceUpdated(session.workspaceId);
        return { session, task: rerun, action: 'reran-turn' };
      }
    }

    const sent = this.sendMessage(session.id, {
      prompt: opts?.prompt?.trim() || 'Resume this workspace session from where we left off, recall prior progress, and continue.',
      agent: opts?.agent,
      thinking: opts?.thinking,
      isResume: true,
    });
    return { session: sent.session, task: sent.task, action: 'continued-turn' };
  }

  // ── Workspace-Scoped Tasks ────────────────────────────────────────────────

  public listWorkspaceTasks(
    workspaceId: string,
    filters?: { status?: string; platform?: string; agent?: string; tag?: string; sessionId?: string; limit?: number },
  ): Task[] {
    return this.store.listTasks({
      ...filters,
      workspaceId,
    });
  }

  public createWorkspaceTask(
    workspaceId: string,
    params: {
      title: string;
      description: string;
      from?: { platform: string; agent: string };
      to?: { platform?: string; agent?: string };
      priority?: Task['priority'];
      skill?: string;
      context?: Record<string, any>;
      tags?: string[];
      sessionId?: string;
      scheduledAt?: string;
      recurrence?: any;
      interaction?: any;
    },
    opts?: { inputs?: Array<{ token?: string; name?: string }> },
  ): Task {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

    const ctx: Record<string, any> = {
      ...(params.context || {}),
      workspaceId: ws.id,
      workspaceName: ws.name,
      ...(ws.path ? { workspacePath: ws.path } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
    if (!ctx.agent && ws.defaultAgent) ctx.agent = ws.defaultAgent;
    if (!ctx.thinking && ws.defaultThinking) ctx.thinking = ws.defaultThinking;

    if (ws.pstackAutoSkills !== false && ctx.autoPstackSkills !== false) {
      const resolved = resolveWorkspaceSessionPstackSkills({
        repoRoot: this.repoRoot,
        title: params.title,
        prompt: params.description,
        workspacePath: ws.path,
        explicitSkill: ctx.skill,
        pinnedSkills: ws.pinnedSkills,
        autoSkills: true,
      });
      if (resolved.length) {
        ctx.autoPstackSkills = true;
        ctx.pstackSkills = resolved.map(s => s.name);
        ctx.pstackSkillReasons = Object.fromEntries(resolved.map(s => [s.name, `${s.source}: ${s.reason}`]));
      }
    }

    const task = this.store.createTask({
      title: params.title,
      description: params.description,
      from: params.from || { platform: 'dashboard', agent: `workspace:${ws.name}` },
      to: params.to || (ctx.agent ? { agent: ctx.agent } : {}),
      priority: params.priority || 'normal',
      skill: params.skill,
      workspaceId: ws.id,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      context: ctx,
      tags: params.tags,
      interaction: params.interaction,
      scheduledAt: params.scheduledAt,
      recurrence: params.recurrence,
    }, opts);

    ws.updatedAt = new Date().toISOString();
    this.saveWorkspace(ws);
    this.eventBus.emitWorkspaceUpdated(ws.id);
    return task;
  }

  public attachTaskToWorkspace(workspaceId: string, taskId: string): Task | null {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    const task = this.store.getTask(taskId);
    if (!task) return null;
    task.workspaceId = ws.id;
    task.context = {
      ...(task.context || {}),
      workspaceId: ws.id,
      workspaceName: ws.name,
      ...(ws.path ? { workspacePath: ws.path } : {}),
    };
    this.store.saveTask(task);
    this.eventBus.emitWorkspaceUpdated(ws.id);
    this.eventBus.emitTaskCreated(task);
    return task;
  }

  public detachTaskFromWorkspace(workspaceId: string, taskId: string): Task | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const currentWs = task.workspaceId || task.context?.workspaceId;
    if (currentWs !== workspaceId) return task;
    delete task.workspaceId;
    if (task.context) {
      delete task.context.workspaceId;
      delete task.context.workspaceName;
      delete task.context.workspacePath;
    }
    this.store.saveTask(task);
    this.eventBus.emitWorkspaceUpdated(workspaceId);
    this.eventBus.emitTaskCreated(task);
    return task;
  }

  public availablePstackSkills() {
    return listVendoredPstackSkills(this.repoRoot).map(s => ({
      name: s.name,
      description: s.description,
    }));
  }
}
