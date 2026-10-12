#!/usr/bin/env node
// v1300-replication.mjs — v1.29.4 THE TOOL MEMORY's REAL-MODEL
// replication (the user's explicit ask: "If you can try and replicate
// this urself"): a REAL provider (OpenRouter, qwen-2.5-72b) through the
// REAL engine with the EXECUTING fake bridge, reproducing the Doobie
// transcript's disease and proving the cure:
//
//   TURN 1 — "use the termux tool exec to run `cat notes.txt`" → the
//             model emits a REAL tool call; the bridge REALLY runs it;
//             the observation lands in the persisted events.
//   TURN 2 — "without running any command, what were the three words?"
//             → THE MEMORY PROOF: the model answers from the folded
//             tool observation (the words appear in the reply) AND the
//             bridge's run counter DOES NOT MOVE (no re-read — the
//             transcript's double-read disease, dead).
//
// Pre-wave behavior (verified by the code recon): turn 2 started
// fact-blind (tool events never entered the history) — the model either
// re-ran the command or guessed.

'use strict';
import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1300-repl-engine';
const DATA_DIR = '/tmp/v1300-repl-data';
const ENGINE_LOG = '/tmp/v1300-repl-engine.log';
const ENGINE_PORT = 8681;
const BRIDGE_PORT = 8683;
const TOKEN = 'tok-' + Math.random().toString(16).slice(2, 12);
const FAKE_HOME = '/tmp/v1300-repl-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const SID = 'v1300-replication-' + Date.now(); // fresh per run: the WS connect replay of an old session arms the activity heuristic + pollutes the assertions
// the real provider + a model that calls tools (probed: qwen-2.5-72b-instruct)
const PROVIDER = 'openrouter';
const MODEL = 'openrouter/qwen/qwen-2.5-72b-instruct';
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const THE_WORDS = ['kilometer', 'lantern', 'meridian']; // unique — never in the prompt

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okCount = 0, failCount = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { okCount++; console.log('  ok - ' + name); }
  else { failCount++; fails.push(name); console.log('  FAIL - ' + name + (extra ? '  → ' + String(extra).slice(0, 400) : '')); }
}
async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jget(u) {
  const r = await fetch(u);
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}

// ── the executing fake bridge (run-counted) ─────────────────────────
let bridgeRuns = 0;
const bridgeCommands = [];
function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false }); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) { send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/probe')) { send(200, { ok: true, storage_ok: true, props_ok: true, stdout: '__doomalay_probe__\nstorage_ok\nprops_ok\n', stderr: '', exit_code: 0, err: 0, errmsg: null, timeout: false }); return; }
    if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
    if (req.method === 'POST' && req.url.endsWith('/run')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        bridgeRuns++;
        bridgeCommands.push(String(b.command || ''));
        const cmd = intoFake(String(b.command || ''));
        const workdir = b.workdir ? intoFake(String(b.workdir)) : '';
        const p = spawn('bash', ['-c', cmd], { env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin' }, cwd: fs.existsSync(workdir) ? workdir : undefined });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        try { p.stdin.end(); } catch (e) {}
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 190000);
        p.on('close', (code) => {
          clearTimeout(timer);
          send(200, { ok: true, stdout: out.slice(0, 102400), stderr: errOut.slice(0, 20480), stdout_original_length: out.length, stderr_original_length: errOut.length, exit_code: code === null ? -1 : code, err: 0, errmsg: null, timeout: false });
        });
      });
      return;
    }
    send(404, { ok: false });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

function bootEngine() {
  const env = { ...process.env, DOOMALAY_TERMUX_BRIDGE: BRIDGE + '/' + TOKEN, DOOMALAY_OTA_DISABLE: '1' };
  const out = fs.openSync(ENGINE_LOG, 'a');
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

// ── the WS client (node's native WebSocket) ─────────────────────────
function wsSession(sid) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket('ws://127.0.0.1:' + ENGINE_PORT + '/api/chat?session_id=' + encodeURIComponent(sid));
    let idleResolve = null;
    let sawActivity = false; // v1300 fix: an idle only counts AFTER the turn produced activity (the connect-replay's historical statuses never resolve a wait)
    const wsTimeout = setTimeout(() => { reject(new Error('ws timeout')); try { ws.close(); } catch (e) {} }, 240000);
    ws.onopen = () => {
      resolve({
        events,
        send: (text) => { sawActivity = false; ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid })); },
        waitIdle: (timeoutMs) => new Promise((res) => {
          idleResolve = res;
          setTimeout(() => { idleResolve = null; res(false); }, timeoutMs || 180000);
        }),
        close: () => { clearTimeout(wsTimeout); try { ws.close(); } catch (e) {} },
      });
    };
    ws.onerror = (e) => { clearTimeout(wsTimeout); reject(new Error('ws error')); };
    ws.onmessage = (m) => {
      let ev = null; try { ev = JSON.parse(m.data); } catch (e) { return; }
      events.push(ev);
      const t = ev.type;
      if (t === 'assistant_delta' || t === 'assistant' || t === 'tool_use' || t === 'tool_result' || t === 'thinking' || t === 'progress') {
        sawActivity = true;
      }
      if (t === 'status' && (ev.state === 'idle' || ev.state === 'error')) {
        if (idleResolve && sawActivity) { const r = idleResolve; idleResolve = null; r(ev.state === 'idle'); }
      }
    };
  });
}

function replyText(events) {
  return events.filter((e) => e.type === 'assistant' || e.type === 'assistant_delta').map((e) => e.text || '').join('');
}
function toolResults(events) {
  return events.filter((e) => e.type === 'tool_result').map((e) => e.text || '').join('\n');
}
function toolUses(events) {
  return events.filter((e) => e.type === 'tool_use');
}

// ══ THE REPLICATION ═════════════════════════════════════════════════
console.log('v1300 REAL-MODEL REPLICATION — THE TOOL MEMORY against OpenRouter qwen-2.5-72b');
if (!OR_KEY) { console.log('OPENROUTER_API_KEY missing'); process.exit(1); }

fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/repl-proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/repl-proj/notes.txt', THE_WORDS.join('\n') + '\n');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge();
bootEngine();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'OPENROUTER_API_KEY', provider: 'openrouter', key: OR_KEY });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'the tool memory replication', model: MODEL, provider: PROVIDER });
await jpost(ENGINE + '/api/workspaces/device', { name: 'repl-proj', termux_path: TERMUX_SHARED + '/Doomalay/repl-proj', session_id: SID });
console.log('S1 — the world boots (engine + real provider + executing bridge + armed session)');

const session = await wsSession(SID);
await sleep(2000); // the connect replay settles BEFORE the first send (the sawActivity law)

// TURN 1 — the real model runs the command through the real tool path
console.log('TURN 1 — "run cat notes.txt via the termux tool":');
const runsBefore1 = bridgeRuns;
session.send('Use the termux tool (action exec) to run this exact command: cat notes.txt — then tell me the three words you saw.');
const t1 = await session.waitIdle(200000);
await sleep(6000); // the engine's quiet law (the turn lock releases seconds after the terminal flush on tool turns — the post-turn tail; a human cadence is seconds anyway)
const words1 = replyText(session.events).toLowerCase();
const res1 = toolResults(session.events);
const uses1 = toolUses(session.events);
ok('T1: the turn ended clean (idle)', t1 === true);
ok('T1: the model made a REAL termux tool call', uses1.length >= 1, JSON.stringify(uses1.slice(0, 2)));
ok('T1: the bridge REALLY ran the command', bridgeRuns > runsBefore1, 'runs=' + (bridgeRuns - runsBefore1) + ' cmds=' + JSON.stringify(bridgeCommands.slice(0, 2)));
ok('T1: the observation carried the words', THE_WORDS.every((w) => res1.toLowerCase().includes(w)), res1.slice(0, 120));
ok('T1: the reply spoke the words', THE_WORDS.every((w) => words1.includes(w)), words1.slice(-160));

// the persisted events carry the pair (the fold's source)
const evs = await jget(ENGINE + '/api/sessions/' + SID + '/events');
const rows = (evs.body && (evs.body.events || evs.body)) || [];
const evTypes = (Array.isArray(rows) ? rows : []).map((r) => r.event_type || r.type || '');
ok('T1: the persisted events carry tool_use + tool_result (the fold source)', evTypes.includes('tool_use') && evTypes.includes('tool_result'), JSON.stringify(evTypes.slice(-8)));

// TURN 2 — THE MEMORY PROOF: answer WITHOUT re-reading
console.log('TURN 2 — "without running any command, what were the three words?" (THE MEMORY PROOF):');
const evLenBefore2 = session.events.length;
const runsBefore2 = bridgeRuns;
session.send('Without running ANY command or tool, tell me again: what were the three words in notes.txt? Answer from what you already read.');
const t2 = await session.waitIdle(200000);
await sleep(500);
const turn2Events = session.events.slice(evLenBefore2);
const words2 = replyText(turn2Events).toLowerCase();
const uses2 = toolUses(turn2Events);
ok('T2: the turn ended clean (idle)', t2 === true);
ok('T2: THE MEMORY — the reply names all three words', THE_WORDS.every((w) => words2.includes(w)), words2.slice(0, 300));
ok('T2: NO re-read — the bridge run count did NOT move', bridgeRuns === runsBefore2, 'delta=' + (bridgeRuns - runsBefore2));
ok('T2: no termux call in turn 2', uses2.length === 0, JSON.stringify(uses2.slice(0, 2)));

session.close();
console.log('');
console.log('v1300 replication: ' + okCount + '/' + (okCount + failCount));
if (failCount) {
  console.log('FAILS:'); fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('THE MEMORY IS REAL: the model answered turn 2 from the folded tool observation — no re-read.');
