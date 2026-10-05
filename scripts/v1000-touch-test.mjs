#!/usr/bin/env node
// v1000-touch-test.mjs — THE REAL-TOUCH RIG (v1.00.1 gate, the class-
// death proof).
//
// WHY THIS RIG EXISTS: every previous overlay bug (#sheet-root class,
// six recurrences) was invisible to mouse-driven rigs — canceling
// touchstart suppresses the synthetic click (W3C Touch Events L2 §9),
// but mouse clicks fire regardless of touchstart preventDefault, so
// Playwright's click() is structurally blind to the class (the
// maintainers' own note, microsoft/playwright#2903). This rig uses
// REAL trusted touches: hasTouch:true context + tap() (CDP
// Input.dispatchTouchEvent through Chromium's input pipeline) + raw
// CDP touch sequences for the drag cases.
//
// THE CONTRACT (the positive-list canvas gate):
//  (T1) a real touch opens settings on the Colors page (7 slot rows).
//  (T2) a real touch on a slot row opens the floating picker.
//  (T3) THE CLASS-DEATH PROOF — a real touch INSIDE the popover
//       fires the click (a gradient stop is added) and the touchstart
//       probe records prevented === false for popover touches.
//       (the click counter rides .slot-pop ITSELF — the rebuild
//       replaces the subtree mid-dispatch and a detached target's
//       bubble dies before document: measured btn:1, pop:1, doc:0.)
//  (T4) the ✕ closes on tap. (T5) an outside-tap (the Theme section
//       header — NOT the drag handle, whose touchstart preventDefault
//       eats its own clicks BY DESIGN) closes it.
//  (T6) canvas pan STILL WORKS on touch: a real touch fling on the
//       panel handle closes the panel, then a CDP touch-drag on #c
//       preventDefaults (the probe) and MOVES a real world icon.
//  (T7) the popover SCROLLS under a touch-drag (touchmove fix).
//  (T8) mouse parity: click opens; wheel over the popover scrolls it
//       (the mouse twin of the same bug).
//  (T9) zero console errors through the whole sweep.
//
// Run via scripts/v1000-touch-tap.sh (engine + this script).
import { createRequire } from 'node:module';

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/home/z/.npm-global/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
    '/home/z/my-project/node_modules/playwright'
  ].filter(Boolean);
  for (const c of candidates) {
    try { const req = createRequire(import.meta.url); return req(c); } catch (e) { /* next */ }
  }
  console.error('FATAL: playwright not found (export PLAYWRIGHT_PATH=<dir with playwright>)');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const BASE = process.argv[2] || 'http://127.0.0.1:8414';
let PASS = 0, FAIL = 0;
const ck = (name, ok, got) => {
  if (ok) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + ' → got: ' + (got !== undefined ? JSON.stringify(got) : '?')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpDrag(client, x0, y0, x1, y1, steps) {
  const n = steps || 8;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: x0, y: y0 }]
  });
  for (let i = 1; i <= n; i++) {
    const x = x0 + (x1 - x0) * (i / n);
    const y = y0 + (y1 - y0) * (i / n);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y }]
    });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
}

// find + expand the section that owns the slot rows (sections boot
// COLLAPSED — .section-inner is visibility:hidden + cv:hidden)
async function expandFields(page) {
  const hdr = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.settings-section'));
    const fields = secs.find((s) => s.querySelector('.slot-row'));
    const h = fields && fields.querySelector('[data-section-toggle]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (hdr) await page.touchscreen.tap(hdr.x, hdr.y);
  await sleep(550);
  return !!hdr;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 650 },   // the real Blackview class
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1400);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(2200);

  // the touchstart probe — registered AFTER app.js's own listener
  // (same node, same phase → registration order → we observe the
  // app's preventDefault decisions)
  await page.evaluate(() => {
    window.__tsProbe = [];
    document.addEventListener('touchstart', function (e) {
      window.__tsProbe.push({
        inPop: !!(e.target.closest && e.target.closest('.slot-pop')),
        onCanvas: e.target.id === 'c' || !!(e.target.closest && e.target.closest('#chatbots')),
        prevented: e.defaultPrevented
      });
    });
  });

  console.log('── T1 — settings opens on a real touch (the Colors page)');
  await page.tap('#settings-btn');
  await page.waitForSelector('.settings-section', { timeout: 10000 });
  await sleep(900);   // let the panel's slide settle BEFORE measuring
  ck('T1a the Fields section header was found', await expandFields(page));
  await page.waitForSelector('.slot-row', { timeout: 8000 });
  const rowCount = await page.$$eval('.slot-row', (els) => els.length);
  ck('T1b the Colors page shows the slot rows', rowCount >= 6, rowCount);

  console.log('── T2 — the Theme Editor opens on tap (v1.03.3+ contract)');
  await page.tap('[data-slot-open="surface"]');
  await page.waitForSelector('.te-page', { timeout: 5000 });
  await sleep(700); // the view mount settle
  ck('T2a .te-page renders after tapping the surface row', true);
  const depth = await page.evaluate(() => (window.Settings.panelOf() && window.Settings.panelOf().viewDepth)
    ? window.Settings.panelOf().viewDepth() : -1);
  ck('T2b the editor rides the view stack (depth ≥ 1)', depth >= 1, depth);

  console.log('── T3 — THE CLASS-DEATH PROOF (taps INSIDE the editor page)');
  // the click counter rides .te-page ITSELF: the stop-grid rebuild
  // replaces the tapped subtree mid-dispatch and a detached target's
  // bubble dies before document
  await page.evaluate(() => {
    window.__popClicks = 0;
    document.querySelector('.te-page').addEventListener('click', function () {
      window.__popClicks++;
    });
  });
  const stops0 = await page.$$eval('.te-page .te-stop', (els) => els.length);
  await page.tap('[data-te-add]');
  await sleep(450);
  const stops1 = await page.$$eval('.te-page .te-stop', (els) => els.length);
  ck('T3a a tap on ＋ adds a gradient stop', stops1 === stops0 + 1, stops0 + '→' + stops1);
  const clicks = await page.evaluate(() => window.__popClicks);
  ck('T3b the synthetic click FIRED inside the editor page', clicks >= 1, clicks);
  const popTouches = await page.evaluate(() => window.__tsProbe.filter((p) =>
    p.inPop || (p.onCanvas === false && !p.prevented)));
  const edTouches = await page.evaluate(() => window.__tsProbe.length);
  const edPrevented = await page.evaluate(() => window.__tsProbe.filter((p) => p.prevented).length);
  ck('T3c editor touchstarts are NOT prevented', edTouches > 0 && edPrevented === 0,
    edTouches + ' touches, ' + edPrevented + ' prevented');

  console.log('── T4 — the ‹ back closes the editor (tap)');
  await page.tap('#panel-view-back');
  await sleep(600);
  const stillThere = await page.$$eval('.te-page', (els) => els.length);
  const rootBack = await page.$$eval('.settings-nav', (els) => els.length);
  ck('T4a back popped the editor view (the Colors root restored)',
    stillThere === 0 && rootBack === 1, 'te-pages=' + stillThere + ' nav=' + rootBack);

  console.log('── T5 — the stashed root is POINTER-INERT under the view');
  await page.tap('[data-slot-open="surface"]');
  await page.waitForSelector('.te-page', { timeout: 5000 });
  await sleep(500);
  // the rows are view-stashed: unreachable by tap (the old
  // outside-tap-close concept is dead with the popover — the VIEW
  // covers the rows; no accidental row interaction is possible)
  const rowsReachable = await page.evaluate(() =>
    !!document.querySelector('[data-slot-open="surface"]'));
  ck('T5a the stashed slot rows are unreachable under the editor view',
    rowsReachable === false, rowsReachable);
  await page.tap('#panel-view-back');
  await sleep(600);

  console.log('── T6 — canvas pan still works on touch (the refactor proof)');
  const client = await ctx.newCDPSession(page);
  // close the full-screen panel first — a REAL touch fling on the
  // handle (the phone user's close), not a scripted panel.close()
  const handle = await page.$eval('#panel-handle', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) };
  });
  // gesture.js decide(): from the full dock a close needs dy > 55% of
  // height (357px) OR a >0.55px/ms fling — a smaller pull just docks
  // at the half position (2 fixed positions). Drag FAR + fast.
  await cdpDrag(client, handle.x, handle.y, handle.x, handle.y + 480, 6);
  await sleep(900);
  const panelCls = await page.$eval('#chat-panel', (el) => el.className);
  ck('T6a the touch fling on the handle closed the panel',
    !/\bopen\b/.test(panelCls), panelCls);
  // a real world icon so the pan has a visible mover (the raw
  // createAt path — no panel, no native-sheet noise)
  const made = await page.evaluate(() => {
    if (window.WebTabs && window.WebTabs.createAt && window.doomalay &&
        window.doomalay.addEntity) {
      const icon = window.WebTabs.createAt(206, 200);
      if (icon) { window.doomalay.addEntity(icon); return true; }
    }
    return false;
  });
  ck('T6b a world icon exists (WebTabs.createAt)', made);
  const rectBefore = await page.evaluate(() => {
    const el = document.querySelector('#chatbots > *');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await cdpDrag(client, 120, 420, 220, 500, 8);   // a finger-drag on the canvas
  const rectAfter = await page.evaluate(() => {
    const el = document.querySelector('#chatbots > *');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const moved = rectBefore && rectAfter &&
    (Math.abs(rectAfter.x - rectBefore.x) + Math.abs(rectAfter.y - rectBefore.y)) > 15;
  ck('T6c the touch-drag PANNED the canvas (the icon moved)', !!moved,
    rectBefore && rectAfter ? { before: rectBefore, after: rectAfter } : 'no icon');
  const canvasTouches = await page.evaluate(() => window.__tsProbe.filter((p) => p.onCanvas));
  ck('T6d canvas touchstarts ARE prevented (the pan path engaged)',
    canvasTouches.length > 0 && canvasTouches.every((p) => p.prevented), canvasTouches);

  console.log('── T7 — the editor page scrolls under a touch-drag');
  await page.tap('#settings-btn');
  await page.waitForSelector('.settings-section', { timeout: 10000 });
  await sleep(900);
  ck('T7a the Fields section re-expanded', await expandFields(page));
  await page.tap('[data-slot-open="canvas"]');
  await page.waitForSelector('.te-page', { timeout: 5000 });
  await sleep(700);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.panel-body');
    return el ? el.scrollHeight - el.clientHeight : -1;
  });
  ck('T7b the canvas editor overflows at a 650px viewport', overflow > 8, overflow);
  const popBox = await page.$eval('.panel-body', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await cdpDrag(client, popBox.x + popBox.w / 2, popBox.y + popBox.h - 40,
    popBox.x + popBox.w / 2, popBox.y + 60, 10);
  const scrolled = await page.$eval('.panel-body', (el) => el.scrollTop);
  ck('T7c the touch-drag scrolled the editor body', scrolled > 10, scrolled);

  console.log('── T8 — mouse parity (the click + wheel twins)');
  await page.tap('#panel-view-back');
  await sleep(600);
  // the CANVAS editor overflows (T7b) — the wheel test needs
  // scrollable content (the surface editor may not overflow)
  await page.click('[data-slot-open="canvas"]');
  await page.waitForSelector('.te-page', { timeout: 5000 });
  ck('T8a a mouse click still opens the editor', true);
  const wheelBox = await page.$eval('.panel-body', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const sc0 = await page.$eval('.panel-body', (el) => el.scrollTop);
  await page.mouse.move(wheelBox.x + wheelBox.w / 2, wheelBox.y + wheelBox.h / 2);
  await page.mouse.wheel(0, 240);
  await sleep(350);
  const sc1 = await page.$eval('.panel-body', (el) => el.scrollTop);
  ck('T8b the wheel over the editor scrolls IT (not the canvas zoom)', sc1 > sc0, sc0 + '→' + sc1);

  console.log('── T9 — zero console errors through the sweep');
  ck('T9a no page/console errors', errs.length === 0, errs.slice(0, 4));

  await browser.close();
  console.log('');
  console.log('v1000 TOUCH RIG: ' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('RIG CRASH: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
