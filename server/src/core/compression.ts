import compression from 'compression';
import type { Request, Response, RequestHandler } from 'express';

/**
 * HTTP compression for JSON + static assets: Content-Encoding gzip (or br when
 * the browser offers it) per Accept-Encoding. The Tasks page pulls /api/inbox
 * (~400 KB JSON) and app.js + lucide.js (~850 KB JS); they shrink 3–5x, which
 * matters on a phone over Tailscale far more than the few ms of CPU it costs.
 * Numbers and trade-offs: docs/tasks-page-performance.md.
 *
 * Never compresses streams that must reach the client byte-by-byte: zlib holds
 * output until its window fills, so a gzipped SSE stream would sit on "Connecting…"
 * and the MCP streamable-HTTP transport (also text/event-stream) would stall.
 * Bodies under `threshold` bytes are sent as-is (gzip framing ≈ 20 B, no win).
 */
export function isStreamingRequest(req: Request, res: Response): boolean {
  const p = req.path || req.url || '';
  if (p === '/api/events' || p.startsWith('/mcp')) return true;
  const type = String(res.getHeader('Content-Type') || '');
  return type.startsWith('text/event-stream');
}

export function createCompression(threshold = 1024): RequestHandler {
  // Negotiates br (quality 4) > gzip (level 6) > deflate from Accept-Encoding.
  const negotiate = compression({
    threshold,
    filter: (req, res) => !isStreamingRequest(req as Request, res as Response)
      && compression.filter(req, res)
  }) as RequestHandler;
  return (req, res, next) => {
    // `compression` skips HEAD outright, so `curl -I` would claim no encoding even
    // though the GET is compressed. Run HEAD as the GET it mirrors instead — Node
    // already drops the body for a HEAD request (decided when the response was
    // created), so only the headers go out, now matching the GET's.
    if (req.method === 'HEAD' && req.headers['accept-encoding']) req.method = 'GET';
    negotiate(req, res, next);
  };
}
