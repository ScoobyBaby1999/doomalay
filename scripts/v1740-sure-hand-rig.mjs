#!/usr/bin/env node
// v1740-sure-hand-rig.mjs — v1.74 THE SURE HAND, the LIVE proof against the
// REAL engine binary + a FAKE chained-MCP tool server + a FAKE GitHub + a
// FAKE OpenAI-compatible provider.
//
// THE USER'S LAW (verbatim): "Still so many tool hiccups, we always seem to
// save it but still the rate at which models fail to land tool calls is too
// high… the model does a tool call, it fails, but executes successfully…
// our surgical editing tools + Json or text tools are very limited and bad…
// it has to create patches and fix mistakes that shouldn't happen… displayed
// that it will try to continue in 0:00??… The chat seemed to break out of
// its shell or intend to download something external when it wanted to
// rebase?!?!"
//
//   LEG A — THE PHANTOM LAW: a SUCCESSFUL tool whose content echoes error:
//           lines (a log read) produces NO hiccup notice and CACHES (the
//           identical repeat answers from the cache); a REAL failure (isError)
//           speaks the notice AND re-executes on the identical retry.
//
//   LEG B — THE OATH: a workspace patch call with 2 good edits + 1 genuinely
//           missing old → the commit carries the two (the fake GitHub's PUT
//           proves it), the observation says 2-of-3 with the actual-lines
//           re-ask + the don't-re-send law; a 0-of-N patch never PUTs; the
//           ranged read echoes its anchors + numbers its lines.
//
//   LEG C — THE 0:00 CLOCK: a provider 429 → the retry pill row lands BELOW
//           the error row (the order law, live: pill id > error id) → the
//           manual continue → the closing "recovered" row.
//
//   LEG D — THE HONEST DOOR + THE SCHEMA: the /mcp manifest tells the truth
//           (workspace edits is an ARRAY, line_numbers + resume ride, termux
//           args is an OBJECT) + the source pins (the API-only truth, the
//           complete teaches, the scratch-dir line, the countdown honesty).
//
//   LEG E — THE DEEP PARSE: a tool call whose arguments are hand-written
//           non-JSON ({file: "app.log" // the app log}) EXECUTES through the
//           repaired ladder — never the malformed refusal.
//
// Honesty law: every assertion binds to the tool's own frames — no inference
// from side effects.
'use strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const PORT = 8740;
const ENGINE = 'http://127.0.0.1:' + PORT;
const BIN = '/tmp/v1740-engine';
const DATA = '/tmp/v1740-data';
const HOME = '/tmp/v1740-home';
const PROV_PORT = 8741;   // the fake OpenAI-compatible provider
const OATH_PORT = 8742;   // the fake chained MCP tool server (log_reader/boom)
const GH_PORT = 8743;     // the fake GitHub (the workspace leg)
const GH_API = 'http://127.0.0.1:' + GH_PORT;

let n = 0; const fails = [];
const ok = (name, cond, extra) => { n++; if (cond) console.log('  \u2713 ' + name); else { fails.push(name); console.log('  \u2717 ' + name + (extra !== undefined && extra !== null ? ' \u2014 ' + String(extra).slice(0, 600) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tC = (v) => JSON.stringify(v).slice(0, 600);

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ── the fake chained MCP server (the phantom-law + deep-parse tools) ────
// log_reader: a SUCCESS whose content echoes error: lines (the phantom
//             conviction's exact shape). boom: a REAL failure (isError).
let boomCalls = 0;
const oathSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
    let rpc = null; try { rpc = JSON.parse(body); } catch (e) {}
    const send = (payload) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (!rpc) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (rpc.method === 'initialize') {
      send({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'rig-oath', version: '1.0.0' } } });
      return;
    }
    if (String(rpc.method || '').startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
    if (rpc.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: rpc.id, result: { tools: [
        { name: 'log_reader', description: 'Reads a log file (the rig phantom-law tool).', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
        { name: 'boom', description: 'A tool that genuinely fails (the rig real-failure tool).', inputSchema: { type: 'object', properties: {} } },
      ] } });
      return;
    }
    if (rpc.method === 'tools/call') {
      const name = rpc.params && rpc.params.name;
      if (name === 'log_reader') {
        // a SUCCESSFUL read of an error-laden log — the phantom conviction
        send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'DEPLOY.LOG (412 bytes):\n2026-10-24 error: connection refused\n2026-10-24 error: retrying\nerror: gave up after 3 tries\nthe deploy eventually succeeded' }] } });
        return;
      }
      if (name === 'boom') {
        boomCalls++;
        send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'error: the boom tool failed on purpose (attempt ' + boomCalls + ')' }], isError: true } });
        return;
      }
      send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'error: unknown tool ' + name }], isError: true } });
      return;
    }
    send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found: ' + rpc.method } });
  });
});

// ── the fake GitHub (the workspace leg) ─────────────────────────────────
const GH_FILE = 'package x\n\nfunc greet(name string) string {\n\treturn "hello " + name\n}\n\nfunc farewell() {}\n';
let ghPUTs = [];
const ghSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const j = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/repos/me/oath/branches' || (u.pathname.startsWith('/repos/me/oath/git/'))) {
      j([{ name: 'main' }]);
      return;
    }
    if (u.pathname === '/repos/me/oath/contents/a.go' && req.method === 'GET') {
      j({ name: 'a.go', path: 'a.go', sha: 'x', size: GH_FILE.length, encoding: 'base64', content: Buffer.from(GH_FILE).toString('base64') });
      return;
    }
    if (u.pathname === '/repos/me/oath/contents/a.go' && req.method === 'PUT') {
      let p = null; try { p = JSON.parse(body); } catch (e) {}
      let content = '';
      try { content = Buffer.from((p && p.content) || '', 'base64').toString('utf8'); } catch (e) {}
      ghPUTs.push(content);
      j({ content: { path: 'a.go', sha: 'newsha' }, commit: { sha: 'c1', html_url: GH_API + '/me/oath/commit/c1' } });
      return;
    }
    if (u.pathname.startsWith('/repos/me/oath') && req.method === 'GET') {
      // the access probe / misc reads
      j({ default_branch: 'main', private: false, permissions: { push: true }, full_name: 'me/oath' });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

// ── the fake OpenAI-compatible provider ─────────────────────────────────
// The scripted rounds keyed on the user prompt (each leg sends its own cue).
let provState = { callSeq: 1, fourTwentyNine: 0 };
const provSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    if (!req.url.startsWith('/v1/chat/completions') && !req.url.startsWith('/chat/completions')) {
      res.writeHead(404); res.end('{}'); return;
    }
    let reqBody = null; try { reqBody = JSON.parse(body); } catch (e) {}
    const msgs = (reqBody && reqBody.messages) || [];
    const toolMsgs = msgs.filter((m) => m && m.role === 'tool');
    const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content || '') : '';
    const firstUser = msgs.find((m) => m && m.role === 'user');
    const script = String((firstUser && firstUser.content) || '');
    if (process.env.RIG_PROV_LOG === 'full') console.log('PROV MSGS: ' + JSON.stringify(msgs.slice(-2)));
    const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const toolCall = (id, name, argsStr) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse({ id: 'cmpl' + (provState.callSeq++), choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsStr } }] }, finish_reason: null }] });
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
    if (/429 rate limit now/.test(script)) {
      // LEG C: the provider 429s ONCE (the arm), then heals (the manual
      // continue answers normally — a persistent 429 re-arms forever,
      // honest but not this leg's shape)
      provState.fourTwentyNine = (provState.fourTwentyNine || 0) + 1;
      if (provState.fourTwentyNine <= 3) { // the engine's own quick hiccup ladder retries twice — the 429 must persist past it to arm the sentinel
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
        res.end(JSON.stringify({ error: { message: 'rate limited — the rig 429', code: 429 } }));
        return;
      }
      answer('the rate limit cleared — the rig answer after the retry');
      return;
    }
    if (/the phantom law/.test(script)) {
      if (!toolMsgs.length) { toolCall('call_log_1', 'rigoath_log_reader', JSON.stringify({ file: 'deploy.log' })); return; }
      if (/identical/.test(lastTool)) { toolCall('call_boom_1', 'rigoath_boom', '{}'); return; } // the cached marker FIRST (the cached obs also contains the log text — the loop trap)
      if (/DEPLOY\.LOG/.test(lastTool)) { toolCall('call_log_2', 'rigoath_log_reader', JSON.stringify({ file: 'deploy.log' })); return; }
      if (/boom tool failed on purpose \(attempt 1\)/.test(lastTool)) { toolCall('call_boom_2', 'rigoath_boom', '{}'); return; }
      answer('the phantom is dead: the log read never lied, the boom retried for real');
      return;
    }
    if (/the surgeons oath/.test(script)) {
      if (!toolMsgs.length) {
        toolCall('call_patch_1', 'workspace', JSON.stringify({ action: 'patch', ws: 'me/oath', path: 'a.go', message: 'oath', edits: [
          { old: 'return "hello " + name', new: 'return "hi " + name' },
          { old: 'func greetz_the_missing_one(name string) string {', new: 'func greet2(name string) string {' },
          { old: 'func farewell() {}', new: 'func farewell(name string) {}' },
        ] }));
        return;
      }
      if (/2 of 3/.test(lastTool)) {
        toolCall('call_read_1', 'workspace', JSON.stringify({ action: 'read', ws: 'me/oath', path: 'a.go', range: 'lines:3-5' }));
        return;
      }
      if (/lines 3\u20135/.test(lastTool) || /lines 3-5/.test(lastTool)) {
        toolCall('call_patch_0', 'workspace', JSON.stringify({ action: 'patch', ws: 'me/oath', path: 'a.go', edits: [
          { old: 'not here at all', new: 'x' }, { old: 'also absent', new: 'y' },
        ] }));
        return;
      }
      answer('the oath holds: the good edits landed, the misses taught, nothing double-applied');
      return;
    }
    if (/the deep parse/.test(script)) {
      if (!toolMsgs.length) {
        // hand-written NON-JSON arguments: unquoted key + a // comment
        toolCall('call_deep_1', 'rigoath_log_reader', '{file: "app.log" // the application log\n}');
        return;
      }
      answer('the deep parse landed the hand-written call');
      return;
    }
    answer('unexpected script: ' + script.slice(0, 60));
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
      DOOMALAY_BASE_URL_OPENROUTER: 'http://127.0.0.1:' + PROV_PORT,
      DOOMALAY_GITHUB_API_BASE: GH_API,
      HOME,
      DOOMALAY_MCP_SERVERS: JSON.stringify([{ name: 'rigoath', url: 'http://127.0.0.1:' + OATH_PORT + '/mcp', timeout_ms: 60000 }]),
      DOOMALAY_SENTINEL_QUOTA_S: '30',
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
  try { child && child.kill('SIGKILL'); } catch (e) {}
  for (const s of [oathSrv, ghSrv, provSrv]) { try { s.close(); } catch (e) {} }
}

// ONE turn over the engine's own WS, collecting every event.
function wsTurn(sid, text, totalMs, onOpen) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
    const events = [];
    let assistant = '';
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch (e) {} resolve({ events, assistant }); };
    const t = setTimeout(finish, totalMs || 60000);
    ws.onopen = () => { if (onOpen) onOpen(ws); ws.send(JSON.stringify({ type: 'send', message: text, session_id: sid })); };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data);
        events.push(ev);
        if (ev.type === 'assistant_delta' && ev.text) assistant += ev.text;
        if (ev.type === 'assistant' && ev.text) assistant = ev.text;
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
    return ((j.result && j.result.tools) || []);
  } catch (e) { return []; }
}

async function sessionEvents(sid) {
  const r = await api('GET', '/api/sessions/' + sid + '/events?limit=500');
  const rows = (r.body && (r.body.events || r.body)) || [];
  return Array.isArray(rows) ? rows : [];
}

async function main() {
  console.log('\u2550 v1.74 THE SURE HAND \u2014 the rig');
  // a stale engine from an interrupted prior run holds the data dir's
  // SQLite (the readonly-1032 conviction) — kill it before anything
  try { execSync("pkill -9 -f '/tmp/v1740-engine' || true"); } catch (e) {}
  try { execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch (e) {}
  execSync(`cd ${__ROOT}/engine && ${process.env.GORUN || 'go'} build -o ${BIN} ./cmd/doomalay`, { stdio: 'inherit' });
  await new Promise((r) => oathSrv.listen(OATH_PORT, '127.0.0.1', r));
  await new Promise((r) => ghSrv.listen(GH_PORT, '127.0.0.1', r));
  await new Promise((r) => provSrv.listen(PROV_PORT, '127.0.0.1', r));
  bootEngine('/tmp/v1740-engine.log');
  ok('the engine boots', await waitBoot());

  // the chained tools must attach before any leg drives them
  let chained = false;
  for (let i = 0; i < 40 && !chained; i++) {
    await sleep(500);
    const names = (await mcpListTools()).map((t) => t.name);
    chained = names.includes('rigoath_log_reader') && names.includes('rigoath_boom');
  }
  ok('the chained log_reader + boom ride the bus manifest', chained);

  // the keys
  const kor = await api('POST', '/api/keys', { provider: 'openrouter', env_var: 'OPENROUTER_API_KEY', key: 'sk-rig-fake' });
  ok('the openrouter key installs', kor.status < 300, tC(kor.body));
  const kgh = await api('POST', '/api/keys', { provider: 'github', env_var: 'GITHUB_PAT', key: 'ghp_rig_fake' });
  ok('the github key installs', kgh.status < 300, tC(kgh.body));

  const mkChat = async (title) => {
    const cs = await api('POST', '/api/sessions', { title, sandbox: 'quick', provider: 'openrouter', model: 'openrouter/stub-flow-model' });
    return cs.body && cs.body.ID;
  };

  // ══════════════════════════════════════════════════════════════════
  console.log('\n\u2550 LEG A \u2014 the phantom law (display never lies again)');
  {
    const sid = await mkChat('rig phantom');
    const turn = await wsTurn(sid, 'the phantom law', 45000);
    const notices = turn.events.filter((e) => e.type === 'notice' && /hiccup/.test(String(e.text || '')));
    const logNotices = notices.filter((e) => /log_reader/.test(String(e.text || '')));
    ok('a successful log read with error: CONTENT raises NO hiccup notice', logNotices.length === 0, tC(logNotices.map((e) => e.text)));
    const boomNotices = notices.filter((e) => /boom/.test(String(e.text || '')));
    ok('a REAL failure (isError) speaks its hiccup notice', boomNotices.length >= 1, tC(notices.map((e) => e.text)));
    const results = turn.events.filter((e) => e.type === 'tool_result');
    const uses = turn.events.filter((e) => e.type === 'tool_use');
    const cached = uses.filter((e) => /identical repeat \u2014 cached result/.test(String(e.summary || '')));
    ok('the identical log re-fire serves the CACHE (no double side effects)', cached.length >= 1, tC(uses.map((e) => e.summary)));
    const boomResults = results.filter((e) => /boom tool failed on purpose/.test(String(e.text || '')));
    ok('the boom retry RE-EXECUTED (attempt 2 rides \u2014 failures never cache)', /attempt 2/.test(boomResults.map((e) => e.text).join(' ')), tC(boomResults.map((e) => e.text)));
    ok('the phantom answer landed', /phantom is dead/.test(turn.assistant), turn.assistant.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n\u2550 LEG B \u2014 the surgeon\u2019s oath (the partial apply, end-to-end)');
  {
    // connect the fake repo + bind it to the chat
    const sid = await mkChat('rig oath');
    const wc = await api('POST', '/api/workspaces/connect', { url: 'https://github.com/me/oath', token: 'ghp_rig_fake', session_id: sid, name: 'me/oath' });
    ok('the workspace connects against the fake GitHub', wc.status < 300, tC(wc.body));
    ghPUTs = [];
    const turn = await wsTurn(sid, 'the surgeons oath', 60000);
    const results = turn.events.filter((e) => e.type === 'tool_result');
    const patch = results.find((e) => /PATCHED \u2014 a\.go/.test(String(e.text || '')));
    ok('the patch observation says 2 of 3', !!patch && /2 of 3 surgical edit\(s\)/.test(patch.text), patch && patch.text.slice(0, 300));
    ok('the miss carries the actual-lines re-ask', !!patch && /the file's actual lines/.test(patch.text), patch && patch.text.slice(0, 500));
    ok('the don\u2019t-re-send law rides', !!patch && /do NOT re-send them/.test(patch.text));
    ok('exactly ONE PUT shipped (the partial commit)', ghPUTs.length === 1, 'puts=' + ghPUTs.length);
    ok('the PUT carries the two applied edits + the untouched signature', ghPUTs[0] && /return "hi " \+ name/.test(ghPUTs[0]) && /func farewell\(name string\) \{\}/.test(ghPUTs[0]) && /func greet\(name string\) string \{/.test(ghPUTs[0]), ghPUTs[0] && ghPUTs[0].slice(0, 300));
    const read = results.find((e) => /lines 3\u20135 of/.test(String(e.text || '')));
    ok('the ranged read echoes its anchors (lines 3\u20135 of N)', !!read, tC(results.map((e) => String(e.text).slice(0, 60))));
    ok('the ranged read numbers its lines by default', !!read && /3\u2502 func greet\(name string\) string \{/.test(read.text), read && read.text.slice(0, 200));
    const putsBefore = ghPUTs.length;
    const zero = results.find((e) => /no edits applied/.test(String(e.text || '')));
    ok('the 0-of-N patch is the honest error', !!zero, tC(results.map((e) => String(e.text).slice(0, 60))));
    ok('the 0-of-N patch NEVER writes', ghPUTs.length === putsBefore, 'puts=' + ghPUTs.length);
    ok('the oath answer landed', /oath holds/.test(turn.assistant), turn.assistant.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n\u2550 LEG C \u2014 the 0:00 clock (the pill below the error + the closing row)');
  {
    const sid = await mkChat('rig clock');
    const turn = await wsTurn(sid, '429 rate limit now', 25000);
    await sleep(1500);
    const evs = await sessionEvents(sid);
    const errRow = evs.find((e) => e.type === 'error');
    const retryRows = evs.filter((e) => e.type === 'retry');
    ok('the 429 error row persisted', !!errRow, tC(evs.map((e) => e.type)));
    ok('the retry pill row persisted (the sentinel armed)', retryRows.length >= 1, tC(evs.map((e) => e.type)));
    if (errRow && retryRows.length) {
      // THE ORDER LAW: the armed pill lands BELOW the error row
      const errIdx = evs.indexOf(errRow);
      const firstPill = retryRows[0];
      const pillIdx = evs.indexOf(firstPill);
      ok('THE ORDER LAW: the pill lands BELOW the error row (id ' + (firstPill.i || firstPill.ID || '?') + ' > ' + (errRow.i || errRow.ID || '?') + ')', pillIdx > errIdx, 'pill@' + pillIdx + ' err@' + errIdx);
    }
    // the manual continue → the closing row (the continue message ONLY —
    // never a new prompt; a fresh send would also disarm but the leg pins
    // the continue path itself)
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/chat?session_id=${sid}`);
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve(); }, 25000);
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'continue', session_id: sid })); };
      ws.onmessage = () => {};
      ws.onclose = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => {};
    });
    await sleep(1500);
    const evs2 = await sessionEvents(sid);
    const lastRetry = evs2.filter((e) => e.type === 'retry').pop();
    ok('the manual continue closes the pill (the recovered row)', !!lastRetry && /recovered/.test(String(lastRetry.content || lastRetry.text || '')), tC(lastRetry));
    ok('the closer carries the honest note', !!lastRetry && /continued without the timer/.test(String(lastRetry.content || lastRetry.text || '')));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n\u2550 LEG D \u2014 the honest door + the schema truth (the live manifest)');
  {
    const tools = await mcpListTools();
    const ws = tools.find((t) => t.name === 'workspace');
    ok('the workspace tool rides the /mcp manifest', !!ws);
    if (ws) {
      const props = (ws.inputSchema && ws.inputSchema.properties) || {};
      ok('the manifest declares edits as an ARRAY (the schema-literal client\u2019s teach-retry dies)', props.edits && props.edits.type === 'array', tC(props.edits));
      ok('the manifest declares line_numbers', !!props.line_numbers, tC(Object.keys(props)));
      ok('the manifest declares the grep resume cursor', !!props.resume);
    }
    const tx = tools.find((t) => t.name === 'termux');
    ok('the termux args prop is an OBJECT (the honest shape)', !tx || (tx.inputSchema && tx.inputSchema.properties && tx.inputSchema.properties.args && tx.inputSchema.properties.args.type === 'object'), tx && tC(tx.inputSchema && tx.inputSchema.properties && tx.inputSchema.properties.args));
    // the source pins (the honest texts)
    const readSrc = (p) => { try { return fs.readFileSync(path.join(__ROOT, p), 'utf8'); } catch (e) { return ''; } };
    const wt = readSrc('engine/internal/server/workspacetool.go');
    ok('the API-only truth rides the manifest (no clone/rebase \u2014 sync is the rebase eye)', /HONEST LIMITS/.test(wt) && /rebase, merge and cherry-pick DO NOT EXIST/.test(wt));
    ok('the device-row split (termux rows never ride the cloud block)', /ws.Kind == "device" \|\| ws.Kind == "termux"/.test(wt));
    const cg = readSrc('engine/internal/llm/chat.go');
    ok('the complete workspace teach (30 verbs)', /help\|list\|info\|tree\|ls\|read\|readme\|grep\|view\|put\|patch\|commit\|sync\|pr\|/.test(cg));
    ok('the complete termux teach (cmds/git_setup/patch)', /exec\|cmds\|git_setup\|ls\|read\|write\|append\|patch\|rm\|mkdir\|grep\|find\|pkg\|/.test(cg));
    const ot = readSrc('engine/internal/server/ocservetools.go');
    ok('the serve pick line names the scratch cwd', /SCRATCH sandbox/.test(ot));
    const cp = readSrc('engine/internal/server/web/chatpanel.js');
    ok('the countdown honesty (probing\u2026 / timer ended \u2014 never a frozen 0:00)', /return 'probing\u2026'/.test(cp) && /return 'timer ended'/.test(cp));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n\u2550 LEG E \u2014 the deep parse (hand-written non-JSON arguments)');
  {
    const sid = await mkChat('rig deep');
    const turn = await wsTurn(sid, 'the deep parse', 45000);
    const results = turn.events.filter((e) => e.type === 'tool_result');
    const deep = results.find((e) => /DEPLOY\.LOG/.test(String(e.text || '')));
    ok('the unquoted-key + comment arguments EXECUTED through the repaired ladder', !!deep, tC(results.map((e) => String(e.text).slice(0, 60))));
    const bad = results.find((e) => /malformed|CUT OFF/.test(String(e.text || '')));
    ok('never the malformed/cut refusal (the call was whole \u2014 just hand-written)', !bad, bad && bad.text.slice(0, 200));
    ok('the deep-parse answer landed', /deep parse landed/.test(turn.assistant), turn.assistant.slice(0, 120));
  }

  // ── the verdict ────────────────────────────────────────────────────────
  console.log('\n\u2550\u2550\u2550 ' + (n - fails.length) + '/' + n + ' GREEN ' + (fails.length ? '\u2014 FAILURES: ' + fails.join(' | ') : '\u2014 ALL GREEN') + ' \u2550\u2550\u2550');
  killAll();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('RIG FATAL', e); killAll(); process.exit(2); });
