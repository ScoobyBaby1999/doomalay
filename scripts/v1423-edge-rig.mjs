#!/usr/bin/env node
// v1423-edge-rig.mjs — v1.42.3 THE EDGE battery (PLAN-V142 §3.1).
//
// §1 source pins: the bounded world is REAL — applyWorldSize +
// clampCamera + the 9 clamp sites (finger pan · momentum · compass
// glide · setView · reset · zoomAt · pinch · boot restore · resize),
// setBounds/conform in physics, the soft damped wall constants, the
// edge affordance riding --border-strong-rgb (zero literals), the
// settings default, the Sizing row, cameraProbe (the rig read-back).
// §2 behavioral (vm, the REAL physics.js): the wall reflects with
// restitution + drag and the fling SETTLES inside; conform pulls
// stranded sleepers home + dirties the static grid; half=0 keeps the
// legacy infinite law.
// §3 the boot law (source): the settings apply BEFORE the camera
// restore, so no stale snapshot escapes the bounds.
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
  if (cond) console.log('  ✓ ' + name);
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
function section(t) { console.log('\n═ ' + t); }

// ══ §0 parse ════════════════════════════════════════════════════════
section('§0 the touched files parse');
for (const f of ['app.js', 'physics.js', 'settings.js', 'appearance.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}

// ══ §1 source pins ══════════════════════════════════════════════════
section('§1 the bounded world is real');
const ax = read('app.js');
ok('applyWorldSize exists + snaps to the sanctioned ladder', /function applyWorldSize\(sz\)/.test(ax) && /\[16384, 32768, 65536, 131072, 0\]/.test(ax));
ok('clampCamera exists (both axes independent + degenerate centering)', /function clampCamera\(\)/.test(ax) && /offsetX = -vw \/ 2;/.test(ax) && /var maxX = half - vw \/ 2;/.test(ax));
ok('the finger pan clamps', /offsetX \+= ddx; offsetY \+= ddy;\s*\n\s*clampCamera\(\);.*the finger's camera never leaves the world/s.test(ax));
ok('momentum clamps', /offsetX \+= velX; offsetY \+= velY;\s*\n\s*clampCamera\(\);.*momentum dies AT the edge/s.test(ax));
ok('the compass glide clamps every flight frame', /offsetY = glide\.fromY \+ \(toOy - glide\.fromY\) \* ease;\s*\n\s*clampCamera\(\);/s.test(ax));
ok('setView clamps (the rig writer)', /clampCamera\(\);.*no stale snapshot escapes the bounds \(the plan's boot-heal law\)/s.test(ax));
ok('zoomAt + pinch clamp', /clampCamera\(\);.*the zoomed viewport span re-enters the world/s.test(ax) && /clampCamera\(\);.*the pinch's viewport span re-enters the world/s.test(ax));
ok('the boot restore clamps AFTER the settings apply (the boot law)', ax.indexOf('applyWorldSize(window.Settings.getState().worldSize)') < ax.indexOf("offsetX = (saved.offset && saved.offset.x) || 0;"));
ok('the boot-heal clamp sits after the scale heal', /Math\.min\(MAX_SCALE, saved\.scale\)\);\s*\n\s*\}\s*\n\s*clampCamera\(\);/s.test(ax));
ok('resize + orientationchange re-clamp', /addEventListener\('resize', function \(\) \{ resize\(\); clampCamera\(\); updateEdgeAffordance\(\); \}\);/.test(ax));
ok('the edge affordance rides --border-strong-rgb (zero literals)', /rgba\(var\(--border-strong-rgb\),0\.35\)/.test(ax) && /function updateEdgeAffordance\(\)/.test(ax));
ok('the edge refresh rides the latticeDue cadence (O(1) skip-if-identical)', /renderIconsCulled\(\);.*O\(visible\), not O\(world\)\s*\n\s*updateEdgeAffordance\(\);/s.test(ax));
ok('cameraProbe exported (the read-back law)', /cameraProbe: function \(\)/.test(ax));
ok('the settings change coerces + gates', /var sz = Number\(st && st\.worldSize !== undefined \? st\.worldSize : 65536\);/.test(ax));

const px = read('physics.js');
ok('setBounds + conform exist', /setBounds\(half\)/.test(px) && /conform\(half\)/.test(px));
ok('the soft damped wall: restitution 0.4 + tangential drag 0.9', /e\.vx = -e\.vx \* 0\.4;/.test(px) && /e\.vy \*= 0\.9;/.test(px));
ok('conform pulls sleepers + dirties the static grid (the shrink migration)', /for \(const e of this\.entities\) \{\s*\n\s*if \(e\._orbit\) continue;.*e\.x = m; this\._staticDirty = true;/s.test(px));
ok('the wall pass is exempt for orbits (the steering owns them)', /if \(this\._half && !e\._orbit\) \{/.test(px));

const st = read('settings.js');
ok('worldSize defaults to 65536', /worldSize: 65536,/.test(st));
const ap = read('appearance.js');
ok('the Sizing page carries the World Size dial (5 options)', /selectRow\('worldSize', 'Bounded world'/.test(ap) && /16k \u2014 quick/.test(ap) && /Off \u2014 infinite/.test(ap));

// ══ §2 behavioral — the REAL physics.js in a vm ════════════════════
section('§2 the walls, behavioral');
const win = {};
win.window = win;
vm.createContext(win);
vm.runInContext(read('physics.js'), win);
const { Entity, World } = win.Physics;

// (1) a fling at the wall reflects, drags, and SETTLES inside.
// (friction math: vx=40 travels Σ40·0.92^i ≈ 500px total — start NEAR
// the wall so the flight actually reaches it)
{
  const w = new World();
  w.setBounds(1000);   // half-extent → world is 2000×2000
  const e = new Entity({ id: 'fling', x: 800, y: 0, radius: 28 });
  e.vx = 40; e.vy = 0;
  w.add(e);
  for (let i = 0; i < 400; i++) w.step(1);
  // the soft wall REFLECTS: the fling hits 972, bounces back with 0.4
  // restitution, and settles INSIDE the edge neighborhood — never past
  // the wall, never bouncing forever.
  ok('the fling settles INSIDE the world (reflected off the edge)', e.x <= 1000 - 28 + 0.001 && e.x >= 700,
    `x=${e.x.toFixed(1)} (edge at ${1000 - 28}, reflected)`);
  ok('the fling comes to REST (soft damped, not bouncing forever)', e.vx === 0 && e.vy === 0,
    `vx=${e.vx} after 400 steps`);
}

// (2) the corner law: both axes clamp independently.
{
  const w = new World();
  w.setBounds(500);
  const e = new Entity({ id: 'corner', x: 0, y: 0, radius: 28 });
  e.vx = 30; e.vy = 30;
  w.add(e);
  for (let i = 0; i < 300; i++) w.step(1);
  ok('the diagonal fling settles inside the CORNER', e.x <= 472.001 && e.y <= 472.001,
    `x=${e.x.toFixed(1)} y=${e.y.toFixed(1)}`);
}

// (3) conform pulls stranded SLEEPERS home (a world shrink).
{
  const w = new World();
  const far = new Entity({ id: 'far', x: 40000, y: 0, radius: 28 });
  w.add(far);
  for (let i = 0; i < 3; i++) w.step(1);
  ok('the stranded icon is asleep at 40000', far._asleep === true);
  w.setBounds(8192);
  w.conform(8192);
  ok('conform snapped the sleeper inside + dirtied the static grid', far.x === 8192 - 28 && w._staticDirty === true,
    `x=${far.x}`);
}

// (4) half=0 keeps the legacy infinite law — the differential twin:
// the SAME fling in a bounded 400-world stops AT its wall (372); the
// unbounded twin flies PAST that point on friction alone.
{
  const mk = () => { const w = new World(); const e = new Entity({ id: 'free', x: 0, y: 0, radius: 28 }); e.vx = 50; w.add(e); return { w, e }; };
  const bounded = mk(); bounded.w.setBounds(400);
  const free = mk();
  for (let i = 0; i < 400; i++) { bounded.w.step(1); free.w.step(1); }
  ok('the bounded twin reflects off its wall (stops inside, short of the free flight)', bounded.e.x <= 372.001 && bounded.e.x < free.e.x - 50,
    `bounded x=${bounded.e.x.toFixed(1)} vs free x=${free.e.x.toFixed(1)}`);
  ok('the unbounded twin flies PAST the wall point (the legacy law)', free.e.x > 372 + 50, `x=${free.e.x.toFixed(1)}`);
}

// (5) the sleep law survives the walls: a settled-at-edge entity rests O(1).
{
  const w = new World();
  w.setBounds(1000);
  const e = new Entity({ id: 'rest', x: 900, y: 0, radius: 28 });
  e.vx = 20; w.add(e);
  for (let i = 0; i < 200; i++) w.step(1);
  ok('the edge-settled entity sleeps', e._asleep === true);
  let rebuilds = 0;
  const orig = w._ensureStaticGrid.bind(w);
  w._ensureStaticGrid = (cell) => { rebuilds++; orig(cell); };
  for (let i = 0; i < 50; i++) w.step(1);
  ok('the resting edge world stays O(1) (zero rebuilds)', rebuilds === 0);
}

console.log(`\n${'═'.repeat(40)}\nv1423 edge rig: ${n - fails.length}/${n} — ${fails.length ? 'FAILURES: ' + fails.join(' · ') : 'ALL GREEN'}`);
process.exit(fails.length ? 1 : 0);
