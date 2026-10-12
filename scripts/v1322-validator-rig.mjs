#!/usr/bin/env node
// v1322-validator-rig.mjs — v1.32.2 THE HONEST VALIDATOR redteam: the
// LIVE rig (PLAN-V133 §2). The real engine serves the real tree:
//
//   L1  the static layer's new shape: 200 + strong ETag + no-cache; the
//       exact validator → 304 empty; a stale validator → 200
//   L2  the gzip variant: Content-Encoding + Vary + the W/"-gz" validator;
//       the -gz validator revalidates; the identity validator misses it
//   L3  THE LIVE OTA PROOF: a patch lands in <dataDir>/ota/ (what
//       handleOtaDownload produces) → the SAME URL serves the patched
//       bytes with a FLIPPED ETag; the cached client's stale validator
//       misses; the new one revalidates — no engine restart involved
//   L4  the wasm route's validator (its max-age contract untouched)
//   L5  THE BROWSER RECEIPT: load the PWA, reload, and read the resource
//       timing — the first load transfers the full bodies, the reload's
//       304s transfer ~nothing (encodedBodySize 0), zero page errors
'use strict';

import net from 'node:net';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __ROOT = pathResolve();
const ENGINE_BIN = '/tmp/doomalay-v1322-rig-engine';
const DATA_DIR = '/tmp/v1322-rig-data';
const ENGINE_LOG = '/tmp/v1322-rig-engine.log';
const ENGINE_PORT = 8695;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;

import path from 'node:path';
function pathResolve() { return path.resolve(path.dirname(process.argv[1] || ''), '..'); }

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

// ══ THE RIG ══════════════════════════════════════════════════════════
console.log('L0 — BOOT:');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
try { execSync("pkill -9 -f 'doomalay.*--port " + ENGINE_PORT + "' || true"); } catch (e) {}
try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
ok('L0: the port is free (the zombie guard)', await waitPortFree(ENGINE_PORT));
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: __ROOT + '/engine', stdio: 'inherit',
  env: { ...process.env, GOTOOLCHAIN: 'auto' }
});
const out = fs.openSync(ENGINE_LOG, 'a');
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR],
  { env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' }, detached: true, stdio: ['ignore', out, out] });
child.unref();
await waitEngine();
const servedFmt = await (await fetch(ENGINE + '/formatter.js')).text();
ok('L0: the served tree is THIS tree (the off-thread tail rides formatter.js)', servedFmt.includes('OFF-THREAD TAIL'));

// ── L1: the shape ──
// NOTE: Node's fetch auto-negotiates gzip — every IDENTITY assertion pins
// 'Accept-Encoding: identity' explicitly.
console.log('L1 — THE SHAPE (200 + ETag + no-cache; 304s):');
const r1 = await fetch(ENGINE + '/app.js', { headers: { 'Accept-Encoding': 'identity' } });
const etag1 = r1.headers.get('etag') || '';
ok('L1: app.js answers 200 with a strong quoted ETag', r1.status === 200 && /^"[0-9a-f]{64}"$/.test(etag1), r1.status + ' ' + etag1);
ok('L1: the OTA law holds (Cache-Control: no-cache)', (r1.headers.get('cache-control') || '') === 'no-cache', r1.headers.get('cache-control'));
const body1 = await r1.text();
ok('L1: the body is the real asset', body1.length > 10000, body1.length + ' bytes');

const r2 = await fetch(ENGINE + '/app.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': etag1 } });
ok('L2: the exact validator revalidates → 304', r2.status === 304, r2.status);
ok('L2: the 304 is EMPTY (no body leaked)', (await r2.text()) === '');
ok('L2: the 304 keeps the ETag + the OTA law', (r2.headers.get('etag') || '') === etag1 && (r2.headers.get('cache-control') || '') === 'no-cache');
const r3 = await fetch(ENGINE + '/app.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': '"deadbeef' + '0'.repeat(56) + '"' } });
ok('L2: a stale validator misses → the full 200', r3.status === 200 && (await r3.text()).length === body1.length, r3.status);
const r3b = await fetch(ENGINE + '/app.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': 'W/' + etag1 } });
ok('L2: the WEAK comparison law (W/ matches strong → 304)', r3b.status === 304, r3b.status);

// ── L3: the gzip variant ──
console.log('L3 — THE GZIP VARIANT (own validator + Vary):');
const g1 = await fetch(ENGINE + '/chatpanel.js', { headers: { 'Accept-Encoding': 'gzip' } });
const gzEtag = g1.headers.get('etag') || '';
ok('L3: the gzip variant engages', g1.status === 200 && (g1.headers.get('content-encoding') || '') === 'gzip', g1.status + ' ce=' + g1.headers.get('content-encoding'));
ok('L3: the W/"-gz" validator (RFC 7232 content-coding)', /^W\/"[0-9a-f]{64}-gz"$/.test(gzEtag), gzEtag);
ok('L3: Vary: Accept-Encoding rides', (g1.headers.get('vary') || '').includes('Accept-Encoding'), g1.headers.get('vary'));
const gzLen = Number(g1.headers.get('content-length') || 0);
const idResp = await fetch(ENGINE + '/chatpanel.js', { headers: { 'Accept-Encoding': 'identity' } });
const idEtag = idResp.headers.get('etag') || '';
ok('L3: the two representations carry DIFFERENT validators (the content-coding law)', gzEtag !== idEtag && /^"[0-9a-f]{64}"$/.test(idEtag), idEtag);
const g2 = await fetch(ENGINE + '/chatpanel.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gzEtag } });
ok('L3: the -gz validator revalidates → 304', g2.status === 304 && (g2.headers.get('content-encoding') || '') === '', g2.status);
const g3 = await fetch(ENGINE + '/chatpanel.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag1 } });
ok('L3: the IDENTITY validator never 304s against the gzip representation', g3.status === 200, g3.status);

// ── L4: THE LIVE OTA PROOF ──
console.log('L4 — THE LIVE OTA PROOF (the patch flips the validator, no restart):');
const a1 = await fetch(ENGINE + '/vendor/format/marked.min.js', { headers: { 'Accept-Encoding': 'identity' } });
const aEtag1 = a1.headers.get('etag') || '';
const aBody1 = await a1.text();
ok('L4: the embedded asset answers with its validator', a1.status === 200 && /^"[0-9a-f]{64}"$/.test(aEtag1), aEtag1);
const patch = '// THE V1322 PATCH PROOF\n' + aBody1.replace(/;$/, ';\n// patched');
const patchDir = DATA_DIR + '/ota/vendor/format';
fs.mkdirSync(patchDir, { recursive: true });
fs.writeFileSync(patchDir + '/marked.min.js', patch);
const a2 = await fetch(ENGINE + '/vendor/format/marked.min.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': aEtag1 } });
const aBody2 = await a2.text();
const aEtag2 = a2.headers.get('etag') || '';
ok('L4: the cached client\u2019s stale validator MISSES (the patch arrives)', a2.status === 200 && aBody2 === patch, a2.status);
ok('L4: the served bytes ARE the patched bytes', aBody2.includes('THE V1322 PATCH PROOF'));
ok('L4: the ETag FLIPPED with the patch', aEtag2 !== aEtag1 && aEtag2 !== '', aEtag1 + ' → ' + aEtag2);
const a3 = await fetch(ENGINE + '/vendor/format/marked.min.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': aEtag2 } });
ok('L4: the new validator revalidates → 304', a3.status === 304, a3.status);
const a4 = await fetch(ENGINE + '/vendor/format/marked.min.js', { headers: { 'Accept-Encoding': 'identity' } });
ok('L4: the validator-free reload also serves the patch (the fresh device)', (await a4.text()) === patch);
fs.rmSync(patchDir, { recursive: true, force: true });
const a5 = await fetch(ENGINE + '/vendor/format/marked.min.js', { headers: { 'Accept-Encoding': 'identity', 'If-None-Match': aEtag2 } });
ok('L4: removing the overlay restores the embedded validator chain (old etag misses → 200 embedded)', a5.status === 200 && (await a5.text()) === aBody1, a5.status);
// ── L5: the wasm route ──
console.log('L5 — THE WASM VALIDATOR (the max-age contract untouched):');
const w1 = await fetch(ENGINE + '/vendor/pm/privatemode.wasm');
const wEtag = w1.headers.get('etag') || '';
ok('L5: the wasm answers 200 + ETag + the v0.15 contract', w1.status === 200 && wEtag !== '' && (w1.headers.get('content-encoding') || '') === 'gzip' && (w1.headers.get('cache-control') || '') === 'public, max-age=86400', wEtag);
const w2 = await fetch(ENGINE + '/vendor/pm/privatemode.wasm', { headers: { 'If-None-Match': wEtag } });
ok('L5: the wasm validator revalidates → 304', w2.status === 304, w2.status);

// ── L6: THE BROWSER RECEIPT ──
console.log('L6 — THE BROWSER RECEIPT (the reload transfers ~nothing):');
ab('close');
ab('set viewport 1280 900');
ab('open ' + ENGINE + '/?apk=1');
await sleep(2600);
const t1 = JSON.parse(pstr("(function(){var rs=(performance.getEntriesByType('resource')||[]).filter(function(r){return /chatpanel\\.js|app\\.js/.test(r.name)});return JSON.stringify(rs.map(function(r){return {n:r.name.split('/').pop(),t:r.transferSize,d:r.decodedBodySize}}))})()"));
const firstChat = (t1.filter(function (x) { return x.n === 'chatpanel.js'; })[0] || {});
ok('L6: the first load transfers the FULL bodies', (firstChat.t || 0) > 50000, JSON.stringify(firstChat));
ab('open ' + ENGINE + '/?apk=1');
await sleep(2600);
const t2 = JSON.parse(pstr("(function(){var rs=(performance.getEntriesByType('resource')||[]).filter(function(r){return /chatpanel\\.js|app\\.js/.test(r.name)});return JSON.stringify(rs.map(function(r){return {n:r.name.split('/').pop(),t:r.transferSize,d:r.decodedBodySize}}))})()"));
const secondChat = (t2.filter(function (x) { return x.n === 'chatpanel.js'; })[0] || {});
ok('L6: the RELOAD\u2019s revalidation transfers ~nothing (the 304 receipt)', secondChat.d === 0 && secondChat.t < 2000, JSON.stringify(secondChat));
const errs = pstr("(function(){return 'noerrorguard'})()");
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
await sleep(400);
const e2 = pstr('(JSON.stringify(window.__errs||[]))');
ok('L6: zero page errors on the reloaded PWA', e2 === '[]', e2);
ab('screenshot /tmp/v1322-shots/reload-304s.png');

// ══ the verdict ══════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════');
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS ' + n + '/' + n + ' — v1.32.2 THE HONEST VALIDATOR rig');
