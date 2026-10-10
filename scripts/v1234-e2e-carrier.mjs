#!/usr/bin/env node
// v1234-e2e-carrier.mjs — v1.23.4 THE POLISH redteam carrier.
//
// Boots the whole world for the agent-browser real-user walk:
//   · the engine (fresh binary — chatpanel.js + index.html embedded)
//   · the v1233 executing fake bridge (bash for real, roots remapped)
//   · the v1204 OpenAI stub with a SLOW termux tool call (the live
//     stream has room to breathe while the overlay is open)
//   · the armed session (termux stacked via the device bind) + the key
//
// Modes: up (default, stays up) · down
'use strict';

import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const MODE = process.argv[2] || 'up';

const ENGINE_BIN = '/tmp/doomalay-v1234-e2e-engine';
const DATA_DIR = '/tmp/v1234-e2e-data';
const ENGINE_LOG = '/tmp/v1234-e2e-engine.log';

const ENGINE_PORT = 8651;
const STUB_PORT = 8652;
const BRIDGE_PORT = 8653;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1234-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;

const SID = 'e2e-tv-walk';
const MODEL = 'groq/stub-model';
// ~10s of streamed output — the overlay opens mid-flight and breathes.
// bash -c shape: the pill's derived label reads "bash" (a real program,
// not the `for` keyword).
const SLOW_CMD = "bash -c 'for i in $(seq 1 14); do echo \"pkg step $i done\"; sleep 0.7; done'";

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}

// ── the executing fake bridge (the v1233 law) ─────────────────────────
function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false, error: 'bad token' }); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) {
      send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: true });
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/probe')) {
      send(200, { ok: true, storage_ok: true, props_ok: true, stdout: '__doomalay_probe__\nstorage_ok\nprops_ok\n', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false });
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        const cmd = intoFake(String(b.command || ''));
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const timeoutMS = Number(b.timeout_ms) || 60000;
        const p = spawn('bash', ['-c', cmd], {
          env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' },
          cwd: fs.existsSync(workdir) ? workdir : undefined,
        });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMS + 4000);
        p.on('close', (code, signal) => {
          clearTimeout(timer);
          send(200, {
            ok: true,
            stdout: intoTermux(out).slice(0, 102400),
            stderr: intoTermux(errOut).slice(0, 20480),
            stdout_original_length: intoTermux(out).length,
            stderr_original_length: intoTermux(errOut).length,
            exit_code: code === null ? -1 : code,
            err: 0, errmsg: null, timeout: false,
          });
        });
      });
      return;
    }
    send(404, { ok: false, error: 'unknown route' });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the OpenAI stub (the v1204 pattern + the SLOW termux turn) ────────
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
      let body = '';
      for await (const c of req) body += c;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (!hasToolResult) {
        sse(res, { choices: [{ delta: { content: 'Running the install on the device shell.' } }] });
        await sleep(120);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_tv1', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(60);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: { command: SLOW_CMD, timeout_ms: 60000 } }) } }] } }] });
        await sleep(60);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const toolOut = (parsed.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join('\n');
        const words = ['The', 'install', 'ran', '—', String(toolOut.length), 'bytes', 'of', 'streamed', 'output.'];
        for (const w of words) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
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

function bootEngine() {
  const env = {
    ...process.env,
    DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN,
    DOOMALAY_BASE_URL_GROQ: STUB,
    DOOMALAY_OTA_DISABLE: '1',
  };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN,
    '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
    { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

// ── modes ──────────────────────────────────────────────────────────────
if (MODE === 'down') {
  for (const bin of [ENGINE_BIN]) { try { execSync("pkill -f '" + bin + "' || true"); } catch (e) {} }
  try { execSync('pkill -f "v1234-e2e-carrier" || true'); } catch (e) {}
  console.log('down: engine + carrier killed (the stub/bridge rode the carrier process)');
  process.exit(0);
}

// up: build, seed, boot, arm, park (keep-alive)
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/proj/notes.txt', 'alpha\nbravo\n');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}

execFileSync('go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge();
startStub();
bootEngine();
await waitEngine();

await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-1234' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'overlay walk', model: MODEL, provider: 'groq' });
const bind = await jpost(ENGINE + '/api/workspaces/device', {
  name: 'e2e-proj', termux_path: TERMUX_SHARED + '/Doomalay/proj', session_id: SID,
});

console.log('CARRIER UP');
console.log('  engine : ' + ENGINE + '  (PWA at /)');
console.log('  session: ' + SID + ' (model ' + MODEL + ', termux auto-stacked)');
console.log('  bind   : ' + JSON.stringify(bind.body));
console.log('  bridge : ' + BRIDGE + '/' + TOKEN + '  (executes bash for real)');
console.log('  stub   : ' + STUB + '  (round1: termux exec → the ~10s slow stream)');
console.log('  fake   : ' + FAKE_SHARED + '/Doomalay/proj');

// park forever (the stub + bridge ride this process)
setInterval(() => {}, 60000);
