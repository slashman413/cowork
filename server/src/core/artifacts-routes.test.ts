import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'http';

function makeApp(artifactsRoot: string) {
  const app = express();

  function listFilesRecursive(dir: string, base = ''): string[] {
    let results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
        } else if (entry.isFile()) {
          results.push(rel);
        }
      }
    } catch {}
    return results.sort();
  }

  app.get('/api/artifacts/:taskId', (req, res) => {
    const dir = path.join(artifactsRoot, path.basename(req.params.taskId));
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(listFilesRecursive(dir));
  });

  app.get('/api/artifacts/:taskId/*file', (req, res) => {
    const taskId = path.basename(req.params.taskId);
    const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
    const taskDir = path.resolve(artifactsRoot, taskId);
    const file = path.resolve(taskDir, rawFile);

    if (!file.startsWith(taskDir + path.sep)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    if (rawFile === 'result.md' && !fs.existsSync(file)) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="result.md"');
      return res.send('# synthetic result\n');
    }

    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });

    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return res.status(404).json({ error: 'not found' });
    }
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

    if (req.query.inline === '1') return res.sendFile(file);
    res.download(file, path.basename(file), (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'download failed' });
      }
    });
  });

  app.post('/api/artifacts/:taskId/*file', express.raw({ type: '*/*', limit: '256mb' }), (req, res) => {
    try {
      const taskId = path.basename(req.params.taskId);
      const rawFile = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
      if (!rawFile || rawFile === '.' || rawFile === '..') throw new Error('invalid filename');
      const taskDir = path.resolve(artifactsRoot, taskId);
      const dest = path.resolve(taskDir, rawFile);
      if (!dest.startsWith(taskDir + path.sep)) throw new Error('path escape');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!body.length) throw new Error('empty body');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      res.json({ ok: true, taskId, file: rawFile, bytes: body.length });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  return app;
}

function reqGet(server: http.Server, urlPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as any).port;
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function reqPost(server: http.Server, urlPath: string, payload: Buffer | string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as any).port;
    const bodyBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bodyBuf.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

test('artifacts routes: recursive listing and nested downloads work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-artifacts-test-'));
  const taskId = 'task-nested-123';
  const taskDir = path.join(root, taskId);
  fs.mkdirSync(path.join(taskDir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'root.txt'), 'hello root');
  fs.writeFileSync(path.join(taskDir, 'sub', 'nested.json'), '{"nested":true}');
  fs.writeFileSync(path.join(taskDir, 'sub', 'deep', 'deep.md'), '# deep content');
  fs.mkdirSync(path.join(taskDir, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, '__pycache__', 'skip.pyc'), 'junk');

  const app = makeApp(root);
  const server = app.listen(0);

  try {
    // 1. Recursive list
    const listRes = await reqGet(server, `/api/artifacts/${taskId}`);
    assert.equal(listRes.status, 200);
    const list = JSON.parse(listRes.body);
    assert.deepEqual(list, ['root.txt', 'sub/deep/deep.md', 'sub/nested.json']);

    // 2. Download root file
    const rootRes = await reqGet(server, `/api/artifacts/${taskId}/root.txt`);
    assert.equal(rootRes.status, 200);
    assert.equal(rootRes.body, 'hello root');

    // 3. Download nested file with unencoded slash
    const nestedRes = await reqGet(server, `/api/artifacts/${taskId}/sub/nested.json`);
    assert.equal(nestedRes.status, 200);
    assert.equal(nestedRes.body, '{"nested":true}');

    // 4. Download nested file with URL-encoded slash
    const encRes = await reqGet(server, `/api/artifacts/${taskId}/sub%2Fnested.json`);
    assert.equal(encRes.status, 200);
    assert.equal(encRes.body, '{"nested":true}');

    // 5. Deeply nested download
    const deepRes = await reqGet(server, `/api/artifacts/${taskId}/sub/deep/deep.md`);
    assert.equal(deepRes.status, 200);
    assert.equal(deepRes.body, '# deep content');

    // 6. Path traversal attempts are blocked (403 or 404)
    const travRes = await reqGet(server, `/api/artifacts/${taskId}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(travRes.status, 403);

    // 7. Requesting a directory returns 400 not a file (not unhandled EISDIR)
    const dirRes = await reqGet(server, `/api/artifacts/${taskId}/sub`);
    assert.equal(dirRes.status, 400);

    // 8. Missing file returns 404
    const missRes = await reqGet(server, `/api/artifacts/${taskId}/sub/missing.txt`);
    assert.equal(missRes.status, 404);

    // 9. Synthetic result.md fallback
    const synRes = await reqGet(server, `/api/artifacts/${taskId}/result.md`);
    assert.equal(synRes.status, 200);
    assert.ok(synRes.body.includes('# synthetic result'));

    // 10. Remote brain uploading a nested artifact
    const upRes = await reqPost(server, `/api/artifacts/${taskId}/uploads/new-file.csv`, 'a,b,c\n1,2,3');
    assert.equal(upRes.status, 200);
    assert.ok(fs.existsSync(path.join(taskDir, 'uploads', 'new-file.csv')));
    const downUpRes = await reqGet(server, `/api/artifacts/${taskId}/uploads/new-file.csv`);
    assert.equal(downUpRes.status, 200);
    assert.equal(downUpRes.body, 'a,b,c\n1,2,3');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
