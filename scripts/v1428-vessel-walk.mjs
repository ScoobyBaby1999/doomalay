#!/usr/bin/env node
// v1428-vessel-walk.mjs — v1.42.8 THE VESSEL live walk (a real engine +
// the real PWA + the real finger): the publish sheet → the toggles →
// the export → the import (a REAL File through the REAL input) → the
// world lands.
//
//   W1  THE SHEET OPENS: ⋯ → 'publish .doomcanvas' → the toggle tree
//       (the canvas locked · the chats group + the chat leaf · the
//       history row · the linked-worlds group) + the live size line
//   W2  THE TOGGLES ARE LIVE: flipping 'chat histories' drops the size
//   W3  THE EXPORT IS REAL: lastBuilt carries the manifest + the
//       bundle passes its OWN ladder in-page + BYOK (no key-shaped
//       field names anywhere in the bundle JSON)
//   W4  THE IMPORT IS REAL: the manager's import row → a REAL File on
//       the REAL input → the report page (the world landed · chats
//       reborn · 1 linked world) — zero errors
//   W5  THE WORLD LANDED: switchTo fired (world-switched), the probe's
//       active = the new row, the icons ride, the provenance mark
//       (worldsProbe.provenance = the source world's name)
//   W6  THE ENGINE PARITY: the new canvas row exists with the icon
//       count; the reborn session carries auto-tools OFF; the hole
//       retargets to the reborn child; the history events rode
//   W7  zero page errors · the theme pin (zero literals) · B1 (no body
//       appenders in the three new/touched modules)
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1428-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1428-walk-'));
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

// a real PNG (1x1) — the asset the walk's chat carries
const TINY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 250, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 129, 109, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

async function boot() {
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
  // SEED: a real session (Aster) with a turn of history + a background
  // asset + tweaks; a child canvas; the parent canvas ACTIVE with the
  // chat icon (model+provider — the gatelock law) + the hole.
  const sess = (await api('POST', '/api/sessions', { title: 'Aster', model: 'glm-5.3', provider: 'opencode', sandbox: 'quick', effort: 'high', web_search: true })).body;
  const SID = sess.ID;
  await api('POST', `/api/sessions/${SID}/events`, { type: 'user', text: 'hello from the walk' });
  await api('POST', `/api/sessions/${SID}/events`, { type: 'assistant', text: 'the walk hears you' });
  await api('PUT', `/api/sessions/${SID}/tweaks`, { bubbleStyle: 'soft' });
  await api('PUT', `/api/sessions/${SID}/background`, TINY_PNG, true);
  const childState = { offset: { x: 0, y: 0 }, scale: 1, currentFamily: '', savedAt: Date.now(),
    icons: [{ id: 'ci1', type: 'chat', x: 30, y: 30, radius: 28, name: 'Child Chat', sessionId: 'none-yet', model: 'minimax-m3', provider: 'nvidia' }], dots: [], settings: { theme: 'paper' } };
  await api('PUT', '/api/canvases/wChild', { name: 'The Child', state: childState });
  const parentState = { offset: { x: 40, y: 60 }, scale: 1.2, currentFamily: 'anthropic',
    icons: [
      { id: 'i1', type: 'chat', x: 120, y: 120, radius: 28, name: 'Aster', sessionId: SID, model: 'glm-5.3', provider: 'opencode', caps: { termux: true, webSearch: true, deepResearch: false, libAuto: false, skillsAuto: false, templateAuto: false } },
      { id: 'h1', type: 'hole', x: 320, y: 220, radius: 24, targetWorldId: 'wChild', pairId: 'p1', label: 'to the child' }
    ],
    dots: [], settings: { theme: 'midnight', gridSize: 44 }, savedAt: Date.now() + 5 };
  await api('PUT', '/api/canvases/wParent', { name: 'Home World', state: parentState });

  ab(['open', ENGINE + '/config/names.json']);
  await sleep(600);
  abEval("localStorage.clear()");
  await sleep(400);
  ab(['open', ENGINE]);
  ok('the app boots ready', await waitFn('window.__doomalayReady === true', 30000));
  await sleep(1800);
  abEval("(function(){window.__sw=[];window.addEventListener('doomalay:world-switched',function(e){window.__sw.push(e.detail)});window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message))});return 'wired'})()");
  return SID;
}

function openManager() {
  abEval("(function(){window.WorldsManager.open();return 'opened'})()");
}

(async () => {
  console.log('v1428-vessel-walk — THE VESSEL (the real finger: publish → export → import → land)');
  const SID = await boot();

  // ── W1 the sheet opens ────────────────────────────────────────────
  openManager();
  await sleep(900);
  ok('W1 the manager opens with the import row', await waitFn("!!document.getElementById('wm-import')", 5000));
  // the active row's ⋯ → the sheet
  abEval("(function(){var b=document.querySelector('button[data-wm-more]');if(b)b.click();return 'clicked'})()");
  ok('W1 the action sheet opens', await waitFn("!!document.querySelector('[data-wm-act=pub]')", 5000));
  ok('W1 the sheet carries the publish row', pstr("(function(){var b=document.querySelector('[data-wm-act=pub]');return b?b.textContent:'none'})()").indexOf('publish') >= 0);
  abEval("(function(){var b=document.querySelector('[data-wm-act=pub]');if(b)b.click();return 'clicked'})()");
  ok('W1 the publish sheet opens (the toggle tree)', await waitFn("!!document.getElementById('wm-pub')", 9000));
  await sleep(600);
  const treeText = pstr("(function(){var t=document.getElementById('wm-pub');return t?t.textContent:''})()");
  ok('W1 the tree carries the locked canvas + the chat + the history + the linked world',
    /always/.test(treeText) && /Aster/.test(treeText) && /histories/.test(treeText) && /The Child|linked/i.test(treeText),
    treeText.slice(0, 200));
  const size0 = pstr("(function(){var s=document.getElementById('wm-pub-size');return s?s.textContent:''})()");
  ok('W1 the live size line reads', /≈/.test(size0) && /B|KB|MB/.test(size0), size0);

  // ── W2 the toggles are live ───────────────────────────────────────
  abEval("(function(){var els=document.querySelectorAll('[data-wm-tg]');for(var i=0;i<els.length;i++){if(els[i].getAttribute('data-wm-tg')==='history'){els[i].click();break}}return 'toggled'})()");
  await sleep(400);
  const size1 = pstr("(function(){var s=document.getElementById('wm-pub-size');return s?s.textContent:''})()");
  const num = (s) => { const m = /([\d.]+)\s*(B|KB|MB)/.exec(s || ''); if (!m) return -1; const u = { B: 1, KB: 1024, MB: 1048576 }; return parseFloat(m[1]) * u[m[2]]; };
  ok('W2 flipping histories drops the size (' + size0 + ' → ' + size1 + ')', num(size1) < num(size0) && num(size1) > 0, size0 + ' → ' + size1);
  // flip it back (the export should carry history)
  abEval("(function(){var els=document.querySelectorAll('[data-wm-tg]');for(var i=0;i<els.length;i++){if(els[i].getAttribute('data-wm-tg')==='history'){els[i].click();break}}return 'toggled'})()");
  await sleep(300);

  // ── W3 the export is real ─────────────────────────────────────────
  abEval("(function(){var b=document.getElementById('wm-pub-export');if(b)b.click();return 'clicked'})()");
  ok('W3 the build lands (lastBuilt)', await waitFn("!!(window.CanvasBundle&&window.CanvasBundle.lastBuilt)", 15000));
  const lb = abJson("(function(){var l=window.CanvasBundle.lastBuilt;return JSON.stringify({name:l.name,bytes:l.bytes.length,manifest:l.manifest})})()");
  ok('W3 the manifest speaks the format', lb && lb.manifest.format === 'doomalay-canvas' && lb.manifest.formatVersion === '1.0' && lb.manifest.name === 'Home World', JSON.stringify(lb && lb.manifest).slice(0, 160));
  ok('W3 the bundle passes its OWN ladder in-page',
    abEval("(function(){var l=window.CanvasBundle.lastBuilt;var v=window.CanvasBundle.read(l.bytes);return v.ok})()") === 'true');
  ok('W3 BYOK: no key-shaped field name rides the bundle',
    abEval("(function(){var l=window.CanvasBundle.lastBuilt;var v=window.CanvasBundle.read(l.bytes);var hit=[];var re=/(api_?key|token|secret|password|credential)/i;Object.keys(v.files).forEach(function(nm){if(typeof v.files[nm]!=='string')return;try{var w=function(o,p){if(o&&typeof o==='object')Object.keys(o).forEach(function(k){if(re.test(k))hit.push(p+'.'+k);w(o[k],p+'.'+k)})};w(JSON.parse(v.files[nm]),nm)}catch(e){}});return hit.length===0})()") === 'true');
  ok('W3 the bundle carries the child world + the chat + the asset',
    abEval("(function(){var l=window.CanvasBundle.lastBuilt;var v=window.CanvasBundle.read(l.bytes);return JSON.stringify(Object.keys(v.files))})()").indexOf('children/wChild.doomcanvas') >= 0,
    pstr("(function(){var l=window.CanvasBundle.lastBuilt;var v=window.CanvasBundle.read(l.bytes);return JSON.stringify(Object.keys(v.files))})()"));

  // ── W4 the import is real (a REAL File on the REAL input) ────────
  // close the sheet stack back to the manager root first
  abEval("(function(){try{window.ConnectOverlay.popPage()}catch(e){};try{window.ConnectOverlay.popPage()}catch(e){};return 'popped'})()");
  await sleep(700);
  openManager();
  await sleep(800);
  abEval("(function(){var b=document.getElementById('wm-import');if(b)b.click();return 'clicked'})()");
  ok('W4 the real file input exists', await waitFn("!!document.getElementById('wm-import-input')", 5000));
  abEval("(function(){var l=window.CanvasBundle.lastBuilt;var f=new File([l.bytes],'home-world.doomcanvas',{type:'application/zip'});var dt=new DataTransfer();dt.items.add(f);var inp=document.getElementById('wm-import-input');inp.files=dt.files;inp.dispatchEvent(new Event('change',{bubbles:true}));return 'dispatched'})()");
  ok('W4 the report page lands (the world landed)', await waitFn("(function(){var t=document.body.textContent;return t.indexOf('the world landed')>=0})()", 20000));
  const report = pstr("(function(){return document.body.textContent})()");
  ok('W4 the report speaks the reborn chat + the linked world',
    /chat/.test(report) && /linked world|reborn|fresh/i.test(report), report.slice(report.indexOf('Import'), report.indexOf('Import') + 300));
  await sleep(1200);   // the switchTo + the save settle

  // ── W5 the world landed ───────────────────────────────────────────
  ok('W5 the ONE switchTo fired for the new world', abJson("(function(){return JSON.stringify(window.__sw||[])})()").some((s) => s.ok && s.id && s.id.indexOf('cv_') === 0));
  const probe = abJson("JSON.stringify(window.doomalay.worldsProbe())");
  ok('W5 the probe active = the new row', probe && probe.active && probe.active.indexOf('cv_') === 0, JSON.stringify(probe));
  ok('W5 the icons rode (the chat + the hole)', probe && probe.icons === 2, JSON.stringify(probe));
  ok('W5 the provenance mark rides (from Home World)', probe && probe.provenance === 'Home World', JSON.stringify(probe));
  ok('W5 zero page errors through the whole walk', (abJson("(function(){return JSON.stringify(window.__errs||[])})()") || []).length === 0,
    pstr("(function(){return JSON.stringify(window.__errs||[]).slice(0,200)})()"));

  // ── W6 the engine parity ──────────────────────────────────────────
  const rows = (await api('GET', '/api/canvases')).body.canvases;
  const newRow = rows.filter((r) => r.id.indexOf('cv_') === 0)[0];
  ok('W6 the new canvas row exists engine-side', !!newRow, JSON.stringify(rows.map((r) => r.id)));
  const newDetail = newRow ? (await api('GET', '/api/canvases/' + newRow.id)).body : null;
  const st = newDetail && newDetail.canvas && newDetail.canvas.state;
  ok('W6 the row state rebinds the chat icon to a FRESH session',
    !!(st && st.icons && st.icons[0] && st.icons[0].sessionId && st.icons[0].sessionId !== SID),
    JSON.stringify(st && st.icons && st.icons.map((i) => i.sessionId)));
  const rebornId = st && st.icons && st.icons[0] && st.icons[0].sessionId;
  if (rebornId) {
    const rs = (await api('GET', '/api/sessions/' + rebornId)).body;
    ok('W6 the reborn session carries auto-tools OFF (WebSearch/TemplateAuto/LibAuto/Termux all false)',
      rs && rs.WebSearch === false && rs.TemplateAuto === false && rs.LibAuto === false && rs.Termux === false,
      JSON.stringify(rs && { W: rs.WebSearch, T: rs.TemplateAuto, L: rs.LibAuto, X: rs.Termux }));
    ok('W6 the reborn session: title Aster · persona absent (never seeded → never invented)',
      rs && rs.Title === 'Aster' && rs.Persona === '', JSON.stringify(rs && { T: rs.Title, P: rs.Persona }));
    const rev = (await api('GET', '/api/sessions/' + rebornId + '/events')).body;
    const evs = rev && (rev.events || rev);
    ok('W6 the history rode (the walk\'s user + assistant turns)',
      !!(evs && evs.some && evs.some((e) => (e.content || e.text) === 'hello from the walk')),
      JSON.stringify(evs && evs.slice && evs.slice(0, 3)));
  } else {
    ok('W6 the reborn session checks (no reborn id)', false, 'no reborn session');
  }
  ok('W6 the hole retargets to the reborn child',
    (function () {
      if (!st) return false;
      const hole = st.icons.filter((i) => i.type === 'hole')[0];
      return !!(hole && hole.targetWorldId && hole.targetWorldId !== 'wChild' && hole.targetWorldId.indexOf('cv_') === 0);
    })(), JSON.stringify(st && st.icons && st.icons.filter((i) => i.type === 'hole').map((h) => h.targetWorldId)));
  const childRows = rows.filter((r) => r.id !== 'wChild' && r.id !== 'wParent' && r.id !== newRow.id && r.id.indexOf('cv_') === 0);
  ok('W6 the child world was reborn as its own row', childRows.length === 1, JSON.stringify(rows.map((r) => r.id)));

  // ── W7 the laws ───────────────────────────────────────────────────
  const webDir = path.join(__ROOT, 'engine/internal/server/web');
  const srcP = fs.readFileSync(path.join(webDir, 'publishers.js'), 'utf8');
  const srcC = fs.readFileSync(path.join(webDir, 'canvasbundle.js'), 'utf8');
  const srcM = fs.readFileSync(path.join(webDir, 'worldsmanager.js'), 'utf8');
  ok('W7 theme pin: zero color literals in the new modules',
    !/(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)/.test(srcP.replace(/\/\/.*/g, '')) && !/(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)/.test(srcC.replace(/\/\/.*/g, '')) && !/(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)/.test(srcM.replace(/\/\/.*/g, '')));
  ok('W7 B1: no body appenders in the three modules',
    ['body.appendChild', 'body.append('].every((bad) => srcP.indexOf(bad) < 0 && srcC.indexOf(bad) < 0 && srcM.indexOf(bad) < 0));

  console.log('\n═══ ' + (n - fails.length) + '/' + n + ' ═══');
  if (fails.length) { console.log('FAILS: ' + JSON.stringify(fails)); process.exit(1); }
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('WALK CRASH', e); try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e2) {} process.exit(2); });
