#!/usr/bin/env node
// v1234-ws-probe.mjs — does the WS path emit tool_stream events?
// Boots the world (bridge + stub + engine), drives ONE turn over the
// WS exactly as the PWA does, and dumps every event type seen.
'use strict';
import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = '/home/z/doomalay';
const ENGINE_BIN = '/tmp/doomalay-v1234-probe-engine';
const DATA_DIR = '/tmp/v1234-probe-data';
const ENGINE_LOG = '/tmp/v1234-probe-engine.log';
const ENGINE_PORT = 8661, STUB_PORT = 8662, BRIDGE_PORT = 8663;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');
const FAKE_HOME = '/tmp/v1234-probe-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_SHARED = '/storage/emulated/0';
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'probe-tv';
const SLOW_CMD = "bash -c 'for i in $(seq 1 6); do echo \"probe step $i\"; sleep 0.7; done'";
const intoFake = (s) => s.split('/data/data/com.termux/files/home').join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join('/data/data/com.termux/files/home');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.text();
}

function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, {}); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) { send(200, { installed: true, version_code: 1022, version_name: 'x', permission: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/probe')) { send(200, { ok: true, storage_ok: true, props_ok: true, stdout: 'x', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false }); return; }
    if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        const cmd = intoFake(String(b.command || ''));
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const p = spawn('bash', ['-c', cmd], { env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' }, cwd: fs.existsSync(workdir) ? workdir : undefined });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        p.on('close', (code) => {
          send(200, { ok: true, stdout: intoTermux(out).slice(0, 102400), stderr: intoTermux(errOut).slice(0, 20480), stdout_original_length: intoTermux(out).length, stderr_original_length: intoTermux(errOut).length, exit_code: code === null ? -1 : code, err: 0, errmsg: null, timeout: false });
        });
      });
      return;
    }
    send(404, {});
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = ''; for await (const c of req) body += c;
      let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
      const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (!hasToolResult) {
        sse(res, { choices: [{ delta: { content: 'Running.' } }] });
        await sleep(100);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: { command: SLOW_CMD, timeout_ms: 60000 } }) } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const w of ['Done', 'ok']) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  srv.listen(STUB_PORT, '127.0.0.1');
  return srv;
}

// ── boot ──
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/proj', { recursive: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge(); startStub();
{
  const env = { ...process.env, DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN, DOOMALAY_BASE_URL_GROQ: STUB, DOOMALAY_OTA_DISABLE: '1' };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
for (let i = 0; i < 150; i++) { try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {} await sleep(200); }
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'k' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'probe', model: 'groq/stub-model', provider: 'groq' });
await jpost(ENGINE + '/api/workspaces/device', { name: 'p', termux_path: TERMUX_SHARED + '/Doomalay/proj', session_id: SID });

// ── the WS turn ──
const seen = [];
const ws = new WebSocket('ws://127.0.0.1:' + ENGINE_PORT + '/api/chat?session_id=' + SID);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (ev) => {
  try {
    const d = JSON.parse(ev.data);
    seen.push(d);
    if (d.type === 'tool_stream') console.log('TOOL_STREAM delta=' + JSON.stringify(String(d.delta || '').slice(0, 60)));
    else if (d.type === 'tool_use' || d.type === 'tool_result') console.log(d.type.toUpperCase() + ' ' + String(d.name || '').slice(0, 30));
    else if (d.type === 'status') console.log('STATUS ' + (d.state || ''));
  } catch (e) {}
};
ws.send(JSON.stringify({ type: 'send', message: 'run it', session_id: SID, model: 'groq/stub-model', provider: 'groq' }));
const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  const last = seen[seen.length - 1];
  if (last && last.type === 'status' && (last.state === 'idle' || last.state === 'error')) break;
  await sleep(200);
}
const types = {};
for (const s of seen) types[s.type] = (types[s.type] || 0) + 1;
console.log('\nEVENT TYPES: ' + JSON.stringify(types));
console.log('tool_stream count: ' + (types.tool_stream || 0));
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
process.exit(0);
