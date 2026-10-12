#!/usr/bin/env node
// v1300-opendoor-live.mjs — THE REAL-USER PROOF for v1.29.3 + v1.29.4.
//
// The user's exact Nvidia scenario, replayed against the REAL engine:
//   1. chat A sends a message; the provider (a slow stub behind the
//      nvidia base-URL override) hangs the turn.
//   2. chat A's client DIES mid-turn (the socket is destroyed — the
//      network-drop shape).
//   3. chat A's user comes back and sends again (a fresh socket):
//      BEFORE v1.29.3 this was "agent already processing" forever.
//      NOW: the open door fires — the stale turn is aborted, the lock
//      hands over, and the new turn RUNS.
//   4. the resuming client receives the engine's replay_done marker
//      after the backlog burst (v1.29.4's deterministic tag end).
'use strict';

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Node 24's BUILT-IN WebSocket (no deps — the house rigs run bare).

const ROOT = path.dirname(process.argv[1] || '');
const ENGINE_BIN = '/tmp/doomalay-verify-engine';
const ENGINE_PORT = 8731;
const STUB_PORT = 8732;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const DATA = '/tmp/v1300-opendoor-data';
const LOG = '/tmp/v1300-opendoor-engine.log';

let okCount = 0, failCount = 0;
function ok(cond, label, extra) {
  if (cond) { okCount++; console.log('  ok - ' + label); }
  else { failCount++; console.log('  FAIL - ' + label + (extra ? ' → ' + String(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stub provider (the OpenAI-compatible shape behind NVIDIA_API_KEY)
let stubCalls = 0;
function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/models')) { send(200, { data: [{ id: 'stub-model' }] }); return; }
      if (req.url.endsWith('/chat/completions')) {
        stubCalls++;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (stubCalls === 1) {
            // THE HANG: the first turn never answers (the deprovisioned
            // stream shape — the wedge that held the lock forever).
            console.log('  [stub] call 1: hanging the turn (the interrupted-turn shape)');
            return; // never respond — the engine's abort cancels its side
          }
          // every later call: an immediate SSE stream
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'recovery works' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      send(404, { error: 'nope' });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolve(srv));
  });
}

function bootEngine() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const env = {
    ...process.env,
    DOOMALAY_BASE_URL_NVIDIA: 'http://127.0.0.1:' + STUB_PORT,
  };
  const child = spawn('bash', ['-c', `nohup setsid ${ENGINE_BIN} --port ${ENGINE_PORT} --bind 127.0.0.1 --data-dir ${DATA} >> ${LOG} 2>&1 &`], { env, detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitEngine() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(ENGINE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* booting */ }
    await sleep(250);
  }
  return false;
}

function wsConnect(sessionId, since) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${sessionId}${since ? '&since=' + since : ''}`);
    const events = [];
    const waiters = [];
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(ev)) { waiters[i].res(ev); waiters.splice(i, 1); }
      }
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error'));
    (ws).events = events;
    (ws).waitFor = (pred, ms = 8000, label = 'event') => new Promise((res, rej) => {
      const hit = events.find(pred);
      if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + label)), ms);
      waiters.push({ pred, res: (ev) => { clearTimeout(t); res(ev); } });
    });
  });
}

const send = (ws, text) => ws.send(JSON.stringify({ type: 'send', message: text, session_id: (ws).sid, provider: 'nvidia', model: 'stub-model' }));

async function run() {
  const stub = await startStub();
  bootEngine();
  if (!(await waitEngine())) { console.log('FAIL - engine never came up'); process.exit(1); }
  console.log('  [engine] up (built with the v1.29.3/v1.29.4 changes)');

  // the chat's session, pointed at the (stubbed) nvidia provider
  // the vault holds provider keys (env doesn't seed it) — POST the stub key
  await fetch(ENGINE + '/api/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'nvidia', env_var: 'NVIDIA_API_KEY', key: 'nvapi-stub-' + crypto.randomBytes(6).toString('hex') }),
  });

  const cr = await fetch(ENGINE + '/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'opendoor proof', sandbox: 'quick', provider: 'nvidia', model: 'stub-model' }),
  });
  const sess = await cr.json();
  const sid = sess.ID;

  // ── chat A: turn 1 starts, then the client DIES mid-turn ────────────
  const a = await wsConnect(sid);
  (a).sid = sid;
  send(a, 'first message — the turn that gets interrupted');
  await a.waitFor((e) => e.type === 'user', 5000, 'user echo');
  console.log('  [chat A] turn 1 running — killing the client (the network drop)');
  // the built-in WebSocket has no terminate() — a hard socket kill via
  // the raw underlying close: readyState → CLOSING is close(); for the
  // NETWORK-DROP shape we want no close frame at all. Node's WebSocket
  // exposes neither abort() nor the raw socket; close() without code is
  // the honest available drop (the engine's read loop ends either way).
  a.close();
  await sleep(700); // the engine's read loop clears the pipe

  // ── chat A returns: a FRESH socket, sends again ─────────────────────
  const b = await wsConnect(sid, 3); // the user's resume shape: the client holds a seq cursor
  (b).sid = sid;
  const replayDoneSeen = b.waitFor((e) => e.type === 'ws_state' && e.state === 'replay_done', 8000, 'replay_done');
  const busy = b.events.find((e) => e.type === 'error' && /already processing/.test(e.message || ''));
  send(b, 'second message — the user comes back');
  const userEcho = await b.waitFor((e) => e.type === 'user' && /second message/.test(e.text || ''), 8000, 'second user echo');
  ok(!!userEcho && !busy, 'the second send was ACCEPTED (no busy reject)');
  let delta = null;
  try {
    delta = await b.waitFor((e) => e.type === 'assistant_delta' && /recovery works/.test(e.text || ''), 15000, 'assistant delta');
  } catch (e) {
    console.log('  [debug] events so far:', JSON.stringify(b.events, null, 1).slice(0, 2000));
    console.log('  [debug] engine log tail:', fs.readFileSync(LOG, 'utf8').split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
  ok(!!delta, 'the NEW turn ran end-to-end (the stub streamed into it)');
  const idle = await b.waitFor((e) => e.type === 'status' && e.state === 'idle', 15000, 'status idle');
  ok(!!idle, 'the turn reached its terminal (the lock is free again)');
  const rd = await replayDoneSeen.catch(() => null);
  ok(!!rd && rd.resumed === true, 'the resuming client received ws_state replay_done (resumed:true — the cursor was honored)', rd);

  const log = fs.readFileSync(LOG, 'utf8');
  ok(log.includes('open door:'), 'the engine log carries the open-door takeover line');
  ok(stubCalls === 2, 'the stub saw 2 chat calls (the hung one + the recovery)', 'calls=' + stubCalls);

  console.log('\n' + okCount + ' ok · ' + failCount + ' fail');
  stub.close();
  process.exit(failCount ? 1 : 0);
}

run().catch((e) => { console.error('rig crashed', e); process.exit(1); });
