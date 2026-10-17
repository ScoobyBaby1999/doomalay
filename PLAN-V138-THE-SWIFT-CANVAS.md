# PLAN-V138 — THE SWIFT CANVAS (the redo of the lost wave, renumbered past THE COMPASS WAVE)

> The user's ask, verbatim: *"implement the fixes to make rendering the canvas
> much, much more optimized"*. The original wave (v1.37.0-the-swift-canvas,
> 6 commits) was lost with a sandbox reset before its push — never landed on
> origin (verified: no tag, no branch, no release; the local commits died with
> the sandbox). This is the redo, riding the recovered tree (v1.37.0 THE
> COMPASS WAVE, e4e910df, CI green, pushed). The phases renumber v1.37.1-3;
> the ship takes **v1.38.0** (the house law: the next dot left).
>
> The insight corpus: the Lippy transcript (2026-10-16) — the user's own
> diagnosis ask inside the app ("the canvas, even after all our efforts,
> needs work still") with its RC1 (the #c2 per-frame pass is fill-rate /
> paint-cost bound) and its fix recommendation #2 (the atom/orbit paint
> cost) — plus the wave's own measured convictions from the lost session's
> worklog record.

## THE CONVICTIONS (recon receipts, this tree)

- **C1 — the per-star 2D paint.** `atoms.js paintCore`: every FRONT star
  paints 2 `beginPath/arc/fill` pairs (halo 0.18 + core 0.95) and builds 2
  rgba strings (`'rgba(' + triplet + ',α)'`); every BACK star one more pair.
  At 480 stars that is ~960 fills and **960 string builds per frame**.
- **C2 — the per-star math allocates.** `starPos(key, level, R, t)` runs on
  every star every frame in BOTH hosts (main paintCore + the pixi driver):
  a key-string concat (`icon.id + '|' + L + '|' + j`), a `Map.get`, and a
  fresh `{x, y, z, r}` result object — **~28,800 objects/sec of GC pressure
  at 60fps/480 stars**, plus the back-half `back[]` array per shell.
- **C3 — every pixi z-flip re-sorts + invalidates the root structure.** The
  vendored v8 receipts, read straight from `pixi.min.js`:
  `set zIndex(r){…this.depthOfChildModified()}` →
  `depthOfChildModified(){this.parent&&(this.parent.sortableChildren=!0,
  this.parent.sortDirty=!0),this.parentRenderGroup&&
  (this.parentRenderGroup.structureDidChange=!0)}` — and pixiworld's
  `updateWorld` writes `st.sp.zIndex = p.z >= 0 ? 150 : 45` on EVERY star
  EVERY frame while `addChat` armed `sortableChildren = true` at mint.
  (The lost session measured 107 sorts + 233 zIndex writes + 324 root
  structure invalidations over 605 frames on the 5-chat scene.)
- **C4 — the shells mint unbatched Graphics.** Every chat mints up to five
  64-segment `PIXI.Graphics` polylines; the v8 docs' own law: "Graphics
  objects are batched when under a certain size (100 points or smaller)…
  Using 100s of graphics complex objects can be slow, in this instance use
  sprites". 300+ Graphics on a busy canvas = the slow path.
- **C5 — THE LATENT ×R BUG.** `pixiworld.js:728` — the shell polyline's
  `lineTo` points are NOT multiplied by `R` (only the initial `moveTo`
  is). The world-layer shells have drawn a ~1px blob since v0.85.4 while
  the DOM twin (`shellPath`, ×R correct) drew true ellipses.
- **C6 — THE 2× TEMPO DRIFT.** `updateWorld`'s clock `t = nowMs/1000 - t0`
  never multiplies by `MOTION_TEMPO` (0.5, the v0.97 slow-down) —
  `paintCore` does (`t = t * MOTION_TEMPO`). The pixi stars orbit at 2×
  the DOM twin's speed.

## THE RESEARCH (web receipts, on the record)

- **MDN / optimizing canvas** — "Pre-render similar primitives or
  repeating objects on an offscreen canvas… render the offscreen image to
  your primary canvas as often as needed, without unnecessarily repeating
  the steps." → §2's baked star sprites.
- **PixiJS v8 performance-tips (official)** — "Sprites can be batched with
  up to 16 different textures… the fastest way to render content";
  "Graphics… batched when under a certain size (100 points or smaller)";
  "Using 100s of graphics complex objects can be slow — use sprites". →
  §3's shell atlas (one source, five frames) + sprite stars.
- **PixiJS v8 render-groups (official)** — RenderGroups are "specialized
  containers… mini scene graphs themselves"; the vendored `addChild`
  receipt confirms a child added to a render-group container re-points
  `parentRenderGroup` to IT (`t.parentRenderGroup=this` on the group's own
  pipe) — reparenting between render-group buckets is BUCKET-LOCAL. →
  §3's fixed buckets.
- **The software-canvas counter-receipt** (the lost session's live
  conviction, re-proven in the walk): on Skia's SOFTWARE canvas a scaled
  `drawImage` costs ~13× an analytic `arc` (~2.7µs vs ~0.2µs per star) —
  a sprite-only diet would REGRESS headless/software hosts. → §2's DUAL
  STAR: probe the host once, ride the winner.
- **The probe-honesty law** (the lost session's own bug, on the record):
  a micro-probe that never CLEARS between paints accumulates
  semi-transparent ink and pushes Skia off its fast path (~100× artifact)
  — the production frame shape is clear-then-paint. Every probe in the
  rig/walk clears per iteration.

## THE PHASES

### §1 v1.37.1 — THE FLAT STAR MATH (atoms.js)

`starFieldsOf(iconId, n)` — one `Float64Array` of `[omega, phase, r]`
per (iconId, count-layout), populated through the SAME hash populate
`starPos` runs (identical BY CONSTRUCTION — the rig pins it), cached
beside STAR_CACHE with the same 4096 bound. `paintCore`'s star loop reads
the typed array + projects INLINE: `ang = t*omega + phase; u = cos; v =
sin;` against the hoisted `TILT_BASIS[level]` floats — **zero key
strings, zero Map.gets, zero object allocations per star per frame**.
The back-half scratch becomes a preallocated module-level array (grown,
never shrunk). `MOTION_TEMPO` moves ABOVE the `AtomCore` export and is
exposed (`AtomCore.MOTION_TEMPO`) — pixiworld needs it for §3's tempo
parity (the current file's export block sits at line 366 while the var
sits at 610: the export literal would read `undefined` — the hoisting
bug the lost session caught). `starPos` itself stays byte-identical (the
DOM rig's `_starPos` twin + the v0841 contract).

### §2 v1.37.2 — THE DUAL STAR (atoms.js paintCore)

The honest primitive-picker:
- **Bake**: per color channel (accent, accent2) two sprites — the halo
  (radial gradient, α 0.18, 2.4× radius) and the core (soft-edged disc,
  α 0.95) — drawn once per theme into small canvases (the MDN law).
- **`starPathVerdict()`**: on first paintCore call, run the live A/B —
  300 arcs vs 300 scaled drawImages, CLEARING between paints (the
  probe-honesty law), sticky per host (localStorage, the GL-gate
  pattern; `__forceStarPath` hook for the rigs). **sprite** on hardware
  canvases, **arc** on software.
- **Both paths keep §1's flat math** and hoist the rgba fill strings
  ONCE PER FRAME (6 strings: accent/accent2 × 0.18/0.95/0.5) — the
  parity of the arc path stays byte-identical modulo the string hoist;
  the sprite path's op-mix is drawImage-only with ±0.75px raster
  tolerance (the rig pins BOTH).
- Back stars ride the same primitive inside the existing evenodd clip.

### §3 v1.37.3 — THE BATCH DIET (pixiworld.js)

- **THE FIXED BUCKETS**: per chat container — `shellLayer`, `backLayer`,
  `sprite` (the icon raster), `frontLayer`, in that immutable child
  order. `sortableChildren` stays FALSE forever and **nothing ever
  writes zIndex** (the vendored setter can never re-arm). A star z-flip
  RE-PARENTS the sprite between backLayer/frontLayer — both
  `enableRenderGroup()` containers, so the structure invalidation is
  bucket-local (the vendored addChild receipt). Alpha (0.95/0.5) rides
  the flip.
- **THE SHELL ATLAS**: the five level ellipses bake ONCE per theme into
  ONE canvas (the true projected geometry — the ×R fix); five
  `new PIXI.Texture({source, frame})` share that ONE source (the v8
  batching law). `destroy()` without `true` frees the wrapper, never the
  shared source (the vendored destroy receipt). Shells become five
  batchable Sprites per chat instead of five unbatched 65-point
  Graphics.
- **THE FOLDED CONSTANTS**: the star records carry `{sp, omega, phase,
  r, e1x, e1y, e2x, e2y, R}` — minted from `starFieldsOf`/TILT_BASIS.
  `updateWorld`'s star loop is pure arithmetic (no `starPos` call, no
  Map, no alloc).
- **THE TEMPO PARITY**: the world clock `× AtomCore.MOTION_TEMPO` — the
  2× drift dies (the rig pins: pixi `t` and DOM `t` produce the same
  projected position for the same wall clock).
- The driver semantics (running/resting, poke, threshold gate, GL gate,
  theme re-mint, deactivate DOM-return) are untouched — v0854/v1310 pin
  them.

### THE SHIP — v1.38.0

buildinfo 1.38.0 (the chained record), the rig + walk in `scripts/`,
the device checklist section in `docs/TERMUX-DEVICE-TEST.md`.

## THE BATTERY (the honest bar)

- **`scripts/v1380-swift-canvas-rig.mjs`** — 39 checks: the §1/§2
  op-mix + geometry parity vs the pre-wave base (both primitive paths,
  forced), the probe law (sticky + force + clear-between-paints), the
  worker-env law (AtomCore in a worker VM), the JS-overhead receipts
  (arc path / sprite path vs OLD), the PIXI-stub A/B pinned to the
  vendored receipts (sorts / zIndex writes / root invalidations /
  Graphics mints — OLD vs NEW), the atlas frame geometry vs the DOM
  twin, the tempo parity, the buckets' child order.
- **`scripts/v1380-swift-canvas-walk.mjs`** — 24 checks × 2 consecutive
  runs: the REAL engine + REAL PWA (agent-browser), the live #c2 raster
  A/B (base worktree build vs worktree build — clear-between-paints,
  adaptive evals, single-line evals, jparse for the double-JSON
  encoding), the behavioral laws (v0841's: #c2 moves, #c identical,
  backHidden/frontInside via explicit t samples), the world layer live
  (forced 'on': atlas frames, buckets, driver resting on unbind,
  deactivate clears refs), the DUAL STAR verdict live, mobile 390px,
  zero page errors.
- **Regressions**: v0841 (atom orbits 14) · v0854 (pixi world) · v1310
  rig + walk · the Go suite 13 packages · vet · linux + android(arm64
  CGO=0) builds · the v1370 compass walk (48) · v1340 · v1350 · v1361 ·
  v1363 · v1364 (the neighbors' laws hold under my tree).

## THE WILL-NOT BOUNDARY

No React islands, no Pixi-in-worker, no bundler, no dirty-rect surgery
(the map-app pattern stays the later wave it is), no DOM-side
`icon.render` changes, no theme-color hardcoding (the sprites bake from
the resolved theme triplets — the canon law), no new UI surface (the
wave is pure engine-side paint cost).
