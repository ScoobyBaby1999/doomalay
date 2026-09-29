# PLAN — v0.75 Grid Effects wave (the user's 4 settings/canvas requests)

Companion to PLAN-V075-BYOK-HARDENING.md (the 5 security phases — approved
by the user's "implement all 5 faces"). This doc plans the GRID half.

## The user's requests (verbatim intent)

1. Rename the "Space parallax" slider → "Amplify parallax", and CHANGE the
   amplification method (the v0.67 differential-lag "made it worse not
   better visually"). At 0 the default behavior must be untouched.
2. Size variation: max/min range ×2; add a SIZE BIAS favoring smaller or
   larger sizes; even at max bias MOST sizes go one way, a FEW stay the
   other way.
3. Grid Effects expanded → TWO COLUMNS (dots | lines), every option
   duplicated per side.
4. An "animate" toggle per side: animated dots twinkle (rotate +
   grow/shrink at varying speeds); animated lines move randomly up/down
   the relative direction they face at random speeds.

## Design

### Amplify parallax (the new method — v0.75)

The v0.67 lag (PF_LINE 1−0.38d / PF_DOT 1−0.20d — lines sliding against
dots) is DELETED. Lines and dots always ride factor 1.0 (one flat
lattice; the v0.67 shimmer complaint is structurally impossible now).

Amplify (0 = off, byte-identical default) instead ADDS depth planes that
never touch the primary lattice:
- a deep STARFIELD: two extra scattered dot layers riding slower pan
  factors (0.55 / 0.28), smaller radii, lower alpha, density scaled by
  the amplification, deterministic per-cell hash anchors (no shimmer);
- the BACKDROP camera deepens: BG_PARALLAX 0.35 → min 0.20 as the
  amplification rises (0 = exactly today's 0.35).

`window.DoomalayDebug` gains lastStarCount/lastDotCount/lastSegCount
counters (the suite's parallax proof reads them — the old pixel-fold
"different line/dot shift" expectation is now inverted: the lattice must
be FLAT and the stars must exist).

### Size bias (per side)

- New state keys: `dotSizeBias` / `lineSizeBias` ∈ [−100, 100], 0 default.
- Distribution warp on the size hash h ∈ [0,1): `h^(2^(−2·b))`.
  b=+1 → exponent 0.25 → ~94% of sizes above mid (few smaller);
  b=−1 → exponent 4 → ~84% below mid (few larger); b=0 → identity.
- Applied to: dot radius hash, line base width, segment length + width
  hashes (per-side bias).
- Range doubling: `sizeFrac = sizeVar/100 · 1.7` (was 0.85) — sizes reach
  2.7× base and paint floors keep them visible.

### Two columns + per-side options

Per-side state keys (migrated once from the shared legacy keys):
`dotScatter/lineScatter`, `dotSizeVariation/lineSizeVariation`,
`dotSizeBias/lineSizeBias`, `dotRotation/lineRotation`,
`dotAnimate/lineAnimate` + the existing `hideDots`/`hideGridLines`.

Layout: "Amplify parallax" slider full-width, then a flex two-column
block (min-width 150px, wraps on narrow screens): each column = header
(Dots / Lines) + hide toggle + animate toggle + scatter + size variation
+ size bias (−100..100 slider) + rotation. Reset effects resets all of
it. Migration: loadState copies legacy gridScatter/gridSizeVariation/
gridRotation to BOTH sides once (gridV75 flag); renderGrid + the UI also
fall back to the legacy key when the twin is absent (imported old looks
keep working).

### Animate

- Ambient loop: `tick()` keeps the rAF alive while dotAnimate or
  lineAnimate is on (no scheduleSave spam — offsets don't change);
  the Settings.onChange handler kicks startAnimation() when ambient
  turns on.
- Dots twinkle: per-dot speed/phase from the stable hash →
  scale pulse (grow/shrink, ±40%) + a small ORBIT around the lattice
  anchor (the visible "rotation", 6–14% of grid spacing) + brightness
  riding the pulse. Animate off → exact static circles.
- Lines drift: per-line/segment random speed + direction sign; the
  segment center oscillates ALONG the line's own (rotated) axis —
  "up or down the relative direction they are facing". With size
  variation 0, animated lines render as overlapping segments
  (1.35× spacing) so the motion is visible while still reading
  continuous. Animate off + size 0 → byte-identical full lines.

## Files

| File | Change |
|---|---|
| web/settings.js | new defaults + one-time legacy migration |
| web/appearance.js | two-column Grid Effects UI, bias sliders, animate toggles, renamed slider, reset |
| web/app.js | renderGrid rework (flat lattice, bias warp, ×2 range, starfield, ambient animation), DoomalayDebug counters |
| scripts/v065-theme-suite.sh | p21 → the new flat-lattice + starfield proof |

## Gates

node --check on the three web files; theme twins 165; uikit 140; the
suite's p21 phase green (star count > 0 at 100, 0 at 0, lattice flat);
browser-verified screenshots of the two-column UI + animate on/off;
go build/vet/test unaffected-but-green.
