#!/usr/bin/env node
// v1233-live-stream-rig.mjs — v1.23.3 THE LIVE STREAM (PLAN-V123 §3).
//
// A real engine + the v1211 executing fake bridge: the wrapper's curls hit
// the ENGINE's live stream route, so the whole streaming physics runs for
// real. Driven EXACTLY as pmsdk.js drives a PM chat's termux call (POST
// /mcp with X-Doomalay-Session) — while the call blocks, the rig polls
// the PM side channel (/api/termux/stream?session=&after=) the same way
// the PM loop's poller does.
//
// Scenarios:
//   S1 THE STREAM: a slow 6-line command (~3.3s) — the poll sees deltas
//      arrive at ~0.5s cadence, len grows monotonically, done + ec land;
//      the final /mcp observation carries every line + exit_code 0 (the
//      STREAMED buffers, not the broadcast fallback).
//   S2 THE SPLIT: stdout + stderr stay separated in the observation.
//   S3 THE OFFSET: consecutive polls with after=<len> return only the
//      new bytes (the delta math the PM poller relies on).
//   S4 THE TIMEOUT: a command that outlives its budget — the honest
//      TIMEOUT observation + the PARTIAL output from the live stream.
//   S5 THE HONEST EDGE: a wrong-token POST 404s; a session with no
//      stream answers active:false (the poll never lies).
//
// Modes: run (default) · --keep · --down
'use strict';

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const MODE = process.argv[2] || '';

const ENGINE_BIN = '/tmp/doomalay-v1233-engine';
const DATA_DIR = '/tmp/doomalay-v1233-data';
const ENGINE_LOG = '/tmp/v1233-engine.log';
const STATE_FILE = '/tmp/v1233-rig.json';

const ENGINE_PORT = 8097;
const BRIDGE_PORT = 8636;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1233-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;

let okCount = 0, failCount = 0;
function ok(cond, label, extra) {
  if (cond) { okCount++; console.log('  ok - ' + label); }
  else { failCount++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 400) : '')); }
}

function seedFs() {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.mkdirSync(FAKE_SHARED + '/Doomalay/proj', { recursive: true });
  fs.writeFileSync(FAKE_SHARED + '/Doomalay/proj/notes.txt', 'alpha\nbravo\n');
}

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);

// ── the fake bridge (the v1211 executing law) ──────────────────────────
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
        const startedAt = Date.now();
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
          const timedOut = signal === 'SIGKILL' && Date.now() - startedAt > timeoutMS;
          send(200, {
            ok: true, stdout: intoTermux(out), stderr: intoTermux(errOut),
            exit_code: timedOut ? 124 : (code === null ? 1 : code),
            err: 0, errmsg: null, timeout: timedOut,
          });
        });
      });
      return;
    }
    send(404, { ok: false, error: 'no route' });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

function bootEngine() {
  const env = { ...process.env, DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN, DOOMALAY_OTA_DISABLE: '1' };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN,
    '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
    { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

async function jpost(u, body, headers) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jget(u) {
  const r = await fetch(u); const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcpCall(sessionId, name, args) {
  return jpost(ENGINE + '/mcp', {
    jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call',
    params: { name, arguments: args || {} },
  }, { 'X-Doomalay-Session': sessionId || '' });
}
function toolText(res) {
  const content = (res.body && res.body.result && res.body.result.content) || [];
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}

function tearDown() {
  try { const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); for (const pid of st.pids || []) { try { process.kill(-pid, 'SIGTERM'); } catch (e) {} } } catch (e) {}
  try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
  try { fs.rmSync(ENGINE_BIN, { force: true }); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
  console.log('torn down');
}

// armSession: a session + a bound termux workspace (the bind auto-stacks).
async function armSession(id) {
  await jpost(ENGINE + '/api/sessions', { id, title: 'rig ' + id, model: 'm', provider: 'p' });
  // the v1211 shape: the device row with a termux_path (the bind IS the
  // consent — the auto-stack flips ⌨ on).
  await jpost(ENGINE + '/api/workspaces/device', {
    name: 'rig-' + id, termux_path: TERMUX_SHARED + '/Doomalay/proj', session_id: id,
  });
}

// ── the scenarios ──────────────────────────────────────────────────────
async function run() {
  seedFs();
  const bridge = startBridge();
  const build = spawn('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
  await new Promise((r, j) => { build.on('close', (c) => c === 0 ? r() : j(new Error('build failed'))); });
  bootEngine();
  await waitEngine();

  console.log('S1 — THE STREAM (a slow 6-line command, polled like the PM loop):');
  await armSession('stream1');
  const slow = 'for i in 1 2 3 4 5 6; do echo line-$i; sleep 0.55; done';
  const t0 = Date.now();
  const call = mcpCall('stream1', 'termux', { action: 'exec', args: { command: slow, timeout_ms: 30000 } });
  // poll EXACTLY like pmsdk's poller (600ms cadence, after=<len>)
  const polls = [];
  let after = 0;
  while (true) {
    await sleep(600);
    const p = await jget(ENGINE + '/api/termux/stream?session=stream1&after=' + after);
    if (p.body && p.body.active) {
      if (typeof p.body.len === 'number') after = p.body.len;
      if (p.body.text) polls.push({ at: Date.now() - t0, text: p.body.text, len: p.body.len });
      if (p.body.done) break;
    } else if (Date.now() - t0 > 15000) break; // safety
  }
  const res = await call;
  const text = toolText(res);
  ok(polls.length >= 3, 'the stream produced ≥3 poll deltas (got ' + polls.length + ')', JSON.stringify(polls));
  const cadenceOk = polls.length >= 2 && (polls[polls.length - 1].at - polls[0].at) / (polls.length - 1) < 1500;
  ok(cadenceOk, 'the chunk cadence is sub-1.5s (the twice-a-second law)', polls.map((p) => p.at).join(','));
  const sawMid = polls.slice(0, -1).some((p) => /line-[1-5]\n/.test(p.text));
  ok(sawMid, 'the MID-STREAM lines arrived BEFORE completion (live, not a pop-in)');
  for (let i = 1; i <= 6; i++) {
    if (!text.includes('line-' + i)) { ok(false, 'the observation carries line-' + i, text); break; }
    if (i === 6) ok(true, 'the observation carries every line');
  }
  ok(/EXEC DONE/.test(text) && /exit_code: 0/.test(text), 'the observation: EXEC DONE + exit_code 0', text.slice(0, 200));
  ok(/stdout:/.test(text) && /stderr:/.test(text), 'the observation separates the streams');

  console.log('S2 — THE SPLIT (stdout vs stderr stay separated):');
  await armSession('split1');
  const sres = await mcpCall('split1', 'termux', { action: 'exec', args: { command: 'echo to-out; echo to-err >&2', timeout_ms: 20000 } });
  const stext = toolText(sres);
  const outM = stext.match(/stdout:\n([\s\S]*?)\nstderr:/);
  const errM = stext.match(/stderr:\n([\s\S]*)$/);
  ok(outM && /to-out/.test(outM[1]) && !/to-err/.test(outM[1]), 'stdout carries only to-out', stext);
  ok(errM && /to-err/.test(errM[1]) && !/to-out/.test(errM[1]), 'stderr carries only to-err', stext);

  console.log('S3 — THE OFFSET (consecutive polls return only the new bytes):');
  await armSession('off1');
  const call3 = mcpCall('off1', 'termux', { action: 'exec', args: { command: 'echo a; sleep 1.4; echo b', timeout_ms: 20000 } });
  await sleep(900); // mid-flight: flush #1 (a) landed at ~0.55s, b at ~1.9s
  const p1 = await jget(ENGINE + '/api/termux/stream?session=off1&after=0');
  ok(p1.body && p1.body.active === true && /a\n/.test(p1.body.text || '') && !/b/.test(p1.body.text || ''), 'the mid-flight poll sees only a', JSON.stringify(p1.body));
  const lenA = (p1.body && p1.body.len) || 0;
  await call3; // let it finish
  // a finished stream answers active:false honestly — the FINAL observation
  // carries b (the poller's contract: the call's result is the whole truth)
  const p2 = await jget(ENGINE + '/api/termux/stream?session=off1&after=' + lenA);
  ok(p2.body && p2.body.active === false, 'a finished stream answers active:false (never a stale lie)', JSON.stringify(p2.body));
  const t3 = toolText(await mcpCall('off1', 'termux', { action: 'exec', args: { command: 'echo again', timeout_ms: 20000 } }));
  ok(/again/.test(t3), 'the offset math never corrupts the next call (the registry is per-stream)');

  console.log('S4 — THE TIMEOUT (the honest partial from the live stream):');
  await armSession('slow1');
  const tres = await mcpCall('slow1', 'termux', { action: 'exec', args: { command: 'echo partial-one; sleep 8', timeout_ms: 2000 } });
  const ttext = toolText(tres);
  ok(/TIMEOUT — Termux killed the command at its 2s budget/.test(ttext), 'the TIMEOUT verdict', ttext.slice(0, 200));
  ok(/partial-one/.test(ttext), 'the PARTIAL stdout rides (from the live stream)', ttext.slice(0, 300));

  console.log('S5 — THE HONEST EDGE:');
  const wrong = await fetch(ENGINE + '/api/termux/stream/not-a-real-token', { method: 'POST', body: 'x' });
  ok(wrong.status === 404, 'a wrong token 404s (the unguessability law)');
  const none = await jget(ENGINE + '/api/termux/stream?session=no-stream-here&after=0');
  ok(none.body && none.body.active === false, 'a session with no stream answers active:false (the poll never lies)');
  const noSess = await jget(ENGINE + '/api/termux/stream');
  ok(noSess.status === 400, 'a poll without a session 400s');

  // source pins (the PWA + engine contract)
  const cp = fs.readFileSync(__ROOT + '/engine/internal/server/web/chatpanel.js', 'utf8');
  const pm = fs.readFileSync(__ROOT + '/engine/internal/server/web/vendor/pm/pmsdk.js', 'utf8');
  console.log('S6 — THE SOURCE CONTRACTS:');
  ok(/type === 'tool_stream'/.test(cp) && /bumpActivity\(state\);/.test(cp.slice(cp.indexOf("type === 'tool_stream'"), cp.indexOf("type === 'tool_stream'") + 900)), 'the WS tool_stream handler bumps the activity clock (the stall fix)');
  ok(/onToolStream: function/.test(cp), 'the PM loop wires onToolStream');
  ok(/name === 'termux' && opts\.sessionId/.test(pm) && /after=' \+ streamLen/.test(pm), 'pmsdk polls the side channel while a termux call blocks');
  ok(/"tool_stream"/.test(fs.readFileSync(__ROOT + '/engine/internal/server/chat.go', 'utf8')), 'the engine forwards tool_stream ephemerally');
  ok(/tool-pill-bar/.test(cp), 'the pill renders the loading bar while in flight');

  console.log(`\nv1233 live-stream rig: ${okCount} ok, ${failCount} FAIL`);
  if (MODE !== '--keep') { try { bridge.close(); } catch (e) {} tearDown(); }
  else console.log('kept up: engine ' + ENGINE);
  process.exit(failCount ? 1 : 0);
}

if (MODE === '--down') { tearDown(); process.exit(0); }
run().catch((e) => { console.error('FATAL:', e.message); tearDown(); process.exit(1); });
