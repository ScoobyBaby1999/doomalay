# PLAN-V098 — THE FINISH WAVE (canvas tiling + zoom + the panel)

> The user's three reports (2026-10-03), verbatim intent:
> 1. "The titling is still very noticeable tho, either add very performant and
>    effective variations (rotations or something) stuff that are negligible in
>    performance, or increase the sizing of the tiles."
> 2. "Zooming in and out is also broken, as stars and lines seem to snap into
>    different positions as I zoom in and out, resulting in a very broken feel,
>    even tho it's super smooth."
> 3. "Currently opening the settings panel causes a very noticeable spike in
>    performance, especially in the colors and general tabs… scrolling inside
>    the settings panel is laggy… the collapsible boxes open and close in a much
>    lower frame rate… artifacts and a moment of a black screen/panel as it
>    tries to recalculate."

## EVIDENCE (research agents, file:line, v0.97.0 @ b1fc081)

### Zoom snap — the mechanism (ranked)
1. `tlFingerprint` embeds `scaleQ.toFixed(4)` (lattice.js:638) → ANY scale change
   arms the 150ms rebake — which fires MID-GESTURE (clock starts at first
   mismatch; lattice.js:983-997).
2. `M = clamp(round(384/spacingQ),2,12)` (lattice.js:649) — M crosses ~9
   boundaries across zoom 0.5→3.0. Every dot/line/hero attribute is hashed
   TILE-LOCAL (`hashCell(X mod M, …)`): an M change = the ENTIRE field
   re-randomizes. THE snap.
3. Baked jitter is absolute px (lattice.js:795-796); mid-gesture the `ps`
   stretch (lattice.js:1200) magnifies it; the rebake pops it back.
4. Hero fireflies re-mint per bake (set + phases + orbit params,
   lattice.js:746-781) and LAYER-FLIP when the baked `h.jr` crosses the
   runtime `overThreshD` (lattice.js:1272 vs 1082).
5. `fpNow` embeds `scale.toFixed(4)` (lattice.js:1065) → param-cache wipe per
   zoom frame.

### Tiling visibility — the mechanism
- User config (packed: small gridSize, scatter 80, variation 100): the 40MB
  budget shrinks M to ~7 → tile period ≈ M·spacing ≈ 235px → ~4.6 horizontal
  repeats on a 1080px screen.
- The color fold is a MIRROR (`tlFoldIdx`, lattice.js:629) — symmetric color
  windows make the repetition recognizable.
- One period per (band × kind) — no de-correlation between layers.

### Panel colors/general — the mechanism
1. Colors tab mounts 18 FULL GradientUI editors collapsed-but-in-DOM
   (~754-979 nodes, 534 inline styles).
2. `L2.ok()` walks EVERY descendant with `getComputedStyle` (theme.js:1201-1208)
   — interleaved with mint writes in the write phase → forced-recalc thrash
   over the ~1000-node subtree = the mount stall; the black-flash = compositor
   checkerboarding during the stall over the dark `--surface-1` panel.
3. The PROJ MutationObserver sees the ~1000-node childList insert →
   full paint next rAF.
4. The collapse animation (`grid-template-rows` 0fr→1fr) matches `MOVER_RE`
   → 5 consecutive FULL paints over the subtree + per-frame layout.
5. General tab: 3 account fetches per mount + inline catcher-fixed backgrounds.
6. Settings close retains the whole hidden DOM + still-minted L2 rules.
7. `#proj-layer-styles` injection re-triggers SEL re-walk.

## THE FIXES

### Phase A — zoom stability (lattice.js)
- M (the tile pair) becomes zoom-independent: derived from the memory budget
  + params at a REFERENCE spacing (scale 1) only. All bake geometry is
  world-proportional (jitter + radius × bake scale) so the mid-gesture `ps`
  stretch is EXACT and rebakes never pop. Rebakes trigger on a 1.25× raster
  quantum (sharpness only). Heroes are baked-stable with runtime-correct
  radii and bake-time layer assignment. `fpNow` drops `scale`.

### Phase B — the tiling kill: PARITY PERIOD-INTERLEAVE
- Dots split by WORLD PARITY: even cells → layer A at M_A, odd → layer B at
  M_B (both even ⇒ parity survives mod-M). Joint period = lcm(M_A,M_B) cells
  — 80 cells at the default pair (10,16) = 3840px, wider than any phone
  screen. Fill count unchanged (the animDots checker groups ARE the parity
  layers). Lines interleave by column/row parity. Colors sample an identity
  window (no mirror). Budget 40→96MB; raster shrinks before the pair ladder
  drops: (10,16) → (8,14) → (6,10) → (4,6).

### Phase C — the panel
- C1 POSITIONED_SEL (theme.js): one native querySelector sweep replaces the
  per-descendant getComputedStyle walk in L2.ok().
- C2 strict two-phase (theme.js): the mint decision (okv) computes in the
  read phase; the write phase never reads.
- C3 lazy editors (appearance.js): collapsed color rows build their editor on
  first expand (~300 mount nodes instead of ~979).
- C4 (theme.js): `#proj-layer-styles` joins the observer style-exclusion.
- C5 (appearance.js): hydrateAccounts 60s session cache.
- C6 (settings.js): wipe the heavy settings body after close (+poke).

### Phase D — the color system rework plan (doc, next waves)
PLAN-V098-COLOR-SYSTEM.md: the user's north star (every surface = a
swappable texture window; user-uploadable UI assets) reconciled with the
repo research consensus (CSS-native OKLCH/color-mix DOM derivation; L2
compositor layers as the delivery mechanism). Batched repo-scan roadmap.

### Phase E — rigs + battery + ship
- scripts/v098-zoom-stability.sh — the constellation survives zoom rebakes.
- scripts/v098-tiling-period.sh — the pair contract + paint budget.
- scripts/v098-panel-colors.sh — the panel scenarios + black-flash detector.
- Battery: v097 oneobject, v092 orbit-rest, theme twins, uikit, v0783, v088
  + the standard set. Version → 0.98.0, rebuild, rebase, push, release.

## NON-GOALS
- No lattice rotation (axis-aligned aesthetic; breaks anchoring).
- No changes to renderLegacy (the byte-identical fallback).
- No color-system rebuild this wave (plan only).
- No general tab redesign (targeted fixes only).
