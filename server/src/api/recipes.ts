import { Router } from 'express';
import type { Store } from '../core/store.js';
import { Recipes, draftFromTask, instantiate, recipeStats, recipePitfalls, type RecipeRating } from '../core/recipes.js';

/**
 * REST surface for reusable tasks ("Recipes", see core/recipes.ts).
 *   GET    /recipes                     — library, each with derived stats
 *   GET    /recipes/:id                 — one recipe + stats, versions, runs
 *   POST   /recipes/draft-from-task/:id — editable draft from a finished task (saves nothing)
 *   POST   /recipes                     — save a draft as a recipe (copies the origin task's inputs)
 *   PUT    /recipes/:id                 — edit; brief/fields/carry changes bump the version
 *   DELETE /recipes/:id                 — archive (soft)
 *   POST   /recipes/:id/run             — { values, extra?, brain?, scheduledAt?, recurrence? } → task
 *   POST   /inbox/:id/rating            — { good, note? } 👍/👎 on a task (feeds recipe stats)
 */
export function createRecipeRouter(recipes: Recipes, store: Store): Router {
  const router = Router();
  const allTasks = () => store.listTasks();

  router.get('/recipes', (req, res) => {
    const tasks = allTasks();
    res.json(recipes.list({ includeArchived: req.query.archived === '1' })
      .map(r => ({ ...r, stats: recipeStats(r, tasks) })));
  });

  router.get('/recipes/:id', (req, res) => {
    const r = recipes.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'recipe not found' });
    const tasks = allTasks();
    const runs = tasks.filter(t => t.context?.recipe?.id === r.id).slice(0, 50).map(t => ({
      id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, completedAt: t.completedAt,
      version: t.context?.recipe?.version, brain: t.context?.ranBrain || t.context?.brain,
      rating: t.context?.rating || null, failed: (t as any).failed === true || /^FAILED\b/i.test(String(t.result || '').trim()),
    }));
    res.json({ ...r, stats: recipeStats(r, tasks), versions: recipes.versions(r.id), runs });
  });

  router.post('/recipes/draft-from-task/:taskId', (req, res) => {
    const task = store.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    try { res.json(draftFromTask(task)); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.post('/recipes', (req, res) => {
    try {
      const body = req.body || {};
      const originId = body.origin?.taskId;
      const originInputs = originId ? store.inputsPath(String(originId)) : null;
      const r = recipes.create(body, originInputs);
      res.status(201).json(r);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.put('/recipes/:id', (req, res) => {
    try { res.json(recipes.update(req.params.id, req.body || {})); }
    catch (e: any) { res.status(/not found/.test(e.message) ? 404 : 400).json({ error: e.message }); }
  });

  router.delete('/recipes/:id', (req, res) => {
    try { res.json(recipes.archive(req.params.id)); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  router.post('/recipes/:id/run', (req, res) => {
    try {
      const r = recipes.get(req.params.id);
      if (!r || r.archived) return res.status(404).json({ error: 'recipe not found' });
      const body = req.body || {};
      const params = instantiate(r, {
        values: body.values && typeof body.values === 'object' ? body.values : {},
        extra: typeof body.extra === 'string' ? body.extra : undefined,
        brain: typeof body.brain === 'string' ? body.brain : undefined,
        pitfalls: recipePitfalls(r, allTasks()),
        scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt : undefined,
        recurrence: body.recurrence ?? undefined,
      });
      const staged = [...recipes.stageInputs(r), ...(Array.isArray(body.inputs) ? body.inputs : [])];
      const task = store.createTask(params, { inputs: staged });
      res.status(201).json(task);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.post('/inbox/:id/rating', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const body = req.body || {};
    if (body.good === null) {
      if (task.context) delete task.context.rating;
    } else {
      if (typeof body.good !== 'boolean') return res.status(400).json({ error: 'good (boolean, or null to clear) is required' });
      const rating: RecipeRating = { good: body.good, at: new Date().toISOString() };
      if (typeof body.note === 'string' && body.note.trim()) rating.note = body.note.trim().slice(0, 500);
      task.context = { ...(task.context || {}), rating };
    }
    store.saveTask(task);
    res.json(task);
  });

  return router;
}
