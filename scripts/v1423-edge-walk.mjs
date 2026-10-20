#!/usr/bin/env node
// v1423-edge-walk.mjs — v1.42.3 THE EDGE redteam: the REAL-USER walk
// (PLAN-V142 §3.1). Boots the real engine, drives the real PWA:
//
//   S1  the World Size dial lives in Settings → Sizing (the real UI,
//       five options) and a change applies LIVE (camera clamps)
//   S2  THE FLING LAW: repeated hard flings at one edge — the camera
//       NEVER exceeds the bounds (cameraProbe read-back)
//   S3  THE BOOT LAW: a stale out-of-bounds saved camera is clamped at
//       restore (no snapshot escapes)
//   S4  THE PHYSICS WALL: an icon flung at the edge reflects + settles
//       inside (stepSim, the rig stepper)
//   S5  THE EDGE AFFORDANCE: at the bound, the theme-native edge line
//       is visible (border-strong-rgb, zero literals); centered, it
//       is not
//   S6  worldSize OFF keeps the legacy infinite world (the camera
//       passes the old bound freely)
//   S7  zero page errors
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1423-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1423-walk-'));
const ENGINE_PORT = 8433;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (args, timeoutMs) =>
  execFileSync('agent-browser', args, { timeout: timeoutMs || 45000, encoding: 'utf8' }).trim();
const ev = (js) => {
  const out = ab(['eval', js]);
  try { return JSON.parse(out); } catch (e) { return out; }
};
const setLS = (key, value) => ab(['storage', 'local', 'set', key, value]);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if (ev('window.__doomalayReady') === true) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}

function setSettings(patch) {
  const cur = ev(`JSON.parse(localStorage.getItem('doomalay.settings.v1') || '{}')`);
  setLS('doomalay.settings.v1', JSON.stringify(Object.assign({}, cur, patch)));
}

async function fling(dx, dy, steps) {
  ev(`(function(){
    var surf = document.getElementById('chatbots') || document;
    var fire = function(t, x, y){ surf.dispatchEvent(new MouseEvent(t, {bubbles:true, clientX:x, clientY:y, button:0})); };
    fire('mousedown', 400, 350);
    for (var i = 1; i <= ${steps}; i++) fire('mousemove', 400 - Math.round(${dx} * i / ${steps}), 350 - Math.round(${dy} * i / ${steps}));
    fire('mouseup', 400 - ${dx}, 350 - ${dy});
    return 'flung';
  })()`);
  await sleep(1200);
}

(async () => {
  console.log('v1423-edge-walk — THE EDGE (the bounded world, live)');
  try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--data-dir', DATA_DIR], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  await sleep(2000);

  // ── S1: the dial exists in the real UI; a change applies live ──
  ab(['open', ENGINE], 60000);
  await sleep(1500);
  setLS('doomalay.state.v2', JSON.stringify({
    offset: { x: 0, y: 0 }, scale: 1, currentFamily: 'default',
    icons: [{ type: 'chat', id: 'edgebot', x: 200, y: 0, name: 'Edgebot' }], dots: [], savedAt: Date.now(),
  }));
  ab(['reload']);
  ok('S1 the app boots ready', await waitReady());

  // the real UI path: gear → Sizing tab → the World Size select
  ab(['find', 'role', 'button', 'click', '--name', 'Settings']);
  await sleep(900);
  const snap = ab(['snapshot', '-i', '-c']);
  ok('S1b the Sizing tab is reachable', /📐 Sizing/.test(snap));
  ab(['find', 'text', '📐 Sizing', 'click']);
  await sleep(700);
  // collapsed <select> options don't surface in the a11y snapshot —
  // assert the dial through the DOM (5 options, the labels intact)
  const dial = ev(`(function(){
    var el = document.querySelector('select[data-setting-key="worldSize"]');
    if (!el) return null;
    return { options: el.options.length, labels: Array.prototype.map.call(el.options, function(o){ return o.textContent; }).join('|') };
  })()`);
  ok('S1c the World Size dial renders (5 options)', !!dial && dial.options === 5 && /64k/.test(dial.labels) && /infinite/.test(dial.labels),
    dial ? dial.labels : 'missing');
  // select 16k through the real control
  const sel = ev(`(function(){
    var el = document.querySelector('select[data-setting-key="worldSize"]');
    if (!el) return null;
    el.value = '16384';
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return el.value;
  })()`);
  await sleep(900);
  const probe16 = ev('window.doomalay.cameraProbe()');
  ok('S1d the 16k world applies live', sel === '16384' && probe16.worldSize === 16384,
    `select=${sel} probe.worldSize=${probe16.worldSize}`);
  // close the settings panel (the scrim's own click-to-close — a real
  // user flings the CANVAS, not the panel over it)
  ev(`(function(){ var s = document.getElementById('chat-scrim'); if (s) s.click(); return 'closed'; })()`);
  await sleep(600);

  // ── S2: the fling law — repeated hard flings never escape. The
  // assertions are NON-VACUOUS: the camera must MOVE and stay bounded.
  const half = 8192;
  let p = ev('window.doomalay.cameraProbe()');
  const vw = p.w / p.scale;
  const maxX = half - vw / 2;
  const x0 = p.x;
  for (let i = 0; i < 6; i++) await fling(700, 0, 16);
  p = ev('window.doomalay.cameraProbe()');
  ok('S2 six hard right-flings: the camera MOVES and NEVER exceeds the bound',
    p.x <= maxX + 0.5 && p.x > x0 + 500,
    `x=${p.x.toFixed(1)} (from ${x0.toFixed(1)}) ≤ ${maxX.toFixed(1)}`);
  const x1 = p.x;
  for (let i = 0; i < 6; i++) await fling(-700, 0, 16);
  p = ev('window.doomalay.cameraProbe()');
  ok('S2b six hard left-flings: the camera moves back, the far bound holds too',
    p.x >= -maxX - 0.5 && p.x < x1 - 500,
    `x=${p.x.toFixed(1)} (from ${x1.toFixed(1)}) ≥ ${(-maxX).toFixed(1)}`);

  // ── S3: the boot law — a stale out-of-bounds snapshot clamps at restore ──
  const st = ev(`JSON.parse(localStorage.getItem('doomalay.state.v2'))`);   // ev() already parses
  st.offset = { x: 50000, y: 40000 };
  setLS('doomalay.state.v2', JSON.stringify(st));
  ab(['reload']);
  await sleep(2500);
  p = ev('window.doomalay.cameraProbe()');
  ok('S3 the stale 50000-offset camera clamps at boot', p.x <= maxX + 0.5 && p.y <= (half - (p.h / p.scale) / 2) + 0.5,
    `boot camera=(${p.x.toFixed(0)}, ${p.y.toFixed(0)}) worldSize=${p.worldSize}`);

  // ── S4: the physics wall — a flung icon reflects + settles inside ──
  const settled = ev(`(function(){
    var w = window.doomalay.world, icon = null;
    for (var i = 0; i < w.entities.length; i++) if (w.entities[i].id === 'edgebot') { icon = w.entities[i]; break; }
    if (!icon) return { missing: true };
    icon.x = 7600; icon.y = 0; icon.vx = 60; icon.vy = 0;
    window.doomalay.stepSim(500);
    return { x: icon.x, vx: icon.vx, edge: 8192 - icon.radius };
  })()`);
  ok('S4 the icon flung at the edge settles INSIDE', !settled.missing && settled.x <= settled.edge + 0.001 && settled.vx === 0,
    `x=${settled.x && settled.x.toFixed(1)} (edge ${settled.edge}) vx=${settled.vx}`);

  // ── S5: the edge affordance — visible AT the bound, hidden when centered ──
  const edgeShown = ev(`(function(){
    var els = document.querySelectorAll('div[style*="border-strong-rgb"]');
    var shown = 0;
    els.forEach(function(el){ if (el.style.display !== 'none') shown++; });
    return { total: els.length, shown: shown };
  })()`);
  ok('S5 the edge line renders at the bound (theme-native)', edgeShown.total >= 4 && edgeShown.shown >= 1,
    `${edgeShown.shown}/${edgeShown.total} shown`);
  // center the camera — the edge fades out
  ev(`window.doomalay.setView(0, 0, 1)`);
  await sleep(800);
  const edgeHidden = ev(`(function(){
    var els = document.querySelectorAll('div[style*="border-strong-rgb"]');
    var shown = 0;
    els.forEach(function(el){ if (el.style.display !== 'none') shown++; });
    return shown;
  })()`);
  ok('S5b centered: the edge line is out of view', edgeHidden === 0, `${edgeHidden} shown`);

  // ── S6: OFF keeps the legacy infinite world ──
  // The REAL user path: the Sizing select itself (a raw storage write
  // would be clobbered by the pagehide trailing-flush — the page's
  // in-memory state outlives external writes; the UI's setState is the
  // one true path, exactly like a finger).
  ab(['find', 'role', 'button', 'click', '--name', 'Settings']);
  await sleep(800);
  ab(['find', 'text', '📐 Sizing', 'click']);
  await sleep(600);
  ev(`(function(){
    var el = document.querySelector('select[data-setting-key="worldSize"]');
    el.value = '0';
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return el.value;
  })()`);
  await sleep(900);
  p = ev('window.doomalay.cameraProbe()');
  ok('S6 worldSize OFF applies live (0 = infinite)', p.worldSize === 0);
  // close the panel — the canvas takes the gestures again
  ev(`(function(){ var s = document.getElementById('chat-scrim'); if (s) s.click(); return 'closed'; })()`);
  await sleep(600);
  const xOff0 = ev('window.doomalay.cameraProbe()').x;
  let moved = xOff0;
  for (let i = 0; i < 14; i++) {
    await fling(700, 0, 16);
    moved = ev('window.doomalay.cameraProbe()').x;
    if (moved > maxX + 100) break;
  }
  ok('S6b the unbounded camera flies past the old bound', moved > maxX + 100,
    `x=${moved.toFixed(0)} > ${maxX.toFixed(0)} (from ${xOff0.toFixed(0)})`);
  const edgeGone = ev(`(function(){
    var els = document.querySelectorAll('div[style*="border-strong-rgb"]');
    var shown = 0;
    els.forEach(function(el){ if (el.style.display !== 'none') shown++; });
    return shown;
  })()`);
  ok('S6c the edge line is gone when OFF', edgeGone === 0);

  const errs = ab(['errors']);
  ok('S7 zero page errors across the whole walk', !errs || errs.trim() === '' || errs === '[]',
    String(errs).slice(0, 200));

  console.log(`\n${'═'.repeat(40)}\nv1423 edge walk: ${n - fails.length}/${n} — ${fails.length ? 'FAILURES: ' + fails.join(' · ') : 'ALL GREEN'}`);
  try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('walk crashed: ' + e.message);
  try { execSync("pkill -9 -f '" + ENGINE_BIN + "' || true"); } catch (e2) {}
  process.exit(1);
});
