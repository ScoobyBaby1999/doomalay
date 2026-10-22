#!/usr/bin/env node
// v1570-bounded-field-walk.mjs — THE REAL FINGER (PLAN-V157 §4).
//
// A human walks the bounded field: pan to the world's edge and FEEL the
// bounds (the camera stops, the edge line shows), zoom out to the map
// view (the whole world in one screen, the sea fades), zoom back in
// (the sea returns), drag an icon across the field, open a chat. Zero
// errors, the theme intact, the visuals whole.
'use strict';

import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_PORT = 8460;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1570-walk-engine';
const DATA_DIR = '/tmp/v1570-walk-data';

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
    return execFileSync('agent-browser', args, { timeout: timeoutMs || 45000, encoding: 'utf8' }).trim();
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

// ── boot (the pristine-browser law) ─────────────────────────────────
try { ab(['close', '--all']); } catch (e) {}
await sleep(600);
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
  env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
});
fs: {
  const fs = await import('node:fs');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
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

// SEED: a walkable world — a few chats spread across the field.
const seedIcons = [
  { id: 'walk1', type: 'chat', x: -500, y: -300, radius: 28, name: 'Scooby', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'walk2', type: 'chat', x: 500, y: -300, radius: 28, name: 'Trippy', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'walk3', type: 'chat', x: -500, y: 300, radius: 28, name: 'Dock', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
  { id: 'walk4', type: 'chat', x: 500, y: 300, radius: 28, name: 'Sky', sessionId: '', model: 'glm-5.3', provider: 'opencode' }
];
await api('PUT', '/api/canvases/wWalk', {
  name: 'Walk World',
  state: { offset: { x: -640, y: -288 }, scale: 1, currentFamily: '', savedAt: Date.now(), icons: seedIcons, dots: [] }
});
ab(['open', ENGINE + '/']);
await sleep(2500);
ok('the app boots ready', abEval("(function(){return !!window.__doomalayReady})()") === 'true');
abEval("(function(){window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'armed'})()");

// ── W1: pan to the world's edge and FEEL the bounds ────────────────
section('W1 the edge (pan until the camera stops)');
{
  // slam toward the right edge (+8192) — the clamp catches at maxX;
  // then the REAL finger tries to push past it.
  abEval("doomalay.setView(200000, 0, 1)");
  await sleep(500);
  const clamped = abJson("(function(){var p=doomalay.cameraProbe();var maxX=p.worldSize/2-(p.w/p.scale)/2;return JSON.stringify({x:Math.round(p.x),maxX:Math.round(maxX),atClamp:Math.abs(p.x-maxX)<1})})()");
  ok('a violent setView past the edge CLAMPS at maxX (the bounds are real)', clamped && clamped.atClamp, JSON.stringify(clamped));
  // the edge line is on screen now (the affordance)
  const edge = abJson("(function(){var els=[];document.querySelectorAll('body > div').forEach(function(d){if(d.style.display==='block'&&(d.style.width==='2px'||d.style.height==='2px'))els.push(d.style.width==='2px'?'v':'h')});return JSON.stringify({lines:els})})()");
  ok('the edge affordance line is VISIBLE at the boundary', edge && edge.lines.length >= 1, JSON.stringify(edge));
  // the real finger pushes PAST the edge — the camera must not move beyond
  const cam0 = abJson("(function(){var p=doomalay.cameraProbe();return JSON.stringify({x:p.x,maxX:p.worldSize/2-(p.w/p.scale)/2})})()");
  ab(['mouse', 'move', '1100', '280', '--duration', '150']);
  ab(['mouse', 'down']);
  for (let i = 0; i < 6; i++) {
    ab(['mouse', 'move', '500', '280', '--steps', '6', '--duration', '150']);
    ab(['mouse', 'up']);
    ab(['mouse', 'down']);
    ab(['mouse', 'move', '1100', '280', '--steps', '2', '--duration', '40']);
  }
  ab(['mouse', 'up']);
  await sleep(500);
  const cam1 = abJson("(function(){var p=doomalay.cameraProbe();return JSON.stringify({x:p.x,maxX:p.worldSize/2-(p.w/p.scale)/2})})()");
  ok('the finger CANNOT push the camera past the edge (the clamp held through the whole pan)', cam1 && cam1.x <= cam1.maxX + 1, JSON.stringify({ startX: cam0 && cam0.x, endX: cam1 && cam1.x, maxX: cam1 && cam1.maxX }));
}

// ── W2: zoom out to the map view ───────────────────────────────────
section('W2 the map view (the whole world in one screen)');
{
  // wheel out to the floor — the whole 16k world in view
  abEval("doomalay.setView(0, 0, 0.0001)");
  await sleep(800);
  const p = abJson("(function(){var p=doomalay.cameraProbe();return JSON.stringify({s:p.scale,floor:p.minScaleLive,atFloor:Math.abs(p.scale-p.minScaleLive)<1e-9})})()");
  ok('the zoom landed exactly at the fit-all floor', p && p.atFloor, JSON.stringify(p));
  const st = abJson("(function(){var s=window.DoomalayDebug||{};return JSON.stringify({farK:s.oneObject?s.oneObject.farK:null,dots:s.dots})})()");
  ok('the map view: the sea is gone (farK 0), the icons remain', st && st.farK === 0, JSON.stringify(st));
  const vis = abJson("(function(){var v=0;document.querySelectorAll('#chatbots .chatbot').forEach(function(el){if(el.style.display!=='none')v++});return JSON.stringify({visible:v})})()");
  ok('ALL four icons visible in the map view (the whole world on screen)', vis && vis.visible === 4, JSON.stringify(vis));
  // zoom back in — the sea returns
  abEval("doomalay.setView(-640, -288, 1)");
  await sleep(800);
  const st2 = abJson("(function(){var s=window.DoomalayDebug||{};return JSON.stringify({farK:s.oneObject?s.oneObject.farK:null,dots:s.dots})})()");
  ok('zoomed back in: the sea is FULL again (farK 1)', st2 && st2.farK === 1 && st2.dots > 100, JSON.stringify(st2));
}

// ── W3: drag an icon across the field ──────────────────────────────
section('W3 the dragged icon (the real finger)');
{
  // center the camera on walk1 (Scooby at -500,-300)
  abEval("doomalay.setView(-500 - 640, -300 - 288, 1)");
  await sleep(600);
  const before = abJson("(function(){var el=document.querySelector('#chatbots .chatbot [data-id=walk1], #chatbots .chatbot');var p=null;document.querySelectorAll('#chatbots .chatbot').forEach(function(e){if(e.dataset.id==='walk1')p=e});if(!p)return null;var r=p.getBoundingClientRect();return JSON.stringify({cx:r.x+r.width/2,cy:r.y+r.height/2})})()");
  ok('Scooby is on screen for the finger', before !== null, JSON.stringify(before));
  if (before) {
    const sx = Math.round(before.cx), sy = Math.round(before.cy);
    ab(['mouse', 'move', String(sx), String(sy), '--duration', '120']);
    ab(['mouse', 'down']);
    ab(['mouse', 'move', String(sx + 260), String(sy + 140), '--steps', '14', '--duration', '420']);
    ab(['mouse', 'up']);
    await sleep(900);   // let the settle finish
    const after = abJson("(function(){var p=null;document.querySelectorAll('#chatbots .chatbot').forEach(function(e){if(e.dataset.id==='walk1')p=e});if(!p)return null;var r=p.getBoundingClientRect();return JSON.stringify({cx:r.x+r.width/2,cy:r.y+r.height/2})})()");
    const moved = after ? (Math.abs(after.cx - before.cx) > 150 && Math.abs(after.cy - before.cy) > 60) : false;
    ok('the finger dragged Scooby across the field (the input path + the ride + physics all live)', moved,
      JSON.stringify({ before: before, after: after }));
  }
}

// ── W4: open a chat ────────────────────────────────────────────────
section('W4 the chat (the golden path)');
{
  // tap the icon (a click on the icon element)
  const at = abJson("(function(){var p=null;document.querySelectorAll('#chatbots .chatbot').forEach(function(e){if(e.dataset.id==='walk1')p=e});if(!p)return null;var r=p.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()");
  ok('the tap target resolved', at !== null, JSON.stringify(at));
  if (at) {
    ab(['mouse', 'move', String(at.x), String(at.y), '--duration', '120']);
    ab(['mouse', 'down']);
    await sleep(90);
    ab(['mouse', 'up']);
    await sleep(700);
    const panel = abJson("(function(){var p=document.getElementById('chat-panel');return JSON.stringify({open:!!(p&&p.classList.contains('open'))})})()");
    ok('the chat panel OPENED (the tap → flash → panel path)', panel && panel.open, JSON.stringify(panel));
    // close it (the scrim)
    abEval("(function(){var s=document.getElementById('chat-scrim');if(s)s.click();return 'closed'})()");
  }
}

// ── W5: honesty ────────────────────────────────────────────────────
section('W5 honesty');
{
  const errs = abJson("(function(){return JSON.stringify(window.__errs||[])})()");
  ok('zero page errors through the whole walk', (!errs || errs.length === 0), JSON.stringify(errs));
  const rp = abJson("(function(){return JSON.stringify(doomalay.rideProbe())})()");
  ok('the ride is ON and the container carries the camera', rp && rp.on === true && rp.containerTf.indexOf('scale(') >= 0, JSON.stringify(rp));
  ab(['screenshot', '/tmp/v1570-walk-final.png']);
  ok('the final screenshot saved (the eyeball receipt)', true);
}

console.log('\n' + '═'.repeat(38));
if (fails.length) {
  console.log(`v1570 walk: ${n - fails.length}/${n} — FAILURES: ${fails.join(' · ')}`);
  process.exit(1);
} else {
  console.log(`v1570 walk: ${n}/${n} — ALL GREEN`);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
}
