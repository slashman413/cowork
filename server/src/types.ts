export interface PlatformConfig {
  enabled: boolean;
  agentsDir?: string;
  skillsDir?: string;
  color?: string;
}

export interface ServiceConfig {
  url: string;
  /** Monitor this service — when false it is listed but never probed. */
  enabled: boolean;
}


export interface RoleConfig {
  /** claude/hermes/agy spawn an LLM CLI; script runs an arbitrary command
   *  (e.g. a media pipeline) with the task passed via COWORK_TASK_* env vars. */
  exec: 'claude' | 'hermes' | 'agy' | 'script' | 'codex' | 'ollama';
  model: string;
  /** argv for exec:script roles (the command + args to run). */
  command?: string[];
  /** Delegate execution to a named brain (see BrainConfig) instead of the
   *  inline exec/model above. */
  brain?: string;
  /** Role to hand the task to after a failed attempt (see Dispatcher handover). */
  fallback?: string;
}

/**
 * A "brain" is a concrete execution identity — a specific model on a specific
 * platform at a specific location. Aliased (e.g. `local-ha-qwen35b`,
 * `remote-aicodegen-cc-fable`) so the orchestrator can target one directly via
 * a task's `context.brain`. LOCAL brains are spawned by the dispatcher; REMOTE
 * brains are left in the inbox for that remote MCP client to claim itself.
 */
export interface BrainConfig {
  /** Human description shown to the orchestrator so it can choose. */
  description: string;
  location: 'local' | 'remote';
  /** local brains: how to run them. */
  exec?: 'claude' | 'hermes' | 'agy' | 'script' | 'codex' | 'ollama';
  model?: string;
  command?: string[];
  /** remote brains: which machine/client (informational + claim-routing hint). */
  host?: string;
  /** How many tasks this ONE instance may run CONCURRENTLY. A brain backed by a
   *  shared inference server (the local hermes/vLLM brains) or a stateless CLI can
   *  serve several requests at once, so it need not serialise one-task-at-a-time.
   *  The dispatcher never launches more than this many local runs on the brain
   *  simultaneously, and — when the preferred chain rung is saturated — spreads the
   *  overflow to the next local rung with spare capacity (load balancing). Defaults
   *  to orchestration.defaultBrainConcurrency (or 1). Ignored for remote brains
   *  (their own client governs concurrency). */
  maxConcurrent?: number;
  /** Brain alias to hand off to after a failed attempt. */
  fallback?: string;
  /** True when auto-registered by a connecting MCP client (vs configured by
   *  hand). Persisted, and only removed via explicit deregister or the UI —
   *  never on heartbeat timeout. */
  dynamic?: boolean;
  /** Agent id of the client that registered this brain (for explicit deregister). */
  registeredBy?: string;
  /** WF-3: machine-detected environment facts, so the router can know what this
   *  brain's host actually has and stop landing tasks where they cannot run.
   *  Auto-detected by the client at registration (names only — never secret
   *  values). A brain with no `env` is treated permissively (legacy behavior)
   *  except against `path:`/`secret:` task requirements, which fail closed. */
  env?: BrainEnv;
}

/** Environment capability manifest for a brain (WF-3 §B-I). All fields are
 *  detected facts, not values: `secrets` holds credential NAMES only. */
export interface BrainEnv {
  /** Absolute paths present on the host (matched by prefix against `path:` requires). */
  paths?: string[];
  /** CLI tools available (`command -v` hits): git, gh, ffmpeg, python3, … */
  tools?: string[];
  /** Names (never values) of credentials the host holds — matched by `secret:` requires. */
  secrets?: string[];
  /** Reachable network hosts (optional, advisory). */
  net?: string[];
  /** Freeform host traits (e.g. "linux-x86_64", "no-gpu"). */
  traits?: string[];
}

/**
 * One rate-limit window of a metered brain (e.g. Claude's 5-hour session or
 * 7-day cap, Codex's primary/secondary windows). Percent-used plus when it
 * resets — exactly what the Connections cards render.
 */
export interface BrainUsageWindow {
  /** Short human label: '5h', '7d', '7d-opus', … */
  label: string;
  /** Percent of the window consumed, 0–100. */
  usedPct: number;
  /** ISO timestamp when this window resets, when known. */
  resetsAt?: string;
  /**
   * Percent of the window REMAINING (0–100), when the source reports remaining
   * rather than used (Antigravity's quota RPC). Carried alongside `usedPct` so
   * the UI can show "X% remaining" without re-deriving it. Absent for
   * used-based execs (claude/codex).
   */
  remainingPct?: number;
  /**
   * The model-group this window belongs to. Antigravity buckets its quota by
   * model family — e.g. "Gemini Models" vs "Claude and GPT Models" — so the
   * same window label ('5h'/'7d') appears once per group. Absent for
   * single-account execs (claude/codex), whose windows are ungrouped.
   */
  group?: string;
  /** Member model display names for `group` ("Models within this group: …"). */
  groupModels?: string[];
  /**
   * When set, this window is not currently metered (e.g. the 5-hour limit no
   * longer applies once the weekly cap is hit). The UI shows this note in place
   * of a progress bar.
   */
  disabledNote?: string;
}

/**
 * A point-in-time usage snapshot for one brain. Only brains whose exec has a
 * queryable rate limit (claude, codex, …) ever produce one — hermes/ollama/
 * script brains have no external quota, report nothing, and stay hidden in the
 * UI. Local brains are probed by the server itself; remote brains self-report
 * via the `usage` field of their heartbeat.
 */
export interface BrainUsage {
  exec: string;
  windows: BrainUsageWindow[];
  /** ISO timestamp of the measurement (staleness marker in the UI). */
  at: string;
}

/**
 * The RESULT VERIFIER — inspects each finished attempt so a soft failure (a
 * rate-limit / quota / overloaded notice, an auth error, or an empty answer) that
 * still exited 0 is NOT mistaken for a completed task. A bad verdict makes the
 * dispatcher hand the task to the next brain in the fallback chain.
 */
export interface VerifierConfig {
  /** Master switch. Default on (omit or set true). Set false to trust exit codes only. */
  enabled?: boolean;
  /** Extra case-insensitive substrings that mark a bad result (merged with the built-ins). */
  failPatterns?: string[];
  /** Replace the built-in patterns entirely instead of merging. */
  replacePatterns?: boolean;
  /** A trimmed result shorter than this many chars is treated as empty. Default 1. */
  minLength?: number;
  /** Detect a result that ASKS THE USER a question (rather than delivering) and
   *  park the task on `wait-input` instead of marking it done. Default on. */
  detectInput?: boolean;
  /** Extra case-insensitive phrases that also mark a result as an input request. */
  inputPatterns?: string[];
  /** Replace the built-in input-request phrases entirely instead of merging. */
  replaceInputPatterns?: boolean;
  /** Optional LLM verifier agent stacked on top of the deterministic check. */
  llm?: {
    enabled: boolean;
    exec?: 'claude' | 'hermes' | 'agy' | 'codex' | 'ollama';
    model?: string;
    /** Wall-clock budget for one verification (ms). Default 300000. */
    timeoutMs?: number;
  };
}

export interface ClassifierConfig {
  /** When true, the dispatcher uses an LLM to assign a role to any pending
   *  task that has no role/tag/skill match, so free-text tasks never stall. */
  enabled: boolean;
  exec: 'claude' | 'hermes' | 'agy';
  model: string;
  /** Role used when the LLM's answer doesn't match a configured role. */
  fallbackRole: string;
  /** Per-classification wall-clock budget (ms). */
  timeoutMs: number;
}

/**
 * An agent is a named worker with a capability + an ORDERED list of brains.
 * brains[0] is tried first; on failure the dispatcher hands the task to
 * brains[1], then brains[2], … (the list is the fallback chain). Editable live
 * from the dashboard's Agents view.
 */
export interface AgentConfig {
  description: string;
  brains: string[];
}

export interface OrchestrationConfig {
  enabled: boolean;
  /** Global ceiling on locally-spawned concurrent runs across ALL brains. The
   *  per-brain {@link BrainConfig.maxConcurrent} caps are the finer governor; this
   *  is the total the host machine will run at once. */
  maxConcurrent: number;
  /** Fallback per-brain concurrency for any brain without its own maxConcurrent.
   *  Default 1 (one task at a time), preserving the historical behaviour. */
  defaultBrainConcurrency?: number;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  defaultRole: string;
  /** The global default brain fallback chain (ordered brain ids). Used by any
   *  roster-agent task whose division has no override. Drag-sortable in the UI. */
  defaultChain?: string[];
  /** Per-division overrides of the default chain (division id -> brain ids). */
  divisionChains?: Record<string, string[]>;
  /** Per-roster-agent overrides of the chain (agent slug -> brain ids). Highest
   *  precedence for a roster agent: an agent with its own chain here ignores its
   *  division override and the global default. Editable live from the Agents view. */
  agentChains?: Record<string, string[]>;
  /** Special (non-roster) executor agents: orchestrator (router/decomposer),
   *  video (LTX pipeline), generalist (fallback). Each has its own brain chain. */
  agents: Record<string, AgentConfig>;
  /** Grace period before a task on a REMOTE brain in a chain auto-advances to
   *  the next brain if no client has claimed it (ms; 0 disables). */
  remoteGraceMs?: number;
  /** Legacy role map (pre-agents). Read only if an agent of the same name is
   *  absent; kept so old configs keep working. */
  roles?: Record<string, RoleConfig>;
  /** Named execution identities (model×platform×location) the orchestrator can
   *  target via a task's context.brain. */
  brains?: Record<string, BrainConfig>;
  /** LLM classifier that assigns roles to roleless tasks. */
  classifier?: ClassifierConfig;
  /** Result verifier — rejects soft failures (rate-limit/empty/refusal) that
   *  exited 0, so they trigger a fallback-brain handover instead of "done". */
  verifier?: VerifierConfig;
  /** Reclaim in-progress tasks whose claim has gone dead after this many ms
   *  (0 disables). A claim is dead once older than this AND the claimer has
   *  vanished OR reports itself `idle` (its run finished/crashed without a
   *  complete_task). Rescues work orphaned by a crashed/exited agent OR by a
   *  live-but-idle client that dropped its child. */
  staleClaimMs?: number;
  /** Absolute ceiling (ms) on an in-progress claim regardless of what the
   *  claimer reports: past this, the task is reclaimed even if the claimer still
   *  heartbeats `working` — a backstop for a client wedged on a hung child.
   *  0/undefined disables the ceiling (only staleClaimMs applies). */
  hardClaimMs?: number;
  /** Safety bound on an orchestrated workflow run: the max number of steps the
   *  orchestrator may dispatch before the run is force-finished (prevents a
   *  runaway decision loop). Default 12. */
  maxWorkflowSteps?: number;
}

export interface Config {
  server: {
    port: number;
    host: string;
    name: string;
    version: string;
    apiKey: string | null;
    corsOrigin: string;
  };
  paths: {
    agencyAgents: string;
    inbox: string;
    /** Per-task output files, downloadable from the Inbox. */
    artifacts: string;
    /** Files a person attaches to a task for the brain to read. */
    inputs: string;
    status: string;
    decisions: string;
    /** Dir of declarative workflow templates (workflows/*.json). */
    workflows: string;
  };
  platforms: Record<string, PlatformConfig>;
  services: Record<string, ServiceConfig>;
  inbox: {
    autoArchiveDays: number;
    maxRetries: number;
  };
  orchestration: OrchestrationConfig;
}

export interface AgentCard {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  color?: string;
  vibe?: string;
  division?: string;
  divisionLabel?: string;
  divisionIcon?: string;
  sourcePath: string;
  platforms?: string[];
}

export interface ActiveAgent {
  id: string;
  platform: string;
  agentName: string;
  sessionId?: string;
  capabilities?: string[];
  currentTask?: string;
  status: 'idle' | 'working' | 'blocked';
  registeredAt: string;
  lastHeartbeat: string;
}

/**
 * One human-in-the-loop input control on a task card: a question the requester
 * wants a person to answer, or a checklist item to tick, BEFORE (or while) the
 * task is worked. The collected `value` is the person's answer.
 */
export interface InteractionField {
  /** Stable id, unique within the task's interaction (used to key responses). */
  id: string;
  /** Human-facing label / question text. */
  label: string;
  /** Control kind. `checkbox` = a single yes/no (checklist item); `select`
   *  needs `options`; `text`/`textarea` are free-form. Default `text`. */
  type?: 'text' | 'textarea' | 'checkbox' | 'select';
  /** Options for a `select` field. */
  options?: string[];
  /** Block submission until this field is answered. */
  required?: boolean;
  /** Placeholder / helper hint for text fields. */
  placeholder?: string;
  /** The submitted answer (string for text/select, boolean for checkbox). */
  value?: string | boolean;
}

/**
 * A task's human-interaction packet: a set of questions / checklist items a
 * person fills in from the Inbox card so the executing agent has the extra
 * information it needs "in advance". Once submitted, the answers are mirrored
 * into `context.humanInput` so they reach the executor's prompt.
 */
export interface TaskInteraction {
  /** Optional instructions shown above the fields. */
  prompt?: string;
  /** The questions / checklist items to collect. */
  fields: InteractionField[];
  /** `pending` until a person submits, then `submitted`. */
  status?: 'pending' | 'submitted';
  submittedAt?: string;
  /** Free-form label of who provided the input (e.g. a name or agent id). */
  submittedBy?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  from: {
    platform: string;
    agent: string;
  };
  to: {
    platform?: string;
    agent?: string;
  };
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** `wait-input` = a task holding an unanswered human-in-the-loop interaction
   *  packet. It is deliberately NOT `pending`, so the dispatcher never schedules,
   *  routes, or hands it off to a fallback brain. It flips to `pending` (entering
   *  normal scheduling) only once a person submits their answers.
   *  `scheduled` = a task whose `scheduledAt` launch time is still in the future.
   *  Like `wait-input` it is held OUT of the pending pool (never claimed, routed,
   *  or dispatched); the dispatcher releases it to `pending` when its time comes. */
  status: 'wait-input' | 'scheduled' | 'pending' | 'claimed' | 'in-progress' | 'done' | 'rejected';
  skill?: string;
  context?: Record<string, any>;
  tags?: string[];
  /** Human-in-the-loop questions/checklist a person answers from the Inbox card
   *  to supply information in advance. */
  interaction?: TaskInteraction;
  /** ISO 8601 launch time. Default is "now": absent (or already past at creation)
   *  means the task enters the pending pool immediately. A FUTURE time parks the
   *  task on the `scheduled` status until the dispatcher releases it (see
   *  Store.releaseDueScheduled). Normalized to UTC ISO form at creation. */
  scheduledAt?: string;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  result?: string;
  /** Filenames collected from the task's artifacts dir (downloadable when done). */
  artifacts?: string[];
  /**
   * True when the task FINISHED by exhausting its whole fallback chain — every
   * brain failed verification (result is a "FAILED after N attempt(s) (chain
   * exhausted)…" summary). Set centrally by {@link Store.completeTask}. The UI
   * groups these into a red "failed" category and offers a confirm-gated re-run
   * (POST /api/inbox/:id/rerun) instead of silently listing them as "done".
   * Input files a person attached to the task live under `inputs/<taskId>/` and
   * are mirrored onto `context.inputFiles` (filenames) so the brain can read them.
   */
  failed?: boolean;
}

export interface DashboardData {
  activeAgents: number;
  inboxSummary: {
    pending: number;
    /** Tasks parked on `scheduled` — waiting for their launch time. */
    scheduled: number;
    /** Tasks parked on `wait-input` — blocked awaiting a person's answers. */
    waitingInput: number;
    inProgress: number;
    completed: number;
    /** Finished tasks that exhausted their fallback chain (task.failed === true). */
    failed: number;
  };
  platformStatus: Record<string, boolean>;
  rosterCount: number;
  uptime: number;
}

export interface CoworkEventPayloads {
  agentRegistered: { agent: ActiveAgent };
  taskCreated: { task: Task };
  taskClaimed: { task: Task; agentId: string };
  taskCompleted: { task: Task };
  heartbeat: { agentId: string; status: string; currentTask?: string };
}

/**
 * One node of a declarative workflow: a task template. `key` is a stable,
 * template-local id used to wire `dependsOn` edges (resolved to real task ids at
 * expansion time). Exactly the fields a task needs, minus the runtime plumbing.
 */
export interface WorkflowStep {
  /** Unique-within-the-workflow node id. Referenced by other steps' dependsOn. */
  key: string;
  /** Task title. `{{param}}` placeholders are filled from run params. */
  title?: string;
  /** Task description (the standalone brief the executing agent sees). */
  description?: string;
  /** Pin a specific roster/special agent (context.agent). Omit to let the router pick. */
  agent?: string;
  /** Pin a division (context.division) so the router only chooses within it. */
  division?: string;
  /** Pin an exact brain (context.brain). */
  brain?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Step keys (NOT task ids) this step waits for — the DAG edges. */
  dependsOn?: string[];
}

/**
 * A reusable, version-controlled pipeline. Loaded from workflows/<id>.json.
 *
 * Two execution modes:
 *   - `dag` (default): the steps form a static DAG wired by `dependsOn`. The whole
 *     graph is expanded into inbox tasks up front and the dispatcher walks it in
 *     dependency order. Deterministic — same template + params → same shape.
 *   - `orchestrated`: the steps are a LIBRARY of candidate moves. Nothing is
 *     expanded up front; instead, after each step finishes, the orchestrator brain
 *     reads the goal + results so far and DECIDES which step to run next (or that
 *     the goal is met). Adaptive — the path taken depends on what came back.
 */
export interface WorkflowDef {
  id: string;
  /** Human label + one-liner shown in the UI. */
  name?: string;
  description?: string;
  /** `dag` (static, pre-expanded) or `orchestrated` (adaptive). Default `dag`. */
  mode?: 'dag' | 'orchestrated';
  /** Orchestrated mode only: the objective the orchestrator drives toward when
   *  deciding the next step. `{{param}}` placeholders are filled from run params. */
  goal?: string;
  /** Named params required at run time; referenced as {{name}} in steps/goal. */
  params?: string[];
  steps: WorkflowStep[];
}

/**
 * One orchestrator decision in an adaptive run: the step it chose to run next
 * (or `null` = the run is complete), the task that decision created, and a short
 * rationale pulled from the orchestrator's reply — the audit trail the UI renders
 * as a decision log so the adaptive path is fully traceable.
 */
export interface WorkflowDecision {
  stepKey: string | null;
  reason?: string;
  taskId?: string;
  decidedAt: string;
}

/**
 * Persistent state for an ORCHESTRATED run. DAG runs need no record (they are
 * reconstructed from task context), but an adaptive run's goal and decision
 * history live nowhere else, so they are written to workflow-runs/<runId>.json.
 */
export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  mode: 'orchestrated';
  goal?: string;
  params: Record<string, string>;
  status: 'running' | 'done' | 'failed';
  history: WorkflowDecision[];
  createdAt: string;
  updatedAt: string;
}

/** A live/finished run: the tasks one expansion produced, grouped for the UI. */
export interface WorkflowRun {
  runId: string;
  workflowId: string;
  createdAt: string;
  tasks: Task[];
  status: 'running' | 'done' | 'failed';
  /** `orchestrated` runs carry their mode, goal, and decision log; DAG runs omit these. */
  mode?: 'dag' | 'orchestrated';
  goal?: string;
  history?: WorkflowDecision[];
}

export type CoworkEventType = keyof CoworkEventPayloads;

export interface CoworkEvent<T extends CoworkEventType> {
  type: T;
  payload: CoworkEventPayloads[T];
  timestamp: string;
}
