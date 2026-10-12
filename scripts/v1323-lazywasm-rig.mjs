#!/usr/bin/env node
// v1323-lazywasm-rig.mjs — v1.32.3 THE EMBED TRUTH (PLAN-V133 §3): the
// lazy-wasm law, pinned. pmsdk.js constructs PrivatemodeCore + fetches the
// 6.1MB /vendor/pm/privatemode.wasm ONLY inside getCore() on the first PM
// turn — the deferred item's goal was already the shipped behavior; this
// rig makes it a TESTED law instead of a memory:
//
//   W1  the PM JS module graph loads (pmsdk is a boot-time module) but the
//       WASM BYTES never move on boot
//   W2  a REAL non-PM streamed turn (the groq stub) — the wasm still never
//       moves, the turn completes
//   W3  the source pins: getCore() has no top-level caller (the lazy shape
//       is structural, not incidental)
'use strict';

import http from 'node:http';
import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1323-rig-engine';
const DATA_DIR = '/tmp/v1323-rig-data';
const ENGINE_LOG = '/tmp/v1323-rig-engine.log';
const ENGINE_PORT = 8697;
const STUB_PORT = 8698;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const STUB = 'http://127.0.0.1:' + STUB_PORT;
const SID = 'v1323-rig-' + crypto.randomBytes(3).toString('hex');
const MODEL = 'stub-model';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ab(args, t) {
  try { return execSync('agent-browser ' + args, { timeout: t || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message); }
}
const abEval = (js) => ab('eval ' + JSON.stringify(js), 25000);
const pstr = (js) => { const v = abEval(js); try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {} return String(v).replace(/^"|"$/g, ''); };
async function waitFn(js, t) {
  const t0 = Date.now();
  for (;;) {
    const v = String(abEval(js)).trim().replace(/^"|"$/g, '');
    if (v === 'true' || v === 'yes') return true;
    if (Date.now() - t0 > (t || 15000)) return false;
    await sleep(300);
  }
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { return await r.json(); } catch (e) { return {}; }
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
async function waitEngine() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(ENGINE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never became healthy: ' + fs.readFileSync(ENGINE_LOG, 'utf8').slice(-800));
}

// ══ W3 first: the source pins (cheap, structural) ════════════════════
console.log('W3 — THE SOURCE PINS (the lazy shape is structural):');
const WEB = __ROOT + '/engine/internal/server/web/';
const pm = fs.readFileSync(WEB + 'vendor/pm/pmsdk.js', 'utf8');
const bootRegion = pm.slice(0, pm.indexOf('async function getCore()'));
ok('W3: getCore is the ONLY PrivatemodeCore constructor', /new PrivatemodeCore\(/.test(pm.slice(pm.indexOf('async function getCore()'))));
ok('W3: nothing before getCore constructs it (no top-level boot)', !/new PrivatemodeCore\(/.test(bootRegion));
// the callers of getCore: inside the PM turn paths only
const callers = [...pm.matchAll(/getCore\(\)/g)].length;
ok('W3: getCore is referenced from the turn paths (not at module top level)', callers >= 1 && !/^\s*getCore\(\)/m.test(pm), 'refs=' + callers);
ok('W3: the wasm URL is the SDK option (fetched inside the SDK, on demand)', /browserWasmURL:\s*'\/vendor\/pm\/privatemode\.wasm'/.test(pm));

// ══ the live boot ════════════════════════════════════════════════════
console.log('W1 — THE BOOT (the JS graph loads, the WASM bytes never move):');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
try { execSync("pkill -9 -f 'doomalay.*--port " + ENGINE_PORT + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
ok('W1: the port is free (the zombie guard)', await waitPortFree(ENGINE_PORT));
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: __ROOT + '/engine', stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'auto' }
});
// the stub: a slow plain streamer (a NON-PM turn)
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
const stubSrv = http.createServer(async (req, res) => {
  const url = req.url.replace(/\?.*$/, '');
  if (req.method === 'GET' && (url === '/models' || url === '/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  if (req.method === 'POST' && (url === '/chat/completions' || url === '/v1/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (let i = 0; i < 10; i++) { sse(res, { choices: [{ delta: { content: 'plain chunk ' + i + '. ' } }] }); await sleep(100); }
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404); res.end();
});
stubSrv.listen(STUB_PORT, '127.0.0.1');
const out = fs.openSync(ENGINE_LOG, 'a');
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
  { env: { ...process.env, DOOMALAY_BASE_URL_GROQ: STUB, DOOMALAY_OTA_DISABLE: '1' }, detached: true, stdio: ['ignore', out, out] });
child.unref();
await waitEngine();
await jpost(ENGINE + '/api/keys', { env_var: 'GROQ_API_KEY', provider: 'groq', key: 'stub-groq-key' });
await jpost(ENGINE + '/api/sessions', { id: SID, title: 'lazy wasm pin', model: MODEL, provider: 'groq' });
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2600);
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
abEval("(window.doomalay && window.doomalay.openChatBySession) ? (window.doomalay.openChatBySession('" + SID + "', {}), 'opened') : 'no api'");
await waitFn("!!(document.querySelector('#chat-input')||document.querySelector('textarea'))", 12000);
const bootRes = JSON.parse(pstr("(function(){var rs=(performance.getEntriesByType('resource')||[]);var wasm=rs.filter(function(r){return /privatemode\\.wasm/.test(r.name)});var pmjs=rs.filter(function(r){return /pmsdk\\.js|privatemode-ai\\.js|wasm(_exec)?\\.js/.test(r.name)});return JSON.stringify({wasmEntries:wasm.length,pmJsEntries:pmjs.length,wasmBytes:wasm.reduce(function(a,r){return a+(r.transferSize||0)},0)})})()"));
ok('W1: the PM JS module graph loads at boot (the bridge is armed)', bootRes.pmJsEntries >= 1, JSON.stringify(bootRes));
ok('W1: the WASM BYTES never move on boot (zero privatemode.wasm entries)', bootRes.wasmEntries === 0 && bootRes.wasmBytes === 0, JSON.stringify(bootRes));

// ══ W2: a real non-PM turn — still lazy ══════════════════════════════
console.log('W2 — A REAL NON-PM TURN (the wasm still never moves):');
abEval("(function(){var t=document.querySelector('#chat-input')||document.querySelector('textarea');t.value='plain turn please';t.dispatchEvent(new Event('input',{bubbles:true}));var s=document.querySelector('[aria-label=\"Send the message\"]');if(!s)return 'no send';s.click();return 'sent'})()");
const done = await waitFn("(function(){var b=[].slice.call(document.querySelectorAll('.msg-bubble'));return b.some(function(x){return /plain chunk 9/.test(x.textContent||'')})?'yes':'no'})()", 25000);
ok('W2: the non-PM turn completes (chunk 9 lands)', done === true);
await sleep(600);
const afterRes = JSON.parse(pstr("(function(){var rs=(performance.getEntriesByType('resource')||[]);var wasm=rs.filter(function(r){return /privatemode\\.wasm/.test(r.name)});return JSON.stringify({wasmEntries:wasm.length,wasmBytes:wasm.reduce(function(a,r){return a+(r.transferSize||0)},0)})})()"));
ok('W2: the WASM BYTES still never moved after a real turn', afterRes.wasmEntries === 0 && afterRes.wasmBytes === 0, JSON.stringify(afterRes));
const errs = pstr('(JSON.stringify(window.__errs||[]))');
ok('W2: zero page errors', errs === '[]', errs);
ab('screenshot /tmp/v1323-shots/lazy-wasm.png');

// ══ the verdict ══════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════');
try { stubSrv.close(); } catch (e) {}
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + n + '/' + n + ' — v1.32.3 THE LAZY WASM law pinned');
