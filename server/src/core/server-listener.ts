import net from 'net';
import http from 'http';
import https from 'https';
import tlsModule from 'tls';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { Config } from '../types.js';

export interface ServerListenerOptions {
  port: number;
  host: string;
  tls?: { certFile: string; keyFile: string } | null;
}

export type ServerConfigInput = Config | { server: ServerListenerOptions } | ServerListenerOptions;

export interface MultiplexedServerResult {
  server: net.Server | http.Server | https.Server;
  scheme: 'http' | 'https';
  trustedDomain: string | null;
  trustedDomains: string[];
}

/**
 * Extract DNS names and IP addresses from certificate SANs (or Subject CN).
 */
export function extractCertDomains(certBuf: Buffer | string): string[] {
  const domains: string[] = [];
  try {
    const x509 = new crypto.X509Certificate(certBuf);
    if (x509.subjectAltName) {
      const parts = x509.subjectAltName.split(',').map(s => s.trim());
      for (const p of parts) {
        if (p.startsWith('DNS:')) {
          domains.push(p.slice(4).toLowerCase());
        }
      }
    }
    if (!domains.length && x509.subject) {
      const m = x509.subject.match(/CN=([^,\n]+)/);
      if (m) domains.push(m[1].trim().toLowerCase());
    }
  } catch (err) {
    console.warn('extractCertDomains: failed to parse certificate:', err);
  }
  return [...new Set(domains)];
}

/**
 * Return the primary trusted FQDN (excluding localhost and loopback).
 */
export function getPrimaryTrustedDomain(certBuf: Buffer | string): string | null {
  const domains = extractCertDomains(certBuf);
  return domains.find(d => d !== 'localhost' && d !== '127.0.0.1' && d !== '::1') || null;
}

/**
 * Create a server that supports dual HTTP and HTTPS multiplexing on a single port.
 *
 * When TLS is configured:
 *  - Incoming TLS connections (first byte 0x16) are handed to HTTPS.
 *    SNI routes requests to the signed certificate (e.g. Tailscale Let's Encrypt)
 *    or fallback localhost certificate.
 *  - Incoming plain HTTP connections:
 *    - On localhost / 127.0.0.1: handled directly by `app`. In Chrome/browsers,
 *      `http://localhost` is a W3C-standard secure context (all APIs work with
 *      zero certificate warnings).
 *    - On external domains / IPs: redirected to `https://${trustedDomain}:${port}${url}`.
 */
export function createMultiplexedServer(
  app: express.Express,
  config: ServerConfigInput,
  onListen?: () => void
): MultiplexedServerResult {
  const serverCfg: ServerListenerOptions = 'server' in config
    ? (config as { server: ServerListenerOptions }).server
    : config as ServerListenerOptions;
  const tls = serverCfg.tls;
  const hasTls = !!(tls && fs.existsSync(tls.certFile) && fs.existsSync(tls.keyFile));

  if (!hasTls) {
    if (tls) {
      console.warn(
        `server.tls is set but the cert/key were not found ` +
        `(${tls.certFile}, ${tls.keyFile}); falling back to http://.`
      );
    }
    const server = http.createServer(app).listen(serverCfg.port, serverCfg.host, onListen);
    return {
      server,
      scheme: 'http',
      trustedDomain: null,
      trustedDomains: []
    };
  }

  // Load primary certificate (e.g. Let's Encrypt from Tailscale)
  const primaryCert = fs.readFileSync(tls!.certFile);
  const primaryKey = fs.readFileSync(tls!.keyFile);
  const trustedDomains = extractCertDomains(primaryCert);
  const primaryTrustedDomain = getPrimaryTrustedDomain(primaryCert);

  const primaryCtx = tlsModule.createSecureContext({
    cert: primaryCert,
    key: primaryKey
  });

  // Load or detect fallback certificate for localhost / 127.0.0.1
  let localhostCtx: tlsModule.SecureContext | null = null;
  const certDir = path.dirname(tls!.certFile);
  const localhostCertPath = path.join(certDir, 'localhost.pem');
  const localhostKeyPath = path.join(certDir, 'localhost-key.pem');
  const backupCertPath = path.join(certDir, 'cert.pem.bak-selfsigned');
  const backupKeyPath = path.join(certDir, 'key.pem.bak-selfsigned');

  if (fs.existsSync(localhostCertPath) && fs.existsSync(localhostKeyPath)) {
    try {
      localhostCtx = tlsModule.createSecureContext({
        cert: fs.readFileSync(localhostCertPath),
        key: fs.readFileSync(localhostKeyPath)
      });
    } catch {}
  } else if (fs.existsSync(backupCertPath) && fs.existsSync(backupKeyPath)) {
    try {
      localhostCtx = tlsModule.createSecureContext({
        cert: fs.readFileSync(backupCertPath),
        key: fs.readFileSync(backupKeyPath)
      });
    } catch {}
  } else if (trustedDomains.includes('localhost')) {
    localhostCtx = primaryCtx;
  }

  // HTTPS Server with SNICallback
  const httpsServer = https.createServer(
    {
      cert: primaryCert,
      key: primaryKey,
      SNICallback: (servername, cb) => {
        const name = (servername || '').toLowerCase();
        if ((name === 'localhost' || name === '127.0.0.1' || !name) && localhostCtx) {
          return cb(null, localhostCtx);
        }
        return cb(null, primaryCtx);
      }
    },
    app
  );

  // Plain HTTP Server (handles localhost natively & redirects remote HTTP -> HTTPS)
  const httpApp = express();
  httpApp.use((req, res) => {
    const rawHost = req.headers.host || '';
    const hostname = rawHost.split(':')[0].toLowerCase();

    // Loopback / localhost: serve app directly!
    // Browsers natively consider http://localhost a secure context (microphone, clipboard, STT all work).
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '') {
      return app(req, res);
    }

    // External host / IP: redirect to trusted HTTPS domain if available
    const targetDomain = primaryTrustedDomain || hostname;
    const targetPort = serverCfg.port === 443 ? '' : `:${serverCfg.port}`;
    const redirectUrl = `https://${targetDomain}${targetPort}${req.url}`;
    res.redirect(302, redirectUrl);
  });
  const httpServer = http.createServer(httpApp);

  // Master net.Server multiplexing TLS (0x16) vs plain HTTP
  const masterServer = net.createServer((socket) => {
    socket.once('data', (buf) => {
      socket.pause();
      socket.unshift(buf);
      if (buf[0] === 22) { // 0x16: TLS record Handshake
        httpsServer.emit('connection', socket);
      } else {
        httpServer.emit('connection', socket);
      }
      process.nextTick(() => {
        if (!socket.destroyed) socket.resume();
      });
    });

    socket.on('error', (err: any) => {
      // Ignore common client aborts / RSTs
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.warn('Socket error in multiplexed listener:', err.message);
      }
    });
  });

  // Forward close event to child servers and close active connections
  masterServer.on('close', () => {
    try { (masterServer as any).closeAllConnections?.(); } catch {}
    try { (httpsServer as any).closeAllConnections?.(); } catch {}
    try { (httpServer as any).closeAllConnections?.(); } catch {}
    try { httpsServer.close(); } catch {}
    try { httpServer.close(); } catch {}
  });

  masterServer.listen(serverCfg.port, serverCfg.host, onListen);

  return {
    server: masterServer,
    scheme: 'https',
    trustedDomain: primaryTrustedDomain,
    trustedDomains
  };
}
