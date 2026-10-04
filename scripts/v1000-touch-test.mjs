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

  console.log('── T2 — the popover opens on tap');
  await page.tap('[data-slot-open="surface"]');
  await page.waitForSelector('.slot-pop.open', { timeout: 5000 });
  await sleep(500); // the anchor settle + the open transition
  ck('T2a .slot-pop.open after tapping the surface row',
    await page.$eval('.slot-pop', (el) => el.classList.contains('open')));

  console.log('── T3 — THE CLASS-DEATH PROOF (taps INSIDE the popover)');
  // the click counter rides .slot-pop ITSELF (the singleton): the
  // editor rebuild replaces the tapped subtree mid-dispatch and a
  // detached target's bubble dies before document
  await page.evaluate(() => {
    window.__popClicks = 0;
    document.querySelector('.slot-pop').addEventListener('click', function () {
      window.__popClicks++;
    });
  });
  const stops0 = await page.$$eval('.slot-pop .gr-color', (els) => els.length);
  await page.tap('.slot-pop [data-gr-add]');
  await sleep(450);
  const stops1 = await page.$$eval('.slot-pop .gr-color', (els) => els.length);
  ck('T3a a tap on ＋ color adds a gradient stop', stops1 === stops0 + 1, stops0 + '→' + stops1);
  const clicks = await page.evaluate(() => window.__popClicks);
  ck('T3b the synthetic click FIRED inside the popover', clicks >= 1, clicks);
  const popTouches = await page.evaluate(() => window.__tsProbe.filter((p) => p.inPop));
  ck('T3c popover touchstarts are NOT prevented',
    popTouches.length > 0 && popTouches.every((p) => !p.prevented), popTouches);

  console.log('── T4 — the ✕ closes on tap');
  await page.tap('.slot-pop-close');
  await sleep(350);
  ck('T4a the popover closed via its ✕',
    await page.$eval('.slot-pop', (el) => !el.classList.contains('open')));

  console.log('── T5 — an outside-tap closes the popover');
  await page.tap('[data-slot-open="surface"]');
  await page.waitForSelector('.slot-pop.open', { timeout: 5000 });
  await sleep(450);
  // the OUTSIDE tap: the Theme section header (a plain click zone;
  // the panel HANDLE is a gesture anchor — its touchstart
  // preventDefault eats its own clicks BY DESIGN, so it can never be
  // an outside-tap proof)
  const themeHdr = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.settings-section'));
    const theme = secs.find((s) => !s.querySelector('.slot-row'));
    const h = theme && theme.querySelector('[data-section-toggle]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  ck('T5-setup the Theme section header was found', !!themeHdr, themeHdr);
  await page.touchscreen.tap(themeHdr.x, themeHdr.y);
  await sleep(400);
  ck('T5a a tap outside (the Theme header) closed it',
    await page.$eval('.slot-pop', (el) => !el.classList.contains('open')));

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

  console.log('── T7 — the popover scrolls under a touch-drag');
  await page.tap('#settings-btn');
  await page.waitForSelector('.settings-section', { timeout: 10000 });
  await sleep(900);
  ck('T7a the Fields section re-expanded', await expandFields(page));
  await page.tap('[data-slot-open="canvas"]');
  await page.waitForSelector('.slot-pop.open', { timeout: 5000 });
  await sleep(500);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.slot-pop');
    return el ? el.scrollHeight - el.clientHeight : -1;
  });
  ck('T7b the canvas popover overflows at a 650px viewport', overflow > 8, overflow);
  const popBox = await page.$eval('.slot-pop', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await cdpDrag(client, popBox.x + popBox.w / 2, popBox.y + popBox.h - 40,
    popBox.x + popBox.w / 2, popBox.y + 60, 10);
  const scrolled = await page.$eval('.slot-pop', (el) => el.scrollTop);
  ck('T7c the touch-drag scrolled the popover body', scrolled > 10, scrolled);

  console.log('── T8 — mouse parity (the click + wheel twins)');
  await page.tap('.slot-pop-close');
  await sleep(300);
  // the CANVAS row: its popover overflows (T7b) — the wheel test
  // needs scrollable content (the surface editor never overflows)
  await page.click('[data-slot-open="canvas"]');
  await page.waitForSelector('.slot-pop.open', { timeout: 5000 });
  ck('T8a a mouse click still opens the popover', true);
  const wheelBox = await page.$eval('.slot-pop', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const sc0 = await page.$eval('.slot-pop', (el) => el.scrollTop);
  await page.mouse.move(wheelBox.x + wheelBox.w / 2, wheelBox.y + wheelBox.h / 2);
  await page.mouse.wheel(0, 240);
  await sleep(350);
  const sc1 = await page.$eval('.slot-pop', (el) => el.scrollTop);
  ck('T8b the wheel over the popover scrolls IT (not the canvas zoom)', sc1 > sc0, sc0 + '→' + sc1);

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
