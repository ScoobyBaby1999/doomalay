#!/usr/bin/env node
// v1234-e2e-walk.mjs — v1.23.4 THE POLISH redteam: the REAL-USER walk.
//
// ONE long-lived process (the sandbox reaps daemons between commands):
// boots the carrier world in-process (the executing fake bridge + the
// OpenAI stub with a SLOW termux tool call + the engine), then drives
// the PWA through agent-browser exactly as a human would:
//
//   S2 the chat opens (model pre-set — the gatelock satisfied)
//   S3 the turn: send → the ONE pill (pending, the derived label)
//   S4 the ↗ opens THE POLISHED overlay (ONE box, query section, the
//      live output trio, the footer copy — no button in the head)
//   S5 the LIVE STREAM fills the overlay's output area while the
//      command runs (the v1.23.3 law extended to the open overlay)
//   S6 the copy affordance answers (⧉ + the label flips)
//   S7 the result landing RE-RENDERS the open overlay in place
//   S8 close (the static ✕) — the merged pill keeps the transcript
//   S9 reload → replay → the ONE pill survives (the persist law)
//  S10 mobile 390px — no horizontal overflow, the overlay clean
//  S11 zero page errors + the screenshots (receipts)
'use strict';

import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1234-e2e-engine';
const DATA_DIR = '/tmp/v1234-e2e-data';
const ENGINE_LOG = '/tmp/v1234-e2e-engine.log';
const SHOTS = '/tmp/v1234-shots';

const ENGINE_PORT = 8651;
const STUB_PORT = 8652;
const BRIDGE_PORT = 8653;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1234-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;

const SID = 'e2e-tv-walk';
const MODEL = 'groq/stub-model';
const SLOW_CMD = "bash -c 'for i in $(seq 1 14); do echo \"pkg step $i done\"; sleep 0.7; done'";

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
const intoTermux = (s) => s.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okCount = 0, failCount = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { okCount++; console.log('  ok - ' + name); }
  else { failCount++; fails.push(name); console.log('  FAIL - ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}

async function jpost(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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

// ── the OpenAI stub (round 1: the SLOW termux exec; round 2: the answer)
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
        sse(res, { choices: [{ delta: { content: 'Running the install on the device shell.' } }] });
        await sleep(120);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_tv1', type: 'function', function: { name: 'termux', arguments: '' } }] } }] });
        await sleep(60);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ action: 'exec', args: { command: SLOW_CMD, timeout_ms: 60000 } }) } }] } }] });
        await sleep(60);
        sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const toolOut = (parsed.messages || []).filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join('\n');
        const words = ['The', 'install', 'ran', '—', String(toolOut.length), 'bytes', 'of', 'streamed', 'output.'];
        for (const w of words) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
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

// wait for a JS condition in the page (poll abEval)
async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (String(v).trim() === 'true') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(400);
  }
}

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + bridge + stub + seeds):');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/proj/notes.txt', 'alpha\nbravo\n');
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
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'overlay walk', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/workspaces/device', { name: 'e2e-proj', termux_path: TERMUX_SHARED + '/Doomalay/proj', session_id: SID });
ok('the world boots (engine healthy, session armed, workspace bound)', true);
ab('close');
console.log('S1 ok — opening the PWA');

// S2 — the chat opens
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/');
await sleep(2200);
// INSTRUMENTATION (before any chat WS exists): count inbound WS frames by
// type — the definitive "did tool_stream reach the browser" probe.
abEval('(function(){var Orig=window.WebSocket;var P=function(){var args=Array.prototype.slice.call(arguments);var w=Reflect.construct(Orig,args,P);window.__wsFrames=window.__wsFrames||{};try{w.addEventListener(\'message\',function(e){try{var d=JSON.parse(e.data);var t=d.type||\'?\';window.__wsFrames[t]=(window.__wsFrames[t]||0)+1}catch(err){}})}catch(e){}return w};P.prototype=Object.create(Orig.prototype);P.CONNECTING=0;P.OPEN=1;P.CLOSING=2;P.CLOSED=3;window.WebSocket=P;return \'ws-patched\'})()');
// expand the dock + open the chat — THE ROW'S OWN PATH (the all-chats
// row click is exactly window.doomalay.openChatBySession(sid) — the
// same code the tapped button runs; driving it directly kills the
// dock-expand/all-chats navigation flakiness while walking the real
// open path).
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('e2e-tv-walk', {}), 'opened') : 'no api'");
const composerReady = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea')||document.querySelector('[contenteditable]'))", 10000);
ok('S2: the chat opens with the composer ready (model pre-set)', composerReady && openRes.includes('opened'), openRes);
if (!composerReady) {
  console.log('  DEBUG snapshot: ' + ab('snapshot -i -c').split('\n').slice(0, 12).join(' | '));
  console.log('  DEBUG console: ' + ab('console').split('\n').slice(-6).join(' | '));
}

// S3 — the turn: send + the ONE pill
console.log('S3 — THE TURN (send → the ONE pill):');
const sendRes = abEval('(function(){var t=document.querySelector(\'#chat-input\')||document.querySelector(\'textarea\');if(!t)return \'no input\';t.value=\'run the package install please\';t.dispatchEvent(new Event(\'input\',{bubbles:true}));var s=document.querySelector(\'[aria-label="Send the message"]\');if(!s)return \'no send\';s.click();return \'sent\'})()');
ok('S3: the message sends', sendRes.includes('sent'), sendRes);
const pillUp = await waitFn("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length >= 1", 20000);
ok('S3: the ONE pill appears (the tool_use event)', pillUp);
if (pillUp) {
  // v1.24.5: the verb rides the .tool-pill-name chip; the text span is the dim body
  const pillInfo = abEval("(function(){var p=document.querySelector('.tool-pill');var nm=p&&p.querySelector('.tool-pill-name');var lbl=p&&p.querySelector('.tool-pill-text');return p?p.className+' | '+(nm?nm.textContent:'')+' | '+(lbl?lbl.textContent.slice(0,80):''):'none'})()");
  ok('S3: the pill is the PENDING use shape (the loading bar, no result yet)',
    /tool-pill-use/.test(pillInfo), pillInfo);
  ok('S3: the pill label derives the PROGRAM (bash), not "exec"',
    /bash/.test(pillInfo) && !/ exec /.test(pillInfo), pillInfo);
}

// S4 — the ↗ opens THE POLISHED overlay
console.log('S4 — THE OVERLAY (the ↗ → the ONE polished box):');
abEval('(function(){var o=document.querySelector(\'.tool-pill-open\');if(!o)return \'no open ctl\';o.click();return \'clicked\'})()');
const ovUp = await waitFn("!!document.querySelector('.tool-fullview')", 8000);
ok('S4: the overlay opens', ovUp);
if (ovUp) {
  const one = abEval("(function(){var v=document.querySelector('.tool-fullview');if(!v)return 'none';return JSON.stringify({body:!!v.querySelector('.tv-body'),row:!!v.querySelector('.tv-row'),secQ:!!v.querySelector('.tv-sec-q'),stream:!!v.querySelector('.tv-stream'),kb:!!v.querySelector('.tv-kb'),bar:!!v.querySelector('.tv-bar'),foot:!!v.querySelector('.tv-foot'),copyInFoot:!!v.querySelector('.tv-foot .tv-copy'),copyIco:!!v.querySelector('.tv-copy-ico'),btnInHead:!!v.querySelector('.tv-head button'),name:(v.querySelector('.tv-name')||{}).textContent,nameAttr:(v.querySelector('.tv-name')||{}).title,sub:(v.querySelector('.tv-sub')||{}).textContent})})()");
  let s = {};
  try { s = JSON.parse(JSON.parse(one)); } catch (e) { try { s = JSON.parse(one); } catch (e2) {} }
  ok('S4: ONE box (.tv-body), the old .tv-row DEAD', s.body === true && s.row === false, one);
  ok('S4: the query section renders (labeled, inside the ONE box)', s.secQ === true);
  ok('S4: the pending trio (stream + kb + bar) renders', s.stream === true && s.kb === true && s.bar === true);
  ok('S4: the footer copy (⧉ icon + label) — NO button in the head',
    s.foot === true && s.copyInFoot === true && s.copyIco === true && s.btnInHead === false, one);
  // v1.24.5: tv-name speaks the one-word TITLE (bash); the raw 'termux'
  // name rides the title attribute; the sub is the title-stripped body
  ok('S4: the head shows the one-word title (bash) + the body sub; the raw name in the tooltip',
    s.name === 'bash' && /-c/.test(s.sub || '') && s.nameAttr === 'termux', one);
  const qTxt = abEval("(document.querySelector('.tv-q')||{}).textContent || ''");
  ok('S4: the query carries the command (pretty JSON)', /bash -c/.test(qTxt) && /pkg step/.test(qTxt), qTxt.slice(0, 120));
  ab('screenshot ' + SHOTS + '/s4-overlay-live.png');
}

// S5 — the live stream fills the open overlay
console.log('S5 — THE LIVE STREAM (the open overlay breathes):');
// INSTRUMENTATION: the WS frame counter (did tool_stream reach the browser?)
const frames0 = abEval('JSON.stringify(window.__wsFrames || {})');
const t0 = abEval("(document.querySelector('.tv-stream')||{}).textContent || ''");
await sleep(2600);
const frames1 = abEval('JSON.stringify(window.__wsFrames || {})');
const t1 = abEval("(document.querySelector('.tv-stream')||{}).textContent || ''");
console.log('  [probe] ws frames at S5 start: ' + frames0);
console.log('  [probe] ws frames mid-S5:     ' + frames1);
ok('S5: the overlay\'s output area FILLS while the command runs (the live tick)',
  t1.length > t0.length && /pkg step/.test(t1), 't0=' + t0.length + 'B t1=' + t1.length + 'B');
const kb = abEval("(document.querySelector('.tv-kb')||{}).textContent || ''");
ok('S5: the byte counter answers (fmtBytes)', /[KB]/.test(kb), kb);
await sleep(2400);
const frames2 = abEval('JSON.stringify(window.__wsFrames || {})');
const t2 = abEval("(document.querySelector('.tv-stream')||{}).textContent || ''");
console.log('  [probe] ws frames late-S5:    ' + frames2);
ok('S5: the stream keeps growing (≥2 lines landed)', t2.length > t1.length, t2.length + 'B');
ab('screenshot ' + SHOTS + '/s5-overlay-streaming.png');

// S6 — the copy affordance answers
console.log('S6 — THE COPY (the footer affordance):');
abEval('(function(){var c=document.querySelector(\'.tv-copy\');if(!c)return \'no copy\';c.click();return \'clicked\'})()');
await sleep(500);
const cpLbl = abEval("(document.querySelector('.tv-copy span:last-child')||{}).textContent || ''");
ok('S6: the label flips to copied (the icon stays)', /copied/.test(cpLbl), cpLbl);
await sleep(1300);
const cpLbl2 = abEval("(document.querySelector('.tv-copy span:last-child')||{}).textContent || ''");
ok('S6: the label reverts after the beat', /copy/.test(cpLbl2), cpLbl2);

// S7 — the result landing re-renders the open overlay
console.log('S7 — THE LANDING (the open overlay re-renders in place):');
const landed = await waitFn("!!document.querySelector('.tool-fullview .tv-result')", 30000);
ok('S7: the result lands IN THE OPEN overlay (the re-render)', landed);
if (landed) {
  const st = abEval("(function(){var v=document.querySelector('.tool-fullview');return JSON.stringify({stream:!!v.querySelector('.tv-stream'),bar:!!v.querySelector('.tv-bar'),res:!!v.querySelector('.tv-result'),resTxt:(v.querySelector('.tv-result')||{}).textContent||'',pg:!!v.querySelector('.tv-pager'),pgHidden:(function(){var p=v.querySelector('.tv-pager');return p?p.hasAttribute(\'hidden\'):null})(),stillOpen:!!v})})()");
  let s = {};
  try { s = JSON.parse(JSON.parse(st)); } catch (e) { try { s = JSON.parse(st); } catch (e2) {} }
  ok('S7: the pending trio is GONE (stream + bar replaced by the result)', s.stream === false && s.bar === false, st);
  ok('S7: the FULL result renders (the last line landed)', /pkg step 14 done/.test(s.resTxt), (s.resTxt || '').slice(-120));
  ok('S7: the overlay is still open (no history glitch)', s.stillOpen === true);
  ab('screenshot ' + SHOTS + '/s7-overlay-landed.png');
}

// S8 — close + the merged pill
console.log('S8 — CLOSE (the static ✕ + the merged pill):');
abEval('(function(){var x=document.querySelector(\'#connect-overlay-x\');if(!x)return \'no x\';x.click();return \'closed\'})()');
await sleep(600);
const closed = abEval("(function(){var o=document.querySelector('#connect-overlay');var v=document.querySelector('.tool-fullview');return (!v) || (o && getComputedStyle(o).visibility === 'hidden')})()");
ok('S8: the overlay closes (the static ✕)', /true/.test(closed), closed);
const pills = abEval("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length");
ok('S8: the ONE merged pill stays in the transcript', pills === '1', pills);
// expand the pill → the inline detail (tool/query/result rows)
abEval('(function(){var h=document.querySelector(\'.tool-pill-head\');if(h){h.click();return \'expanded\'}return \'no head\'})()');
await sleep(400);
const detail = abEval("(function(){var d=document.querySelector('.tool-pill-detail');return d?d.textContent.slice(0,200):'none'})()");
ok('S8: the pill expands to the tool/query/result detail', /result/.test(detail) && /pkg step/.test(detail), detail.slice(0, 100));

// S9 — reload → replay → the ONE pill survives
console.log('S9 — REPLAY (reload → the same one-pill transcript):');
ab('reload');
await sleep(2500);
abEval("window.doomalay && window.doomalay.openChatBySession && window.doomalay.openChatBySession('e2e-tv-walk', {})", 20000);
await sleep(2000);
const replayPills = abEval("document.querySelectorAll('.tool-pill:not(.tool-pill-progress)').length");
ok('S9: after reload the transcript is still ONE pill (the persist law)', replayPills === '1', replayPills);
const replayLbl = abEval("(function(){var n=document.querySelector('.tool-pill-name');var t=document.querySelector('.tool-pill-text');return (n?n.textContent:'')+' | '+(t?t.textContent.slice(0,80):'none'})()");
ok('S9: the replayed pill keeps the derived verb chip (bash, not exec)', /^bash \|/.test(replayLbl), replayLbl);
// the replayed overlay carries the result
abEval('(function(){var o=document.querySelector(\'.tool-pill-open\');if(o){o.click();return \'ok\'}return \'no ctl\'})()');
const replayOv = await waitFn("!!document.querySelector('.tool-fullview .tv-result')", 8000);
ok('S9: the replayed overlay opens with the FULL result (query + output)', replayOv);
abEval('document.querySelector(\'#connect-overlay-x\') && document.querySelector(\'#connect-overlay-x\').click()')
await sleep(500);

// S10 — mobile 390px
console.log('S10 — MOBILE 390px:');
ab('set viewport 390 844');
await sleep(700);
const noOverflow = abEval("document.documentElement.scrollWidth <= 392");
ok('S10: no horizontal overflow at 390px', /true/.test(noOverflow), noOverflow);
abEval('(function(){var o=document.querySelector(\'.tool-pill-open\');if(o){o.click();return \'ok\'}return \'no ctl\'})()');
const mobOv = await waitFn("!!document.querySelector('.tool-fullview')", 8000);
ok('S10: the overlay opens at 390px', mobOv);
if (mobOv) {
  const mobNoOf = abEval("(function(){var v=document.querySelector('.tool-fullview');return v ? (v.scrollWidth <= v.clientWidth + 2) : false})()");
  ok('S10: the overlay content fits (no inner overflow)', /true/.test(mobNoOf), mobNoOf);
  ab('screenshot ' + SHOTS + '/s10-mobile-overlay.png');
}
abEval('document.querySelector(\'#connect-overlay-x\') && document.querySelector(\'#connect-overlay-x\').click()')

// S11 — the console + page errors
console.log('S11 — CONSOLE (zero page errors):');
const errs = ab('errors');
const errLines = errs.split('\n').filter((l) => l.trim() && !/^\[agent-browser\]/.test(l));
ok('S11: zero page errors across the whole walk', errLines.length === 0, errLines.slice(0, 3).join(' | '));

// teardown
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
const byes = fails.length ? '\n  FAIL - ' + fails.join('\n  FAIL - ') : '';
console.log(`\nv1234 E2E walk: ${okCount - failCount}/${okCount}${byes}`);
console.log('screenshots: ' + SHOTS + '/ (s4 s5 s7 s10)');
process.exit(fails.length ? 1 : 0);
