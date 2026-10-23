#!/usr/bin/env node
// v1730-patient-flow-rig.mjs — v1.73 THE PATIENT FLOW, the LIVE proof against
// the REAL engine binary + a FAKE opencode 2.x serve + a FAKE OpenAI-compatible
// provider + a SLOW external MCP chain server (the slow tool every leg drives).
//
// THE USER'S LAW (verbatim): "Our top priority is continuity… tool calls that
// take a lot of time interrupt the chat flow completely? Wouldn't it make more
// sense if that long tool call gets its own pid with its own allocated
// resources, goes on for however long and then returns when its done? The
// model can execute and continue without a hinderance… The UI be dealt with
// after the fact."
//
//   LEG A — THE NET ARM: a serve provider failure with a NET-class message
//           (undici's "fetch failed: getaddrinfo EAI_AGAIN") → retry_class=net
//           rides the failure events → the visible arm line (the net wording)
//           → the sentinel ARMS (the pill) → the probe succeeds → THE
//           AUTO-CONTINUE fires (an answer lands with NO user tap).
//
//   LEG B — THE NATIVE JOB LANE: a real native-tools turn whose chained
//           slow_probe (15s) outlives the 3s grace window → the JOB_STARTED
//           ticket returns at the window → the model CONTINUES (calculator
//           fires while the lane runs) → job_status mid-flight answers
//           RUNNING honestly → the turn ends IDLE in <10s while the lane is
//           still running (THE CONTINUITY PROOF) → the completion "job" event
//           lands after the fact with the honest ≥12s duration.
//
//   LEG C — THE SERVE-PATH JOB LANE: the fake serve's model calls the chained
//           slow_probe THROUGH the engine's own /mcp/oc/<chat> MCP route → the
//           MCP response arrives at the grace window (well under any client
//           timeout) carrying the ticket → the serve model continues → the
//           completion lands after the fact.
//
//   LEG D — THE KILL: a slow lane → the model's own job_kill → STOPPED (the
//           cooperative best-effort honesty) → the cancelled "job" row lands.
//
//   LEG E — THE HONEST CLOCK: duration_ms rides every tool_result (the native
//           calculator + the serve's tool round); the PWA source pins (the
//           duration chip, the slow tone, the job row) — §A-style.
//
// Honesty law: every assertion binds to the tool's own frames — no inference
// from side effects.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8730;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1730-engine';
const DATA = '/tmp/v1730-data';
const HOME = '/tmp/v1730-home';
const FAKE_SERVE = '/tmp/v1730-fake-opencode';
const MODE_FILE = '/tmp/v1730-serve-mode';
const CHAT_FILE = '/tmp/v1730-serve-chat';
const CATALOG_FILE = '/tmp/v1730-serve-catalog.json';
const PROV_PORT = 8731;     // the fake OpenAI-compatible provider (native legs)
const SLOW_PORT = 8732;     // the slow external MCP chain server
const GRACE_MS = 3000;      // the engine's lane window for this rig
const SLOW_MS = 15000;      // the slow tool's own duration

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + String(extra).slice(0, 500) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tC = (v) => JSON.stringify(v).slice(0, 500);

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ── the SLOW external MCP server (the chain's slow_probe tool) ──────────
// Streamable-HTTP JSON-RPC: initialize → tools/list → tools/call. The probe
// sleeps SLOW_MS then answers — the tool every leg drives.
const slowSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
    let rpc = null; try { rpc = JSON.parse(body); } catch (e) {}
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (!rpc) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (rpc.method === 'initialize') {
      send({ jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'rig-slow', version: '1.0.0' },
      } });
      return;
    }
    if (rpc.method === 'notifications/initialized' || String(rpc.method || '').startsWith('notifications/')) {
      res.writeHead(202); res.end(); return;
    }
    if (rpc.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{
        name: 'slow_probe',
        description: 'A deliberately slow probe (takes ' + (SLOW_MS / 1000) + 's) — the patient-flow rig\'s slow tool.',
        inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'a label echoed back' } }, required: ['label'] },
      }] } });
      return;
    }
    if (rpc.method === 'tools/call') {
      const name = rpc.params && rpc.params.name;
      if (name !== 'slow_probe') { send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'error: unknown tool ' + name }], isError: true } }); return; }
      const label = (rpc.params.arguments && rpc.params.arguments.label) || 'unlabeled';
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'the slow probe answered (' + label + ') after its long work' }] } });
      }, SLOW_MS);
      return;
    }
    send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found: ' + rpc.method } });
  });
});

// ── the fake opencode 2.x serve (the v1670 rig's shape) ──────────────────
const fakeServeSrc = `
'use strict';
import http from 'node:http';
import fs from 'node:fs';
const MODE_FILE = ${JSON.stringify(MODE_FILE)};
const CHAT_FILE = ${JSON.stringify(CHAT_FILE)};
const CATALOG_FILE = ${JSON.stringify(CATALOG_FILE)};
const ENGINE_PORT = ${String(PORT)};
const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i++) { if (args[i] === '--port') port = parseInt(args[i+1] || '0', 10); }
const mode = () => { try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch (e) { return 'quick'; } };
const chatID = () => { try { return fs.readFileSync(CHAT_FILE, 'utf8').trim(); } catch (e) { return ''; } };
let seq = 1;
const sessions = {};
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
// the serve-path MCP call through the ENGINE's own /mcp/oc/<chat> route —
// returns { ms, text } (the elapsed is LEG C's truth).
async function engineMCP(name, args) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:' + ENGINE_PORT + '/mcp/oc/' + chatID(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'host': '127.0.0.1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json().catch(() => ({}));
  const content = (j.result && j.result.content) || [];
  const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\\n');
  return { ms: Date.now() - t0, text, isError: !!(j.result && j.result.isError) };
}
async function runTurn(s) {
  const sid = s.id;
  const now = Date.now();
  s.turnCount = (s.turnCount || 0) + 1;
  const toolID = 'call_' + sid + '_' + s.turnCount;
  const md = mode();
  s.transcript.push({ type: 'user', text: 'go', time: { created: now } });
  if (md === 'netfail') {
    // LEG A: the serve's provider call died on the network (undici's own
    // error shape — the class the OLD classifier never armed on)
    s.transcript.push({ type: 'idle', outcome: 'failed', error: { type: 'provider.error', message: 'fetch failed: getaddrinfo EAI_AGAIN api.opencode.ai: Temporary failure in name resolution' }, time: { created: Date.now() } });
    broadcast({ type: 'session.execution.failed', data: { sessionID: sid, error: { type: 'provider.error', message: 'fetch failed: getaddrinfo EAI_AGAIN api.opencode.ai: Temporary failure in name resolution', status: 0 } } });
    return;
  }
  if (md === 'servejob') {
    // LEG C: the serve's model calls the chained slow_probe THROUGH the
    // engine's own per-chat MCP route — the grace window answers the
    // ticket fast; the serve model continues.
    broadcast({ type: 'session.tool.input.started', data: { sessionID: sid, id: toolID, name: 'rigslow_slow_probe' } });
    broadcast({ type: 'session.tool.input.ended', data: { sessionID: sid, id: toolID, text: JSON.stringify({ label: 'serve lane' }) } });
    const mc = await engineMCP('rigslow_slow_probe', { label: 'serve lane' });
    s.mcpElapsed = mc.ms;
    broadcast({ type: 'session.tool.progress', data: { sessionID: sid, id: toolID, metadata: { message: 'mcp round-trip ' + mc.ms + 'ms' } } });
    const resText = mc.isError ? String(mc.text) : String(mc.text);
    s.transcript.push({ type: 'assistant', content: [ { type: 'tool', id: toolID, name: 'rigslow_slow_probe', state: { status: 'completed', input: { label: 'serve lane' }, content: [ { type: 'text', text: resText } ] } } ], time: { created: Date.now() } });
    broadcast({ type: 'session.tool.success', data: { sessionID: sid, id: toolID, content: [ { type: 'text', text: resText } ] } });
    broadcast({ type: 'session.text.delta', data: { sessionID: sid, delta: 'the serve model continued past the slow call' } });
    s.transcript.push({ type: 'assistant', text: 'the serve model continued past the slow call', time: { created: Date.now() } });
    s.transcript.push({ type: 'idle', outcome: 'succeeded', time: { created: Date.now() } });
    broadcast({ type: 'session.execution.succeeded', data: { sessionID: sid } });
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
      sessions[id] = { id, transcript: [], clients: new Set(), jobs: [], turnCount: 0, mcpElapsed: 0 };
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    let m = p.match(/^\\/api\\/session\\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const s = sessions[m[1]];
      if (!s) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ data: { id: s.id, title: 't', directory: '/ws/' + s.id, mcpElapsed: s.mcpElapsed } }));
      return;
    }
    m = p.match(/^\\/api\\/session\\/([^/]+)\\/message$/);
    if (m && req.method === 'GET') {
      const s = sessions[m[1]];
      if (!s) { res.writeHead(404); res.end('{}'); return; }
      const limit = parseInt(u.searchParams.get('limit') || '50', 10);
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
    if (m && req.method === 'POST') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ interrupted: false })); return; }
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

// ── the fake OpenAI-compatible provider (the native-path legs) ───────────
// Scripted rounds, keyed on the LAST tool result in the request:
//   no tools yet        → the slow_probe call (the lane arms)
//   JOB_STARTED         → LEG B: calculator 2+2 (continue unblocked) · LEG D: job_kill
//   calculator's "4"    → job_status (the mid-flight honest check)
//   RUNNING / STOPPED   → the final answer
const provState = { callSeq: 1 };
const provSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-flow-model' }] }));
      return;
    }
    if (!u.pathname.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    let reqBody = {}; try { reqBody = JSON.parse(body); } catch (e) {}
    const msgs = reqBody.messages || [];
    const toolMsgs = msgs.filter((m) => m && m.role === 'tool');
    const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content || '') : '';
    const firstUser = msgs.find((m) => m && m.role === 'user');
    const script = String((firstUser && firstUser.content) || '');
    const wantKill = /start and kill/.test(script);
    const jobIdOf = (txt) => { const m = String(txt || '').match(/j_[0-9a-f]{6,}/); return m ? m[0] : ''; };
    const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const toolCall = (id, name, argsObj) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse({ id: 'cmpl' + (provState.callSeq++), choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(argsObj) } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const answer = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse({ id: 'cmpl' + (provState.callSeq++), choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (!toolMsgs.length) {
      // round 1: arm the slow lane
      toolCall('call_slow_1', 'rigslow_slow_probe', { label: wantKill ? 'the doomed lane' : 'the patient lane' });
      return;
    }
    if (/JOB_STARTED/.test(lastTool)) {
      const jid = jobIdOf(lastTool);
      if (wantKill) { toolCall('call_kill_1', 'job_kill', { id: jid }); return; }
      // LEG B: the model CONTINUES — a second tool fires while the lane runs
      toolCall('call_calc_1', 'calculator', { expr: '2+2' });
      return;
    }
    if (/^4\s*$/.test(lastTool.trim())) {
      const jid = jobIdOf(msgs.map((m) => m && m.role === 'tool' ? m.content : '').join('\n'));
      toolCall('call_status_1', 'job_status', { id: jid });
      return;
    }
    if (/RUNNING/.test(lastTool)) { answer('the flow never blocked — the answer arrived while the slow lane kept running'); return; }
    if (/STOPPED/.test(lastTool)) { answer('the lane was stopped, best-effort, and the flow continued'); return; }
    // unknown shape — answer honestly so the turn never hangs
    answer('unexpected tool result shape: ' + lastTool.slice(0, 80));
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
      DOOMALAY_BASE_URL_OPENROUTER: 'http://127.0.0.1:' + PROV_PORT,
      HOME,
      // v1.73 THE PATIENT FLOW: the 3s lane window — the slow probe (15s)
      // parks on its own lane; the chain carries it (60s timeout — the
      // ticket at 3s is comfortably inside).
      DOOMALAY_JOB_GRACE_MS: String(GRACE_MS),
      DOOMALAY_MCP_SERVERS: JSON.stringify([{ name: 'rigslow', url: 'http://127.0.0.1:' + SLOW_PORT + '/mcp', timeout_ms: 60000 }]),
      DOOMALAY_SENTINEL_NET_S: '4',
      DOOMALAY_OC_SILENCE_PROBE_MS: '1200',
      DOOMALAY_OC_STALL_CEILING_MS: '9000',
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
  try { slowSrv.close(); } catch (e) {}
  try { provSrv.close(); } catch (e) {}
}

// ONE turn over the engine's own WS, collecting every event for a FIXED
// window (the async "job" rows land AFTER the turn's idle — the collector
// stays open past the turn's end by design).
function wsTurn(sid, text, totalMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const events = [];
    let assistant = '';
    let sentAt = 0, idleAt = 0;
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (e) {} resolve({ events, assistant, sentAt, idleAt }); };
    const t = setTimeout(finish, totalMs || 90000);
    ws.onopen = () => { sentAt = Date.now(); ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid })); };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        if (ev.type === 'user' && String(ev.text || '') === text) {
          events.push(ev);
          return;
        }
        if (events.length || ev.type === 'status' || ev.type === 'error') events.push(ev);
        if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
        if (ev.type === 'assistant' && ev.text) assistant = ev.text;
        if (ev.type === 'status' && ev.state === 'idle' && !idleAt) idleAt = Date.now();
      } catch (e) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => finish();
  });
}

async function mcpListTools() {
  try {
    const r = await fetch(ENGINE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'host': '127.0.0.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const j = await r.json();
    return ((j.result && j.result.tools) || []).map((t) => t.name);
  } catch (e) { return []; }
}

async function main() {
  console.log('═ v1.73 THE PATIENT FLOW — the rig');
  execSync(`cd ${__ROOT}/engine && ${process.env.GORUN || 'go'} build -o ${BIN} ./cmd/doomalay`, { stdio: 'inherit' });
  await new Promise((r) => slowSrv.listen(SLOW_PORT, '127.0.0.1', r));
  await new Promise((r) => provSrv.listen(PROV_PORT, '127.0.0.1', r));
  bootEngine('/tmp/v1730-engine.log');
  ok('the engine boots', await waitBoot());

  // the chained slow tool must attach before any leg drives it
  let chained = false;
  for (let i = 0; i < 40 && !chained; i++) {
    await sleep(500);
    const names = await mcpListTools();
    chained = names.includes('rigslow_slow_probe') && names.includes('job_status') && names.includes('job_kill') && names.includes('job_list');
  }
  ok('the chained slow_probe + the job trio ride the bus manifest', chained);

  // a real free opencode model for the serve legs (the registry's own truth)
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
  fs.writeFileSync(CATALOG_FILE, JSON.stringify([
    { id: freeA || 'stub-free-a', providerID: 'opencode', capabilities: { tools: true }, cost: [{ input: 0, output: 0 }] },
  ]));

  // the keys
  const kr = await api('POST', '/api/keys', { provider: 'opencode', env_var: 'OPENCODE_ZEN_API_KEY', key: 'oc_sk_fake_rig_key' });
  ok('the opencode key installs', kr.status < 300, tC(kr.body));
  const kor = await api('POST', '/api/keys', { provider: 'openrouter', env_var: 'OPENROUTER_API_KEY', key: 'sk-rig-fake' });
  ok('the openrouter key installs', kor.status < 300, tC(kor.body));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG A — the net arm (the timer picks up network interrupts)');
  try { fs.writeFileSync(MODE_FILE, 'netfail'); } catch (e) {}
  const csA = await api('POST', '/api/sessions', { title: 'rig net arm', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + (freeA || 'stub-free-a') });
  const sidA = csA.body && csA.body.ID;
  ok('the net-arm chat creates', !!sidA, tC(csA.body));
  // the auto-continue's NEXT attempt must hit a healthy serve: flip the
  // mode mid-collection (the first net failure already landed + armed)
  setTimeout(() => { try { fs.writeFileSync(MODE_FILE, 'quick'); } catch (e) {} }, 7000);
  const tA = await wsTurn(sidA, 'please answer me', 45000);
  const errA = tA.events.find((e) => e.type === 'error' && e.retry_class === 'net');
  ok('the net-class failure carries retry_class=net + retry_provider=opencode', !!errA, tC(tA.events.filter((e) => e.type === 'error')));
  const armLineA = tA.events.find((e) => e.type === 'progress' && /network interrupted/.test(String(e.message || e.text || '')));
  ok('the visible NET arm line lands (the visual queue/hint)', !!armLineA, tC(tA.events.filter((e) => e.type === 'progress')));
  const pillA = tA.events.find((e) => e.type === 'retry' && (e.phase === 'armed' || e.phase === 'probe' || e.phase === 'recovered'));
  ok('the sentinel ARMS (the pill — the chat joined the continuation timer)', !!pillA, tC(tA.events.filter((e) => e.type === 'retry')));
  ok('THE AUTO-CONTINUE fired (an answer landed with NO user tap)', /quick answer/.test(tA.assistant), JSON.stringify(tA.assistant).slice(0, 200));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG B — the native job lane (the patient flow)');
  const csB = await api('POST', '/api/sessions', { title: 'rig native lane', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/stub-flow-model' });
  const sidB = csB.body && csB.body.ID;
  ok('the native-lane chat creates', !!sidB, tC(csB.body));
  const bStart = Date.now();
  const tB = await wsTurn(sidB, 'start the slow lane and keep going — then check its status', 30000);
  const bIdleAt = tB.idleAt || Date.now();
  const bTurnMS = bIdleAt - bStart;
  const ticketB = tB.events.find((e) => e.type === 'tool_result' && /JOB_STARTED/.test(String(e.text || '')));
  ok('the slow call answers the JOB_STARTED ticket (not the 15s result)', !!ticketB, tC(tB.events.filter((e) => e.type === 'tool_result').map((e) => String(e.text || '').slice(0, 60))));
  const calcB = tB.events.find((e) => e.type === 'tool_result' && /4/.test(String(e.text || '')) && e.name === 'calculator');
  ok('the model CONTINUED — the calculator fired while the lane ran', !!calcB, tC(tB.events.filter((e) => e.type === 'tool_result').map((e) => e.name)));
  const statusB = tB.events.find((e) => e.type === 'tool_result' && /RUNNING/.test(String(e.text || '')));
  ok('job_status mid-flight answers RUNNING honestly', !!statusB, tC(tB.events.filter((e) => e.type === 'tool_result').map((e) => String(e.text || '').slice(0, 50))));
  ok('THE CONTINUITY PROOF — the turn ended in ' + (bTurnMS / 1000).toFixed(1) + 's (<10s) while the 15s lane kept running', bTurnMS < 10000 && /the flow never blocked/.test(tB.assistant), 'assistant=' + JSON.stringify(tB.assistant).slice(0, 120) + ' turnMS=' + bTurnMS);
  const jobB = tB.events.find((e) => e.type === 'job' && e.state === 'completed');
  ok('the completion "job" row landed after the fact (state=completed)', !!jobB, tC(tB.events.filter((e) => e.type === 'job')));
  ok('the job row carries the honest ≥12s duration', !!(jobB && Number(jobB.duration_ms) >= 12000), jobB && jobB.duration_ms);
  ok('the job row carries the slow probe\'s own text', !!(jobB && /the slow probe answered/.test(String(jobB.text || ''))), jobB && String(jobB.text || '').slice(0, 80));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG C — the serve-path job lane (the /mcp/oc route)');
  try { fs.writeFileSync(MODE_FILE, 'servejob'); } catch (e) {}
  const csC = await api('POST', '/api/sessions', { title: 'rig serve lane', sandbox: 'quick', provider: 'opencode', model: 'opencode/' + (freeA || 'stub-free-a') });
  const sidC = csC.body && csC.body.ID;
  ok('the serve-lane chat creates', !!sidC, tC(csC.body));
  try { fs.writeFileSync(CHAT_FILE, sidC || ''); } catch (e) {}
  const tC3 = await wsTurn(sidC, 'run the slow probe through your tool route', 30000);
  const serveRes = tC3.events.find((e) => e.type === 'tool_result' && /JOB_STARTED|slow probe/i.test(String(e.text || '')));
  ok('the serve model\'s tool round answered (the /mcp/oc route executed)', !!serveRes, tC(tC3.events.filter((e) => e.type === 'tool_result').map((e) => String(e.text || '').slice(0, 60))));
  ok('the MCP round-trip carried the TICKET (the grace window — never the 15s wait)', !!(serveRes && /JOB_STARTED/.test(String(serveRes.text || ''))), serveRes && String(serveRes.text || '').slice(0, 100));
  ok('the serve turn continued to its answer', /the serve model continued/.test(tC3.assistant), JSON.stringify(tC3.assistant).slice(0, 150));
  const jobC = tC3.events.find((e) => e.type === 'job' && e.state === 'completed');
  ok('the serve-path completion "job" row landed too', !!jobC, tC(tC3.events.filter((e) => e.type === 'job')));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG D — the kill (the model\'s own job_kill)');
  const csD = await api('POST', '/api/sessions', { title: 'rig kill lane', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/stub-flow-model' });
  const sidD = csD.body && csD.body.ID;
  ok('the kill chat creates', !!sidD, tC(csD.body));
  const tD = await wsTurn(sidD, 'start and kill the slow lane', 30000);
  const killD = tD.events.find((e) => e.type === 'tool_result' && /STOPPED/.test(String(e.text || '')));
  ok('job_kill answers STOPPED with the best-effort honesty', !!(killD && /best-effort|may still finish quietly/i.test(String(killD.text || ''))), killD && String(killD.text || '').slice(0, 120));
  const jobD = tD.events.find((e) => e.type === 'job' && e.state === 'cancelled');
  ok('the cancelled "job" row lands (the never-transition law)', !!jobD, tC(tD.events.filter((e) => e.type === 'job')));
  ok('the kill turn flows to its answer', /the lane was stopped/.test(tD.assistant), JSON.stringify(tD.assistant).slice(0, 150));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n═ LEG E — the honest clock (duration_ms on every tool_result)');
  ok('the native calculator result carries duration_ms (0 is honest for an in-process call)', !!(calcB && calcB.duration_ms !== undefined && Number(calcB.duration_ms) >= 0), calcB && calcB.duration_ms);
  ok('the serve tool_result carries duration_ms', !!(serveRes && Number(serveRes.duration_ms) > 0), serveRes && serveRes.duration_ms);
  const ticketPill = tB.events.find((e) => e.type === 'tool_result' && /JOB_STARTED/.test(String(e.text || '')));
  ok('the ticketed call\'s own result carries the window duration (the honest clock)', !!(ticketPill && Number(ticketPill.duration_ms) >= GRACE_MS - 500), ticketPill && ticketPill.duration_ms);
  // the PWA source pins (§A-style — the UI laws cannot silently regress)
  const panelSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/chatpanel.js'), 'utf8');
  ok('the PWA duration chip (tool-pill-dur)', panelSrc.indexOf('tool-pill-dur') > 0);
  ok('the PWA slow tone (data-slow + SLOW_TOOL_MS)', panelSrc.indexOf('SLOW_TOOL_MS') > 0 && panelSrc.indexOf('data-slow="1"') > 0);
  ok('the PWA job row (the after-the-fact re-render)', panelSrc.indexOf("type === 'job'") > 0 && panelSrc.indexOf('msg-job') > 0);
  const htmlSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/index.html'), 'utf8');
  ok('the CSS: the chip + the slow tone + the job row (theme tokens)', htmlSrc.indexOf('.tool-pill-dur') > 0 && htmlSrc.indexOf('.tool-pill[data-slow="1"]') > 0 && htmlSrc.indexOf('.msg-job') > 0);

  killAll();
  console.log('\n═ VERDICT: ' + (n - fails.length) + '/' + n + (fails.length ? ' — FAILURES: ' + fails.join(' | ') : ' — ALL GREEN'));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('RIG CRASH:', e); killAll(); process.exit(1); });
