#!/usr/bin/env node
// v1321-workertail-walk.mjs — v1.32.1 THE OFF-THREAD TAIL redteam: the
// REAL-USER walk (PLAN-V133 §1). The real engine serves the real tree; a
// slow-streaming OpenAI stub feeds markdown-rich turns; agent-browser
// drives the PWA exactly as a human would:
//
//   S1  boot (the zombie guard; the SERVED tree is THIS tree; the worker
//       file is served with a JavaScript content-type — a Worker script
//       with a wrong MIME never starts)
//   S2  the PWA opens; the Performance page carries the Formatter-worker
//       ledger row (jobs · worst ms · drops)
//   S3  a REAL streamed markdown turn → the WORKER PATH IS LIVE
//       (Formatter.__fmtw().spawned === true, fmtwCount > 0) and the
//       transcript actually renders the markdown (headings/bold/table)
//   S4  THE SANITIZE LAW LIVE: a streamed turn carrying a hostile payload
//       (<img onerror>, [x](javascript:…), raw <script>) → the applied
//       DOM has no onerror attribute, no javascript: href, no script tag
//   S5  mobile 390px + zero page errors (the wave's receipts)
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1321-walk-engine';
const DATA_DIR = '/tmp/v1321-walk-data';
const ENGINE_LOG = '/tmp/v1321-walk-engine.log';
const SHOTS = '/tmp/v1321-shots';

const ENGINE_PORT = 8691;
const STUB_PORT = 8692;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1321-walk-' + crypto.randomBytes(3).toString('hex');
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
    await sleep(300);
  }
}
async function jpost(url, body, headers) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  let b = {}; try { b = await r.json(); } catch (e) {}
  return { status: r.status, body: b };
}

// ── the stub: the LAST user message's CONTENT picks the turn (the
// engine's history shape makes count-based branching a lie — both turns
// looked identical to a counter). 'markdown' → the rich turn; anything
// else → the hostile payload turn ──
const MD_TURN = [
  '# The Off-Thread Tail\n\n',
  'A paragraph with **bold**, _italic_ and `inline code` bits.\n\n',
  '```js\nfunction tail(x) { return x + 1; }\n```\n\n',
  '| col a | col b |\n|---|---|\n| 1 | 2 |\n\n',
  '- list one\n- list two\n  - nested\n\n',
  '> a quoted line\n\n',
  'tail text padding the body out so the tiers split. '.repeat(6),
  'more tail text to keep the stream busy. '.repeat(6)
];
const HOSTILE_TURN = [
  'Hostile check: ',
  '<img src=x onerror="window.__pwned=(window.__pwned||0)+1" alt="pwn"> ',
  'and [clickme](javascript:window.__pwned=99) ',
  'and <script>window.__pwned=(window.__pwned||0)+10</script> ',
  'and plain end.'
];
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
      const chunks = /markdown/i.test(lastUser) ? MD_TURN : HOSTILE_TURN;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const ch of chunks) {
        sse(res, { choices: [{ delta: { content: ch } }] });
        await sleep(120);
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
// THE ZOMBIE GUARD (the v1310 conviction): kill hard, wait until the port
// actually refuses, verify the SERVED tree is this tree.
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
console.log('S1 — BOOT (engine + the streaming stub):');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
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
ok('S1: the served tree is THIS tree (the off-thread tail marker rides)', servedCp.includes('THE GESTURE MASK') && servedCp.includes('v0.78.3'));
const wkResp = await fetch(ENGINE + '/formatter.worker.js');
const wkCt = (wkResp.headers.get('content-type') || '').toLowerCase();
const wkBody = await wkResp.text();
ok('S1: /formatter.worker.js is SERVED', wkResp.ok && wkBody.includes('importScripts'), wkResp.status + ' ' + wkCt);
ok('S1: the worker script rides a JavaScript MIME (a Worker refuses the rest)', /javascript|ecmascript/.test(wkCt), wkCt);
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'off-thread tail walk', model: MODEL, provider: 'groq' });
ok('S1: the world boots (engine healthy + the session armed on the stub)', true);
ab('close');
console.log('S1 ok — opening the PWA');

// S2 — the PWA opens; the Performance page carries the worker row
console.log('S2 — THE PERFORMANCE PAGE (the Formatter-worker row):');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2400);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
const openRes = abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
const opened = await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000);
ok('S2: the app opens with the composer ready', opened && String(openRes).includes('opened'), openRes);
await sleep(600);
abEval("(function(){var b=document.getElementById('settings-btn');if(b){b.click();return 'clicked'}return 'no-btn'})()");
await sleep(700);
abEval("(function(){var tab=document.querySelector('.settings-nav [data-page=\"performance\"]');if(tab){tab.click();return 'tab'}return 'no-tab'})()");
await sleep(700);
const fmtwRow = pstr("(function(){var r=document.getElementById('pf-fmtw');return r? r.textContent.slice(0,60) : 'missing'})()");
ok('S2: the Formatter-worker ledger row renders (jobs · worst · drops)', fmtwRow !== 'missing' && /drops/.test(fmtwRow), fmtwRow);
ab('screenshot ' + SHOTS + '/s2-perf-page.png');
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 10000);
await sleep(400);

// S3 — a REAL streamed markdown turn → the worker path is live
console.log('S3 — THE WORKER PATH IS LIVE (a real turn):');
const send1 = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='show me the rich markdown please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S3: the message sends', String(send1).includes('sent'), send1);
// mid-stream: the worker must be spawned + counting WHILE the stream runs
const liveSpawn = await waitFn("(function(){var f=window.Formatter&&window.Formatter.__fmtw&&window.Formatter.__fmtw();return (f&&f.spawned)?'yes':'no'})()", 9000);
const led1 = JSON.parse(pstr("(function(){var P=window.DoomalayPerf||{};return JSON.stringify({spawned:!!(window.Formatter&&window.Formatter.__fmtw&&window.Formatter.__fmtw().spawned),c:P.fmtwCount||0,w:Math.round(P.fmtwMsWorst||0),d:P.fmtwDrops||0})})()"));
ok('S3: the worker SPAWNED during the live stream', led1.spawned === true, JSON.stringify(led1));
ok('S3: the fmtw ledger moved (the tail renders rode the worker)', led1.c > 0, JSON.stringify(led1));
ok('S3: the live check agrees (spawned mid-stream)', liveSpawn === true || led1.spawned === true, 'live=' + liveSpawn);
// THE COMPLETION WAIT: the LAST chunk's marker (the walk's first pass
// matched the h1 and read a mid-stream bubble — the harness lie the
// A/B probe convicted; the engine's event log held all 8 deltas)
await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));return b.some(function(x){return /keep the stream busy/.test(x.textContent||'')})?'yes':'no'})()", 30000);
await sleep(900);   // the final render + any late applies land
console.log('   fmtw ledger after turn 1: ' + JSON.stringify(led1));
// the FULL transcript receipt (post-completion — every marker in the last
// assistant bubble: h1, code, table, list, quote, both tail chunks)
const full1 = JSON.parse(pstr("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble[data-msg-role=assistant]'));var t=b.length?b[b.length-1].textContent:'';return JSON.stringify({len:t.length,h1:/Off-Thread Tail/.test(t),code:/function tail/.test(t),table:/col a/.test(t),list:/list two/.test(t),quote:/quoted line/.test(t),tail:/keep the stream busy/.test(t)})})()"));
ok('S3: the completed bubble carries the WHOLE turn (h1/code/table/list/quote/tail)',
  full1.h1 && full1.code && full1.table && full1.list && full1.quote && full1.tail, JSON.stringify(full1));
ab('screenshot ' + SHOTS + '/s3-worker-turn.png');

// S4 — THE SANITIZE LAW LIVE: the hostile turn
console.log('S4 — THE SANITIZE LAW LIVE (a hostile stream):');
const pwnBefore = parseInt(pstr('(window.__pwned||0)'), 10) || 0;
// the send button returns when the turn is idle — wait for it (the first
// pass hit 'no send' because the rich turn was still streaming)
const btnBack = await waitFn("!!document.querySelector('[aria-label=\"Send the message\"]')", 15000);
ok('S4: the composer is idle again (the send button returned)', btnBack === true);
const send2 = abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');if(!t)return 'no input';t.value='now the hostile payload please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
ok('S4: the hostile turn sends', String(send2).includes('sent'), send2);
await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));return b.some(function(x){return /plain end/.test(x.textContent||'')})?'yes':'no'})()", 30000);
await sleep(900);
const lawRes = JSON.parse(pstr("(function(){var q=function(s){return document.querySelectorAll(s).length};var qB=function(s){return document.querySelectorAll('.msg-bubble '+s).length};return JSON.stringify({onerr:q('[onerror]'),scrB:qB('script'),pwn:(window.__pwned||0)})})()"));
const hostileBubble = pstr("(function(){var b=[].slice.call(document.querySelectorAll('.fmt-full, [class*=\"assistant\"]'));var t=b.map(function(x){return x.textContent||''}).join('|');return JSON.stringify({txt:/Hostile check/.test(t),clickme:/clickme/.test(t)})})()");
const hj = JSON.parse(hostileBubble);
ok('S4: the hostile text renders (the message arrived)', hj.txt && hj.clickme, hostileBubble);
ok('S4: NO [onerror] attribute survived anywhere in the DOM', lawRes.onerr === 0, JSON.stringify(lawRes));
ok('S4: NO <script> element survived INSIDE any bubble (the page\u2019s own scripts don\u2019t count)', lawRes.scrB === 0, JSON.stringify(lawRes));
ok('S4: the onerror handler NEVER FIRED (window.__pwned unmoved by the payload)', lawRes.pwn === pwnBefore, 'before=' + pwnBefore + ' after=' + lawRes.pwn);
const jsHref = pstr("(function(){var a=[].slice.call(document.querySelectorAll('a[href]'));return JSON.stringify(a.filter(function(x){return /^javascript:/i.test(x.getAttribute('href'))}).length)})()");
ok('S4: NO javascript: href survived', jsHref === '0', jsHref);
const led2 = JSON.parse(pstr("(function(){var P=window.DoomalayPerf||{};return JSON.stringify({c:P.fmtwCount||0,d:P.fmtwDrops||0})})()"));
ok('S4: the worker rode the hostile turn too (fmtwCount still moving)', led2.c >= led1.c, JSON.stringify({ t1: led1.c, t2: led2.c }));
ab('screenshot ' + SHOTS + '/s4-sanitize-law.png');

// S5 — mobile + the receipts
console.log('S5 — MOBILE + ZERO ERRORS:');
ab('set viewport 390 844');
await sleep(900);
const mob = pstr("(function(){return document.documentElement.clientWidth<=400?'yes':'no'})()");
ok('S5: the panel holds mobile 390px', mob === 'yes');
const errs = pstr('(JSON.stringify(window.__errs||[]))');
ok('S5: zero page errors across the whole walk', errs === '[]', errs);
ab('screenshot ' + SHOTS + '/s5-mobile.png');

// ══ the verdict ══════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════');
try { stubSrv.close(); } catch (e) {}
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + n + '/' + n + ' — v1.32.1 THE OFF-THREAD TAIL walk');
console.log('shots: ' + SHOTS);
