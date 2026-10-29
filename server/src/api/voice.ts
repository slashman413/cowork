import { Router } from 'express';
import type { VoiceAssistant } from '../core/voice-assistant.js';

/**
 * REST surface for the Chat page's voice assistant (core/voice-assistant.ts).
 * Speech-to-text / text-to-speech happen in the browser; the server owns the
 * session state, brain selection, and plan → Goal execution.
 *
 *   GET    /voice/brains                  brains that can take a turn now (+ cooling ones)
 *   GET    /voice/sessions                session summaries (newest first)
 *   POST   /voice/sessions                start a session            { title? }
 *   GET    /voice/sessions/:id            session (+ finished turn / goal progress folded in)
 *   POST   /voice/sessions/:id/turn       say something              { text }
 *   POST   /voice/sessions/:id/execute    approve the plan → active Goal
 *   DELETE /voice/sessions/:id            delete (cancels an in-flight turn)
 */
export function createVoiceRouter(voice: VoiceAssistant): Router {
  const router = Router();
  const fail = (res: any, e: any) => res.status(e?.status || (/not found/.test(e?.message) ? 404 : 400)).json({ error: e?.message || String(e) });

  router.get('/voice/brains', (_req, res) => {
    const r = voice.availableBrains();
    res.json({ ...r, chosen: r.available[0]?.id || null });
  });
  router.get('/voice/sessions', (_req, res) => res.json(voice.list()));
  router.post('/voice/sessions', (req, res) => {
    try { res.status(201).json(voice.create(req.body?.title)); } catch (e) { fail(res, e); }
  });
  router.get('/voice/sessions/:id', (req, res) => {
    try {
      const s = voice.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'session not found' });
      res.json(s);
    } catch (e) { fail(res, e); }
  });
  router.post('/voice/sessions/:id/turn', (req, res) => {
    try { res.json(voice.turn(req.params.id, String(req.body?.text ?? ''))); } catch (e) { fail(res, e); }
  });
  router.post('/voice/sessions/:id/execute', (req, res) => {
    try { res.json(voice.execute(req.params.id)); } catch (e) { fail(res, e); }
  });
  router.delete('/voice/sessions/:id', (req, res) => {
    try { voice.delete(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  return router;
}
