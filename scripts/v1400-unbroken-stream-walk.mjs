#!/usr/bin/env node
// v1400-unbroken-stream-walk.mjs — THE UNBROKEN STREAM walk (the PWA half
// of the redteam; the engine half is the rig). The user's two reports,
// walked as a real user on the REAL engine + the REAL PWA:
//
//   W1  boot (engine with compressed clocks, the stub provider, the PWA)
//   W2  THE RETURN (level 1's catch-up half): a long streamed turn → the
//       user LEAVES (navigate away — the WebView-kill/app-switch shape) →
//       the work continues engine-side in the absence → the user returns
//       (navigate back — the PWA reloads) → opens the chat → the log
//       shows ALL the work done in the absence
//   W3  THE RESYNC (the zombie killer): a mid-stream return-to-app
//       (the synthetic visibilitychange — MainActivity's own bridge
//       gesture) forces the silent resync: no "connection lost" flash,
//       the stream continues, the full text lands
//   W4  THE OFFLINE USER (level 2, the full story): mid-turn the engine's
//       provider leg DIES (the stub stops) → the panel stays armed (Stop)
//       + the live pause notice lands → the network returns → the turn
//       completes BY ITSELF → the transcript carries the whole story
//       (pause notice + regained notice + the answer) with no manual
//       continue and no error bubble
//   W5  zero page errors
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const GO_BIN = process.env.GO_BIN || 'go';
const ENGINE_BIN = '/tmp/doomalay-v1400-walk-engine';
const DATA_DIR = '/tmp/v1400-walk-data';
const ENGINE_LOG = '/tmp/v1400-walk-engine.log';
const SHOTS = '/tmp/v1400-walk-shots';
const ENGINE_PORT = 8741;
const STUB_PORT = 8742;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1400-walk-' + crypto.randomBytes(3).toString('hex');
const MODEL = 'stub-model';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || e.stderr || '') || ('ERR ' + e.message);
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

// ── the stub: content-keyed, killable ────────────────────────────────
let stubSrv = null;
function startStub() {
  function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  stubSrv = http.createServer(async (req, res) => {
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
      let plan;
      if (/absence/i.test(lastUser)) {
        plan = [];
        for (let i = 0; i < 14; i++) plan.push({ d: mk('absence', i), wait: 400 }); // ~5.6s of work in the "absence"
      } else if (/resync/i.test(lastUser)) {
        plan = [];
        for (let i = 0; i < 12; i++) plan.push({ d: mk('resync', i), wait: 400 });
      } else if (/offline/i.test(lastUser)) {
        plan = [];
        for (let i = 0; i < 3; i++) plan.push({ d: mk('offline', i), wait: 250 });
      } else {
        plan = [{ d: ' quick-a ', wait: 150 }, { d: ' quick-b ', wait: 150 }];
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
  return new Promise((r) => stubSrv.listen(STUB_PORT, '127.0.0.1', () => r(stubSrv)));
}
async function killStub() {
  if (!stubSrv) return;
  await new Promise((r) => { stubSrv.close(() => r()); stubSrv.closeAllConnections?.(); });
  stubSrv = null;
}

// ── the browser helpers (the app's own seams) ───────────────────────
function openChat(sid) {
  return abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + sid + "', {}), 'opened') : 'no api'");
}
function sendMsg(text) {
  return abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value=" + JSON.stringify(text) + ";t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
}
function btnMode() {
  return pstr("(function(){var all=[].slice.call(document.querySelectorAll('button,[role=button]'));var sb=all.filter(function(x){return /Send|Stop|Retry|Queue/i.test(x.getAttribute('aria-label')||'')});return sb.length? (sb[sb.length-1].getAttribute('aria-label')||'').trim() : 'none'})()");
}
function stateSnap() {
  const raw = pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var s=c&&c.state;if(!s){var icon=window.doomalay&&window.doomalay.findIconForSession&&window.doomalay.findIconForSession('" + SID + "');if(icon&&window.ChatPanel&&window.ChatPanel.getState)s=window.ChatPanel.getState(icon.id);}if(!s)return 'no-state';var lastA=null;for(var i=s.messages.length-1;i>=0;i--){if(s.messages[i].role==='assistant'){lastA=s.messages[i];break}}return JSON.stringify({streaming:!!s.isStreaming,lastLen:lastA?lastA.text.length:-1,lastDone:lastA?!!lastA.complete:null,roles:s.messages.map(function(m){return m.role}).join(','),notices:(s.messages.filter(function(m){return m.role==='notice'}).map(function(m){return String(m.text).slice(0,60)}).join(' | '))||null,err:(s.messages.filter(function(m){return m.role==='error'}).map(function(m){return String(m.text).slice(0,80)}).join(' | '))||null})})()");
  if (raw === 'no-state' || raw === '') return { streaming: false, lastLen: -1, lastDone: null, roles: '', notices: null, err: null };
  try { return JSON.parse(raw); } catch (e) { return { streaming: false, lastLen: -1, lastDone: null, roles: '', notices: null, err: null }; }
}
const hasErrBubbleJs = "(function(){var t=document.body?(document.body.textContent||''):'';return /tap Retry|Connection to the engine dropped|reply was interrupted/i.test(t)?'yes':'no'})()";
const hasLostIndicatorJs = "(function(){var t=document.body?(document.body.textContent||''):'';return /connection lost/i.test(t)?'yes':'no'})()";
const fullText = (tag, last) => new RegExp(tag + '-chunk-' + (last === undefined ? '13' : last)).source;

console.log('═══ v1400 THE UNBROKEN STREAM walk ═══');
console.log('W1 — BOOT:');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(ENGINE_LOG, '');
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
{
  let free = false;
  for (let i = 0; i < 60; i++) {
    const busy = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false))); s.listen(ENGINE_PORT, '127.0.0.1'); });
    if (!busy) { free = true; break; }
    await sleep(200);
  }
  ok('W1: the port is free (the zombie guard)', free);
}
execFileSync(GO_BIN, ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit', env: { ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto' } });
await startStub();
{
  const env = {
    ...process.env, PATH: process.env.PATH, GOTOOLCHAIN: 'auto',
    DOOMALAY_BASE_URL_GROQ: STUB,
    DOOMALAY_OTA_DISABLE: '1',
    // compressed production ratios (the pacer's ~2s provider cooldown is a
    // legitimate engine behavior the clocks must clear)
    DOOMALAY_NET_LADDER_WAITS: '120,200',
    DOOMALAY_NET_SUSPEND_BASE_MS: '250',
    DOOMALAY_NET_SUSPEND_CAP_MS: '600',
    DOOMALAY_NET_HEARTBEAT_MS: '80',
    DOOMALAY_TURN_STALE_MS: '2500',
  };
  const out = fs.openSync(ENGINE_LOG, 'a');
  spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], { env, detached: true, stdio: ['ignore', out, out] }).unref();
}
for (let i = 0; i < 150; i++) {
  try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) break; } catch (e) {}
  await sleep(200);
}
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'v1400 walk', model: MODEL, provider: 'groq' });
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2600);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
ok('W1: the PWA boots', await waitFn("(function(){return window.doomalay?'yes':'no'})()", 15000));
ok('W1: the chat opens', String(openChat(SID)).includes('opened') && await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
console.log('W1 ok');

// ── W2 — THE RETURN (the absence catch-up) ──────────────────────────
console.log('W2 — THE RETURN (navigate away → work continues → return):');
{
  ok('W2: the absence turn sends', String(sendMsg('please stream the work done in my absence')).includes('sent'));
  ok('W2: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
  // THE USER LEAVES (the app-switch shape: the page is gone; the engine
  // keeps working — no socket, no page, only the turn + the log)
  ab('open about:blank');
  await sleep(7000); // the work happens entirely in the "absence"
  // THE USER RETURNS: the PWA reloads (the cold WebView), opens the chat
  ab('open ' + ENGINE + '/?apk=1');
  await sleep(2600);
  abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
  ok('W2: the PWA reboots on return', await waitFn("(function(){return window.doomalay?'yes':'no'})()", 15000));
  openChat(SID);
  ok('W2: the chat reopens', await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000));
  // THE LAW: the log reflects ALL the work done in the absence
  await sleep(1500);
  const snap = stateSnap();
  ok('W2: the transcript shows the FULL work done in the absence (absence-chunk-13)',
    snap.lastLen > 0 && /absence-chunk-13/.test(pstr("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var s=c&&c.state;if(!s)return '';var t='';for(var i=0;i<s.messages.length;i++){if(s.messages[i].role==='assistant')t+=s.messages[i].text}return t})()")),
    JSON.stringify({ lastLen: snap.lastLen, done: snap.lastDone }));
  ok('W2: the turn is complete (not stuck streaming)', !snap.streaming, JSON.stringify(snap));
  ok('W2: no error bubble on return', pstr(hasErrBubbleJs) === 'no');
  ab('screenshot ' + SHOTS + '/w2-the-return.png');
}
console.log('W2 ok');

// ── W3 — THE RESYNC (the zombie killer, no flash) ────────────────────
console.log('W3 — THE RESYNC (a mid-stream return-to-app):');
{
  ok('W3: the resync turn sends', String(sendMsg('please stream the resync turn')).includes('sent'));
  ok('W3: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
  ok('W3: the first chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /resync-chunk-1/.test(t)?'yes':'no'})()", 15000));
  // THE RETURN-TO-APP GESTURE: the synthetic visibilitychange (exactly
  // MainActivity's own bridge gesture) — the sweep fires, the open socket
  // with live work gets the silent resync
  abEval("document.dispatchEvent(new Event('visibilitychange')); 'dispatched'");
  await sleep(600);
  // NO connection-lost flash — the resync is silent by design
  ok('W3: NO connection-lost flash on the resync', pstr(hasLostIndicatorJs) === 'no');
  const snapA = stateSnap();
  ok('W3: the turn stays armed through the resync', snapA.streaming, JSON.stringify(snapA));
  ok('W3: the turn completes after the resync (resync-chunk-11 lands)',
    await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /resync-chunk-11/.test(t)?'yes':'no'})()", 25000));
  await sleep(1000);
  const snapEnd = stateSnap();
  ok('W3: the turn ends cleanly (full text, no error)', !snapEnd.streaming && !snapEnd.err, JSON.stringify(snapEnd));
  ab('screenshot ' + SHOTS + '/w3-resync.png');
}
console.log('W3 ok');

// ── W4 — THE OFFLINE USER (the full story, no manual continue) ───────
console.log('W4 — THE OFFLINE USER (engine egress dies → holds → returns):');
{
  ok('W4: the offline turn sends', String(sendMsg('please stream the offline turn')).includes('sent'));
  ok('W4: the turn arms', await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();return (c&&c.state&&c.state.isStreaming)?'yes':'no'})()", 12000));
  ok('W4: the pre-outage chunks land', await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));var t=b.length?b[b.length-1].textContent||'':'';return /offline-chunk-2/.test(t)?'yes':'no'})()", 15000));
  // THE OUTAGE: the engine's provider leg dies (the user's internet is
  // gone; the engine holds the turn)
  await killStub();
  // the suspension arms (rungs + pacing ≈ 4.5s compressed) — the panel
  // keeps the turn armed + the LIVE hold notice lands in the transcript.
  // (The stub died MID-STREAM — the emitted-content class — so the SEAM
  // owns the hold: its notice says "cut mid-reply"; a between-rounds death
  // would say "connection to … lost". Both are the honest hold story.)
  ok('W4: the LIVE hold notice lands while the user watches',
    await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var s=c&&c.state;if(!s)return 'no';for(var i=0;i<s.messages.length;i++){if(s.messages[i].role==='notice'&&/(cut mid-reply|connection to .* lost)/.test(s.messages[i].text))return 'yes'}return 'no'})()", 20000));
  const snapHold = stateSnap();
  ok('W4: the turn STAYS ARMED through the outage (Stop works)', snapHold.streaming, JSON.stringify(snapHold));
  ok('W4: no error bubble during the outage', pstr(hasErrBubbleJs) === 'no');
  // THE USER'S INTERNET RETURNS — the turn completes BY ITSELF
  await startStub();
  ok('W4: the turn completes with no manual continue (offline-chunk-2 → idle)',
    await waitFn("(function(){var c=window.ChatPanel&&window.ChatPanel.current();var s=c&&c.state;if(!s)return 'no';return (!s.isStreaming)?'yes':'no'})()", 30000));
  const evs = await events();
  const texts = evs.map((e) => String(e.Text || e.text || '')).join(' ');
  ok('W4: the transcript carries the WHOLE story (the hold + regained + the answer)',
    /(cut mid-reply|connection to .* lost)/.test(texts) && /network regained after/.test(texts) && /offline-chunk-2/.test(texts), texts.slice(0, 300));
  const snapEnd = stateSnap();
  ok('W4: the panel ends clean (not streaming, no error)', !snapEnd.streaming && !snapEnd.err, JSON.stringify(snapEnd));
  ab('screenshot ' + SHOTS + '/w4-offline-story.png');
}
console.log('W4 ok');

// ── W5 — zero page errors ────────────────────────────────────────────
console.log('W5 — THE PAGE:');
{
  const errs = pstr("(function(){return (window.__errs||[]).join(' | ')||'none'})()");
  ok('W5: zero page errors through the whole walk', errs === 'none', errs);
}
console.log('W5 ok');

// ── the verdict ──────────────────────────────────────────────────────
console.log('');
console.log('════════════════════════════════════════');
console.log('v1400 unbroken-stream walk: ' + (n - fails.length) + '/' + n);
if (fails.length) {
  console.log('FAILURES:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('ALL GREEN — the panel proves the work, the stream survives the absence.');
}
try { if (stubSrv) stubSrv.close(); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
