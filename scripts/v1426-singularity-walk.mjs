#!/usr/bin/env node
// v1426-singularity-walk.mjs — v1.42.6 THE SINGULARITY redteam: the
// REAL-USER walk. The rig proved the machinery; the walk proves the
// story a thumb tells:
//
//   W1  THE PORTAL SURVIVES THE APP: make a pair, RELOAD, the hole is
//       still on the canvas, still aimed, still diveable — the whole
//       point of a reference (a browser tab survives a restart)
//   W2  THE RING WEARS THE THEME: the palette chips repaint the ring
//       live (computed border-color from the theme var — zero literals,
//       the pin's law) and the choice survives the save
//   W3  RE-TARGET: the panel's world-picker re-aims an existing portal
//       (the old pair dies on BOTH sides, the new pair births)
//   W4  ARRIVAL AT THE PORTAL: the emerge lands the camera AT the
//       return hole (the user steps OUT of a door, not into the void)
//   W5  zero errors + idle at rest
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1426-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1426-walk-'));
const ENGINE_PORT = 8439;
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

async function bootPage() {
  ab(['open', ENGINE]);
  if (!(await waitFn('window.__doomalayReady === true', 30000))) return false;
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__pd=[];window.addEventListener('doomalay:portal-done',function(e){window.__pd.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
  return true;
}

(async () => {
  console.log('v1426-singularity-walk — THE SINGULARITY (the real-user story)');
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
  await api('PUT', '/api/canvases/w2', { name: 'Second', state: { offset: { x: 60, y: -40 }, scale: 1, currentFamily: 'default', icons: [], dots: [], settings: {}, savedAt: Date.now() } });
  await api('PUT', '/api/canvases/default', { name: 'Home', state: { offset: { x: -80, y: 50 }, scale: 1, currentFamily: 'default', icons: [], dots: [], settings: {}, savedAt: Date.now() } });
  ab(['open', ENGINE + '/config/names.json']); await sleep(600);
  abEval("localStorage.clear()"); await sleep(400);
  ok('W1 the app boots', await bootPage());

  // ── W1 the portal survives the app ──────────────────────────────
  const made = await (async () => {
    abEval("(function(){window.__cp=null;window.Holes.createPair({x:300,y:220},'w2','the door').then(function(r){window.__cp=r},function(e){window.__cp={err:String(e&&e.message||e)}})})()");
    for (let i = 0; i < 14; i++) { const r = abJson("(window.__cp!==undefined&&window.__cp!==null)?JSON.stringify(window.__cp):null"); if (r) return r; await sleep(300); }
    return null;
  })();
  ok('W1 the pair births', made && made.ok === true, JSON.stringify(made));
  await sleep(1200);   // the calm save lands the hole in Home's row
  ok('W1 the reload keeps the hole', await bootPage() && abJson("JSON.stringify(window.Holes.probe())").holes.length === 1,
    pstr("JSON.stringify(window.Holes.probe())"));
  const p1 = abJson("JSON.stringify(window.Holes.probe())");
  ok('W1 the hole still aims true (target + label survive)', p1 && p1.holes[0] && p1.holes[0].target === 'w2' && p1.holes[0].label === 'the door', JSON.stringify(p1));
  // ...and still dives
  abEval("(function(){var h=window.doomalay.world.entities.filter(function(e){return e.type==='hole'})[0];window.Holes.transition(h)})()");
  ok('W1 the survived hole still dives', await waitFn("(window.__pd||[]).some(d=>d.ok===true)", 15000));
  ok('W1 the dive landed in Second', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === 'w2');

  // ── W4 arrival at the portal ────────────────────────────────────
  // (living in Second now — the camera should sit AT the return hole:
  // the hole's own screen rect ≈ the viewport center)
  const holeRect = abJson("(function(){var el=document.querySelector('#chatbots [data-type=hole]');if(!el||!el.getBoundingClientRect)return null;var r=el.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()");
  const vw = parseInt(pstr("window.innerWidth") || '0', 10);
  const vh = parseInt(pstr("window.innerHeight") || '0', 10);
  ok('W4 the emerge lands AT the return hole (≈ viewport center)', holeRect && vw && Math.abs(holeRect.x - vw / 2) < 90 && Math.abs(holeRect.y - vh / 2) < 90,
    'hole on screen @ ' + JSON.stringify(holeRect) + ' vs center ' + JSON.stringify({ x: vw / 2, y: vh / 2 }));

  // ── W2 the ring wears the theme ─────────────────────────────────
  // (the hole panel: palette chip → the ring's computed border changes)
  const borderBefore = pstr("(function(){var r=document.querySelector('#chatbots [data-type=hole] .hole-ring');return r?getComputedStyle(r).borderColor:'none'})()");
  abEval("(function(){var el=document.querySelector('#chatbots [data-type=hole]');if(!el||!el.getBoundingClientRect)return 'no-el';var r=el.getBoundingClientRect();var c=document.getElementById('c');c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}));setTimeout(function(){c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}))},60);return 'tapped'})()");
  ok('W2 the hole panel opens', await waitFn("!!document.getElementById('hole-body')", 8000));
  const chips = abJson("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#hole-body [data-pal]'),function(b){return b.getAttribute('data-pal')}))");
  ok('W2 the palette chips exist (theme tokens)', chips && chips.length === 3 && chips.indexOf('ok') >= 0 && chips.indexOf('warn') >= 0, JSON.stringify(chips));
  abEval("(function(){var b=document.querySelector('#hole-body [data-pal=warn]');if(b)b.click();return 'chip'})()");
  await sleep(500);
  const borderAfter = pstr("(function(){var r=document.querySelector('#chatbots [data-type=hole] .hole-ring');return r?getComputedStyle(r).borderColor:'none'})()");
  ok('W2 the ring repaints live from the theme var', borderBefore !== borderAfter && /rgb|var/i.test(borderAfter), borderBefore + ' → ' + borderAfter);
  await sleep(700);   // the choice rides the save
  const rowW2 = await api('GET', '/api/canvases/w2');
  const savedHole = ((rowW2.body.canvas.state.icons) || []).filter((ic) => ic.type === 'hole')[0];
  ok('W2 the palette choice survives the save', savedHole && savedHole.holePalette === 'warn', JSON.stringify(savedHole && savedHole.holePalette));

  // ── W3 re-target ────────────────────────────────────────────────
  // (the panel is still open on the hole; Home is the only other world)
  const retargetShown = await waitFn("!!document.querySelector('#hole-body [data-rt=default]')", 5000);
  ok('W3 the re-target list renders', retargetShown);
  abEval("(function(){var b=document.querySelector('#hole-body [data-rt=default]');if(b)b.click();return 'rt'})()");
  ok('W3 the re-target completes (the new pair aims home)', await waitFn("(window.Holes&&(window.Holes.probe().holes.length===1&&window.Holes.probe().holes[0].target==='default'))", 12000));
  await sleep(900);
  const rowHome = await api('GET', '/api/canvases/default');
  const homeHoles = (rowHome.body.canvas.state.icons || []).filter((ic) => ic.type === 'hole');
  ok('W3 the OLD far side died (one hole in Home, the NEW pair)', homeHoles.length === 1 && homeHoles[0].targetWorldId === 'w2',
    JSON.stringify(homeHoles.map((h) => ({ p: h.pairId, t: h.targetWorldId }))));

  // ── W5 the close-out ────────────────────────────────────────────
  ok('W5 zero in-page exceptions', pstr("JSON.stringify(window.__errs||[])") === '[]', pstr("JSON.stringify(window.__errs||[])"));
  ok('W5 the runtime is idle at rest', pstr("window.Holes.probe().phase") === 'idle');

  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  console.log(`\n${n - fails.length}/${n} passed${fails.length ? '\n  FAILED: ' + fails.join(' · ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
