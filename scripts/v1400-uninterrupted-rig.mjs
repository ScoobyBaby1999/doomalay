#!/usr/bin/env node
// v1400-uninterrupted-rig.mjs — THE UNINTERRUPTED TURN redteam, wave two
// (the faces the v1350 rig did not model — the user's law stands: once a
// turn starts, NOTHING may end it automatically; the only terminals are
// the engine's own truth and an explicit user Stop):
//
//   T1  boot (the zombie guard; the served tree is THIS tree; the WS
//       capture patch arms before any chat socket exists)
//   T2  THE >300 REBUILD: a long turn streams; the panel CLOSES; while
//       closed the transcript grows past the v1.29.1 stash gate (>300 new
//       messages — the long-run shape); the REOPEN takes the renderHost
//       FULL-REBUILD path MID-TURN → the turn must stay armed, never
//       bubble an interrupt, keep growing, complete honestly
//   T3  THE STASH-UNAVAILABLE REBUILD + THE QUIET PHASE: the stash is
//       unavailable at reopen (whatever real cause — the stacked view, a
//       masked transcript, the gate flip) DURING the 9s quiet phase (zero
//       live deltas) → renderHost rebuilds mid-turn → the truth arm holds
//       streaming with NO delta to ride on → the turn completes
//   T4  THE CHAT SWITCH: chat A streams → the panel closes → chat B opens
//       and works → the panel closes → chat A REOPENS mid-turn → A keeps
//       streaming to completion; B's history survives its own reopen
//   T5  THE LADDER EXHAUSTION (the real background shape): mid-turn the
//       socket dies and STAYS dead past the ladder (the Android pause:
//       timers frozen, no reconnect attempts land) → the UI holds armed
//       with NO fabricated terminal through the whole dark window → the
//       revive poll reconnects → the gap replay resolves the truth → the
//       turn completes
//   T6  receipts: the engine log shows NO open-door abort on any path
//
// The real engine serves the real tree; a keyed slow-streaming stub feeds
// the turns; agent-browser drives the PWA (the v1350 harness shape).

'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1400-engine';
const DATA_DIR = '/tmp/v1400-data';
const ENGINE_LOG = '/tmp/v1400-engine.log';
const SHOTS = '/tmp/v1400-shots';

const ENGINE_PORT = 8695;
const STUB_PORT = 8696;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1400-turn-' + crypto.randomBytes(3).toString('hex');
const SID2 = 'v1400-turn-' + crypto.randomBytes(3).toString('hex');
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
async function events(sid) {
  try {
    const r = await fetch(ENGINE + '/api/sessions/' + (sid || SID) + '/events');
    const j = await r.json();
    return Array.isArray(j) ? j : (j.events || j.items || []);
  } catch (e) { return []; }
}

// ── the stub: the LAST user message's content picks the turn ──────
//  · /long/i   → 30 chunks × 350ms (~10.5s) — the streaming turn
//  · /quiet/i  → 5 chunks, a 9s SILENCE, then 5 chunks + stop
//  · else      → a quick 2-chunk turn (chat B's throwaway)
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
function stateSnap(sid) {
  const s = sid || SID;
  const raw = pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var st=c&&c.state;if(st&&st.sessionId&&st.sessionId!=='" + s + "')st=null;if(!st){var icon=window.doomalay&&window.doomalay.findIconForSession&&window.doomalay.findIconForSession('" + s + "');if(icon&&window.ChatPanel&&window.ChatPanel.getState)st=window.ChatPanel.getState(icon.id);}if(!st)return 'no-state';var lastA=null;for(var i=st.messages.length-1;i>=0;i--){if(st.messages[i].role==='assistant'){lastA=st.messages[i];break}}return JSON.stringify({streaming:!!st.isStreaming,holdQ:!!st._holdQueue,msgs:st.messages.length,lastLen:lastA?lastA.text.length:-1,err:(st.messages.filter(function(m){return m.role==='error'}).map(function(m){return String(m.text).slice(0,80)}).join(' | '))||null})})()");
  if (raw === 'no-state' || raw === '') return { streaming: false, holdQ: false, msgs: 0, lastLen: -1, err: null };
  try { return JSON.parse(raw); } catch (e) { return { streaming: false, holdQ: false, msgs: 0, lastLen: -1, err: null }; }
}
function bubbleText() {
  return pstr("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return t.slice(-400)})()");
}
const hasErrBubbleJs = "(function(){var t=document.body?(document.body.textContent||''):'';return /tap Retry|Connection to the engine dropped|reply was interrupted/i.test(t)?'yes':'no'})()";

// the state seam (owner-first, then the icon route — the stateSnap law)
function stateJs(sid, expr) {
  const s = sid || SID;
  return "(function(){var c=window.ChatPanel&&window.ChatPanel.current();var st=c&&c.state;if(st&&st.sessionId&&st.sessionId!=='" + s + "')st=null;if(!st){var icon=window.doomalay&&window.doomalay.findIconForSession&&window.doomalay.findIconForSession('" + s + "');if(icon&&window.ChatPanel&&window.ChatPanel.getState)st=window.ChatPanel.getState(icon.id);}if(!st)return 'no-state';return (" + expr + ")})()";
}

// ══ THE RIG ══════════════════════════════════════════════════════════
console.log('T1 — BOOT:');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(ENGINE_LOG, '');
try { execSync("pkill -9 -f 'doomalay.*--port " + ENGINE_PORT + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
ok('T1: the port is free (the zombie guard)', await waitPortFree(ENGINE_PORT));
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: __ROOT + '/engine', stdio: 'inherit',
  env: { ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto' }
});
const stubSrv = startStub();
bootEngine();
await waitEngine();
const servedCp = await (await fetch(ENGINE + '/chatpanel.js')).text();
ok('T1: the served tree is THIS tree (the stash law rides)', servedCp.includes('v1.29.1') || servedCp.includes('STASHED'));
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'uninterrupted walk A', model: MODEL, provider: 'groq' });
await jpost(ENGINE + '/api/sessions', { id: SID2, title: 'uninterrupted walk B', model: MODEL, provider: 'groq' });
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
ok('T1: the WS capture patch arms', String(abEval(WS_PATCH)).includes('patched'));
const openRes1 = openChat(SID);
ok('T1: the chat opens with the composer ready',
  await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000), openRes1);
console.log('T1 ok');

// ── T2 — THE >300 REBUILD (the long-run stash-gate face) ────────────
console.log('T2 — THE >300 REBUILD (renderHost rebuilds MID-TURN):');
ok('T2: the long turn sends', String(sendMsg('please stream the long turn')).includes('sent'));
ok('T2: the turn arms (isStreaming)', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.state)return 'no';var l=null;for(var i=c.state.messages.length-1;i>=0;i--){if(c.state.messages[i].role==='assistant'){l=c.state.messages[i];break}}return (l&&l.text.length>200)?'yes':'no'})()", 15000);
const snapMid = stateSnap(SID);
ok('T2: mid-turn snapshot (streaming, no errors)', snapMid.streaming && !snapMid.err, JSON.stringify(snapMid));
const closed = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no panel';c.panel.close();return 'closed'})()");
ok('T2: the panel closes mid-turn', String(closed).includes('closed'), closed);
ok('T2: ownership dropped (the data-only law)', await waitFn("(function(){return (window.ChatPanel&&window.ChatPanel.current())?'no':'yes'})()", 6000));
await sleep(2000);
// THE GATE: the transcript grows past the v1.29.1 >300 delta cap while
// closed (the long autonomous run's shape). The injection rides the app's
// OWN state seam — the rebuild downstream is the real path.
const inject = abEval(stateJs(SID, "(function(){for(var i=0;i<310;i++){st.messages.push({role:'tool',text:' background-run step '+i,ts:Date.now()})}return st.messages.length})()"));
ok('T2: the transcript grew past the stash cap while closed (' + String(inject).slice(-6) + ')', /43\d|4\d\d|\d{3}/.test(String(inject)), inject);
// THE REOPEN — the stash gate MUST fail (310 > 300) → renderHost rebuilds
openChat(SID);
ok('T2: the chat reopens (the full rebuild path)', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(1500);
const snap2Re = stateSnap(SID);
ok('T2: the turn STILL streams after the rebuild (the unbroken law)', snap2Re.streaming, JSON.stringify(snap2Re));
ok('T2: no interrupt bubble after the rebuild', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
const len2 = snap2Re.lastLen;
await sleep(2200);
const snap2Grow = stateSnap(SID);
ok('T2: the bubble KEPT GROWING after the rebuild (' + len2 + '→' + snap2Grow.lastLen + ')', snap2Grow.lastLen > len2, JSON.stringify({ len2, after: snap2Grow.lastLen }));
ok('T2: the turn completes (long-chunk-29 lands)', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /long-chunk-29/.test(t)?'yes':'no'})()", 30000));
await sleep(1200);
const snap2End = stateSnap(SID);
ok('T2: the turn ends cleanly (not streaming, no error)', !snap2End.streaming && !snap2End.err, JSON.stringify(snap2End));
ab('screenshot ' + SHOTS + '/t2-rebuild-reopen.png');
console.log('T2 ok');

// ── T3 — THE STASH-UNAVAILABLE REBUILD DURING THE QUIET PHASE ───────
console.log('T3 — THE STASH-UNAVAILABLE REBUILD (quiet phase, zero deltas):');
ok('T3: the quiet turn sends', String(sendMsg('please stream the quiet turn')).includes('sent'));
ok('T3: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('T3: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
const closed3 = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no panel';c.panel.close();return 'closed'})()");
ok('T3: the panel closes INSIDE the quiet phase', String(closed3).includes('closed'), closed3);
await sleep(500);
// THE SEAM: the stash is unavailable at reopen (the real causes: a stacked
// view owned the body at close, a masked transcript, the gate flip).
const killed3 = abEval(stateJs(SID, "(st._domStash=null, 'stash-null')"));
ok('T3: the stash is torn down (the no-stash shape)', String(killed3).includes('stash-null'), killed3);
openChat(SID);
ok('T3: the chat reopens (renderHost rebuild, mid-quiet)', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(1000);
const snap3 = stateSnap(SID);
// THE LAW: the truth arm holds streaming with NO live delta to ride on.
ok('T3: the turn RE-ARMS from the transcript truth (streaming held)', snap3.streaming, JSON.stringify(snap3));
ok('T3: no interrupt bubble mid-quiet', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
ok('T3: the turn completes (post-chunk-4 lands)', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /post-chunk-4/.test(t)?'yes':'no'})()", 30000));
await sleep(1200);
const snap3End = stateSnap(SID);
ok('T3: the turn ends cleanly', !snap3End.streaming && !snap3End.err, JSON.stringify(snap3End));
ab('screenshot ' + SHOTS + '/t3-stashless-quiet.png');
console.log('T3 ok');

// ── T4 — THE CHAT SWITCH (A streams, B opens, A returns) ────────────
console.log('T4 — THE CHAT SWITCH (A → B → A, mid-turn):');
ok('T4: the long turn sends (chat A)', String(sendMsg('please stream the long turn now')).includes('sent'));
ok('T4: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
const closed4 = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no panel';c.panel.close();return 'closed'})()");
ok('T4: the panel closes (A keeps streaming data-only)', String(closed4).includes('closed'), closed4);
// chat B opens and completes its own quick turn
const openB = openChat(SID2);
ok('T4: chat B opens', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000), openB);
ok('T4: chat B sends its own turn', String(sendMsg('quick hello')).includes('sent'));
ok('T4: chat B completes', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /quick-answer-b/.test(t)?'yes':'no'})()", 20000));
const closedB = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no panel';c.panel.close();return 'closed'})()");
ok('T4: the panel closes (B)', String(closedB).includes('closed'), closedB);
await sleep(1500);
const snapASwitch = stateSnap(SID);
ok('T4: A still streams underneath the switch (the data-only law)', snapASwitch.streaming, JSON.stringify(snapASwitch));
// A reopens MID-TURN
openChat(SID);
ok('T4: chat A reopens mid-turn', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(1200);
const snap4 = stateSnap(SID);
ok('T4: A STILL streams after the round trip (the unbroken law)', snap4.streaming, JSON.stringify(snap4));
ok('T4: no interrupt bubble anywhere', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
ok('T4: A completes (long-chunk-29 lands)', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /long-chunk-29/.test(t)?'yes':'no'})()", 30000));
await sleep(1000);
const snap4End = stateSnap(SID);
ok('T4: A ends cleanly', !snap4End.streaming && !snap4End.err, JSON.stringify(snap4End));
// B's history survives its own reopen
openChat(SID2);
ok('T4: chat B reopens', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(800);
ok('T4: Bs history survived (quick-answer-b still in the transcript)', pstr("(function(){var t=document.body?document.body.textContent:'';return /quick-answer-b/.test(t)?'yes':'no'})()") === 'yes');
// THE PANEL RETURNS TO A — every later scenario runs against A (the
// walk's own conviction: the open panel owns the composer, so the rig
// must always KNOW whose turn a send feeds).
abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(c&&c.panel){c.panel.close();return 'closed'}return 'no panel'})()");
await sleep(600);
openChat(SID);
ok('T4: the panel returns to chat A', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
await sleep(600);
ab('screenshot ' + SHOTS + '/t4-switch-roundtrip.png');
console.log('T4 ok');

// ── T5 — THE LADDER EXHAUSTION (the frozen-background shape) ────────
console.log('T5 — THE LADDER EXHAUSTION (socket dead past the ladder):');
ok('T5: the quiet turn sends', String(sendMsg('please stream the quiet turn once more')).includes('sent'));
ok('T5: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
ok('T5: the pre-quiet chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /pre-chunk-4/.test(t)?'yes':'no'})()", 15000));
const killed5 = killSocks();
ok('T5: the socket is killed mid-turn', /killed [1-9]/.test(String(killed5)), killed5);
// THE FREEZE: the real Android pause stops JS timers, so NO reconnect can
// land while dark — model it by blocking every new WebSocket for 12s (the
// ladder tries, throws, exhausts to the poll; the client holds armed).
abEval("(function(){window.__OW=window.WebSocket;window.__blockWS=true;window.WebSocket=function(){throw new Error('network frozen (the doze shape)')};window.WebSocket.prototype=window.__OW.prototype;return 'blocked'})()");
await sleep(6000);
const snap5Dark1 = stateSnap(SID);
console.log('    [T5 probe] ' + abEval(stateJs(SID, "JSON.stringify({cs:st.client&&st.client.state,ta:st.client&&st.client.turnActive,dropped:!!st._wsDropped,term:st._terminalSeen,stream:!!st.isStreaming,last:st.messages.slice(-4).map(function(m){return m.role+':'+String(m.text).slice(0,40)})})")));
ok('T5: 6s frozen — the turn stays armed', snap5Dark1.streaming, JSON.stringify(snap5Dark1));
ok('T5: 6s frozen — NO fabricated interrupt bubble', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
await sleep(6000);
const snap5Dark2 = stateSnap(SID);
ok('T5: 12s frozen — the turn STILL stays armed', snap5Dark2.streaming, JSON.stringify(snap5Dark2));
ok('T5: 12s frozen — STILL no fabricated bubble', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
// THE RESUME: timers unfreeze, the block lifts, the ladder/poll reconnects;
// the gap replay resolves the truth; the turn completes.
abEval("(function(){window.WebSocket=window.__OW;window.__blockWS=false;return 'unblocked'})()");
ok('T5: the client reconnects (the ladder/poll)', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.client&&c.state.client.connected)?'yes':'no'})()", 40000));
ok('T5: NO interrupt bubble through the whole frozen window', pstr(hasErrBubbleJs) === 'no', abEval(hasErrBubbleJs));
// THE TRUTH AT RESUME: the engine kept running through the freeze — the
// gap replay resolves it HONESTLY: either the turn is still mid-flight
// (re-armed) or it completed engine-side during the dark window (the
// replay lands the tail + the terminal). Both are the law; a fabricated
// error/interrupt is not.
const snap5Resume = stateSnap(SID);
ok('T5: the resume resolves the truth honestly (armed or completed, NEVER an error)',
  (snap5Resume.streaming || !snap5Resume.err), JSON.stringify(snap5Resume));
ok('T5: the turn completes (post-chunk-4 lands)', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /post-chunk-4/.test(t)?'yes':'no'})()", 30000));
await sleep(1200);
const snap5End = stateSnap(SID);
ok('T5: the turn ends cleanly', !snap5End.streaming && !snap5End.err, JSON.stringify(snap5End));
ab('screenshot ' + SHOTS + '/t5-ladder-exhaustion.png');
console.log('T5 ok');

// ── T6 — THE RECEIPTS ────────────────────────────────────────────────
console.log('T6 — THE RECEIPTS:');
const log6 = fs.readFileSync(ENGINE_LOG, 'utf8');
ok('T6: the engine logged NO open-door abort on any path', !log6.includes('open door'), log6.split('\n').filter((l) => l.includes('open door')).join(' ;; ').slice(0, 200));
const evs6 = await events(SID);
const statuses6 = evs6.filter((e) => (e.Type || e.type) === 'status').map((e) => String(e.Payload || e.payload || ''));
ok('T6: every terminal on A is an honest idle (no error terminals)', statuses6.length === 0 || statuses6.every((s) => s.includes('idle') || s === ''), statuses6.slice(-3).join(' ;; ').slice(0, 200));
ok('T6: zero page errors across the whole walk', pstr("(function(){return (window.__errs&&window.__errs.length)?String(window.__errs.length):'0'})()") === '0', pstr("(function(){return JSON.stringify((window.__errs||[]).slice(0,3))})()"));
console.log('T6 ok');

// ══ THE VERDICT ══════════════════════════════════════════════════════
console.log('════════════════════════════════════════');
console.log('v1400 uninterrupted rig: ' + (n - fails.length) + '/' + n + (fails.length ? ' — FAILURES:' : ' — ALL GREEN — the law holds on the unmodeled faces too'));
if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); }
try { stubSrv.close(); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
process.exit(fails.length ? 1 : 0);
