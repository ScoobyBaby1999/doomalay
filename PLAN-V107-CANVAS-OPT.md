# PLAN-V107 — THE CANVAS OPT WAVE (real plan, post-measurement & research)

## Evidence base (measured this session, v1.06.0 @ c2d1ff1f, headless 412×915)

- Worst-case doom grid (amp100 + both anims + 60% variations): **29 tile fills per
  full frame**, resting **fps 15** (ambient cadence gate), worker paintMs 0.2-0.5.
- Zoom sweep 1→3→0.5: **6 rebakes in one gesture pair**, `pending=true` visible
  mid-gesture — the storm.
- VLM on screenshots: repetition period ≈ **1.5–2 screens** — tiling visible.
- Resting animation: the v0.97 ambient cadence gate caps full frames at ~**15fps**
  (66ms) — heroes/breath step at 15fps + TEMPO 0.5 → reads "extremely static".
- Code-verified root causes:
  1. `tlFingerprint` embeds `bgKey` (bgView.tw/th/zx) — `zx = 1+(scale−1)·bgP`
     moves CONTINUOUSLY once scale>1 → fp churns every frame → the 150ms debounce
     re-fires through the whole zoom-in gesture.
  2. Colors sample through the LIVE bgView fold at BAKE scale (`sampler(dx·spacingQ+…)`)
     → the color field jumps at every rebake (part of the "snap"), and forces bgKey
     into the fp in the first place.
  3. Bakes run synchronously inside worker paintFrame at cam.scale (not canonical),
     so nothing is cacheable across zooms.
  4. bg = 4–9 viewport-sized drawImage blits + save/restore per frame.

## Research verdicts (web + in-repo RESEARCH-V084)

- STAY canvas2d + worker + createPattern (GPU-backed) — no second WebGL context
  for the grid (Pixi already owns the conditional world layer; RESEARCH-V084's
  standing verdict — Godot/Unity/WASM rejected with reasons on file).
- `CanvasPattern.setTransform`/CTM scale = the zoom-stretch primitive (MDN) —
  already the mechanism in `tlFill`; keep.
- Multiresolution LADDERS are the standard zoom approach (mipmaps/krpano multires
  analog): pre-baked level sets, swap = pattern swap, stretch between levels.
- Repetition perception: tile period must be ≥ ~2–4× viewport, or broken by
  multi-scale variation (decals / a second low-frequency layer). Current joint
  period (lcm(10,16)=80 cells ≈ 1.6 phone screens at min zoom) is below the bar.

## THE PLAN (phases ship as v1.06.1 … v1.06.4, wave tag v1.07.0)

### Phase 1 — v1.06.1 THE ZOOM LADDER (storm + snap die)

All in `lattice.js` (both hosts run it; zero main-thread work):

1. **Reference-space color sampling**: bakes sample colors through a FIXED
   reference fold (`bgViewRef`: tw/th at scale 1, zx=1, px/py=0) — never the live
   bgView. A cell's color becomes a pure function of its world position:
   rebake-stable, zoom-stable.
2. **bgKey out of the fingerprint**: `tlFingerprint` = params + colors + pair +
   rq + DPR only. NOTHING continuous-with-zoom remains.
3. **Canonical level bakes**: level q bakes at raster R_q = 1.25^q (clamped to
   [0.35, TL_DPR]) and scaleQ_q = Rref/R_q — the tile-set is a pure function of
   (params, q): cacheable forever, gesture-independent. Tile pixel size is
   invariant across levels (scaleQ·R = Rref), so runtime ps-stretch stays ≤1.25×.
4. **The ladder cache**: `TL.sets` = LRU map (rq → tile set), byte-capped
   (Σ DL²·4 ≤ 96MB; evict LRU, never the current). A zoom into a SEEN level =
   instant pattern swap, zero bakes. Unseen level = async bake (debounce
   callback — never inside paintFrame), lands via the existing repaint-wanted
   path. Sharpness-only transition (geometry exact both ways — world-proportional).
5. **Instruments**: `oneObject` gains `ladder` {levels cached, bytes, rq, hits,
   misses} + `tileMs` in the compact twin (rigs prove the storm is dead).

### Phase 2 — v1.06.2 THE FILL DIET (the 60fps push)

1. **bg mirror-quad**: bake the 2×2 flipped arrangement ONCE into a quad tile
   (BG_TILE_MULT 2→1.35, raster ×0.75 — it's a soft field) keyed by (spec, zx
   quantum via tlRasterQ) → ONE pattern fill per frame replaces the 4–9 blit
   loop (period 2·tw ≈ 2.7×viewport — no visible repetition, zx stretch between
   quanta rides the pattern transform).
2. **Over-split diet**: over-tiles (the in-front-of-icons parallax pop) mint for
   the TOP band + heroes only (bands 0–3 keep base tiles) — worst case
   29 → ~19 fills.
3. Hero glow pass unchanged (≤40 small sprites). Full-line immediate path
   untouched (≤2 fills, contracts intact).

### Phase 3 — v1.06.3 THE LIFE WAVE (visual restoration)

1. **The modulation layer** (the tiling kill): ONE extra full-viewport pattern
   fill per full frame — a 256² value-noise tile (generated once per colorway
   from theme hexes via shadeHex — ZERO hardcoded colors), tiled at period
   320 cells (≫ screen at any zoom), composite soft-light, alpha ~0.5, riding
   its own slightly-slower parallax + a slow drift (the whole field subtly
   breathes). Kills the "wallpaper" read on top of the 80-cell placement
   interleave.
2. **Comets** (the fast movers): ≤3 concurrent, world-anchored, spawn every
   4–10s, ~1.2s life crossing ~1.5 screens, glow head + fading gradient tail,
   band-parallax rate. Paint on #c2 in BOTH frame paths (60fps cheap frames —
   smooth, no strobe).
3. **Twinklers**: ~28 world-anchored extra micro-dots (period-160 cells, between
   lattice positions), phase-offset sine alpha, plain fills — ride the cheap
   frame with comets.
4. **Cadence gate 66ms → adaptive**: full ambient frames at 33ms (~30fps) when
   only the lattice animates (breath/shimmer — slow global alphas read fine),
   comets/twinklers/atoms at 60fps cheap frames between. Hero tempo variety
   (per-hero tsp already hashed — widen spread; some fast pulsers).
5. All new motion respects the user's toggles: gated on (animDots || animLines).

### Phase 4 — v1.06.4 THE PROOF (rig, rebuild, rebase, push)

Rig `scripts/v107-canvas-proof.sh` (per-run port + ss-pid ownership proof):
- **Storm proof**: worst-case zoom sweep (1→3→0.5→1) — bakeGen increments ONLY
  on unseen levels; the REVERSE sweep = zero bakes (ladder cache hits);
  no synchronous bake inside any frame with pending=true... (assert via the
  new ladder instrument: midas-bakes = 0).
- **Budget proof**: worst-case fills ≤ 20, bg = 1 fill, ladder bytes ≤ cap,
  resting paintMs ≤ prior (no regression), fps at rest ≥ 30 ambient / 60 moving
  (headless).
- **Life proof**: 2s at rest — comet spawns ≥ 1, twinklers painted, heroes
  animate (frame counter delta on full frames), zero console errors.
- **Theme proof**: theme flip → colorFp changes → rebake with new hexes; grep
  gate — no new hex literals in touched files (FALLBACKS owner exempt).
- **Regression battery**: v0899 12/12 (stretch), v0852 14/14, v0901 15/15,
  v0831 13/13, theme twins, uikit, `go test ./...` (Go user-local build).
- Engine rebuild from the merged tree (go:embed), version bump per phase,
  rebase check, push + tag.

## Standing constraints honored

- No hardcoded colors (theme 7-slot FIELD + shadeHex derivations only).
- No new foreground UI (all changes are canvas-side; no Panel/Overlay needed).
- Scope discipline: ONLY the three asks; stop before spaghetti.
