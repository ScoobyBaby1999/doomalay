#!/usr/bin/env node
// v1340-e2e-walk.mjs — v1.34.0 THE OWNERSHIP WAVE redteam: the REAL-USER
// walk (PLAN-V134), one long-lived process (the sandbox reaps daemons
// between commands) driving the PWA through agent-browser exactly as a
// human would:
//
//   S2  §1 THE RETURNING MODEL: a mature chat closed + reopened through
//       the STASH path — the panel-header model pill returns (app.js
//       hides it per-open; the stash mirror used to skip updateHeaderBtn
//       — the pill vanished forever). The pill shows the model + opens
//       the browser.
//   S3  §2 THE HONEST TAILS: seeded tool events (the device's exact
//       shapes) replay as collapsed pills that read "read notes.txt" /
//       "skills load superpowers" — the verb + the path's tail.
//   S4  §3 THE SETTLED SETUP: the caps library → the termux row → the
//       setup page → the READY card (the optional line — never the
//       error-reading "locked") → Done → the row is RIGHT THERE (the
//       stale-snapshot vanish dead) + ON (the auto-stack).
//   S5  §5 THE ISOLATED MINDS: two PM chats; chat A's turn streams
//       (a controlled PMBridge stub) while the FRESH chat B is open —
//       B's transcript gains ZERO foreign rows (its greeting survives);
//       A's data keeps accumulating; reopening A shows everything.
//   S6  §4's done-page law (the error page never auto-returns) + the
//       mobile 390px + zero page errors.
'use strict';

import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');

const ENGINE_BIN = '/tmp/doomalay-v1340-e2e-engine';
const DATA_DIR = '/tmp/v1340-e2e-data';
const ENGINE_LOG = '/tmp/v1340-e2e-engine.log';
const SHOTS = '/tmp/v1340-shots';

const ENGINE_PORT = 8681;
const STUB_PORT = 8682;
const BRIDGE_PORT = 8683;
const TOKEN = 'tok-' + crypto.randomBytes(8).toString('hex');

const FAKE_HOME = '/tmp/v1340-e2e-fake-home';
const FAKE_SHARED = FAKE_HOME + '/storage/shared';
const TERMUX_HOME = '/data/data/com.termux/files/home';
const TERMUX_SHARED = '/storage/emulated/0';

const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;

const SID = 'v1340-ownership-walk';
const SID_PM_A = 'v1340-pm-a';
const SID_PM_B = 'v1340-pm-b';
const MODEL = 'groq/stub-model';

const intoFake = (s) => s.split(TERMUX_HOME).join(FAKE_HOME).split(TERMUX_SHARED).join(FAKE_SHARED);
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
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}

// ── the executing fake bridge (the v1270 law) + the READY TOGGLE ─────
// bridgeReady starts FALSE (the caps row renders unready → the tap opens
// THE SETUP PAGE — the only path there); S4 flips it true mid-walk and the
// setup's 3s poll picks the readiness up → the READY card + the auto-stack.
let bridgeReady = false;
function startBridge() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false, error: 'bad token' }); return; }
    if (req.method === 'GET' && req.url.endsWith('/status')) {
      send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: bridgeReady, api_installed: false });
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/probe')) {
      if (!bridgeReady) { send(200, { ok: false, storage_ok: false, props_ok: false, stdout: '', stderr: 'not set up yet', exit_code: 1, err: 0, errmsg: null, timeout: false }); return; }
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
        const p = spawn('bash', ['-c', cmd], { env: { ...process.env, HOME: FAKE_HOME, PATH: '/usr/bin:/bin:/usr/local/bin', PREFIX: '/usr' }, cwd: undefined });
        let out = '', errOut = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { errOut += d; });
        try { p.stdin.end(); } catch (e) {}
        p.on('close', (code) => {
          send(200, { ok: true, stdout: out.split(FAKE_SHARED).join(TERMUX_SHARED).split(FAKE_HOME).join(TERMUX_HOME).slice(0, 102400), stderr: errOut.slice(0, 20480), stdout_original_length: out.length, stderr_original_length: errOut.length, exit_code: code === null ? -1 : code, err: 0, errmsg: null, timeout: false });
        });
      });
      return;
    }
    send(404, { ok: false });
  });
  srv.listen(BRIDGE_PORT, '127.0.0.1');
  return srv;
}

// ── the OpenAI stub: one quick reply (matures the chat for S2) ───────
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
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const w of ['The', 'quick', 'answer.']) { sse(res, { choices: [{ delta: { content: w + ' ' } }] }); await sleep(40); }
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

// ══ THE WALK ═════════════════════════════════════════════════════════
console.log('S1 — BOOT (engine + bridge + stub + seeds):');
fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.mkdirSync(FAKE_SHARED + '/Doomalay/own-proj', { recursive: true });
fs.writeFileSync(FAKE_SHARED + '/Doomalay/own-proj/notes.txt', 'alpha\nbravo\ncharlie\n');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
try { execSync("pkill -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
startBridge();
startStub();
bootEngine();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key-1234' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'ownership walk', model: MODEL, provider: 'groq' });
// (NO device-workspace bind: the bind auto-stacks session.termux — S4's
// auto-stack walk needs it OFF to flip it ON itself)
// the PM pair (S5): two privatemodeai sessions, both zero-message
await jpost(ENGINE + '/api/sessions', { id: SID_PM_A, title: 'pm autonomous', model: 'privatemodeai/pm-stub', provider: 'privatemodeai' });
await jpost(ENGINE + '/api/sessions', { id: SID_PM_B, title: 'pm fresh', model: 'privatemodeai/pm-stub', provider: 'privatemodeai' });
// S3's seeds: the tails events (the device's exact shapes)
await jpost(ENGINE + '/api/sessions/' + SID + '/events', { type: 'user', text: 'read the notes and load the skill' });
await jpost(ENGINE + '/api/sessions/' + SID + '/events', {
  type: 'tool_use',
  text: JSON.stringify({ name: 'termux', summary: 'read ' + TERMUX_SHARED + '/Doomalay/own-proj/notes.txt', args: JSON.stringify({ action: 'read', args: JSON.stringify({ path: TERMUX_SHARED + '/Doomalay/own-proj/notes.txt' }) }) })
});
await jpost(ENGINE + '/api/sessions/' + SID + '/events', {
  type: 'tool_result',
  text: JSON.stringify({ name: 'termux', summary: '', text: 'alpha\nbravo\ncharlie' })
});
await jpost(ENGINE + '/api/sessions/' + SID + '/events', {
  type: 'tool_use',
  text: JSON.stringify({ name: 'skills', summary: 'load superpowers', args: JSON.stringify({ action: 'load', skill: 'superpowers' }) })
});
await jpost(ENGINE + '/api/sessions/' + SID + '/events', {
  type: 'tool_result',
  text: JSON.stringify({ name: 'skills', summary: '', text: 'superpowers methodology armed' })
});
await jpost(ENGINE + '/api/sessions/' + SID + '/events', { type: 'assistant', text: 'Done — read the notes and armed the skill.' });
ok('S1: the world boots (engine + bridge + groq stub + the seeded session + the PM pair)', true);
ab('close');

// S2 — §1 THE RETURNING MODEL (the pill goes after close/reopen — dead)
console.log('S2 — THE RETURNING MODEL (the stash path returns the pill):');
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e))});'armed'");
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
// mature the chat: one send through the stub (a live turn)
abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='say hi';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
const replyLanded = await waitFn("(function(){var es=document.querySelectorAll('.msg-bubble');for(var i=0;i<es.length;i++){if(es[i].textContent.indexOf('quick answer')>=0)return true}return false})()", 30000);
ok('S2: the chat matures (the stub reply landed — a live turn completed)', replyLanded);
await sleep(600);
// the pill is visible BEFORE the close (the law it must keep)
const before = pstr("(function(){var b=document.getElementById('panel-model-btn');return b?(b.style.display+'|'+b.textContent.slice(0,40)):'missing'})()");
ok('S2: the model pill is rendered before the close', before.includes('flex') && /stub-model/i.test(before), before);
// CLOSE the panel (the stash path) — then REOPEN
const closeRes = abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(!c||!c.panel)return 'no ctx panel';if(typeof c.panel.close!=='function')return 'no close';c.panel.close();return 'closed'})()");
ok('S2: the panel closes (the mature chat stashes)', closeRes.includes('closed'), closeRes);
await sleep(900);
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'reopened') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(900);
// THE LAW: the pill is BACK (app.js hid it per-open; the stash mirror
// must repaint it — the regression the wave kills)
const after = pstr("(function(){var b=document.getElementById('panel-model-btn');return b?(b.style.display+'|'+b.textContent.slice(0,40)):'missing'})()");
ok('S2: §1 THE PILL RETURNS after the close/reopen (the stash mirror paints it)', after.includes('flex') && /stub-model/i.test(after), after);
// the transcript survived the stash (the maturity is intact)
const transcriptKept = abEval("(function(){var es=document.querySelectorAll('.msg-bubble');var n=0;for(var i=0;i<es.length;i++){if(es[i].textContent.indexOf('quick answer')>=0)n++}return n>=1})()").includes('true');
ok('S2: the mature transcript survived the stash round-trip', transcriptKept);
ab('screenshot ' + SHOTS + '/s2-model-pill-returned.png');

// S3 — §2 THE HONEST TAILS (the seeded pills speak verb + tail)
console.log('S3 — THE HONEST TAILS (read X · skills load X):');
await sleep(600);
const readPill = pstr("(function(){var ps=document.querySelectorAll('.tool-pill');for(var i=0;i<ps.length;i++){var nm=ps[i].querySelector('.tool-pill-name');if(nm&&nm.textContent.trim()==='read'){return (ps[i].querySelector('.tool-pill-text')||{}).textContent||''}}return 'none'})()");
ok('S3: the read pill reads "read notes.txt" (the verb + the path TAIL)', /notes\.txt/.test(readPill), readPill);
const readChip = pstr("(function(){var ps=document.querySelectorAll('.tool-pill');for(var i=0;i<ps.length;i++){var nm=ps[i].querySelector('.tool-pill-name');if(nm&&nm.textContent.trim()==='read')return 'read'}return 'none'})()");
ok('S3: the read pill\'s chip speaks the plain verb (read — not file_read)', readChip === 'read', readChip);
const skillPill = pstr("(function(){var ps=document.querySelectorAll('.tool-pill');for(var i=0;i<ps.length;i++){var nm=ps[i].querySelector('.tool-pill-name');if(nm&&nm.textContent.trim()==='skills load'){return (ps[i].querySelector('.tool-pill-text')||{}).textContent||''}}return 'none'})()");
ok('S3: the skills pill reads "skills load superpowers"', /superpowers/.test(skillPill), skillPill);
// the expanded truth rows keep the FULL path (the inspection law)
abEval("(function(){var p=document.querySelector('.tool-pill');if(p){p.click();return 'expanded'}})()");
await sleep(500);
const fullQuery = pstr("(function(){var q=document.querySelector('.tool-pill-detail');if(!q)return 'no detail';return q.textContent.slice(0,400)})()");
ok('S3: the expanded detail keeps the FULL path (the truth rows)', fullQuery.includes('/Doomalay/own-proj/notes.txt'), fullQuery.slice(0, 120));
abEval("(function(){var p=document.querySelector('.tool-pill');if(p){p.click();return 'collapsed'}})()");
ab('screenshot ' + SHOTS + '/s3-honest-tails.png');

// S4 — §3 THE SETTLED SETUP (the row never vanishes; the auto-stack)
console.log('S4 — THE SETTLED SETUP (the caps row + the ready card + Done):');
// open the capabilities library through the live chat context (the
// v1250 walk's own path)
const capsOpen = abEval('(function(){var c=window.ChatPanel.current();if(window.Capabilities&&c){window.Capabilities.open(c);return "opened"}return "no caps"})()');
const capsListed = await waitFn("!!document.getElementById('cap-list')", 12000);
ok('S4: the capabilities library opens', capsListed, capsOpen);
// the termux row appears (the async probe lands)
const rowUp = await waitFn("!!document.querySelector('[data-cap=\"termux\"]')", 15000);
ok('S4: the termux row renders (the probe lands)', rowUp);
// tap the row → the setup page (the row is UNREADY — the bridge's
// permission gate is off; the flip below walks the setup's own poll)
abEval("document.querySelector('[data-cap=\"termux\"]').click()");
const setupPage = await waitFn("!!document.getElementById('tsx-page')", 12000);
ok('S4: the unready row opens THE SETUP PAGE', setupPage);
// NOW the device completes its setup (the bridge flips ready) — the
// walk busts the engine's 30s probe cache exactly as the device's own
// checkin does (a fresh ?refresh=1 re-probe), and the setup's 3s poll
// reads the fresh status → the READY card
bridgeReady = true;
await jget(ENGINE + '/api/termux/status?refresh=1');
const readyCard = await waitFn("!!document.getElementById('tsx-ready')", 20000);
ok('S4: the setup lands on the READY card (the device completed mid-setup)', readyCard);
await sleep(400);
const readyText = pstr("(function(){var c=document.getElementById('tsx-ready');return c?c.textContent.slice(0,420):'none'})()");
ok('S4: the READY card speaks the OPTIONAL unlock (never the error-reading "locked")', /optional/.test(readyText) && !/locked/.test(readyText), readyText.slice(0, 200));
ok('S4: the card names the companion app as separate + fully-ready Termux', /companion app/.test(readyText) && /fully ready/.test(readyText), readyText.slice(0, 200));
ok('S4: the card speaks the stacked truth (the auto-stack fired)', /stacked on this chat/.test(readyText), readyText.slice(0, 240));
ab('screenshot ' + SHOTS + '/s4-ready-card.png');
// DONE — the instant return: the caps page is RIGHT THERE with the row ON
abEval("document.getElementById('tsx-btn-done') && document.getElementById('tsx-btn-done').click()");
const rowBack = await waitFn("(function(){var r=document.querySelector('[data-cap=\"termux\"]');if(!r)return false;var c=r.querySelector('.cap-chip');return !!(c&&/on/i.test(c.className+' '+c.textContent))})()", 10000);
ok('S4: §3 DONE → the caps page is right there — the row visible + ON (the vanish + the off are dead)', rowBack);
// the session itself carries termux (the auto-stack persisted)
const sessTermux = await jget(ENGINE + '/api/sessions/' + SID);
const stOn = /termux[_"]?\s*[:=]\s*(true|1)/i.test(sessTermux.text || '');
ok('S4: the session row persisted termux=true (the auto-stack through the PATCH)', stOn, (sessTermux.text || '').slice(0, 200));
abEval("document.querySelector('#connect-overlay-x') && document.querySelector('#connect-overlay-x').click()");
await sleep(500);

// S5 — §5 THE ISOLATED MINDS (two PM chats; A streams while B is open)
console.log('S5 — THE ISOLATED MINDS (PM cross-chat leakage dead):');
// a controlled PMBridge stub: the turn's REAL callbacks captured for A
abEval("(function(){window.__pmEvents=[];window.PMBridge={streamChat:function(opts){window.__pmTurn=opts;return new Promise(function(res){window.__pmResolve=res;})}};return 'stubbed'})()");
// open PM chat A and send (its turn starts through the stub)
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID_PM_A + "', {}), 'opened-A') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(700);
abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='work autonomously';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
const pmTurnArmed = await waitFn("!!window.__pmTurn", 15000);
ok('S5: PM chat A\'s turn armed through the stub', pmTurnArmed);
// capture A's state reference (the data truth) while A still owns the DOM
abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();window.__pmAState=c&&c.state;return c&&c.state?'captured':'no state'})()");
// A streams: reasoning + a tool call + a delta
abEval("(function(){var o=window.__pmTurn;o.onThinking('the autonomous reasoning of chat A');return 'thought'})()");
const aBox = await waitFn("(function(){var es=document.querySelectorAll('.msg-bubble.msg-think-body, details');for(var i=0;i<es.length;i++){if(es[i].textContent.indexOf('autonomous reasoning')>=0)return true}return false})()", 8000);
ok('S5: chat A\'s reasoning streams (it owns the live DOM)', aBox);
// NOW open the FRESH PM chat B while A is mid-turn
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID_PM_B + "', {}), 'opened-B') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(700);
const bGreeting = abEval("!!document.getElementById('chat-greeting') || !!document.getElementById('chat-starters')").includes('true');
const bRows = pstr("(function(){return document.querySelectorAll('#chat-messages > *').length + ' rows: ' + Array.prototype.map.call(document.querySelectorAll('#chat-messages > *'),function(e){return e.className||e.id}).join(',').slice(0,150)})()");
ok('S5: the fresh chat B shows its greeting (zero foreign rows while A streams)', bGreeting && !/autonomous|tool-pill|msg-think|thinking/.test(bRows), bRows);
// A keeps streaming while B is open — B must gain NOTHING (the leak law)
abEval("(function(){var o=window.__pmTurn;o.onThinking(' more reasoning from A');o.onTool({name:'termux',summary:'exec bash -c ls',args:'{\"action\":\"exec\",\"args\":\"{\\\\\"command\\\\\":\\\\\"ls\\\\\"}\"}'});o.onDelta('A is still working. ');return 'fired'})()");
await sleep(1200);
const bRows2 = pstr("(function(){return document.querySelectorAll('#chat-messages > *').length + ' rows: ' + Array.prototype.map.call(document.querySelectorAll('#chat-messages > *'),function(e){return e.className||e.id}).join(',').slice(0,150)})()");
ok('S5: §5 THE LEAK IS DEAD — B\'s transcript gains ZERO foreign rows while A streams', bRows2 === bRows, bRows + '  →  ' + bRows2);
ok('S5: B\'s greeting still alive (the leak used to delete it)', abEval("!!document.getElementById('chat-greeting') || !!document.getElementById('chat-starters')").includes('true'));
// the blank-box variant: reasoning deltas for A paint NOTHING anywhere in B
abEval("(function(){var o=window.__pmTurn;o.onThinking(' even more A reasoning that must never render in B');return 'fired2'})()");
await sleep(900);
const bBlank = pstr("(function(){var b=document.body;var t=b.textContent||'';return (t.indexOf('even more A reasoning')>=0)?'LEAKED':'clean'})()");
ok('S5: the blank-box variant is dead too (A\'s later reasoning never renders in B)', bBlank === 'clean', bBlank);
// A's data keeps accumulating (the truth) — its own state messages
const aCount = pstr("(function(){var s=window.__pmAState;return s?String(s.messages.length):'no state'})()");
ok('S5: A\'s data keeps accumulating while backgrounded (the data-only mode)', parseInt(aCount, 10) >= 3, aCount);
// reopen A: its reasoning + rows are there (the data restore — the
// formatter paints async, so wait for the text; the pill speaks the
// program token 'bash' + '-c ls', not the raw summary)
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID_PM_A + "', {}), 'reopened-A') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
const aBack = await waitFn("(function(){var m=document.getElementById('chat-messages');if(!m)return false;var t=m.textContent||'';return t.indexOf('autonomous reasoning')>=0})()", 12000);
const aPill = pstr("(function(){var ps=document.querySelectorAll('.tool-pill');for(var i=0;i<ps.length;i++){var nm=ps[i].querySelector('.tool-pill-name');if(nm&&nm.textContent.trim()==='ls')return 'ls-pill-present'}return 'no-ls-pill'})()");
ok('S5: reopening A shows its reasoning (the data survived the backgrounding)', aBack === true || aBack === 'true');
ok('S5: A\'s tool pill is there (the ls chip — derived from the ARGS, not the summary)', aPill === 'ls-pill-present', aPill);
// resolve A's turn (clean end)
abEval("(function(){window.__pmResolve({text:'A finished.',usage:{}});return 'resolved'})()");
await sleep(600);
ab('screenshot ' + SHOTS + '/s5-isolated-minds.png');

// S6 — §4's done-page law + mobile + zero errors
console.log('S6 — THE DONE-PAGE LAW + MOBILE + ZERO ERRORS:');
// the bogus-state OAuth callback: the honest 400 JSON (never a
// redirect, never the auto-return script — the success-only law)
const errRes = await fetch(ENGINE + '/api/hf/oauth/callback?code=1&state=bogus').then((r) => r.text().then((t) => r.status + '|' + t)).catch(() => 'ERR');
ok('S6: the bogus-state OAuth callback answers the honest 400 (no redirect, no auto-return)', /^400\|/.test(errRes) && /unknown or expired state/.test(errRes) && !/doomalay:\/\/return/.test(errRes), errRes.slice(0, 120));
ab('set viewport 390 800');
await sleep(900);
const overflow = abEval("(document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) ? 'overflow' : 'fits'");
ok('S6: no horizontal overflow at 390px', overflow.includes('fits'));
ab('screenshot ' + SHOTS + '/s6-mobile.png');
const errors = abEval("window.__errs ? window.__errs.length : 0");
ok('S6: zero page errors across the whole walk', String(errors) === '0', String(errors));

console.log('');
console.log('v1340 E2E walk: ' + okCount + '/' + (okCount + failCount));
if (failCount) {
  console.log('FAILS:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('screenshots: ' + SHOTS + '/');
process.exit(0);
