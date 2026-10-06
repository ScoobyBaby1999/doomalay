# PLAN-V106 — THE FLUID WAVE
## The panel's per-frame cost + the doom projection toggle's stuck state

User report (v1.05.0, two symptoms):
1. "the doom projection toggle sometimes does not toggle back off when it's on
   or doesn't update as it should"
2. "the panel causes lag when it moves … the panel that we use for everything
   else is the source of the lag, especially in motion while it's sliding" —
   while "the browser in browser panel … is silky smooth". Research why; find
   open-source panel libraries for a reusable screen; "even if it's not an
   outright complete change."

---

## §0 THE RESEARCH (done BEFORE this plan — the standing protocol)

Sources (saved to tool-results/v106-research/):
- **viliket/pure-web-bottom-sheet** (MIT, vanilla web component) + the author's
  write-up "Native-like bottom sheets on the web: the power of modern CSS"
  (Oct 2025). THE key quote: *"it is not advisable to animate the element
  height (or any other 'geometric properties') since this causes relayout
  (reflow), which is an expensive operation for the CPU, particularly when the
  affected DOM is large."* Their nested-scroll optimization: switch from
  height animation to **transform-based motion during active scrolling**
  ("runs smoothly on the browser's compositor thread without blocking the
  main thread") — with the footer transforming INDEPENDENTLY to stay glued.
- **web.dev / MDN on @property registration** (Oct 2024): an UNREGISTERED
  custom property is inherited — a value change invalidates computed style
  for the whole receiving subtree; registered `inherits: false` scopes the
  invalidation to the element itself.
- Paul Irish / CSS-Tricks transform-vs-position classics: compositor-carried
  motion vs geometric writes.
- The BIB comparison the user drew: PanelBrowserSheet.kt is a NATIVE Android
  sheet — its smoothness comes from skipping the WebView pipeline entirely.
  It is the wrong benchmark for the WebView panel; the right benchmark is
  "transform-only motion inside the WebView."

### The diagnosis (why OUR panel lags)

gesture.js's v0.42 always-tall model drives every motion frame with TWO writes
on `#chat-panel` (renderY → writeY + writeVis):
1. `style.transform = translate3d(...)` — compositor-only. CHEAP. ✓
2. `style.setProperty('--panel-vis-h', …)` — **THE LAG**:
   - `.panel-body { height: var(--panel-vis-h, 62dvh) }` (index.html:1051) is
     its only layout consumer → the scroller's box resizes EVERY FRAME.
   - The var is UNREGISTERED + INHERITED → every frame's write marks the whole
     `#chat-panel` subtree (handle + header + the FULL chat transcript with
     markdown/prism DOM — often thousands of nodes) for style recalc, then
     layout dirties the sticky composer (`#chat-inputbar` is
     `position:sticky;bottom:0` INSIDE the scroller) + bottom-anchored bits.
   - Style-recalc(whole panel subtree) + layout(scroller+sticky) + paint, at
     60–120 Hz, on a phone WebView = the slide lag. The drag smoothing loop
     and both springs all pay it.
   - With the doom projection ON, every frame's write also walks the
     projection observer → motion() → readMatrix (a getComputedStyle — a
     style flush) + CSSOM var writes for every L2 window. Real, but SECONDARY.

### The library verdict (user asked; honest answer)

- **pure-web-bottom-sheet** — MIT, vanilla, snap points + nested scroll via
  CSS scroll snap + scroll-driven animations. The only credible vanilla
  candidate. NOT adopted wholesale: adopting it means re-hosting the entire
  Panel (chat + settings + the view stack + the duck dock + the scroll-chain
  hijack + the projection's transformed-root tracking) inside a shadow-DOM
  scrolling track — the exact "adding too much / spaghettifying" the user
  capped. What we ADOPT: its discipline (transform-only during motion; zero
  geometric writes per frame; bottom chrome rides transforms, not resizes).
- React-native-era libs (vaul, react-spring-bottom-sheet, gorhom) — need
  React; the engine UI is vanilla. N/A.
- Native BottomSheetBehavior — already shipped as the BIB (PanelBrowserSheet).
- CONSEQUENCE: keep the homegrown engine; fix the per-frame cost; document
  the constant-height + transformed-composer architecture (the library's
  model) as the escape hatch if measurements fall short.

---

## §1 v1.05.1 — THE GLASS WINDOW (the per-frame cost)

**Goal: during ANY motion frame, the only writes are the transform + ONE
element-scoped style write; the panel subtree never recalc-sweeps.**

1. gesture.js `writeVis(y)`:
   - Write `height` DIRECTLY on `.panel-body` (`bodyEl.style.height = px`) —
     element-scoped invalidation; the inherited-var subtree sweep DIES.
   - Write the `--panel-vis-h` var ONLY when the doom projection is enabled
     (`window.DoomProjection && DoomProjection.enabled()`) — its L2 window
     transforms + fmtCalcYVis consume it live; that is the projection's own
     opt-in tax, unchanged.
   - Cache the body element (attach already queries it; hoist the reference
     so writeVis never re-queries).
   - The index.html fallback (`height: var(--panel-vis-h, 62dvh)`) stays as
     the pre-JS/progressive default; the inline height always wins after
     attach.
2. Audit every `writeVis`/`renderY` call site (attach hidden-state, riseTo,
   springY, dragRender, setHeight, resize, remeasure) — all flow through the
   same two functions; no call-site changes expected.
3. `measureChrome()` untouched (not per-frame).

Will-NOT (the spaghetti boundary): no gesture.js rewrite, no library swap,
no content-visibility/virtualization changes to the transcript, no projection
math changes.

## §2 v1.05.2 — THE STUCK SWITCH (the toggle's state machine)

**Root cause class: setEnabled's half-applied states wedge the toggle.**
- Enable path sets `data-doom-proj` + mints the sheet + wires observers
  BEFORE `on = true`; any throw between them leaves VISUALS ON with the
  module believing OFF — and the OFF tap then early-returns
  (`want === on`) forever. "Sometimes does not toggle back off." ✓ matches.
- teardown() has NO stage guards: a throw mid-strip leaves a partial world
  (baked inline styles survive; the sheet survives; observers die) — the
  OFF look is broken until the next successful enable.
- paint()'s drop-loop SKIPS disconnected elements without stripping their
  bakes; the Panel's view-stack stash/restore (panel.js) DETACHES and
  RE-ATTACHES the root DOM — resurrected windows come back baked but OUTSIDE
  the `painted` registry: never re-anchored ("doesn't update as it should")
  and INVISIBLE to teardown (survive the toggle OFF).

Fixes (doomprojection.js only):
1. `setEnabled` — commit-first enable (`on = true` before the risky work) +
   full rollback on throw; the disable path runs teardown REGARDLESS of the
   early-return (self-heal on DOM traces: the attr, the sheets, painted,
   observers); every teardown stage individually guarded.
2. Orphan sweep — teardown also strips `document.querySelectorAll('[data-proj]')`
   (L2) and every `[data-proj-bake]` (NEW: a one-time attribute set at the
   three inline-bake sites, stripped on drop) — registry-INDEPENDENT, so
   resurrected strays die with the toggle.
3. paint()'s drop-loop: disconnected elements get STRIPPED (not skipped).
4. No painter-math changes. No sheet-walk changes.

## §3 v1.05.3 — THE PROOF (the real-user rig; no phase ships unproven)

Playwright rig (engine built + served on :8099, the v30/v31 convention):
1. THE GLIDE: seed a heavy chat (300 messages), open the panel, CDP-drag the
   handle through half↔full + settle springs; sample rAF gaps + long tasks
   BEFORE (parent commit) and AFTER (the fix). Assert: median frame time
   improves materially; zero whole-subtree recalc storms (probe
   PerformanceObserver longtask counts).
2. THE TOGGLE: ON → `html[data-doom-proj]` present, stats().painted > 0;
   OFF → attr gone, `[data-proj]` = 0, `[data-proj-bake]` = 0, the override
   sheet detached, zero inline background-position bakes on windows.
3. THE WEDGE: monkey-patch a throw into paint(), toggle ON, toggle OFF →
   the self-heal must still restore the local light (attr gone + zero bakes).
4. THE RESURRECTION: bake with settings views open, stash/restore through
   pushView/popView, toggle OFF → clean (the orphan sweep proof).
5. THE LOOK: rest-state screenshots before/after (projection OFF and ON)
   pixel-compared — the wave changes MOTION COST, never the look.

## §4 v1.06.0 — THE SHIP (the protocol, verbatim)

1. Rebase per the standing protocol: fetch origin/main, diff vs local, check
   for the parallel bot's movement, merge, resolve amicably.
2. CI: Build Desktop · Build Android APK · Build HF Space green.
3. Tag v1.06.0-the-fluid-wave + release with the APK.

The spaghetti boundary for the whole wave: if §3-1 measurements fall short
of the target (~60fps median on the rig with 300 messages), the NEXT wave
considers the library-grade architecture (constant-height scroller +
transformed composer, the pure-web-bottom-sheet model) as its own plan —
never as a mid-wave patch.
