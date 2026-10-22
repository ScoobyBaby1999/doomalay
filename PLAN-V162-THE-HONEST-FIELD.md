# PLAN-V162 — THE HONEST FIELD

The user's ask verbatim (this wave's law):

> "Now let's go back to the canvas please. I did great but it can still be better.
> For starters, when zooming out the entire canvas. The zoom out is so wonky and
> needs complete rework, to a certain extent it's good, then when it goes really
> far out it starts to do some weird thing where the grid seems to go diagonally
> before it snaps back, zooming out very far currently is confusing, as while the
> camera is zooming out it seems to loose protective of the grid or the grid
> seems to move aswell not just the camera. Another issue is that the further the
> user is zoomed out the faster the camera should pan, its very frustrating when
> a user zooms our all the way and still moves as if he is zoomed in close, so
> jumping from one end of the canvas still takes like 10 seconds worth of
> dragging if not more when all it should take is a zoom into the correct
> location, the more the user is zoomed out, the faster the camera should pan
> and it should move the grid further for the same amount of stride. Moreso,
> now that we can zoom out and see the full grid, the tiling is so noticeable.
> Let's instead make the grid consist of less tiles, make each time around x3
> larger and reduce the total quantity, then apply a rigid rotation / flip
> (180,90,-90,-180) to each tile so they appear to look different, we
> strategically make it so that no similar rotation appears either adjacent to
> or next to one another. So that each tile is surrounded by different
> rotations - the rotations don't have to be dynamic or take compute either, we
> can make it deterministic and negligible performance wise. The entire grid
> should consist of like 8 tiles give or take, so the pattern would still be
> visible when the grid is scattered but much less obvious. Also verify we use
> spatial loading, and only render and animate any stars and icons that appear
> on camera. When they are off screen, the frontend should not render any
> elements and should reserve the computer for the backend doing all the actual
> work without the frontend UI."

## §0 THE DIAGNOSIS (file:line receipts)

1. **THE CROSSING LURCH** — `app.js:1449 clampCamera`: the viewport-inside-
   world clamp writes `offsetX ∈ ±(half − vw/2)` (a top-left law, symmetric
   about ZERO — half a viewport of margin on the top/left, half a viewport
   of OVERRUN allowed on the bottom/right), and the degenerate branch
   (`vw ≥ WORLD_SIZE`) writes `offsetX = −vw/2`. At the crossing
   (vw = WORLD_SIZE) the else-range has collapsed to ±0 while the
   degenerate branch demands −vw/2 = −half = **−8,192 world units in ONE
   frame** — a violent half-screen lurch. On a phone (W=390, H=844,
   WORLD=16,384): the Y axis crosses at scale ≈ 0.0515 (lurch #1), the X
   axis at the fit-all floor 0.0238 (lurch #2) — the content jumps
   down-left in two steps: the user's "the grid seems to go diagonally
   before it snaps back". The mid-range drag-in (maxX shrinking) is the
   "the grid seems to move as well not just the camera".
2. **THE STALE PINCH ANCHOR** — `app.js:2370/2386-2391`: `pinchCenter` is
   captured ONCE at gesture start and never follows the live centroid;
   the centroid's drift is silently dropped (no pan component during the
   pinch) — the content slips under the fingers ("it seems to lose
   perspective of the grid").
3. **THE FIXED-SCALE STRIDE** — `app.js:2158-2167`: `offsetX += ddx` adds
   RAW SCREEN PIXELS to a WORLD-UNIT offset (the ICON_DRAG twin at 2170
   already does `dx / scale` correctly). At the fit-all floor
   (scale ≈ 0.024) a 100px stride moves 100 world units = **2.4px on
   screen** — the content crawls; crossing the 16,384 world takes ~10s of
   dragging ("still moves as if he is zoomed in close"). The momentum
   twin (`app.js:2165`, cap `MAX_PAN_VELOCITY=18` screen px/16ms) is also
   fixed-scale.
4. **THE 80-CELL WALLPAPER** — `lattice.js:755 TL_PAIRS = [[10,16],…]`:
   the dot sea's joint period is lcm(10,16) = 80 cells = 3,840px — at the
   fit-all view the whole 16,384 world shows 4.27 × 4.27 ≈ **18 identical
   tile periods** ("the tiling is so noticeable"). One pattern fill per
   (band × kind) repeats the SAME raster everywhere — every instance is
   byte-identical by construction.
5. **THE SEEN-ONLY AUDIT** — icons (`renderIconsCulled`, CULL_PAD 320 +
   THE RIDE), atoms (pad-cull `atoms.js:432`), twinklers (viewport walk
   `lattice.js:1596-1608` + the 16,384-cell ceiling), comets (spawn
   on-screen, cull ±250 `lattice.js:1541`) already cull; the lattice fills
   cover the viewport only; the worker paints off-thread. The wave's job
   is to VERIFY + PIN all of it (the rig census), not rebuild it.

## §1 THE RESEARCH (sourced — the research agent's digest, worklog v1.62.0-research)

- **R1 THE CONTINUOUS CLAMP**: every reference (xyflow getViewportForBounds,
  tldraw zoomToBounds, excalidraw centerScrollOn, pixi-viewport Clamp
  underflow-center) uses ONE always-center formula; the canonical per-axis
  rule in our convention: `vw < WORLD: offset ∈ [−half, half−vw]` (edge
  clamp, closes to the single point −half at the crossing); `vw ≥ WORLD:
  offset = −vw/2` (center; EQUALS −half at the crossing) — continuous by
  construction. Our ±(half−vw/2) top-left law is the odd one out and the
  lurch's root cause.
- **R2 THE LIVE-CENTROID ANCHOR**: pixi-viewport Pinch recomputes the anchor
  at the live two-finger centroid EVERY move (capture the world point under
  it, scale, land it at the current centroid). Our start-frozen centroid is
  the gap; the anchor formula `offset' = offset + A·(1/s₀ − 1/s₁)` is the
  standard (verified algebraically for screen=(world−offset)·scale).
- **R3 THE DE-TILING ROTATIONS**: Wang tiles (procedural non-periodic fields
  from a small tile set) + Latin squares: the cyclic construction
  `(i+2j) mod 4` gives ALL 8 neighbors a different rotation class
  ((i+j) mod 4 fails on the anti-diagonal). Rotation about each instance's
  CENTER keeps the square tiling seamlessly (corners map to corners).
- **R4 THE PROPORTIONAL STRIDE**: the standard is content-tracks-the-finger
  1:1 at any zoom (pixi Drag, Leaflet Map.Drag) — in our pre-scale
  convention: `offset += screenDelta / scale`. The culling standard is the
  pad-AABB against the camera (pixi-cull) — already our shape.

## §2 THE HONEST NUMBERS (the "x3 larger" vs "8 tiles" reconciliation)

- The joint period today: 80 cells (3,840px) → ~18 periods visible at the
  fit-all view of the 16,384 default world.
- THE TARGET: "the entire grid should consist of like 8 tiles give or take"
  → periods per axis = √8 ≈ 2.83 → period = 16,384/2.83 ≈ **5,760px =
  120 cells**. New first-rung pair **[10, 24]** (lcm 120; gcd 2): the
  even-parity layer repeats every 10 cells, odd every 24; joint 120.
- Each instance is then 5,760/3,840 = **1.5× the linear size = 2.25× the
  area** — the honest reading of "around x3 larger": 3× LINEAR (11,520px)
  would leave only ~2 tiles across the whole world, contradicting the
  8-tile ask; 2.25× AREA at exactly 8 tiles is the reconciliation the plan
  pins (recorded honestly for the user).
- THE ROTATIONS: per layer, per instance, `rot = (i + 2·j) mod 4` →
  {0°, 90°, 180°, 270°} (the user's list "180, 90, −90, −180" carries a
  redundancy — −180 ≡ 180 — so the four DISTINCT rigid classes are
  0/90/180/270; recorded honestly) + the mirror flip on the checkerboard
  `flip = ((i+j) mod 2) === 1` (the "flip" reading) — deterministic,
  world-anchored (pan/zoom-stable: each world square keeps its transform
  forever), ~4 bit-ops + 1 save/rotate/restore per instance.
- THE JOINT PERIOD WITH ROTATIONS: the combined field repeats only when
  BOTH layers' rotations align — at Δ=120 cells the B-layer is +90°; the
  true joint repeat lands at 480 cells (23,040px) — BEYOND the whole
  16,384 world: the wallpaper read dies inside one world.
- THE COST: same bake budget class (TL_BUDGET 32MB pins the total; the
  pair only re-splits it: A-tile smaller, B-tile bigger). Paint: per-
  instance drawImage instead of one pattern fill — bounded by a 2,048-
  instance ceiling (past it the instances are <40px and the rotation is
  sub-pixel — the plain pattern fill rides, honestly degraded).

## §3 THE SUB-WAVES

- **v1.62.1 THE CONTINUOUS CLAMP** — `clampCamera` rewritten to the
  canonical law (`offset ∈ [−half, half−vw]`; degenerate `−vw/2` —
  continuous at the crossing, both provably −half) + THE LIVE-CENTROID
  PINCH (the anchor recomputed at the live centroid per move; the
  centroid's drift pans 1:1). All funnel sites (zoomAt, pinch, glide,
  setCamera, applyWorldSize, boot heal) inherit it — zero call-site churn.
- **v1.62.2 THE PROPORTIONAL STRIDE** — the PANNING branch: `ddx = −dx /
  scale`; the momentum cap `MAX_PAN_VELOCITY / scale` (the SCREEN cap
  18px/16ms holds at any zoom); the momentum integration itself unchanged
  (velX is world-units/frame by construction).
- **v1.62.3 THE EIGHT TILES** — `TL_PAIRS[0] = [10, 24]` (the ladder's
  other rungs untouched — the low-memory fallbacks) + `tlFillInstances`
  (the per-instance rotated/mirrored drawImage walk replacing the single
  `tlFill` call; the >2,048-instance ceiling falls back to the plain
  fill) + the bake untouched (rotation is paint-time only; gridworker
  imports lattice.js — both painter modes get it for free).
- **v1.62.4 THE SEEN ONLY** — the audit pins: the cull census probe (the
  rigs' read-back) covering icons/atoms/twinklers/comets/the instance
  ceiling; the far-field re-pin; the honest instrument
  (DoomalayPerf.oneObject) extended with the instance-draw counter.

## §4 THE PROOF

- `scripts/v1610-honest-field-rig.mjs` (the v1570 pattern): §0 source
  pins; §1 THE CONTINUOUS CLAMP live (drive the camera through the
  crossing — the per-frame offset delta stays within the anchor's own
  movement, NEVER a half-screen jump; both axes; in and out); §2 THE
  PROPORTIONAL STRIDE live (same 100px stride at scale 1 vs the floor:
  the world delta scales 1/scale; the whole world crossed in ≤2 strides
  at the floor; the momentum cap); §3 THE EIGHT TILES (the pair/cells/
  period pins; the rotation adjacency law — every instance's 8 neighbors
  differ; the census bound); §4 THE SEEN ONLY (the cull census + the
  far-field re-pin).
- `scripts/v1610-honest-field-walk.mjs` (the real finger): a real pinch
  out to the floor (cameraProbe sampled through the gesture — no lurch),
  a real pan at the floor (the world crossed in a stride), the tiling
  read dead (VLM screenshot verdict), zero console errors.
- THE BATTERY: the full prior-wave suite re-run (v1350/v1400/v1421-v1428/
  v1570 re-pinned to the new clamp law + v1590) + go suite + vet +
  cross-compiles + discipline.

## §5 THE SHIP

v1.62.0 THE HONEST FIELD — buildinfo 1.61.0 + the README section + both
worklogs + push + tag `v1.62.0-the-honest-field` + the GitHub release (the
CI builds the APK). Rebase before pushing (the standing law — the parallel
bot's v1.60.0 already rebased in; fetch again at ship time).
