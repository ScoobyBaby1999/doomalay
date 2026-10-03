# PLAN-V094 — THE INTERACTION WAVE (performance, part 3)

> The user's ask (2026-10-02, live report): "we are still lagging… especially
> while at motion. The canvas while still, even with the moving elements, is
> not laggy. Only after I android gesture navigation move does it become
> laggy. Same with the panel — scrolling inside the panel is mostly fine, but
> when the panel itself moves or if we want to interact with it or open it,
> it's immensely laggy… typing in the messagebox feels laggy, especially with
> longer messages… We might need another method — I prefer open source battle
> tested library over home grown methods."
>
> Method (the standing iron rule): hypothesis → read the repo's own research
> → web search → measure → real plan → build in phases → red-team as a real
> user. This doc is the real plan.

## The refined symptom map (all paths, verified)

| Path | Feel | Why |
|---|---|---|
| Canvas STILL (ambient atoms/orbits) | smooth | v0.92 killed idle churn; atoms-only cheap frame |
| Canvas PAN/ZOOM with finger | **laggy** | synchronous full frame per touchmove + projection poke + lattice color re-sample |
| Panel INTERNAL scroll | mostly fine | incremental scrollRebake, no reads; content-visibility |
| Panel DRAG/OPEN/interact | **immensely laggy** | per-frame style-recalc + **raster of every gradient window** (`background-position` writes per motion tick); open = full DOM build + first-bake of every window |
| Typing (longer = worse) | **laggy** | forced sync reflow per keystroke + **one FULL projection paint per keystroke** (MO sees innerHTML + height writes) |
| After Android gesture-nav | laggy | resize → `SEL = null` + full paint + **complete stylesheet re-walk**, unbatched; ACTION_CANCEL → momentum |
| Browser panel (WebView) | smooth | native surface, ambient parked |

## Root causes (verified in code, file:line)

1. **app.js:1474-1491 + 1270** — `touchmove` runs `inputMove → update()`
   SYNCHRONOUSLY per event (non-passive, no rAF coalescing). A 120Hz
   digitizer queues multiple touchmoves per frame → the main thread drains
   and renders ALL of them: physics step + lattice frame + icon transforms
   + `DoomProjection.poke()` each time.
2. **app.js:897 → theme.js:1775 (`poke = mark`)** — every canvas frame marks
   the projection DIRTY → one FULL projection paint per pan frame. STALE
   no-op-in-intent: v0.92.1 evicted `.chatbot` from the root registry
   (theme.js:970-981) — a canvas pan moves NO tracked root. The paint still
   pays `querySelectorAll(SEL ≈ 100+ selectors)` + gBCR per painted window,
   every frame, for nothing.
3. **lattice.js:623-624** — the color fingerprint embeds
   `offsetX.toFixed(2), offsetY.toFixed(2)` → any finger motion wipes
   `dotC/vlineC/hlineC/vsegC/hsegC/dotG` → every visible cell re-samples
   its color (~1,100 dots + up to ~2,900 segments per frame on a
   1080×2400 viewport) on gradient/mesh/pattern themes. The sampler input is
   SCREEN coords (lattice.js:991) → viewport-fixed field → the re-sample is
   semantically "required" by that choice. The param caches already key by
   parallax-space world cell (lattice.js:950-952) — colors can ride the same
   invariance.
4. **chatpanel.js:1334-1343** — per `input` event: `height='auto'` write →
   `scrollHeight` read (forced sync reflow, O(message length)) → height
   write → **MutationObserver sees the style write + `SendMode.sync`'s
   unconditional `innerHTML` rewrite (chatpanel.js:639) → `full = true` →
   one FULL projection paint per keystroke** (theme.js:1586-1607).
5. **theme.js:1156-1380 (the bake)** — painted windows carry
   `background-position: calc(var(--proj-tx) + Bx) …`; motionTick
   (theme.js:1053-1070) writes the vars per frame → style recalc of every
   painted window → **background-position change = repaint + re-raster of
   every gradient window per panel-drag frame** (~100 windows ⇒ the
   "immensely laggy" drag/open). The repo's own research named the endgame:
   "the background on its OWN layer, moved with transform (compositor-only,
   no repaint)" (RESEARCH-V092) — Track 2, still not done.
6. **theme.js:1724** — `resize` → `SEL = null; mark()`: SEL re-collect walks
   EVERY rule of EVERY stylesheet; unbatched (Android inset animations fire
   bursts). SEL only depends on stylesheets, not on viewport size — the
   null-out is unnecessary for pure resizes.
7. **Panel OPEN (panel.js:161-195, chatpanel.js:1052-1075)** — whole chat
   DOM in one innerHTML parse + first-bake of EVERY gradient window
   (2× gCS + 1 gBCR + 3 writes each), including below-the-fold ones (the
   scroll newcomer-bake path already exists, theme.js:1687-1718).

## The library question (answered honestly)

The user asked for battle-tested open source over homegrown. Findings:
- **GSAP 3.13+ is 100% free** (Webflow, Apr 2025) incl. Draggable +
  InertiaPlugin — the canonical vanilla drag/momentum lib. BUT the measured
  bottlenecks are NOT in the drag math: gesture.js is already rAF-batched
  with 2 writes/frame ("exemplary" per the audit). Vendoring GSAP would add
  ~70KB and not remove one raster.
- The battle-tested machinery that DOES apply is the browser's own:
  **rAF-coalesced input** (Chrome's aligned-input guidance — Nolan Lawson /
  developer.chrome.com), **compositor-only transforms** (Chrome rendering
  guidance — what Track 2 rides), and the **worker painter** already
  vendored. Track 2 IS "another method": it retires the homegrown
  per-frame background-position engine in favor of the platform compositor.
- Verdict: no new JS libraries this wave; we replace homegrown per-frame
  work with native compositor/rAF primitives. (If we ever rebuild the panel
  system wholesale, GSAP Draggable+Inertia is the shortlist candidate.)

## The phases (each: build → measure → red-team → push)

### Phase 0 — THE RIG (v094-interaction-profile.py)
Playwright + the committed engine binary, mobile viewport 412×915 DPR 2,
**CDP `Emulation.setCPUThrottlingRate(6)`** (BlackView-class), gradient-mesh
theme + 8 bound chats (reuse the v092-soak world builder). Scenarios, each
10s: canvas pan stress · panel drag stress · typing stress (80 chars) ·
panel open/close ×10 · resize burst ×10. Metrics: fps, frameMs max,
longTasks count/worst, DoomProjection paints/motions, lattice cache
hits/misses. → BASELINE table on v0.93.3 (ecfb5d16).

### Phase 1 — v0.94.1 THE CANVAS INPUT WAVE (root causes 1, 2, 3)
- **A1 rAF coalescing**: `inputMove/inputStart` keep the cheap state math
  (offset/velocity, per-event dt) but defer `update()` to ONE coalesced
  rAF per frame (latest-wins). Pinch path identical. The doc `touchmove`
  handler keeps `preventDefault` per event (scroll must not start).
- **A2 poke retirement**: delete `DoomProjection.poke()` from `update()`
  (app.js:897) — stale since v0.92.1; canvas motion moves no tracked root
  (the tick already stopped painting for motion in v0.78.3 — this is the
  same discipline for the input path). Keep the API for World3D.
- **A3 lattice colors go WORLD-anchored**: sample at parallax-space world
  coords (`x + offsetX*scale*dPF` — the same space the param cache already
  keys on, lattice.js:950-952); drop offsetX/offsetY from `cfpNow`
  (colors NEVER clear on pan); split the color-fingerprint from the param
  fingerprint (zoom keeps colors too — world cells are zoom-stable); cap
  color maps (existing 24576 pattern). Visual: colors belong to world
  locations (same model as the bg tiles + parallax) — identical at rest.
- **A4 momentum ownership**: `tick()` skips the `offsetX += velX` drift
  while `inputState === 'PANNING'` (the finger owns the camera; momentum
  integrates from release) — kills the double-integration.
- Gates: rig pan stress ≥ 2× fps, projPaints/s ≈ 0 during pan; theme-twins
  suite green; visual screenshot diff (at-rest lattice identical).

### Phase 2 — v0.94.2 THE TYPING WAVE (root cause 4)
- **B1 autogrow without the thrash**: cache last content height; read
  `scrollHeight` against the current box FIRST; only do the
  auto→measure→set dance when the height actually changes (growing past
  120px cap or shrinking a line). Steady-state keystrokes: ZERO style
  writes → no MO record → no paint.
- **B2 SendMode.sync no-op guard**: skip the `innerHTML` rewrite when the
  mode+state are unchanged (chatpanel.js:639).
- Gates: typing stress — zero projPaints per keystroke after settle, no
  long tasks; composer behavior identical (grow/shrink/send/queue/stop).

### Phase 3 — v0.94.3 THE PANEL MOTION WAVE (root causes 5, 7 — Track 2)
- **C1 transform-carried gradient layers**: the bake mints a per-element
  generated CSS rule (dedicated stylesheet, no inline style writes —
  nothing for the MO to see):
  `[data-proj="N"]::before { content:''; position:absolute; inset:<border
  compensation>; background-image:<computed>; background-size: vw vh;
  background-position: <Bx> <By>; transform: translate3d(calc(var(--proj-tx,
  0px)), calc(var(--proj-ty, 0px)), 0); will-change: transform; }` +
  `[data-proj="N"] { background-image: none }`.
  Same math as today (the var goes in with the SAME sign — verified:
  field origin = layerLeft + Bx + var = 0), but the per-frame change is a
  **compositor transform**, not a background-position raster.
  motionTick stays (1 gCS + 2 var writes per root). scrollRebake patches
  the rule constants (arithmetic, as today).
- **C2 fallback path**: elements with an existing ::before/::after
  (`getComputedStyle(el, '::before').content` non-none) or exotic
  positioning fall back to TODAY's inline bake — zero-risk rollout, both
  paths coexist.
- **C3 open-cost cut**: viewport-bounded minting at open (skip
  below-the-fold windows — the scroll newcomer-bake mints them lazily);
  the rise transition rides motion()/vars → compositor-only with C1.
- Gates: rig panel drag + open stress ≥ 2×; theme-twins 165 assertions;
  visual screenshots (mono + 3 gradient themes × 3 scroll offsets) pixel-
  audited vs baseline; hub-sheet/tpl-sheet/connect-overlay parity.

### Phase 4 — v0.94.4 THE RESIZE WAVE (root cause 6)
- **D1**: resize → keep SEL (re-collect ONLY on stylesheet mutation — the
  injected-styles path already exists, theme.js:1473-1483); debounce the
  re-bake 150ms; ONE settle paint.
- **D2**: app.js canvas bitmap resize debounced the same way (app.js:1929).
- Gates: resize burst = 1 paint + 1 SEL walk total; canvas parity after
  rotation-ish resizes.

### Phase 5 — SHIP
- Engine version bumps per phase (buildinfo.go), binary rebuilt + embed
  parity, go build/vet/test green, brain suites untouched (web-only wave),
  rebase-before-push, tag v0.94.x + release notes with the rig tables.

## Expected end state
Canvas pan/zoom, panel drag/open, typing, and post-gesture-nav resume all
ride compositor-only or coalesced-frame paths; the projection engine's
per-frame raster role is retired (Track 2); every claim is measured before
and after on a 6×-throttled BlackView-class rig. Target: ≥ 2× fps in
every interaction scenario (the user's goal), measured not felt.

## Not doing (documented)
- No GSAP vendoring (measured bottlenecks are raster/paint architecture,
  not drag math — the browser's rAF + compositor ARE the battle-tested
  primitives here).
- No rewrite of gesture.js (already exemplary: rAF-batched, 2 writes/frame).
- No WASM/Rust (v0.91 verdict stands).
- scrollRebake stays arithmetic (scroller vars were tried in v0.78.3c and
  found unsound for flex footers/sticky zones).

## THE RESULTS (measured on the rig, 6x CPU throttle, BlackView class)

| scenario | v0.93.3 baseline | v0.94.0 shipped |
|---|---|---|
| canvas-pan-120hz paints | 479 | **0** |
| canvas-pan cache misses | 946,076 | **662** |
| canvas-pan maxGap | 87ms | 55ms |
| typing-630-chars paints | 436 | **24** |
| typing fps | 36 | **50 (the throttled ceiling)** |
| typing longTasks | 28 | 2 |
| panel-drag maxGap | 247ms | 196ms |
| at-rest visual parity | — | pixel-identical (mean 0.54/255) |

## THE TRACK-2 LEDGER (for the next session — the code is in theme.js, dormant)

Track 2 (the transform-carried gradient layers) is fully implemented in
theme.js's `L2` module (mint/patch/drop/resize + the oversize geometry +
clip-path rounding + the ::before/::after fallback + eligibility) and its
GEOMETRY IS VERIFIED CORRECT (every audited layer's field origin computes
to the viewport origin; an isolated lab renders the exact pseudo geometry
perfectly). It is DORMANT behind `L2_ON = false` because of ONE unresolved
rendering interaction in the live panel: a later sibling element's
oversized layer appears to paint over earlier elements' boxes (the strip
test: a user bubble's accent ends ~90px in and surface-1 colors take
over). With layers active the panel drag hit 28fps / 131 long tasks (vs
17fps dormant / 15fps baseline) — the prize is real. The next session
should DevTools-eyeball the stacking (prime suspects: the clip-path
interaction with the composited oversized pseudo; z-index:-1 between
isolated sibling contexts; the scroller's clipping), fix the interaction,
flip `L2_ON = true`, and re-run `scripts/v094-interaction-profile.py`.

## v0.95.0 — THE TRACK 2 WAVE (the ledger resolved)

### THE "STACKING BUG" — ROOT-CAUSED AND DEAD (2026-10-03)

The v0.94.3 dormancy note above said "a later sibling's oversized layer
paints over earlier elements' boxes." That diagnosis was WRONG. The real
mechanism, caught with a live-page evidence chain (pixel diff → resolved
field origins → pseudo computed styles → winning-declaration walks → a
0.00% isolated lab that proved the geometry perfect → a forced-suppression
experiment):

**THE EPOCH RE-MINT CANNIBALIZED ITSELF.** The first mint is correct
(the snapshot reads a live element). Every epoch bump AFTER (theme flip,
gate-CSS injection → `repaint()`) re-mints from a snapshot taken while
OUR OWN base rule had already suppressed the element's gradient →
`snap.image = 'none'` → the re-mint paints a DEAD layer over a
suppressed element. The elements went see-through, and whatever raw
background sat behind showed up: the panel root's own fixed gradient
(squeezed by its transform — the exact bug the projection system exists
to fix) and the surviving `!important` twins. That composition reads
exactly like a sibling-overrun to a pixel diff.

The four fixes (theme.js, L2 module):
1. **Lift-read-restore** in `L2.snapshot` — for elements already riding
   a layer, the base-rule AND inline suppressions lift for the computed
   read and restore after; CSSOM writes, writeEpoch-stamped, invisible
   to the MutationObserver, zero layout cost.
2. **Base suppression goes `!important`** — the twins carry their own.
3. **The INLINE `!important` suppression** — the gate twins reach
   (0,2,0)+ specificity (`[data-a1-grad] [style*="color:var(--accent)"]`
   on the model pills, `[data-s2-grad] …` on the composer buttons); no
   attribute rule out-specifies an ID-matched twin. The element's inline
   style + `!important` beats every selector at any specificity. Cleared
   on `drop()` and on every legacy fallthrough (4 sites).
4. **`contain: paint` on overflow:visible bases** — the oversized
   pseudo's skirt was (a) extending the transcript scroller 3511 vs
   3029px — a 482px void the auto-scroll drowned in — and (b) turning
   every bubble into a `findScroller()` false positive. Lab: 538→300.
   (overflow:hidden bases deliberately EXCLUDED — see the code comment:
   the paint-containment-implies-layout-containment cost on
   .panel-body regressed open/resize/settle on the rig.)

### Verification (all on the 6× rig, live engine)

- All pseudos alive: 13/13 at rest, **17/17 through a live theme flip**
  (the re-mint case that used to kill them).
- Every own background suppressed (0 unsuppressed, was 6/12).
- Scroller parity restored (3312 = 3312 with identical traversal).
- Header band parity 2.4–3.7% (antialiasing noise). Transcript ±1/255.
- The composer strip delta that REMAINS is Track 2 being MORE correct
  than the shipped reference: those elements keep the twins'
  `background-attachment: fixed !important`, which defeated the LEGACY
  path's plain inline `attachment: scroll` write — the legacy rendering
  of them was already broken (fixed-under-transform). The layers render
  the true viewport windows.
- `L2_ON = (window.__doomalayL2 !== false)` — the answer to "why does the
  variable exist": it is now the runtime kill-switch / device-class
  escape hatch (oversized composited layers cost GPU memory on
  low-memory WebViews). Default ON.

### The wave's numbers (6× CPU throttle, BlackView class)

| scenario | L2 off (this build) | L2 on (this build) |
|---|---|---|
| panel-drag paints / 4.6s | 72–108 | **4–12** |
| panel-drag fps | 15–16 | **19** |
| typing paints | 24–25 | 22–26 |
| canvas pan | 0 paints both | 0 paints |

### The rest of the wave

- **D1/D2 resize**: SEL survives resizes (stylesheet-derived only);
  the re-bake + `L2.resizeAll` + the canvas bitmap realloc debounce
  150ms; the boot resize stays synchronous.
- **F2 spatial hash**: the O(n²) physics scan is retired — uniform grid
  broadphase (the same one Matter.js/planck use, hand-rolled), rebuilt
  per substep, half-neighborhood pair walk. 400 entities step in
  **0.15ms** (~30–60× the old cost at that count) — the complexity
  headroom the "much more complex canvas" needs.
- **F3 time-scaled integration**: `step(dtFrames)` with ≤1-frame
  substeps (no tunneling); at 60Hz byte-identical (verified numerically:
  dt=2 == 2×dt=1 to the last decimal); at 30fps the world decelerates at
  the same rate instead of getting heavier.
- **F6 poller**: webpanel.js's 2s scroll-save `setInterval` replaced with
  real scroll events (500ms debounce, `scrollend`, re-attached per
  same-origin navigation via the iframe `load` event).
- **GSAP verdict** (re-researched at the user's ask): NOT vendored. The
  canvas world renders in a dedicated OffscreenCanvas worker where GSAP
  cannot operate; the DOM-side motion now rides compositor-only
  transforms; the measured bottlenecks (DOM build, style recalc,
  raster) are not drag-math problems. The spatial hash + the compositor
  path ARE the complexity enablement.

### Known residue (next wave, with data)

The panel-open L2 overhead: ~+12% busy time under 6× throttle
(`/home/z/l2dbg/openprofile.py` CPU profile: the eligibility probe 1.8%,
`scrollBottom`/`restoreChatScroll`/`scrollRebake` ≈ 6% — the
scroll-anchoring churn as progressive containment lands mid-rise) and
the transcript DOM build itself (one innerHTML parse of the whole
transcript). The C3 "split the transcript render" remains the open item.
