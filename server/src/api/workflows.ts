import { Router } from 'express';
import type { Workflows } from '../core/workflows.js';

/**
 * REST surface for the declarative workflow layer.
 *   GET  /workflows                 — list templates (validated)
 *   GET  /workflows-invalid         — templates that failed to load, with reasons
 *   GET  /workflows/:id             — one template
 *   POST /workflows                 — author a NEW template; { def, overwrite? }
 *   PUT  /workflows/:id             — replace a template (id taken from the path)
 *   POST /workflows/:id/run         — expand into tasks; { params, dryRun }
 *   GET  /workflow-runs             — every run, grouped from task context
 *   GET  /workflow-runs/:runId      — one run's tasks + DAG status
 */
export function createWorkflowRouter(workflows: Workflows): Router {
  const router = Router();

  router.get('/workflows', (_req, res) => {
    res.json(workflows.list());
  });

  router.get('/workflows-invalid', (_req, res) => {
    res.json(workflows.listInvalid());
  });

  router.get('/workflows/:id', (req, res) => {
    const def = workflows.get(req.params.id);
    if (!def) return res.status(404).json({ error: 'workflow not found' });
    res.json(def);
  });

  // Author a NEW template. Accepts either { def, overwrite? } or a raw definition
  // body; the def is validated + persisted to workflows/<id>.json.
  router.post('/workflows', (req, res) => {
    try {
      const body = req.body || {};
      const { def: nested, overwrite, ...rest } = body;
      const def = nested && typeof nested === 'object' ? nested : rest;
      const created = workflows.create(def, { overwrite: !!overwrite });
      res.status(201).json({ ok: true, workflow: created });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Replace an existing template (or create it) — id is taken from the path.
  router.put('/workflows/:id', (req, res) => {
    try {
      const body = req.body || {};
      const def = { ...(body.def && typeof body.def === 'object' ? body.def : body), id: req.params.id };
      delete (def as any).overwrite;
      const saved = workflows.create(def, { overwrite: true });
      res.json({ ok: true, workflow: saved });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/workflows/:id/run', (req, res) => {
    try {
      const body = req.body || {};
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const result = workflows.run(req.params.id, params, { dryRun: !!body.dryRun });
      res.status(result.dryRun ? 200 : 201).json(result);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/workflow-runs', (_req, res) => {
    res.json(workflows.listRuns());
  });

  router.get('/workflow-runs/:runId', (req, res) => {
    const run = workflows.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  });

  router.delete('/workflow-runs/:runId', (req, res) => {
    try {
      workflows.deleteRun(req.params.runId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/workflow-runs', (req, res) => {
    try {
      workflows.deleteAllRuns();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
