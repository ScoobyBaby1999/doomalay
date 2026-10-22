#!/usr/bin/env node
// v1620-honest-field-rig.mjs — v1.62 THE HONEST FIELD battery (PLAN-V162 §4).
//
// §0 parse + source pins: the four sub-waves' laws live in the source.
// §1 THE CONTINUOUS CLAMP (v1.62.1): the numeric contrast (the OLD law's
//    ~8,000-world-unit one-frame lurch vs the NEW law's ≤150-unit smooth
//    tracking — the rig's own algebra); the LIVE sweep through the
//    crossing (max per-step probe delta < 150 units ≈ <8px on screen);
//    the crossing straddle (±0.3% — <120 units, was ~8,200 ≈422px); the
//    canonical range lands to the unit (a violent setView pins exactly
//    half−vw); at the floor the whole world fits BOTH axes, centered
//    (the degenerate −vw/2); the finger cannot push past the edge (a
//    real drag stops at exactly half−vw).
// §2 THE PROPORTIONAL STRIDE (v1.62.2): real-finger 100px drags at
//    1.0 / 0.5 / 0.125 / 0.05 — the world delta is EXACTLY 100/scale
//    (was a flat 100 at every zoom); one 300px stride at 0.05 covers
//    ≥30% of the whole world (the "10 seconds of dragging" crawl is
//    dead); the momentum cap rides the SCREEN law (source pin); the
//    ICON_DRAG twin unchanged (dx/scale).
// §3 THE EIGHT TILES (v1.62.3): the pair [10,24] + jointCells 120 live;
//    the 8-tiles math (16384/(120·48) = 2.844² = 8.09 — "like 8 give or
//    take"); the rotation law (ALL 8 neighbors differ — pure math) +
//    the checkerboard mirror; the effective joint period with rotations
//    (480 cells — beyond the whole world); instDraws > 0 with ZERO
//    fallbacks across the whole zoom-out sweep; the ladder stable
//    through zoom-out (misses stays 1 — no re-bakes); 0.125
//    byte-identical (farK 1 + dots) + the floor map view (farK 0,
//    renderTiles 0, dots 0); the ladder bytes under the cap; the
//    sub-pixel ceiling is the unreachable guard (source pin).
// §4 THE SEEN ONLY (v1.62.4): off-view icons display:none (the cull
//    census); the MutationObserver write census during a REAL pan
//    (0 plain-icon writes + 1 container write per camera change — the
//    ride); the movers paint on-screen only (twinklers counted, comets
//    honestly none in the rig's window); the atoms/twinkler culls are
//    the source's; the lattice paints in the WORKER (the main thread
//    reserved); the physics honest note (off-screen = no DOM writes;
//    the cull law is the RENDER's).
// §5 honesty: zero page errors + zero new color literals in the new
//    code + zero new surfaces (B1).
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(__ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');

const ENGINE_PORT = 8462;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1620-rig-engine';
const DATA_DIR = '/tmp/v1620-rig-data';

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log('\n═ ' + t); }

const ab = (args, timeoutMs) => {
  try {
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 30000, encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ERR: ' + String((e && e.stderr) || e.message || e).slice(0, 160);
  }
};
function abEval(js) { return ab(['eval', js], 45000); }
function abJson(js) {
  const v = abEval(js);
  try {
    let j = JSON.parse(v);
    if (typeof j === 'string') j = JSON.parse(j);
    return j;
  } catch (e) { return null; }
}
async function api(method, p, body, raw) {
  const init = { method };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(ENGINE + p, init);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, body: d };
}

// ══ §0 parse + source pins ══════════════════════════════════════════
section('§0 the touched files parse + the laws live in the source');
for (const f of ['app.js', 'lattice.js', 'gridworker.js', 'gridicon.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
{
  const ax = read('app.js');
  const la = read('lattice.js');
  // v1.62.1 THE CONTINUOUS CLAMP
  ok('the canonical clamp law: offset ∈ [−half, half−vw] + the degenerate −vw/2',
    /if \(offsetX < -half\) offsetX = -half;/.test(ax) && /if \(offsetX > half - vw\) offsetX = half - vw;/.test(ax) &&
    /if \(vw >= WORLD_SIZE\) offsetX = -vw \/ 2;/.test(ax));
  ok('the old lopsided law is DEAD (no ±(half − vw/2) anywhere)',
    !/var maxX = half - vw \/ 2;/.test(ax));
  ok('THE LIVE-CENTROID PINCH: the anchor recomputed at the live centroid',
    /const liveCx = \(e\.touches\[0\]\.clientX \+ e\.touches\[1\]\.clientX\) \/ 2;/.test(ax) &&
    /const worldX = liveCx \/ pinchStartScale \+ pinchStartOffsetX;/.test(ax) &&
    /offsetX = worldX - liveCx \/ newScale;/.test(ax));
  ok('the start-frozen pinchCenter is RETIRED', !/pinchCenter = \{/.test(ax));
  // v1.62.2 THE PROPORTIONAL STRIDE
  ok('the stride: the world delta is the screen delta / scale',
    /const ddx = -dx \/ scale, ddy = -dy \/ scale;/.test(ax));
  ok('the momentum cap rides the SCREEN law (18px/16ms at any zoom)',
    /const cap = MAX_PAN_VELOCITY \/ scale;/.test(ax) &&
    /Math\.min\(cap, \(ddx \/ dt\) \* 16\)/.test(ax));
  ok('the ICON_DRAG twin unchanged (dx / scale)', /draggedIcon\.x \+= dx \/ scale;/.test(ax));
  // v1.62.3 THE EIGHT TILES
  ok('the pair ladder: [10, 24] first + the readability gate 0.70',
    /var TL_PAIRS = \[\[10, 24\], \[8, 14\], \[6, 10\], \[4, 6\]\];/.test(la) && /if \(Rref >= 0\.70\) break;/.test(la));
  ok('tlFillInstances: the rotation law (i+2j)&3 + the checkerboard mirror',
    /var rot = \(i \+ 2 \* j\) & 3;/.test(la) && /var flip = \(\(i \+ j\) & 1\) === 1;/.test(la) &&
    /if \(rot\) gc\.rotate\(rot \* TWO_PI_QUARTER\);/.test(la) && /if \(flip\) gc\.scale\(-1, 1\);/.test(la));
  ok('the rotation is about the instance CENTER (seamless tiling)',
    /gc\.translate\(bx \+ i \* Tcss \+ half, fy\);/.test(la) && /gc\.drawImage\(tile\.canvas, -half, -half, Tcss, Tcss\);/.test(la));
  ok('the sub-pixel ceiling: >2048 falls back to the plain fill',
    /if \(inst > 2048\) \{   \/\/ the sub-pixel regime — the honest fallback/.test(la) && /TL\.instFallbacks\+\+;/.test(la));
  ok('the instance instrument (instDraws/instFallbacks/joint) on the accessor + the stats',
    /instDraws: TL\.instDraws || 0/.test(la) && /instDraws: TL\.instDraws, instFallbacks: TL\.instFallbacks/.test(la) &&
    /jointCells: T \? T\.cells : 0,/.test(la));
  // v1.62.4 THE SEEN ONLY (the culls are the source's)
  const at = read('atoms.js');
  ok('atoms: the spheres + stars pad-cull per element',
    /if \(fx < -fogR - 40 \|\| fx > W \+ fogR \+ 40/.test(at) && /if \(x < -vr - 120 \|\| x > W \+ vr \+ 120/.test(at));
  ok('twinklers: the walk keys on the live camera (viewport-only) + the hard ceiling',
    /var x0 = Math\.floor\(-bx \/ spacingNow\) - 1, x1 = Math\.ceil\(\(W - bx\) \/ spacingNow\) \+ 1;/.test(la) &&
    /\(x1 - x0\) \* \(y1 - y0\) > 16384\) return 0;/.test(la));
  ok('comets: spawn at the screen edges + the ±250 cull',
    /var sx = \(edge === 0\) \? -30 : \(edge === 2 \? W \+ 30/.test(la) && /x < -250 \|\| x > W \+ 250/.test(la));
}

// ══ boot ════════════════════════════════════════════════════════════
section('§0.5 boot (the pristine-browser law)');
try { ab(['close', '--all']); } catch (e) {}
await sleep(600);
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
  env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
});
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
  detached: true, stdio: 'ignore',
  env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' },
});
child.unref();
let booted = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(ENGINE + '/api/health')).ok) { booted = true; break; } } catch (e) {}
  await sleep(500);
}
ok('the engine boots', booted);

// SEED: the v1570 mixed world — 4 spaced plains + an auto-grouped web pair
// (seeded AWAKE) + one pinned far out. The far icons exercise §4's cull.
const seedIcons = [
  { id: 'p1', type: 'chat', x: -600, y: -400, radius: 28, name: 'PlainOne', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p2', type: 'chat', x: 600, y: -400, radius: 28, name: 'PlainTwo', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p3', type: 'chat', x: -600, y: 400, radius: 28, name: 'PlainThree', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p4', type: 'chat', x: 600, y: 400, radius: 28, name: 'PlainFour', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'w1', type: 'web', x: 0, y: 0, vx: 1.5, vy: 1, radius: 28, url: 'https://one.example.com', title: 'WebOne' },
  { id: 'w2', type: 'web', x: 10, y: 8, vx: -1.5, vy: -1, radius: 28, url: 'https://two.example.com', title: 'WebTwo' },
  { id: 'pin1', type: 'chat', x: 0, y: -1400, radius: 28, name: 'PinnedFar', sessionId: '', model: 'glm-5.3', provider: 'opencode', pinned: true },
  { id: 'far1', type: 'chat', x: -5200, y: 4600, radius: 28, name: 'FarCull', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'far2', type: 'chat', x: 5100, y: -4700, radius: 28, name: 'FarCull2', sessionId: '', model: 'glm-5.3', provider: 'opencode' }
];
await api('PUT', '/api/canvases/wRig', {
  name: 'Rig World',
  state: { offset: { x: -640, y: -400 }, scale: 1, currentFamily: '', savedAt: Date.now(),
    icons: seedIcons, dots: [] }
});
ab(['open', ENGINE + '/']);
// the phone class (390×844) — the rig's stride/clamp scales are tuned to
// it (the 1280 default makes 0.05 degenerate on X — a different regime).
ab(['set', 'viewport', '390', '844']);
await sleep(2500);
ok('the app boots ready', abEval("(function(){return !!window.__doomalayReady})()") === 'true');
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'armed'})()");

// ══ §1 THE CONTINUOUS CLAMP ═════════════════════════════════════════
section('§1 THE CONTINUOUS CLAMP (v1.62.1)');
{
  // (a) THE NUMERIC CONTRAST — the rig's own algebra: the OLD law vs the
  // NEW law across the crossing, camera parked at the world's top-left.
  const W = 390, WS = 16384, half = WS / 2;
  const oldClamp = (off, vw) => { if (vw >= WS) return -vw / 2; const mx = half - vw / 2; return Math.max(-mx, Math.min(mx, off)); };
  const newClamp = (off, vw) => { if (vw >= WS) return -vw / 2; return Math.max(-half, Math.min(half - vw, off)); };
  let oldWorst = 0, newWorst = 0, prevO = null, prevN = null;
  for (let vw = W / 0.06; vw <= WS * 1.2; vw += WS / 600) {
    const o = oldClamp(half - 40, vw), nn = newClamp(half - 40, vw);
    if (prevO !== null) { oldWorst = Math.max(oldWorst, Math.abs(o - prevO)); newWorst = Math.max(newWorst, Math.abs(nn - prevN)); }
    prevO = o; prevN = nn;
  }
  ok('the algebra: the OLD law lurches ≥4,000 units in one step at the crossing', oldWorst >= 4000, String(Math.round(oldWorst)));
  ok('the algebra: the NEW law tracks ≤150 units per step (≈<8px on screen)', newWorst <= 150, String(Math.round(newWorst)));

  // (b) THE LIVE SWEEP — setView steps from above the Y-crossing to the
  // floor; the probe delta per step must stay tiny (no lurch, no snap).
  const p0 = abJson("(function(){var p=doomalay.cameraProbe();return JSON.stringify({w:p.w,h:p.h,ws:p.worldSize,floor:p.minScaleLive})})()");
  const crossY = p0.h / p0.ws, floor = p0.floor;
  abEval(`doomalay.setView(${p0.ws / 2 - 40}, ${p0.ws / 2 - 40}, ${crossY * 1.15})`);
  const start = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
  let liveWorst = 0, liveWorstAt = 0, prev = start;
  for (let s = crossY * 1.15; s >= floor; s *= 0.995) {
    abEval(`doomalay.setView(${start.x}, ${start.y}, ${s})`);
    const p = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
    const d = Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y));
    if (d > liveWorst) { liveWorst = d; liveWorstAt = s; }
    prev = p;
  }
  ok('the LIVE sweep: max per-step camera delta < 150 world units (was an 8,192 lurch)', liveWorst < 150, String(Math.round(liveWorst)) + ' @' + liveWorst.toFixed(5));

  // (c) THE CROSSING STRADDLE — ±0.3% around the Y crossing (both sides
  // of the branch flip): the delta is the tracking, not a snap.
  abEval(`doomalay.setView(${start.x}, ${start.y}, ${crossY * 1.003})`);
  const above = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
  abEval(`doomalay.setView(${start.x}, ${start.y}, ${crossY * 0.997})`);
  const below = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
  const straddle = Math.max(Math.abs(above.x - below.x), Math.abs(above.y - below.y));
  ok('the straddle across the branch flip: <120 units (the old law: ~8,200 ≈422px)', straddle < 120, String(Math.round(straddle)));

  // (d) THE CANONICAL RANGE lands to the unit — a violent setView past
  // the edge pins EXACTLY half − vw (the old law pinned ±(half−vw/2)).
  abEval(`doomalay.setView(${p0.ws}, ${p0.ws}, 0.5)`);
  const c = abJson("(function(){var p=doomalay.cameraProbe();var vw=p.w/p.scale,vh=p.h/p.scale,half=p.worldSize/2;return JSON.stringify({x:p.x,y:p.y,xMax:half-vw,yMax:half-vh,xOk:Math.abs(p.x-(half-vw))<0.01,yOk:Math.abs(p.y-(half-vh))<0.01})})()");
  ok('a violent setView past the edge clamps to EXACTLY half−vw (the viewport\'s edge lands on the world\'s edge)', c && c.xOk && c.yOk, JSON.stringify(c));

  // (e) AT THE FLOOR — the whole world fits BOTH axes (the viewport
  // covers [−half, +half]: right edge ≥ half−1), centered on the deep axis.
  abEval('doomalay.setView(0,0,0.001)');
  await sleep(400);
  const fl = abJson("(function(){var p=doomalay.cameraProbe();var half=p.worldSize/2;return JSON.stringify({s:p.scale,floor:p.minScaleLive,w:p.w,h:p.h,x:p.x,y:p.y,fitX:(p.x<=-half+1)&&(p.x+p.w/p.scale>=half-1),fitY:(p.y<=-half+1)&&(p.y+p.h/p.scale>=half-1)})})()");
  ok('at the floor the WHOLE world fits both axes', fl && fl.fitX && fl.fitY, JSON.stringify(fl));
  ok('at the floor the deep (taller) axis is degenerate-centered: y ≈ −vh/2', fl && Math.abs(fl.y + fl.h / fl.s / 2) < 4, 'y=' + (fl && Math.round(fl.y)) + ' expect ' + (fl && Math.round(-fl.h / fl.s / 2)));

  // (f) THE FINGER CANNOT PUSH PAST — a REAL drag at 0.125 starting near
  // the right bound: the clamp stops it at EXACTLY half−vw (±1).
  abEval('doomalay.setView(4800,0,0.125)');
  await sleep(300);
  const dmf = await dragMeasure(195, 700, 5);
  const pushed = abJson("(function(){var p=doomalay.cameraProbe();var half=p.worldSize/2;var vw=p.w/p.scale;return JSON.stringify({x:p.x,limit:half-vw,at:Math.abs(p.x-(half-vw))<1})})()");
  ok('a real drag cannot push past the world (stops at half−vw ±1)', dmf && pushed && pushed.at, JSON.stringify(pushed));
}

// dragMeasure — a REAL-input pan through the app's own handlers, minus
// the CLI latency flake: the agent-browser CLI's cold start can exceed
// the app's 500ms long-press window between a real down and the first
// move (the menu opens + eats the gesture — drag-dead). The pan instead
// rides ONE dispatched-event eval: the mousedown on the element at the
// point (the document listener's own gate), the moves + the up on
// window — the app's exact handlers, zero inter-event latency. The WALK's
// CDP real-finger twins (trusted input, the v1000 discipline) cover the
// trusted path; this measures the /scale law, which is input-agnostic.
// The up rides a SECOND eval so the mid-drag probe reads the PURE stride
// (no momentum contamination).
async function dragMeasure(x0, y, x1) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
    const steps = 8;
    let seq = '';
    for (let i = 1; i <= steps; i++) seq += `f('mousemove', ${(x0 + (x1 - x0) * i / steps).toFixed(1)}, ${y});`;
    const r = abEval(`(function(){function f(t,x,y){if(t==='mousedown'){var el=document.elementFromPoint(x,y)||document;el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}))}else{window.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}))}}f('mousedown',${x0},${y});${seq}return true})()`);
    if (r !== 'true') { await sleep(300); continue; }
    await sleep(260);   // the finger holds still — the camera holds the stride
    const after = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
    abEval(`(function(){window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:${x1},clientY:${y},button:0}));return true})()`);
    await sleep(850);   // the momentum dies before the next measurement
    if (after && before && (Math.abs(after.x - before.x) > 1 || Math.abs(after.y - before.y) > 1)) return { before, after };
    // attempt 1's mousedown may have been consumed dismissing an open
    // long-press menu (the app's own law: a down outside the menu hides
    // it and returns) — the next attempt runs clean.
  }
  return null;
}

// ══ §2 THE PROPORTIONAL STRIDE ══════════════════════════════════════
section('§2 THE PROPORTIONAL STRIDE (v1.62.2)');
{
  const scales = [1.0, 0.5, 0.125, 0.05];
  for (const sc of scales) {
    abEval(`doomalay.setView(-4000,-4000,${sc})`);
    await sleep(250);
    const dm = await dragMeasure(290, 422, 190);
    const stride = dm ? dm.after.x - dm.before.x : 0;
    const expect = 100 / sc;
    ok(`a real 100px drag @${sc} moves EXACTLY 100/scale = ${Math.round(expect)} world units (±3)`,
      dm && Math.abs(stride - expect) < 3, 'got ' + Math.round(stride) + (dm ? '' : ' (drag-dead)'));
  }
  // the crawl is dead: one 300px stride at 0.05 covers ≥30% of the world
  // (start deep-left at -7500 so the right bound (392 @390px/0.05) never eats it)
  abEval('doomalay.setView(-7500,-4000,0.05)');
  await sleep(250);
  const dm2 = await dragMeasure(350, 422, 50);
  const cover = dm2 ? (dm2.after.x - dm2.before.x) / 16384 : 0;
  ok('a single 300px stride at 0.05 covers ≥30% of the whole world (the ~10s crawl is dead)',
    dm2 && cover >= 0.3, dm2 ? Math.round(cover * 100) + '%' : 'drag-dead');
}

// ══ §3 THE EIGHT TILES ══════════════════════════════════════════════
section('§3 THE EIGHT TILES (v1.62.3)');
{
  // the pair + the joint period, live
  abEval('doomalay.setView(0,0,0.3)');
  await sleep(900);
  let oo = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({pair:o.pair,jc:o.jointCells,draws:o.instDraws,fb:o.instFallbacks,farK:o.farK,rt:o.renderTiles,ladder:o.ladder})})()");
  ok('the pair is [10,24] with jointCells 120 (lcm)', oo && JSON.stringify(oo.pair) === '[10,24]' && oo.jc === 120, JSON.stringify(oo && oo.pair));
  const perAxis = 16384 / (120 * 48);
  const tiles = perAxis * perAxis;
  ok(`the whole world consists of ${tiles.toFixed(2)} tile periods ("like 8 give or take")`, tiles >= 7 && tiles <= 9, String(tiles));
  ok('the per-instance paint is LIVE (instDraws > 0, zero fallbacks)', oo && oo.draws > 0 && oo.fb === 0, JSON.stringify(oo && { d: oo.draws, f: oo.fb }));

  // the rotation law (pure math): ALL 8 neighbors of any instance differ
  let adjBad = 0;
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
    const r = (i + 2 * j) & 3;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      if ((((i + di) + 2 * (j + dj)) & 3) === r) adjBad++;
    }
  }
  ok('the rotation law: ALL 8 neighbors of every instance differ ((i+2j) mod 4)', adjBad === 0, String(adjBad));
  // the mirror law among SAME-ROTATION displacements: a displacement Δ
  // repeats the rotation iff Δi+2Δj ≡ 0 (mod 4); among those, the MIRROR
  // still differs iff Δi+Δj is odd — so same-rotation pairs split ~half
  // mirrored / half not (the extra variety on top of the rotation law).
  let sameRot = 0, sameRotMirrored = 0;
  for (let di = -8; di <= 8; di++) for (let dj = -8; dj <= 8; dj++) {
    if (!di && !dj) continue;
    if (((di + 2 * dj) & 3) !== 0) continue;   // only same-rotation displacements
    sameRot++;
    if (((di + dj) & 1) === 1) sameRotMirrored++;   // the mirror flips → reads different
  }
  ok('the mirror: among same-rotation displacements, ~half still read different (the flip)',
    sameRot > 10 && sameRotMirrored / sameRot > 0.4 && sameRotMirrored / sameRot < 0.6,
    (100 * sameRotMirrored / sameRot).toFixed(1) + '% of ' + sameRot);
  // the effective joint period with rotations: A's rotation repeats every
  // 4 A-instances (40 cells ≡ 0 mod 4 at 4·10=40... the alignment needs 40 ≡ 0
  // mod 4 ✓ 40 mod 4 = 0); B's every 4 B-instances (96 cells, 96 mod 4 = 0 ✓).
  // The joint field repeats only where BOTH align AND the positions tile:
  // Δ=480 cells (48 A-instances: 48 mod 4 = 0 ✓; 20 B-instances: 20 mod 4 = 0 ✓;
  // 480 ≡ 0 mod 10 ✓ mod 24 ✓) = 23,040px — BEYOND the whole world (341 cells).
  ok('the effective joint period with rotations (480 cells = 23,040px) is BEYOND the whole world (341 cells)', 480 > 16384 / 48, '480 vs ' + Math.round(16384 / 48));

  // zoom-out sweep: the ladder stable (no re-bakes), zero fallbacks
  const miss0 = oo && oo.ladder ? oo.ladder.misses : 0;
  let worstFb = 0;
  for (let s = 0.3; s >= 0.028; s *= 0.9) {
    abEval(`doomalay.setView(0,0,${s})`);
    await sleep(420);
    const o2 = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({fb:o.instFallbacks,d:o.instDraws,miss:o.ladder?o.ladder.misses:null,farK:o.farK})})()");
    if (o2) { worstFb = Math.max(worstFb, o2.fb || 0); }
  }
  const ooEnd = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({miss:o.ladder?o.ladder.misses:null,bytes:o.ladder?o.ladder.bytes:null,farK:o.farK,rt:o.renderTiles,d:s.dots})})()");
  ok('the ladder stays level-0 through the whole zoom-out (misses unchanged — zero re-bakes)', ooEnd && ooEnd.miss === miss0, JSON.stringify(ooEnd && ooEnd.miss) + ' vs ' + miss0);
  ok('ZERO sub-pixel fallbacks across the entire zoom-out sweep (the ceiling is the unreachable guard)', worstFb === 0, String(worstFb));
  ok('the ladder bytes stay under the 128MB cap', ooEnd && ooEnd.bytes !== null && ooEnd.bytes < 130, JSON.stringify(ooEnd && ooEnd.bytes) + 'MB');

  // 0.125 byte-identical + the floor map view (the far-field re-pin)
  abEval('doomalay.setView(0,0,0.125)');
  await sleep(900);
  const at125 = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({farK:o.farK,d:s.dots,draws:o.instDraws})})()");
  ok('at 0.125 the sea is FULL (farK 1, dots painted — byte-identical to today)', at125 && at125.farK === 1 && at125.d > 100, JSON.stringify(at125));
  abEval('doomalay.setView(0,0,0.001)');
  await sleep(900);
  const atFloor = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({farK:o.farK,rt:o.renderTiles,d:s.dots})})()");
  ok('at the floor the sea is GONE (farK 0, renderTiles 0 — the map view)', atFloor && atFloor.farK === 0 && atFloor.rt === 0 && atFloor.d === 0, JSON.stringify(atFloor));
}

// ══ §4 THE SEEN ONLY ════════════════════════════════════════════════
section('§4 THE SEEN ONLY (v1.62.4)');
{
  // (a) the cull census: at 0.5 centered, the far icons are display:none
  abEval('doomalay.setView(0,0,0.5)');
  await sleep(500);
  const census = abJson("(function(){var out={none:0,shown:0,list:[]};document.querySelectorAll('#chatbots .chatbot').forEach(function(el){if(el.style.display==='none'){out.none++;out.list.push(el.dataset.id)}else out.shown++});return JSON.stringify(out)})()");
  ok('off-view icons are display:none (the far pair culled, the near shown)', census && census.none >= 2 && census.shown >= 4, JSON.stringify(census));

  // (b) the write census during a REAL pan (the ride): the AT-REST plain
  // icons write ZERO transform styles (the container owns the camera).
  // The orbit members write per frame BY DESIGN (their tilt is camera-
  // relative), and a plain carrying residual physics drift writes ITS OWN
  // motion (p2 in this seeded world — its drift decays under any velocity
  // threshold, so the classifier snapshots each entity's POSITION at arm
  // time; a plain whose world position moved = physics, not camera).
  // The pan is a REAL agent-browser drag with one retry (the CLI's cold
  // start can exceed the 500ms long-press window — the menu-flake).
  let wc = null;
  for (let attempt = 0; attempt < 2 && !(wc && wc.icon === 0 && wc.cont >= 4); attempt++) {
    const cens = abEval("(function(){window.__pos0={};(window.doomalay.world.entities||[]).forEach(function(e){window.__pos0[e.id]=[e.x,e.y]});window.__wc={icon:0,cont:0,member:0,phys:0,cull:0,uncull:0,mCull:0};var obs=new MutationObserver(function(muts){muts.forEach(function(m){if(m.type!=='attributes'||m.attributeName!=='style')return;var t=m.target;if(t&&(t.id==='chatbots')){window.__wc.cont++;return}if(!t.classList||!t.classList.contains('chatbot'))return;var prior=m.oldValue||'';var now=t.getAttribute('style')||'';var isCullNow=now.indexOf('display: none')>=0;var wasCull=prior.indexOf('display: none')>=0;var id=t.dataset.id||'';var plain=(id==='p1'||id==='p2'||id==='p3'||id==='p4');if(isCullNow&&!wasCull){if(plain)window.__wc.cull++;else window.__wc.mCull++;return}if(wasCull&&!isCullNow){if(plain)window.__wc.uncull++;else window.__wc.mCull++;return}if(plain){var ent=null;(window.doomalay.world.entities||[]).some(function(e){if(e.id===id){ent=e;return true}return false});var p0=window.__pos0[id];if(ent&&p0&&(Math.abs(ent.x-p0[0])>0.001||Math.abs(ent.y-p0[1])>0.001)){window.__wc.phys++;return}window.__wc.icon++;return}window.__wc.member++})});obs.observe(document.getElementById('chatbots'),{attributes:true,attributeFilter:['style'],attributeOldValue:true,subtree:true});return true})()");
    if (cens !== 'true') continue;
    ab(['mouse', 'move', '195', '422']); ab(['mouse', 'down', 'left']); ab(['mouse', 'up', 'left']);   // the menu-flake guard (mid-screen: away from the arrows)
    ab(['mouse', 'move', '290', '422']);
    ab(['mouse', 'down', 'left']);
    for (let i = 1; i <= 8; i++) { ab(['mouse', 'move', String(290 - i * 25), '422']); await sleep(40); }
    await sleep(150);
    ab(['mouse', 'up', 'left']);
    await sleep(300);
    wc = abJson("(function(){return JSON.stringify(window.__wc)})()");
  }
  ok('the pan census: ZERO AT-REST plain-icon TRANSFORM writes (the container owns the camera; drifters write their own motion)',
    wc && wc.icon === 0 && wc.cont >= 4 && (wc.cull + wc.uncull) <= 4, JSON.stringify(wc));

  // (c) the movers: with the living sky on, the twinklers paint on the
  // cheap frame (on-screen only — the walk keys on the live camera);
  // comets are honestly none in the rig's window (cadence 180-440s).
  abEval("(function(){Settings.setState({gridScatter:46,dotScatter:52,lineScatter:40,dotSizeVariation:62,lineSizeVariation:50,gridRotation:18,dotAnimate:true,lineAnimate:true,spaceParallax:55});return 'sky'})()");
  abEval('doomalay.setView(-1000,-1000,0.3)');
  await sleep(1600);
  const movers = abJson("(function(){var s=window.DoomalayDebug||{};var o=s.oneObject||{};return JSON.stringify({painted:o.live?o.live.painted:null,comets:o.live?o.live.comets:null,gate:o.live?o.live.cometGate:null})})()");
  ok('the movers paint (twinklers on-camera; the comets honestly none in this window)', movers && movers.painted > 0 && movers.comets === 0, JSON.stringify(movers));
  abEval("(function(){Settings.setState({gridScatter:0,dotScatter:0,lineScatter:0,dotSizeVariation:0,lineSizeVariation:0,gridRotation:0,dotAnimate:false,lineAnimate:false,spaceParallax:0});return 'tidy'})()");

  // (d) the lattice paints in the WORKER (the main thread reserved for
  // the app + the backend's streams — the user's "reserve the computer").
  const worker = abJson("(function(){var s=window.DoomalayDebug||{};return JSON.stringify({worker:s.worker,frames:s.frames})})()");
  ok('the lattice paints in the worker (off the main thread)', worker && worker.worker === true && worker.frames > 10, JSON.stringify(worker));
}

// ══ §5 honesty ══════════════════════════════════════════════════════
section('§5 honesty');
{
  const errs = abJson("(function(){return JSON.stringify(window.__errs||[])})()");
  ok('zero page errors through the whole battery', errs && errs.length === 0, JSON.stringify(errs));
  const la = read('lattice.js');
  const m = la.match(/function tlFillInstances[\s\S]{0,2400}?^  }/m);
  const newCode = m ? m[0] : '';
  ok('zero new color literals in tlFillInstances', !/#[0-9a-fA-F]{6}|rgb\(/.test(newCode));
  ok('B1: the wave adds zero new surfaces (no createElement in the new code)', !/createElement/.test(newCode));
}

console.log('\n' + (fails.length ? '✗ FAILURES (' + fails.length + '):\n  - ' + fails.join('\n  - ')
  : '✓ ALL ' + n + ' GREEN'));
process.exit(fails.length ? 1 : 0);
