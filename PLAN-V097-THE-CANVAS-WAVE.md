# PLAN-V097 — THE CANVAS WAVE: one-object lattice + C3 split

The user's directive (this wave, in order):
1. **The C3 split** — the panel-open transcript render (the open item from v0.96).
2. **The canvas**: "make every individual dot and line in the grid act as one
   object, or possibly two… bundle them up to as little or an optimal number of
   groups… fake the math, fake the parallax… make them all render as more of a
   static background when it is not." Also: slow everything that moves.
   Evidence: packing/scatter/animation degrades frames fast; spacing the grid
   apart doubles/triples fps → cost is per-cell-per-frame.
3. Redteam the canvas work, then the panel color/gradient audit (next wave).

## Root cause (measured architecture, not vibes)

`lattice.js render()` is immediate-mode Canvas2D: EVERY ambient frame re-walks
every visible cell (~1,100 dots + up to ~2,900 segments at 1080×2400), recom-
putes jitter/size/rotation/color/animation per cell, and re-issues every path
op (bucketed, but still per-element). Cost scales with visible cell count —
exactly the user's "spacing doubles fps" observation. The batcher (v0.85.1)
reduced style switches, not the O(cells) walk + path issue cost.

## The fix — v0.97 THE ONE-OBJECT LATTICE (in lattice.js, both hosts)

**Bake the lattice into per-band tiles; draw each band as ONE pattern fill.**
(Web research verdict 2025-10: Canvas2D `createPattern`+fillRect is the
GPU-backed primitive for repeating cached rasters on Android Skia; no second
WebGL context — Android caps WebGL canvases at 8 and Pixi shares none.)

- **Tile** = `MEGA` grid cells per side (adaptive: `clamp(round(320/spacing),2,12)`
  → 384 CSS px at default 48px grid; ~2.4 MB/tile at DPR 2). One tile per
  (band × kind): kinds = dots-group-A, dots-group-B (checker parity — the
  user's "possibly two"), lines-segments. Over-icons tiles only when
  `amp ≥ 0.5` (existing gate).
- **Geometry**: per-cell hash inputs are tile-local → periodic by construction
  (the "fake": the scatter pattern repeats every MEGA cells — 64+ cells of
  hashed variation per repeat; imperceptible at dot scale).
- **Colors**: solid specs → constant, seamless. Sampler specs (mesh/gradient)
  → sample at a MIRROR-FOLDED tile-local position (triangle wave over the
  tile span): the repeat unit becomes field(t)…field(mirror)… — seamless by
  construction at any sampler period (the sampler already mirror-folds at
  bgView; we fold at tile granularity).
- **Parallax** stays EXACT: band b's fill transform = camera × bandPF(b) —
  each band is one object moving as a whole (5 bands ⇒ 5 fills for lines +
  5×2 for breathing dots; at default amp=0/variation=0: ONE band, 3 fills).
- **Animation = the illusion** (user: "fake it"):
  - The dot sea **breathes**: groups A/B drawn with counter-phase global
    alpha `0.62+0.38·(0.5+0.5·sin(animT))` (and +π) — a slow shimmering
    wave instead of 1,100 per-dot sin()s.
  - **Hero fireflies**: glow-candidate cells (top band, jr ≥ 1.6×base) are
    EXCLUDED from the bake when animDots is on and drawn live per frame
    (pulse radius + tiny orbit + halo sprite), capped. A handful of real
    movers sells the "not static" look.
  - Line shuttle drift: baked static (a random frame of today's motion).
    Full-line mode (no variation/animation) stays IMMEDIATE (≈40 quads,
    ≤2 fills — keeps v0723 source greps + v0831 math + exact full-line look).
- **Zoom**: tiles baked at quantized scaleQ buckets; mid-gesture the pattern
  transform scales (soft), rebake 150ms after settle. **Bake debounce**: a
  params churn (slider drag) renders with the last tiles and rebakes on
  quiet (the worker bakes — main thread never pays it).
- **Stats stay honest** (rig contract): dots/segs = coverage counts
  (tiles drawn × cells per tile), dotStats/weight/glow from bake-time
  bookkeeping, batches = real fills + immediate buckets, paintMs = real.
  `render(ctx, ctx2, W, H, cam, P)` signature untouched; worker contract
  untouched (same file, both hosts).

## The tempo (the user's slow-down ask)

`TEMPO = 0.5` applied at every ambient time base: lattice `animT`, AtomCore
star time (atoms.js:597 + gridworker twins), orbit-star pulse time
(atoms.js:613 + twins). NOT physics, NOT TabGroups ω (rigs pin those;
interaction stays 1:1).

## The cadence gate (the hack the user described first)

When ONLY ambient animation moves (no pan/physics/camera): full lattice
frames at ≥66ms cadence (≈15fps) instead of every rAF; atoms/orbit stars
keep their 60fps cheap frame. The canvas retains the last raster between
lattice frames.

## C3 — the split transcript render (chatpanel.js)

- **Tail window at open**: `renderMessages(messages, from)` renders the last
  `OPEN_TAIL = 30` messages; older history backfills in idle chunks
  (requestIdleCallback fallback setTimeout) of 80 messages, prepended above
  with scrollTop compensation (no visual jump). `state._bfGen` token guards
  re-entrancy (panel re-render cancels in-flight backfill).
- **Replay scroll coalescing**: appendMessage's `scrollBottom` per replay
  event → rAF-coalesced (one forced layout per frame instead of one per
  message during the WS backlog burst). Live streaming untouched.
- Gates: v094 rig open-stress (fps/maxGap), v0783 panel-perf 12/12,
  theme twins 165, uikit 140.

## Verification (the order)

1. New rig `v097-oneobject-test.sh`: batches ≤ 3 at defaults; 5-band +
   mesh + animate worst case fps/paintMs vs v0.96 baseline (expect ≥2×);
   pixel diff vs baseline at rest (default theme: near-zero; the mirror
   fold documented for sampler themes); seam probe (tile boundary pixel
   continuity along a vertical scan); leak guard (10-min soak, tile count
   bounded).
2. Battery: v0851 v0852 v0779 v0811 v0812 v0831 v0882 v0899 v0841 v088
   v092-orbit-rest (+ theme twins / uikit).
3. Device pass via the user's APK/tunnel.

## Deferred (next waves, per the user)

- Panel color/gradient audit: verify every artifact/pill/background renders
  ONLY its own gradient (suspicion: stacked/multi-layer backgrounds where
  overlapping pills pick the wrong layer — the composer-strip finding from
  v0.96 is the first confirmed case).

## The wave's verified numbers (this session, live engine)

### The one-object lattice (v097 oneobject rig: 29/29)

- Ambient worst case (mesh + scatter 80 + variation 100 + parallax 100 +
  both anims, 1080×1920): lattice paintMs **14.0ms → 0.3ms** (headless) and
  **10.2ms → 1.6ms** under 6× CPU throttle; batches **1252 → 22**; with
  the 15fps ambient cadence gate the lattice work per second drops ~25×.
- Pixel parity vs the legacy renderer at rest: **0.00% differing pixels**
  (byte-equal frame) — the bake reproduces the legacy look exactly.
- Pan = transform-only (bakeGen stable); the rebake debounce converges
  (150ms) and the post-bake frame lands the fresh tiles in BOTH painter
  modes (the worker asks via repaint-wanted).
- Fixed on the way (all rig-caught): the self-arming debounce (never
  fired), the hero starvation (all top-band dots minted as heroes at high
  variation → the cap vanished the rest; now HERO_PER_TILE=5 with the
  remainder baked static), the unfloored weight ratio (v0831), the
  renderMessages slice double-offset (the [80..89] hole), and the
  `pjr` rename throw that silently legacied the worker worst case.

### C3 (the v097 rig, C3 leg)

- The fresh open replays 120 messages with ONE rAF-coalesced scroll
  (was 120 forced layouts).
- The RE-open mounts the last 30 rows; the head backfills in idle
  80-message chunks (with a 2s background-tab fallback); jump-to-event /
  find flush the pending head on demand (ensureTranscriptMounted).

### The battery

v097 29/29 · v0851 15/15 (the cache ledger re-pinned to the bake
stability contract — the per-frame cell walk it measured no longer
exists) · v0852 14/14 · v0779 5/6 (the pixel-proof leg fails on PRISTINE
v0.96 too — pre-existing rig rot: it reads #c pixels in worker mode) ·
v0811 8/8 · v0812 7/7 · v0831 13/13 · v0882 10/10 · v0899 12/12 ·
v0841 14/14 · v0901 15/15 · v0902 8/8 · v0903 7/7 · v0783 12/12 ·
v088 10/10 · v092-orbit-rest 13/13 · theme twins 165 · uikit 140.

### The panel gradient audit (v097-panel-grad-audit.sh: 3/3) — the verdict

The user's suspicion is ADJUDICATED: themed boxes paint 5-7-layer
background stacks (the window + plate + ring radius-safe design), but
the VISIBLE top layer is always the element's OWN slot's field — objects
do NOT render other slots' gradients. The artifact mechanism ("pills
and backgrounds overlap and don't know which gradient"): the
UNDER-layers are the slot's solid plate + the BORDER slot's 135° sweep —
when the per-layer window math desyncs mid-transform, they peek at
edges. Zero steady L2 double-paints (own + pseudo never both). The fix
(the plate/ring redesign) is the next wave's work with this evidence.

### Redteam residue (documented)

- The over-icons tiles (#c2) paint full-screen pattern fills per frame —
  bounded by the 40MB/M-shrink memory guard; on-device fill-rate pass
  pending (the tunnel APK).
- The hero cap (40) may cut heroes at deep zoom-out (rare, cosmetic).
