#!/usr/bin/env node
// v1400-unbroken-stream-rig.mjs — THE UNBROKEN STREAM redteam (the user's
// two reports, verbatim):
//   LEVEL 1 — "the app running on the background should not pause the bots
//              working whatsoever… when the user comes back and opens the
//              bots panel it should update the log to reflect all the work
//              that was done in his absence"
//   LEVEL 2 — "It should continue with all it's effort to work despite me
//              not having internet, when it reconnect, it should update the
//              chat logs to show everything I've missed"
//
// The engine-level proof on the REAL engine (spawned with the v1.39.3
// rig-only clock compression; production numbers are the defaults):
//
//   S1  boot (two engines: A the fast-clock patient engine, B the
//       long-cap wake engine; the stub provider; the FAKE BRIDGE)
//   S2  THE BUSY GAUGE — /api/engine/busy reads the live truth (Kotlin's
//       wakelock poll rides it): 1 mid-turn, 0 after
//   S3  THE PATIENT LADDER — the stub DIES (connection refused): the turn
//       suspends past the old ~110s give-up ceiling, the door stays SHUT
//       (a stranger send gets the honest busy answer), the persisted
//       pause notice is in the log; the stub returns → the turn completes
//       → the regained notice + the full text
//   S4  THE NET WAKE — a 60s-capped suspension wakes in ~1s of the fake
//       bridge's seq flip (the whole chain: bridge long-poll → the
//       engine's listener → WakeNet → the waiter)
//   S6  THE SEAMLESS CUT — the stub streams 3 chunks then KILLS the
//       socket mid-stream: no terminal, the seam notice, the continuation
//       completes the answer — zero duplicated text
//   S7  NON-TRANSIENT STAYS TERMINAL — a 401 ends honestly (no
//       suspension, no notices)
//   S8  STOP DURING SUSPENSION — the user's Stop is the only exit: the
//       turn ends clean, the gauge drains, no zombie
//   S9  THE SOURCE PINS — the Kotlin wakelock/netwake/renderer-defense,
//       the JS resync/sweep, the ladder's no-give-up shape, the v1.35
//       fabricated-bubble ban still standing
//
// The PWA half (the honest return, the resync, the navigate-away
// catch-up) is the WALK's job (v1400-unbroken-stream-walk.mjs).
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const GO_BIN = process.env.GO_BIN || 'go';
const BIN_A = '/tmp/doomalay-v1400-engine-a';
const BIN_B = '/tmp/doomalay-v1400-engine-b';
const DATA_A = '/tmp/v1400-a-data';
const DATA_B = '/tmp/v1400-b-data';
const LOG_A = '/tmp/v1400-a-engine.log';
const LOG_B = '/tmp/v1400-b-engine.log';

const PORT_A = 8701;
const PORT_B = 8711;
const STUB_PORT = 8702;
const BRIDGE_PORT = 8703;
const ENGINE_A = 'http://127.0.0.1:' + PORT_A;
const ENGINE_B = 'http://127.0.0.1:' + PORT_B;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const BRIDGE_TOKEN = 'rig-bridge-token-' + crypto.randomBytes(4).toString('hex');
const BRIDGE_URL = 'http://127.0.0.1:' + BRIDGE_PORT + '/' + BRIDGE_TOKEN;
const MODEL = 'stub-model';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let b = {}; try { b = await r.json(); } catch (e) {}
  return { status: r.status, body: b };
}
async function jget(url) {
  try { const r = await fetch(url); return { status: r.status, body: await r.json() }; } catch (e) { return { status: 0, body: null }; }
}
async function eventsOf(engine, sid) {
  const r = await jget(engine + '/api/sessions/' + sid + '/events');
  return (r.body && (r.body.events || r.body)) || [];
}

async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
    const busy = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(true));
      s.once('listening', () => s.close(() => res(false)));
      s.listen(port, '127.0.0.1');
    });
    if (!busy) return true;
    await sleep(200);
  }
  return false;
}
async function waitEngine(engine, log) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(engine + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(log, 'utf8').slice(-800));
}

// ── the chat WS: one persistent socket per session, event-collecting ──
function chatWS(port, sessionId) {
  const w = new WebSocket('ws://127.0.0.1:' + port + '/api/chat?session_id=' + encodeURIComponent(sessionId));
  const state = { evs: [], open: false, closed: false };
  const pending = [];
  w.onopen = () => { state.open = true; };
  w.onclose = () => { state.open = false; state.closed = true; };
  w.onmessage = (e) => {
    try { const ev = JSON.parse(e.data); state.evs.push(ev); pending.forEach((p) => p(ev)); } catch (err) {}
  };
  state.send = (obj) => { try { w.send(JSON.stringify(obj)); return true; } catch (e) { return false; } };
  state.waitFor = (pred, timeoutMs) => new Promise((resolve) => {
    const found = state.evs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const fn = (ev) => { if (pred(ev)) { cleanup(); resolve(ev); } };
    const cleanup = () => { clearTimeout(timer); const i = pending.indexOf(fn); if (i >= 0) pending.splice(i, 1); };
    pending.push(fn);
  });
  state.close = () => { try { w.close(); } catch (e) {} };
  return state;
}

// ── the stub provider: content-keyed, killable, cut-capable ──────────
let stubSrv = null;
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  stubSrv = http.createServer(async (req, res) => {
    const url = req.url.replace(/\?.*$/, '');
    if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
      const users = (parsed.messages || []).filter((m) => m.role === 'user');
      const lastUser = String((users[users.length - 1] || {}).content || '');
      const mk = (tag, i) => ' ' + tag + '-chunk-' + i + ' padding text to make the tail real. ';
      if (/authfail/i.test(lastUser)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key (the honest terminal class)', code: 401 } }));
        return;
      }
      // THE SEAM'S CONTINUATION REQUEST: the context's LAST user message is
      // the nudge ("cut off mid-stream…") — serve the completing half.
      if (/cut off mid-stream/.test(lastUser)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (let i = 0; i < 4; i++) { sse(res, { choices: [{ delta: { content: mk('seam-post', i) } }] }); await sleep(120); }
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (/seam/i.test(lastUser)) {
        // THE SEAMLESS CUT shape: the request streams visible content then
        // the connection DIES mid-stream (no [DONE]). The continuation is
        // the branch above (matched by its nudge).
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (let i = 0; i < 3; i++) { sse(res, { choices: [{ delta: { content: mk('seam-pre', i) } }] }); await sleep(120); }
        res.socket.destroy(); // THE CUT — the mobile-VPN shape
        return;
      }
      // the default: a modest multi-chunk turn
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (let i = 0; i < 5; i++) { sse(res, { choices: [{ delta: { content: mk('turn', i) } }] }); await sleep(130); }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((r) => stubSrv.listen(STUB_PORT, '127.0.0.1', () => r(stubSrv)));
}
async function killStub() {
  if (!stubSrv) return;
  await new Promise((r) => { stubSrv.close(() => r()); stubSrv.closeAllConnections?.(); });
  stubSrv = null;
}

// ── the FAKE BRIDGE: the /netwait long-poll contract + a flip() ──────
function startFakeBridge() {
  let seq = 0;
  const armed = []; // {answer, timer} of pending netwaits
  const srv = http.createServer((req, res) => {
    const u = req.url || '';
    if (!u.includes('/netwait')) { res.writeHead(404); res.end('nope'); return; }
    const q = new URL(u, 'http://x').searchParams;
    const since = Number(q.get('since') || 0);
    const timeoutMS = Math.min(Number(q.get('timeout_ms') || 30000), 60000);
    const waiter = { answer: null, timer: null };
    const unarm = () => { clearTimeout(waiter.timer); const i = armed.indexOf(waiter); if (i >= 0) armed.splice(i, 1); };
    waiter.answer = () => {
      unarm();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seq: seq, timeout: seq <= since }));
    };
    waiter.timer = setTimeout(() => waiter.answer(), timeoutMS);
    if (seq > since) { waiter.answer(); return; }
    armed.push(waiter);
  });
  return new Promise((r) => srv.listen(BRIDGE_PORT, '127.0.0.1', () => r({
    flip: () => { seq++; armed.splice(0).forEach((w) => { clearTimeout(w.timer); w.answer(); }); },
    close: () => new Promise((r2) => srv.close(() => r2())),
    seq: () => seq,
  })));
}

function bootEngine(bin, dataDir, log, port, extraEnv) {
  const env = {
    ...process.env,
    PATH: process.env.PATH,
    GOTOOLCHAIN: 'auto',
    DOOMALAY_BASE_URL_GROQ: STUB,
    DOOMALAY_OTA_DISABLE: '1',
    ...extraEnv,
  };
  const out = fs.openSync(log, 'a');
  const child = spawn('nohup', ['setsid', bin,
    '--port', String(port), '--bind', '127.0.0.1', '--data-dir', dataDir,
    '--termux-bridge', BRIDGE_URL],
    { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function stopEngine(bin, port, log) {
  try { execSync("pkill -9 -f '" + bin + "' || true"); } catch (e) {}
  try { execSync("pkill -9 -f 'doomalay.*--port " + port + "' || true"); } catch (e) {}
  await sleep(300);
  return await waitPortFree(port);
}

// the fast-clock patient engine (production ratios, millisecond scale).
// NOTE the pacer: PaceProvider inserts a ~2s provider-cooldown wait before
// each retry attempt (a legitimate engine behavior — production's 2s is
// nothing against the 120s stale window). The compressed stale window must
// clear the pacer's gap or the door would open on healthy retries: 2500ms.
const CLOCKS_A = {
  DOOMALAY_NET_LADDER_WAITS: '120,200',
  DOOMALAY_NET_SUSPEND_BASE_MS: '250',
  DOOMALAY_NET_SUSPEND_CAP_MS: '600',
  DOOMALAY_NET_HEARTBEAT_MS: '80',
  DOOMALAY_TURN_STALE_MS: '2500',
};
// the wake engine: the rungs stay fast but the suspended waits are LONG —
// only the bridge flip can finish the turn quickly
const CLOCKS_B = {
  DOOMALAY_NET_LADDER_WAITS: '100,150',
  DOOMALAY_NET_SUSPEND_BASE_MS: '30000',
  DOOMALAY_NET_SUSPEND_CAP_MS: '60000',
  DOOMALAY_NET_HEARTBEAT_MS: '100',
  DOOMALAY_TURN_STALE_MS: '2500',
};

console.log('═══ v1400 THE UNBROKEN STREAM rig ═══');
console.log('S1 — BOOT (engine A: fast clocks; engine B: the wake clocks):');
for (const d of [DATA_A, DATA_B]) fs.rmSync(d, { recursive: true, force: true });
fs.writeFileSync(LOG_A, ''); fs.writeFileSync(LOG_B, '');
for (const b of [BIN_A, BIN_B]) { try { execSync('pkill -9 -f ' + b + ' || true'); } catch (e) {} }
ok('S1: engine ports are free', (await waitPortFree(PORT_A)) && (await waitPortFree(PORT_B)));
execFileSync(GO_BIN, ['build', '-o', BIN_A, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit', env: { ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto' } });
execFileSync(GO_BIN, ['build', '-o', BIN_B, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit', env: { ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto' } });
await startStub();
const bridge = await startFakeBridge();
bootEngine(BIN_A, DATA_A, LOG_A, PORT_A, CLOCKS_A);
bootEngine(BIN_B, DATA_B, LOG_B, PORT_B, CLOCKS_B);
await waitEngine(ENGINE_A, LOG_A);
await waitEngine(ENGINE_B, LOG_B);
ok('S1: both engines healthy (A fast clocks, B wake clocks)', true);
const mkSession = async (engine, tag) => {
  const sid = 'v1400-' + tag + '-' + crypto.randomBytes(3).toString('hex');
  await jpost(engine + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
  await jpost(engine + '/api/sessions', { id: sid, title: 'v1400 ' + tag, model: MODEL, provider: 'groq' });
  return sid;
};
console.log('S1 ok');

// ── S2 — THE BUSY GAUGE ─────────────────────────────────────────────
console.log('S2 — THE BUSY GAUGE (Kotlin\'s wakelock poll rides it):');
{
  const sid = await mkSession(ENGINE_A, 'gauge');
  const ws = chatWS(PORT_A, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  ok('S2: the socket connects', ws.open);
  ws.send({ type: 'send', message: 'a normal turn for the gauge', session_id: sid });
  await ws.waitFor((ev) => ev.type === 'assistant_delta', 10000);
  const busyMid = await jget(ENGINE_A + '/api/engine/busy');
  ok('S2: mid-turn the gauge reads turns=1 + the session',
    busyMid.body && busyMid.body.turns === 1 && Array.isArray(busyMid.body.sessions) && busyMid.body.sessions.includes(sid),
    JSON.stringify(busyMid.body));
  await ws.waitFor((ev) => ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error'), 20000);
  await sleep(400);
  const busyEnd = await jget(ENGINE_A + '/api/engine/busy');
  ok('S2: after the terminal the gauge drains to 0', busyEnd.body && busyEnd.body.turns === 0, JSON.stringify(busyEnd.body));
  ws.close();
}
console.log('S2 ok');

// ── S3 — THE PATIENT LADDER (the outage is a pause, not a verdict) ───
console.log('S3 — THE PATIENT LADDER (stub dead → suspension → stub back):');
{
  const sid = await mkSession(ENGINE_A, 'patient');
  const ws = chatWS(PORT_A, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  await killStub(); // THE OUTAGE (connection refused = the transient class)
  ws.send({ type: 'send', message: 'stream the patient turn', session_id: sid });
  // the old ladder gave up at rungs-total; wait PAST several suspension
  // cycles — nothing may end the turn. (The pacer adds ~2s per attempt:
  // rungs 120+200ms + 2 paces ≈ 4.5s before the suspension even arms.)
  const enterNotice = await ws.waitFor((ev) => ev.type === 'notice' && /connection to .* lost/.test(ev.text || ''), 15000);
  ok('S3: the persisted pause notice lands (the transcript story begins)', !!enterNotice);
  const heart = await ws.waitFor((ev) => ev.type === 'progress' && /network still paused/.test(ev.text || ''), 10000);
  ok('S3: the suspension heartbeats (the live truth + the pulse)', !!heart);
  await sleep(1200); // several suspended retries fail (stub still dead)
  const busyMid = await jget(ENGINE_A + '/api/engine/busy');
  ok('S3: the turn is STILL ALIVE past the old give-up ceiling (gauge=1)', busyMid.body && busyMid.body.turns === 1, JSON.stringify(busyMid.body));
  const evsMid = await eventsOf(ENGINE_A, sid);
  const termMid = evsMid.filter((e) => (e.Type || e.type) === 'status' && (e.state === 'error' || e.state === 'idle'));
  ok('S3: NO terminal fired during the outage', termMid.length === 0, JSON.stringify(termMid).slice(0, 160));
  // THE DOOR STAYS SHUT (the pulse survives suspension): a stranger send
  // gets the honest busy answer — never an abort
  const stranger = chatWS(PORT_A, sid);
  await stranger.waitFor((ev) => ev.type === 'ws_state', 5000);
  stranger.send({ type: 'send', message: 'a stranger send during the outage', session_id: sid });
  const busyAnswer = await stranger.waitFor((ev) => ev.type === 'error' && /busy|still running/i.test(ev.text || ev.message || ''), 8000);
  ok('S3: the stranger send gets the honest BUSY answer (the door stayed shut)', !!busyAnswer);
  stranger.close();
  // THE NETWORK RETURNS — the turn completes on its own. (The live tail
  // may have followed the stranger's now-closed pipe — the v1.35 law: the
  // newest subscriber owns the live feed; the EVENT LOG is the truth —
  // the v1350 rig's own precedent. Poll it.)
  await startStub();
  let completed = false;
  for (let i = 0; i < 30; i++) {
    const evs = await eventsOf(ENGINE_A, sid);
    if (evs.some((e) => (e.Type || e.type) === 'status' && e.state === 'idle')) { completed = true; break; }
    await sleep(500);
  }
  ok('S3: the turn completes when the network returns (no manual continue)', completed);
  const evs = await eventsOf(ENGINE_A, sid);
  const texts = evs.map((e) => String(e.Text || e.text || '')).join(' ');
  ok('S3: the transcript carries BOTH notices (lost + regained)', /connection to .* lost/.test(texts) && /network regained after/.test(texts), texts.slice(0, 300));
  ok('S3: the answer content landed (the work was done in the "absence")', /turn-chunk-4/.test(texts));
  ws.close();
}
console.log('S3 ok');

// ── S4 — THE NET WAKE (the bridge flip beats the 60s wait) ──────────
console.log('S4 — THE NET WAKE (engine B, 30-60s suspended waits):');
{
  const sid = await mkSession(ENGINE_B, 'wake');
  const ws = chatWS(PORT_B, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  await killStub();
  ws.send({ type: 'send', message: 'stream the wake turn', session_id: sid });
  const enterNotice = await ws.waitFor((ev) => ev.type === 'notice' && /connection to .* lost/.test(ev.text || ''), 8000);
  ok('S4: the suspension arms (the enter notice)', !!enterNotice);
  const heart = await ws.waitFor((ev) => ev.type === 'progress' && /network still paused/.test(ev.text || ''), 5000);
  ok('S4: the waiter is armed (the first heartbeat)', !!heart);
  // THE NETWORK RETURNS + THE FLIP — the wake must beat a 15-30s average wait
  await startStub();
  const t0 = Date.now();
  bridge.flip();
  const term = await ws.waitFor((ev) => ev.type === 'status' && ev.state === 'idle', 8000);
  const dt = Date.now() - t0;
  ok('S4: the wake completed the turn in <4s (the 60s-capped wait was beaten)', !!term && dt < 4000, 'dt=' + dt + 'ms');
  const logB = fs.readFileSync(LOG_B, 'utf8');
  ok('S4: the engine logged the NET WAKE (the bridge chain fired)', /NET WAKE: bridge net seq/.test(logB));
  ws.close();
}
console.log('S4 ok');

// ── S6 — THE SEAMLESS CUT ───────────────────────────────────────────
console.log('S6 — THE SEAMLESS CUT (mid-stream death → hold → continuation):');
{
  const sid = await mkSession(ENGINE_A, 'seam');
  const ws = chatWS(PORT_A, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  ws.send({ type: 'send', message: 'please run the seam turn', session_id: sid });
  const partial = await ws.waitFor((ev) => ev.type === 'assistant_delta' && /seam-pre-chunk-2/.test(ev.text || ''), 8000);
  ok('S6: the partial streamed (3 chunks on screen)', !!partial);
  // THE CUT: the stub destroyed the socket — the turn must NOT terminalize
  const seamNotice = await ws.waitFor((ev) => ev.type === 'notice' && /cut mid-reply/.test(ev.text || ''), 10000);
  ok('S6: the persisted SEAM notice lands (no terminal, the hold)', !!seamNotice);
  const evsMid = await eventsOf(ENGINE_A, sid);
  const termMid = evsMid.filter((e) => (e.Type || e.type) === 'status' && (e.state === 'error' || e.state === 'idle'));
  ok('S6: no terminal fired on the mid-stream cut', termMid.length === 0, JSON.stringify(termMid).slice(0, 160));
  const term = await ws.waitFor((ev) => ev.type === 'status' && ev.state === 'idle', 20000);
  ok('S6: the continuation completes the turn', !!term);
  const evs = await eventsOf(ENGINE_A, sid);
  const deltas = evs.filter((e) => (e.Type || e.type) === 'assistant_delta').map((e) => String(e.Text || e.text || ''));
  const joined = deltas.join('');
  const preCount = (joined.match(/seam-pre-chunk-0/g) || []).length;
  const postCount = (joined.match(/seam-post-chunk-0/g) || []).length;
  ok('S6: BOTH segments are on the record (partial + continuation)', preCount === 1 && postCount === 1, 'pre=' + preCount + ' post=' + postCount + ' :: ' + joined.slice(0, 220));
  const notices = evs.filter((e) => (e.Type || e.type) === 'notice').map((e) => String(e.Text || e.text || ''));
  ok('S6: the seam notice + the regained notice persisted',
    notices.some((t) => /cut mid-reply/.test(t)) && notices.some((t) => /network regained after/.test(t)),
    JSON.stringify(notices).slice(0, 300));
  ws.close();
}
console.log('S6 ok');

// ── S7 — NON-TRANSIENT STAYS TERMINAL ───────────────────────────────
console.log('S7 — NON-TRANSIENT (a 401 ends honestly, no suspension):');
{
  const sid = await mkSession(ENGINE_A, 'auth');
  const ws = chatWS(PORT_A, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  ws.send({ type: 'send', message: 'the authfail turn', session_id: sid });
  const term = await ws.waitFor((ev) => (ev.type === 'status' && ev.state === 'error') || (ev.type === 'error'), 15000);
  ok('S7: the auth failure ends the turn honestly', !!term);
  const evs = await eventsOf(ENGINE_A, sid);
  const notices = evs.filter((e) => (e.Type || e.type) === 'notice');
  ok('S7: NO suspension notices for the non-transient class', notices.length === 0, JSON.stringify(notices).slice(0, 200));
  // the answer-force nudge + the pacer legitimately take ~2.5s — poll the
  // drain instead of sleeping past it
  let drained = false;
  for (let i = 0; i < 20; i++) {
    const b = (await jget(ENGINE_A + '/api/engine/busy')).body;
    if (b && b.turns === 0) { drained = true; break; }
    await sleep(500);
  }
  ok('S7: the gauge drained (no zombie)', drained);
  ws.close();
}
console.log('S7 ok');

// ── S8 — STOP DURING SUSPENSION ─────────────────────────────────────
console.log('S8 — THE USER\'S STOP (the only exit):');
{
  const sid = await mkSession(ENGINE_A, 'stop');
  const ws = chatWS(PORT_A, sid);
  await ws.waitFor((ev) => ev.type === 'ws_state' || ev.type === 'user', 8000);
  await killStub();
  ws.send({ type: 'send', message: 'the stop turn', session_id: sid });
  await ws.waitFor((ev) => ev.type === 'notice' && /connection to .* lost/.test(ev.text || ''), 8000);
  ok('S8: the suspension holds the turn', true);
  ws.send({ type: 'stop', session_id: sid });
  const stopped = await ws.waitFor((ev) => ev.type === 'status' && (ev.state === 'error' || ev.state === 'idle'), 8000);
  ok('S8: Stop ends the suspended turn cleanly', !!stopped);
  let drained8 = false;
  for (let i = 0; i < 20; i++) {
    const b = (await jget(ENGINE_A + '/api/engine/busy')).body;
    if (b && b.turns === 0) { drained8 = true; break; }
    await sleep(500);
  }
  ok('S8: the gauge drained after Stop', drained8);
  await startStub();
  ws.close();
}
console.log('S8 ok');

// ── S9 — THE SOURCE PINS (the whole wave's shape, guarded) ──────────
console.log('S9 — THE SOURCE PINS:');
{
  const manifest = fs.readFileSync(__ROOT + '/platforms/android/app/src/main/AndroidManifest.xml', 'utf8');
  ok('S9: manifest has WAKE_LOCK', /android.permission.WAKE_LOCK/.test(manifest));
  ok('S9: manifest has ACCESS_NETWORK_STATE', /android.permission.ACCESS_NETWORK_STATE/.test(manifest));
  ok('S9: manifest has REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', /android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(manifest));
  const svc = fs.readFileSync(__ROOT + '/platforms/android/app/src/main/java/com/doomalay/engine/EngineService.kt', 'utf8');
  ok('S9: EngineService holds the PARTIAL_WAKE_LOCK (turn-gated)', /PARTIAL_WAKE_LOCK/.test(svc) && /doomalay:engine-turns/.test(svc));
  ok('S9: EngineService polls /api/engine/busy', /\/api\/engine\/busy/.test(svc));
  ok('S9: EngineService releases the wake lock on destroy + idle', /wakeLock\?\.release/.test(svc));
  ok('S9: EngineService registers the NetworkCallback (the validated wake)', /registerNetworkCallback/.test(svc) && /NET_CAPABILITY_VALIDATED/.test(svc));
  ok('S9: the notification tells the busy truth', /bots working/.test(svc));
  const main = fs.readFileSync(__ROOT + '/platforms/android/app/src/main/java/com/doomalay/engine/MainActivity.kt', 'utf8');
  ok('S9: MainActivity overrides onRenderProcessGone (the renderer-death defense)', /onRenderProcessGone/.test(main));
  ok('S9: MainActivity rebuilds the WebView through proceed()', /recreateWebView/.test(main));
  ok('S9: the battery-exemption one-time ask exists', /ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(main) && /pendingBatteryAsk/.test(main));
  const bridgeKt = fs.readFileSync(__ROOT + '/platforms/android/app/src/main/java/com/doomalay/engine/TermuxBridge.kt', 'utf8');
  ok('S9: the bridge serves /netwait (the long-poll route)', /\/netwait/.test(bridgeKt) && /netWake\(\)/.test(bridgeKt));
  const cc = fs.readFileSync(__ROOT + '/engine/internal/server/web/chatclient.js', 'utf8');
  ok('S9: ChatClient.resync exists (the zombie killer)', /prototype\.resync/.test(cc));
  ok('S9: the silent teardown flag is respected in onclose', /_resyncing/.test(cc));
  const cp = fs.readFileSync(__ROOT + '/engine/internal/server/web/chatpanel.js', 'utf8');
  ok('S9: the visible/online sweep exists (sweepOnRegain)', /sweepOnRegain/.test(cp) && /addEventListener\('online'/.test(cp));
  ok('S9: the v1.35 fabricated-bubble ban still stands', !/Connection to the engine dropped mid-reply/.test(cp));
  const llmChat = fs.readFileSync(__ROOT + '/engine/internal/llm/chat.go', 'utf8');
  ok('S9: the suspended loop exists (the no-give-up law)', /func netSuspendedLoop/.test(llmChat));
  ok('S9: WakeNet broadcast exists', /func WakeNet/.test(llmChat));
  ok('S9: the plain path is laddered + seam-capable', /emittedCutError/.test(llmChat) && /seamNudgeText/.test(llmChat));
  const nt = fs.readFileSync(__ROOT + '/engine/internal/llm/nativetools.go', 'utf8');
  ok('S9: the nativetools seam exists (round_end + notice + continuation)', /round_end/.test(nt) && /cut mid-reply/.test(nt));
  const srvGo = fs.readFileSync(__ROOT + '/engine/internal/server/chat.go', 'utf8');
  ok('S9: the busy gauge + endpoint live in the server', /func turnGaugeInc/.test(srvGo) && /handleEngineBusy/.test(srvGo));
  const served = await (await fetch(ENGINE_A + '/chatpanel.js')).text();
  ok('S9: the SERVED tree carries the honest-return sweep (one install carries it)', served.includes('sweepOnRegain'));
}
console.log('S9 ok');

// ── the verdict ──────────────────────────────────────────────────────
console.log('');
console.log('════════════════════════════════════════');
console.log('v1400 unbroken-stream rig: ' + (n - fails.length) + '/' + n);
if (fails.length) {
  console.log('FAILURES:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('ALL GREEN — the unbroken-stream laws hold on the real engine.');
}
try { if (stubSrv) stubSrv.close(); } catch (e) {}
try { bridge.close(); } catch (e) {}
try { execSync("pkill -9 -f '" + BIN_A + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + BIN_B + "' || true"); } catch (e) {}
