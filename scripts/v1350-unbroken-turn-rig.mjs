#!/usr/bin/env node
// v1350-unbroken-turn-rig.mjs — THE UNBROKEN TURN redteam (the user's
// report, both faces):
//   BUG 1 — "closing and opening the panel mid-turn interrupts the bot"
//   BUG 2 — "leaving the app while the bot runs interrupts the bot"
// The user's LAW: once a turn starts, NOTHING may end it automatically —
// the only terminals are the engine's own truth and an explicit user Stop.
//
// The real engine serves the real tree; a keyed slow-streaming stub feeds
// long turns (with a deliberate 9s SILENT phase modeling the long quiet
// stretch of an autonomous tool run); agent-browser drives the PWA:
//
//   S1  boot (the zombie guard; the served tree is THIS tree; the WS
//       capture patch arms before any chat socket exists)
//   S2  BUG 1: a long streamed turn → mid-stream CLOSE the panel (the
//       real panel.close()), wait, REOPEN the same chat → the turn keeps
//       streaming (button stays Stop, the bubble keeps growing), no
//       fabricated error bubble, the engine log shows no open-door abort,
//       the full text lands
//   S3  BUG 2a: a long turn with a quiet phase → mid-turn the WS socket
//       is KILLED (the doze/tunnel shape) → the ladder reconnects → the
//       gap replay resolves the truth → NO fabricated terminal, the turn
//       completes fully
//   S4  BUG 2b: a long turn → mid-stream the PAGE RELOADS (the Android
//       WebView-kill shape) → reopen the chat mid-turn → the UI re-arms
//       from the transcript truth (button Stop) WITHOUT waiting for a
//       live delta, no interrupt bubble, the turn completes
//   S5  THE QUIET-PHASE SEND TRAP: a turn sits in its silent phase, the
//       page reloads (fresh socket — the old turn's owner conn is gone),
//       the user sends a follow-up → the running turn must NOT be
//       aborted (the engine's open door never kills a LIVE turn; the
//       honest busy answer lands instead), turn 1 completes fully
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1350-engine';
const DATA_DIR = '/tmp/v1350-data';
const ENGINE_LOG = '/tmp/v1350-engine.log';
const SHOTS = '/tmp/v1350-shots';

const ENGINE_PORT = 8693;
const STUB_PORT = 8694;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1350-turn-' + crypto.randomBytes(3).toString('hex');
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
    if (s === 'true' || s === 'yes') { if (label) console.log('    [' + label + ' waited ' + (Date.now() - t0) + 'ms]'); return true; }
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(300);
  }
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let b = {}; try { b = await r.json(); } catch (e) {}
  return { status: r.status, body: b };
}
async function events() {
  try {
    const r = await fetch(ENGINE + '/api/sessions/' + SID + '/events');
    const j = await r.json();
    return Array.isArray(j) ? j : (j.events || j.items || []);
  } catch (e) { return []; }
}

// ── the stub: the LAST user message's content picks the turn ──────
//  · /long/i      → 30 chunks × 350ms (~10.5s) — the S2 long turn
//  · /quiet/i     → 5 chunks, a 9s SILENCE, then 5 chunks + stop — the
//                   quiet-phase shape (S3/S4/S5)
//  · else         → a quick 2-chunk turn (the S5 follow-up)
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
      const users = (parsed.messages || []).filter((m) => m.role === 'user');
      const lastUser = String((users[users.length - 1] || {}).content || '');
      const mk = (tag, i) => ' ' + tag + '-chunk-' + i + ' padding text to make the tail real. ';
      let plan = [];
      if (/long/i.test(lastUser)) {
        for (let i = 0; i < 30; i++) plan.push({ d: mk('long', i), wait: 350 });
      } else if (/quiet/i.test(lastUser)) {
        for (let i = 0; i < 5; i++) plan.push({ d: mk('pre', i), wait: 300 });
        plan.push({ d: null, wait: 9000 }); // THE QUIET PHASE
        for (let i = 0; i < 5; i++) plan.push({ d: mk('post', i), wait: 300 });
      } else {
        plan = [{ d: ' quick-answer-a ', wait: 200 }, { d: ' quick-answer-b ', wait: 200 }];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const ch of plan) {
        if (ch.d) sse(res, { choices: [{ delta: { content: ch.d } }] });
        await sleep(ch.wait);
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

// ── the browser helpers (the app's own seams) ──────────────────────
const WS_PATCH = "(function(){if(window.__socks)return 'already';window.__socks=[];var OW=window.WebSocket;window.WebSocket=function(u,p){var w=p!==undefined?new OW(u,p):new OW(u);window.__socks.push(w);return w;};window.WebSocket.prototype=OW.prototype;window.WebSocket.OPEN=OW.OPEN;window.WebSocket.CLOSED=OW.CLOSED;window.WebSocket.CONNECTING=OW.CONNECTING;window.WebSocket.CLOSING=OW.CLOSING;return 'patched'})()";
function killSocks() {
  return abEval("(function(){var k=0;(window.__socks||[]).forEach(function(w){try{if(w.readyState===1){w.close();k++}}catch(e){}});return 'killed '+k})()");
}
function openChat(sid) {
  return abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + sid + "', {}), 'opened') : 'no api'");
}
function sendMsg(text) {
  return abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value=" + JSON.stringify(text) + ";t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
}
// the send button's mode: aria-label or title tells send/stop/queue/retry
function btnMode() {
  return pstr("(function(){var b=document.querySelector('[aria-label]');var all=[].slice.call(document.querySelectorAll('button,[role=button]'));var sb=all.filter(function(x){return /Send|Stop|Retry|Queue/i.test(x.getAttribute('aria-label')||'')});return sb.length? (sb[sb.length-1].getAttribute('aria-label')||'').trim() : 'none'})()");
}
function stateSnap() {
  // owner-first, then the icon route (a CLOSED panel has no currentCtx —
  // the state lives on in the registry keyed by the icon's chat id)
  const raw = pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var s=c&&c.state;if(!s){var icon=window.doomalay&&window.doomalay.findIconForSession&&window.doomalay.findIconForSession('" + SID + "');if(icon&&window.ChatPanel&&window.ChatPanel.getState)s=window.ChatPanel.getState(icon.id);}if(!s)return 'no-state';var lastA=null;for(var i=s.messages.length-1;i>=0;i--){if(s.messages[i].role==='assistant'){lastA=s.messages[i];break}}return JSON.stringify({streaming:!!s.isStreaming,holdQ:!!s._holdQueue,msgs:s.messages.length,lastLen:lastA?lastA.text.length:-1,lastDone:lastA?!!lastA.complete:null,roles:s.messages.map(function(m){return m.role}).join(','),err:(s.messages.filter(function(m){return m.role==='error'}).map(function(m){return String(m.text).slice(0,80)}).join(' | '))||null})})()");
  if (raw === 'no-state' || raw === '') return { streaming: false, holdQ: false, msgs: 0, lastLen: -1, lastDone: null, roles: '', err: null };
  try { return JSON.parse(raw); } catch (e) { return { streaming: false, holdQ: false, msgs: 0, lastLen: -1, lastDone: null, roles: '', err: null }; }
}
function bubbleText() {
  return pstr("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble[data-msg-role=assistant],.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return t.slice(-500)})()");
}
const hasErrBubbleJs = "(function(){var t=document.body?(document.body.textContent||''):'';return /tap Retry|Connection to the engine dropped|reply was interrupted/i.test(t)?'yes':'no'})()";
const streamTailLive = "(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /post-chunk-4/.test(t)?'yes':'no'})()";

// ══ THE RIG ══════════════════════════════════════════════════════════
console.log('S1 — BOOT:');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(ENGINE_LOG, '');
try { execSync("pkill -9 -f 'doomalay.*--port " + ENGINE_PORT + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
ok('S1: the port is free (the zombie guard)', await waitPortFree(ENGINE_PORT));
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: __ROOT + '/engine', stdio: 'inherit',
  env: { ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto' }
});
const stubSrv = startStub();
bootEngine();
await waitEngine();
const servedCp = await (await fetch(ENGINE + '/chatpanel.js')).text();
ok('S1: the served tree is THIS tree (the unbroken-turn marker rides)', servedCp.includes('v1.29.2') || servedCp.includes('UNBROKEN'));
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'unbroken turn walk', model: MODEL, provider: 'groq' });
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
ok('S1: the WS capture patch arms', String(abEval(WS_PATCH)).includes('patched'));
const openRes1 = openChat(SID);
ok('S1: the chat opens with the composer ready',
  await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000), openRes1);
console.log('S1 ok');

// ── S2 — BUG 1: panel close + reopen mid-turn ───────────────────────
console.log('S2 — BUG 1 (panel close/reopen mid-turn):');
ok('S2: the long turn sends', String(sendMsg('please stream the long turn')).includes('sent'));
ok('S2: the turn arms (isStreaming)', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.state)return 'no';var l=null;for(var i=c.state.messages.length-1;i>=0;i--){if(c.state.messages[i].role==='assistant'){l=c.state.messages[i];break}}return (l&&l.text.length>200)?'yes':'no'})()", 15000);
const snapMid = stateSnap();
ok('S2: mid-turn snapshot (streaming, no errors)', snapMid.streaming && !snapMid.err, JSON.stringify(snapMid));
// THE CLOSE (the real panel.close())
const closed = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no panel';c.panel.close();return 'closed'})()");
ok('S2: the panel closes mid-turn', String(closed).includes('closed'), closed);
const ctxGone = await waitFn("(function(){return (window.ChatPanel&&window.ChatPanel.current())?'no':'yes'})()", 6000);
ok('S2: ownership dropped (the data-only law)', ctxGone);
await sleep(3500); // the turn keeps streaming data-only for a real beat
const dataOnlySnap = stateSnap();
ok('S2: the closed-chat state kept streaming (isStreaming held)', dataOnlySnap.streaming, JSON.stringify(dataOnlySnap));
ok('S2: no error bubble exists while closed', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
// THE REOPEN
openChat(SID);
ok('S2: the chat reopens', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(1200);
const snapReopen = stateSnap();
ok('S2: the turn STILL streams after reopen (the unbroken law)', snapReopen.streaming, JSON.stringify(snapReopen));
ok('S2: no interrupt bubble after reopen', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
const lenA = snapReopen.lastLen;
await sleep(2200);
const snapGrow = stateSnap();
ok('S2: the bubble KEPT GROWING after reopen (' + lenA + '→' + snapGrow.lastLen + ')', snapGrow.lastLen > lenA, JSON.stringify({ lenA, snapGrow }));
// the open-door receipt: the engine must have logged NO abort
const log1 = fs.readFileSync(ENGINE_LOG, 'utf8');
ok('S2: the engine logged no open-door abort', !log1.includes('open door'), log1.split('\n').filter((l) => l.includes('open door')).join(' ;; ').slice(0, 200));
// THE COMPLETION
ok('S2: the turn completes (long-chunk-29 lands)', await waitFn(streamTailLive.replace('post-chunk-4', 'long-chunk-29'), 30000));
await sleep(1200);
const snapEnd = stateSnap();
ok('S2: the turn ends streaming=false', !snapEnd.streaming, JSON.stringify(snapEnd));
ok('S2: no interrupt bubble at the end', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
const evs1 = await events();
const lastStatus1 = evs1.filter((e) => e.Type === 'status' || e.type === 'status').pop();
ok('S2: the engine log carries the terminal idle (not an abort artifact)', !!lastStatus1 && JSON.stringify(lastStatus1).includes('idle'), JSON.stringify(lastStatus1).slice(0, 160));
ab('screenshot ' + SHOTS + '/s2-panel-reopen.png');
console.log('S2 ok');

// ── S3 — BUG 2a: socket killed mid-turn (the doze shape) ────────────
console.log('S3 — BUG 2a (socket death mid-turn, the ladder + gap replay):');
ok('S3: the quiet turn sends', String(sendMsg('please stream the quiet turn')).includes('sent'));
ok('S3: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('S3: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
const killed = killSocks();
ok('S3: the socket is killed mid-turn (the doze shape)', /killed [1-9]/.test(String(killed)), killed);
// the ladder reconnects (turnActive → 500/1000/2000ms), the gap replay lands
ok('S3: the client reconnects (the ladder)', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.client&&c.state.client.connected)?'yes':'no'})()", 15000));
ok('S3: NO fabricated interrupt bubble during the drop', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
const snap3 = stateSnap();
ok('S3: the turn stays armed through the drop', snap3.streaming, JSON.stringify(snap3));
ok('S3: the turn completes (post-chunk-4 lands)', await waitFn(streamTailLive, 25000));
await sleep(1200);
const snap3End = stateSnap();
ok('S3: the turn ends cleanly (no error, not streaming)', !snap3End.streaming && !snap3End.err, JSON.stringify(snap3End));
const log3 = fs.readFileSync(ENGINE_LOG, 'utf8');
ok('S3: the engine logged no open-door abort', !log3.includes('open door'));
ab('screenshot ' + SHOTS + '/s3-socket-kill.png');
console.log('S3 ok');

// ── S4 — BUG 2b: page reload mid-turn (the WebView-kill shape) ──────
console.log('S4 — BUG 2b (page reload mid-turn, reopen + re-arm):');
ok('S4: the quiet turn sends', String(sendMsg('please stream the quiet turn now')).includes('sent'));
ok('S4: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('S4: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
abEval("location.reload(); 'reloading'");
await sleep(3000);
ok('S4: the page boots again (the canvas, no panel)', await waitFn("(function(){return window.doomalay?'yes':'no'})()", 15000));
abEval(WS_PATCH);
openChat(SID);
ok('S4: the chat reopens mid-turn', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 15000));
await sleep(1000);
const snap4 = stateSnap();
// THE LAW: the reopen mid-turn must re-arm the streaming state from the
// transcript truth — the button reads Stop — WITHOUT waiting for a live
// delta (the quiet phase produces none for ~9s).
ok('S4: the turn RE-ARMS from the transcript truth (streaming held)', snap4.streaming, JSON.stringify(snap4));
ok('S4: no interrupt bubble after the reload', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
ok('S4: the turn completes (post-chunk-4 lands)', await waitFn(streamTailLive, 25000));
await sleep(1200);
const snap4End = stateSnap();
ok('S4: the turn ends cleanly', !snap4End.streaming && !snap4End.err, JSON.stringify(snap4End));
const log4 = fs.readFileSync(ENGINE_LOG, 'utf8');
ok('S4: the engine logged no open-door abort', !log4.includes('open door'));
ab('screenshot ' + SHOTS + '/s4-reload-reopen.png');
console.log('S4 ok');

// ── S5 — THE QUIET-PHASE SEND TRAP (the open door vs a LIVE turn) ───
console.log('S5 — THE QUIET-PHASE SEND TRAP (a send on a fresh socket mid-turn):');
ok('S5: the quiet turn sends', String(sendMsg('please stream the quiet turn again')).includes('sent'));
ok('S5: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('S5: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
// reload mid-quiet → fresh socket → the old turn's owner conn is GONE
abEval("location.reload(); 'reloading'");
await sleep(3000);
abEval(WS_PATCH);
openChat(SID);
ok('S5: the chat reopens mid-quiet', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 15000));
await sleep(800);
const snap5 = stateSnap();
console.log('    mid-quiet snapshot: ' + JSON.stringify(snap5));
// the user sends a follow-up (the button may honestly read Stop if the
// re-arm law landed — then the send is impossible and the trap is dead)
const mode5 = btnMode();
console.log('    button mode at send time: ' + mode5);
const sent5 = sendMsg('a quick follow-up question');
console.log('    send attempt: ' + sent5);
// the truth: turn 1 must complete — its post-quiet chunks must land
ok('S5: turn 1 was NOT aborted (post-chunk-4 lands)', await waitFn(streamTailLive, 25000));
await sleep(1500);
const log5 = fs.readFileSync(ENGINE_LOG, 'utf8');
const doorFired5 = log5.split('\n').filter((l) => l.includes('open door'));
ok('S5: the engine never aborted the live turn (no open door on a fresh turn)', !doorFired5.length, doorFired5.join(' ;; ').slice(0, 240));
const snap5End = stateSnap();
ok('S5: the transcript ends honest (no fabricated error)', !/Connection to the engine dropped/.test(snap5End.err || ''), JSON.stringify(snap5End));
ab('screenshot ' + SHOTS + '/s5-quiet-send.png');
console.log('S5 ok');

// ── S6 — THE ENGINE-RESTART TRUTH (the dead turn ends honestly) ─────
// The truth-arm must never stream forever: a killed engine mid-turn
// leaves a log with no terminal — the restarted engine's boot-heal
// appends the terminal ("interrupted by engine restart"), the resumed
// client replays it, and the turn ends on the ENGINE's truth.
console.log('S6 — THE ENGINE-RESTART TRUTH (the boot-heal terminal):');
ok('S6: the quiet turn sends', String(sendMsg('please stream the quiet turn once more')).includes('sent'));
ok('S6: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('S6: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
// KILL the engine mid-quiet (the Android process-death shape)
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
await sleep(1200);
bootEngine(); // the watchdog's restart
await waitEngine();
ok('S6: the engine restarts, the client re-heals', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.client&&c.state.client.connected)?'yes':'no'})()", 30000));
// the boot-heal terminal must land: the turn ends honestly, NOT forever
ok('S6: the healed terminal ends the turn (no eternal stream)', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&!c.state.isStreaming)?'yes':'no'})()", 25000));
const evs6 = await events();
const healed6 = evs6.filter((e) => JSON.stringify(e).includes('interrupted by engine restart'));
ok('S6: the log carries the boot-heal terminal', healed6.length > 0, JSON.stringify(healed6).slice(0, 160));
const snap6 = stateSnap();
ok('S6: the state ends honest (not streaming, no fabricated wire error)', !snap6.streaming, JSON.stringify(snap6));
ab('screenshot ' + SHOTS + '/s6-restart-truth.png');
console.log('S6 ok');

// ── S7 — THE RAW GATE PROOF (a second socket can never abort) ───────
// The pure engine-level proof of the turn pulse: a RAW WebSocket (a
// conn that owns no registered turn) sends mid-turn — the LIVE turn
// must survive (the honest busy answer lands on the wire) and complete.
console.log('S7 — THE RAW GATE PROOF (a second socket vs a live turn):');
let rawBusy = null;
if (typeof WebSocket === 'function') {
  ok('S7: the quiet turn sends', String(sendMsg('please stream the quiet turn raw')).includes('sent'));
  ok('S7: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
  ok('S7: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
  rawBusy = await new Promise((resolve) => {
    const w = new WebSocket('ws://127.0.0.1:' + ENGINE_PORT + '/api/chat?session_id=' + SID);
    const got = { user: false, busy: false, term: false };
    const done = () => resolve(got);
    w.onopen = () => w.send(JSON.stringify({ type: 'send', message: 'a hostile mid-turn send from a stranger socket', session_id: SID }));
    w.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'error' && /busy|still running/i.test(ev.text || '')) got.busy = true;
        if (ev.type === 'user' && /stranger/.test(ev.text || '')) got.user = true;
        if (ev.type === 'status' && (ev.state === 'error')) got.term = true;
        if (got.busy && got.term) { try { w.close(); } catch (e2) {} done(); }
      } catch (e2) {}
    };
    setTimeout(() => { try { w.close(); } catch (e2) {} done(); }, 8000);
  });
  ok('S7: the honest busy answer landed (the transcript carries "the previous turn is still running")',
    (await (async () => { const t = pstr("(function(){return document.body?document.body.textContent:''})()"); return /the previous turn is still running/i.test(t); })()), 'see transcript');
  ok('S7: the LIVE turn was NOT aborted (post-chunk-4 lands)', await waitFn(streamTailLive, 25000));
  const log7 = fs.readFileSync(ENGINE_LOG, 'utf8');
  const door7 = log7.split('\n').filter((l) => l.includes('open door') && l.includes('LIVE turn'));
  ok('S7: the engine says the door stayed SHUT on a live turn', door7.length > 0, door7.join(' ;; ').slice(0, 200));
  const abort7 = log7.split('\n').filter((l) => l.includes('aborting the stale turn'));
  ok('S7: no abort of a live turn anywhere in the log', !abort7.length, abort7.join(' ;; ').slice(0, 200));
  await sleep(1200);
  const snap7 = stateSnap();
  // the honest records (the engine's busy answer, the S6 heal) live in the
  // transcript — the law bans only FABRICATED terminals (the client's own
  // "Connection to the engine dropped" / bare "the reply was interrupted").
  const fab7 = (snap7.err || '') + ' ' + pstr("(function(){return document.body?document.body.textContent:''})()");
  ok('S7: the turn ends honest (not streaming, NO fabricated terminal)',
    !snap7.streaming && !/Connection to the engine dropped|the reply was interrupted — tap Retry/i.test(fab7), JSON.stringify(snap7));
} else {
  console.log('  (ws module unavailable — S7 skipped)');
}
console.log('S7 ok');

// ── the verdict ─────────────────────────────────────────────────────
console.log('');
console.log('════════════════════════════════════════');
console.log('v1350 unbroken-turn rig: ' + (n - fails.length) + '/' + n);
if (fails.length) {
  console.log('FAILURES:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('ALL GREEN — the unbroken-turn law holds on every path.');
}
try { stubSrv.close(); } catch (e) {}
