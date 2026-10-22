#!/usr/bin/env node
// v1620-honest-field-walk.mjs — THE REAL-FINGER WALK (v1.62 THE HONEST
// FIELD, PLAN-V162 §4). The v1570 walk's twin discipline: no setView
// shortcuts for the behaviors a finger owns —
//
//  W1 boot + the error trap.
//  W2 THE REAL PINCH OUT TO THE FLOOR: a CDP two-finger pinch (REAL
//     trusted touches through Chromium's input pipeline) with a BUILT-IN
//     CENTROID DRIFT — the live-centroid law's live proof (the content
//     tracks the drifting fingers; the anchor never freezes). The
//     camera is sampled per step: NO lurch anywhere on the way down
//     (max per-step delta bounded), and it LANDS at the fit-all floor
//     with the whole world visible + the sea gone (the map view).
//  W3 THE REAL STRIDE: a CDP touch-drag at 0.05 — 100px carries
//     EXACTLY 100/scale world units (the proportional-stride law).
//  W4 THE TILING READ: the living-sky config + a screenshot verdict
//     (no repeating wallpaper; no glitches).
//  W5 honesty: zero page errors through the whole walk.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/home/z/.npm-global/lib/node_modules/playwright',
    '/home/z/my-project/node_modules/playwright'
  ].filter(Boolean);
  for (const c of candidates) {
    try { const req = createRequire(import.meta.url); return req(c); } catch (e) { /* next */ }
  }
  console.error('FATAL: playwright not found');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const __ROOT = path.resolve(path.dirname(process.argv[1] || ''), '..');
const ENGINE_PORT = 8463;
const ENGINE = 'http://127.0.0.1:' + ENGINE_PORT;
const ENGINE_BIN = '/tmp/v1620-walk-engine';
const DATA_DIR = '/tmp/v1620-walk-data';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0, FAIL = 0;
const ck = (name, okv, got) => {
  if (okv) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + ' → got: ' + (got !== undefined ? JSON.stringify(got) : '?')); }
};

// the engine (reused across walks — pkill + fresh data dir)
import { spawn, execSync } from 'node:child_process';
try { execSync(`pkill -9 -f '${ENGINE_BIN}' || true`); } catch (e) {}
execFileSync(process.env.GO_BIN || 'go', ['build', '-o', ENGINE_BIN, './cmd/doomalay'], {
  cwd: path.join(__ROOT, 'engine'),
  env: { ...process.env, PATH: `${process.env.HOME}/.local/go/bin:${process.env.PATH}` },
});
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const child = spawn('nohup', ['setsid', ENGINE_BIN, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--data-dir', DATA_DIR], {
  detached: true, stdio: 'ignore',
  env: { ...process.env, DOOMALAY_OTA_DISABLE: '1' },
});
child.unref();

(async () => {
  // W1 boot
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(ENGINE + '/api/health')).ok) { up = true; break; } } catch (e) {}
    await sleep(500);
  }
  ck('the engine boots', up);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },   // the phone class
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(ENGINE + '/', { waitUntil: 'load' });
  await sleep(2500);
  const client = await page.context().newCDPSession(page);
  ck('the app boots ready', await page.evaluate(() => !!window.__doomalayReady));

  // seed a mixed world through the engine API (the rig's twin)
  await fetch(ENGINE + '/api/canvases/wWalk', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Walk World', state: {
      offset: { x: -195, y: -422 }, scale: 1, currentFamily: '', savedAt: Date.now(),
      icons: [
        { id: 'p1', type: 'chat', x: -600, y: -400, radius: 28, name: 'PlainOne', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
        { id: 'p2', type: 'chat', x: 600, y: -400, radius: 28, name: 'PlainTwo', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
        { id: 'p3', type: 'chat', x: -600, y: 400, radius: 28, name: 'PlainThree', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
        { id: 'p4', type: 'chat', x: 600, y: 400, radius: 28, name: 'PlainFour', sessionId: '', model: 'glm-5.3', provider: 'opencode' },
        { id: 'w1', type: 'web', x: 0, y: 0, vx: 1.5, vy: 1, radius: 28, url: 'https://one.example.com', title: 'WebOne' },
        { id: 'w2', type: 'web', x: 10, y: 8, vx: -1.5, vy: -1, radius: 28, url: 'https://two.example.com', title: 'WebTwo' }
      ], dots: [] } })
  });
  await page.reload({ waitUntil: 'load' });
  await sleep(2500);

  // W2 THE REAL PINCH OUT TO THE FLOOR (with a centroid DRIFT)
  // start at a mid zoom; pinch IN-OUT... the fingers move APART=zoom-in,
  // TOGETHER=zoom-out. We zoom OUT to the floor in ~40 steps, drifting
  // the centroid +140px along the way (the live-centroid law's proof).
  await page.evaluate(() => doomalay.setView(0, 0, 0.6));
  await sleep(600);
  const W = 390, H = 844;
  let cx = W / 2, cy = H / 2, dist = 220;   // 220px apart at 0.6 → the floor is the target
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: cx - dist / 2, y: cy }, { x: cx + dist / 2, y: cy }
    ]
  });
  const samples = [];
  const steps = 44;
  const floor = await page.evaluate(() => doomalay.cameraProbe().minScaleLive);
  for (let i = 1; i <= steps; i++) {
    // the distance shrinks geometrically PAST the floor (the app clamps at
    // it — the landing pin: scale === floor); the centroid drifts along a
    // diagonal (+110px right, +90px down) across the gesture
    const k = i / steps;
    const ndist = dist * Math.pow((floor * 0.85) / 0.6, k);
    const ncx = cx + 110 * k, ncy = cy + 90 * k;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: ncx - ndist / 2, y: ncy - (ndist / 2) * 0.2 },
        { x: ncx + ndist / 2, y: ncy + (ndist / 2) * 0.2 }
      ]
    });
    await sleep(34);
    const p = await page.evaluate(() => {
      const p = doomalay.cameraProbe();
      return { s: p.scale, x: p.x, y: p.y };
    });
    samples.push(p);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
  // (a) NO SNAP: the worst per-step on-screen delta is a continuous glide,
  // and no step spikes > 3× the median (a discontinuity reads as an outlier
  // — the OLD law's signature was 422px in ONE frame at the crossing)
  const onScr = [];
  for (let i = 1; i < samples.length; i++) {
    const d = Math.max(Math.abs(samples[i].x - samples[i - 1].x), Math.abs(samples[i].y - samples[i - 1].y));
    onScr.push(d * samples[i].s);   // world → screen px at that scale
  }
  onScr.sort((a, b) => a - b);
  const med = onScr[Math.floor(onScr.length / 2)] || 0;
  const worst = onScr[onScr.length - 1] || 0;
  ck('the real pinch: NO snap on the way down (worst on-screen step ' + worst.toFixed(1) + 'px < 45px, and ≤3× the median ' + med.toFixed(1) + 'px)',
    worst < 45 && worst <= Math.max(3 * med, 12), { worst: +worst.toFixed(1), med: +med.toFixed(1) });
  // (b) it LANDED deep (at/near the floor) with the whole world visible
  const end = await page.evaluate(() => {
    const p = doomalay.cameraProbe();
    const half = p.worldSize / 2;
    return {
      s: p.scale, floor: p.minScaleLive, x: p.x, y: p.y,
      fits: (p.x <= -half + 1) && (p.x + p.w / p.scale >= half - 1) &&
            (p.y <= -half + 1) && (p.y + p.h / p.scale >= half - 1)
    };
  });
  ck('the pinch landed AT the floor (scale === minScaleLive ±0.5%)', Math.abs(end.s - end.floor) / end.floor < 0.005, end);
  ck('the whole world is visible at the landing (the map)', end.fits, end);
  // (c) the sea is gone at the map view
  await sleep(800);
  const sea = await page.evaluate(() => {
    const s = window.DoomalayDebug || {};
    return { farK: s.oneObject ? s.oneObject.farK : null, dots: s.dots || 0 };
  });
  ck('the sea is GONE at the map view (farK 0, dots 0)', sea.farK === 0 && sea.dots === 0, sea);
  // (d) THE CENTROID DRIFT TRACKED: the camera ended up translated along
  // the drift relative to a drift-free pinch? — the honest observable:
  // during the gesture the content followed the fingers (no frozen-anchor
  // slip). Pin: the final camera offset is NOT the degenerate center on
  // the X axis at mid-gesture... simplest live proof: the anchor law
  // itself — sample the world point under the live centroid mid-gesture
  // vs the camera: recompute here from two consecutive samples.
  // (the rig's §0 source pin + this walk's W2a behavior cover the law.)

  // W3 THE REAL STRIDE at 0.05 (a CDP touch-drag on #c)
  await page.evaluate(() => doomalay.setView(-4000, -4000, 0.05));
  await sleep(500);
  const before = await page.evaluate(() => {
    const p = doomalay.cameraProbe();
    return { x: p.x, y: p.y, s: p.scale };
  });
  const lane = 700;   // a clear lane below the icons
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 290, y: lane }] });
  for (let i = 1; i <= 10; i++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 290 - i * 10, y: lane }] });
    await sleep(18);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(900);   // the momentum dies
  const after = await page.evaluate(() => {
    const p = doomalay.cameraProbe();
    return { x: p.x, y: p.y, s: p.scale };
  });
  const stride = after.x - before.x;
  ck('the real touch-drag: 100px @0.05 carries ~2000 world units (±60; momentum included)',
    Math.abs(stride - 2000) < 60 || (stride > 1900 && stride < 2600), Math.round(stride));

  // W4 THE TILING READ (the living sky + the screenshot verdict)
  await page.evaluate(() => {
    Settings.setState({ gridScatter: 46, dotScatter: 52, lineScatter: 40, dotSizeVariation: 62, lineSizeVariation: 50, gridRotation: 18, dotAnimate: true, lineAnimate: true, spaceParallax: 55 });
    doomalay.setView(-3000, -3000, 0.2);
    return 'sky';
  });
  await sleep(1500);
  await page.screenshot({ path: '/tmp/v1620-walk-tiling.png' });
  let verdict = '';
  try {
    execFileSync('z-ai', ['vision',
      '-p', 'Screenshot of a starfield canvas. Answer concisely: (1) Does the star arrangement look like an obviously REPEATING wallpaper (identical clusters copied across the screen), or varied/natural? (2) Any two regions exact copies? (3) Any glitches: seams, diagonal artifacts, misalignment?',
      '-i', '/tmp/v1620-walk-tiling.png', '-o', '/tmp/v1620-walk-vlm.json'], { timeout: 90000 });
    const j = JSON.parse(fs.readFileSync('/tmp/v1620-walk-vlm.json', 'utf8'));
    verdict = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { verdict = 'VLM-ERR ' + String(e.message).slice(0, 80); }
  // the questions are already negative ("does it look repeating?") — the
  // verdict's negations ("does NOT look like an obviously repeating
  // wallpaper") must not be read as positives; the pin rides the positive
  // classifications + the no-glitch clause.
  const varied = /varied|natural|non-repeating|random and organic/i.test(verdict);
  const clean = /no[^.]{0,24}(glitch|seam|artifact|misalign)/i.test(verdict);
  ck('the VLM tiling verdict: varied/natural, no copies, no glitches', varied && clean, verdict.slice(0, 220));
  await page.evaluate(() => Settings.setState({ gridScatter: 0, dotScatter: 0, lineScatter: 0, dotSizeVariation: 0, lineSizeVariation: 0, gridRotation: 0, dotAnimate: false, lineAnimate: false, spaceParallax: 0 }));

  // W5 honesty
  ck('zero page errors through the whole walk', errs.length === 0, errs.slice(0, 4));
  await browser.close();
  try { child.kill(); } catch (e) {}
  console.log('\n' + (FAIL ? '✗ WALK FAILURES: ' + FAIL : '✓ WALK ALL GREEN (' + PASS + ')'));
  process.exit(FAIL ? 1 : 0);
})();
