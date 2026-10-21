#!/usr/bin/env node
// v1427-manager-walk.mjs — v1.42.7 THE MANAGER walk (the real-user
// story, the real finger — every entry is the user's own path: the
// long-press menu, the overlay rows, the sheet, the forms, the dive).
//
//   W1  the menu story: long-press the canvas → '⊞ + Canvas' → the
//       worlds overlay (three zones, rows, the storage footer)
//   W2  the jump story: tap a row → travel (the overlay closes, the
//       world flips, chats keep running — zero error bubbles)
//   W3  the back story: reopen → the '↩ back to' chip → tap → home
//   W4  the create story: '+ create new canvas' → canvas_N (first
//       free) → lands in the new world
//   W5  the sheet story: ⋯ → rename → save → the row + the engine row
//       carry it (state intact); duplicate → the copy
//   W6  the portal story: a hole panel → '⊞ all worlds…' → the
//       manager in portal mode → tap a world → re-target + the dive
//       lands (the return hole aims home)
//   W7  the laws: zero page errors, the theme pin (var(--) only)
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1427-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1427-walk-'));
const ENGINE_PORT = 8438;
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

// the REAL finger: the long-press menu, every time
function longPress(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'down'})()");
}
function releaseAt(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'up'})()");
}
function openManagerByFinger() {
  longPress(500, 400);
  return waitFn("(function(){var m=document.getElementById('menu');return m&&!m.classList.contains('hidden')&&!!document.querySelector('#menu [data-action=new-canvas]')})()", 4000).then((opened) => {
    if (!opened) return false;
    abEval("(function(){var b=document.querySelector('#menu [data-action=new-canvas]');if(b)b.click();return 'clicked'})()");
    return waitFn("!!document.getElementById('wm-root')", 8000);
  });
}

(async () => {
  console.log('v1427-manager-walk — THE MANAGER (the real-user story)');
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
  // the world: Home (a chat, the boot world) + Far Side (a chat)
  await api('PUT', '/api/canvases/home', { name: 'Home', state: { icons: [{ id: 'h1', type: 'chat', x: 200, y: 200, radius: 30, name: 'Homer', sessionId: 'sh1' }], dots: [], savedAt: Date.now(), offset: { x: 0, y: 0 }, scale: 1 } });
  await api('PUT', '/api/canvases/far', { name: 'Far Side', state: { icons: [{ id: 'f1', type: 'chat', x: 240, y: 220, radius: 30, name: 'Fara', sessionId: 'sf1' }], dots: [], savedAt: Date.now() + 5, offset: { x: 0, y: 0 }, scale: 1 } });
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('W1 the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__pd=[];window.addEventListener('doomalay:portal-done',function(e){window.__pd.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");

  // ── W1 the menu story ────────────────────────────────────────────
  ok('W1 the long-press → + Canvas opens the overlay', await openManagerByFinger());
  await sleep(900);
  ok('W1 the rows show both worlds', pstr("document.querySelectorAll('#wm-rows [data-wm-id]').length") === '2');
  const farText = pstr("(function(){var r=document.querySelector('[data-wm-id=far]');return r?r.textContent:'none'})()");
  ok('W1 the Far Side row is honest (name + icons + size)', farText.indexOf('Far Side') >= 0 && farText.indexOf('1 icons') >= 0 && /B|KB|MB/.test(farText), farText.slice(0, 100));
  await sleep(500);
  ok('W1 the storage footer', /canvas/i.test(pstr("(function(){var s=document.getElementById('wm-storage');return s?s.textContent:''})()")));
  // v1.54 THE LIBRARY SHIP pin update: the subtitle FLIPPED (the canvas
  // library is live — the forward-wiring's own anticipated state).
  ok('W1 the browse row speaks the truth about the wave (v1.54: FLIPPED — the canvas library is live)', pstr("(function(){var s=document.getElementById('wm-browse-sub');return s?s.textContent:''})()").indexOf('ready to download') >= 0);

  // ── W2 the jump story ────────────────────────────────────────────
  abEval("(function(){var r=document.querySelector('[data-wm-id=home]');if(r)r.click();return 'tapped'})()");
  ok('W2 the tap travels to Home', await waitFn("(window.__sw||[]).some(s=>s.id==='home'&&s.ok)", 12000));
  ok('W2 the overlay closed for the trip', await waitFn("window.ConnectOverlay.isOpen()===false", 5000));
  ok('W2 Home is the active world', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === 'home');
  ok('W2 the chat survived the trip (Homer lives)', pstr("(function(){return window.doomalay.world.entities.filter(function(e){return e.type==='chat'}).length})()") === '1');

  // ── W3 the back story ────────────────────────────────────────────
  ok('W3 reopen by the same finger', await openManagerByFinger());
  await sleep(900);
  const chip = pstr("(function(){var b=document.getElementById('wm-back');return b&&b.style.display!=='none'?b.textContent:'none'})()");
  ok('W3 the chip offers the way back', chip.indexOf('back to Far Side') >= 0, chip);
  abEval("(function(){var b=document.getElementById('wm-back');if(b)b.click();return 'clicked'})()");
  ok('W3 the chip carries me home', await waitFn("(window.__sw||[]).some(s=>s.id==='far'&&s.ok)", 12000));

  // ── W4 the create story ──────────────────────────────────────────
  ok('W4 reopen', await openManagerByFinger());
  await sleep(900);
  abEval("(function(){var b=document.getElementById('wm-create');if(b)b.click();return 'clicked'})()");
  await sleep(2200);
  const walkRows = (await api('GET', '/api/canvases')).body.canvases;
  const fresh = walkRows.filter((r) => r.id !== 'home' && r.id !== 'far')[0];
  ok('W4 canvas_1 was born (first free — no canvas_N taken)', fresh && fresh.name === 'canvas_1', JSON.stringify(walkRows.map((r) => r.name)));
  ok('W4 and it is the active world', fresh && abJson("JSON.stringify(window.doomalay.worldsProbe())").active === fresh.id);

  // ── W5 the sheet story ───────────────────────────────────────────
  ok('W5 reopen', await openManagerByFinger());
  await sleep(900);
  abEval("(function(){var b=document.querySelector('[data-wm-more=far]');if(b)b.click();return 'clicked'})()");
  ok('W5 the sheet opens', await waitFn("document.querySelectorAll('[data-wm-act]').length===4", 6000));   // v1.42.8: +pub
  abEval("(function(){var b=document.querySelector('[data-wm-act=rename]');if(b)b.click();return 'clicked'})()");
  ok('W5 the rename form', await waitFn("!!document.getElementById('wm-rn-in')", 5000));
  abEval("(function(){var i=document.getElementById('wm-rn-in');i.value='The Far Reaches';document.getElementById('wm-rn').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 'saved'})()");
  ok('W5 back at the manager', await waitFn("(function(){return window.ConnectOverlay.pageDepth()===1&&!!document.getElementById('wm-root')})()", 6000));
  await sleep(600);
  let farAfter = null;
  for (let i = 0; i < 10 && !(farAfter && farAfter.name === 'The Far Reaches'); i++) {
    farAfter = (await api('GET', '/api/canvases/far')).body.canvas;
    if (!(farAfter && farAfter.name === 'The Far Reaches')) await sleep(400);
  }
  ok('W5 the engine row wears the new name', farAfter && farAfter.name === 'The Far Reaches', JSON.stringify(farAfter && farAfter.name));
  ok('W5 the state rode safe (Fara lives)', farAfter && ((farAfter.state || {}).icons || []).length === 1,
    'icons=' + JSON.stringify(farAfter && ((farAfter.state || {}).icons || []).length));
  // duplicate
  abEval("(function(){var b=document.querySelector('[data-wm-more=far]');if(b)b.click();return 'clicked'})()");
  await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 5000);
  abEval("(function(){var b=document.querySelector('[data-wm-act=dup]');if(b)b.click();return 'clicked'})()");
  await sleep(1500);
  const afterDup = (await api('GET', '/api/canvases')).body.canvases;
  ok('W5 the copy exists', afterDup.some((r) => r.name === 'The Far Reaches copy'), JSON.stringify(afterDup.map((r) => r.name)));

  // ── W6 the portal story ──────────────────────────────────────────
  // (delete the copy first — one clean stage: the pair from canvas_1 to far)
  const copyId = afterDup.filter((r) => r.name === 'The Far Reaches copy')[0].id;
  abEval("(function(){var b=document.querySelector('[data-wm-more='+JSON.stringify('" + copyId + "')+']');if(b)b.click();return 'c'})()");
  await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 5000);
  abEval("(function(){var b=document.querySelector('[data-wm-act=del]');if(b)b.click();return 'del'})()");
  await waitFn("!!document.getElementById('wm-del-y')", 5000);
  abEval("(function(){var y=document.getElementById('wm-del-y');if(y)y.click();return 'gone'})()");
  await sleep(1200);
  const prePair = (await api('GET', '/api/canvases')).body.canvases;
  ok('W6 the stage is clean (3 worlds)', prePair.length === 3, JSON.stringify(prePair.map((r) => r.id)));
  // the pair births (from the active canvas_1 to far)
  const activeId = abJson("JSON.stringify(window.doomalay.worldsProbe())").active;
  ok('W6 the pair births', await (async () => {
    abEval("(function(){window.__cp=null;window.Holes.createPair({x:320,y:240},'far','the walk door').then(function(r){window.__cp=r},function(e){window.__cp={err:String(e)}})})()");
    for (let i = 0; i < 14; i++) { const r = abJson("(window.__cp!==undefined&&window.__cp!==null)?JSON.stringify(window.__cp):null"); if (r) return r.ok === true; await sleep(300); }
    return false;
  })(), 'active=' + activeId);
  await sleep(1000);
  // the hole panel by the real tap
  abEval("(function(){var el=document.querySelector('#chatbots [data-type=hole]');if(!el)return 'no-hole';var r=el.getBoundingClientRect();var c=document.getElementById('c');c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}));setTimeout(function(){c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}))},60);return 'tapped'})()");
  ok('W6 the hole panel opens', await waitFn("!!document.getElementById('hole-body')", 8000));
  ok('W6 the all-worlds row is there', await waitFn("!!document.getElementById('hole-wm')", 6000));
  abEval("(function(){var b=document.getElementById('hole-wm');if(b)b.click();return 'clicked'})()");
  ok('W6 the manager opens in portal mode', await waitFn("(function(){var p=window.WorldsManager.probe();return p.open&&p.portalMode})()", 6000));
  ok('W6 the banner names the door', await waitFn("(function(){var b=document.getElementById('wm-portalnote');return b&&b.textContent.indexOf('the walk door')>=0})()", 6000));
  abEval("(function(){window.__pd=[];var r=document.querySelector('[data-wm-id=far]');if(r)r.click();return 'through'})()");
  ok('W6 the fall-through lands in The Far Reaches', await waitFn("(window.__pd||[]).some(d=>d.ok===true&&d.id==='far')", 15000));
  ok('W6 the return hole aims home', await (async () => {
    // v1.42.8 harness hardening: poll (the dive's emerge + the engine
    // write can outlive a fixed 400ms — a flaky gate is a lying gate)
    const t0 = Date.now();
    for (;;) {
      const holes = abJson("JSON.stringify(window.Holes.probe())");
      if (holes && holes.holes.length === 1 && holes.holes[0].target === activeId) return true;
      if (Date.now() - t0 > 8000) return false;
      await sleep(350);
    }
  })(), pstr("JSON.stringify(window.Holes.probe())"));

  // ── W7 the laws ──────────────────────────────────────────────────
  const errs = abJson("JSON.stringify(window.__errs||[])");
  ok('W7 zero page errors through the whole walk', errs && errs.length === 0, JSON.stringify(errs));
  const wmSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/worldsmanager.js'), 'utf8');
  const litLines = wmSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).filter((l) => /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(l) || /#[0-9a-fA-F]{3,8}\b/.test(l));
  ok('W7 the theme pin (zero literals in the manager)', litLines.length === 0, JSON.stringify(litLines.slice(0, 2)));

  console.log('');
  console.log('v1427-manager-walk: ' + (n - fails.length) + '/' + n + (fails.length ? '  FAILS: ' + fails.join(' · ') : '  ALL GREEN'));
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('WALK CRASH:', e);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e2) {}
  process.exit(1);
});
