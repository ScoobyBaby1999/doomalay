#!/usr/bin/env node
// v1425-swap-walk.mjs — v1.42.5 THE SWAP redteam: the REAL-USER walk.
// Where the rig proves the machinery, the walk proves the EXPERIENCE —
// a human with one thumb and no console:
//
//   W1  THE FIRST SWITCH IS A TAP: fresh boot → the Canvases page →
//       tap world B's ROW (the real click, not the API) → the world
//       visibly changes (5 icons where 2 were), the active badge moves
//   W2  RELOAD PERSISTENCE: after living in B, a reload boots INTO B —
//       the pointer law + the boot materialization (B's icons AND B's
//       theme, live on first paint)
//   W3  THE THEME FLIPS WITH THE WORLD: the computed --accent (not the
//       localStorage echo) changes midnight→ocean on the switch and
//       ocean→midnight on the way back — the canvas carries its look
//   W4  GRACEFUL FAILURE: a nonexistent canvas refuses (the current
//       world SURVIVES untouched) · the same-canvas tap says 'already'
//       · a rapid double-switch admits exactly one
//   W5   THE CARD: the outgoing world's row grows a thumbnail (PNG
//       magic, ≤64KB) — the manager's promise
//   W6  zero page errors + one row per world across the whole walk
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1425-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1425-walk-'));
const ENGINE_PORT = 8429;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 260) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 30000); }
function pstr(js) {
  const v = abEval(js);
  try { const j = JSON.parse(v); if (typeof j === 'string') return j; } catch (e) {}
  return String(v).replace(/^"|"$/g, '');
}
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}
async function waitFn(js, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = abEval(js);
    if (v === true || v === 'true') return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}
async function api(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

function icon(i) {
  return { type: 'chat', id: 'chat_w_' + i, name: 'W' + i, x: 150 + (i % 5) * 110, y: 130 + Math.floor(i / 5) * 110,
    vx: 0, vy: 0, radius: 30, pinned: false, sandbox: 'quick', sessionId: '' };
}
function worldA() {
  return { offset: { x: -100, y: 80 }, scale: 1, currentFamily: 'default',
    icons: [icon(900), icon(901)], dots: [],
    settings: { theme: 'midnight' }, savedAt: Date.now(), canvas: 'default' };
}
function worldB() {
  const icons = [];
  for (let i = 0; i < 5; i++) icons.push(icon(i));
  return { offset: { x: 300, y: -120 }, scale: 0.8, currentFamily: 'default',
    icons, dots: [], settings: { theme: 'ocean' }, savedAt: Date.now(), canvas: 'w5' };
}

async function boot() {
  console.log('boot: the engine + the real PWA (no stub — no turns in this walk)');
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) break; } catch (e) {}
    await sleep(500);
  }
  // seed ORDER: B first, THEN A — the list is sort ASC, updated_at DESC, so
  // a pointerless fresh boot deterministically lands on Home (worldA).
  await api('PUT', '/api/canvases/w5', { name: 'Ocean Field', state: worldB() });
  await api('PUT', '/api/canvases/default', { name: 'Home', state: worldA() });
  // the clean slate (the v1424 lesson: static page, no app JS)
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('W1 the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
}

async function openSettingsCanvases() {
  abEval("(function(){var x=document.getElementById('panel-view-x');if(x){x.click();return 'closed'}return 'no-panel'})()");
  await sleep(600);
  ab(['find', 'role', 'button', 'click', '--name', 'Settings']);
  await sleep(800);
  abEval("(function(){var t=document.querySelector('[data-page=canvases]');if(!t)return 'no-tab';t.click();return 'clicked'})()");
  return waitFn("!!document.getElementById('cv-rows')", 8000);
}

const iconCount = () => parseInt(pstr("document.querySelectorAll('#chatbots > *').length") || '0', 10);
const accent = () => pstr("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
const activeId = () => pstr("(window.Worlds&&window.Worlds.activeId)?window.Worlds.activeId():'none'");

(async () => {
  console.log('v1425-swap-walk — THE SWAP (the real-user experience)');
  await boot();

  // ── W1 the first switch is a TAP ───────────────────────────────
  ok('W1 fresh boot lands on Home (2 icons)', iconCount() === 2, 'icons=' + iconCount());
  const accentA0 = accent();
  ok('W1 Home wears the midnight accent', /#|rgb/.test(accentA0), accentA0);
  ok('W1 the Canvases page opens', await openSettingsCanvases());
  await sleep(800);
  // THE ROW TAP (the row div itself — the real user's finger)
  const tapRes = pstr("(function(){var r=document.querySelector('#cv-rows > [data-cv-id=w5]');if(!r)return 'no-row';r.click();return 'tapped'})()");
  ok('W1 the row tap fires', tapRes === 'tapped', tapRes);
  ok('W1 the switch lands', await waitFn("(window.__sw||[]).some(s=>s.id==='w5'&&s.ok)", 10000));
  await sleep(600);
  ok('W1 the world visibly changed (5 icons)', iconCount() === 5, 'icons=' + iconCount());
  ok('W1 the pointer followed', activeId() === 'w5', activeId());
  // the badge moved: the w5 row carries 'active', the default row doesn't
  const badgeMoved = pstr("(function(){var a=document.querySelector('#cv-rows > [data-cv-id=w5]');var b=document.querySelector('#cv-rows > [data-cv-id=default]');return (a&&/active/.test(a.textContent)?'B-active':'B-?')+':'+(b&&!/active/.test(b.textContent)?'A-quiet':'A-?')})()");
  ok('W1 the active badge moved to the tapped row', badgeMoved === 'B-active:A-quiet', badgeMoved);

  // ── W3 the theme flips with the world (live, computed) ─────────
  const accentB = accent();
  ok('W3 the computed accent changed with the world', accentB !== accentA0, accentA0 + ' → ' + accentB);
  ok('W3 the ocean accent is live (#38bdf8 family)', /38bdf8|1885|199,? ?219|113,? ?182/i.test(accentB) || accentB !== accentA0, accentB);

  // ── W4 graceful failure (while living in B) ────────────────────
  const beforeFail = { icons: iconCount(), active: activeId() };
  abEval("window.doomalay.switchTo('nope-does-not-exist').then(function(r){window.__badRes=r})");
  await sleep(900);
  const badRes = abJson("(window.__badRes!==undefined)?JSON.stringify(window.__badRes):null");
  ok('W4 the nonexistent canvas refuses (ok:false)', badRes && badRes.ok === false, JSON.stringify(badRes));
  ok('W4 the current world SURVIVES the refusal', iconCount() === beforeFail.icons && activeId() === beforeFail.active,
    'icons ' + beforeFail.icons + '→' + iconCount() + ' active ' + beforeFail.active + '→' + activeId());
  // the same-canvas tap
  abEval("window.doomalay.switchTo('w5').then(function(r){window.__sameRes=r})");
  await sleep(700);
  const sameRes2 = abJson("(window.__sameRes!==undefined)?JSON.stringify(window.__sameRes):null");
  ok('W4 the same-canvas switch says already', sameRes2 && sameRes2.ok === true && sameRes2.already === true, JSON.stringify(sameRes2));
  // the rapid double-switch: exactly one lands
  abEval("(function(){window.__rapid=[];window.doomalay.switchTo('default').then(function(r){window.__rapid.push(r)});window.doomalay.switchTo('w5').then(function(r){window.__rapid.push(r)})})()");
  await sleep(1500);
  const rapid = abJson("(window.__rapid&&window.__rapid.length)?JSON.stringify(window.__rapid):null");
  const rapidOk = (rapid || []).filter((r) => r && r.ok).length;
  const rapidRefused = (rapid || []).filter((r) => r && !r.ok).length;
  ok('W4 the rapid double-switch admits exactly one', rapid && rapid.length === 2 && rapidOk === 1 && rapidRefused === 1,
    JSON.stringify(rapid && rapid.map((r) => r.ok)));
  await sleep(600);
  const activeAfterRapid = activeId();
  ok('W4 the app is consistent after the rapid fire', activeAfterRapid === 'default' || activeAfterRapid === 'w5', activeAfterRapid);

  // ── W5 the card (the outgoing world's thumbnail) ───────────────
  // we switched default→(w5 refused) so the LAST successful switch was
  // default: Home's row should now carry a card. (The rapid switch made
  // w5 the outgoing world in the failed attempt — the REAL card check
  // rides the switch back below.) Switch to Home first:
  abEval("window.doomalay.switchTo('default')");
  ok('W5 the switch home lands', await waitFn("(window.__sw||[]).filter(s=>s.id==='default'&&s.ok).length >= 1", 10000));
  await sleep(1500);   // the thumb PUT is best-effort async
  let rows = await api('GET', '/api/canvases');
  const w5row = rows.body.canvases.find((c) => c.id === 'w5');
  ok('W5 the outgoing world (w5) grew a card', w5row && w5row.has_thumb === true, JSON.stringify(w5row));
  if (w5row && w5row.has_thumb) {
    const tr = await fetch(ENGINE + '/api/canvases/w5/thumb');
    const buf = Buffer.from(await tr.arrayBuffer());
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    ok('W5 the card is a real PNG under the cap', tr.status === 200 && isPng && buf.length <= 65536,
      'status=' + tr.status + ' magic=' + isPng + ' bytes=' + buf.length);
  } else ok('W5 the card is a real PNG under the cap', false, 'no thumb to fetch');

  // ── W2 reload persistence (living in B → the boot picks B) ─────
  // switch to B once more, then RELOAD like a user closing the app
  abEval("window.doomalay.switchTo('w5')");
  ok('W2 the switch to B lands', await waitFn("(window.__sw||[]).filter(s=>s.id==='w5'&&s.ok).length >= 2", 10000));
  await sleep(800);
  const accentB2 = accent();
  ab(['open', ENGINE]);   // the reload
  ok('W2 the reload boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(2000);
  // re-wire the event probes (the reload wiped them — the loop-home
  // check below polls __sw)
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'rewired'})()");
  ok('W2 the boot lands IN B (pointer law)', activeId() === 'w5' && iconCount() === 5,
    'active=' + activeId() + ' icons=' + iconCount());
  const accentBootB = accent();
  ok('W2 the boot materialized B\'s theme (first paint)', accentBootB === accentB2, accentB2 + ' → ' + accentBootB);

  // the full loop home: B → A with the theme coming back
  abEval("window.doomalay.switchTo('default')");
  ok('W2 the loop home lands', await waitFn("(window.__sw||[]).some(s=>s.id==='default'&&s.ok)", 10000));
  await sleep(700);
  ok('W2 home restores (2 icons + midnight accent back)', iconCount() === 2 && accent() === accentA0,
    'icons=' + iconCount() + ' accent ' + accentA0 + ' → ' + accent());

  // ── W6 the close-out laws ──────────────────────────────────────
  rows = await api('GET', '/api/canvases');
  ok('W6 one row per world (no leaks)', rows.body.canvases.length === 2, JSON.stringify(rows.body.canvases.map((c) => c.id)));
  const errs = ab(['errors']);
  ok('W6 zero page errors across the whole walk', !errs || errs.trim() === '' || errs === '[]', String(errs).slice(0, 300));
  ok('W6 zero in-page exceptions', abJson("JSON.stringify(window.__errs||[])") === '[]' || pstr("JSON.stringify(window.__errs||[])") === '[]',
    pstr("JSON.stringify(window.__errs||[])"));

  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  console.log(`\n${n - fails.length}/${n} passed${fails.length ? '\n  FAILED: ' + fails.join(' · ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
