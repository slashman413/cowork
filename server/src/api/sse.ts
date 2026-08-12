import type { Request, Response } from 'express';
import type { EventBus } from '../core/events.js';

export function createSSEHandler(eventBus: EventBus) {
  return (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Defense-in-depth: if the dashboard is ever fronted by nginx (or any proxy
    // that buffers responses), buffering an SSE stream makes the browser sit on
    // "Connecting…" until the buffer fills — which lines up with a stalled 30s ping.
    // This header disables that buffering; it is harmless when served directly.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventBus.on('*', onEvent);

    // Tell the browser's native EventSource reconnect to retry fast (3s) after a
    // dropped stream, instead of leaning on its longer implementation default.
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    const keepalive = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      eventBus.off('*', onEvent);
    });
  };
}
