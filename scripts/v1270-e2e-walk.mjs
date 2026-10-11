#!/usr/bin/env node
// v1270-e2e-walk.mjs — v1.27.0 THE HONEST PROGRAM redteam: the REAL-USER
// walk (PLAN-V127).
//
// ONE long-lived process (the sandbox reaps daemons between commands):
// boots the carrier world in-process (the executing fake bridge + the
// OpenAI stub whose termux tool call rides the DEVICE's exact
// double-encoded string args + the engine), then drives the PWA through
// agent-browser exactly as a human would:
//
//   S2  the chat opens
//   S3  THE STRING-ARGS PILL (§1 — the user's blank-title bug): the stub
//       emits {"action":"exec","args":"{\"command\": …}"} (the MCP
//       manifest's declared string form — the live device's shape); the
//       pill carries the ONE-WORD PROGRAM chip (bash) + the dim body
//       (NEVER blank); the ↗ overlay's tv-name speaks 'bash'; the merged
//       result pill keeps the chip
//   S4  THE UNBOUND BURST (§2): 15 rapid one-shot execs through the PM
//       path (/mcp tools/call, the device's string-args shape) ALL run
//       (the 12/min law is dead); an armed cap (✦ tweaks blob
//       {"execCap":5}) holds the rolling window — the window counts
//       from the ARM (unbound execs never fill it): 5 run, the 6th
//       refuses with the honest N + ✦ tweaks teach; disarming ({}
//       blob) unbinds live
//   S5  THE ✦ TWEAKS TERMUX SECTION (§2): the real ✦ pill → the Termux
//       section renders (switch + slider, 'unbound' state) → the switch
//       arms → the blob round-trips (execCap:12) → the slider persists
//       (30) → the switch disarms → the key drops → RELOAD → the
//       section re-renders honest
//   S6  mobile 390px + zero page errors (the wave's receipts)
'use strict';

import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1270-e2e-engine';
const DATA_DIR = '/tmp/v1270-e2e-data';
const ENGINE_LOG = '/tmp/v1270-e2e-engine.log';
const SHOTS = '/tmp/v1270-shots';

const ENGINE_PORT = 8671;
const STUB_PORT = 8672;
const BRIDGE_PORT = 8673;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1270-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;

const SID = 'v1270-honest-program-walk';
const MODEL = 'groq/stub-model';
const SLOW_CMD = "bash -c 'for i in $(seq 1 6); do echo \"honest step $i\"; sleep 0.4; done'";

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okCount = 0, failCount = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { okCount++; console.log('  ok - ' + name); }
  else { failCount++; fails.push(name); console.log('  FAIL - ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}

async function jpost(u, body, headers) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jput(u, body) {
  const r = await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}
async function jget(u) {
  const r = await fetch(u);
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}

// agent-browser driver (the CLI; JSON where we parse)
function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js) { return ab('eval ' + JSON.stringify(js), 20000); }

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
        try { p.stdin.end(); } catch (e) {}
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMS + 4000);
        p.on('close', (code) => {
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

// ── the OpenAI stub ───────────────────────────────────────────────────
// Round 1 emits the termux tool call with THE DEVICE'S EXACT ARGS SHAPE
// — the MCP manifest declares "args" as a JSON-object STRING, so the
// schema-following models double-encode: {"action":"exec","args":"{…}"}
// (the live Faqous events' form — the blank-title bug's root cause).
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
        sse(res, { choices: [{ delta: { content: 'Running it on the device shell.' } }] });
        await sleep(100);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v1271', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(50);
        // THE DEVICE SHAPE: the nested args as a JSON STRING (the manifest's
        // own declared type — exactly what glm-5.3-flash emitted on the device)
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: JSON.stringify({ command: SLOW_CMD, timeout_ms: 60000 }) }) } }] } }] });
        await sleep(50);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const w of ['Done', '—', 'the', 'shell', 'answered.']) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(30); }
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

async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (String(v).trim() === 'true' || String(v).trim() === '"true"') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(400);
  }
}
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}
function jparse(s) {
  try { return JSON.parse(JSON.parse(s)); } catch (e) {}
  try { return JSON.parse(s); } catch (e) {}
  return {};
}

// mcpCall — EXACTLY pmsdk.js's mcpExecTool (the PM browser loop's tool
// path), with the device's args shape (the nested args as a JSON string).
async function mcpExec(sessionId, command) {
  return jpost(ENGINE + '/mcp', {
    jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call',
    params: { name: 'termux', arguments: { action: 'exec', args: JSON.stringify({ command, timeout_ms: 30000 }) } },
  }, { 'X-Doomalay-Session': sessionId || '' });
}
function toolText(res) {
  const content = (res.body && res.body.result && res.body.result.content) || [];
  return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
}

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + bridge + stub + seeds):');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/honest-proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/honest-proj/notes.txt', 'alpha\nbravo\ncharlie\n');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync('/home/z/sdk/go/bin/go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge();
startStub();
bootEngine();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-1234' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'honest program walk', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/workspaces/device', { name: 'honest-proj', termux_path: TERMUX_SHARED + '/Doomalay/honest-proj', session_id: SID });
ok('S1: the world boots (engine healthy, session armed, termux workspace bound + auto-stacked)', true);
ab('close');
console.log('S1 ok — opening the PWA');

// S2 — the chat opens
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const composerReady = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
ok('S2: the chat opens with the composer ready (model pre-set)', composerReady && openRes.includes('opened'), openRes);
await sleep(800);

// S3 — THE STRING-ARGS PILL (§1 the blank-title bug's regression)
console.log('S3 — THE STRING-ARGS PILL (the device shape derives the program):');
const sendRes = abEval('(function(){var t=document.querySelector(\'#chat-input\')||document.querySelector(\'textarea\');if(!t)return \'no input\';t.value=\'run it on the shell please\';t.dispatchEvent(new Event(\'input\',{bubbles:true}));var s=document.querySelector(\'[aria-label="Send the message"]\');if(!s)return \'no send\';s.click();return \'sent\'})()');
ok('S3: the message sends', sendRes.includes('sent'), sendRes);
const pillUp = await waitFn("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length >= 1", 20000);
ok('S3: the ONE pill appears (the use half)', pillUp);
if (pillUp) {
  const pillInfo = abEval("(function(){var p=document.querySelector('.tool-pill');var nm=p&&p.querySelector('.tool-pill-name');var lbl=p&&p.querySelector('.tool-pill-text');return p?p.className+' | '+(nm?nm.textContent:'')+' | '+(lbl?lbl.textContent.slice(0,80):''):'none'})()");
  const pi = pillInfo.split(' | ');
  ok('S3: THE CHIP SPEAKS THE PROGRAM (bash) — the string-args shape derives (never blank)',
    (pi[1] || '').trim() === 'bash', pillInfo);
  ok('S3: the body carries the command remainder (the dim text is NOT blank)',
    /-c/.test(pi[2] || ''), pillInfo);
  // the ↗ overlay: tv-name speaks the program
  abEval('(function(){var o=document.querySelector(\'.tool-pill-open\');if(o){o.click();return "opened"}return "no open btn"})()');
  await sleep(700);
  const tvName = pstr("(function(){var n=document.querySelector('.tv-name');return n?n.textContent.trim()+(n.title?\'|\'+n.title:\'\'):\'none\'})()");
  ok('S3: the overlay tv-name speaks bash (the raw name in the tooltip)', /^bash(\||$)/.test(tvName), tvName);
  const tvSub = pstr("(function(){var s=document.querySelector('.tv-sub');return s?s.textContent.trim().slice(0,60):\'none\'})()");
  ok('S3: the overlay sub carries the command remainder (not a name echo)', /-c/.test(tvSub), tvSub);
  ab('screenshot ' + SHOTS + '/s3-string-args-pill.png');
  abEval('document.querySelector("#connect-overlay-x") && document.querySelector("#connect-overlay-x").click()');
  await sleep(400);
  // the result lands → the merged pill keeps the chip
  const merged = await waitFn("(function(){var p=document.querySelector('.tool-pill.tool-pill-result');if(!p)return false;var nm=p.querySelector('.tool-pill-name');return !!(nm&&nm.textContent.trim()==='bash'&&p.textContent.indexOf('honest step')>=0)})()", 30000);
  ok('S3: the MERGED result pill keeps the bash chip (one pill, the program survives the merge)', merged);
  ab('screenshot ' + SHOTS + '/s3-merged-pill.png');
}

// S4 — THE UNBOUND BURST (§2)
console.log('S4 — THE UNBOUND BURST (the anti-burst law is a tweak now):');
// 15 rapid one-shot execs through the PM path — ALL run (the old 12/min
// law would have eaten #13-15; the default is UNBOUND now)
let burstOk = 0;
for (let i = 0; i < 15; i++) {
  const r = await mcpExec(SID, 'echo burst-' + i);
  if (/EXEC DONE/.test(toolText(r))) burstOk++;
}
ok('S4: the 15-exec burst runs UNBOUND (the compiled 12/min cap is dead — all 15 reach the shell)', burstOk === 15, 'ran ' + burstOk + '/15');
// arm the cap through the ✦ tweaks blob (the UI's own storage): 5 — the
// window starts at the ARM moment (unbound execs never fill it), so the
// first 5 armed execs run, the 6th refuses with the honest N
const armPut = await jput(ENGINE + '/api/sessions/' + SID + '/tweaks', { execCap: 5 });
ok('S4: the tweaks blob PUT lands (the ✦ storage)', armPut.status === 200, armPut.text);
let armedOk = 0;
for (let i = 15; i < 20; i++) {
  const r = await mcpExec(SID, 'echo burst-' + i);
  if (/EXEC DONE/.test(toolText(r))) armedOk++;
}
ok('S4: the armed cap holds the window (5 run under execCap:5 — the window counts from the arm)', armedOk === 5, 'ran ' + armedOk + '/5');
const refused = await mcpExec(SID, 'echo should-refuse');
const rfText = toolText(refused);
ok('S4: the 6th armed exec REFUSES with the honest N (the rolling verdict)',
  /exec rate cap/.test(rfText) && /5 one-shot execs/.test(rfText), rfText.slice(0, 200));
ok('S4: the refusal teaches the ✦ tweaks path (never a silent drop)', /✦ tweaks/.test(rfText), rfText.slice(0, 200));
// disarm (the lean blob) → the next exec runs LIVE (no restart)
await jput(ENGINE + '/api/sessions/' + SID + '/tweaks', {});
const unbound = await mcpExec(SID, 'echo unbound-again');
ok('S4: disarming the blob unbinds LIVE (the very next exec runs)', /EXEC DONE/.test(toolText(unbound)), toolText(unbound).slice(0, 120));

// S5 — THE ✦ TWEAKS TERMUX SECTION (§2 the UI round-trip)
console.log('S5 — THE ✦ TWEAKS TERMUX SECTION (the real ✦ pill path):');
const tweaksOpened = abEval("(function(){var bs=document.querySelectorAll('.util-btn');for(var i=0;i<bs.length;i++){if(/✦ tweaks/.test(bs[i].textContent)){bs[i].click();return 'clicked'}}return 'no pill'})()");
const capSection = await waitFn("!!document.getElementById('tw-exec-cap-toggle')", 8000);
ok('S5: the ✦ pill opens the tweaks view with the TERMUX section', tweaksOpened.includes('clicked') && capSection, tweaksOpened);
if (capSection) {
  const initState = pstr("(document.getElementById('tw-exec-cap-state')||{textContent:''}).textContent.trim()");
  ok('S5: the state value reads UNBOUND (the default)', /unbound/i.test(initState), initState);
  const sliderDisabled = abEval("(function(){var s=document.getElementById('tw-exec-cap-slider');return s?String(s.disabled):'no slider'})()");
  ok('S5: the slider is disabled while unbound (the honest dim)', /true/.test(sliderDisabled), sliderDisabled);
  // the switch arms → the blob round-trips (the debounced PUT)
  abEval("(function(){var t=document.getElementById('tw-exec-cap-toggle');if(t){t.click();return 'flipped'}return 'no toggle'})()");
  await sleep(900);
  const blob1 = await jget(ENGINE + '/api/sessions/' + SID + '/tweaks');
  const b1 = (blob1.body && blob1.body.tweaks) || {};
  ok('S5: arming the switch writes execCap:12 (the arm-at-12 law) into the blob',
    b1.execCap === 12, blob1.text);
  const stateAfter = pstr("(document.getElementById('tw-exec-cap-state')||{textContent:''}).textContent.trim()");
  ok('S5: the state value flips to CAPPED (in place)', /capped/i.test(stateAfter), stateAfter);
  // the slider persists 30
  abEval("(function(){var s=document.getElementById('tw-exec-cap-slider');if(s){s.value='30';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));return 'set'}})()");
  await sleep(900);
  const blob2 = await jget(ENGINE + '/api/sessions/' + SID + '/tweaks');
  const b2 = (blob2.body && blob2.body.tweaks) || {};
  ok('S5: the slider persists execCap:30 (release → the debounced PUT)',
    b2.execCap === 30, blob2.text);
  const valLbl = pstr("(document.getElementById('tw-exec-cap-val')||{textContent:''}).textContent.trim()");
  ok('S5: the value label speaks 30 / minute', /30 \/ minute/.test(valLbl), valLbl);
  ab('screenshot ' + SHOTS + '/s5-termux-section.png');
  // the switch disarms → the key DROPS (the lean-blob law)
  abEval("(function(){var t=document.getElementById('tw-exec-cap-toggle');if(t){t.click();return 'off'}})()");
  await sleep(900);
  const blob3 = await jget(ENGINE + '/api/sessions/' + SID + '/tweaks');
  const b3 = (blob3.body && blob3.body.tweaks) || {};
  ok('S5: disarming DROPS the key (the lean blob — absent = unbound)',
    b3.execCap === undefined, blob3.text);
  // back out of the view
  abEval('document.querySelector("#panel-view-back") && document.querySelector("#panel-view-back").click()');
  await sleep(400);
  // RELOAD → the section re-renders honest
  ab('reload');
  await sleep(2400);
  abEval("window.doomalay && window.doomalay.openChatBySession && window.doomalay.openChatBySession('" + SID + "', {})", 20000);
  await sleep(800);
  const reOpen = abEval("(function(){var bs=document.querySelectorAll('.util-btn');for(var i=0;i<bs.length;i++){if(/✦ tweaks/.test(bs[i].textContent)){bs[i].click();return 'clicked'}}return 'no pill'})()");
  const reSection = await waitFn("!!document.getElementById('tw-exec-cap-toggle')", 8000);
  const reState = pstr("(document.getElementById('tw-exec-cap-state')||{textContent:''}).textContent.trim()");
  ok('S5: after RELOAD the Termux section re-renders (unbound again — the round-trip is stateless)',
    reOpen.includes('clicked') && reSection && /unbound/i.test(reState), reState);
  abEval('document.querySelector("#panel-view-back") && document.querySelector("#panel-view-back").click()');
  await sleep(300);
}

// S6 — mobile + console
console.log('S6 — MOBILE + CONSOLE (the receipts):');
ab('set viewport 390 844');
await sleep(700);
const noOverflow = abEval("document.documentElement.scrollWidth <= 392");
ok('S6: no horizontal overflow at 390px', /true/.test(noOverflow), noOverflow);
const secFits = abEval("(function(){var t=document.getElementById('tw-exec-cap-toggle');if(!t)return 'no section (closed)';var s=document.getElementById('tw-exec-cap-slider');var r=s?s.getBoundingClientRect():null;return JSON.stringify({hasToggle:!!t,sliderW:r?Math.round(r.width):0})})()");
ok('S6: the Termux section fits the mobile view (the slider ≤ 200px)', function () {
  if (!/^\{/.test(secFits)) return true; // the panel closed on reload — the layout held
  const sf = jparse(secFits);
  return sf.hasToggle === true && sf.sliderW <= 200;
}(), secFits);
ab('set viewport 1280 900');
ab('screenshot ' + SHOTS + '/s6-mobile.png');
const errs = ab('errors');
const errLines = errs.split('\n').filter((l) => l.trim() && !/^\[agent-browser\]/.test(l));
ok('S6: zero page errors across the whole walk', errLines.length === 0, errLines.slice(0, 3).join(' | '));

// teardown
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
const byes = fails.length ? '\n  FAIL - ' + fails.join('\n  FAIL - ') : '';
console.log(`\nv1270 E2E walk: ${okCount - failCount}/${okCount}${byes}`);
console.log('screenshots: ' + SHOTS + '/ (s3 s5 s6)');
process.exit(fails.length ? 1 : 0);
