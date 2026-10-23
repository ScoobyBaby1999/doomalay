#!/usr/bin/env node
// v1670-patient-canvas-rig.mjs — v1.67 THE PATIENT CANVAS, the LIVE proof
// against the REAL engine binary + a FAKE opencode 2.x serve (the exact API
// surface the Manager speaks — the endpoint map from ocserve.go) + a fake
// OpenRouter provider for the SSE-error-frame leg. The legs:
//
//   LEG A — THE STUCK TURN (the interrupt hand): a serve whose tool NEVER
//           returns (the user's complex multi-pipe command hung in termux)
//           → the STALL CEILING fires → the interrupt POSTs → every pending
//           pill closes honestly → the terminal lands → THE SAME CHAT
//           accepts a new prompt (the lock released — "a new chat works"
//           without the new chat).
//
//   LEG B — THE LOST RESULT (the unlost mid-turn): a serve that emits the
//           tool_use LIVE, kills every SSE connection in the gap, completes
//           the tool ONLY in the durable transcript, then answers on the
//           reconnected feed → the MID-TURN RECONCILE re-emits the missed
//           result → the pill closes → the answer lands.
//
//   LEG C — THE LOUD 429 (three arms): (1) a provider that answers 200 then
//           a mid-stream SSE error frame {"error":{"code":429}} → the error
//           surfaces WITH retry_class → the sentinel arms → the pill ladder
//           on the WS; (2) the oc_free_walled shape (the wall walk
//           exhausted) arms the sentinel too; (3) the error TEXT carries the
//           auto-retry line.
//
//   LEG D — THE FROZEN STARS + THE FINITE PLATE: atoms.js's tempo law (the
//           exponential band, the freeze, the cadence), the pixi parity,
//           the dial without the ∞ rung, the saved-0 migration — pinned
//           against the REAL sources + the REAL math.
//
// Honesty law: every assertion binds to the tool's own frames — no
// inference from side effects.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8670;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1670-engine';
const DATA = '/tmp/v1670-data';
const HOME = '/tmp/v1670-home';
const FAKE_SERVE = '/tmp/v1670-fake-opencode';
const FAKE_PROV_PORT = 8671;
const MODE_FILE = '/tmp/v1670-serve-mode';
const CATALOG_FILE = '/tmp/v1670-serve-catalog.json';

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ── the fake opencode 2.x serve (the Manager's own endpoint map) ────────
// MODE rides a control file the rig flips between legs; the turn's event
// burst is CLIENT-GATED (the real serve fires events while the SSE streams
// — the fake parks each prompt's job and fires it when the engine's pump
// connects).
const fakeServeSrc = `
'use strict';
import http from 'node:http';
import fs from 'node:fs';
const MODE_FILE = ${JSON.stringify(MODE_FILE)};
const CATALOG_FILE = ${JSON.stringify(CATALOG_FILE)};
const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i++) { if (args[i] === '--port') port = parseInt(args[i+1] || '0', 10); }
const mode = () => { try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch (e) { return 'quick'; } };
let seq = 1;
const sessions = {};   // id → {transcript, clients:Set, jobs:[], pendingAnswer}
let anyClients = () => { for (const s of Object.values(sessions)) if (s.clients.size) return true; return false; };
const sse = (res, obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\\n\\n'); } catch (e) {} };
function broadcast(obj) {
  const sid = obj.data && obj.data.sessionID;
  for (const s of Object.values(sessions)) {
    if (sid && s.id !== sid) continue;
    for (const res of s.clients) sse(res, obj);
  }
}
function fireJobs() {
  if (!anyClients()) return;
  for (const s of Object.values(sessions)) {
    while (s.jobs.length && s.clients.size) { const j = s.jobs.shift(); j(); }
  }
}
function runTurn(s) {
  const sid = s.id;
  const now = Date.now();
  s.turnCount = (s.turnCount || 0) + 1;
  const toolID = 'call_' + sid + '_' + s.turnCount;
  const md = mode();
  s.transcript.push({ type: 'user', text: 'go', time: { created: now } });
  if (md === 'stuck') {
    broadcast({ type: 'session.tool.input.started', data: { sessionID: sid, id: toolID, name: 'bash' } });
    broadcast({ type: 'session.tool.input.ended', data: { sessionID: sid, id: toolID, text: JSON.stringify({ command: 'cd /data && ls -la | strings | grep -i secret | head -50' }) } });
    broadcast({ type: 'session.tool.progress', data: { sessionID: sid, id: toolID, metadata: { message: 'running…' } } });
    // the transcript holds the RUNNING tool forever — the zombie
    s.transcript.push({ type: 'assistant', content: [ { type: 'tool', id: toolID, name: 'bash', state: { status: 'running', input: { command: 'cd /data' }, content: [] } } ], time: { created: now } });
    return;
  }
  if (md === 'gap') {
    broadcast({ type: 'session.tool.input.started', data: { sessionID: sid, id: toolID, name: 'bash' } });
    broadcast({ type: 'session.tool.input.ended', data: { sessionID: sid, id: toolID, text: JSON.stringify({ command: 'echo hello-gap' }) } });
    setTimeout(() => {
      // kill every SSE connection (the volatile gap)
      for (const res2 of Array.from(s.clients)) { try { res2.destroy(); } catch (e) {} }
      s.clients.clear();
      // the tool completes OFF-WIRE (the transcript only)
      s.transcript.push({ type: 'assistant', content: [ { type: 'tool', id: toolID, name: 'bash', state: { status: 'completed', input: { command: 'echo hello-gap' }, content: [ { type: 'text', text: 'hello-gap' } ] } } ], time: { created: Date.now() } });
      s.pendingAnswer = true;
    }, 600);
    return;
  }
  if (md === 'wall') {
    s.transcript.push({ type: 'idle', outcome: 'failed', error: { type: 'provider.error', message: 'Free usage limit reached — the free tier window for this model is full right now' }, time: { created: Date.now() } });
    broadcast({ type: 'session.execution.failed', data: { sessionID: sid, error: { type: 'provider.error', message: 'Free usage limit reached — the free tier window for this model is full right now', status: 429 } } });
    return;
  }
  // quick — the immediate honest answer
  broadcast({ type: 'session.text.delta', data: { sessionID: sid, delta: 'quick answer ' + s.turnCount } });
  s.transcript.push({ type: 'assistant', text: 'quick answer ' + s.turnCount, time: { created: Date.now() } });
  s.transcript.push({ type: 'idle', outcome: 'succeeded', time: { created: Date.now() } });
  broadcast({ type: 'session.execution.succeeded', data: { sessionID: sid } });
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === '/api/provider') { res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return; }
    if (p === '/api/model') {
      let models = [];
      try { models = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch (e) {
        models = [ { id: 'stub-free-a', providerID: 'opencode', capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] } ];
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: { models } }));
      return;
    }
    if (p === '/api/session' && req.method === 'POST') {
      const id = 'ses_' + (seq++);
      sessions[id] = { id, transcript: [], clients: new Set(), jobs: [], pendingAnswer: false };
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    let m = p.match(/^\\/api\\/session\\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const s = sessions[m[1]];
      if (!s) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: { id: s.id, title: 't', directory: '/ws/' + s.id } }));
      return;
    }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/message$/);
    if (m && req.method === 'GET') {
      const s = sessions[m[1]];
      if (!s) { res.writeHead(404); res.end('{}'); return; }
      const limit = parseInt(u.searchParams.get('limit') || '50', 10);
      // newest-first wire shape (the Manager reverses to chronological)
      const rows = s.transcript.slice().reverse().slice(0, limit).map((mm, idx) => ({ ...mm, id: 'msg_' + (s.transcript.length - idx) }));
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: rows }));
      return;
    }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/model$/);
    if (m && req.method === 'POST') { res.writeHead(204); res.end(); return; }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/move$/);
    if (m && req.method === 'POST') { res.writeHead(204); res.end(); return; }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/interrupt$/);
    if (m && req.method === 'POST') {
      const s = sessions[m[1]];
      let did = false;
      if (s) {
        // an in-flight tool (a running tool part as the newest) is interrupted
        const newest = s.transcript[s.transcript.length - 1];
        const hasRunning = newest && newest.type === 'assistant' && newest.content && newest.content.some((c) => c.type === 'tool' && c.state && c.state.status === 'running');
        if (hasRunning) {
          for (const c of newest.content) { if (c.type === 'tool' && c.state && c.state.status === 'running') c.state.status = 'error'; }
          s.transcript.push({ type: 'idle', outcome: 'interrupted', error: { type: 'interrupted', message: 'interrupted by the engine' }, time: { created: Date.now() } });
          did = true;
        }
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ interrupted: did }));
      return;
    }
    m = p.match(/^\\/api\\/session\\/([^/]+)$/);
    if (m && req.method === 'DELETE') { delete sessions[m[1]]; res.writeHead(204); res.end(); return; }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/prompt$/);
    if (m && req.method === 'POST') {
      const s = sessions[m[1]];
      res.writeHead(202); res.end();
      s.jobs.push(() => runTurn(s));
      setTimeout(fireJobs, 250);
      return;
    }
    if (p === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, { type: 'server.connected', data: {} });
      const hb = setInterval(() => { try { res.write(': heartbeat\\n\\n'); } catch (e) {} }, 2000);
      res.on('close', () => { clearInterval(hb); for (const s of Object.values(sessions)) s.clients.delete(res); });
      for (const s of Object.values(sessions)) {
        s.clients.add(res);
        if (s.pendingAnswer) {
          // LEG B: a RECONNECTED client releases the parked answer
          s.pendingAnswer = false;
          setTimeout(() => {
            broadcast({ type: 'session.text.delta', data: { sessionID: s.id, delta: 'the answer after the gap' } });
            s.transcript.push({ type: 'assistant', text: 'the answer after the gap', time: { created: Date.now() } });
            s.transcript.push({ type: 'idle', outcome: 'succeeded', time: { created: Date.now() } });
            broadcast({ type: 'session.execution.succeeded', data: { sessionID: s.id } });
          }, 400);
        }
      }
      setTimeout(fireJobs, 150);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
server.listen(port, '127.0.0.1', () => console.log('FAKE SERVE on ' + port));
`;
fs.writeFileSync(FAKE_SERVE + '.mjs', fakeServeSrc);
fs.writeFileSync(FAKE_SERVE, '#!/bin/sh\nexec node ' + FAKE_SERVE + '.mjs "$@"\n');
fs.chmodSync(FAKE_SERVE, 0o755);
try { fs.writeFileSync(MODE_FILE, 'quick'); } catch (e) {}

// ── the fake OpenRouter: 200 then a mid-stream 429 error frame ─────────
const provSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-429-model' }] }));
      return;
    }
    if (u.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'par' } }] }) + '\n\n');
      setTimeout(() => {
        // THE MID-STREAM ERROR FRAME (OpenRouter's free-model kill shape)
        res.write('data: ' + JSON.stringify({ error: { code: 429, message: 'Provider returned error: upstream rate limit exceeded' } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 120);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

// ── the engine ──────────────────────────────────────────────────────────
let child = null;
function bootEngine(logPath) {
  execSync(`rm -rf ${DATA} ${HOME} && mkdir -p ${DATA} ${HOME}`);
  const log = fs.openSync(logPath, 'a');
  child = spawn(BIN, ['--port', String(PORT), '--bind', '127.0.0.1', '--data-dir', DATA], {
    detached: true, stdio: ['ignore', log, log],
    env: {
      ...process.env,
      DOOMALAY_OTA_DISABLE: '1',
      DOOMALAY_OPENCODE_BIN: FAKE_SERVE,
      DOOMALAY_BASE_URL_OPENROUTER: 'http://127.0.0.1:' + FAKE_PROV_PORT,
      HOME,
      DOOMALAY_OC_SILENCE_PROBE_MS: '1200',
      DOOMALAY_OC_STALL_CEILING_MS: '9000',
      DOOMALAY_SENTINEL_QUOTA_S: '4',
    },
  });
  child.unref();
}
async function waitBoot() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
function killAll() {
  try { execSync(`pkill -9 -f '${BIN}' || true`); } catch (e) {}
  try { execSync(`pkill -9 -f '${FAKE_SERVE}.mjs' || true`); } catch (e) {}
  try { child && child.kill('SIGKILL'); } catch (e) {}
  try { provSrv.close(); } catch (e) {}
}

// ONE turn over the engine's own WS, collecting every event. The replay's
// historic terminals never finish the collection early (ownTurn gating —
// only THIS turn's status counts).
function wsTurn(sid, text, timeoutMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const events = [];
    let assistant = '';
    let own = false;
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (e) {} resolve({ timeout: false, events, assistant }); };
    const t = setTimeout(() => { if (settled) return; settled = true; try { ws.close(); } catch (e) {} resolve({ timeout: true, events, assistant }); }, timeoutMs || 90000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid }));
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.type === 'user' && String(ev.text || '') === text) own = true;
        if (own) {
          events.push(ev);
          if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
          if (ev.type === 'assistant' && ev.text) assistant = ev.text;
          if (ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) {
            setTimeout(finish, 500);
          }
        }
      } catch (e) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => finish();
  });
}

async function main() {
  console.log('═ v1.67 THE PATIENT CANVAS — the rig');
  execSync(`cd ${__ROOT}/engine && ${process.env.GORUN || 'go'} build -o ${BIN} ./cmd/doomalay`, { stdio: 'inherit' });
  await new Promise((r) => provSrv.listen(FAKE_PROV_PORT, '127.0.0.1', r));
  bootEngine('/tmp/v1670-engine.log');
  ok('the engine boots', await waitBoot());

  // the catalog: two REAL free opencode models (the registry's own cost-0
  // truth — the same pattern as the v1590 live rig) feed BOTH the engine's
  // slot gate and the fake serve's walk roster
  let freeA = '', freeB = '';
  for (let i = 0; i < 45 && !freeA; i++) {
    await sleep(1000);
    try {
      const ms = await api('GET', '/api/models');
      const flat = JSON.stringify(ms.body || {});
      for (const cand of ['glm-5.3-flash-free', 'minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free', 'flint-40b-free', 'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'beam-free']) {
        if (flat.indexOf(cand) >= 0) { if (!freeA) freeA = cand; else if (!freeB && cand !== freeA) { freeB = cand; break; } }
      }
    } catch (e) {}
  }
  ok('FREE opencode models resolve from the live registry (' + freeA + ' + ' + freeB + ')', !!freeA);
  if (!freeB) freeB = freeA; // a single-model roster: the walk answers the terminal on attempt 2
  fs.writeFileSync(CATALOG_FILE, JSON.stringify([
    { id: freeA, providerID: 'opencode', capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] },
    { id: freeB, providerID: 'opencode', capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] },
  ]));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG A — the stuck turn (the interrupt hand)');
  try { fs.writeFileSync(MODE_FILE, 'stuck'); } catch (e) {}
  const kr = await api('POST', '/api/keys', { provider: 'opencode', env_var: 'OPENCODE_ZEN_API_KEY', key: 'oc_sk_fake_rig_key' });
  ok('the opencode key installs', kr.status < 300, JSON.stringify(kr.body).slice(0, 200));
  const cs = await api('POST', '/api/sessions', { title: 'rig stuck', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidA = cs.body && cs.body.ID;
  ok('the opencode chat creates', !!sidA, JSON.stringify(cs.body).slice(0, 200));

  const tA = await wsTurn(sidA, 'run the complex command', 90000);
  const evA = tA.events.map((e) => e.type);
  ok('the stuck turn terminal lands (no eternal wait)', evA.includes('status') && tA.events.some((e) => e.type === 'status' && e.state === 'error'), evA.join(','));
  const pillClose = tA.events.find((e) => e.type === 'tool_result' && /never returned|cancelled/i.test(String(e.text || '')));
  ok('the pending pill closes honestly (the command never returned)', !!pillClose, JSON.stringify(tA.events.filter((e) => e.type === 'tool_result')).slice(0, 300));
  const stalledErr = tA.events.find((e) => e.type === 'error' && /stalled/i.test(String(e.message || e.error || '')));
  ok('the stall conviction answers the honest error', !!stalledErr, JSON.stringify(tC(tA.events.filter((e) => e.type === 'error'))).slice(0, 300));
  // the same chat accepts a NEW prompt (the lock released) — flip to quick
  try { fs.writeFileSync(MODE_FILE, 'quick'); } catch (e) {}
  const tA2 = await wsTurn(sidA, 'a quick follow-up', 60000);
  ok('THE SAME CHAT accepts a new prompt (the lock released — no new chat needed)', !tA2.timeout && tA2.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tA2.timeout + ' ' + tC(tA2.events.map((e) => e.type)));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG B — the lost result (the unlost mid-turn)');
  try { fs.writeFileSync(MODE_FILE, 'gap'); } catch (e) {}
  const csB = await api('POST', '/api/sessions', { title: 'rig gap', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidB = csB.body && csB.body.ID;
  ok('the gap chat creates', !!sidB, JSON.stringify(csB.body).slice(0, 200));
  const tB = await wsTurn(sidB, 'run the gap command', 90000);
  const resB = tB.events.find((e) => e.type === 'tool_result' && /hello-gap/.test(String(e.text || '')));
  ok('the MISSED result re-emits from the durable record (the pill closes)', !!resB, tC(tB.events.map((e) => e.type + (e.text ? ':' + String(e.text).slice(0, 24) : ''))));
  ok('the answer after the gap lands', /the answer after the gap/.test(tB.assistant), JSON.stringify(tB.assistant).slice(0, 200));
  ok('the turn completes idle', tB.events.some((e) => e.type === 'status' && e.state === 'idle'), tC(tB.events.map((e) => e.type)));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG C — the loud 429');
  // (1) the mid-stream SSE error frame arms the sentinel
  const kor = await api('POST', '/api/keys', { provider: 'openrouter', env_var: 'OPENROUTER_API_KEY', key: 'sk-rig-fake' });
  ok('the fake-openrouter key installs', kor.status < 300, JSON.stringify(kor.body).slice(0, 200));
  const csC = await api('POST', '/api/sessions', { title: 'rig 429 frame', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/stub-429-model' });
  const sidC = csC.body && csC.body.ID;
  ok('the 429-frame chat creates', !!sidC, JSON.stringify(csC.body).slice(0, 200));
  const tC1 = await wsTurn(sidC, 'provoke the frame', 60000);
  const errC = tC1.events.find((e) => e.type === 'error');
  ok('the mid-stream error frame SURFACES (never the silent empty shell)', !!errC, tC(tC1.events.map((e) => e.type)));
  ok('the error carries the machine class (the sentinel arms)', !!(errC && errC.retry_class === '429'), String(JSON.stringify(errC)).slice(0, 300));
  const pillC = tC1.events.find((e) => e.type === 'retry' && (e.phase === 'armed' || e.phase === 'probe' || e.phase === 'recovered'));
  ok('THE RETRY PILL SHOWS (the chat joined the timer)', !!pillC, tC(tC1.events.filter((e) => e.type === 'retry')));

  // (2) the oc_free_walled shape arms the sentinel
  try { fs.writeFileSync(MODE_FILE, 'wall'); } catch (e) {}
  const csD = await api('POST', '/api/sessions', { title: 'rig wall', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidD = csD.body && csD.body.ID;
  const tD = await wsTurn(sidD, 'hit the wall', 90000);
  const errD = tD.events.find((e) => e.type === 'error' && String(e.error || '').includes('oc_free_walled'));
  ok('the wall-walk exhaustion answers the honest terminal', !!errD, tC(tD.events.filter((e) => e.type === 'error')));
  ok('the wall ARMS the sentinel (retry_class rides)', !!(errD && errD.retry_class === '429' && errD.retry_provider === 'opencode'), String(JSON.stringify(errD)).slice(0, 300));
  const armD = tD.events.find((e) => e.type === 'retry' && (e.phase === 'armed' || e.phase === 'probe'));
  ok('the wall\'s retry pill lands', !!armD, tC(tD.events.filter((e) => e.type === 'retry')));
  const armPing = tD.events.find((e) => e.type === 'progress' && /auto-retry timer is armed/i.test(String(e.message || e.text || '')));
  ok('the arm rides the visible progress line (never an unexplained wait)', !!armPing, tC(tD.events.filter((e) => e.type === 'progress')));

  // (3) the PWA error text names the auto-retry (source pin)
  const panelSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/chatpanel.js'), 'utf8');
  ok('the PWA error bubble names the auto-retry (the source law)', /auto-retry armed/.test(panelSrc) && panelSrc.indexOf('retryClassLabel(String(src.retry_class)') > 0);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG D — the frozen stars + the finite plate');
  const atomsSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/atoms.js'), 'utf8');
  ok('THE ZOOM TEMPO LAW lives in AtomCore', /starTempoFactor/.test(atomsSrc) && /TEMPO_FREEZE_SCALE/.test(atomsSrc));
  ok('the exponential band + the freeze threshold (0.75 → 0.45)', /TEMPO_FULL_SCALE = 0\.75/.test(atomsSrc) && /TEMPO_FREEZE_SCALE = 0\.45/.test(atomsSrc));
  ok('the base orbit is much slower (MOTION_TEMPO 0.25)', /MOTION_TEMPO = 0\.25/.test(atomsSrc));
  ok('paintCore rides the tempo factor (both hosts freeze)', /t \* MOTION_TEMPO \* starTempoFactor\(scale\)/.test(atomsSrc));
  const appSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/app.js'), 'utf8');
  ok('THE CADENCE LAW gates the atom-only frame', /starFrameCadenceMS/.test(appSrc) && /lastAtomFrameAt/.test(appSrc));
  ok('THE FREEZE parks ambientActive (zero frames at far zoom)', appSrc.indexOf('starTempoFactor(scale) > 0') > 0);
  const pixiSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/pixiworld.js'), 'utf8');
  ok('the pixi layer rides the same law (the quantized star clock)', /starTempoFactor\(sc\)/.test(pixiSrc) && /lastStarStepMs/.test(pixiSrc));
  const appearSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/appearance.js'), 'utf8');
  ok('the dial has NO infinite rung', !/Off — infinite/.test(appearSrc) && /128k — endless/.test(appearSrc));
  ok('the sanctioned ladder is 8k→128k (0 is dead)', /\[8192, 16384, 32768, 65536, 131072\]/.test(appSrc));
  const settingsSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/settings.js'), 'utf8');
  ok('a saved 0 migrates to the finite default once', /worldSizeV167/.test(settingsSrc));

  // the tempo math itself, headless (the worker-host shape: self-global)
  const self = {};
  const fn = new Function('self', 'globalThis', 'performance', atomsSrc + '\n;return self.AtomCore;');
  const AC = fn(self, self, { now: () => 0 });
  const tempoOK = AC.starTempoFactor(1) === 1 && AC.starTempoFactor(0.75) === 1 && AC.starTempoFactor(0.45) === 0 &&
                  AC.starTempoFactor(0.3) === 0 && AC.starTempoFactor(0.6) < 0.35 && AC.starTempoFactor(0.6) > 0.05;
  ok('the tempo math: full at ≥0.75, exponential mid-band, frozen at ≤0.45', tempoOK,
    'f(1)=' + AC.starTempoFactor(1) + ' f(0.75)=' + AC.starTempoFactor(0.75) + ' f(0.6)=' + AC.starTempoFactor(0.6) + ' f(0.45)=' + AC.starTempoFactor(0.45));
  const cadOK = AC.starFrameCadenceMS(1) === 33 && AC.starFrameCadenceMS(0.1) >= 250 && AC.starFrameCadenceMS(0.5) > 33;
  ok('the cadence math: 30fps full, ≤4fps in the slow band', cadOK,
    'c(1)=' + AC.starFrameCadenceMS(1) + ' c(0.5)=' + AC.starFrameCadenceMS(0.5) + ' c(0.1)=' + AC.starFrameCadenceMS(0.1));

  killAll();
  console.log('\n═ VERDICT: ' + (n - fails.length) + '/' + n + (fails.length ? ' — FAILURES: ' + fails.join(' | ') : ' — ALL GREEN'));
  process.exit(fails.length ? 1 : 0);
}
const tC = (v) => JSON.stringify(v).slice(0, 400);

main().catch((e) => { console.error('RIG CRASH:', e); killAll(); process.exit(1); });
