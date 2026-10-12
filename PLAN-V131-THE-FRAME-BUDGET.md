# PLAN-V131 — THE FRAME BUDGET WAVE

The review of the two doobie-session transcripts (v1.28→v1.30 handoff)
concluded: the shipped perf stack is sound (perfhud, on-demand driver,
GL gate, trim contract, content-visibility, the 180ms trailing throttle,
the breath) and the surviving batch-1 items are real, small, and
renumber to v1.30.x on the v1.30.0 tree — the wave ship is v1.31.0.

The wave's one sentence: **spend the frame budget where the eyes are —
never raster what the user isn't watching, never let a stream fight a
finger, and measure every claim.**

Research (prior session, re-verified): Pixi v8 resolves `antialias` /
`resolution` at `app.init()` only (a change = destroy + re-init — the
"decide before init" shape); Chrome's timer throttling clamps hidden-page
timers (1Hz, then 1/min after 5min) — an app that keeps rendering its own
tickers while hidden fights the OS for nothing; `performance.mark/measure`
is the platform ledger (buffered `'measure'` observer where supported).

---

## 0. THE CENSUS (read in the tree @ a3e91649, v1.30.0)

### F1 — the sprite layer rasterizes blind (pixiworld.js)
- `activate()` (455-516): `var dpr = Math.min(window.devicePixelRatio || 1, 2)`
  (464) and `antialias: true` (471) are UNCONDITIONAL — every device,
  every GPU class, every DPI gets MSAA + the same raster density.
- On the software-GL class the v0.88 gate already refuses to boot the
  layer — but on REAL hardware the two knobs still cost real frame
  budget: MSAA on a full-screen alpha canvas + a 2× resolution on a
  3×/4× DPR phone panel is a per-frame raster tax paid even when the
  frame only nudges two stars.
- Both knobs are **init-time-only** (Pixi v8). The settings change path
  exists (onChange → `evaluate()`, 820-824) but `evaluate()` only
  decides on/off — it cannot re-shape a running context.
- The GL verdict (`glGateVerdict()`, 143) is the classifier the knobs
  should have been reading all along.

### F2 — a stream fights a finger (chatpanel.js × gesture.js)
- `gesture.js writeY` (127-152) stamps `window.__doomalayGestureAt` on
  EVERY motion frame; `writeVis` (198-214) already reads it with a 200ms
  freshness window ("gestFresh") — the projection painter uses the stamp
  to classify its own writes as drag noise.
- `chatpanel.js scheduleUpdate` (5199-5213) — the 180ms trailing
  throttle — knows NOTHING about gestures: an `assistant_delta` burst
  landing mid-glide renders per throttle tick into the same DOM the
  gesture is moving (the stream and the finger compete for the frame
  budget; the spring pays the other's layout).
- `updateMessageEl` renders can also fire synchronously on the first
  event past 180ms — mid-spring, that is the worst possible moment.

### F3 — the panel works while the room is dark (chatpanel.js)
- `ensureActivityWatch` (5354-5378): a 500ms interval runs
  `renderActivity` + `tickThinkingMeta` — DOM writes — for as long as a
  turn streams, REGARDLESS of `document.visibilityState`. A user who
  backgrounds the app mid-turn keeps paying a 2Hz style/layout bill for
  an indicator nobody can see (and Chrome throttles the timer to 1/min
  anyway — the work lands in bursts when it fires at all).
- `app.js` (902) already listens to visibilitychange→visible for the
  trim resume; the panel has no equivalent catch-up: the activity row +
  reasoning stats can sit stale one interval past return.

### F4 — the ledger stops at long tasks (perfhud.js)
- `DoomalayPerf` carries fps/frames/longtasks/paints/cache/nodes — all
  RATES, none of them the pipeline's own latency. There is no answer,
  on the honest instrument, to "how long did that message render take"
  or "what did the formatter cost" — the wave's claims (§2's mask, §3's
  quiet room) need a ledger to be judged on the device, not felt.
- `row()` (177) + `pageRender` (183) + `refreshPage` (227) are the
  ready surface; the longtask observer (50-61) sets the "always-on
  ledger" precedent; `watchers` (65) gates the expensive meters.

---

## 1. v1.30.1 — THE SOFT RASTER (F1)

**Files: settings.js, pixiworld.js, perfhud.js.**

- settings.js `defaultState`:
  - `worldAA: 'auto'` — 'auto' resolves against the GL verdict
    (hardware GL → true, software GL → false — though the gate already
    keeps software off the layer); 'on'/'off' force.
  - `worldDpr: 0` — 0 = the legacy cap (min(dpr, 2)); 1 / 1.5 / 2 / 3 =
    an explicit cap (min(devicePixelRatio, value)).
- pixiworld.js `activate()`: read the two settings + `glGateVerdict()`
  BEFORE `app.init()`; `antialias: resolveAA()`,
  `resolution: Math.min(window.devicePixelRatio || 1, resolveDpr())`.
  Publish the effective pair on `DoomalayPerf.world` + `debugInfo()`
  (gains `aa`, `dpr`).
- pixiworld.js onChange (820-824): a worldAA/worldDpr change while the
  layer is active → `deactivate()` + `evaluate()` — the layer re-inits
  on the next gate pass with the new facts (a ~100ms boot, the same
  cost the auto threshold already accepts). Unchanged values no-op.
- perfhud.js Performance page: two selects beside the worldLayer one
  (the `data-setting-key` pattern, theme vars only) + the world row
  reports `aa on/off · res 2×`.

**Gate**: the layer OFF → the controls render inert with an honest
hint; a forced 'on' AA on software GL is the user's explicit call and
the row says so.

## 2. v1.30.2 — THE GESTURE MASK (F2)

**Files: chatpanel.js. gesture.js is NOT touched (the stamp exists).**

- chatpanel.js, beside scheduleUpdate:
  - `GESTURE_FRESH_MS = 200` (the same window writeVis already uses —
    one gesture definition, not two).
  - `GESTURE_MASK_MAX_MS = 400` — the MAX-DEFER DEADLINE (the review
    correction): a stream that never stops cannot starve the panel
    forever; after 400ms parked, the next tick renders regardless.
- `scheduleUpdate`: an `immediate` call bypasses (as today). A deferred
  call while the gesture is fresh parks via the existing trailing
  timer; the timer's callback re-checks the mask and either re-arms
  (still fresh + under deadline) or renders. The first call's
  synchronous render (past 180ms since the last) is suppressed while
  masked — parked, not dropped.
- THE ERROR BYPASS (the review correction): messages carrying
  `msg._renderNow` skip the mask — the error/terminal paths stamp it
  before scheduling (the user must never watch an error wait on a
  spring). Errors that ride `type: 'error'` / ws_state 'failed' set it;
  normal deltas never do.
- Rest writes flush naturally: the spring's final `renderY(force)` does
  not touch chatpanel, but the parked timer (≤400ms) lands right after
  the settle — one render, one layout, the gesture's budget intact.

**Gate**: the rig proves (behavioral sim + source pins): N deltas during
a fresh stamp → exactly ONE render inside the window + one flush at the
deadline; an `_renderNow` message renders while masked; no parked
update survives past 400ms + one tick.

## 3. v1.30.3 — THE QUIET ROOM (F3)

**Files: chatpanel.js.**

- `ensureActivityWatch`'s 500ms tick: while `document.hidden`, run the
  bookkeeping (the streaming-clear branch MUST keep working — it is how
  the timer dies) and SKIP the DOM work (renderActivity +
  tickThinkingMeta). The interval keeps running — stop/start races are
  the spaghetti this phase refuses.
- One module-level `visibilitychange` listener: → visible while the
  owner streams → ONE immediate renderActivity + tickThinkingMeta pass
  (the indicator catches up the instant the room lights). Listener
  added once, guarded, never per-turn.
- Message renders (scheduleUpdate path) are deliberately NOT hidden-
  gated: they are the persisted transcript (correctness, not cosmetics)
  and hidden renders are near-free (no compositor). The room quiets the
  TICKERS, not the record.

**Gate**: the rig proves the tick skips DOM work while hidden and runs
one catch-up pass on visible; the clear-on-idle branch still fires.

## 4. v1.30.4 — THE LEDGER (F4)

**Files: perfhud.js, chatpanel.js, formatter.js, chatclient.js.**

- perfhud.js: `P.renders / P.renderMsWorst / P.renderMsLast /
  P.fmtMsWorst / P.wsEvents` + `PerfHUD.ledger(kind, ms)` — counters
  are ALWAYS on (the longtask precedent); the `performance.mark/
  measure` API calls fire only while a watcher exists (the timeline
  bonus, not the source of truth).
- Instrumentation (three lines each, guarded for PerfHUD's absence):
  - chatpanel.js `updateMessageEl` → `ledger('render', ms)`.
  - formatter.js `Formatter.renderInto` → `ledger('fmt', ms)`.
  - chatclient.js `onmessage` → the ws counter bump.
- perfhud.js page: two new rows — 'Render ledger' (renders/s · worst
  render ms) and 'Formatter' (worst ms) — riding `row()`/`refreshPage`
  with the value-change gate.

**Gate**: the rig proves the counters move (a fake ledger call path in
vm), the rows render, and the value-change gate holds.

## 5. v1.31.0 — THE SHIP

- buildinfo.go `Version` → `"1.31.0"` + the wave record prepended.
- The rebase protocol BEFORE the push: fetch, diff vs local, merge
  amicably, THEN tag `v1.31.0-the-frame-budget` + push. CI: APK +
  Desktop + HF Space.
- The red-team battery (every phase): `scripts/v1310-framebudget-rig.mjs`
  (the v1300 pattern: parse + source pins + vm behavioral) PLUS the
  real-user walk when a Go toolchain can be provisioned in the sandbox:
  engine booted, agent-browser drives the PWA exactly as a human (open,
  real turn against a stub, drag the panel mid-stream, background the
  tab, return), CDP long-task probes around every phase's claim.

---

## THE WILL-NOT (the spaghetti boundary)

- The paint WORKER is not re-plumbed (the review's verdict: the worker
  fixes responsiveness, not raster fps — the DOM worker cannot help the
  WebGL canvas).
- No worker-side DOMPurify (linkedom/jsdom shim territory — the review's
  correction stands: not plain-safe, not this wave).
- No Vite/embed/cache-header work (OTA-shaped, orthogonal to the frame
  budget).
- No new gesture/event coupling between gesture.js and chatpanel.js
  beyond the existing `__doomalayGestureAt` stamp — the mask reads a
  fact, it does not create a protocol.
- No hidden-gating of the transcript renders (correctness over comfort).
