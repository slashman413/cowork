import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createCompression } from './compression.js';

const big = { tasks: Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}`, artifacts: ['outputs/report.md', 'progress.md'] })) };

function app() {
  const a = express();
  a.use(createCompression());
  a.get('/api/inbox', (_req, res) => { res.json(big); });
  a.get('/api/tiny', (_req, res) => { res.json({ ok: true }); });
  a.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: {"type":"connected"}\n\n');
  });
  a.post('/mcp', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`data: ${'x'.repeat(4000)}\n\n`);
  });
  return a.listen(0);
}

function get(server: http.Server, path: string, method = 'GET', encoding = 'gzip'): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer; firstChunkMs: number }> {
  const { port } = server.address() as AddressInfo;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method, headers: { 'Accept-Encoding': encoding } }, (res) => {
      const chunks: Buffer[] = [];
      let firstChunkMs = -1;
      res.on('data', (c: Buffer) => {
        if (firstChunkMs < 0) firstChunkMs = Date.now() - t0;
        chunks.push(c);
        // Streams never end on their own — stop once the first frame arrived.
        if (String(res.headers['content-type']).startsWith('text/event-stream')) { req.destroy(); resolve({ headers: res.headers, body: Buffer.concat(chunks), firstChunkMs }); }
      });
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks), firstChunkMs }));
    });
    req.on('error', (e) => { if ((e as any).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

test('JSON over the threshold is gzipped and round-trips', async () => {
  const server = app();
  try {
    const r = await get(server, '/api/inbox');
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.match(String(r.headers.vary), /Accept-Encoding/i);
    const json = JSON.parse(zlib.gunzipSync(r.body).toString('utf8'));
    assert.deepEqual(json, big);
    assert.ok(r.body.length < JSON.stringify(big).length / 4, `gzip should shrink repetitive JSON (got ${r.body.length} B)`);
  } finally { server.close(); }
});

test('HEAD advertises gzip for a compressible body', async () => {
  const server = app();
  try {
    const r = await get(server, '/api/inbox', 'HEAD');
    assert.equal(r.headers['content-encoding'], 'gzip');
  } finally { server.close(); }
});

test('browsers offering br get brotli; HEAD carries no body', async () => {
  const server = app();
  try {
    const r = await get(server, '/api/inbox', 'GET', 'gzip, deflate, br');
    assert.equal(r.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(r.body).toString('utf8')), big);
    const h = await get(server, '/api/inbox', 'HEAD');
    assert.equal(h.body.length, 0);
  } finally { server.close(); }
});

test('small bodies are sent uncompressed', async () => {
  const server = app();
  try {
    const r = await get(server, '/api/tiny');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(r.body.toString('utf8')), { ok: true });
  } finally { server.close(); }
});

test('SSE and MCP streams stay uncompressed and unbuffered', async () => {
  const server = app();
  try {
    for (const [path, method] of [['/api/events', 'GET'], ['/mcp', 'POST']] as const) {
      const r = await get(server, path, method);
      assert.equal(r.headers['content-encoding'], undefined, path);
      assert.match(r.body.toString('utf8'), /^data: /, path);
    }
  } finally { server.close(); }
});
