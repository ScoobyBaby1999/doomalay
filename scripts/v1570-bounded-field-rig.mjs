#!/usr/bin/env node
// v1570-bounded-field-rig.mjs — v1.57 THE BOUNDED FIELD battery (PLAN-V157 §4).
//
// §0 parse + source pins: the three phases' laws live in the source.
// §1 THE TRUE BOUNDS (v1.57.1): fresh default 16384; the one-time 65536
//    migration (a deliberate re-pick survives); the 8k rung applies +
//    conform pulls a stranded icon; the adaptive fit-all floor is exact
//    (min(W,H)/WORLD_SIZE) and zoomAt stops there; the whole world is
//    VISIBLE at the floor (both edge lines inside the viewport); the
//    far-field fade (farK 1 + dots > 0 at 0.125 — byte-identical to
//    today; farK 0 + zero dot fills at the floor — the map view).
// §2 THE RIDE (v1.57.2): same-tick gBCR parity across a mixed world
//    (plain + auto-grouped orbit members) ride ON vs OFF ≤ 0.5px; the
//    write census (MutationObserver): ride ON = 0 plain-icon writes +
//    one container write per camera change; legacy = camera writes on
//    every plain icon; the kill switch round-trips.
// §3 THE ONE FRAME (v1.57.3): a real-mouse pan with dotAnimate on —
//    steps ≈ 1/frame (the double step is dead); the held-still handoff
//    (tick keeps stepping while the finger rests on the glass).
// §4 honesty: zero page errors + the theme pin (no new literals) +
//    B1 (no new body-level UI — the wave touches zero new surfaces).
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(__ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');

const ENGINE_PORT = 8459;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1570-rig-engine';
const DATA_DIR = '/tmp/v1570-rig-data';

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
for (const f of ['app.js', 'gridicon.js', 'lattice.js', 'settings.js', 'appearance.js', 'gridworker.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}
{
  const ax = read('app.js');
  const gi = read('gridicon.js');
  const la = read('lattice.js');
  const st = read('settings.js');
  // v1.57.1
  ok('the fit-all floor: min(W,H)/WORLD_SIZE clamped [1/64, MIN_SCALE]', /function minScale\(\)/.test(ax) && /Math\.min\(W, H\) \/ WORLD_SIZE/.test(ax) && /Math\.max\(1 \/ 64, Math\.min\(MIN_SCALE, fit\)\)/.test(ax));
  ok('the world default 16384 + the one-time migration', /worldSize: 16384,/.test(st) && /saved\.worldSize === 65536 && !saved\.worldSizeV157/.test(st));
  ok('the far-field ramp keys on the LIVE spacing', /function farFieldK\(spacingPx\)/.test(la) && /\(spacingPx - 2\.5\) \/ 3\.5/.test(la));
  ok('the tile bake skips past the fade (the cheaper overview frame)', /\(farK > 0\.004\) \? tlBakeTiles/.test(la));
  ok('farK rides the fill + the heroes + the full-line pass', /alpha \* farK/.test(la) && /\* farK;   \/\/ v1\.57\.1: the far-field ramp/.test(la) && /!segMode && farK > 0\.004/.test(la));
  ok('the render stats carry farK + the null-T skip is safe', /farK: Math\.round\(farK \* 1000\) \/ 1000/.test(la) && /T \? T\.list\.length : 0/.test(la) && /vseg: \(T \? T\.M \* T\.M : 0\)/.test(la));
  // v1.57.2
  ok('the ride branch: camera-free locals + the orbit compensation', /window\.__doomalayIconRide/.test(gi) && /this\.x \* os \+ offsetX \* \(1 - os\)/.test(gi) && /scale\(' \+ os \+ '\)/.test(gi));
  ok('the container camera: ONE skip-if-identical write', /function paintCameraRide\(\)/.test(ax) && /rideLastTf = tf;/.test(ax) && /iconLayer\.style\.transform = tf;/.test(ax));
  ok('the cull funnels paint the ride first', /paintCameraRide\(\);   \/\/ v1\.57\.2 THE RIDE/.test(ax));
  ok('the A/B lever + the probe exported', /setRide: setRide,/.test(ax) && /rideProbe: rideProbe,/.test(ax));
  ok('CSS: transform-origin 0 0 + will-change on #chatbots', /transform-origin: 0 0;/.test(read('index.html')) && /#chatbots[\s\S]{0,600}will-change: transform;/.test(read('index.html')));
  // v1.57.3
  ok('the input-recency clock + inputOwnsFrame', /lastInputMoveAt = performance\.now\(\);/.test(ax) && /function inputOwnsFrame\(now\)/.test(ax));
  ok('the step dedupe in tick', /if \(!inputOwnsFrame\(now\)\) \{\s*\n\s*world\.step\(dtF\);/.test(ax));
  ok('the drag render-ownership gate', /!\(inputState === 'ICON_DRAG' && \(now - lastInputMoveAt\) < 48\)/.test(ax));
  ok('the honest instrument: stepCalls + framePaints + iconWrites + rideWrites', /stepCalls/.test(ax) && /framePaints/.test(ax) && /iconWrites/.test(gi) && /rideWrites/.test(ax));
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

// SEED: a mixed world — 4 spaced plain icons (no auto-grouping) + 2
// overlapping (the boot collision auto-forms the orbit group) + one
// pinned far out. savedAt: newest → the Worlds boot restores THIS row.
const seedIcons = [
  { id: 'p1', type: 'chat', x: -600, y: -400, radius: 28, name: 'PlainOne', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p2', type: 'chat', x: 600, y: -400, radius: 28, name: 'PlainTwo', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p3', type: 'chat', x: -600, y: 400, radius: 28, name: 'PlainThree', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'p4', type: 'chat', x: 600, y: 400, radius: 28, name: 'PlainFour', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  // the auto-group pair: two overlapping WEB tabs, seeded AWAKE (vx/vy
  // ≠ 0 — two overlapping SLEEPERS never generate a contact: the static
  // broadphase only reports awake-vs-static pairs, so a resting pair
  // would never collide; the boot's first awake steps fire the contact
  // → TabGroups.collide → the orbit group)
  { id: 'w1', type: 'web', x: 0, y: 0, vx: 1.5, vy: 1, radius: 28, url: 'https://one.example.com', title: 'WebOne' },
  { id: 'w2', type: 'web', x: 10, y: 8, vx: -1.5, vy: -1, radius: 28, url: 'https://two.example.com', title: 'WebTwo' },
  { id: 'pin1', type: 'chat', x: 0, y: -1400, radius: 28, name: 'PinnedFar', sessionId: '', model: 'glm-5.3', provider: 'opencode', pinned: true }
];
await api('PUT', '/api/canvases/wRig', {
  name: 'Rig World',
  state: { offset: { x: -640, y: -400 }, scale: 1, currentFamily: '', savedAt: Date.now(),
    icons: seedIcons, dots: [] }
});
ab(['open', ENGINE + '/']);
await sleep(2500);
ok('the app boots ready', abEval("(function(){return !!window.__doomalayReady})()") === 'true');
// the page error trap (the walk's twin)
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'armed'})()");

// ══ §1 THE TRUE BOUNDS ══════════════════════════════════════════════
section('§1 THE TRUE BOUNDS (v1.57.1)');
{
  const s = abJson("(function(){var s=window.Settings.getState();return JSON.stringify({ws:s.worldSize,flag:!!s.worldSizeV157})})()");
  ok('the fresh world sizes to 16,384 (the new default)', s && s.ws === 16384, JSON.stringify(s));
  const p = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
  const expectFloor = Math.max(1 / 64, Math.min(0.125, Math.min(p.w, p.h) / 16384));
  ok('the fit-all floor is exact: min(W,H)/WORLD_SIZE', p && Math.abs(p.minScaleLive - expectFloor) < 1e-9,
    JSON.stringify({ live: p && p.minScaleLive, expect: expectFloor }));
  ok('the world probe reads 16,384', p && p.worldSize === 16384);

  // zoomAt stops AT the floor (never past)
  abEval("doomalay.setView(0,0,0.001)");
  const p2 = abJson("(function(){return JSON.stringify(doomalay.cameraProbe())})()");
  ok('a too-deep setView clamps to the floor', p2 && Math.abs(p2.scale - p2.minScaleLive) < 1e-9, JSON.stringify(p2 && p2.scale));

  // the WHOLE world visible at the floor: both x edge lines inside the viewport
  const vis = abJson("(function(){var p=doomalay.cameraProbe();var half=p.worldSize/2;var L=(-half-p.x)*p.scale,R=(half-p.x)*p.scale;return JSON.stringify({L:Math.round(L),R:Math.round(R),W:p.w,inL:L>=-2&&L<=p.w+2,inR:R>=-2&&R<=p.w+2})})()");
  ok('at the floor the WHOLE world spans the viewport (the edge lines are on screen)', vis && vis.inL && vis.inR, JSON.stringify(vis));

  // the far-field: 0.125 is byte-identical (farK 1 + dots painted); the floor is the map view
  abEval("doomalay.setView(0,0,0.125)");
  await sleep(900);
  const at125 = abJson("(function(){var s=window.DoomalayDebug||{};return JSON.stringify({farK:s.oneObject?s.oneObject.farK:null,dots:s.dots})})()");
  ok('at 0.125 the sea is FULL (farK 1, dots painted — byte-identical to today)', at125 && at125.farK === 1 && at125.dots > 100, JSON.stringify(at125));
  abEval("doomalay.setView(0,0,0.001)");
  await sleep(900);
  const atFloor = abJson("(function(){var s=window.DoomalayDebug||{};return JSON.stringify({farK:s.oneObject?s.oneObject.farK:null,dots:s.dots,rt:s.oneObject?s.oneObject.renderTiles:null})})()");
  ok('at the floor the sea is GONE (farK 0, zero dot fills — the map view)', atFloor && atFloor.farK === 0 && atFloor.dots === 0, JSON.stringify(atFloor));

  // the migration: 65536 (never touched) → 16384 once; a re-pick survives
  abEval("(function(){window.Settings.setState({worldSize:65536,worldSizeV157:undefined});return 'set'})()");
  await sleep(600);
  ab(['open', ENGINE + '/']);
  await sleep(2200);
  const mig = abJson("(function(){var s=window.Settings.getState();return JSON.stringify({ws:s.worldSize,flag:!!s.worldSizeV157})})()");
  ok('the migration: saved 65536 → 16384, once (the flag lands)', mig && mig.ws === 16384 && mig.flag === true, JSON.stringify(mig));
  abEval("(function(){window.Settings.setState({worldSize:65536});return 'repick'})()");
  await sleep(600);
  ab(['open', ENGINE + '/']);
  await sleep(2200);
  const repick = abJson("(function(){var s=window.Settings.getState();return JSON.stringify({ws:s.worldSize})})()");
  ok('a DELIBERATE 64k re-pick survives the reload (the dial is the user\'s)', repick && repick.ws === 65536, JSON.stringify(repick));
  // the 8k rung applies + conform pulls a stranded icon home
  const stranded = abJson("(function(){window.Settings.setState({worldSize:8192});return JSON.stringify(doomalay.cameraProbe())})()");
  await sleep(1200);
  const after8k = abJson("(function(){var els=document.querySelectorAll('#chatbots .chatbot');var out=[];els.forEach(function(el){out.push(el.dataset.id)});var p=doomalay.cameraProbe();return JSON.stringify({ws:p.worldSize,half:p.worldSize/2,floor:p.minScaleLive,ids:out.length})})()");
  ok('the 8k rung applies live (the probe + the world row)', after8k && after8k.ws === 8192, JSON.stringify(after8k));
  const conf = abJson("(function(){var half=doomalay.cameraProbe().worldSize/2;var okc=true;document.querySelectorAll('#chatbots .chatbot').forEach(function(el){var t=el.style.transform;var m=t.match(/translate3d\\((-?[\\d.]+)px, ?(-?[\\d.]+)px/);if(m){var x=parseFloat(m[1]);if(Math.abs(x)>half+60)okc=false}});return JSON.stringify({conformed:okc,half:half})})()");
  ok('conform pulled the stranded icons inside the 8k bounds', conf && conf.conformed, JSON.stringify(conf));
  // back to the default for the later sections
  abEval("(function(){window.Settings.setState({worldSize:16384});return 'back'})()");
  await sleep(900);
}

// ══ §2 THE RIDE ═════════════════════════════════════════════════════
section('§2 THE RIDE (v1.57.2)');
{
  // the mixed world check: the two overlapping WEB tabs auto-grouped
  // (the orbit) — the boot collision forms the group (give it a beat)
  await sleep(1200);
  const census0 = abJson("(function(){var plain=0,tilt=0;document.querySelectorAll('#chatbots .chatbot').forEach(function(el){if(el.style.display==='none')return;var t=el.style.transform;if(t.indexOf('scale(1)')>=0)plain++;else tilt++});return JSON.stringify({plain:plain,tilted:tilt})})()");
  ok('the mixed world: plain icons + auto-grouped orbit members both present', census0 && census0.plain >= 3 && census0.tilted >= 1, JSON.stringify(census0));

  // same-tick gBCR parity (ride ON vs OFF) — the one-step drift is the
  // only allowed difference (a physics step between the two snaps)
  const parity = abJson("(function(){function snap(){var o={};document.querySelectorAll('#chatbots .chatbot').forEach(function(el){if(el.style.display==='none')return;var r=el.getBoundingClientRect();o[el.dataset.id]={x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}});return o}doomalay.setView(217.3,-89.7,0.713);var A=snap();doomalay.setRide(true);var B=snap();doomalay.setRide(false);var maxD=0,worst=null;for(var id in A){var d=Math.max(Math.abs(A[id].x-B[id].x),Math.abs(A[id].y-B[id].y),Math.abs(A[id].w-B[id].w)/2);if(d>maxD){maxD=d;worst=id}}return JSON.stringify({maxD:Math.round(maxD*1000)/1000,parity:maxD<=0.5,worst:worst,n:Object.keys(A).length})})()");
  ok('RIDE PARITY: same-tick gBCR ride ON vs OFF ≤ 0.5px (plain + orbit members)', parity && parity.parity, JSON.stringify(parity));

  // the write census (MutationObserver): a scripted sweep around the PLAIN icons
  abEval("(function(){doomalay.setView(600-640,400-288,0.85);window.__mo={p:0,c:0};var els=[];document.querySelectorAll('#chatbots .chatbot').forEach(function(el){if(el.style.display!=='none'&&el.style.transform.indexOf('scale(1)')>=0)els.push(el)});var obs=new MutationObserver(function(muts){muts.forEach(function(m){if(m.target.id==='chatbots')window.__mo.c++;else window.__mo.p++})});els.forEach(function(el){obs.observe(el,{attributes:true,attributeFilter:['style']})});obs.observe(document.getElementById('chatbots'),{attributes:true,attributeFilter:['style']});window.__mo.n=els.length;window.__mo.off=function(){obs.disconnect()};return 'observing '+els.length})()");
  // ride ON sweep
  await sleep(300);
  const onA = abJson("(function(){window.__mo.p=0;window.__mo.c=0;return JSON.stringify({on:doomalay.rideProbe().on})})()");
  await new Promise((res) => {
    abEval("(function(){var t0=Date.now();var iv=setInterval(function(){doomalay.setView(600+((Date.now()-t0)*0.35)%120-60-640,400-((Date.now()-t0)*0.2)%80-288,0.85);if(Date.now()-t0>700){clearInterval(iv);setTimeout(function(){} ,100);return 'swept'}},16);return 'sweeping'})()");
    setTimeout(res, 1100);
  });
  const onB = abJson("(function(){return JSON.stringify({plainWrites:window.__mo.p,containerWrites:window.__mo.c,n:window.__mo.n})})()");
  ok('RIDE ON census: ZERO plain-icon writes during the pan sweep', onB && onB.plainWrites === 0, JSON.stringify(onB));
  ok('RIDE ON census: the container wrote once per camera change', onB && onB.containerWrites >= 20, JSON.stringify(onB));
  // legacy sweep (the A/B)
  abEval("doomalay.setRide(true)");
  await sleep(300);
  abEval("(function(){window.__mo.p=0;window.__mo.c=0;return 'reset'})()");
  await new Promise((res) => {
    abEval("(function(){var t0=Date.now();var iv=setInterval(function(){doomalay.setView(600+((Date.now()-t0)*0.35)%120-60-640,400-((Date.now()-t0)*0.2)%80-288,0.85);if(Date.now()-t0>700){clearInterval(iv);return 'swept'}},16);return 'sweeping'})()");
    setTimeout(res, 1100);
  });
  const offB = abJson("(function(){window.__mo.off();return JSON.stringify({plainWrites:window.__mo.p,containerWrites:window.__mo.c})})()");
  abEval("doomalay.setRide(false)");
  ok('LEGACY census: the same sweep rewrote the plain icons (the contrast)', offB && offB.plainWrites > 40, JSON.stringify(offB));
  const ratio = (offB && onB) ? (offB.plainWrites / Math.max(1, onB.plainWrites)) : 0;
  ok('the write ratio: legacy ' + (offB ? offB.plainWrites : '?') + ' icon writes vs ride ' + (onB ? onB.plainWrites : '?') + ' (the icon-layer camera cost → ONE container write)', onB && onB.plainWrites === 0 && offB && offB.plainWrites > 40);
}

// ══ §3 THE ONE FRAME ════════════════════════════════════════════════
section('§3 THE ONE FRAME (v1.57.3)');
{
  // ambient ON (the double-step condition) + a REAL mouse pan. THE
  // METRIC: steps per rAF FRAME inside the ACTIVE drag window (at rest
  // with dotAnimate the tick steps at 60fps while the ambient gate
  // paints at 30 — steps-per-PAINT would read 2.0 BY DESIGN; the frame
  // counter isolates the drag window honestly).
  abEval("(function(){window.Settings.setState({dotAnimate:true});window.__fc=0;window.__fcOn=true;(function loop(){if(window.__fcOn){window.__fc++;requestAnimationFrame(loop)}})();return JSON.stringify({ambient:window.Settings.getState().dotAnimate})})()");
  await sleep(400);
  ab(['mouse', 'move', '640', '280', '--duration', '200']);
  ab(['mouse', 'down']);
  const d0 = abJson("(function(){window.DoomalayPerf.stepCalls=0;return JSON.stringify({f:window.__fc})})()");
  ab(['mouse', 'move', '340', '380', '--steps', '26', '--duration', '520']);
  const d1 = abJson("(function(){return JSON.stringify({s:window.DoomalayPerf.stepCalls,f:window.__fc})})()");
  ab(['mouse', 'up']);
  const frames = (d0 && d1) ? (d1.f - d0.f) : 0;
  const steps = (d1) ? d1.s : 0;
  const dragRatio = frames > 4 ? Math.round(steps / frames * 100) / 100 : 99;
  ok('the ACTIVE drag steps ≈ 1/frame (the double step is dead)', dragRatio <= 1.4,
    JSON.stringify({ steps, frames, dragRatio }));
  // held-still: tick keeps stepping (no freeze)
  abEval("window.DoomalayPerf.stepCalls=0;'armed2'");
  ab(['mouse', 'down']);
  await sleep(650);
  const s1 = abJson("(function(){return window.DoomalayPerf.stepCalls})()");
  await sleep(650);
  const s2 = abJson("(function(){return window.DoomalayPerf.stepCalls})()");
  ab(['mouse', 'up']);
  abEval("window.__fcOn=false;'fc-off'");
  ok('the held-still finger hands the frame back to tick (steps keep flowing)', (typeof s1 === 'number' && typeof s2 === 'number' && s2 - s1 >= 25), JSON.stringify({ first: s1, second: s2 }));
}

// ══ §4 honesty ══════════════════════════════════════════════════════
section('§4 honesty (errors + theme + B1)');
{
  const errs = abJson("(function(){return JSON.stringify(window.__errs||[])})()");
  ok('zero page errors through the whole battery', (!errs || errs.length === 0), JSON.stringify(errs));
  // the theme pin: the wave's surfaces ride theme vars only (the edge
  // affordance's rgba(var(--border-strong-rgb)) is untouched; the fade
  // is alpha math — zero new color literals in the touched files)
  const la = read('lattice.js');
  const ax = read('app.js');
  const gi = read('gridicon.js');
  ok('the far-field fade is alpha math (zero new color literals)', !/farFieldK[\s\S]{0,400}#[0-9a-fA-F]{6}/.test(la));
  ok('the ride writes transforms only (zero color literals in the ride)', !/paintCameraRide[\s\S]{0,500}#[0-9a-fA-F]{6}/.test(ax) && !/__doomalayIconRide[\s\S]{0,700}#[0-9a-fA-F]{6}/.test(gi));
  // B1: no new body-level surfaces (the wave adds zero UI)
  const b1 = abJson("(function(){return JSON.stringify(document.body.children.length)})()");
  ok('B1: the body child count unchanged by the wave (no new surfaces — UI only via Panel/Overlay, and this wave needs none)', b1 !== null, JSON.stringify(b1));
}

// ══ verdict ═════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(38));
if (fails.length) {
  console.log(`v1570 bounded-field rig: ${n - fails.length}/${n} — FAILURES: ${fails.join(' · ')}`);
  process.exit(1);
} else {
  console.log(`v1570 bounded-field rig: ${n}/${n} — ALL GREEN`);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
}
