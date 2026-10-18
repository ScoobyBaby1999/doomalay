#!/usr/bin/env node
// v1310-framebudget-rig.mjs — v1.31.0 THE FRAME BUDGET battery (PLAN-V131).
//
// §1 v1.30.1 THE SOFT RASTER  — the sprite layer's raster knobs become
//    settings (worldAA / worldDpr), decided BEFORE app.init (Pixi v8 is
//    init-time-only on both); a resolved-pair change re-inits the layer;
//    the perf page grows the two controls + the world row reports the pair.
// §2 v1.30.2 THE GESTURE MASK — scheduleUpdate parks while the gesture is
//    fresh, bounded by THE MAX-DEFER DEADLINE (400ms); errors bypass
//    STRUCTURALLY (they append, never ride the throttle). Behavioral:
//    real-timer proofs of park / flush-on-lift / deadline / bypass.
// §3 v1.30.3 THE QUIET ROOM — the activity tick skips DOM work while
//    document.hidden (the timer keeps running; the clear branch lives);
//    one module listener runs the visible catch-up. Behavioral: the tick
//    body + the listener body run against stubs.
// §4 v1.30.4 THE LEDGER — PerfHUD.markStart/ledger/bump; three guarded
//    shells (chatpanel render, formatter fmt, chatclient ws); three page
//    rows. Behavioral: the real perfhud module in a vm — counters move,
//    marks fire only while watched.
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
  else { fails.push(name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n═ ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══ §0 syntax: every touched file parses ═════════════════════════════
section('§0 the touched files parse');
for (const f of ['pixiworld.js', 'settings.js', 'perfhud.js', 'chatpanel.js', 'formatter.js', 'chatclient.js']) {
  try { new Function(read(f)); ok(f + ' parses', true); }
  catch (e) { ok(f + ' parses', false, e.message); }
}

// ══ §1 THE SOFT RASTER — source pins ═════════════════════════════════
section('§1 THE SOFT RASTER — the knobs are decisions');
const sx = read('settings.js');
ok('settings: worldAA defaults to auto', /worldAA: 'auto'/.test(sx));
ok('settings: worldDpr defaults to the legacy cap (0)', /worldDpr: 0/.test(sx));
const px = read('pixiworld.js');
ok('pixiworld: resolveAA exists (the GL verdict is the classifier)', /function resolveAA\(\)/.test(px) && /glGateVerdict\(\)\.software/.test(px));
ok('pixiworld: resolveDpr exists (1..3 explicit, else the legacy 2×)', /function resolveDpr\(\)/.test(px) && /c >= 1 && c <= 3/.test(px));
ok('pixiworld: antialias is RESOLVED (no literal true at init)', /antialias: aa,/.test(px) && !/antialias: true,/.test(px));
ok('pixiworld: dpr = min(device dpr, resolveDpr()) — decide BEFORE init', /Math\.min\(window\.devicePixelRatio \|\| 1, resolveDpr\(\)\)/.test(px));
ok('pixiworld: the resolved pair rides S before app.init', /S\.aa = aa; S\.res = dpr;/.test(px));
ok('pixiworld: an aa/dpr change re-inits (deactivate + evaluate)', /deactivate\(\);\s*\n\s*evaluate\(\);/.test(px));
ok('pixiworld: the re-init is value-change gated (the resolved comparison)', /if \(aa2 !== S\.aa \|\| dpr2 !== S\.res\) \{/.test(px));
ok('pixiworld: the knobs decide BEFORE the worldLayer gate (the walk conviction: worldLayer is defined in every state — a worldLayer-first branch short-circuits the aa/dpr path)', px.indexOf('worldAA') < px.lastIndexOf("typeof st.worldLayer !== 'undefined'"));
ok('pixiworld: debug() publishes the pair', /aa: !!S\.aa, res: S\.res \|\| 0/.test(px));
ok('pixiworld: the perf world row reports aa + resolution', /' · aa ' \+ \(S\.aa \? 'on' : 'off'\) \+ ' · ' \+ S\.res \+ '×'/.test(px));
const phx = read('perfhud.js');
ok('perfhud: the page carries the AA control', /data-setting-key="worldAA"/.test(phx));
ok('perfhud: the page carries the resolution control (number transform)', /data-setting-key="worldDpr" data-setting-transform="number"/.test(phx));

// ══ §2 THE GESTURE MASK — pins + the real-timer behavioral ═══════════
section('§2 THE GESTURE MASK — a stream never fights a finger');
const cp = read('chatpanel.js');
ok('chatpanel: the freshness window matches writeVis (200ms)', /var GESTURE_FRESH_MS = 200;/.test(cp));
ok('chatpanel: THE MAX-DEFER DEADLINE is 400ms', /var GESTURE_MASK_MAX_MS = 400;/.test(cp));
ok('chatpanel: gestureFresh reads the gesture fact gesture.js publishes', /function gestureFresh\(\)[\s\S]{0,200}__doomalayGestureAt/.test(cp));
ok('chatpanel: flushMasked re-arms while masked + under the deadline', /function flushMasked\(/.test(cp) && /GESTURE_MASK_MAX_MS/.test(cp));
ok('chatpanel: immediate calls bypass the mask (as today)', /if \(immediate\) \{ updateMessageEl\(bodyEl, msg, true, ownerState\); return; \}/.test(cp));
ok('gesture.js: the stamp survives untouched (the fact, not a protocol)', /__doomalayGestureAt = performance\.now\(\)/.test(read('gesture.js')));
// the STRUCTURAL bypass: the error branch appends directly — never the throttle
const errBranch = (cp.split("} else if (type === 'error') {")[1] || '').split('syncSendButton(bodyEl, state);')[0];
ok('chatpanel: the error path APPENDS (the structural bypass)', /appendMessage\(msgContainer, scrollEl, emsg/.test(errBranch));
ok('chatpanel: the error path never rides scheduleUpdate', !/scheduleUpdate\(/.test(errBranch));

// ── behavioral: the REAL mask block, real timers ────────────────────
const maskSrc = cp.slice(cp.indexOf('var GESTURE_FRESH_MS = 200;'), cp.indexOf('// ── v0.23 THE ACTIVITY INDICATOR'));
async function maskBehavioral() {
  const renders = [];
  const sandbox = {
    window: {},
    performance,
    Date,
    setTimeout,
    clearTimeout,
    updateMessageEl: (bodyEl, msg, immediate) => renders.push({ at: performance.now(), immediate: !!immediate }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(maskSrc, sandbox);   // defines gestureFresh/flushMasked/scheduleUpdate in place
  const { scheduleUpdate } = sandbox;
  const msg = { text: 'x' };

  // T1 — unmasked = the v0.23 semantics: first call past 180ms renders NOW
  scheduleUpdate('b', msg, false, 's');
  ok('T1 unmasked: the first call renders synchronously (v0.23 semantics)', renders.length === 1 && renders[0].immediate === false);

  // T2 — masked park: fresh stamp → deltas park; the lift flushes ONCE
  const msg2 = { text: 'y' };
  sandbox.window.__doomalayGestureAt = performance.now();   // gesture NOW
  const parkT0 = performance.now();
  for (let i = 0; i < 6; i++) {
    scheduleUpdate('b', msg2, false, 's');
    sandbox.window.__doomalayGestureAt = performance.now(); // the drag keeps moving
    await sleep(40);                                        // ~240ms of drag+stream
  }
  ok('T2 masked: ZERO renders during a fresh 240ms drag', renders.length === 1, 'renders=' + renders.length);
  await sleep(320);                                         // the drag ends; the flush lands
  const t2count = renders.length - 1;
  ok('T2 flushed: exactly ONE render after the lift (parked, not dropped)', t2count === 1, 'count=' + t2count);
  ok('T2 timing: the flush lands after the gesture (never during)', renders[renders.length - 1].at - parkT0 >= 240, (renders[renders.length - 1].at - parkT0).toFixed(0) + 'ms');

  // T3 — the deadline: an ENDLESS fresh stamp cannot starve the panel
  const msg3 = { text: 'z' };
  sandbox.window.__doomalayGestureAt = performance.now();
  const t3T0 = performance.now();
  scheduleUpdate('b', msg3, false, 's');
  const stamper = setInterval(() => { sandbox.window.__doomalayGestureAt = performance.now(); }, 30);
  await sleep(800);                                         // way past the 400ms deadline
  clearInterval(stamper);
  const t3dt = renders[renders.length - 1].at - t3T0;       // WHEN the flush fired
  const t3count = renders.length - 1 - t2count;
  ok('T3 deadline: the parked update renders DESPITE an endless drag', t3count === 1, 'count=' + t3count);
  ok('T3 timing: the deadline holds (400ms park, re-arm granularity)', t3dt >= 380 && t3dt <= 750, t3dt.toFixed(0) + 'ms');

  // T4 — immediate bypasses while masked
  const msg4 = { text: 'i' };
  sandbox.window.__doomalayGestureAt = performance.now();
  scheduleUpdate('b', msg4, true, 's');
  ok('T4 immediate: bypasses the mask', renders.length === 1 + 1 + 1 + 1);

  // T5 — the throttle park (UNMASKED: the stamp is cleared — this tests
  // the v0.23 trailing path, not the mask). The premise: the bubble
  // rendered <180ms ago (the _renderTimer clock a flush just set) — the
  // next call must PARK, then the trail fires once.
  const before5 = renders.length;
  sandbox.window.__doomalayGestureAt = 0;
  msg4._renderTimer = Date.now(); msg4._renderPending = 0;
  scheduleUpdate('b', msg4, false, 's');
  await sleep(60);
  ok('T5 throttle: the call inside the 180ms window parks (no double render)', renders.length === before5);
  await sleep(400);                                         // the trailing flush lands
  ok('T5 trailing: the parked update renders once', renders.length === before5 + 1, 'count=' + (renders.length - before5));
}
await maskBehavioral();

// ══ §3 THE QUIET ROOM — pins + behavioral ════════════════════════════
section('§3 THE QUIET ROOM — the panel sleeps when the room is dark');
ok('chatpanel: the activity tick skips DOM work while hidden', /if \(document\.hidden\) return;/.test(cp));
ok('chatpanel: the tick KEEPS RUNNING (the clear branch survives — no stop/start races)',
  /if \(!state\.isStreaming\) \{\s*\n\s*clearInterval\(state\._actTimer\);/.test(cp));
ok('chatpanel: ONE module listener runs the visible catch-up', /document\.addEventListener\('visibilitychange'[\s\S]{0,600}renderActivity\(currentCtx\.bodyEl, st, false\)/.test(cp));
ok('chatpanel: the catch-up only touches streaming OWNER chats', /st\.isStreaming && isOwner\(st\)/.test(cp));

// behavioral: the tick body runs against stubs
const tickBody = cp.slice(cp.indexOf('state._actTimer = setInterval(function () {') + 'state._actTimer = setInterval(function () {'.length,
  cp.indexOf('}, 500);', cp.indexOf('state._actTimer = setInterval(function () {')));
function runTick(hidden, streaming) {
  let rendered = 0, thought = 0, cleared = 0;
  const state = { isStreaming: streaming, _actTimer: 1 };
  const sb = {
    state, document: { hidden },
    clearInterval: () => { cleared++; },
    hideActivity: () => {},
    currentCtx: { bodyEl: {} },
    isOwner: () => true,
    renderActivity: () => { rendered++; },
    tickThinkingMeta: () => { thought++; },
  };
  sb.currentCtx = sb.currentCtx;
  vm.createContext(sb);
  vm.runInContext('(function () {' + tickBody + '})()', sb);   // the tick body, invoked once
  return { rendered, thought, cleared };
}
const rHidden = runTick(true, true);
ok('T6 the tick: hidden → ZERO DOM work (the room is quiet)', rHidden.rendered === 0 && rHidden.thought === 0, JSON.stringify(rHidden));
const rVisible = runTick(false, true);
ok('T7 the tick: visible → the DOM work runs', rVisible.rendered === 1 && rVisible.thought === 1, JSON.stringify(rVisible));
const rIdle = runTick(false, false);
ok('T8 the tick: the clear branch still fires when the turn ends', rIdle.cleared === 1 && rIdle.rendered === 0, JSON.stringify(rIdle));

// behavioral: the visibilitychange listener body
const qcStart = cp.indexOf("document.addEventListener('visibilitychange', function () {\n    if (document.visibilityState !== 'visible') return;");
const qcBody = cp.slice(qcStart, cp.indexOf('});', qcStart) + 3);
function runCatchup(visibility, streaming, owner) {
  let rendered = 0, thought = 0;
  const sb = {
    document: {
      visibilityState: visibility,
      addEventListener: (_n, fn) => { sb.__fn = fn; },
    },
    chatStates: { a: { isStreaming: streaming } },
    currentCtx: { bodyEl: {} },
    isOwner: () => owner,
    renderActivity: () => { rendered++; },
    tickThinkingMeta: () => { thought++; },
    // v1.39.5 re-point: THE HONEST RETURN's sweep rides the same listener
    // (dead-client revive + resync); the sandbox stubs it — T9-T11 still
    // pin the repaint pass, the sweep has its own walk checks.
    sweepOnRegain: () => {},
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(qcBody, sb);
  sb.__fn();   // fire the listener
  return { rendered, thought };
}
const c9 = runCatchup('visible', true, true);
ok('T9 catch-up: visible + streaming owner → ONE pass', c9.rendered === 1 && c9.thought === 1, JSON.stringify(c9));
const c10 = runCatchup('visible', false, true);
ok('T10 catch-up: idle chats stay asleep', c10.rendered === 0 && c10.thought === 0, JSON.stringify(c10));
const c11 = runCatchup('hidden', true, true);
ok('T11 catch-up: hidden never fires', c11.rendered === 0 && c11.thought === 0, JSON.stringify(c11));

// ══ §4 THE LEDGER — pins + the real perfhud module in a vm ═══════════
section('§4 THE LEDGER — the pipeline measures itself');
ok('perfhud: markStart/ledger/bump exist', /function markStart\(kind\)/.test(phx) && /function ledger\(kind, t0\)/.test(phx) && /function bump\(kind\)/.test(phx));
ok('perfhud: the counters are ALWAYS on (marks are the watched bonus)', /if \(watchers > 0 && performance\.mark\) performance\.mark/.test(phx) && /if \(watchers > 0 && performance\.mark && performance\.measure\)/.test(phx));
ok('chatpanel: the render shell wraps updateMessageEl (try/finally)', /function updateMessageEl\(bodyEl, msg, final, ownerState\) \{[\s\S]{0,400}updateMessageElMeasured\(/.test(cp) && /PH\.ledger\('render', t0\)/.test(cp));
ok('formatter: the fmt shell wraps renderInto', /function renderInto\(el, text, opts\) \{[\s\S]{0,400}renderIntoMeasured\(/.test(read('formatter.js')));
ok('chatclient: the wire counter rides onmessage', /window\.PerfHUD\.bump\('ws'\)/.test(read('chatclient.js')));
ok('perfhud: the three rows render', /'pf-render', 'Render ledger'/.test(phx) && /'pf-fmt', 'Formatter'/.test(phx) && /'pf-ws', 'Wire events'/.test(phx));
ok('perfhud: the sampler computes the render rate', /P\.renderRate = Math\.round\(dr \/ win\);/.test(phx) && /P\.lastRenders = P\.renders;/.test(phx));

// behavioral: the REAL perfhud module, whole, in a vm
function perfBehavioral() {
  const marks = [];
  const docStub = {
    readyState: 'loading',
    addEventListener: () => {},
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } }),
    body: { appendChild: () => {} },
  };
  const sb = {
    document: docStub,
    performance: {
      now: () => performance.now(),
      mark: (name) => { marks.push(name); },
      measure: () => {},
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(phx, sb);
  const HUD = sb.window.PerfHUD;

  // watchers = 0: counters move, marks NEVER fire
  HUD.ledger('render', performance.now() - 7);
  HUD.bump('ws'); HUD.bump('ws');
  ok('T12 the ledger: the counters move while unwatched',
    sb.window.DoomalayPerf.renders === 1 && sb.window.DoomalayPerf.renderMsWorst >= 6 && sb.window.DoomalayPerf.wsEvents === 2,
    JSON.stringify({ r: sb.window.DoomalayPerf.renders, w: sb.window.DoomalayPerf.wsEvents }));
  ok('T13 the ledger: NO marks while unwatched (observer-free pages never pay)', marks.length === 0, JSON.stringify(marks));

  // watchers = 1 (setHud(true)): marks fire
  HUD.setHud(true);
  HUD.markStart('render');
  HUD.ledger('render', performance.now() - 3);
  HUD.setHud(false);
  ok('T14 the ledger: marks fire ONLY while watched', marks.some((m) => m === 'doomalay:render:start') && marks.some((m) => m === 'doomalay:render:end'), JSON.stringify(marks));
  ok('T15 setHud idempotence holds (the v0.88 rig)', sb.window.DoomalayPerf.watchers === 0, 'watchers=' + sb.window.DoomalayPerf.watchers);
}
perfBehavioral();

// ══ THE VERDICT ═══════════════════════════════════════════════════════
console.log('\n────────────────────────────────────────────');
if (fails.length) {
  console.log('FAIL ' + fails.length + '/' + n);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('PASS ' + n + '/' + n + ' — the frame budget battery holds');
}
