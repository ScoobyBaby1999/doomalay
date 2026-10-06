# PLAN-V110 — THE WEIGHTLESS WAVE

> The user's report (v1.09.0 post-ship), verbatim intent:
> 1. "the panel still feels a bit low frame rate when the text is set to doom
>    projection with two or more colors set, but its the panel movement as it
>    slides between anchor positions, that's all, within the panel it feels
>    smooth."
> 2. "we also have a small issue where the surface color variable, while
>    solid, does not fill the panel as if it where fully docked in the full
>    scree position, instead, it tries recalculates to fit whatever position
>    the panel is docked at after the panel snaps to position, causin the ink
>    color below it to leak.. we can just project as a full screen panel if
>    it makes it easier. whichever is most performant."
> 3. "the canvas feels smooth while scrollin, but zoomin can use some more
>    fixes to make it feel more smooth, currently zoomin doesnt feel smooth,
>    altho we dont have the same issue as we did before where the stars and
>    lines snap around as they recalculate their positions. if everythin is
>    already pre-baked, the entire canvas, then zoomin should just be the
>    parralax movements which should be nothin computation wise."
> 4. "we have too much shootin stars, and all of them come at the same size
>    as distance, we want shootin stars to be much, much rarer, comin at
>    different shapes or distances"

## §0 THE RECON (done — the facts the phases ride)

- **The glide (1)**: the anchor slide is the settle spring (gesture.js
  springY → renderY per frame = writeY + writeVis). Per frame, with the
  projection ON, three per-frame inherited-var writes sweep the ENTIRE
  #chat-panel subtree's computed styles:
  (a) `--panel-vis-h` inline on the root (writeVis — the projection-only
  opt-in tax, gesture.js v1.05.1 note);
  (b) `--proj-tx/--proj-ty` CSSOM rule writes (motionTick → setVars per
  root per frame);
  and the scroller clamp during a shrinking slide fires scrollRebake
  per frame (scroll anchoring re-clamps scrollTop as .panel-body's height
  shrinks) — one rule patch/write per painted window per frame.
  The v1.08.5 COAST stopped the JS from WRITING text windows during
  motion — but the L2 layers' transform compensation still consumes the
  per-frame vars (by design: compositor-only, zero repaint — yet the
  invalidation SWEEP is the cost: every inherited custom-prop change
  re-walks the whole transcript's computed styles), and ANY mid-glide
  paint() (a class flip, an async UI write — anything the 200ms gesture
  gate classifies as `full`) UN-COASTS the text back to var form and
  re-arms the per-frame glyph-raster leg mid-glide. The fmt gate only
  bakes text when the slot paints a REAL gradient (formatter.js: one
  color → grad 'none' → no [data-fmt-grad] → no bakes) — exactly the
  user's "two or more colors" trigger.
- **The surface (2)**: the field vars (--panel-field-h/--panel-head-off/
  --panel-field-top) sync at every REST write to the CURRENT dock's
  window (syncFieldVars measures bodyH = the current vis window). The
  gradient re-fits per dock (the "recalculates to fit" report), and in
  every window where the synced extent is stale or smaller than the
  current window, the no-repeat image ends above the box's bottom — the
  band below shows the box's own color/what's behind it (the "ink leak").
  The user prescribes the fix: size the field as if the panel were FULL
  SCREEN, always — which is also the performant shape (the field becomes
  a per-open constant; per-dock re-syncs die; the extent can never be
  smaller than any window, so the gap is geometrically impossible).
- **The zoom (3)**: the tile lattice bakes are level-quantized (1.25×,
  v1.06.1) with a 150ms debounce armed at the FIRST level mismatch. A
  continuous pinch CROSSES levels: each crossing re-arms a bake that
  lands MID-GESTURE — the bake runs synchronously in the worker (same
  thread as the frame painter) and the set swap uploads the new tile
  bitmaps on the first fill — a hitch every ~1.25× of zoom. Pan never
  triggers any of this (the fingerprint is zoom-stable) — exactly the
  smooth-pan/janky-zoom asymmetry. The mid-gesture stretch is already
  EXACT by world-proportionality (only sharpness rides the level), so
  deferring bakes to gesture-settle is visually free — and it is the
  map-library standard (Leaflet updates grid layers at integer zooms and
  re-renders at gesture end, not per frame).
- **The shooting stars (4)**: lattice.js stepComets spawns a comet every
  4-10s (cap 3 concurrent) with near-uniform stats (tail 90-160px, head
  r 1.6-2.6, 900-1600 px/s, ttl 0.4-0.9s). The user wants MUCH rarer and
  a real spread of sizes/distances/shapes.
- RESEARCH (tool-results/v110-r*.json + docs/RESEARCH-V109): no new
  library shapes any of this — the map-standard deferred-rebake pattern,
  the invalidation-sweep literature (MDN perf fundamentals; the
  web.dev/@property invalidation model gesture.js already cites), and
  the v109 verdict (no OSS improves projected text) all point the same
  way: stop paying per-frame main-thread cost during motion; settle once.

## §1 v1.09.1 — THE DRIFT COAST (the glide stops sweeping the tree)

**The principle**: v1.08.5 taught text to coast (ride rigidly, settle
re-anchors). The glide's remaining cost is the per-frame var writes that
keep the L2 layers compensated. Generalize the coast to the WHOLE field:
during a root-motion window, the vars FREEZE (nothing writes them), every
window rides rigidly, ONE settle re-anchors everything. The glide becomes
transform (compositor) + the body-window layout — nothing else.

**The edits (doomprojection.js):**
- motionTick: while `coasting`, SKIP the per-root setVars (the vars hold
  their pre-motion rest values; the L2 transforms freeze at rest
  compensation = the rigid ride; identical drift contract to the text
  coast — "a bounded drift from the viewport field"). Keep the
  readMatrix per root (the dirty/non-translate detection) and the
  scroller check.
- setVars gains a same-value guard (no no-op rule writes, no orphan
  invalidations at window edges).
- scrollRebake: early-return while `coasting` (the clamp drift during a
  shrinking slide goes stale by design; the settle true-ups).
- coastText: drop the `__projVisForm` exclusion (visForm windows coast
  too — their vars freeze anyway, constants are strictly safer) and
  extend the constant rewrite to LEGACY non-text windows (the rare
  non-L2 fallback population) — one write per window at the motion edge.
- run(): DEFER full paints while a motion window is open AND the gesture
  stamp is fresh (`movingRoot > 0 && gest-fresh`) — keep `dirty`/
  `movingLayout` pending; the paint fires one frame after the window
  closes (the settle paint already un-coasts + re-anchors + the trailing
  motionTick lands the vars current — the existing line-959 contract).
  This closes the mid-glide un-coast hole (a class flip or async write
  mid-glide no longer re-arms the per-frame glyph rasters).
- paint() itself is UNCHANGED at entry (un-coast) — the settle semantics
  stay exactly the v1.08.5 shape.

**WILL NOT:** touch the L2 mint geometry, the DOOM SHEET, the bake
decision, the --panel-vis-h write (it stays live — its consumers are
coasted constants now; freezing it crosses var-ownership between
gesture.js and the painter for at most a handful of ms — the rig will
say if sweep #1 still shows; that would be a v1.10.x follow-up, not this
wave), or the scroll coast's newcomer bakes (first sight still bakes).

**The proof (§A of the rig):** a scripted anchor slide with a long
2+-color fmt transcript under the gate: (a) the root's --proj-ty computed
value FROZEN across glide frames (sampled per rAF); (b) ZERO
background-position/style mutations on transcript windows during the
glide (in-page MutationObserver); (c) mid-glide class flips do NOT
produce paints until settle (stats.paints flat during the glide + the
deferred bump after); (d) the settle re-anchors (the var-form positions
return, L2 rules patched); (e) projection OFF byte-identical glide.

## §2 v1.09.2 — THE FULLSCREEN FIELD (the surface stops re-fitting)

**The edit (gesture.js syncFieldVars):** `--panel-field-h` becomes the
FULLSCREEN extent — `fieldTop + (H - chromeH)` — instead of the current
dock's bodyH. The header offsets (--panel-head-off/--panel-field-top)
are chrome facts and stay as-is.

- The gradient stops sit at the full-dock scale at EVERY dock: sliding
  between anchors REVEALS more/less of one field instead of re-fitting
  it (the user's "fill the panel as if it were fully docked in the full
  screen position").
- The extent is ≥ every possible window at every dock — the no-repeat
  gap below the image (the ink leak) is geometrically impossible, stale
  sync or not.
- The 190ms debounced sync survives but only lands when chrome/viewport
  facts change (open, resize, .panel-full padding) — per-dock re-syncs
  die (the performant shape the user asked for: fewer measured writes,
  and the field never re-rasters per dock).

**WILL NOT:** touch the Layer-1 rules (index.html), the visForm window
math (--panel-vis-h is the live window, unchanged), or the fallback
forms (vars unset = the exact pre-sync look).

**The proof (§B):** gradient surface: --panel-field-h IDENTICAL at peek/
half/full docks (var probe) + the pixel seam probe (header bottom hue ≈
body top hue, the v098 pattern) still green at every dock + a screenshot
sweep (peek/half/full) shows one continuous field with no bottom band;
solid surface: no regression (the color paint path is image-independent);
a stale-sync simulation (dock flip inside the 190ms window) shows NO gap.

## §3 v1.09.3 — THE STILL HAND (zoom recomputes nothing mid-gesture)

**The principle**: the user's model is already the architecture — the
tiles are pre-baked bitmaps; a zoom frame is pattern fills. The one
remaining mid-gesture cost is the LADDER: level-crossing bakes landing
inside the gesture (worker-blocking bake + a texture-upload burst at the
set swap). Hold the ladder while a zoom gesture is live; land ONE bake at
settle. The mid-gesture stretch is exact by world-proportionality (the
v0.98 law) — transiently softer past ±1.12×, sharp the moment the bake
lands (the Leaflet contract: update grid layers at gesture end).

**The edits:**
- app.js: a zoom-gesture flag — `pinching` (exists) or a wheel stamp
  (`lastWheelAt`, set in the wheel handler; fresh for 200ms). The frame
  message carries `zg: zoomHold() ? 1 : 0`; the release frame (the first
  frame with zg=0) lets the painter arm the bake.
- gridworker.js paintFrame: `Lattice.setZoomHold(!!m.zg)` before render.
- lattice.js: `Z_HOLD` flag + exported setZoomHold; tlBakeTiles: while
  held, a fingerprint mismatch keeps the STRETCHED current set and does
  NOT arm the bake timer (wantFp/pend payload still refresh); the first
  un-held frame arms it (the 150ms debounce → the bake lands ~150ms
  after settle → the existing repaint-wanted → schedulePostBakeFrame
  lands the fresh tiles). Boot parity unchanged (the first set still
  bakes synchronously).
- Main mode: app.js calls Lattice.setZoomHold directly around the same
  flag (same semantics).

**WILL NOT:** touch the level quantum, the byte cap, the fingerprints,
the parallax math, or the pinch coalescing.

**The proof (§C):** a scripted CDP pinch crossing ≥2 levels + a wheel
burst: (a) ladderMisses/bakeGen FROZEN during the gesture (the debug
blob's oneObject stats); (b) one bake lands within ~500ms of settle
(bakeGen +1, tileMs recorded); (c) a frame-time sampler during the pinch
shows no per-level hitch (the pre-fix rig shape: a long frame at each
level crossing); (d) pan regression: zoom-stable fingerprints untouched.

## §4 v1.09.4 — THE RARE SKY (shooting stars: scarce and varied)

**The edit (lattice.js stepComets + paintComets):**
- Cadence: spawn interval 4-10s → **18-44s** (`18 + Math.random() * 26`);
  concurrent cap 3 → **2**.
- Size/distance classes (weighted draw per spawn):
  - FAR (60%): r 0.7-1.1, tail 45-90px, 1300-1900 px/s, ttl 0.35-0.6s,
    thin tail (r×0.6), dim head glow, pf hugging the background depth.
  - MID (30%): r 1.4-2.0, tail 110-170px, 800-1200 px/s, ttl 0.5-0.8s.
  - NEAR (10%): r 2.4-3.6, tail 220-340px, 500-850 px/s, ttl 0.7-1.1s,
    thick tail (r×0.9), bright glow, foreground depth.
  - pf (the parallax factor = the depth read) widens per class: far rides
    ~the background rate, near rides visibly foreground — "different
    distances" that the parallax actually shows.
- The debug blob's live stats gain the last spawn's class/shape (the
  instrument the rig asserts against — no behavior change).
- The header comments (the v0.77/v1.06.3 numbers) update to the new law.

**WILL NOT:** touch the spawn edges, the aim logic, the gate (both
animate toggles off = no movers), or the twinklers.

**The proof (§D):** gate the animates on, sample ~45s: the first spawn
≥ ~14s (vs 4s pre), spawn count ≪ pre, and the observed r/len/spd values
span the three classes (no clustering at the old uniform ranges).

## §5 SHIP v1.10.0 — THE WEIGHTLESS WAVE

- the v110 rig (new, permanent — §A/§B/§C/§D) + the full battery:
  v109 30/30 · v107 22/22 · v106 21/21 · v1045 11/11 · v1040 7/7 ·
  uikit 140 · twins · go test rides CI;
- the REBASE PROTOCOL: fetch origin (the parallel bot), diff, merge,
  build — rebase-before-push, amicably;
- buildinfo 1.10.0 → tag v1.10.0-the-weightless-wave → release (CI APK)
  → CI green → worklog + MEMORY.md.

## §6 THE SPAGHETTI BOUNDARY (will NOT)

- no projection-mode additions, no per-element opt-out config, no new
  gate laws — the coast generalizes INSIDE the existing derivation;
- no rewrite of the spring/rise/drag state machine — the glide fix is
  the painter's write diet, not a new motion system;
- no --panel-vis-h ownership transfer in this wave (a measured follow-up
  only if the rig shows sweep #1 still hot);
- no zoom-camera re-architecture (no transform-scale-the-canvas trick —
  the pattern-fill path IS the compositor-clean shape once the ladder
  holds);
- no comet re-spec beyond the cadence/classes (no new mover types, no
  trail particles — the shuttle/twinklers stay untouched);
- if the drift coast needs anything deeper than the gates listed in §1,
  it stops there.
