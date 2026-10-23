#!/usr/bin/env bun
// v1.71.0 THE HONEST RECONCILE — the replay conviction rig.
//
// THE USER'S CONVICTION (the device export "doomalay-sky-6adbbb21", the
// opencode pocket bridge on the real phone): "we have major tooling issues,
// a lot of tools never finish the output" — the export's own ledger: 14
// logical tool calls but 93 tool events in the log, every prior turn's
// tool_use/tool_result pair REPLAYED into each new turn (the event table
// grows quadratically; the UI drowns in "Tool execution interrupted"
// pills), plus the oc_stalled death loop (the stall conviction interrupts
// but NEVER recycles the serve session — the wedged bash state survives,
// the auto-retry hits the same zombie: `git log` answers, then `ls -d */`
// never returns).
//
// THE RIG drives the REAL engine binary against a fake opencode 2.1.2
// serve that speaks the live-captured wire shapes, across the four
// transcript shapes that matter:
//
//   LEG A — THE REPLAY CONVICTION: a stalled tool turn whose interrupt
//           writes NO idle marker (the pocket shape), then two healthy
//           turns — each healthy turn's probe tick must NOT re-emit the
//           PRIOR turns' tool pills. The broken build replays them (the
//           exact device signature).
//   LEG B — THE IDLE BELT: the same stall shape but the interrupt DOES
//           write the idle marker — no replay on any build (the trim's
//           working shape must keep working).
//   LEG C — THE STALL RECYCLE: the oc_stalled conviction must DELETE the
//           wedged serve session (the bash zombie dies with it) and the
//           next turn must ride a FRESH serve session id — the broken
//           build reuses the same session (the death loop).
//   LEG D — THE TURN ANCHOR: no stall at all — turns that complete but
//           whose transcript carries NO idle rows (a serve that omits
//           them): a healthy turn must never re-emit a PRIOR turn's
//           completed tool result. Only the time-anchored window passes.
//
// Honesty law: every assertion binds to the engine's own WS event stream
// and the fake serve's observed state — no invented intermediaries.

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8690;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = process.env.V1710_BIN || '/tmp/v1710-engine';
const DATA = '/tmp/v1710-data';
const HOME = '/tmp/v1710-home';
const FAKE_SERVE = '/tmp/v1710-fake-opencode';
const MODE_FILE = '/tmp/v1710-serve-mode';
const CATALOG_FILE = '/tmp/v1710-serve-catalog.json';
const STATE_FILE = '/tmp/v1710-fake-state.ndjson';

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 500) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tC = (v) => JSON.stringify(v).slice(0, 400);

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ── the fake opencode 2.1.2 serve (the Manager's own endpoint map) ────────
// MODE rides a control file the rig flips between legs. Every observable
// (session birth, turn prompt, tool id, interrupt, delete) lands in the
// STATE_FILE so the rig's assertions bind to what the ENGINE actually did.
const fakeServeSrc = `
'use strict';
import http from 'node:http';
import fs from 'node:fs';
const MODE_FILE = ${JSON.stringify(MODE_FILE)};
const CATALOG_FILE = ${JSON.stringify(CATALOG_FILE)};
const STATE_FILE = ${JSON.stringify(STATE_FILE)};
const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i++) { if (args[i] === '--port') port = parseInt(args[i+1] || '0', 10); }
const mode = () => { try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch (e) { return 'quick'; } };
const note = (t, obj) => { try { fs.appendFileSync(STATE_FILE, JSON.stringify({ t, ...obj, at: Date.now() }) + '\\n'); } catch (e) {} };
let seq = 1;
const sessions = {};   // id → {transcript, clients:Set, jobs:[], turnCount, toolIDs:[]}
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
  s.toolIDs.push(toolID);
  const md = mode();
  note('turn', { session: sid, turn: s.turnCount, toolID, mode: md });
  s.transcript.push({ type: 'user', text: 'go', time: { created: now } });
  const writeIdle = (outcome, err) => {
    if (md === 'slowturn-noidle' || md === 'stall-noidle') return; // the pocket shape: no idle row rides
    s.transcript.push({ type: 'idle', outcome, ...(err ? { error: err } : {}), time: { created: Date.now() } });
  };
  if (md === 'stall-noidle' || md === 'stall-idle') {
    // THE DEVICE SHAPE: the tool fires live (input + one progress line),
    // then NEVER returns — the transcript holds the RUNNING part.
    broadcast({ type: 'session.tool.input.started', data: { sessionID: sid, id: toolID, name: 'bash' } });
    broadcast({ type: 'session.tool.input.ended', data: { sessionID: sid, id: toolID, text: JSON.stringify({ command: 'grep -ril orbit /data --exclude-dir=node_modules | head -40' }) } });
    broadcast({ type: 'session.tool.progress', data: { sessionID: sid, id: toolID, metadata: { message: 'running…' } } });
    s.transcript.push({ type: 'assistant', content: [ { type: 'tool', id: toolID, name: 'bash', time: { created: now }, state: { status: 'running', input: { command: 'grep -ril orbit' }, content: [] } } ], time: { created: now } });
    return;
  }
  if (md === 'slowturn' || md === 'slowturn-noidle') {
    // THE POST-STALL TURN: the model's own tool runs ~2.6s (quiet — the
    // probe ticks mid-tool), completes live, then the answer + the idle.
    broadcast({ type: 'session.tool.input.started', data: { sessionID: sid, id: toolID, name: 'bash' } });
    broadcast({ type: 'session.tool.input.ended', data: { sessionID: sid, id: toolID, text: JSON.stringify({ command: 'echo post-stall-' + s.turnCount }) } });
    setTimeout(() => {
      s.transcript.push({ type: 'assistant', content: [ { type: 'tool', id: toolID, name: 'bash', time: { created: Date.now() }, state: { status: 'completed', input: { command: 'echo post-stall-' + s.turnCount }, content: [ { type: 'text', text: 'post-stall-' + s.turnCount } ] } } ], time: { created: Date.now() } });
      broadcast({ type: 'session.tool.success', data: { sessionID: sid, id: toolID, content: [ { type: 'text', text: 'post-stall-' + s.turnCount } ] } });
      setTimeout(() => {
        broadcast({ type: 'session.text.delta', data: { sessionID: sid, delta: 'answer ' + s.turnCount } });
        s.transcript.push({ type: 'assistant', text: 'answer ' + s.turnCount, time: { created: Date.now() } });
        writeIdle('succeeded');
        broadcast({ type: 'session.execution.succeeded', data: { sessionID: sid } });
      }, 500);
    }, 2600);
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
      sessions[id] = { id, transcript: [], clients: new Set(), jobs: [], turnCount: 0, toolIDs: [] };
      note('create', { session: id });
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
        // an in-flight tool (a running tool part as the newest) is interrupted —
        // the pocket truth: the part goes error with the serve's own text; the
        // idle marker rides ONLY in the -idle shapes (the belt legs)
        const newest = s.transcript[s.transcript.length - 1];
        const hasRunning = newest && newest.type === 'assistant' && newest.content && newest.content.some((c) => c.type === 'tool' && c.state && c.state.status === 'running');
        if (hasRunning) {
          for (const c of newest.content) { if (c.type === 'tool' && c.state && c.state.status === 'running') { c.state.status = 'error'; c.state.error = { type: 'aborted', message: 'Tool execution interrupted' }; } }
          if (mode() === 'stall-idle') {
            s.transcript.push({ type: 'idle', outcome: 'interrupted', error: { type: 'interrupted', message: 'interrupted by the engine' }, time: { created: Date.now() } });
          }
          did = true;
        }
        note('interrupt', { session: s.id, did });
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ interrupted: did }));
      return;
    }
    m = p.match(/^\\/api\\/session\\/([^/]+)$/);
    if (m && req.method === 'DELETE') { note('delete', { session: m[1] }); delete sessions[m[1]]; res.writeHead(204); res.end(); return; }
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
      for (const s of Object.values(sessions)) s.clients.add(res);
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
try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}

const readState = () => {
  try { return fs.readFileSync(STATE_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
};

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
      HOME,
      DOOMALAY_OC_SILENCE_PROBE_MS: '1000',
      DOOMALAY_OC_STALL_CEILING_MS: '8000',
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
}

// ONE turn over the engine's own WS, collecting every event (ownTurn
// gating — only THIS turn's status counts; replayed history rows never
// finish the collection early).
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
            setTimeout(finish, 700);
          }
        }
      } catch (e) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => finish();
  });
}

async function main() {
  console.log('═ v1.71 THE HONEST RECONCILE — the replay conviction rig');
  if (!fs.existsSync(BIN)) { console.log('  \u2717 no binary at ' + BIN + ' (build it or set V1710_BIN)'); process.exit(1); }
  const keyIdx = process.argv.indexOf('--keep'); // optional: keep the engine alive for inspection
  bootEngine('/tmp/v1710-engine.log');
  ok('the engine boots', await waitBoot());

  // the catalog: a REAL free opencode model name from the live registry
  // feeds the engine's slot gate (the same pattern as the v1670 rig)
  let freeA = '';
  for (let i = 0; i < 45 && !freeA; i++) {
    await sleep(1000);
    try {
      const ms = await api('GET', '/api/models');
      const flat = JSON.stringify(ms.body || {});
      for (const cand of ['glm-5.3-flash-free', 'minimax-m3.1-flash-free', 'nemotron-3.5-lightning-free', 'flint-40b-free', 'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'beam-free']) {
        if (flat.indexOf(cand) >= 0) { freeA = cand; break; }
      }
    } catch (e) {}
  }
  ok('a FREE opencode model resolves from the live registry (' + freeA + ')', !!freeA);
  if (!freeA) freeA = 'stub-free-a';
  fs.writeFileSync(CATALOG_FILE, JSON.stringify([
    { id: freeA, providerID: 'opencode', capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] },
  ]));

  const kr = await api('POST', '/api/keys', { provider: 'opencode', env_var: 'OPENCODE_ZEN_API_KEY', key: 'oc_sk_fake_rig_key' });
  ok('the opencode key installs', kr.status < 300, JSON.stringify(kr.body).slice(0, 200));

  // the tool_use events for a set of call IDs inside ONE turn's stream
  const toolEventsFor = (turn, ids) => turn.events.filter((e) => (e.type === 'tool_use' || e.type === 'tool_result') && ids.includes(String(e.tool_use_id || e.toolUseId || '')));
  const stateAfter = async () => { await sleep(300); return readState(); };

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG A — THE REPLAY CONVICTION (the pocket shape: a stalled tool, no idle marker, then healthy turns)');
  try { fs.writeFileSync(MODE_FILE, 'stall-noidle'); } catch (e) {}
  const csA = await api('POST', '/api/sessions', { title: 'rig replay A', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidA = csA.body && csA.body.ID;
  ok('the chat A creates', !!sidA, JSON.stringify(csA.body).slice(0, 200));
  const tA1 = await wsTurn(sidA, 'run the stalled command', 60000);
  ok('the stalled turn dies at the ceiling (oc_stalled, never an eternal wait)', tA1.events.some((e) => e.type === 'error' && /stalled/i.test(String(e.message || e.error || ''))), tC(tA1.events.filter((e) => e.type === 'error')));
  ok('the stalled pill closes honestly', tA1.events.some((e) => e.type === 'tool_result' && /never returned/i.test(String(e.text || ''))), tC(tA1.events.filter((e) => e.type === 'tool_result')));
  const stA = await stateAfter();
  const sesA1 = stA.filter((r) => r.t === 'turn' && r.mode === 'stall-noidle').pop();
  ok('the fake serve saw the stalled turn', !!sesA1, tC(stA.slice(-4)));
  const toolA1 = sesA1 && sesA1.toolID;

  // turn 2 — healthy, quiet mid-tool (the probe ticks): the replay window
  try { fs.writeFileSync(MODE_FILE, 'slowturn'); } catch (e) {}
  const tA2 = await wsTurn(sidA, 'do the next thing', 60000);
  ok('turn 2 completes idle (the lock released)', !tA2.timeout && tA2.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tA2.timeout);
  const replay2 = toolEventsFor(tA2, [toolA1]);
  ok('THE REPLAY IS DEAD: turn 2 re-emits NO tool event for the stalled turn\\u2019s call', replay2.length === 0, tC(replay2));

  // turn 3 — the same assertion against BOTH prior tool ids
  const stA2 = await stateAfter();
  const sesA2 = stA2.filter((r) => r.t === 'turn' && r.mode === 'slowturn').pop();
  const toolA2 = sesA2 && sesA2.toolID;
  const tA3 = await wsTurn(sidA, 'and one more', 60000);
  ok('turn 3 completes idle', !tA3.timeout && tA3.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tA3.timeout);
  const replay3 = toolEventsFor(tA3, [toolA1, toolA2].filter(Boolean));
  ok('THE REPLAY IS DEAD: turn 3 re-emits NO tool event for ANY prior turn\\u2019s call', replay3.length === 0, tC(replay3));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG B — THE IDLE BELT (the interrupt writes the idle marker — the trim\\u2019s working shape keeps working)');
  try { fs.writeFileSync(MODE_FILE, 'stall-idle'); } catch (e) {}
  const csB = await api('POST', '/api/sessions', { title: 'rig replay B', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidB = csB.body && csB.body.ID;
  const tB1 = await wsTurn(sidB, 'run the stalled command again', 60000);
  ok('the stalled turn (idle-writing shape) dies at the ceiling', tB1.events.some((e) => e.type === 'error' && /stalled/i.test(String(e.message || e.error || ''))), tC(tB1.events.filter((e) => e.type === 'error')));
  const stB = await stateAfter();
  const sesB1 = stB.filter((r) => r.t === 'turn' && r.mode === 'stall-idle').pop();
  const toolB1 = sesB1 && sesB1.toolID;
  try { fs.writeFileSync(MODE_FILE, 'slowturn'); } catch (e) {}
  const tB2 = await wsTurn(sidB, 'healthy again', 60000);
  ok('the follow-up completes idle', !tB2.timeout && tB2.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tB2.timeout);
  ok('no replay of the interrupted call (the idle belt holds)', toolEventsFor(tB2, [toolB1]).length === 0, tC(toolEventsFor(tB2, [toolB1])));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG C — THE STALL RECYCLE (the wedged serve session dies with the conviction)');
  try { fs.writeFileSync(MODE_FILE, 'stall-noidle'); } catch (e) {}
  const csC = await api('POST', '/api/sessions', { title: 'rig recycle', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidC = csC.body && csC.body.ID;
  const tC1 = await wsTurn(sidC, 'wedge the bridge', 60000);
  ok('the wedged turn convicts', tC1.events.some((e) => e.type === 'error' && /stalled/i.test(String(e.message || e.error || ''))), tC(tC1.events.filter((e) => e.type === 'error')));
  const stC1 = await stateAfter();
  const sesC1 = stC1.filter((r) => r.t === 'turn' && r.mode === 'stall-noidle' && r.session !== sesA1?.session).pop();
  const wedged = sesC1 && sesC1.session;
  const stalledErr = tC1.events.find((e) => e.type === 'error' && /stalled/i.test(String(e.message || e.error || '')));
  ok('the conviction\\u2019s message names the fresh session (the honest notice)', !!stalledErr && /fresh/i.test(String(stalledErr.message || '')), String(stalledErr && stalledErr.message).slice(0, 300));
  try { fs.writeFileSync(MODE_FILE, 'quick'); } catch (e) {}
  const tC2 = await wsTurn(sidC, 'a quick follow-up on a clean session', 60000);
  ok('the follow-up completes idle', !tC2.timeout && tC2.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tC2.timeout);
  const stC2 = await stateAfter();
  const deleted = wedged ? stC2.some((r) => r.t === 'delete' && r.session === wedged) : false;
  ok('THE WEDGED SERVE SESSION IS DELETED (the bash zombie dies with it)', deleted, tC(stC2.filter((r) => r.t === 'delete' || r.t === 'create')));
  const sesC2 = stC2.filter((r) => r.t === 'turn' && r.mode === 'quick').pop();
  ok('the follow-up rides a FRESH serve session id', !!(sesC2 && wedged && sesC2.session !== wedged), 'turn1=' + wedged + ' turn2=' + (sesC2 && sesC2.session));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG D — THE TURN ANCHOR (no stall at all: completed turns, a transcript with NO idle rows)');
  try { fs.writeFileSync(MODE_FILE, 'slowturn-noidle'); } catch (e) {}
  const csD = await api('POST', '/api/sessions', { title: 'rig anchor', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + freeA });
  const sidD = csD.body && csD.body.ID;
  const tD1 = await wsTurn(sidD, 'first healthy turn', 60000);
  ok('the anchor turn 1 completes idle', !tD1.timeout && tD1.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tD1.timeout);
  const stD = await stateAfter();
  const sesD1 = stD.filter((r) => r.t === 'turn' && r.mode === 'slowturn-noidle' && r.session !== sesA1?.session && r.session !== sesB1?.session && r.session !== wedged).pop();
  const toolD1 = sesD1 && sesD1.toolID;
  const tD2 = await wsTurn(sidD, 'second healthy turn', 60000);
  ok('the anchor turn 2 completes idle', !tD2.timeout && tD2.events.some((e) => e.type === 'status' && e.state === 'idle'), 'timeout=' + tD2.timeout);
  ok('THE TURN ANCHOR HOLDS: turn 2 re-emits NO tool event for turn 1\\u2019s completed call (no idle rows anywhere)', toolEventsFor(tD2, [toolD1]).length === 0, tC(toolEventsFor(tD2, [toolD1])));

  if (keyIdx > 0) { console.log('\n(—keep: the engine + fake serve stay up for inspection)'); }
  else killAll();
  console.log('\n═ VERDICT: ' + (n - fails.length) + '/' + n + (fails.length ? ' — FAILURES: ' + fails.join(' | ') : ' — ALL GREEN'));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('RIG BLEW UP', e); killAll(); process.exit(2); });
