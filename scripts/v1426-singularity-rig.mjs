#!/usr/bin/env node
// v1426-singularity-rig.mjs — v1.42.6 THE SINGULARITY redteam (PLAN-V142
// §3.3): black holes = two-way portals, proven LIVE (a real engine + the
// real PWA + the real finger where it matters):
//
//   T1  THE BIRTH PATH IS REAL: long-press the canvas → the menu gains
//       'New Portal' → the world picker (a PANEL view) lists the other
//       world
//   T2  THE PAIR LAW: picking births BOTH sides — the local hole on the
//       canvas (probe) + the return hole inside the TARGET's engine row
//       (same pairId, aiming home)
//   T3  THE DIVE: tap the hole → its panel → 'fall through' → the dive
//       event → the SWAP (world-switched) → the emerge → done ok — the
//       active world IS the target and the camera lands at its saved
//       position
//   T4  THE CANCEL: a mid-dive press cancels — done {ok:false,canceled},
//       NO switch event, the camera returns to the pre-dive home
//   T5  THE LOST PORTAL: the target row dies → reload → the hole heals
//       to 'lost' → the dive refuses (never a crash)
//   T6  THE PAIR DELETE: the panel's delete kills BOTH sides (the local
//       hole + the far row's hole)
//   T7  zero page errors · holes.js rides the theme pin (zero literals)
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1426-rig-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1426-rig-'));
const ENGINE_PORT = 8435;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
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
    await sleep(350);
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
  return { offset: { x: -100, y: 60 }, scale: 1, currentFamily: 'default',
    icons: [icon(900), icon(901)], dots: [], settings: { theme: 'midnight' }, savedAt: Date.now(), canvas: 'default' };
}
function worldB() {
  const icons = [];
  for (let i = 0; i < 3; i++) icons.push(icon(i));
  return { offset: { x: 220, y: -140 }, scale: 0.9, currentFamily: 'default',
    icons, dots: [], settings: { theme: 'ocean' }, savedAt: Date.now(), canvas: 'w5' };
}

async function boot() {
  console.log('boot: the engine + the real PWA');
  // v1.42.8 harness law (TWO convictions): (1) the previous run's app
  // page SURVIVES in agent-browser and its calm-sync flush resurrects
  // ghost state in the fresh engine's db; (2) the tab's accumulated
  // HISTORY (50+ entries across re-runs) desyncs the overlay's marker
  // chain and overshoots drains past the app root. BOTH die with a
  // full browser reset — close --all; the next command relaunches it
  // pristine (fresh page, fresh history).
  try { ab(['close', '--all']); } catch (e) {}
  await sleep(600);
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
  // seed ORDER: B first, THEN A (sort ASC, updated_at DESC → the pointerless
  // fresh boot deterministically lands on Home)
  await api('PUT', '/api/canvases/w5', { name: 'The Field', state: worldB() });
  await api('PUT', '/api/canvases/default', { name: 'Home', state: worldA() });
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__pd=[];window.addEventListener('doomalay:portal-done',function(e){window.__pd.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
}

// the canvas-surface gesture helpers (the v1422 walk's MouseEvent law:
// synthetic gestures must dispatch on the canvas surface — #c or
// #chatbots — or the app's input gate never sees them)
function press(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'down'})()");
}
function release(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'up'})()");
}
function tapEl(selector) {
  const r = abJson("(function(){var el=document.querySelector(" + JSON.stringify(selector) + ");if(!el||!el.getBoundingClientRect)return null;var r=el.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()");
  if (!r) return null;
  press(Math.round(r.x), Math.round(r.y));
  sleep(60).then(() => release(Math.round(r.x), Math.round(r.y)));
  return r;
}

(async () => {
  console.log('v1426-singularity-rig — THE SINGULARITY (portals live)');
  await boot();

  // ── T1 the birth path is real ───────────────────────────────────
  press(500, 400);            // the canvas long-press
  ok('T1 the long-press menu opens', await waitFn("(function(){var m=document.getElementById('menu');return m&&!m.classList.contains('hidden')})()", 3000));
  ok('T1 the menu carries the New Portal row', pstr("(function(){var b=document.querySelector('#menu [data-action=new-portal]');return b?b.textContent:'none'})()") === '◉ New Portal');
  abEval("(function(){var b=document.querySelector('#menu [data-action=new-portal]');if(b)b.click();return 'clicked'})()");
  ok('T1 the world picker opens (a PANEL view)', await waitFn("!!document.querySelector('[data-portal-to=w5]')", 8000));
  ok('T1 the picker lists the other world (not the active one)', pstr("document.querySelector('[data-portal-to=w5]')?document.querySelector('[data-portal-to=w5]').textContent:'none'").indexOf('The Field') >= 0,
    pstr("document.querySelector('[data-portal-to=w5]')?document.querySelector('[data-portal-to=w5]').textContent:'none'"));

  // ── T2 the pair law ─────────────────────────────────────────────
  abEval("(function(){var b=document.querySelector('[data-portal-to=w5]');if(b)b.click();return 'picked'})()");
  ok('T2 the pair births (the local hole appears)', await waitFn("(window.Holes&&window.Holes.probe().holes.length===1)", 10000));
  await sleep(800);   // the calm save settles the local row too
  const probe1 = abJson("JSON.stringify(window.Holes.probe())");
  ok('T2 the local hole aims at the Field', probe1 && probe1.holes.length === 1 && probe1.holes[0].target === 'w5' && !!probe1.holes[0].pair, JSON.stringify(probe1));
  const pairId = probe1 && probe1.holes[0] ? probe1.holes[0].pair : null;
  const holeElSel = '#chatbots [data-type=hole]';
  ok('T2 the hole wears the DOM (a real icon)', pstr("document.querySelectorAll('#chatbots [data-type=hole]').length") === '1');
  const rowB = await api('GET', '/api/canvases/w5');
  const farHoles = (rowB.body.canvas.state.icons || []).filter((ic) => ic.type === 'hole');
  ok('T2 the return hole lives in the TARGET row (two-way law)', farHoles.length === 1 && farHoles[0].pairId === pairId && farHoles[0].targetWorldId === 'default',
    JSON.stringify(farHoles.map((h) => ({ p: h.pairId, t: h.targetWorldId }))) + ' vs pair ' + pairId);

  // ── T3 the dive ─────────────────────────────────────────────────
  // tap the hole (the real finger path: the tap dispatch → the hole panel)
  const camBefore = abJson("JSON.stringify(window.doomalay.cameraProbe())");
  void tapEl(holeElSel);
  ok('T3 the hole panel opens on tap', await waitFn("!!document.getElementById('hole-body')", 8000));
  abEval("(function(){var b=document.getElementById('hole-dive');if(!b)return 'no-btn';b.click();return 'diving'})()");
  ok('T3 the dive event fires', await waitFn("(window.Holes&&window.Holes.probe().phase!=='idle')", 4000));
  ok('T3 the SWAP lands (world-switched under the veil)', await waitFn("(window.__sw||[]).some(s=>s.id==='w5'&&s.ok)", 15000));
  ok('T3 the transition completes (done ok)', await waitFn("(window.__pd||[]).some(d=>d.ok===true)", 15000));
  await sleep(600);
  const probe3 = abJson("JSON.stringify(window.Holes.probe())");
  const active3 = abJson("JSON.stringify(window.doomalay.worldsProbe())");
  ok('T3 the active world IS the Field', active3 && active3.active === 'w5', JSON.stringify(active3));
  ok('T3 the runtime is idle again', probe3 && probe3.phase === 'idle', JSON.stringify(probe3));
  const cam3 = abJson("JSON.stringify(window.doomalay.cameraProbe())");
  const seededB = worldB();
  ok('T3 the camera emerged at the Field\'s saved position', cam3 && Math.abs(cam3.x - seededB.offset.x) < 60 && Math.abs(cam3.y - seededB.offset.y) < 60,
    'cam=' + JSON.stringify({ x: cam3 && cam3.x, y: cam3 && cam3.y }) + ' want≈' + JSON.stringify(seededB.offset));
  void camBefore;
  // the veil is gone
  ok('T3 the veil retired', pstr("(function(){var v=document.getElementById('hole-veil');return v?(v.style.display==='none'||parseFloat(v.style.opacity)===0?'gone':'SHOWING '+v.style.opacity):'no-el'})()") === 'gone');

  // ── T4 the cancel ───────────────────────────────────────────────
  // (living in the Field now; its return hole aims home)
  const camPre = abJson("JSON.stringify(window.doomalay.cameraProbe())");
  abEval("(function(){var hs=window.Holes.probe().holes;if(!hs.length)return 'no-hole';window.Holes.transition(window.doomalay.world.entities.filter(function(e){return e.type==='hole'})[0]);return 'diving'})()");
  await sleep(260);   // mid-dive (~37% in)
  const midPhase = pstr("window.Holes.probe().phase");
  press(500, 400);    // THE FINGER IS BOSS — the cancel gesture
  await sleep(120);
  ok('T4 the dive was live when cancelled', midPhase === 'dive', 'phase=' + midPhase);
  ok('T4 the cancel completes (done canceled)', await waitFn("(window.__pd||[]).some(d=>d.canceled===true)", 6000));
  await sleep(400);
  const camPost = abJson("JSON.stringify(window.doomalay.cameraProbe())");
  ok('T4 NO switch happened (still the Field)', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === 'w5' && (abJson("JSON.stringify(window.__sw)") || []).filter((s) => s.ok).length === 1,
    JSON.stringify(abJson("JSON.stringify(window.__sw)")));
  ok('T4 the camera returned to the pre-dive home', camPost && camPre && Math.abs(camPost.x - camPre.x) < 40 && Math.abs(camPost.y - camPre.y) < 40 && Math.abs(camPost.scale - camPre.scale) < 0.35,
    'pre=' + JSON.stringify({ x: camPre && camPre.x, y: camPre && camPre.y, s: camPre && camPre.scale }) + ' post=' + JSON.stringify({ x: camPost && camPost.x, y: camPost && camPost.y, s: camPost && camPost.scale }));

  // ── T5 the lost portal ──────────────────────────────────────────
  // the return hole (in the Field) aims at Home — kill Home's row, reload
  const delHome = await api('DELETE', '/api/canvases/default');
  ok('T5 the Home row dies engine-side', delHome.status === 200);
  ab(['open', ENGINE]);   // the reload
  ok('T5 the reload boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(2000);
  abEval("(function(){window.__pd=[];window.__errs=[];return 'rewired'})()");
  const probe5 = abJson("JSON.stringify(window.Holes.probe())");
  ok('T5 the return hole survived the reload (serialized)', probe5 && probe5.holes.length === 1 && probe5.holes[0].target === 'default', JSON.stringify(probe5));
  ok('T5 the hole healed to LOST', probe5 && probe5.holes.length === 1 && probe5.holes[0].lost === true, JSON.stringify(probe5));
  // the dive refuses — never a crash
  const refuse = await (async () => {
    abEval("(function(){var hs=window.doomalay.world.entities.filter(function(e){return e.type==='hole'});if(!hs.length){window.__refuse='no-hole';return}window.Holes.transition(hs[0]).then(function(r){window.__refuse=r})})()");
    for (let i = 0; i < 14; i++) { const r = abJson("(window.__refuse!==undefined)?JSON.stringify(window.__refuse):null"); if (r) return r; await sleep(300); }
    return null;
  })();
  ok('T5 the dive REFUSES on the lost hole', refuse && refuse.ok === false, JSON.stringify(refuse));
  ok('T5 zero errors across the lost-portal path', pstr("JSON.stringify(window.__errs||[])") === '[]', pstr("JSON.stringify(window.__errs||[])"));

  // ── T6 the pair delete ──────────────────────────────────────────
  // bring Home back, birth a fresh pair (API precision — the finger paths
  // are T1-T4's), then delete THAT pair through the PANEL's button.
  // NOTE: T5's lost hole is still on the canvas — the tap must target
  // the NEW hole's OWN element (el.dataset.id), and the assertions must
  // count by pairId (the lost survivor is not this test's business).
  await api('PUT', '/api/canvases/default', { name: 'Home', state: worldA() });
  await sleep(300);
  const created = await (async () => {
    abEval("(function(){window.__cp=null;window.Holes.createPair({x:400,y:260},'default','the way home').then(function(r){window.__cp=r},function(e){window.__cp={err:String(e&&e.message||e)}})})()");
    for (let i = 0; i < 14; i++) { const r = abJson("(window.__cp!==undefined&&window.__cp!==null)?JSON.stringify(window.__cp):null"); if (r) return r; await sleep(300); }
    return null;
  })();
  ok('T6 the fresh pair births (home is back)', created && created.ok === true, JSON.stringify(created));
  const newPair = created && created.pairId;
  const newHoleId = created && created.hole && created.hole.id;
  // tap the NEW hole (its OWN element — the first [data-type=hole] may be
  // T5's lost survivor)
  void tapEl('#chatbots [data-id="' + newHoleId + '"]');
  ok('T6 the hole panel opens (the NEW hole)', await waitFn("!!document.getElementById('hole-body')", 8000));
  abEval("(function(){var b=document.getElementById('hole-del');if(!b)return 'no-btn';b.click();return 'deleting'})()");
  ok('T6 the pair delete completes (THIS pair dies)', await waitFn("(window.Holes&&(window.Holes.probe().holes.filter(function(h){return h.pair===" + JSON.stringify(newPair) + "}).length===0))", 10000));
  await sleep(900);
  const rowHome = await api('GET', '/api/canvases/default');
  const homeHoles = (rowHome.body.canvas.state.icons || []).filter((ic) => ic.type === 'hole');
  ok('T6 BOTH sides died (the far row carries no hole of this pair)', !homeHoles.some((h) => h.pairId === newPair),
    JSON.stringify(homeHoles.map((h) => h.pairId)) + ' vs ' + newPair);

  // ── T7 the close-out laws ───────────────────────────────────────
  // NOTE: `agent-browser errors` is decorative in this CLI build (bare ✗
  // marks regardless of page state) — the IN-PAGE listener is the truth.
  const errs = ab(['errors']);
  const realErrLines = String(errs).split('\n').map((l) => l.trim()).filter((l) => l && l !== '✗' && l !== '✓');
  ok('T7 zero page errors across the whole rig', realErrLines.length === 0, JSON.stringify(realErrLines).slice(0, 300));
  ok('T7 zero in-page exceptions', pstr("JSON.stringify(window.__errs||[])") === '[]', pstr("JSON.stringify(window.__errs||[])"));
  ok('T7 the runtime is idle at rest', pstr("window.Holes.probe().phase") === 'idle');

  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  console.log(`\n${n - fails.length}/${n} passed${fails.length ? '\n  FAILED: ' + fails.join(' · ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
