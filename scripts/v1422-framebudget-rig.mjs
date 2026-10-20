#!/usr/bin/env node
// v1422-framebudget-rig.mjs — v1.42.2 THE FIELD battery (PLAN-V142 §3.0).
//
// §1 THE VISIBILITY LAW — source pins: the camera-authoritative DOM cull
//    exists (renderIconsCulled + iconInView + CULL_PAD) and owns ALL
//    three per-frame render sites (update's full render, tick's
//    latticeDue branch, the orbit-members pass).
// §2 THE SLEEP LAW — source pins: the two-tier broadphase (fine grid =
//    awake only; static grid = sleepers, lazily rebuilt), the O(1)
//    resting-world early-out, sleepers never initiate, the shove-dirty
//    marks in position correction.
// §3 THE SLEEP LAW — behavioral (vm, the REAL physics.js): the resting
//    world steps flat with n (600 vs 20 entities), a mover wakes and
//    displaces sleepers, the drag plow boosts sleepers, contacts fire
//    through the static grid, orbits never sleep, the static grid does
//    not rebuild while at rest, the elastic parity spot-check holds.
// §4 the accepted edge, pinned honestly: two overlapping sleepers do
//    not self-correct (they can't approach each other) — the documented
//    trade for O(1) rest.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const WEB = path.join(ROOT, 'engine', 'internal', 'server', 'web');
const read = (p) => fs.readFileSync(p.startsWith('/') ? p : path.join(WEB, p), 'utf8');

let n = 0;
const fails = [];
function ok(name, cond, extra) {
  n++;
  if (cond) { console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function section(t) { console.log('\n═ ' + t); }

// ══ §0 the touched files parse ══════════════════════════════════════
section('§0 the touched files parse');
for (const f of ['physics.js', 'app.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}

// ══ §1 THE VISIBILITY LAW — source pins ════════════════════════════
section('§1 THE VISIBILITY LAW — the DOM cull owns the render sites');
const ax = read('app.js');
ok('the cull helper exists (camera-authoritative)', /function iconInView\(icon\)/.test(ax) && /var CULL_PAD = 320;/.test(ax));
ok('renderIconsCulled exists + resets the stale transform on return', /function renderIconsCulled\(\)/.test(ax) && /icon\.__lastTf = null;.*force one re-render on return/s.test(ax));
ok('offscreen icons get display:none (the O(visible) write skip)', /icon\.__culled = true;\n\s*icon\.el\.style\.display = 'none';/.test(ax));
ok('update() renders through the cull', /renderGrid\(\);\n\s*renderIconsCulled\(\);.*v1\.42\.2 THE FIELD: O\(visible\) render, not O\(world\)/s.test(ax));
ok("tick()'s latticeDue branch renders through the cull", /lastAmbientFull = now;\n\s*renderIconsCulled\(\);.*v1\.42\.2 THE FIELD: O\(visible\), not O\(world\)/s.test(ax));
ok('the orbit-members pass renders through the cull', /renderMembersCulled\(window\.TabGroups\.members\(\)\)/.test(ax));
ok('no uncalled full-world render loops remain at the two sites', !/for \(const icon of world\.entities\) icon\.render\(offsetX, offsetY, scale\);/.test(ax));

// ══ §2 THE SLEEP LAW — source pins ═════════════════════════════════
section('§2 THE SLEEP LAW — the two-tier broadphase');
const px = read('physics.js');
ok('the sleeper grid + lazy rebuild exist', /_staticGrid = new Map\(\)/.test(px) && /_ensureStaticGrid\(cell\)/.test(px));
ok('the O(1) resting-world early-out exists', /if \(!anyAwake\) \{\s*\n\s*this\.fireContacts\(\);\s*\n\s*return;/.test(px));
ok('sleepers never initiate (the awake-only walk)', /if \(a\._asleep && !a\.dragging\) continue;\s*\/\/ sleepers never initiate/.test(px));
ok('the fine grid bins awake entities only', /if \(e\._asleep && !e\.dragging\) continue;\s*\/\/ sleepers ride the static grid/.test(px));
ok('a shoved sleeper dirties the static grid', /if \(b\._asleep\) this\._staticDirty = true;/.test(px) && /if \(a\._asleep \|\| b\._asleep\) this\._staticDirty = true;/.test(px));

// ══ §3 THE SLEEP LAW — behavioral (the real physics.js in a vm) ════
section('§3 THE SLEEP LAW — behavioral');
const win = {};
win.window = win;   // the IIFE assigns window.Physics — self-reference
vm.createContext(win);
vm.runInContext(read('physics.js'), win);
const { Entity, World } = win.Physics;

function resting(n) {
  const w = new World();
  for (let i = 0; i < n; i++) {
    const e = new Entity({ id: 'e' + i, x: (i % 40) * 300, y: ((i / 40) | 0) * 300, radius: 28 });
    w.add(e);
  }
  for (let i = 0; i < 3; i++) w.step(1);   // settle asleep flags
  return w;
}

// (1) the resting world steps FLAT with n — the whole point (H4/H5).
{
  const w20 = resting(20), w600 = resting(600);
  const t = (w, steps) => { const t0 = performance.now(); for (let i = 0; i < steps; i++) w.step(1); return performance.now() - t0; };
  const ms20 = t(w20, 400), ms600 = t(w600, 400);
  const per600 = (ms600 / 400) * 1000;
  ok('600 resting entities step flat vs 20 (ratio < 4)', ms600 < Math.max(ms20 * 4, 2.0),
    `20→${ms20.toFixed(2)}ms · 600→${ms600.toFixed(2)}ms over 400 steps`);
  ok('the per-step resting cost is ~free (< 60µs at 600)', per600 < 60, `${per600.toFixed(1)}µs/step`);
}

// (2) a mover WAKES + displaces sleepers through the static grid.
{
  const w = new World();
  const sleeper = (x) => { const e = new Entity({ id: 's' + x, x, y: 0, radius: 28 }); w.add(e); return e; };
  const s1 = sleeper(200), s2 = sleeper(400);
  for (let i = 0; i < 3; i++) w.step(1);
  ok('seeded sleepers are asleep', s1._asleep === true && s2._asleep === true);
  const mover = new Entity({ id: 'm', x: -200, y: 0, radius: 28 });
  mover.vx = 30; mover.vy = 0;
  w.add(mover);
  let woke = false;
  for (let i = 0; i < 40; i++) {
    w.step(1);
    if (s1.vx !== 0 || s1.vy !== 0) { woke = true; break; }
  }
  ok('the mover wakes the sleeper (impulse through the static grid)', woke);
  let displaced = false;
  for (let i = 0; i < 60; i++) w.step(1);
  if (Math.abs(s1.x - 200) > 5 || Math.abs(s2.x - 400) > 5) displaced = true;
  ok('the plow displaces the sleepers (chain through the pile)', displaced, `s1.x=${s1.x.toFixed(1)} s2.x=${s2.x.toFixed(1)}`);
}

// (3) the drag plow boosts sleepers (the DRAG_BOOST path, awake-vs-sleeper).
// The real app moves a dragged icon's position directly (the finger owns
// it — app.js wires x/y + carries the plow speed in vx/vy); the rig
// mimics that contract.
{
  const w = new World();
  const s = new Entity({ id: 's', x: 300, y: 0, radius: 28 });
  w.add(s);
  for (let i = 0; i < 3; i++) w.step(1);
  const d = new Entity({ id: 'd', x: 100, y: 0, radius: 28 });
  d.dragging = true; d.vx = 40; d.vy = 0;   // the finger's plow speed
  w.add(d);
  let hit = false;
  for (let i = 0; i < 20; i++) {
    d.x += 40;               // the finger moves the icon (the app contract)
    w.step(1);
    if (s.vx !== 0 || s.x !== 300) { hit = true; break; }
  }
  ok('the dragged plow kicks the sleeper (boost through the static grid)', hit,
    `sleeper vx=${s.vx.toFixed(2)} x=${s.x.toFixed(1)}`);
}

// (4) contacts fire through the static grid (the TabGroups dots law).
{
  const w = new World();
  w.onContacts = (cs) => { w.__hits = (w.__hits || 0) + cs.length; };
  const s = new Entity({ id: 's', x: 200, y: 0, radius: 28 });
  w.add(s);
  for (let i = 0; i < 3; i++) w.step(1);
  const m = new Entity({ id: 'm', x: -100, y: 0, radius: 28 });
  m.vx = 25; w.add(m);
  for (let i = 0; i < 30; i++) w.step(1);
  ok('contacts fire when a mover hits a sleeper', (w.__hits || 0) > 0, `${w.__hits || 0} contacts`);
}

// (5) orbit members NEVER sleep (their motion is owned by the steering).
{
  const w = new World();
  const e = new Entity({ id: 'o', x: 0, y: 0, radius: 28 });
  e._orbit = { t: 0 }; e.vx = 2; e.vy = 0;
  w.add(e);
  for (let i = 0; i < 10; i++) w.step(1);
  ok('an orbiting member stays awake + friction-skipped', e._asleep === false && e.vx === 2);
}

// (6) the static grid does NOT rebuild while the world rests.
{
  const w = resting(120);
  let rebuilds = 0;
  const orig = w._ensureStaticGrid.bind(w);
  w._ensureStaticGrid = (cell) => { rebuilds++; orig(cell); };
  for (let i = 0; i < 100; i++) w.step(1);
  ok('zero static-grid rebuilds across 100 resting steps', rebuilds === 0, `${rebuilds} rebuilds`);
}

// (7) the elastic parity spot-check (all-awake = the old algorithm exactly).
{
  const w = new World();
  const a = new Entity({ id: 'a', x: 0, y: 0, radius: 28 });
  const b = new Entity({ id: 'b', x: 60, y: 0, radius: 28 });
  a.vx = 10; b.vx = -6;
  w.add(a); w.add(b);
  w.step(1);
  // head-on approach 16 → the exchange + BOOST_MIN floor; both must
  // separate (a left, b right) with real momenta — the feel is unchanged.
  ok('the head-on pair separates (a ← → b)', a.vx < b.vx, `a.vx=${a.vx.toFixed(2)} b.vx=${b.vx.toFixed(2)}`);
}

// (8) the accepted edge, pinned: overlapping sleepers stay put.
{
  const w = new World();
  const a = new Entity({ id: 'a', x: 0, y: 0, radius: 28 });
  const b = new Entity({ id: 'b', x: 30, y: 0, radius: 28 });  // overlapping, both at rest
  w.add(a); w.add(b);
  for (let i = 0; i < 3; i++) w.step(1);
  ok('overlapping sleepers do not self-correct (the documented edge)', b.x === 30, `b.x=${b.x}`);
  ok('…and the first nudge restores order (the wake path)', (() => { b.vx = 5; w.step(1); return Math.abs(b.x - 30) > 0.5 || a.x !== 0; })());
}

console.log(`\n${'═'.repeat(40)}\nv1422 framebudget rig: ${n - fails.length}/${n} — ${fails.length ? 'FAILURES: ' + fails.join(' · ') : 'ALL GREEN'}`);
process.exit(fails.length ? 1 : 0);
