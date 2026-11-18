import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeServices } from './service-probe.js';

async function withServer(status: number, fn: (url: string) => Promise<void>) {
  const srv = http.createServer((_q, r) => { r.writeHead(status); r.end('x'); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`); }
  finally { srv.close(); }
}

test('any non-gateway HTTP answer counts as online', async () => {
  for (const code of [200, 302, 401, 404, 500]) {
    await withServer(code, async (url) => {
      const r = await probeServices({ s: { url } as any });
      assert.equal(r.s.online, true, `status ${code}`);
      assert.equal(r.s.code, code);
    });
  }
});

test('gateway errors (proxy up, backend down) count as offline', async () => {
  for (const code of [502, 503, 504]) {
    await withServer(code, async (url) => {
      const r = await probeServices({ s: { url } as any });
      assert.equal(r.s.online, false, `status ${code}`);
      assert.equal(r.s.code, code);
      assert.equal(r.s.reason, `upstream ${code}`);
    });
  }
});

test('connection refused is offline', async () => {
  const r = await probeServices({ s: { url: 'http://127.0.0.1:1/' } as any });
  assert.equal(r.s.online, false);
  assert.equal(r.s.code, null);
});
