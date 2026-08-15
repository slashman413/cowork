import { Router } from 'express';
import type { Goals } from '../core/goals.js';

/**
 * REST surface for the Goals feature — long-lived, phase-tracked objectives that
 * sit beneath Workflows. Authoring (create/edit/validate) plus lifecycle control
 * (activate/pause/block) and the lineage/minutes read views. Autonomous
 * progress is driven by the dispatcher; this surface is for humans authoring and
 * supervising goals.
 *
 *   GET    /goals                     list goal records (newest first)
 *   POST   /goals                     create a draft goal
 *   GET    /goals/:id                 one goal + phases + history + minutes
 *   PATCH  /goals/:id                 edit criteria/phases/brains/budget
 *   POST   /goals/:id/activate        draft/paused/blocked → active (resume)
 *   POST   /goals/:id/pause           active → paused
 *   POST   /goals/:id/block           recoverable hold, with reason + unblockCriteria
 *   DELETE /goals/:id                 remove goal (?withTasks=1 drops its tasks)
 *   GET    /goals/:id/tasks           the tasks this goal generated (lineage)
 */
export function createGoalRouter(goals: Goals): Router {
  const router = Router();

  router.get('/goals', (_req, res) => {
    res.json(goals.list());
  });

  router.post('/goals', (req, res) => {
    try {
      const b = req.body || {};
      const created = goals.create({
        title: b.title,
        description: b.description,
        successCriteria: b.successCriteria,
        reportBrief: b.reportBrief,
        phases: Array.isArray(b.phases) ? b.phases : [],
        achieverBrainChain: b.achieverBrainChain,
        judgerBrainChain: b.judgerBrainChain,
        stepBudget: b.stepBudget
      });
      res.status(201).json({ ok: true, goal: created });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/goals/:id', (req, res) => {
    const g = goals.get(req.params.id);
    if (!g) return res.status(404).json({ error: 'goal not found' });
    res.json(g);
  });

  router.patch('/goals/:id', (req, res) => {
    try {
      const updated = goals.update(req.params.id, req.body || {});
      res.json({ ok: true, goal: updated });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/goals/:id/activate', (req, res) => {
    try { res.json({ ok: true, goal: goals.activate(req.params.id) }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.post('/goals/:id/pause', (req, res) => {
    try { res.json({ ok: true, goal: goals.pause(req.params.id) }); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.post('/goals/:id/block', (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || 'blocked by a human');
      const unblockCriteria = req.body && req.body.unblockCriteria ? String(req.body.unblockCriteria) : undefined;
      res.json({ ok: true, goal: goals.block(req.params.id, reason, unblockCriteria) });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/goals/:id', (req, res) => {
    try {
      goals.delete(req.params.id, { withTasks: req.query.withTasks === '1' || req.query.withTasks === 'true' });
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.get('/goals/:id/tasks', (req, res) => {
    if (!goals.get(req.params.id)) return res.status(404).json({ error: 'goal not found' });
    res.json(goals.generatedTasks(req.params.id));
  });

  return router;
}
