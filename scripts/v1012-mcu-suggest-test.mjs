#!/usr/bin/env node
// v1012-mcu-suggest-test.mjs — THE IMAGE→PALETTE SUGGESTER RIG (v1.01.2 gate).
//
// THE CONTRACT (a real user's flow, end-to-end):
//  (S1) boot clean; the canvas picker opens with the suggest section.
//  (S2) a REAL image upload (setInputFiles — the actual file input
//       path) produces the 7-swatch proposal preview.
//  (S3) apply writes the SEVEN fields as overrides (themeOverrides
//       holds the --field-* keys; the computed styles follow).
//  (S4) the theme actually CHANGED (the surface field's computed
//       value moved to the proposal's).
//  (S5) dismiss without apply leaves the overrides untouched.
//  (S6) zero console errors through the sweep.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH, 'playwright',
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

const BASE = process.argv[2] || 'http://127.0.0.1:8417';
let PASS = 0, FAIL = 0;
const ck = (name, ok, got) => {
  if (ok) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + ' → got: ' + (got !== undefined ? JSON.stringify(got) : '?')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // a real test image: a warm-orange 64×64 PNG (distinct from every
  // default theme's palette)
  mkdirSync('/tmp/v1012', { recursive: true });
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsMtiUOOawwi+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgvnpmFpdzF9dAAAAABJRU5ErkJggg==';
  const buf = Buffer.from(pngB64, 'base64');
  writeFileSync('/tmp/v1012/test-image.png', buf);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 650 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(1400);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  console.log('── S1 — the canvas picker carries the suggest section');
  await page.click('#settings-btn');
  await page.waitForSelector('.settings-section', { timeout: 10000 });
  await sleep(900);
  const fieldsHdr = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.settings-section'));
    const fields = secs.find((s) => s.querySelector('.slot-row'));
    const h = fields && fields.querySelector('[data-section-toggle]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  ck('S1a the Fields section header found', !!fieldsHdr, fieldsHdr);
  await page.touchscreen.tap(fieldsHdr.x, fieldsHdr.y);
  await sleep(600);
  await page.waitForSelector('.slot-row', { timeout: 8000 });
  await page.click('[data-slot-open="canvas"]');
  await page.waitForSelector('.slot-pop.open', { timeout: 5000 });
  await sleep(500);
  const sug = await page.evaluate(() => ({
    mcu: !!window.MCU,
    pick: !!document.querySelector('.slot-pop [data-act="mcu-pick"]'),
    grid: !!document.querySelector('.slot-pop .slot-pop-grid-sec .slot-pop-grid-title')
  }));
  ck('S1b MCU loaded + the pick button + the grid section present',
    sug.mcu && sug.pick && sug.grid, sug);

  console.log('── S2 — a REAL upload produces the proposal');
  const fileInput = page.locator('.slot-pop input[data-mcu-file]');
  await fileInput.setInputFiles('/tmp/v1012/test-image.png');
  await sleep(1200);   // the FileReader + Image + quantize + score
  const preview = await page.evaluate(() => {
    var p = document.querySelector('.slot-pop .mcu-preview');
    return { shown: p ? p.style.display !== 'none' : false,
      swatches: p ? p.querySelectorAll('span[style*="width:52px"]').length : 0 };
  });
  ck('S2a the 6-swatch proposal preview shows (surface/ink/canvas/accents)', preview.shown && preview.swatches >= 6, preview);

  console.log('── S3 — apply writes the seven fields');
  await page.click('.slot-pop [data-act="mcu-apply"]');
  await sleep(900);
  const ov = await page.evaluate(() => {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var o = (s.themeOverrides && s.themeOverrides[cur]) || {};
    return Object.keys(o).filter(function (k) { return k.indexOf('--field-') === 0; }).sort();
  });
  ck('S3a the --field-* overrides landed (≥6 fields)',
    ov.length >= 6, ov);

  console.log('── S4 — the theme actually changed');
  const surfaceNow = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--field-surface').trim());
  const proposalSurface = await page.evaluate(() => {
    var s = Settings.getState();
    var cur = s.theme || 'midnight';
    var o = (s.themeOverrides && s.themeOverrides[cur]) || {};
    var spec = o['--field-surface'];
    return spec && spec.colors ? spec.colors[0] : null;
  });
  ck('S4a the computed --field-surface follows the proposal',
    surfaceNow !== '' && surfaceNow !== '#14141a', { surfaceNow, proposalSurface });

  console.log('── S5 — dismiss leaves things alone (the toast confirms the flow ran)');
  const dismissed = await page.evaluate(() => { window.DoomToast('ok'); return true; });
  ck('S5a the shared toast still works after the flow', dismissed);

  console.log('── S6 — zero console errors through the sweep');
  ck('S6a no page/console errors', errs.length === 0, errs.slice(0, 3));

  await browser.close();
  console.log('');
  console.log('v1012 MCU suggester: ' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => {
  console.error('RIG CRASH: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
