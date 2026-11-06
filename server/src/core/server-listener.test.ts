import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import tlsModule from 'tls';
import { execFileSync } from 'child_process';
import express from 'express';
import { extractCertDomains, getPrimaryTrustedDomain, createMultiplexedServer } from './server-listener.js';
import { ServerConfig } from '../types.js';

test('server-listener: extractCertDomains and getPrimaryTrustedDomain', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cert-test-'));
  try {
    const certPath = path.join(tmpDir, 'test-cert.pem');
    const keyPath = path.join(tmpDir, 'test-key.pem');

    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-subj', '/CN=my-test.example.ts.net',
      '-addext', 'subjectAltName=DNS:my-test.example.ts.net,DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'pipe' });

    const certBuf = fs.readFileSync(certPath);
    const domains = extractCertDomains(certBuf);
    assert.ok(domains.includes('my-test.example.ts.net'));
    assert.ok(domains.includes('localhost'));

    const primary = getPrimaryTrustedDomain(certBuf);
    assert.equal(primary, 'my-test.example.ts.net');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('server-listener: plain HTTP mode when tls is null', async () => {
  const app = express();
  app.get('/test', (_req, res) => res.json({ ok: true }));

  const config: ServerConfig = {
    port: 6891,
    host: '127.0.0.1',
    name: 'test',
    version: '1.0.0',
    tls: null
  };

  const { server, scheme, trustedDomain } = createMultiplexedServer(app, config);
  assert.equal(scheme, 'http');
  assert.equal(trustedDomain, null);

  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get('http://127.0.0.1:6891/test', (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve({ status: r.statusCode || 0, body }));
      }).on('error', reject);
    });

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('server-listener: multiplexed HTTP and HTTPS on same port', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-multi-test-'));
  const certPath = path.join(tmpDir, 'cert.pem');
  const keyPath = path.join(tmpDir, 'key.pem');

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-subj', '/CN=test-box.tailnet.ts.net',
      '-addext', 'subjectAltName=DNS:test-box.tailnet.ts.net'
    ], { stdio: 'pipe' });

    const app = express();
    app.get('/api/ping', (_req, res) => res.json({ pong: true }));

    const config: ServerConfig = {
      port: 6892,
      host: '127.0.0.1',
      name: 'test',
      version: '1.0.0',
      tls: { certFile: certPath, keyFile: keyPath }
    };

    const { server, scheme, trustedDomain } = createMultiplexedServer(app, config);
    assert.equal(scheme, 'https');
    assert.equal(trustedDomain, 'test-box.tailnet.ts.net');

    try {
      // 1. Plain HTTP request to localhost: should be served directly by app (secure context in Chrome)
      const httpRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get('http://127.0.0.1:6892/api/ping', { headers: { host: 'localhost:6892', connection: 'close' } }, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => resolve({ status: r.statusCode || 0, body }));
        }).on('error', reject);
      });
      assert.equal(httpRes.status, 200);
      assert.deepEqual(JSON.parse(httpRes.body), { pong: true });

      // 2. Plain HTTP request with external host/IP: should redirect to trusted HTTPS domain
      const redirectRes = await new Promise<{ status: number; location: string }>((resolve, reject) => {
        http.get('http://127.0.0.1:6892/api/ping', { headers: { host: '100.64.0.1:6892', connection: 'close' } }, (r) => {
          resolve({ status: r.statusCode || 0, location: r.headers.location || '' });
        }).on('error', reject);
      });
      assert.equal(redirectRes.status, 302);
      assert.equal(redirectRes.location, 'https://test-box.tailnet.ts.net:6892/api/ping');

      // 3. HTTPS request with TLS handshake: should terminate TLS and serve app
      const httpsRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request({
          host: '127.0.0.1',
          port: 6892,
          path: '/api/ping',
          method: 'GET',
          servername: 'test-box.tailnet.ts.net',
          ca: fs.readFileSync(certPath),
          headers: { host: 'test-box.tailnet.ts.net:6892', connection: 'close' }
        }, (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => resolve({ status: r.statusCode || 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(httpsRes.status, 200);
      assert.deepEqual(JSON.parse(httpsRes.body), { pong: true });

      // 4. HTTPS request with SNI localhost: should serve localhost context
      const localhostCertPath = path.join(tmpDir, 'localhost.pem');
      const localhostKeyPath = path.join(tmpDir, 'localhost-key.pem');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', localhostKeyPath,
        '-out', localhostCertPath,
        '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
      ], { stdio: 'pipe' });

      // Restart server with localhost fallback present
      await new Promise(r => server.close(r));
      const s2 = createMultiplexedServer(app, config);
      try {
        const localHttpsRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = https.request({
            host: '127.0.0.1',
            port: 6892,
            path: '/api/ping',
            method: 'GET',
            servername: 'localhost',
            ca: fs.readFileSync(localhostCertPath),
            headers: { host: 'localhost:6892', connection: 'close' }
          }, (r) => {
            let body = '';
            r.on('data', c => body += c);
            r.on('end', () => resolve({ status: r.statusCode || 0, body }));
          });
          req.on('error', reject);
          req.end();
        });
        assert.equal(localHttpsRes.status, 200);
        assert.deepEqual(JSON.parse(localHttpsRes.body), { pong: true });
      } finally {
        await new Promise(r => s2.server.close(r));
      }
    } finally {
      // server already closed in test flow above
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createMultiplexedServer: SNI routes between ECDSA primary and localhost certs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-ecdsa-test-'));
  const genEcCert = (name: string, cn: string) => execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', path.join(tmpDir, `${name}-key.pem`),
    '-out', path.join(tmpDir, `${name}.pem`),
    '-days', '1',
    '-subj', `/CN=${cn}`,
    '-addext', `subjectAltName=DNS:${cn}`
  ], { stdio: 'pipe' });
  genEcCert('cert', 'primary.test');
  genEcCert('localhost', 'localhost');

  const { server } = createMultiplexedServer(express(), {
    port: 6893,
    host: '127.0.0.1',
    tls: { certFile: path.join(tmpDir, 'cert.pem'), keyFile: path.join(tmpDir, 'cert-key.pem') }
  });
  const servedCn = (servername: string) => new Promise<string>((resolve, reject) => {
    const socket = tlsModule.connect({ host: '127.0.0.1', port: 6893, servername, rejectUnauthorized: false }, () => {
      const cn = socket.getPeerCertificate().subject.CN;
      socket.destroy();
      resolve(String(cn));
    });
    socket.on('error', reject);
  });
  try {
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await servedCn('localhost'), 'localhost');
    assert.equal(await servedCn('primary.test'), 'primary.test');
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
