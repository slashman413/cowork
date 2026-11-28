/**
 * REST API for Workspaces & Continuous Working Sessions (`api/workspaces.ts`).
 *
 *   GET    /workspaces                        — list workspaces with live stats + session summaries
 *   POST   /workspaces                        — create workspace ({ name|title, path?, description?, ... })
 *   GET    /workspaces/:id                    — workspace detail (sessions + tasks)
 *   PATCH  /workspaces/:id                    — update workspace settings
 *   PUT    /workspaces/:id                    — alias for PATCH
 *   DELETE /workspaces/:id                    — delete workspace (detaches tasks, deletes sessions)
 *   GET    /workspaces/:id/tasks              — tasks scoped to this workspace
 *   POST   /workspaces/:id/tasks              — create task inside this workspace
 *   POST   /workspaces/:id/tasks/:taskId      — attach an existing task to this workspace
 *   DELETE /workspaces/:id/tasks/:taskId      — detach a task from this workspace
 *   GET    /workspaces/:id/sessions           — sessions scoped to this workspace
 *   POST   /workspaces/:id/sessions           — create session (optional initial `prompt` starts Turn 1)
 *   GET    /sessions                          — list sessions (optional `?workspaceId=`)
 *   GET    /sessions/:sessionId               — session detail with full turn transcript
 *   PATCH  /sessions/:sessionId               — update session (rename, pin, archive, reorder, skills, agent)
 *   DELETE /sessions/:sessionId               — delete session
 *   POST   /sessions/:sessionId/messages      — send prompt into continuous session (auto-injects pstack skills)
 *   POST   /sessions/:sessionId/turns         — alias for /messages
 *   POST   /sessions/:sessionId/pause         — pause active turn
 *   POST   /sessions/:sessionId/resume        — resume paused/failed/idle session
 *   POST   /sessions/:sessionId/fork          — fork session into a sibling session in same workspace
 */
import { Router } from 'express';
import { boundTaskArtifacts } from '../core/artifact-list.js';
import { applyPstackCommand } from '../core/playbooks.js';
import type { Workspaces } from '../core/workspaces.js';

export function createWorkspaceRouter(workspaces: Workspaces): Router {
  const router = Router();

  router.get('/workspaces', (req, res) => {
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    res.json(workspaces.listWorkspaces({ includeArchived }));
  });

  router.post('/workspaces', (req, res) => {
    try {
      const ws = workspaces.createWorkspace(req.body || {});
      res.status(201).json(ws);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id', (req, res) => {
    const detail = workspaces.getWorkspaceDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Workspace not found' });
    res.json({
      ...detail,
      tasks: detail.tasks.map(t => boundTaskArtifacts(t)),
    });
  });

  const updateWorkspaceHandler = (req: any, res: any) => {
    try {
      const ws = workspaces.updateWorkspace(req.params.id, req.body || {});
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      res.json(ws);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  };
  router.patch('/workspaces/:id', updateWorkspaceHandler);
  router.put('/workspaces/:id', updateWorkspaceHandler);

  router.delete('/workspaces/:id', (req, res) => {
    const out = workspaces.deleteWorkspace(req.params.id);
    if (!out.deleted) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ ok: true, ...out });
  });

  router.get('/workspaces/:id/tasks', (req, res) => {
    const ws = workspaces.getWorkspace(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const tasks = workspaces.listWorkspaceTasks(ws.id, {
      status: req.query.status as string,
      platform: req.query.platform as string,
      agent: req.query.agent as string,
      tag: req.query.tag as string,
      sessionId: req.query.sessionId as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    }).map(t => boundTaskArtifacts(t));
    res.json({ workspaceId: ws.id, tasks });
  });

  router.post('/workspaces/:id/tasks', (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('title (string) is required');
      if (typeof body.description !== 'string') throw new Error('description (string) is required');
      const ps = applyPstackCommand({ title: body.title, description: body.description, context: body.context });
      const task = workspaces.createWorkspaceTask(req.params.id, {
        title: ps.title,
        description: ps.description,
        from: body.from && typeof body.from.platform === 'string' && typeof body.from.agent === 'string'
          ? { platform: body.from.platform, agent: body.from.agent }
          : undefined,
        to: body.to,
        priority: ['low', 'normal', 'high', 'urgent'].includes(body.priority) ? body.priority : 'normal',
        skill: body.skill,
        context: ps.context,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        interaction: body.interaction && Array.isArray(body.interaction.fields) ? body.interaction : undefined,
        scheduledAt: typeof body.scheduledAt === 'string' ? body.scheduledAt
          : typeof body.scheduled_at === 'string' ? body.scheduled_at : undefined,
        recurrence: body.recurrence != null ? body.recurrence : undefined,
      }, {
        inputs: Array.isArray(body.inputs) ? body.inputs : undefined,
      });
      res.status(201).json(boundTaskArtifacts(task));
    } catch (e: any) {
      res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
    }
  });

  router.post('/workspaces/:id/tasks/:taskId', (req, res) => {
    try {
      const task = workspaces.attachTaskToWorkspace(req.params.id, req.params.taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(boundTaskArtifacts(task));
    } catch (e: any) {
      res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
    }
  });

  router.delete('/workspaces/:id/tasks/:taskId', (req, res) => {
    const task = workspaces.detachTaskFromWorkspace(req.params.id, req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(boundTaskArtifacts(task));
  });

  router.get('/workspaces/:id/sessions', (req, res) => {
    const ws = workspaces.getWorkspace(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    res.json({ workspaceId: ws.id, sessions: workspaces.listSessions(ws.id, { includeArchived }) });
  });

  router.post('/workspaces/:id/sessions', (req, res) => {
    try {
      const out = workspaces.createSession(req.params.id, req.body || {});
      res.status(201).json(out);
    } catch (e: any) {
      res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
    }
  });

  router.get('/sessions', (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
      ? req.query.workspaceId.trim() : undefined;
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    res.json({ sessions: workspaces.listSessions(workspaceId, { includeArchived }) });
  });

  router.get('/sessions/:sessionId', (req, res) => {
    const session = workspaces.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const workspace = workspaces.getWorkspace(session.workspaceId);
    res.json({ ...session, workspace });
  });

  router.patch('/sessions/:sessionId', (req, res) => {
    try {
      const session = workspaces.updateSession(req.params.sessionId, req.body || {});
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/sessions/:sessionId', (req, res) => {
    const ok = workspaces.deleteSession(req.params.sessionId);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  });

  const sendMessageHandler = (req: any, res: any) => {
    try {
      const out = workspaces.sendMessage(req.params.sessionId, req.body || {});
      res.status(201).json({
        session: out.session,
        turn: out.turn,
        task: boundTaskArtifacts(out.task),
      });
    } catch (e: any) {
      res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
    }
  };
  router.post('/sessions/:sessionId/messages', sendMessageHandler);
  router.post('/sessions/:sessionId/turns', sendMessageHandler);

  router.post('/sessions/:sessionId/pause', (req, res) => {
    const out = workspaces.pauseSession(req.params.sessionId);
    if (!out) return res.status(404).json({ error: 'Session not found' });
    res.json(out);
  });

  router.post('/sessions/:sessionId/resume', (req, res) => {
    try {
      const out = workspaces.resumeSession(req.params.sessionId, req.body || {});
      if (!out) return res.status(404).json({ error: 'Session not found' });
      res.json(out);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/sessions/:sessionId/fork', (req, res) => {
    try {
      const forked = workspaces.forkSession(req.params.sessionId, req.body || {});
      if (!forked) return res.status(404).json({ error: 'Session not found' });
      res.status(201).json(forked);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
