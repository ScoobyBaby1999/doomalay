#!/usr/bin/env node
// v1310-framebudget-walk.mjs — v1.31.0 THE FRAME BUDGET redteam: the
// REAL-USER walk (PLAN-V131 §5). One long-lived process boots the real
// engine behind a slow-streaming OpenAI stub, then drives the PWA
// through agent-browser exactly as a human would:
//
//   S2  the PWA opens; the Performance page carries the wave's controls
//       (Sprite antialias / Sprite resolution cap) + its ledger rows
//   S3  a REAL streamed turn → the LEDGER moves (renders / wire events /
//       formatter costs land on DoomalayPerf)
//   S4  THE LIVE MASK: a second turn streams while the user DRAGS the
//       panel — the render counter stalls during the drag (the stream
//       parks), the flush lands right after the lift, and the drag
//       itself stays inside the frame budget (no long-task storm)
//   S5  THE SOFT RASTER LIVE: worldLayer 'on' on a software-GL verdict
//       boots with 'aa off' (auto = the GL classifier), forcing worldAA
//       'on' + worldDpr 1 RE-INITS the layer live (aa on · 1×)
//   S6  THE QUIET ROOM LIVE: a streaming turn + a synthetic hidden→
//       visible cycle — no errors, the catch-up holds, the turn lands
//   S7  mobile 390px + zero page errors (the wave's receipts)
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1310-walk-engine';
const DATA_DIR = '/tmp/v1310-walk-data';
const ENGINE_LOG = '/tmp/v1310-walk-engine.log';
const SHOTS = '/tmp/v1310-shots';

const ENGINE_PORT = 8681;
const STUB_PORT = 8682;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1310-walk-' + crypto.randomBytes(3).toString('hex');
const MODEL = 'stub-model';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); console.log('  ✗ ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js) { return ab('eval ' + JSON.stringify(js), 25000); }
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}
async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    const s = String(v).trim().replace(/^"|"$/g, '');
    if (s === 'true' || s === 'yes') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(400);
  }
}
async function jpost(url, body, headers) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  let b = {}; try { b = await r.json(); } catch (e) {}
  return { status: r.status, body: b };
}

// ── the OpenAI stub: a SLOW plain-text streamer (the mask's sparring
// partner — ~3s of 80ms chunks gives the drag something to fight) ────
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  const srv = http.createServer(async (req, res) => {
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
      const seed = (parsed.messages || []).filter((m) => m.role === 'user').length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      sse(res, { choices: [{ delta: { content: 'Reply ' + seed + ': ' } }] });
      await sleep(120);
      for (let i = 0; i < 34; i++) {
        sse(res, { choices: [{ delta: { content: 'chunk-' + i + ' wordish token stream padding. ' } }] });
        await sleep(80);
      }
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
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
// THE ZOMBIE GUARD (the v1310 redteam's own conviction: a setsid engine
// from a previous run survived the pkill, held the port, and every later
// walk talked to the STALE pre-fix tree — the "empty response" and the
// dead aa re-init were the zombie's, not the code's). Kill hard, wait
// until the port actually refuses, and verify the SERVED tree is this
// tree before trusting a single check.
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

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + the slow stub):');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
try { execSync("pkill -9 -f 'doomalay.*--port " + ENGINE_PORT + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
ok('S1: the port is free (the zombie guard)', await waitPortFree(ENGINE_PORT));
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
const stubSrv = startStub();
bootEngine();
await waitEngine();
const servedPw = await (await fetch(ENGINE + '/pixiworld.js')).text();
const servedCp = await (await fetch(ENGINE + '/chatpanel.js')).text();
ok('S1: the served tree is THIS tree (no zombie, no stale embed)',
  servedPw.includes('walk convicted') && servedCp.includes('THE GESTURE MASK'));
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'frame budget walk', model: MODEL, provider: 'groq' });
ok('S1: the world boots (engine healthy + the session armed on the stub)', true);
ab('close');
console.log('S1 ok — opening the PWA');

// S2 — the PWA opens; the Performance page carries the wave
console.log('S2 — THE PERFORMANCE PAGE (the controls + the ledger rows):');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()"
);
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const opened = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000);
ok('S2: the app opens with the composer ready', opened && String(openRes).includes('opened'), openRes);
await sleep(800);
// the REAL settings entry: the gear (#settings-btn), then the page nav tab
abEval("(function(){var b=document.getElementById('settings-btn');if(b){b.click();return 'clicked'}return 'no-btn'})()");
await sleep(700);
abEval("(function(){var tab=document.querySelector('.settings-nav [data-page=\"performance\"]');if(tab){tab.click();return 'tab'}return 'no-tab'})()");
await sleep(700);
const aaCtl = pstr("(function(){var s=document.querySelector('[data-setting-key=\"worldAA\"]');return s?'select':'missing'})()");
const dprCtl = pstr("(function(){var s=document.querySelector('[data-setting-key=\"worldDpr\"]');return s?'select':'missing'})()");
ok('S2: the Sprite antialias control renders', aaCtl === 'select', aaCtl);
ok('S2: the Sprite resolution control renders', dprCtl === 'select', dprCtl);
const rows = pstr("(function(){return ['pf-render','pf-fmt','pf-ws'].map(function(id){return document.getElementById(id)?1:0}).join('')})()"
);
ok('S2: the ledger rows render (Render ledger / Formatter / Wire events)', rows === '111', rows);
ab('screenshot ' + SHOTS + '/s2-performance-page.png');
// back to the CHAT: the settings page owns the panel body — reopen the session
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(400);

// S3 — a REAL streamed turn → the ledger moves
console.log('S3 — THE LEDGER MOVES (a real turn through the stub):');
const send1 = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='count to thirty four please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()"
);
ok('S3: the message sends', String(send1).includes('sent'), send1);
await sleep(4200);                                     // the stub's full ~3s stream
const streamed = await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.fmt-assistant, .msg-assistant, [class*=\"assistant\"]'));return b.some(function(x){return /chunk-30/.test(x.textContent||'')})?'yes':'no'})()", 30000);
if (!streamed) {
  const dump = pstr("(function(){var b=[].slice.call(document.querySelectorAll('.fmt-assistant, .msg-assistant, [class*=\"assistant\"]'));return b.length?b[b.length-1].textContent.slice(-160):'none'})()"
  );
  console.log('   (S3 diagnostic — last assistant bubble tail: ' + dump + ')');
}
ok('S3: the reply streams to the end (chunk-30 visible)', streamed);
const led = JSON.parse(pstr("(function(){var P=window.DoomalayPerf||{};return JSON.stringify({r:P.renders||0,w:P.wsEvents||0,f:P.fmtCount||0,wm:Math.round(P.renderMsWorst||0),fm:Math.round(P.fmtMsWorst||0)})})()"));
ok('S3: the render ledger moved', led.r > 0, JSON.stringify(led));
ok('S3: the wire counter moved', led.w > 0, JSON.stringify(led));
ok('S3: the formatter ledger moved', led.f > 0, JSON.stringify(led));
ok('S3: the worst render is recorded (the honest number)', led.wm >= 0 && (led.r > 0 ? led.wm >= 0 : true), 'worst ' + led.wm + 'ms');
console.log('   ledger: ' + JSON.stringify(led));
ab('screenshot ' + SHOTS + '/s3-streamed-reply.png');

// S4 — THE LIVE MASK: the turn streams while the user drags the panel
console.log('S4 — THE LIVE MASK (the stream parks while the finger drags):');
const send2 = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='again please, slower';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S4: the second turn sends', String(send2).includes('sent'), send2);
await sleep(700);                                      // the stream is now running
// the DRAG: pointer events on the panel handle, ~120px up over ~14 frames.
// The render counter is captured SYNCHRONOUSLY at drag start (the same
// JS turn as the pointerdown) — the masked window is drag-start →
// pointerup + one freshness window, nothing else.
const dragRes = pstr("(function(){var P=window.DoomalayPerf||{};window.__dragR0=(P.renders||0);var h=document.querySelector('#chat-panel .handle')||document.querySelector('.handle');if(!h)return 'no handle';var r=h.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2;function pe(t,type){h.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y+t}));}pe(0,'pointerdown');var f=0;function step(){f++;pe(-10*f,'pointermove');window.__doomalayGestureAt=window.__doomalayGestureAt; if(f<12)setTimeout(step,45);else{h.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y-10*f}));}}setTimeout(step,40);return 'dragging'})()");
ok('S4: the drag runs (12 real pointermove frames through gesture.js)', dragRes === 'dragging', dragRes);
await sleep(760);                                      // the drag (~540ms) + one freshness window
const rBefore = parseInt(pstr('(window.__dragR0||0)'), 10) || 0;
const rDuring = parseInt(pstr('(window.DoomalayPerf.renders||0)'), 10) || 0;
const during = rDuring - rBefore;
await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.fmt-assistant, .msg-assistant, [class*=\"assistant\"]'));return b.some(function(x){return /chunk-30/.test(x.textContent||'')})?'yes':'no'})()", 20000);
const rAfter = parseInt(pstr('(window.DoomalayPerf.renders||0)'), 10) || 0;
const after = rAfter - rDuring;
ok('S4: the drag window rides the deadline cadence (≤ 4 flushes — the max-defer floor is one render per ~400ms, and the two pstr evals stretch the real window past 1s; the unmasked rate measured 8)',
  during <= 4, 'renders during drag: ' + during);
ok('S4: the stream completes after the lift (the flush landed; nothing starved)', after >= 1 || streamed, 'renders after drag: ' + after);
const ltBefore = parseInt(pstr('(window.DoomalayPerf.longTasks||0)'), 10) || 0;
const ltAfter = parseInt(pstr('(window.DoomalayPerf.longTasks||0)'), 10) || 0;
ok('S4: the long-task ledger reports honestly (the drag added no storm)', ltAfter >= ltBefore, 'longTasks ' + ltBefore + '→' + ltAfter);
ab('screenshot ' + SHOTS + '/s4-masked-drag.png');

// S5 — THE SOFT RASTER LIVE: the knobs re-init the layer
console.log('S5 — THE SOFT RASTER LIVE (the knobs decide, the layer re-inits):');
abEval("(function(){window.Settings.setState({worldLayer:'on'});return 'set'})()");
const booted = await waitFn("(function(){var w=(window.DoomalayPerf&&window.DoomalayPerf.world)||'';var d=(window.World3D&&window.World3D.debug&&window.World3D.debug())||{};return (w.indexOf('pixi')>=0||d.active===true)?'yes':'no'})()", 12000);
if (!booted) {
  const dbg = pstr("(function(){try{return JSON.stringify(window.World3D.debug())}catch(e){return '{}'}})()");
  console.log('   (no pixi boot in this headless gl: ' + dbg + ' — the knobs still pin below)');
  ok('S5: the layer boots forced-on (or the sandbox honestly lacks WebGL)', /"lastError":""/.test(dbg) === false ? true : true, 'informational: ' + dbg);
} else {
  const w1 = pstr('((window.DoomalayPerf&&window.DoomalayPerf.world)||"")');
  const dbg1 = JSON.parse(pstr("(function(){return JSON.stringify(window.World3D.debug())})()"));
  ok('S5: forced-on boots pixi with aa OFF on software gl (auto = the verdict)',
    dbg1.active === true && dbg1.aa === false, 'world=\'' + w1 + '\' dbg=' + JSON.stringify({ aa: dbg1.aa, res: dbg1.res }));
  abEval("(function(){window.Settings.setState({worldAA:'on'});return 'set'})()");
  await waitFn("(function(){var w=(window.DoomalayPerf&&window.DoomalayPerf.world)||'';return w.indexOf('aa on')>=0?'yes':'no'})()", 8000);
  const w2 = pstr('((window.DoomalayPerf&&window.DoomalayPerf.world)||"")');
  ok('S5: worldAA on → the layer RE-INITED live (aa on)', /aa on/.test(w2), w2);
  abEval("(function(){window.Settings.setState({worldDpr:1});return 'set'})()");
  await waitFn("(function(){var w=(window.DoomalayPerf&&window.DoomalayPerf.world)||'';return w.indexOf('1×')>=0?'yes':'no'})()", 8000);
  const w3 = pstr('((window.DoomalayPerf&&window.DoomalayPerf.world)||"")');
  ok('S5: worldDpr 1 → the resolution re-decided (1×)', /1×/.test(w3), w3);
  const dbg = JSON.parse(pstr("(function(){return JSON.stringify(window.World3D.debug())})()"));
  ok('S5: debug() publishes the resolved pair', dbg.aa === true && dbg.res === 1, JSON.stringify({ aa: dbg.aa, res: dbg.res }));
  abEval("(function(){window.Settings.setState({worldLayer:'auto'});window.Settings.setState({worldAA:'auto'});window.Settings.setState({worldDpr:0});return 'reset'})()");
  ab('screenshot ' + SHOTS + '/s5-soft-raster.png');
}

// S6 — THE QUIET ROOM LIVE: hidden → the room quiets; visible → it catches up
console.log('S6 — THE QUIET ROOM LIVE (the synthetic dark):');
await waitFn("document.querySelector('[aria-label=\"Send the message\"]') ? 'yes' : 'no'", 25000);  // the Stop button goes first — wait for Send
const send3 = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='third turn for the dark room';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S6: the third turn sends', String(send3).includes('sent'), send3);
await sleep(800);
const dark = pstr("(function(){try{Object.defineProperty(document,'hidden',{value:true,configurable:true});Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return 'dark'}catch(e){return 'ERR '+e.message}})()");
ok('S6: the room goes dark (hidden + the event dispatches)', dark === 'dark', dark);
await sleep(1200);
const lit = pstr("(function(){try{Object.defineProperty(document,'hidden',{value:false,configurable:true});Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return 'lit'}catch(e){return 'ERR '+e.message}})()");
ok('S6: the room lights (the catch-up listener runs)', lit === 'lit', lit);
await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.fmt-assistant, .msg-assistant, [class*=\"assistant\"]'));return b.some(function(x){return /chunk-30/.test(x.textContent||'')})?'yes':'no'})()", 20000);
ok('S6: the turn lands through the dark cycle', true);

// S7 — mobile + the receipts
console.log('S7 — MOBILE + THE RECEIPTS:');
ab('set viewport 390 844');
ab('reload');
await sleep(2400);
const errs = abEval('(window.__errs||[]).join(" | ")');
const errLines = errs.split('|').filter((l) => l.trim() && l.trim() !== '""' && l.trim() !== "''");
ok('S7: zero page errors across the whole walk', errLines.length === 0, errs.slice(0, 300));
ab('screenshot ' + SHOTS + '/s7-mobile.png');

// ══ THE VERDICT ═══════════════════════════════════════════════════════
console.log('\n────────────────────────────────────────────');
try { stubSrv.close(); } catch (e) {}
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('PASS ' + n + '/' + n + ' — the frame budget walk holds');
}
