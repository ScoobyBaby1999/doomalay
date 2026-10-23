#!/usr/bin/env node
// v1640-loud-system-rig.mjs — v1.64 THE LOUD SYSTEM battery (PLAN-V164 §proof).
//
// §A source pins: the header law (commandTitleParts + the compound scan +
//    the opencode shell branch), the injection law (EmitInjected at every
//    site + the verbatim directive + the chunk stamp + the persist case +
//    the PWA branch + the CSS state + the export rows) and the pick line
//    (doomalay_web_search first, hublib, workspace releases).
// §B THE SPEAKING HEADER live: the REAL chatpanel.js derivation through the
//    module seam — singles keep the termux-exec law byte-identical,
//    compounds title 'cd & grep' (cap 3 + '…'), quoted pipes stay content,
//    the opencode shell pill titles the program (1:1 with termux exec).
// §C THE LOUD INJECTION live: a real engine turn on a fake provider whose
//    round 1 ANNOUNCES (intent-only) → the proceed fires → the injected
//    row rides the WS (type injected + the DYNAMIC message with the
//    announcement's tail) → round 2's request carries it → the PWA
//    renders the hiccup box's NEW STATE live + on replay + the exports.
// §D THE OPEN SHELF live: the /mcp/oc dance — the catalog carries hublib
//    + web_search + workspace (EXPOSED), a real keyless web_search answers
//    (the DuckDuckGo/Bing ladder), hublib answers, and workspace views
//    the user's OWN repo's releases through GitHub (the 'verify GitHub
//    tools' ask).
// §E honesty: zero page errors + the md export carries the injected row.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(__ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');
const goSrc = (p) => fs.readFileSync(path.join(__ROOT, 'engine', 'internal', p), 'utf8');
const require2 = createRequire(import.meta.url);

const ENGINE_PORT = 8640;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const FAKE_PORT = 8641;
const ENGINE_BIN = '/tmp/v1640-rig-engine';
const DATA_DIR = '/tmp/v1640-rig-data';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log('\n═ ' + t); }

const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 45000); }
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}

// ══ §A the source laws ══════════════════════════════════════════════
section('§A the loud system lives in the source');
{
  const cp = read('chatpanel.js');
  try { new Function(cp); ok('chatpanel.js parses', true); }
  catch (e) { ok('chatpanel.js parses', false, e.message); }
  ok('THE SPEAKING HEADER: commandTitleParts is the one shared derivation (the termux exec law widened)',
    /function commandTitleParts\(cmd\)/.test(cp) &&
    /v1\.64\.1 THE SPEAKING HEADER — ONE shared derivation/.test(cp));
  ok('the COMPOUND SCAN: && || ; | & outside quotes + the $( ) paren skip',
    /two === '&&' \|\| two === '\|\|'/.test(cp) &&
    /ch === ';' \|\| ch === '\|' \|\| ch === '&'/.test(cp) &&
    /depth === 0/.test(cp) && /depth\+\+/.test(cp));
  ok('the CAP law: first ≤3 program tokens joined \' & \' + the trailing … when more segments follow',
    /toks\.length < 3/.test(cp) && /toks\.join\(' & '\) \+ \(more \? ' …' : ''\)/.test(cp));
  ok('the termux exec branch routes through the shared derivation (single law byte-identical)',
    /var cp = commandTitleParts\(cmd\);/.test(cp) && /body = cp \? \(cp\.compound \? cp\.fullLine : cp\.rest\) : ''/.test(cp));
  ok("the opencode SHELL branch: fam === 'shell' titles the command's program (1:1 with termux exec)",
    /fam === 'shell'/.test(cp) && /var shParts = commandTitleParts\(String\(ga\.command \|\| ''\)\);/.test(cp) &&
    /title = shParts\.title;/.test(cp));
  ok('THE LOUD INJECTION branch: the handleEvent injected case lifts {message} (live + replay)',
    /type === 'injected'/.test(cp) && /role: 'injected'/.test(cp));
  ok("the hiccup box's NEW STATE: the same msg-notice container + data-code=injected + the system-injected lead",
    /msg\.role === 'injected'/.test(cp) && /data-msg-role="injected" data-code="injected"/.test(cp) &&
    /<b>system injected:<\/b> /.test(cp));
  ok('the rig seam: commandTitleParts exported', /commandTitleParts: commandTitleParts,/.test(cp));

  const idx = read('index.html');
  ok('the injected CSS state rides the theme accent tokens (no hardcoded colors)',
    /\.msg-notice\[data-code="injected"\]/.test(idx) &&
    /color: var\(--accent\);/.test(idx) &&
    /rgba\(var\(--accent-rgb\), 0\.1\)/.test(idx) &&
    /content: '⌁ '/.test(idx));

  ok('THE VERBATIM LAW: RetryDirectiveFor carries the call verbatim (the const stays the tail)',
    /func RetryDirectiveFor\(name, rawArgs string\) string/.test(goSrc('llm/argrepair.go')) &&
    /verbatim, as you sent it: /.test(goSrc('llm/argrepair.go')));
  const nt = goSrc('llm/nativetools.go');
  ok('every nativetools injection site is LOUD (seam + proceed + answer-force + budget)',
    (nt.match(/EmitInjected\(ch,/g) || []).length >= 4);
  ok('the proceed text is DYNAMIC (ProceedInjectionText carries the announcement tail)',
    /ProceedInjectionText\(roundText\)/.test(nt) &&
    /func ProceedInjectionText\(announcement string\) string/.test(goSrc('llm/injected.go')));
  ok('the fault texts carry the verbatim call', /RetryDirectiveFor\(c\.Name, args\)/.test(nt));
  const chatGo = goSrc('server/chat.go');
  ok('the chunk loop stamps the injected row ({message, code:"injected"})',
    /ev\["code"\] = "injected"/.test(chatGo) && /ev\["message"\] = chunk\.Text/.test(chatGo));
  ok('forwardEvents persists the injected row + emit lifts it (the notice law\'s twin)',
    /case "injected":/.test(chatGo) && /func \(s \*Server\) emitInjectedRow/.test(chatGo));
  ok('the continueCore nudge emits the row (the server-side site is loud too)',
    /s\.emitInjectedRow\(pipe, sessionID, cont\.nudge\)/.test(chatGo));
  ok('the tail read treats injected rows as bookkeeping (the prompt\'s copy, never a turn)',
    /case "error", "status", "hide", "notice", "injected", "title":/.test(chatGo));
  const ex = goSrc('server/export.go');
  ok('the exports carry the injected rows (fold + md/txt/html)',
    /injectedMessage\(ev\.Content\)/.test(ex) && /system injected: %s/.test(ex) &&
    /\[system injected\] %s/.test(ex));
  const ot = goSrc('server/ocservetools.go');
  ok("THE OPEN SHELF pick line: WEB SEARCH rides doomalay_web_search FIRST (keyless — 'as it does with the other providers'), hublib + workspace releases named",
    /for WEB SEARCH always use doomalay_web_search first/.test(ot) &&
    /keyless engine \(DuckDuckGo\/Bing/.test(ot) &&
    /use doomalay_hublib/.test(ot) &&
    /use doomalay_workspace/.test(ot));
  ok('the termux + workspace runners carry the verbatim order at every needs-text site',
    /RetryDirectiveFor\("termux"/.test(goSrc('server/termuxtool.go')) &&
    /RetryDirectiveFor\("workspace "\+action/.test(goSrc('server/workspacetool.go')));
}

// ══ §B THE SPEAKING HEADER live (the real chatpanel.js) ═════════════
section('§B THE SPEAKING HEADER — the derivation through the real chatpanel.js');
// the Node seam: chatpanel.js reads window/document at require time — the
// same stub the v1232 rig ships (the module.exports block is the seam).
const RealWebSocket = globalThis.WebSocket; // the seam stub below overwrites it — the rig's own legs need the REAL one
const sandboxLS = {};
global.localStorage = {
  getItem: (k) => sandboxLS[k] || null,
  setItem: (k, v) => { sandboxLS[k] = String(v); },
  removeItem: (k) => { delete sandboxLS[k]; }
};
global.window = {
  ChatTypes: { helpers: { SANDBOX_LABELS: {}, SANDBOX_ICONS: {} } },
  addEventListener: function () {}
};
global.document = { addEventListener: function () {}, createElement: () => ({ style: {} }) };
global.location = { protocol: 'http:', host: 'test' };
function FakeWS() {}
FakeWS.prototype.send = function () {};
global.WebSocket = FakeWS;
const seam = require2(path.join(WEB, 'chatpanel.js'));
globalThis.WebSocket = RealWebSocket; // restore — the rig's live WS legs ride Node's real client
{
  const t = seam.commandTitleParts;
  ok('is exported through the rig seam', typeof t === 'function');
  const cases = [
    ['grep -rn foo .', 'grep', '-rn foo .', false],
    ['FOO=1 python -V', 'python', '-V', false],
    ['cd src && grep -rn foo', 'cd & grep', '', true],
    ['mkdir a || ls', 'mkdir & ls', '', true],
    ['a; b; c; d; e', 'a & b & c …', '', true],
    ['cat x | grep o | cut -d, | sort | uniq', 'cat & grep & cut …', '', true],
  ];
  for (const [cmd, wantTitle, wantRest, wantCompound] of cases) {
    const r = t(cmd);
    const good = r && r.title === wantTitle && !!r.compound === !!wantCompound &&
      (wantCompound ? r.fullLine === cmd : r.rest === wantRest);
    ok('commandTitleParts(' + JSON.stringify(cmd).slice(0, 40) + ') → ' + JSON.stringify(wantTitle), good,
      JSON.stringify(r));
  }
  const q = t('grep "a|b" file | wc -l');
  ok('a QUOTED pipe stays single (content, never a join) — the unquoted pipes split',
    q && q.compound === true && q.title === 'grep & wc', JSON.stringify(q));
  const sub = t('echo $(ls | head) done');
  ok('a SUBSHELL pipe never splits ($( ) depth-skipped)',
    sub && sub.compound === false && sub.title === 'echo', JSON.stringify(sub));
  const ml = t('\n\n  python3 -V\nprint(1)');
  ok('the FIRST non-empty line carries the head (multi-line scripts)',
    ml && ml.title === 'python3' && ml.rest === '-V', JSON.stringify(ml));

  // the termux exec pill through the REAL toolPillLabelParts (compound-aware now)
  const txMsg = { payload: { name: 'termux', args: { action: 'exec', args: '{"command":"mkdir logs && cd logs && touch a && ls"}' } } };
  const tx = seam.toolPillLabelParts(txMsg);
  ok('the termux exec pill titles its first 3 programs: "mkdir & cd & touch …"',
    tx.title === 'mkdir & cd & touch …', JSON.stringify(tx));
  const txSingle = seam.toolPillLabelParts({ payload: { name: 'termux', args: { action: 'exec', args: '{"command":"python -V"}' } } });
  ok('a single termux exec keeps the program-token law byte-identical (python / -V)',
    txSingle.title === 'python' && txSingle.body === '-V' && txSingle.label === 'python', JSON.stringify(txSingle));

  // THE OPENCODE SHELL PILL — the user's ask 1: the header is the command's own program
  const shSingle = seam.toolPillLabelParts({ payload: { name: 'shell', summary: 'grep -rn foo .', args: '{"command":"grep -rn foo ."}' } });
  ok("the opencode SHELL pill titles 'grep' (the static 'shell' header is DEAD) + the body is the remainder",
    shSingle.title === 'grep' && shSingle.body === '-rn foo .', JSON.stringify(shSingle));
  const shCompound = seam.toolPillLabelParts({ payload: { name: 'shell', summary: 'cd src && grep -rn foo', args: '{"command":"cd src && grep -rn foo"}' } });
  ok("the opencode SHELL pill titles compounds: 'cd & grep' + the full head line as the body",
    shCompound.title === 'cd & grep' && shCompound.body === 'cd src && grep -rn foo', JSON.stringify(shCompound));
  const shFallback = seam.toolPillLabelParts({ payload: { name: 'shell', summary: 'tar -xzf big.tgz' } });
  ok('a shell pill with no parsable command keeps the honest fallback (title=shell, body=summary)',
    shFallback.title === 'shell' && shFallback.body === 'tar -xzf big.tgz', JSON.stringify(shFallback));
}

// ══ the fake provider (the announcement arc) ════════════════════════
const ANNOUNCE = "Let me check the timers first. I will now read the three timer regions and patch the guard carefully.";
const ANSWER = "LOUD ANSWER: the proceed fired and the answer landed.";
let fakeRound = 0;
let sawContextTail = false;
const fakeSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    // THE CATALOG SYNC answers separately: the engine's first-turn /models
    // probe must NEVER consume a chat round (the live conviction — the
    // announcement burned on the catalog otherwise).
    if (req.method === 'GET' || req.url.includes('models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'openrouter/fake-loud' }] }));
      return;
    }
    fakeRound++;
    if (fakeRound >= 2 && body.includes('for context:') && body.includes('patch the guard carefully.')) sawContextTail = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = fakeRound === 1
      ? [`data: {"choices":[{"delta":{"content":"${ANNOUNCE}"}}]}`,
         `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`]
      : [`data: {"choices":[{"delta":{"content":"${ANSWER}"}}]}`,
         `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`];
    for (const f of frames) res.write(f + '\n\n');
    res.end();
  });
});

// ══ boot ════════════════════════════════════════════════════════════
section('§C THE LOUD INJECTION — the live arc (boot)');
await new Promise((r) => fakeSrv.listen(FAKE_PORT, '127.0.0.1', r));
try { ab(['close', '--all']); } catch (e) {}
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
});
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
  detached: true, stdio: 'ignore',
  env: {
    ...process.env,
    DOOMALAY_OTA_DISABLE: '1',
    DOOMALAY_BASE_URL_OPENROUTER: 'http://127.0.0.1:' + FAKE_PORT,
  },
});
child.unref();
let booted = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ENGINE + '/api/health')).ok) { booted = true; break; } } catch (e) {}
  await sleep(500);
}
ok('the engine boots', booted);

async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}
const kr = await api('POST', '/api/keys', { provider: 'openrouter', env_var: 'OPENROUTER_API_KEY', key: 'sk-rig-fake' });
ok('the fake-provider key installs', kr.status === 200, JSON.stringify(kr.body));
const cs = await api('POST', '/api/sessions', { title: 'loud injection arc', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/fake-loud' });
const SID = cs.body && (cs.body.id || cs.body.ID);
ok('the session creates', !!SID, JSON.stringify(cs.body).slice(0, 200));

// the WS watcher: the send + the event collection (live rows)
const wsRows = [];
const ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${SID}`);
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ type: 'send', message: 'patch the timers please', session_id: SID }));
{
  let done = false;
  ws.onmessage = (m) => {
    try { const ev = JSON.parse(m.data); wsRows.push(ev); } catch (e) {}
  };
  for (let i = 0; i < 120 && !done; i++) {
    await sleep(500);
    done = wsRows.some((r) => r.type === 'status' && r.state === 'idle') &&
      wsRows.some((r) => r.type === 'assistant' || (r.type === 'assistant_delta' && r.text));
  }
  try { ws.close(); } catch (e) {}
}
const injectedRows = wsRows.filter((r) => r.type === 'injected');
ok('THE INJECTED ROW RIDES THE WIRE (type injected + code injected + the DYNAMIC message)',
  injectedRows.length === 1 &&
  (injectedRows[0].message || '').includes('proceed — execute the plan you just announced') &&
  injectedRows[0].code === 'injected',
  JSON.stringify(injectedRows).slice(0, 300));
ok("THE DYNAMIC TEXT: the announcement's tail rides for context ('for context:' + the model's own words)",
  (injectedRows[0] && injectedRows[0].message || '').includes('for context:') &&
  (injectedRows[0].message || '').includes('patch the guard carefully.'),
  (injectedRows[0] || {}).message);
ok("the model's round-2 REQUEST carried the dynamic proceed text (the context the rig asserted server-side)",
  sawContextTail);
const answered = wsRows.some((r) => r.type === 'assistant' && String(r.text).includes('LOUD ANSWER'));
ok('the turn completed through the proceed round (the answer landed)', answered,
  JSON.stringify(wsRows.filter((r) => r.type === 'assistant').map((r) => r.text).join('')).slice(0, 120));

// the replay: a fresh WS connection re-delivers the injected row
{
  const ws2 = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/api/chat?session_id=${SID}`);
  const replay = [];
  await new Promise((r) => { ws2.onopen = r; });
  ws2.onmessage = (m) => { try { replay.push(JSON.parse(m.data)); } catch (e) {} };
  await sleep(2500);
  try { ws2.close(); } catch (e) {}
  const inj = replay.filter((r) => r.type === 'injected');
  // the replayed row carries the raw JSON in ev.text — lift {message} exactly
  // like the PWA's injected branch does (the same law both sides).
  const liftMsg = (r) => {
    if (r.message) return String(r.message);
    try { return (JSON.parse(r.text || '{}') || {}).message || ''; } catch (e) { return ''; }
  };
  ok('THE REPLAY re-delivers the injected row (the transcript keeps it — a reopened chat renders it)',
    inj.length >= 1 && liftMsg(inj[0]).includes('proceed — execute the plan'),
    JSON.stringify(replay.filter((r) => r.type === 'injected')).slice(0, 200));
}

// the PWA DOM leg: the hiccup box's NEW STATE renders live in the panel
ab(['set', 'viewport', '1280', '900']);
ab(['open', ENGINE + '/?apk=1']);
await sleep(2600);
abEval("window.__v1640errs=[];window.addEventListener('error',function(e){window.__v1640errs.push(String(e.message||e))});'armed'");
abEval(`(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('${SID}', {}), 'opened') : 'no api'`);
{
  let box = null;
  for (let i = 0; i < 24 && !box; i++) {
    await sleep(500);
    box = abJson(`(function(){var b=document.querySelector('[data-code="injected"]');if(!b)return null;return JSON.stringify({lead:b.textContent.indexOf('system injected:')>=0,text:b.textContent.slice(0,240),glyph:getComputedStyle(b,'::before').content,accent:getComputedStyle(b).color!==''});})()`);
  }
  ok("THE HICCUP BOX'S NEW STATE renders in the panel (data-code=injected + the 'system injected:' lead + the ⌁ glyph)",
    box && box.lead && /⌁/.test(String(box.glyph || '')) && box.text.includes('proceed — execute the plan'),
    JSON.stringify(box));
}
// the md export carries the row
{
  const md = await (await fetch(ENGINE + '/api/sessions/' + SID + '/export.md')).text();
  ok('the md EXPORT carries the injected row verbatim (never a silent injection)',
    md.includes('system injected:') && md.includes('for context:'), md.slice(0, 400));
}

// ══ §D THE OPEN SHELF live (the /mcp/oc dance) ══════════════════════
section('§D THE OPEN SHELF — hublib + web_search + GitHub through /mcp/oc');
{
  const mc = await api('POST', '/api/sessions', { title: 'open shelf', sandbox: 'quick', provider: 'openrouter', model: 'openrouter/fake-shelf' });
  const shelfChat = mc.body && (mc.body.id || mc.body.ID);
  ok('the shelf chat creates', !!shelfChat);
  const rpc = async (method, params, id) => {
    const body = { jsonrpc: '2.0', id, method };
    if (params) body.params = params;
    const r = await fetch(ENGINE + '/mcp/oc/' + shelfChat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    // the streamable shape may answer SSE-framed JSON — lift the last data: line
    let out = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try { out = JSON.parse(line.slice(5).trim()); } catch (e) {}
      }
    }
    if (!out) { try { out = JSON.parse(text); } catch (e) {} }
    return { status: r.status, out };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'v1640-rig', version: '1.0' } }, 1);
  ok('the MCP handshake answers', init.status === 200 && init.out && init.out.result, JSON.stringify(init).slice(0, 160));
  await fetch(ENGINE + '/mcp/oc/' + shelfChat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const list = await rpc('tools/list', {}, 2);
  const names = (((list.out || {}).result || {}).tools || []).map((t) => t.name);
  ok('THE CATALOG carries the shelf: web_search + hublib + workspace (EXPOSED to opencode)',
    names.includes('web_search') && names.includes('hublib') && names.includes('workspace'),
    JSON.stringify(names));

  // THE KEYLESS WEB SEARCH — the user's ask: 'websearch should work with simple google,
  // duckduckgo, another opensource browser as it does with the other providers'
  const wsCall = await rpc('tools/call', { name: 'web_search', arguments: { query: 'opencode websearch tavily provider docs' } }, 3);
  const wsText = JSON.stringify(wsCall.out || {});
  ok('THE KEYLESS WEB SEARCH answers through the /mcp shelf (the DDG/Bing ladder — no tavily key anywhere)',
    wsCall.out && wsCall.out.result && !wsCall.out.result.isError && /https?:\/\//.test(wsText),
    wsText.slice(0, 300));

  // THE HUBLIB — the user's ask: 'hublib isn't exposed to opencode'
  const hb = await rpc('tools/call', { name: 'hublib', arguments: { action: 'search', q: 'brainstorm', type: 'skill' } }, 4);
  const hbText = JSON.stringify(hb.out || {});
  ok('THE HUBLIB tool answers through the shelf (search runs — never an exposure refusal)',
    hb.out && hb.out.result && !hb.out.result.result_isError && !/not armed|unhandled tool/.test(hbText),
    hbText.slice(0, 300));

  // THE GITHUB TOOLS — 'verify that opencode can use GitHub tools (view releases, all that)'
  // The vault's token authenticates the forge (an anonymous sandbox IP rides
  // GitHub's 60/h anonymous rate limit — the user's own device carries their
  // token; the rig reads it from keys.env, never hardcoding the secret).
  let ghTok = '';
  try {
    for (const line of fs.readFileSync('/home/z/keys.env', 'utf8').split('\n')) {
      const m = /^(GITHUB_TOKEN|GITHUB_PAT)=(.+)$/.exec(line.trim());
      if (m) ghTok = m[2].trim();
    }
  } catch (e) {}
  // the vault's allowlist carries GITHUB_PAT (workspace cloning) — that's the
  // env githubToken() reads; install it under that name.
  if (ghTok) {
    const gk = await api('POST', '/api/keys', { provider: 'github', env_var: 'GITHUB_PAT', key: ghTok });
    ok('the vault GitHub token installs (the authenticated forge leg)', gk.status === 200, gk.status);
  } else {
    ok('the vault GitHub token installs (the authenticated forge leg)', false, 'no GITHUB_TOKEN in keys.env');
  }
  const rel = await rpc('tools/call', { name: 'workspace', arguments: { action: 'view', ws: 'ScoobyBaby1999/doomalay', what: 'releases' } }, 5);
  const relText = JSON.stringify(rel.out || {});
  ok("THE GITHUB VIEW-RELEASES answers through the shelf (the user's OWN repo, public unbound)",
    rel.out && rel.out.result && !rel.out.result.isError && /v1\.\d+\.\d+/.test(relText),
    relText.slice(0, 300));
  const rd = await rpc('tools/call', { name: 'workspace', arguments: { action: 'read', ws: 'ScoobyBaby1999/doomalay', path: 'README.md' } }, 6);
  const rdText = JSON.stringify(rd.out || {});
  ok('the GitHub read answers too (the public-repo fallback — full GitHub access for view/read work)',
    rd.out && rd.out.result && !rd.out.result.isError && rdText.length > 400,
    rdText.slice(0, 200));
}

// ══ §E honesty ══════════════════════════════════════════════════════
section('§E honesty');
await sleep(800);
const errs = abJson("JSON.stringify((window.__v1640errs||[]).slice(0,6))");
ok('zero page errors through the whole battery', errs && errs.length === 0, JSON.stringify(errs));
try { ab(['close', '--all']); } catch (e) {}
try { fakeSrv.close(); } catch (e) {}
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}

console.log('\n' + (fails.length === 0 ? '★ v1640 ALL GREEN — ' + n + ' pins' :
  '✗ v1640: ' + fails.length + ' FAILED of ' + n + ' — ' + fails.join(' | ')));
process.exit(fails.length === 0 ? 0 : 1);
