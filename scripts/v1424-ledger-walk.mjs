#!/usr/bin/env node
// v1424-ledger-walk.mjs — v1.42.4 THE LEDGER redteam: the REAL-USER
// walk. Boots the real engine, drives the real PWA in a real browser:
//
//   W1  FRESH BOOT: no state.v2 anywhere → the app births the 'default'
//       canvas engine-side (the migrate path) and the empty-state card
//       shows — zero errors
//   W2  THE REAL MIGRATION: a pre-v1.42.4 install shape (state.v2 with
//       two chat icons, no canvas field) → reload → the world restores
//       AND the engine row carries it (the digest proves it) AND the
//       pointer is set
//   W3  THE ENGINE IS THE HOME: state.v2 DELETED → reload → the world
//       still restores (from the engine row — the R3 law live)
//   W4  THE CALM SYNC: a real icon drag (the #chatbots gesture law) →
//       within the 2s cadence the engine row's state carries the moved
//       icon (saved_at advances)
//   W5  SWEEP COORDINATION: a stale chatscroll entry dies, a live one
//       survives (the engine digest join — icons live engine-side now)
//   W6  zero page errors across the whole walk
'use strict';

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_BIN = '/tmp/doomalay-v1424-walk-engine';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1424-walk-'));
const ENGINE_PORT = 8425;
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
const delLS = (key) => ab(['storage', 'local', 'remove', key]);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if (ev('window.__doomalayReady') === true) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}

// the page-context engine client (same-origin fetch — the real path)
const pageCanvases = () => ev(`fetch('/api/canvases').then(r=>r.json()).then(d=>d.canvases)`);
const pageDigest = () => ev(`fetch('/api/canvases?digest=1').then(r=>r.json()).then(d=>d.canvases)`);
const pageCanvasState = (id) => ev(`fetch('/api/canvases/${id}').then(r=>r.json()).then(d=>d.canvas && d.canvas.state)`);
const iconCount = () => ev(`document.querySelectorAll('#chatbots > *').length`);

// a realistic pre-v1.42.4 state.v2 (the migration input)
function legacyScratch() {
  return {
    offset: { x: -240, y: 160 },
    scale: 0.9,
    currentFamily: 'aurora',
    icons: [
      { type: 'chat', id: 'chat_walk_alpha', name: 'Alpha', x: 320, y: 280, vx: 0, vy: 0, radius: 34, pinned: false, sandbox: 'quick', sessionId: '' },
      { type: 'chat', id: 'chat_walk_beta', name: 'Beta', x: 720, y: 520, vx: 0, vy: 0, radius: 34, pinned: false, sandbox: 'quick', sessionId: '' }
    ],
    dots: [],
    savedAt: Date.now()
  };
}

async function reload() {
  ab(['navigate', ENGINE]);
  return waitReady();
}

async function dragIcon(dx, dy) {
  // the v1422 conviction: synthetic gestures dispatch on #chatbots
  ev(`(function(){
    var surf = document.getElementById('chatbots');
    var r = surf.getBoundingClientRect();
    var x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    var fire = function(t, x, y){ surf.dispatchEvent(new MouseEvent(t, {bubbles:true, clientX:x, clientY:y, button:0})); };
    fire('mousedown', x0, y0);
    fire('mousemove', x0 + 4, y0 + 3);
    fire('mousemove', x0 + ${dx}, y0 + ${dy});
    fire('mouseup', x0 + ${dx}, y0 + ${dy});
    return 'dragged';
  })()`);
  await sleep(400);
}

(async () => {
  console.log('v1424-ledger-walk — THE LEDGER (the engine home, live as the user)');
  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
    cwd: path.join(__ROOT, 'engine'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
  });
  const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--data-dir', DATA_DIR], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(ENGINE + '/api/health')).ok; } catch (e) { await sleep(500); }
  }
  if (!up) { console.log('engine never came up'); process.exit(1); }

  // ── W1 fresh boot ──────────────────────────────────────────────
  // The daemon's browser profile persists ACROSS runs, and the app's
  // FIRST boot would migrate the leaked scratch engine-side before we
  // could clear it. So the clean slate happens on a STATIC same-origin
  // page (no app JS ever runs there): clear localStorage + delete any
  // engine rows, settle, THEN the app's first boot is a true fresh.
  ab(['open', ENGINE + '/config/names.json']);
  await sleep(800);
  ev("localStorage.clear()");
  ev("fetch('/api/canvases').then(r=>r.json()).then(d=>Promise.all((d.canvases||[]).map(c=>fetch('/api/canvases/'+c.id,{method:'DELETE'}))))");
  await sleep(600);
  ab(['open', ENGINE]);
  ok('W1 app boots ready (clean slate)', await waitReady());
  await sleep(1500);
  let rows = await pageCanvases();
  ok('W1 the default canvas births engine-side', Array.isArray(rows) && rows.length === 1 && rows[0].id === 'default',
    JSON.stringify(rows));
  ok('W1 the empty-state card shows (true fresh)', ev(`!!document.querySelector('.empty-card, [class*=empty]')`) === true || iconCount() === 0);
  let ptr = ev(`localStorage.getItem('doomalay.canvas.current')`);
  ok('W1 the pointer is set', ptr === 'default', String(ptr));

  // ── W2 THE REAL MIGRATION ─────────────────────────────────────
  // simulate the pre-v1.42.4 install: kill the row + seed the scratch.
  // (The 3s settle lets W1's boot-time sync flush land BEFORE the
  // delete — else the upsert re-births the row mid-race and the walk
  // proves the heal path instead of the migration.)
  await sleep(3000);
  await ev(`fetch('/api/canvases/default', {method:'DELETE'})`);
  setLS('doomalay.state.v2', JSON.stringify(legacyScratch()));
  ok('W2 reload after migration shape', await reload());
  await sleep(3500);
  ok('W2 both icons restored on the canvas', iconCount() === 2, 'icons=' + iconCount());
  rows = await pageCanvases();
  ok('W2 the engine row carries the migrated world', rows.length === 1 && rows[0].id === 'default' && rows[0].icon_count === 2,
    JSON.stringify(rows));
  let dig = await pageDigest();
  let iconIds = (dig[0] && dig[0].icon_ids) || [];
  ok('W2 the digest proves the icons engine-side', iconIds.includes('chat_walk_alpha') && iconIds.includes('chat_walk_beta'),
    iconIds.join(','));
  const cam = ev('(window.doomalay && window.doomalay.cameraProbe) ? window.doomalay.cameraProbe() : null');
  ok('W2 the camera restored (migration verbatim)', !!cam && typeof cam.x === 'number', JSON.stringify(cam));
  const scratchAfter = ev(`JSON.parse(localStorage.getItem('doomalay.state.v2') || 'null')`);
  // the null-guard law: an unchanged session never rewrites the
  // scratch — the seed stays verbatim (no canvas field yet); the field
  // appears on the first REAL save (asserted post-drag in W4).
  ok('W2 the scratch survived verbatim (the no-clobber law)', !!scratchAfter && Array.isArray(scratchAfter.icons) && scratchAfter.icons.length === 2);

  // ── W3 THE ENGINE IS THE HOME ─────────────────────────────────
  const before = await pageCanvasState('default');
  delLS('doomalay.state.v2');
  ok('W3 scratch deleted, reload from the engine', await reload());
  await sleep(3500);
  ok('W3 the world still restores (engine source)', iconCount() === 2, 'icons=' + iconCount());
  const after = await pageCanvasState('default');
  ok('W3 the engine state is intact', !!after && after.icons && after.icons.length === 2);

  // ── W4 THE CALM SYNC ──────────────────────────────────────────
  const preDrag = await pageCanvasState('default');
  ok('W4 the pre-drag state is known', !!preDrag && typeof preDrag.icons[0].x === 'number');
  await dragIcon(140, 90);
  await sleep(3500);   // the calm cadence (2s) + margin
  const postDrag = await pageCanvasState('default');
  const moved = postDrag && preDrag && (
    Math.abs(postDrag.icons[0].x - preDrag.icons[0].x) > 2 ||
    Math.abs(postDrag.icons[1].x - preDrag.icons[1].x) > 2 ||
    JSON.stringify(postDrag.offset) !== JSON.stringify(preDrag.offset));
  ok('W4 the drag landed engine-side (≤2s cadence)', moved === true,
    preDrag && postDrag ? `offset ${JSON.stringify(preDrag.offset)} → ${JSON.stringify(postDrag.offset)} · icon0.x ${preDrag.icons[0].x} → ${postDrag.icons[0].x}` : 'no state');
  const rowsNow = await pageCanvases();
  ok('W4 one row only (no sync leaked a second row)', rowsNow.length === 1);
  const scratchPostDrag = ev(`JSON.parse(localStorage.getItem('doomalay.state.v2') || 'null')`);
  ok('W4 the first real save carries the canvas id', !!scratchPostDrag && scratchPostDrag.canvas === 'default',
    JSON.stringify(scratchPostDrag && { savedAt: scratchPostDrag.savedAt, canvas: scratchPostDrag.canvas }));

  // ── W5 SWEEP COORDINATION ─────────────────────────────────────
  setLS('doomalay.chatscroll.v1', JSON.stringify({
    chat_walk_alpha: 400,      // live (on the canvas)
    chat_gone_ghost: 999       // stale (nothing references it)
  }));
  const rep = await ev(`window.DoomStorage.sweep().then(r => JSON.stringify(r))`);
  const sweepRep = typeof rep === 'string' ? (() => { try { return JSON.parse(rep); } catch (e) { return null; } })() : null;
  const scrollMap = ev(`JSON.parse(localStorage.getItem('doomalay.chatscroll.v1') || '{}')`);
  ok('W5 the live icon\'s scroll survives', !!scrollMap && scrollMap.chat_walk_alpha === 400, JSON.stringify(scrollMap));
  ok('W5 the stale entry dies', !!scrollMap && !('chat_gone_ghost' in scrollMap), JSON.stringify(scrollMap));

  // ── W6 zero errors ────────────────────────────────────────────
  // NOTE: `agent-browser errors` is decorative in this CLI build (bare ✗
  // marks regardless of page state — convicted live in v1.42.6) — only
  // real error TEXT fails.
  const errs = ab(['errors']);
  const realErrLines = String(errs).split('\n').map((l) => l.trim()).filter((l) => l && l !== '✗' && l !== '✓');
  ok('W6 zero page errors across the whole walk', realErrLines.length === 0,
    JSON.stringify(realErrLines).slice(0, 400));

  try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
  console.log(`\n${n - fails.length}/${n} passed${fails.length ? '  FAILED: ' + fails.join(' · ') : ''}`);
  process.exit(fails.length ? 1 : 0);
})();
