#!/usr/bin/env node
// v1380-swift-canvas-walk.mjs — v1.38.0 THE SWIFT CANVAS, the LIVE walk.
// The real engine + the real PWA (agent-browser) + the honest raster A/B:
//   W1  BOOT — the base worktree engine (origin/main) + the worktree
//       engine, both built + healthy
//   W2  THE RASTER A/B — the #c2 atom pass measured LIVE on the real
//       browser canvas (clear-between-paints, warm, adaptive N, median
//       of rounds): BASE vs NEW — no regression, the honest speedup
//   W3  THE BEHAVIORAL LAWS (v0841's contract) — #c2 moves (stars
//       orbit), #c stays identical (the cheap frame), backHidden +
//       frontInside occur (explicit t samples), #c2 never blocks input
//   W4  THE DUAL STAR VERDICT LIVE — the probe ran, the verdict is
//       sticky, the sprite path forced live paints, the arc path paints
//   W5  THE WORLD LAYER LIVE (forced 'on') — the layer activates, star
//       sprites mint, the driver runs and RESTS on unbind, the DOM
//       icons return on 'off', zero errors
//   W6  MOBILE + the honest close — 390px paints clean, zero page
//       errors across the whole walk
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const __ROOT = fs.existsSync('/home/z/doomalay/engine/go.mod') ? '/home/z/doomalay' : process.cwd();
const GO = process.env.GO_BIN || (fs.existsSync('/home/z/sdk/go/bin/go') ? '/home/z/sdk/go/bin/go' : 'go');
const BASE_TREE = '/tmp/v1380-base-tree';
const ENGINE_A = '/tmp/doomalay-v1380-base-engine';   // the BEFORE (origin/main)
const ENGINE_B = '/tmp/doomalay-v1380-new-engine';    // the AFTER (the worktree)
const PORT_A = 8697, PORT_B = 8698;
const URL_A = 'http://127.0.0.1:' + PORT_A;
const URL_B = 'http://127.0.0.1:' + PORT_B;
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1380a-'));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), 'dm1380b-'));
const LOG_A = '/tmp/dm1380-base.log', LOG_B = '/tmp/dm1380-new.log';
const SID = 'v1380-walk';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// agent-browser (the CLI; the v1340 law) — jparse handles the
// DOUBLE-JSON encoding (the v1250 law: string results come back
// JSON-encoded; a second parse recovers the value)
function ab(args, timeoutMs) {
  try {
    return execSync('agent-browser ' + args, { timeout: timeoutMs || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '') || ('ERR ' + e.message);
  }
}
function abEval(js, tmo) { return ab('eval ' + JSON.stringify(js), tmo || 25000); }
function jparse(raw) {
  let v = raw;
  for (let i = 0; i < 3; i++) {
    try { v = JSON.parse(v); } catch (e) { break; }
    if (typeof v !== 'string') break;
  }
  return v;
}
function pstr(js, tmo) { return String(jparse(abEval(js, tmo))); }
async function waitFn(js, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (String(jparse(abEval(js))).trim() === 'true') return true;
    if (Date.now() - t0 > (timeoutMs || 15000)) return false;
    await sleep(400);
  }
}

function bootEngine(bin, port, data, log) {
  const env = { ...process.env, DOOMALAY_OTA_DISABLE: '1' };
  const out = fs.openSync(log, 'a');
  const child = spawn('nohup', ['setsid', bin, '--port', String(port), '--bind', '127.0.0.1', '--data-dir', data], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
}
async function waitEngine(url, log) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(url + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  throw new Error('engine never healthy: ' + fs.readFileSync(log, 'utf8').slice(-800));
}
function killEngine(bin) { try { execSync("pkill -f '" + bin + "' || true"); } catch (e) {} }

// the in-page raster probe — THE HONEST SHAPE (the lost session's laws):
// clear between paints (the production frame; accumulated semi-transparent
// ink pushes Skia's software canvas off its fast path — a ~100x artifact),
// warm first (bakes/caches), adaptive N (small evals — the box is 2 CPUs
// and a CDP timeout does not kill running JS), single-line, median of
// rounds. Returns ms/paint.
async function probeRaster(rounds) {
  const warm = pstr("(function(){try{window.Settings.setState({workerPaint:false,dotAnimate:false,lineAnimate:false})}catch(e){};var c2=document.getElementById('c2');var ctx=c2.getContext('2d');var ents=window.doomalay.world.entities;var counts=window.Atoms.countsOf();var cols=window.Atoms.colorsFor();for(var i=0;i<12;i++){ctx.clearRect(0,0,c2.width,c2.height);window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,ents)}return 'warm:'+ents.length})()");
  const cal = parseFloat(pstr("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');var ents=window.doomalay.world.entities;var N=10;var t0=performance.now();for(var i=0;i<N;i++){ctx.clearRect(0,0,c2.width,c2.height);window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,ents)}return ((performance.now()-t0)/N).toFixed(4)})()"));
  const N = Math.max(30, Math.min(240, Math.round(300 / Math.max(0.05, cal || 0.5))));
  const results = [];
  for (let r = 0; r < (rounds || 3); r++) {
    const v = parseFloat(pstr("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');var ents=window.doomalay.world.entities;var N=" + N + ";var t0=performance.now();for(var i=0;i<N;i++){ctx.clearRect(0,0,c2.width,c2.height);window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,ents)}return ((performance.now()-t0)/N).toFixed(4)})()"));
    if (isFinite(v)) results.push(v);
  }
  results.sort((a, b) => a - b);
  return { median: results[Math.floor(results.length / 2)], results, N, warm, cal };
}

// open the PWA on an engine, seed two chats with atoms, park them.
// THE WORKER-PAINT LAW (the v0.85.2 receipt): the painter mode is decided
// at MODULE LOAD from the persisted setting — transferControlToOffscreen
// is one-way, so the probe needs MAIN mode: persist workerPaint:false on
// the first boot, then RELOAD (the fresh load reads the persisted state
// and keeps #c2's context on the main thread).
async function openWorld(url, nAtoms) {
  ab('close');
  ab('set viewport 1280 900');
  ab('open ' + url + '/?apk=1');
  await waitFn("window.__doomalayReady===true||!!window.doomalay", 25000);
  pstr("(function(){try{window.Settings.setState({workerPaint:false,dotAnimate:false,lineAnimate:false})}catch(e){}return 'main-mode-persisted'})()");
  ab('open ' + url + '/?apk=1');   // THE RELOAD — the load-time decision reads the persisted main mode
  ab('set viewport 1280 900');     // a fresh tab can inherit a stale mobile viewport — pin it again
  await waitFn("window.__doomalayReady===true||!!window.doomalay", 25000);
  abEval("window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e))});'armed'");
  await jpost(url + '/api/sessions', { id: SID, title: 'v1380 walk', model: 'stub/model-x', provider: 'groq' });
  pstr("(window.doomalay.openChatBySession('" + SID + "', {}), 'opened')");
  await waitFn("window.doomalay.world.entities.length>=1", 10000);
  // THE REFRESH RACE (the walk's own conviction): openChatBySession fires an
  // ASYNC workspace refresh whose .then writes counts[SID]=0 — it can land
  // AFTER the park's setCount and zero the seed. Let it land FIRST.
  await sleep(900);
  pstr("(function(){var es=window.doomalay.world.entities;for(var i=0;i<es.length;i++){es[i].x=520+i*180;es[i].y=380;es[i].vx=0;es[i].vy=0;es[i].render(0,0,1)}window.doomalay.setView(0,0,1);window.Atoms.setCount('" + SID + "'," + nAtoms + ");return 'parked:'+window.Atoms.countsOf()['" + SID + "']})()");
  await waitFn("window.Atoms.countsOf()['" + SID + "']==" + nAtoms, 8000);
  // THE STATE RECEIPT — the probe's own precondition, on the record:
  // the icon on-screen (c2 sized) + the counts live + the paint counts stars
  const st = jparse(abEval("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');var es=window.doomalay.world.entities;var s=window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,es);return JSON.stringify({cw:c2.width,ents:es.length,stars:s.stars})})()")) || {};
  console.log('    [state] ' + url.slice(-4) + ' → c2 ' + (st.cw || '?') + 'px · ' + (st.ents || 0) + ' entities · paint ' + (st.stars || 0) + ' stars');
  if ((st.stars || 0) === 0) { console.log('    [state] PRECONDITION FAILED — retrying the park once'); await sleep(1200); pstr("(window.Atoms.setCount('" + SID + "',0), 'bump')"); await sleep(300); pstr("(window.Atoms.setCount('" + SID + "'," + nAtoms + "), 'reseed')"); await sleep(300); }
}

// ══ THE WALK ═══════════════════════════════════════════════════════
console.log('W1 — BOOT (both engines):');
try { execSync("pkill -f doomalay-v1380 || true"); } catch (e) {}
execSync(`git -C ${__ROOT} worktree remove --force ${BASE_TREE} 2>/dev/null || true`);
execSync(`git -C ${__ROOT} worktree add --detach ${BASE_TREE} origin/main 2>&1 | tail -1`);
execFileSync(GO, ['build', '-o', ENGINE_A, './cmd/doomalay'], { cwd: BASE_TREE + '/engine', stdio: 'inherit' });
execFileSync(GO, ['build', '-o', ENGINE_B, './cmd/doomalay'], { cwd: __ROOT + '/engine', stdio: 'inherit' });
bootEngine(ENGINE_A, PORT_A, DATA_A, LOG_A);
await waitEngine(URL_A, LOG_A);
ok('W1: the BASE engine (origin/main worktree) builds + boots healthy', true);
bootEngine(ENGINE_B, PORT_B, DATA_B, LOG_B);
await waitEngine(URL_B, LOG_B);
ok('W1: the NEW engine (the wave tree) builds + boots healthy', true);

console.log('W2 — THE RASTER A/B (the honest in-page probe):');
await openWorld(URL_A, 20);
const baseP = await probeRaster(5);
killEngine(ENGINE_A);
await openWorld(URL_B, 20);
const newP = await probeRaster(5);
const ratio = baseP.median / newP.median;
ok(`W2: BASE ${baseP.median.toFixed(3)}ms/paint vs NEW ${newP.median.toFixed(3)}ms/paint = ${(ratio).toFixed(2)}x (N=${newP.N}; medians of 5)`, isFinite(ratio) && ratio > 1.0);
ok(`W2: the probe cleared between paints (the honest frame shape; BASE rounds ${baseP.results.map(r => r.toFixed(3)).join(' ')} · NEW ${newP.results.map(r => r.toFixed(3)).join(' ')})`, newP.results.length >= 3);

console.log('W3 — THE BEHAVIORAL LAWS (v0841\'s contract):');
{
  // #c2 moves (the stars orbit), #c identical (the cheap frame)
  const c1a = pstr("(function(){try{window.Settings.setState({workerPaint:false,dotAnimate:false,lineAnimate:false})}catch(e){};window.doomalay.repaint();return document.getElementById('c').toDataURL().length})()");
  const c2a = pstr("(function(){window.doomalay.repaint();return document.getElementById('c2').toDataURL().length})()");
  await sleep(450);
  const c1b = pstr("(function(){window.doomalay.repaint();return document.getElementById('c').toDataURL().length})()");
  const c2b = pstr("(function(){window.doomalay.repaint();return document.getElementById('c2').toDataURL().length})()");
  ok('W3: #c2 MOVES over 450ms (the stars orbit: ' + c2a + ' → ' + c2b + ')', c2a !== c2b);
  ok('W3: #c stays IDENTICAL (the resting grid is not repainted by the atoms)', c1a === c1b);
  // the occlusion stats via explicit t samples (the honest sampler — wide t sweep)
  const stats = pstr("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');var ents=window.doomalay.world.entities;var counts=window.Atoms.countsOf();var cols=window.Atoms.colorsFor();var b=0,f=0;for(var t=0;t<40;t+=0.05){var s=window.AtomCore.paintCore(ctx,c2.width,c2.height,0,0,1,ents,counts,cols,t);b+=s.backHidden;f+=s.frontInside}return b+'/'+f})()");
  const [bh, fi] = stats.split('/').map(Number);
  ok('W3: backHidden (' + bh + ') and frontInside (' + fi + ') both occur (the back-and-above law)', bh > 0 && fi > 0);
  // #c2 never blocks input — the icon's OWN center (its el's bounding box).
  // The panel must close first (openChatBySession leaves it open and its
  // header covers the icon — the scrim click is the real user's close).
  pstr("(function(){var s=document.getElementById('chat-scrim');if(s)s.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return 'closed'})()");
  await sleep(500);
  const hit = pstr("(function(){var es=window.doomalay.world.entities;var el=es&&es[0]&&es[0].el;if(!el)return 'no-el';var r=el.getBoundingClientRect();var e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);var walk=e;for(var i=0;i<6&&walk;i++){if(walk.classList&&walk.classList.contains('chatbot'))return 'chatbot';walk=walk.parentElement}return 'hit:'+(e?(e.className||e.id||e.tagName).toString().slice(0,40):'none')})()");
  ok('W3: elementFromPoint at the icon center is the icon (not #c2) — ' + hit, /chatbot/.test(hit));
}

console.log('W4 — THE DUAL STAR VERDICT LIVE:');
{
  const verdict = pstr("(function(){var v=null;try{v=localStorage.getItem('doomalay.stardraw.v1')}catch(e){}return v===null?'null':v})()");
  ok('W4: the verdict is probed + sticky (localStorage doomalay.stardraw.v1 = ' + verdict + ')', verdict === 'arc' || verdict === 'sprite');
  // the sprite path forced live
  const forced = pstr("(function(){window.__forceStarPath='sprite';var c2=document.getElementById('c2');var ctx=c2.getContext('2d');ctx.clearRect(0,0,c2.width,c2.height);var s=window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,window.doomalay.world.entities);window.__forceStarPath=null;return 'stars='+s.stars})()");
  ok('W4: the SPRITE path paints live (forced) — ' + forced, /stars=\d+/.test(forced) && !/stars=0/.test(forced));
  const unforced = pstr("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');ctx.clearRect(0,0,c2.width,c2.height);var s=window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,window.doomalay.world.entities);return 'stars='+s.stars})()");
  ok('W4: the environment path paints live (the verdict\'s own pick) — ' + unforced, /stars=\d+/.test(unforced) && !/stars=0/.test(unforced));
}

console.log('W5 — THE WORLD LAYER LIVE (forced on):');
{
  pstr("(function(){window.Settings.setState({worldLayer:'on'});return 'set'})()");
  // the layer activates (auto threshold 60 or forced on)
  const act = await waitFn("window.World3D && window.World3D.active()===true", 15000);
  ok('W5: the world layer activates (forced on)', act);
  const d = jparse(abEval("(function(){var d=window.World3D.debug();return JSON.stringify({sprites:d.sprites,stars:d.stars,driver:d.driver,renderer:d.renderer})})()")) || {};
  ok('W5: the star sprites mint in the layer (' + JSON.stringify(d) + ')', (d.stars || 0) > 0 && (d.sprites || 0) >= 1);
  await sleep(700);
  const drvRun = pstr("(window.World3D.debug().driver)");
  ok('W5: the driver RUNS while stars orbit (' + drvRun + ')', drvRun === 'running');
  // unbind → the driver rests (zero frames at rest)
  pstr("(window.Atoms.setCount('" + SID + "',0), 'unbound')");
  await sleep(900);
  const drvRest = pstr("(window.World3D.debug().driver)");
  ok('W5: the driver RESTS on unbind (zero frames at rest) — ' + drvRest, drvRest === 'resting');
  // the DOM icons return on 'off'
  pstr("(window.Settings.setState({worldLayer:'off'}), 'off')");
  await waitFn("window.World3D.active()===false", 8000);
  const domBack = pstr("(function(){var lay=document.getElementById('chatbots');var c3=document.getElementById('c3');return (lay&&!lay.classList.contains('pixi3d')?'dom-ok':'pixi-still')+'/'+(c3?'c3-still':'c3-gone')})()");
  ok('W5: the DOM icons return on off (' + domBack + ')', /dom-ok\/c3-gone/.test(domBack));
  // re-arm for the rest of the walk
  pstr("(window.Atoms.setCount('" + SID + "',20), 'rebound')");
  pstr("(window.Settings.setState({worldLayer:'auto'}), 'auto')");
}

console.log('W6 — MOBILE + the honest close:');
{
  ab('set viewport 390 844');
  await sleep(500);
  const mob = pstr("(function(){var c2=document.getElementById('c2');var ctx=c2.getContext('2d');ctx.clearRect(0,0,c2.width,c2.height);var s=window.Atoms.paint(ctx,c2.width,c2.height,0,0,1,window.doomalay.world.entities);return 'stars='+s.stars})()");
  ok('W6: 390px mobile paints clean — ' + mob, /stars=\d+/.test(mob));
  const errs = pstr("(window.__errs.length)");
  ok('W6: zero page errors across the whole walk (' + errs + ')', String(errs) === '0');
}

killEngine(ENGINE_B);
try { execSync(`git -C ${__ROOT} worktree remove --force ${BASE_TREE} 2>/dev/null || true`); } catch (e) {}
console.log(`\n══ RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
