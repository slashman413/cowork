import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { activeConfigPath } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { Store } from '../core/store.js';
import { buildCalendar } from '../core/calendar.js';
import type { EventBus } from '../core/events.js';
import { mergeWorktree, removeWorktree } from '../core/worktree.js';
import { sharpenInBackground } from '../core/sharpener.js';
import { applyPstackCommand, PLAYBOOK_KEYS, DEFAULT_PSTACK_SKILLS_DIR } from '../core/playbooks.js';
import { boundTaskArtifacts } from '../core/artifact-list.js';

export function createApiRouter(store: Store, eventBus: EventBus): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    res.json(store.getDashboard());
  });

  /** rerun / reassign / continue take an optional { thinking } for the coming run. */
  const withThinking = (task: any, body: any) =>
    task && typeof body?.thinking === 'string' ? store.updateTask(task.id, { thinking: body.thinking }) ?? task : task;

  router.get('/workers', (req, res) => {
    res.json(store.getActiveWorkers({
      platform: req.query.platform as string,
      status: req.query.status as string
    }));
  });

  // Over-long artifact lists are capped per task (boundTaskArtifacts) so one task
  // with tens of thousands of files can't turn every Tasks-page refresh into a
  // multi-megabyte download + DOM build.
  router.get('/inbox', (req, res) => {
    res.json(store.listTasks({
      status: req.query.status as string,
      platform: req.query.platform as string,
      agent: req.query.agent as string,
      tag: req.query.tag as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
    }).map(t => boundTaskArtifacts(t)));
  });

  // Calendar projection for the Calendar page: past runs + projected future fires
  // of scheduled tasks in [from, to) (ISO; default: 7 days back .. 35 days ahead,
  // window capped at 100 days). See core/calendar.ts.
  router.get('/calendar', (req, res) => {
    const DAY = 86400000;
    const now = new Date();
    const parse = (v: unknown, dflt: number) => {
      const ms = typeof v === 'string' && v ? Date.parse(v) : NaN;
      return Number.isFinite(ms) ? ms : dflt;
    };
    const from = parse(req.query.from, now.getTime() - 7 * DAY);
    const to = parse(req.query.to, now.getTime() + 35 * DAY);
    if (to <= from) return res.status(400).json({ error: '`to` must be after `from`' });
    if (to - from > 100 * DAY) return res.status(400).json({ error: 'calendar window is capped at 100 days' });
    res.json(buildCalendar(store.listTasks({}), new Date(from), new Date(to), now));
  });

  // Single task by id — used by the Chat UI to poll a dispatched task to completion.
  router.get('/inbox/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(boundTaskArtifacts(task));
  });

  // Live progress log for a running task — the tail of the agent's stdout/stderr the
  // dispatcher streams to artifacts/<id>/progress.log. The dashboard polls this on
  // an in-progress card to show "what it is doing right now". Always 200 (empty log
  // when nothing has been written yet); never 404 so a card can poll optimistically.
  router.get('/inbox/:id/progress', (req, res) => {
    res.json(store.readProgressLog(req.params.id));
  });

  // Toggle automatic re-run-on-reset for a rate-limited failed task. Body:
  // { enabled: boolean }. When enabled, the dispatcher re-queues the task once its
  // rate-limit window resets (Dispatcher.autoRerunRateLimited).
  router.post('/inbox/:id/auto-rerun', (req, res) => {
    try {
      const enabled = !!(req.body && req.body.enabled);
      const task = store.setAutoRerun(req.params.id, enabled);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // pstack vocabulary for the Create form (G9): playbook keys + vendored skills.
  router.get('/pstack', (_req, res) => {
    let skills: string[] = [];
    try {
      skills = fs.readdirSync(DEFAULT_PSTACK_SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(DEFAULT_PSTACK_SKILLS_DIR, d.name, 'SKILL.md')))
        .map(d => d.name).sort();
    } catch { /* vendor tree absent — playbooks only */ }
    res.json({ playbooks: PLAYBOOK_KEYS, skills });
  });

  router.post('/inbox', async (req, res) => {
    try {
      const body = req.body || {};
      // Minimal shape validation — tasks are persisted as-is to disk and every
      // later read assumes these fields exist.
      if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('title (string) is required');
      if (typeof body.description !== 'string') throw new Error('description (string) is required');
      if (!body.from || typeof body.from.platform !== 'string' || typeof body.from.agent !== 'string') {
        throw new Error('from.platform and from.agent (strings) are required');
      }
      // `/pstack <playbook|skill> <text>` in the brief (or title) sets
      // context.playbook / context.skill (G9); malformed → 400.
      const ps = applyPstackCommand({ title: body.title, description: body.description, context: body.context });
      const task = store.createTask({
        title: ps.title,
        description: ps.description,
        from: { platform: body.from.platform, agent: body.from.agent },
        to: { platform: body.to?.platform, agent: body.to?.agent },
        priority: ['low', 'normal', 'high', 'urgent'].includes(body.priority) ? body.priority : 'normal',
        skill: body.skill,
        // Brief contract (P0-3) rides inside context: context.acceptance /
        // verify / timeboxMin / scope. Validated in the store (bad shape → 400).
        context: ps.context,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        interaction: body.interaction && Array.isArray(body.interaction.fields) ? body.interaction : undefined,
        // Scheduled launch (ISO 8601; default "now"). Accept both key styles —
        // the dashboard sends scheduledAt, MCP-side callers may echo scheduled_at.
        scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt
          : typeof body.scheduled_at === 'string' ? body.scheduled_at : undefined,
        loopIntervalHours: typeof body.loopIntervalHours === 'number' ? body.loopIntervalHours : undefined,
        // Flexible periodic cadence (minutes/hours/daily/weekly/monthly/cron).
        // Validated + normalized in the store; an invalid spec 400s below.
        recurrence: body.recurrence != null ? body.recurrence : undefined
      }, {
        // Staged input uploads (from POST /api/uploads) the agent should read.
        inputs: Array.isArray(body.inputs) ? body.inputs : undefined
      });
      // Intake brief sharpener (PS-1): runs in the background — awaiting it here
      // held the dashboard's Create for up to 60 s (see sharpenInBackground).
      const cfg = store.getConfig?.();
      if (cfg) void sharpenInBackground(store, task.id, { config: cfg, decisionsDir: cfg.paths?.decisions });
      res.status(201).json(store.getTask(task.id) || task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/inbox/:id', async (req, res) => {
    try {
      const taskId = req.params.id;
      const { action, workerId, result } = req.body;
      let task = null;

      if (action === 'claim') {
        if (!workerId) throw new Error('workerId is required for claim');
        task = store.claimTask({ taskId, workerId });
      } else if (action === 'complete') {
        // completeTask runs the completion guard: a remote agent that reports a
        // soft failure (rate limit / session limit / empty) is handed to the next
        // fallback agent and the task stays pending instead of being marked done.
        task = await store.completeTask({ taskId, result });
      } else {
        throw new Error('Invalid action');
      }
      
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Purge finished, unremarkable tasks (keeps anything with artifacts or a
  // keep/important/pinned tag). Declared before /inbox/:id so "purge" isn't
  // swallowed as a task id. Pass dryRun to preview.
  router.post('/inbox/purge', (req, res) => {
    try {
      const { olderThanDays, dryRun } = req.body || {};
      res.json(store.purgeTasks({
        olderThanDays: olderThanDays === undefined ? undefined : Number(olderThanDays),
        dryRun: !!dryRun
      }));
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // Re-run a FAILED (chain-exhausted) or rejected task — reset it to pending from
  // the top of its chain, keeping its brief + attached inputs. The dashboard gates
  // this behind an explicit user confirmation (categorize-failed → confirm re-run).
  router.post('/inbox/:id/rerun', (req, res) => {
    try {
      // Optional { agent }: '' → route via the role's agent chain, '<id>' → pin that
      // agent, absent → keep the task's existing agent targeting (default).
      const agent = typeof req.body?.agent === 'string' ? req.body.agent : undefined;
      const scheduledAt = typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt
        : typeof req.body?.scheduled_at === 'string' ? req.body.scheduled_at : undefined;
      const task = withThinking(store.rerunTask(req.params.id, agent, { scheduledAt }), req.body);
      if (!task) return res.status(404).json({ error: 'Task not found or not in a re-runnable (failed) state' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Reassign a task that hasn't started (pending / scheduled) to another agent —
  // e.g. one held while its agent cools down on a rate limit. Body { agent }:
  // '' → route via the role's agent chain, '<id>' → pin that agent.
  router.post('/inbox/:id/reassign', (req, res) => {
    try {
      const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
      const task = withThinking(store.reassignTask(req.params.id, agent), req.body);
      if (!task) return res.status(409).json({ error: 'Task not found or already started — only pending/scheduled tasks can be reassigned (re-run a failed one instead)' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Run a SCHEDULED task NOW — release it immediately instead of at its
  // scheduledAt time. The dashboard shows this as a "Run now" button on
  // scheduled cards. Returns the released task (now pending, or wait-input if it
  // still needs a person's answers).
  router.post('/inbox/:id/run-now', (req, res) => {
    try {
      const task = store.runScheduledNow(req.params.id);
      if (!task) return res.status(400).json({ error: 'Task not found or not in a scheduled state' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Edit an EXISTING task's parameters (the counterpart to POST /inbox — the New
  // task composer, but with the task's fields loaded and saved back). Only tasks
  // that are NOT running or pending are editable (scheduled / wait-input / done /
  // rejected / failed); the store rejects the rest. Body mirrors POST /inbox:
  // { title?, description?, priority?, tags?, context?:{agent,division,agent},
  //   scheduledAt?, loopIntervalHours? }. Returns the updated task.
  router.post('/inbox/:id/edit', (req, res) => {
    try {
      const b = req.body || {};
      const c = b.context && typeof b.context === 'object' ? b.context : {};
      const patch: any = {};
      if (typeof b.title === 'string') patch.title = b.title;
      if (typeof b.description === 'string') patch.description = b.description;
      if (typeof b.priority === 'string') patch.priority = b.priority;
      if (Array.isArray(b.tags)) patch.tags = b.tags;
      // Routing pins: accept both a flat body and a { context } object. A key set
      // to '' (or null) clears that pin (back to Auto); omitting it leaves it as-is.
      if ('persona' in c) patch.persona = c.persona;
      if ('thinking' in c) patch.thinking = c.thinking;
      if ('division' in c) patch.division = c.division;
      if ('agent' in c) patch.agent = c.agent;
      if ('acceptance' in b) patch.acceptance = b.acceptance;
      else if ('acceptance' in c) patch.acceptance = c.acceptance;
      // Scheduling. Accept scheduledAt/scheduled_at; '' or null clears it.
      if ('scheduledAt' in b) patch.scheduledAt = b.scheduledAt;
      else if ('scheduled_at' in b) patch.scheduledAt = b.scheduled_at;
      if ('loopIntervalHours' in b) {
        patch.loopIntervalHours = b.loopIntervalHours === null || b.loopIntervalHours === ''
          ? null : Number(b.loopIntervalHours);
      }
      // Flexible cadence: a spec object sets it, null / '' / {type:'none'} clears it.
      if ('recurrence' in b) {
        patch.recurrence = (b.recurrence === null || b.recurrence === '') ? null : b.recurrence;
      }
      const task = store.updateTask(req.params.id, patch);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Continue a DONE (successful) task — spawn a follow-up task seeded with the
  // finished run's OUTPUT files + result as inputs, pinned to the same executor,
  // so the work carries forward. The dashboard shows this as a "Continue" button
  // on done cards. 201 + the new task (so the UI can jump to it).
  router.post('/inbox/:id/continue', (req, res) => {
    try {
      // Optional { agent }: '' → route via the role's agent chain, '<id>' → pin that
      // agent to claim the follow-up, absent → same agent as the original (default).
      const agent = typeof req.body?.agent === 'string' ? req.body.agent : undefined;
      // Optional extra steer from the Continue dialog: a { prompt } appended to
      // the follow-up's brief, and { inputs } ([{token,name}] staged uploads)
      // attached alongside the prior run's outputs.
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
      const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : undefined;
      const scheduledAt = typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt
        : typeof req.body?.scheduled_at === 'string' ? req.body.scheduled_at : undefined;
      const task = withThinking(store.continueTask(req.params.id, agent, { prompt, inputs, scheduledAt }), req.body);
      if (!task) return res.status(400).json({ error: 'Task not found or not in a continuable (finished-success) state' });
      res.status(201).json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Attach staged input uploads to an EXISTING task (union onto context.inputFiles
  // so the agent reads them). Body: { inputs: [{ token, name }] } — tokens come
  // from POST /api/uploads.
  router.post('/inbox/:id/inputs', (req, res) => {
    try {
      const inputs = req.body?.inputs;
      if (!Array.isArray(inputs) || !inputs.length) throw new Error('inputs ([{token,name}]) is required');
      const task = store.appendInputs(req.params.id, inputs);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // List a task's attached input files (downloadable via the index.ts route).
  router.get('/inbox/:id/inputs', (req, res) => {
    res.json(store.listInputs(req.params.id));
  });

  // Submit a person's answers to a task's interaction (questions/checklist).
  // Body: { responses: { <fieldId>: string | boolean }, submittedBy?: string }.
  // The answers are recorded on the task and mirrored into context.humanInput so
  // the executing agent sees them.
  router.post('/inbox/:id/interaction', (req, res) => {
    try {
      const { responses, submittedBy } = req.body || {};
      if (!responses || typeof responses !== 'object') {
        throw new Error('responses (object of fieldId → value) is required');
      }
      const task = store.submitInteraction({ taskId: req.params.id, responses, submittedBy });
      if (!task) return res.status(404).json({ error: 'Task not found or has no interaction' });
      res.json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Code-task worktree actions (see core/worktree.ts). Merge refuses on conflicts or
  // a dirty main checkout; discard removes the worktree and deletes its branch.
  router.post('/inbox/:id/worktree/merge', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task?.worktree || task.worktree.merged || task.worktree.discarded) return res.status(404).json({ error: 'Task has no open worktree' });
    const out = mergeWorktree(task.worktree);
    if (!out.ok) return res.status(409).json({ error: out.message });
    task.worktree.merged = true;
    removeWorktree(task.worktree, true);
    store.saveTask(task);
    res.json({ ok: true, message: out.message, task });
  });

  router.post('/inbox/:id/worktree/discard', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task?.worktree || task.worktree.merged || task.worktree.discarded) return res.status(404).json({ error: 'Task has no open worktree' });
    const out = removeWorktree(task.worktree, true);
    if (!out.ok) return res.status(500).json({ error: out.message });
    task.worktree.discarded = true;
    store.saveTask(task);
    res.json({ ok: true, message: out.message, task });
  });

  // Delete one task + its artifacts + its input files.
  router.delete('/inbox/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    const out = store.deleteTask(req.params.id);
    if (!out.deleted) return res.status(404).json({ error: 'Task not found' });
    // Leave a trace: inbox/ is gitignored, so without this a deleted task is
    // unattributable later ("where did my scheduled task go?").
    console.log(`Store: deleted task ${task?.id} (${task?.status}) via API — ${task?.title}`);
    res.json({ ok: true, ...out });
  });

  router.get('/roster', (req, res) => {
    res.json(store.getRoster({
      search: req.query.search as string,
      division: req.query.division as string
    }));
  });

  router.get('/roster/divisions', (req, res) => {
    res.json(store.getDivisions());
  });

  router.get('/config', (req, res) => {
    const config = (store as any).config;
    const sanitized = JSON.parse(JSON.stringify(config));

    // Never leak the API key through the config endpoint
    if (sanitized.server) sanitized.server.apiKey = sanitized.server.apiKey ? '***' : null;

    res.json(sanitized);
  });

  router.put('/config', express.json(), (req, res) => {
    try {
      const newConfig = req.body;
      if (!newConfig || typeof newConfig !== 'object') {
        throw new Error('Invalid config body');
      }

      const configPath = activeConfigPath();
      let current: any = {};
      try { current = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* ignore */ }

      // Restore API key if it was masked
      if (newConfig.server && newConfig.server.apiKey === '***') {
        newConfig.server.apiKey = current.server?.apiKey || null;
      }

      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

      res.json({ ok: true });

      // Mirroring the live config into the tracked template and pushing it leaks
      // host-personal settings (and any apiKey) into git, so it is opt-in only
      // (COWORK_CONFIG_GIT_PUSH=1), and the template copy never carries the key.
      // Either way the process exits so systemd restarts it on the new config.
      const repoTemplate = path.resolve(__dirname, '../../config.json');
      if (process.env.COWORK_CONFIG_GIT_PUSH === '1' && fs.existsSync(repoTemplate)) {
        const templateCopy = { ...newConfig, server: { ...(newConfig.server || {}), apiKey: null } };
        fs.writeFileSync(repoTemplate, JSON.stringify(templateCopy, null, 2));
        import('child_process').then(({ exec }) => {
          exec('git add config.json && git commit -m "chore: update config via web UI" && git push', { cwd: path.resolve(__dirname, '../../') }, (err) => {
            if (err) console.error('Failed to commit config changes:', err);
            else console.log('Config changes committed and pushed');
            process.exit(0);
          });
        }).catch(err => console.error('Failed to load child_process:', err));
      } else {
        setTimeout(() => process.exit(0), 250);
      }
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
