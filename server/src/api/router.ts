import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { activeConfigPath } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { Store } from '../core/store.js';
import type { EventBus } from '../core/events.js';

export function createApiRouter(store: Store, eventBus: EventBus): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    res.json(store.getDashboard());
  });

  router.get('/agents', (req, res) => {
    res.json(store.getActiveAgents({
      platform: req.query.platform as string,
      status: req.query.status as string
    }));
  });

  router.get('/inbox', (req, res) => {
    res.json(store.listTasks({
      status: req.query.status as string,
      platform: req.query.platform as string,
      agent: req.query.agent as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
    }));
  });

  // Single task by id — used by the Chat UI to poll a dispatched task to completion.
  router.get('/inbox/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  router.post('/inbox', (req, res) => {
    try {
      const body = req.body || {};
      // Minimal shape validation — tasks are persisted as-is to disk and every
      // later read assumes these fields exist.
      if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('title (string) is required');
      if (typeof body.description !== 'string') throw new Error('description (string) is required');
      if (!body.from || typeof body.from.platform !== 'string' || typeof body.from.agent !== 'string') {
        throw new Error('from.platform and from.agent (strings) are required');
      }
      const task = store.createTask({
        title: body.title,
        description: body.description,
        from: { platform: body.from.platform, agent: body.from.agent },
        to: { platform: body.to?.platform, agent: body.to?.agent },
        priority: ['low', 'normal', 'high', 'urgent'].includes(body.priority) ? body.priority : 'normal',
        skill: body.skill,
        context: body.context,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        interaction: body.interaction && Array.isArray(body.interaction.fields) ? body.interaction : undefined,
        // Scheduled launch (ISO 8601; default "now"). Accept both key styles —
        // the dashboard sends scheduledAt, MCP-side callers may echo scheduled_at.
        scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt
          : typeof body.scheduled_at === 'string' ? body.scheduled_at : undefined
      }, {
        // Staged input uploads (from POST /api/uploads) the brain should read.
        inputs: Array.isArray(body.inputs) ? body.inputs : undefined
      });
      res.status(201).json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/inbox/:id', async (req, res) => {
    try {
      const taskId = req.params.id;
      const { action, agentId, result } = req.body;
      let task = null;

      if (action === 'claim') {
        if (!agentId) throw new Error('agentId is required for claim');
        task = store.claimTask({ taskId, agentId });
      } else if (action === 'complete') {
        // completeTask runs the completion guard: a remote brain that reports a
        // soft failure (rate limit / session limit / empty) is handed to the next
        // fallback brain and the task stays pending instead of being marked done.
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
      // Optional { brain }: '' → route via the agent's chain, '<id>' → pin that
      // brain, absent → keep the task's existing brain targeting (default).
      const brain = typeof req.body?.brain === 'string' ? req.body.brain : undefined;
      const scheduledAt = typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt
        : typeof req.body?.scheduled_at === 'string' ? req.body.scheduled_at : undefined;
      const task = store.rerunTask(req.params.id, brain, { scheduledAt });
      if (!task) return res.status(404).json({ error: 'Task not found or not in a re-runnable (failed) state' });
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
      // Optional { brain }: '' → route via the agent's chain, '<id>' → pin that
      // brain to claim the follow-up, absent → same brain as the original (default).
      const brain = typeof req.body?.brain === 'string' ? req.body.brain : undefined;
      // Optional extra steer from the Continue dialog: a { prompt } appended to
      // the follow-up's brief, and { inputs } ([{token,name}] staged uploads)
      // attached alongside the prior run's outputs.
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
      const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : undefined;
      const scheduledAt = typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt
        : typeof req.body?.scheduled_at === 'string' ? req.body.scheduled_at : undefined;
      const task = store.continueTask(req.params.id, brain, { prompt, inputs, scheduledAt });
      if (!task) return res.status(400).json({ error: 'Task not found or not in a continuable (finished-success) state' });
      res.status(201).json(task);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Attach staged input uploads to an EXISTING task (union onto context.inputFiles
  // so the brain reads them). Body: { inputs: [{ token, name }] } — tokens come
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

  // Delete one task + its artifacts + its input files.
  router.delete('/inbox/:id', (req, res) => {
    const out = store.deleteTask(req.params.id);
    if (!out.deleted) return res.status(404).json({ error: 'Task not found' });
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

      // Also update the repo template if we are in the repo, commit, push, and restart
      const repoTemplate = path.resolve(__dirname, '../../config.json');
      if (fs.existsSync(repoTemplate)) {
        fs.writeFileSync(repoTemplate, JSON.stringify(newConfig, null, 2));
        import('child_process').then(({ exec }) => {
          exec('git add config.json && git commit -m "chore: update config via web UI" && git push', { cwd: path.resolve(__dirname, '../../') }, (err) => {
            if (err) console.error('Failed to commit config changes:', err);
            else console.log('Config changes committed and pushed');
            // Graceful restart (if managed by systemd/pm2, this will restart it)
            process.exit(0);
          });
        }).catch(err => console.error('Failed to load child_process:', err));
      }

      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
