// pmproxy.mjs — THE PRIVATEMODE SIDECAR (v0.91.8).
//
// WHY THIS EXISTS: PM's chat API requires their E2E-encryption protocol
// (remote attestation + AES-GCM), implemented in the official SDK. The
// brain's agent turns run through litellm (Python) — which CANNOT speak
// the protocol — so PM-on-the-space has been dead since the original brain
// port (the catalog's localhost:8080 pointed at PM's local Docker proxy,
// impossible inside an HF Space). The app's WebView solves this with the
// vendored JS SDK (vendor/pm on the engine side); THIS is the same move
// for the brain: a tiny Node HTTP shim (the space ships Node 20) that
// exposes the PLAIN OpenAI-compatible API locally and does the encrypted
// calls through the same vendored SDK.
//
// Contract (loopback only, default 127.0.0.1:8530 — DOOMALAY_PM_PROXY_PORT):
//   GET  /healthz            → {ok, cores, uptimeMs}
//   GET  /v1/models          → passthrough of api.privatemode.ai/v1/models
//                              (the listing is NOT encrypted — Bearer rides)
//   POST /v1/chat/completions→ encrypted via the SDK; body passes through
//                              as-is (tools, reasoning_effort,
//                              chat_template_kwargs ride — the brain's
//                              effort table already builds them); stream
//                              and non-stream shapes supported.
//
// Multi-user BYOK: every request carries the user's key (Authorization:
// Bearer — litellm forwards api_key). One PrivatemodeCore per key (its own
// verify + secret), capped and LRU-evicted (each core owns a wasm client —
// memory is real).
// THE POLYFILL MUST BE THE FIRST IMPORT (ESM evaluates imports before the
// importing module's body — an inline polyfill runs too late; the SDK's
// wasm_exec.js throws at module scope on Node 18, live-found on the space).
import './pm-polyfill.mjs';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivatemodeCore } from './vendor/pm/privatemode-ai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DOOMALAY_PM_PROXY_PORT || '8530', 10);
const MAX_CORES = 4;
const PM_API = 'https://api.privatemode.ai';
const started = Date.now();

// ── the wasm: decompress ONCE at boot (the SDK reads a path in Node) ──────
let wasmPath;
try {
  const gz = readFileSync(join(HERE, 'vendor', 'pm', 'privatemode.wasm.gz'));
  const raw = gunzipSync(gz);
  const dir = mkdtempSync(join(tmpdir(), 'pmproxy-wasm-'));
  wasmPath = join(dir, 'privatemode.wasm');
  writeFileSync(wasmPath, raw);
} catch (e) {
  console.error('[pmproxy] wasm decompress failed:', e.message);
  process.exit(1);
}
console.log(`[pmproxy] node ${process.version} — wasm staged at ${wasmPath}`);

// ── per-key core cache (LRU, capped) ──────────────────────────────────────
const cores = new Map(); // key → {core, ready: Promise, last}
const corePromises = new Map(); // key → Promise (creation dedupe)

function friendly(raw) {
  const msg = String(raw && raw.message || raw || '');
  const m = msg.match(/"message"\s*:\s*"([^"]+)"/);
  if (m && /invalid|unauthorized|auth/i.test(m[1] + msg)) {
    return 'PrivateMode rejected the key — ' + m[1];
  }
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

async function getCore(apiKey) {
  const hit = cores.get(apiKey);
  if (hit) {
    hit.last = Date.now();
    return hit.ready;
  }
  let p = corePromises.get(apiKey);
  if (!p) {
    p = (async () => {
      const core = new PrivatemodeCore({ apiKey, wasmURL: wasmPath });
      // the pmsdk bridge's handshake discipline: verify() THEN
      // refreshSecret(), 3× with backoff (PM's attest is intermittently
      // slow — observed live 1-in-3 fresh boots).
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await core.verify();
          await core.refreshSecret();
          return core;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      try { core.close(); } catch (_) { /* already dead */ }
      throw new Error(friendly(lastErr));
    })();
    corePromises.set(apiKey, p);
  }
  try {
    const core = await p;
    cores.set(apiKey, { core, ready: p, last: Date.now() });
    // LRU eviction
    while (cores.size > MAX_CORES) {
      let oldest = null;
      for (const [k, v] of cores) if (!oldest || v.last < cores.get(oldest).last) oldest = k;
      const ev = cores.get(oldest);
      cores.delete(oldest);
      try { ev.core.close(); } catch (_) { /* fine */ }
    }
    return core;
  } finally {
    corePromises.delete(apiKey);
  }
}

// ── the server ─────────────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function jsonError(res, status, message) {
  const body = JSON.stringify({ error: { message, type: 'pmproxy' } });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 32 << 20) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cores: cores.size, uptimeMs: Date.now() - started }));
      return;
    }
    if (url === '/v1/models' && req.method === 'GET') {
      const key = bearer(req);
      if (!key) return jsonError(res, 401, 'missing Authorization: Bearer <PM key>');
      // the listing is plain (unencrypted) — proxy the real API
      const up = await fetch(PM_API + '/v1/models', { headers: { Authorization: 'Bearer ' + key } });
      const body = await up.text();
      res.writeHead(up.status, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      const key = bearer(req);
      if (!key) return jsonError(res, 401, 'missing Authorization: Bearer <PM key>');
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      } catch (e) {
        return jsonError(res, 400, 'invalid JSON body: ' + e.message);
      }
      let core;
      try {
        core = await getCore(key);
      } catch (e) {
        return jsonError(res, 401, friendly(e));
      }
      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        try {
          for await (const chunk of core.streamChatCompletions(body)) {
            res.write('data: ' + JSON.stringify(chunk) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) {
          // mid-stream failure: the SSE convention — an error event then done
          res.write('data: ' + JSON.stringify({ error: { message: friendly(e), type: 'pmproxy' } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
      try {
        const r = await core.chatCompletions(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body));
      } catch (e) {
        return jsonError(res, 502, friendly(e));
      }
      return;
    }
    jsonError(res, 404, 'not found: ' + url);
  } catch (e) {
    try { jsonError(res, 500, 'pmproxy: ' + (e && e.message)); } catch (_) { /* sockets die */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pmproxy] up on 127.0.0.1:${PORT} (wasm ready, max ${MAX_CORES} cores)`);
});

const shutdown = () => {
  for (const { core } of cores.values()) {
    try { core.close(); } catch (_) { /* fine */ }
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
