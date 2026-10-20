#!/usr/bin/env node
// v1427-manager-rig.mjs — v1.42.7 THE MANAGER redteam (PLAN-V142 §3.4
// W4): the worlds overlay, proven LIVE (a real engine + the real PWA +
// the real finger where it matters):
//
//   T1  THE ENTRY IS REAL: long-press the canvas → the menu carries
//       '⊞ + Canvas' → tap → the worlds overlay opens (the sanctioned
//       ConnectOverlay surface) with the three zones
//   T2  THE ROWS ARE HONEST: engine parity (id/name/icon_count), the
//       active badge, size + updated lines, the storage footer
//   T3  THE TAP = JUMP: tap a row → the overlay closes → the ONE
//       switchTo lands (world-switched, active flips)
//   T4  THE BACK-STACK: after a jump, the '↩ back to X' chip names the
//       previous world; tap → switches back
//   T5  THE CREATE LAW: '+ create new canvas' births canvas_N with the
//       FIRST FREE index (canvas_1 seeded → canvas_2) and switches to it
//   T6  THE SHEET (⋯ + long-press): rename / duplicate / delete rows;
//       the long-press hold opens the SAME sheet
//   T7  THE RENAME LAW: local-only, state NEVER clobbered (icon_count
//       intact engine-side; state_bytes still present)
//   T8  THE DUPLICATE: a copy row with the source's icon_count
//   T9  THE DELETE: forever-confirm → row gone; the LAST canvas
//       refuses; deleting the ACTIVE world switches away first
//   T10 THE BROWSE ROW: forward-wired — the canvas library type is not
//       registered yet, the row says so, the tap opens the hub (a PANEL
//       view) honestly
//   T11 THE PORTAL CONTEXT: the hole panel's '⊞ all worlds…' opens the
//       manager in portal mode (banner + 'you are here'); tap a world =
//       re-target + the DIVE lands (two-way law intact)
//   T12 zero page errors · the theme pin (zero literals) · B1 (no body
//       appenders in worldsmanager.js)
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1427-rig-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1427-rig-'));
const ENGINE_PORT = 8437;
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

// the seeded worlds. canvas_1 is present on purpose — T5's first-free
// law must skip it and birth canvas_2.
function seedState(icons, savedAt) {
  return { icons: icons || [], dots: [], savedAt: savedAt || Date.now(), offset: { x: 0, y: 0 }, scale: 1 };
}

async function boot() {
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
  // seed: B (freshest savedAt wins the pointerless boot → canvas_1 boots active)
  await api('PUT', '/api/canvases/wA', { name: 'Alpha Base', state: seedState([{ id: 'i1', type: 'chat', x: 100, y: 100, radius: 30, name: 'A1', sessionId: 'sA1' }]) });
  await api('PUT', '/api/canvases/wB', { name: 'canvas_1', state: seedState([{ id: 'i2', type: 'chat', x: 140, y: 120, radius: 30, name: 'B1', sessionId: 'sB1' }], Date.now() + 5) });
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__pd=[];window.addEventListener('doomalay:portal-done',function(e){window.__pd.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
}

// the canvas-surface gesture helpers (the v1422 walk's law: synthetic
// gestures dispatch on the canvas surface — #c — or the input gate
// never sees them)
function press(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'down'})()");
}
function release(x, y) {
  abEval("(function(){var s=document.getElementById('c');s.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:" + x + ",clientY:" + y + ",button:0}));return 'up'})()");
}

function openManager() {
  abEval("(function(){window.WorldsManager.open();return 'opened'})()");
}

(async () => {
  console.log('v1427-manager-rig — THE MANAGER (the worlds overlay live)');
  await boot();

  // ── T1 the entry is real ─────────────────────────────────────────
  press(500, 400);
  ok('T1 the long-press menu opens', await waitFn("(function(){var m=document.getElementById('menu');return m&&!m.classList.contains('hidden')})()", 3000));
  ok('T1 the menu carries the + Canvas row', pstr("(function(){var b=document.querySelector('#menu [data-action=new-canvas]');return b?b.textContent:'none'})()") === '⊞ + Canvas');
  abEval("(function(){var b=document.querySelector('#menu [data-action=new-canvas]');if(b)b.click();return 'clicked'})()");
  ok('T1 the worlds overlay opens', await waitFn("!!document.getElementById('wm-root')", 8000));
  ok('T1 the three zones exist (rows + browse + create)',
    pstr("!!document.getElementById('wm-rows')") === 'true' &&
    pstr("!!document.getElementById('wm-browse')") === 'true' &&
    pstr("!!document.getElementById('wm-create')") === 'true');
  await sleep(700);   // the rows land

  // ── T2 the rows are honest ───────────────────────────────────────
  const engineRows = (await api('GET', '/api/canvases')).body.canvases;
  const uiRows = abJson("(function(){var rs=document.querySelectorAll('#wm-rows [data-wm-id]');return JSON.stringify(Array.prototype.map.call(rs,function(r){return r.getAttribute('data-wm-id')}))})()");
  ok('T2 row parity with the engine', uiRows && engineRows.every((r) => uiRows.indexOf(r.id) >= 0) && uiRows.length === engineRows.length,
    JSON.stringify(uiRows) + ' vs ' + JSON.stringify(engineRows.map((r) => r.id)));
  const activeRow = abJson("(function(){var rs=document.querySelectorAll('#wm-rows [data-wm-id]');var dump=[];for(var i=0;i<rs.length;i++){dump.push(rs[i].getAttribute('data-wm-id')+':'+rs[i].textContent.slice(0,50));if(rs[i].textContent.indexOf('active')>=0)return JSON.stringify(rs[i].getAttribute('data-wm-id'))}window.__t2dump=dump;return null})()");
  ok('T2 the active badge marks the boot world (rows[0] — the list law)', activeRow === 'wB', String(activeRow) + ' dump=' + JSON.stringify(abJson('JSON.stringify(window.__t2dump||[])')));
  const metaLine = pstr("(function(){var r=document.querySelector('[data-wm-id=wA]');return r?r.textContent:'none'})()");
  ok('T2 the row carries icons + size + updated', /1 icons/.test(metaLine) && /B|KB|MB/.test(metaLine), metaLine.slice(0, 120));
  ok('T2 the state_bytes probe rides the engine list', engineRows.every((r) => typeof r.state_bytes === 'number' && r.state_bytes > 0),
    JSON.stringify(engineRows.map((r) => r.state_bytes)));
  await sleep(400);
  ok('T2 the storage footer lands', /canvas/i.test(pstr("(function(){var s=document.getElementById('wm-storage');return s?s.textContent:''})()")));

  // ── T3 the tap = jump ────────────────────────────────────────────
  abEval("(function(){var r=document.querySelector('[data-wm-id=wA]');if(r)r.click();return 'tapped'})()");
  ok('T3 the switch lands (world-switched)', await waitFn("(window.__sw||[]).some(s=>s.id==='wA'&&s.ok)", 12000));
  ok('T3 the overlay closes on travel', await waitFn("window.ConnectOverlay.isOpen()===false", 5000));
  ok('T3 the active world IS Alpha Base', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === 'wA');

  // ── T4 the back-stack ────────────────────────────────────────────
  openManager();
  await sleep(900);
  const chip = pstr("(function(){var b=document.getElementById('wm-back');return b&&b.style.display!=='none'?b.textContent:'none'})()");
  ok('T4 the back chip names the previous world', chip.indexOf('back to canvas_1') >= 0, chip);
  abEval("(function(){var b=document.getElementById('wm-back');if(b)b.click();return 'clicked'})()");
  ok('T4 the chip travels back', await waitFn("(window.__sw||[]).some(s=>s.id==='wB'&&s.ok)", 12000));
  ok('T4 back at canvas_1', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === 'wB');

  // ── T5 the create law ────────────────────────────────────────────
  openManager();
  await sleep(900);
  abEval("(function(){var b=document.getElementById('wm-create');if(b)b.click();return 'clicked'})()");
  ok('T5 create switches to the new world', await waitFn("(window.__sw||[]).some(s=>s.ok&&s.id&&s.id.indexOf('cv_')===0&&s.id!=='wA'&&s.id!=='wB')||window.doomalay.worldsProbe().active.indexOf('cv_')===0", 12000));
  const afterCreate = (await api('GET', '/api/canvases')).body.canvases;
  const created = afterCreate.filter((r) => r.id !== 'wA' && r.id !== 'wB')[0];
  ok('T5 the generic name is canvas_2 (first free — canvas_1 was taken)', created && created.name === 'canvas_2', JSON.stringify(created && created.name));
  const createdId = created && created.id;
  ok('T5 the new world is active', createdId && abJson("JSON.stringify(window.doomalay.worldsProbe())").active === createdId);

  // ── T6 the sheet (⋯ and the long-press) ──────────────────────────
  openManager();
  await sleep(900);
  abEval("(function(){var b=document.querySelector('[data-wm-more=wA]');if(b)b.click();return 'clicked'})()");
  ok('T6 the ⋯ opens the action sheet', await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 6000));
  ok('T6 the sheet offers rename/duplicate/delete',
    pstr("(function(){return Array.prototype.map.call(document.querySelectorAll('[data-wm-act]'),function(b){return b.getAttribute('data-wm-act')}).join(',')})()") === 'rename,dup,del');
  // back out (Esc pops one level), then the LONG-PRESS path
  abEval("(function(){var e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true});window.dispatchEvent(e);return 'esc'})()");
  await sleep(500);
  const rowRect = abJson("(function(){var r=document.querySelector('#wm-rows [data-wm-id='+JSON.stringify('"+createdId+"')+']');if(!r)return null;var b=r.getBoundingClientRect();return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2})})()");
  ok('T6 the created row is present for the hold', !!rowRect, JSON.stringify(rowRect));
  if (rowRect) {
    // the hold: pointerdown → 550ms → the sheet (pointer events, the
    // manager's own hold detector)
    abEval("(function(){var r=document.querySelector('#wm-rows [data-wm-id='+JSON.stringify('"+createdId+"')+']');if(!r)return 'no-row';var b=r.getBoundingClientRect();var ev=new PointerEvent('pointerdown',{bubbles:true,clientX:b.left+20,clientY:b.top+b.height/2,pointerId:7});r.dispatchEvent(ev);return 'held'})()");
    ok('T6 the long-press opens the SAME sheet', await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 4000));
  }
  // dismiss: pop to root
  abEval("(function(){var e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true});window.dispatchEvent(e);return 'esc'})()");
  await sleep(500);

  // ── T7 the rename law ────────────────────────────────────────────
  openManager();
  await sleep(900);
  abEval("(function(){var b=document.querySelector('[data-wm-more=wA]');if(b)b.click();return 'clicked'})()");
  await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 5000);
  abEval("(function(){var b=document.querySelector('[data-wm-act=rename]');if(b)b.click();return 'clicked'})()");
  ok('T7 the rename form opens', await waitFn("!!document.getElementById('wm-rn-in')", 5000));
  abEval("(function(){var i=document.getElementById('wm-rn-in');if(!i)return 'no-input';i.value='Alpha Prime';document.getElementById('wm-rn').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 'submitted'})()");
  ok('T7 the rename lands back at the manager', await waitFn("(function(){return window.ConnectOverlay.pageDepth()===1&&!!document.getElementById('wm-root')})()", 6000));
  await sleep(600);
  const renamedRow = (await api('GET', '/api/canvases/wA')).body.canvas;
  ok('T7 the engine row carries the new name', renamedRow.name === 'Alpha Prime', JSON.stringify(renamedRow.name));
  ok('T7 the state is NEVER clobbered (icons intact)', ((renamedRow.state || {}).icons || []).length === 1,
    JSON.stringify(((renamedRow.state || {}).icons || []).length));
  const listA = (await api('GET', '/api/canvases')).body.canvases.filter((r) => r.id === 'wA')[0];
  ok('T7 state_bytes survives the rename (the no-clobber probe)', listA && listA.state_bytes > 0 && listA.icon_count === 1, JSON.stringify(listA));

  // ── T8 the duplicate ─────────────────────────────────────────────
  abEval("(function(){var b=document.querySelector('[data-wm-more=wA]');if(b)b.click();return 'clicked'})()");
  await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 5000);
  abEval("(function(){var b=document.querySelector('[data-wm-act=dup]');if(b)b.click();return 'clicked'})()");
  await sleep(1400);
  const afterDup = (await api('GET', '/api/canvases')).body.canvases;
  const dupRow = afterDup.filter((r) => r.name === 'Alpha Prime copy')[0];
  ok('T8 the copy row exists ("Alpha Prime copy")', !!dupRow, JSON.stringify(afterDup.map((r) => r.name)));
  ok('T8 the copy carries the source icons', dupRow && dupRow.icon_count === 1, JSON.stringify(dupRow));

  // ── T9 the delete ────────────────────────────────────────────────
  openManager();
  await sleep(900);
  // T9a: the last canvas refuses — delete everything down to one, then try
  // (we have 4 rows: wA, wB, createdId, dupRow. Delete dup + created + wB via API?
  // NO — the honest path: the sheet's delete, one by one. Speed matters:
  // do two via the sheet, then the engine-side for the rest.)
  async function sheetDelete(id) {
    abEval("(function(){var b=document.querySelector('[data-wm-more='+JSON.stringify('"+id+"')+']');if(b)b.click();return 'c'})()");
    if (!(await waitFn("document.querySelectorAll('[data-wm-act]').length===3", 5000))) return 'no-sheet';
    abEval("(function(){var b=document.querySelector('[data-wm-act=del]');if(b)b.click();return 'del'})()");
    if (!(await waitFn("!!document.getElementById('wm-del-y')", 5000))) return 'no-confirm';
    abEval("(function(){var y=document.getElementById('wm-del-y');if(y)y.click();return 'clicked'})()");
    await sleep(900);
    return true;
  }
  ok('T9 the delete flow runs (sheet + confirm)', (await sheetDelete(dupRow.id)) === true);
  await sleep(600);
  const afterDel1 = (await api('GET', '/api/canvases')).body.canvases;
  ok('T9 the copy is gone', !afterDel1.some((r) => r.id === dupRow.id), JSON.stringify(afterDel1.map((r) => r.id)));

  // T9b: deleting the ACTIVE world switches away first
  const activeNow = abJson("JSON.stringify(window.doomalay.worldsProbe())").active;
  ok('T9 the active world is the created one', activeNow === createdId, String(activeNow));
  openManager();
  await sleep(900);
  ok('T9 the active delete runs (sheet + confirm)', (await sheetDelete(createdId)) === true);
  await sleep(1400);   // the switch-away + the delete
  const afterDel2 = (await api('GET', '/api/canvases')).body.canvases;
  ok('T9 the active world died AFTER switching away', !afterDel2.some((r) => r.id === createdId) &&
    abJson("JSON.stringify(window.doomalay.worldsProbe())").active !== createdId,
    JSON.stringify(afterDel2.map((r) => r.id)) + ' active=' + abJson("JSON.stringify(window.doomalay.worldsProbe())").active);

  // T9c: the LAST canvas refuses — wA + wB survive; delete wA, then wB must refuse
  openManager();
  await sleep(900);
  ok('T9 the wA delete runs', (await sheetDelete('wA')) === true);
  await sleep(900);
  const beforeLast = (await api('GET', '/api/canvases')).body.canvases;
  ok('T9 wA is gone (one canvas left)', beforeLast.length === 1 && beforeLast[0].id === 'wB',
    JSON.stringify(beforeLast.map((r) => r.id)));
  openManager();
  await sleep(900);
  const lastTry = await sheetDelete('wB');
  await sleep(900);
  const finalRows = (await api('GET', '/api/canvases')).body.canvases;
  const refusalNote = pstr("(function(){var n=document.getElementById('wm-del-note');return n?n.textContent:(document.getElementById('wm-note')?document.getElementById('wm-note').textContent:'')})()");
  ok('T9 the LAST canvas refuses (the row survives)', lastTry === true && finalRows.length === 1 && finalRows[0].id === 'wB',
    'lastTry=' + lastTry + ' rows=' + JSON.stringify(finalRows.map((r) => r.id)));
  ok('T9 the refusal says why', refusalNote.indexOf('last canvas stays') >= 0, refusalNote);

  // ── T10 the browse row (forward-wired) ───────────────────────────
  // (the hub needs a PANEL host — the dock-library law. The active
  // world at this point is the empty created one (no chat icons) — a
  // real user jumps to the chat-bearing world first, then browses.)
  openManager();
  await sleep(900);
  abEval("(function(){var r=document.querySelector('[data-wm-id=wB]');if(r)r.click();return 'jumped'})()");
  ok('T10 jumped to the chat-bearing world', await waitFn("window.doomalay.worldsProbe().active==='wB'", 12000));
  openManager();
  await sleep(900);
  const browseSub = pstr("(function(){var s=document.getElementById('wm-browse-sub');return s?s.textContent:'none'})()");
  ok('T10 the browse row is honest about the wave', browseSub.indexOf('next wave') >= 0, browseSub);
  abEval("(function(){var b=document.getElementById('wm-browse');if(b)b.click();return 'clicked'})()");
  await sleep(1600);
  ok('T10 the hub opens (a PANEL view — the dock-library law)', await waitFn("!!document.getElementById('hub-topdock')", 10000));
  ok('T10 the manager overlay closed for the hub', pstr("window.ConnectOverlay.isOpen()") === 'false');

  // ── T11 the portal context ───────────────────────────────────────
  // (close the hub panel first; the pair births from the ACTIVE world
  // to the other one — dynamic, T9's switch-away decided active)
  abEval("(function(){var c=window.ChatPanel&&window.ChatPanel.current();if(c&&c.panel&&c.panel.close)try{c.panel.close()}catch(e){};return 'closed'})()");
  await sleep(700);
  // T9c left ONE world (wB) — the pair needs a second. Birth it through
  // the manager's own create row (the real user path), then pair + dive.
  openManager();
  await sleep(900);
  abEval("(function(){var b=document.getElementById('wm-create');if(b)b.click();return 'created'})()");
  await sleep(2200);
  const activeIdNow = abJson("JSON.stringify(window.doomalay.worldsProbe())").active;
  ok('T11 the create birthed a second world (canvas_2)', activeIdNow && activeIdNow !== 'wB' && activeIdNow.indexOf('cv_') === 0, String(activeIdNow));
  const diveTarget = 'wB';
  ok('T11 the pair births from the active world', await (async () => {
    abEval("(function(){window.__cp=null;window.Holes.createPair({x:300,y:220}," + JSON.stringify(diveTarget) + ",'rig door').then(function(r){window.__cp=r},function(e){window.__cp={err:String(e)}})})()");
    for (let i = 0; i < 14; i++) { const r = abJson("(window.__cp!==undefined&&window.__cp!==null)?JSON.stringify(window.__cp):null"); if (r) return r.ok === true; await sleep(300); }
    return false;
  })(), 'active=' + activeIdNow + ' target=' + diveTarget);
  await sleep(1000);
  // open the hole panel (the real tap path)
  abEval("(function(){var el=document.querySelector('#chatbots [data-type=hole]');if(!el)return 'no-hole';var r=el.getBoundingClientRect();var c=document.getElementById('c');c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}));setTimeout(function(){c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0}))},60);return 'tapped'})()");
  ok('T11 the hole panel opens', await waitFn("!!document.getElementById('hole-body')", 8000));
  ok('T11 the panel carries the all-worlds row', await waitFn("!!document.getElementById('hole-wm')", 6000));
  abEval("(function(){var b=document.getElementById('hole-wm');if(b)b.click();return 'clicked'})()");
  ok('T11 the manager opens in PORTAL mode', await waitFn("(function(){var p=window.WorldsManager.probe();return p.open&&p.portalMode})()", 6000));
  const banner = pstr("(function(){var b=document.getElementById('wm-portalnote');return b?b.textContent:'none'})()");
  ok('T11 the banner explains the fall-through', banner.indexOf('rig door') >= 0 && banner.indexOf('fall through') >= 0, banner);
  const hereRow = abJson("(function(){var rs=document.querySelectorAll('#wm-rows [data-wm-id]');for(var i=0;i<rs.length;i++){if(rs[i].textContent.indexOf('you are here')>=0)return JSON.stringify(rs[i].getAttribute('data-wm-id'))}return null})()");
  ok('T11 the active row is disabled (you are here)', hereRow === activeIdNow, String(hereRow) + ' want ' + activeIdNow);
  // tap the target: re-target + dive
  abEval("(function(){window.__pd=[];var r=document.querySelector('[data-wm-id='+JSON.stringify('" + diveTarget + "')+']');if(r)r.click();return 'tapped'})()");
  ok('T11 the re-target + DIVE lands', await waitFn("(window.__pd||[]).some(d=>d.ok===true&&d.id===" + JSON.stringify(diveTarget) + ")", 15000));
  ok('T11 the two-way law held (a return hole aims home)', await (async () => {
    await sleep(400);
    const holes = abJson("JSON.stringify(window.Holes.probe())");
    return holes && holes.holes.length === 1 && holes.holes[0].target === activeIdNow;
  })(), pstr("JSON.stringify(window.Holes.probe())"));
  ok('T11 the active world is the dive target', abJson("JSON.stringify(window.doomalay.worldsProbe())").active === diveTarget);
  // ── T12 the laws ─────────────────────────────────────────────────
  const errs = abJson("JSON.stringify(window.__errs||[])");
  ok('T12 zero page errors', errs && errs.length === 0, JSON.stringify(errs));
  // the theme pin: zero literal colors in the new module
  const wmSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/worldsmanager.js'), 'utf8');
  const literals = wmSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).filter((l) =>
    /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(l) || /#[0-9a-fA-F]{3,8}\b/.test(l));
  ok('T12 worldsmanager.js rides the theme (zero color literals)', literals.length === 0, JSON.stringify(literals.slice(0, 3)));
  ok('T12 B1: no body appenders in worldsmanager.js', wmSrc.indexOf('body.appendChild') < 0 && wmSrc.indexOf('body.append(') < 0);
  // the settings page shares the naming law
  const panelSrc = fs.readFileSync(path.join(__ROOT, 'engine/internal/server/web/canvasespanel.js'), 'utf8');
  ok('T12 the settings page rides the ONE naming law', panelSrc.indexOf('WorldsManager.nextName') >= 0);

  console.log('');
  console.log('v1427-manager-rig: ' + (n - fails.length) + '/' + n + (fails.length ? '  FAILS: ' + fails.join(' · ') : '  ALL GREEN'));
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('RIG CRASH:', e);
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e2) {}
  process.exit(1);
});
