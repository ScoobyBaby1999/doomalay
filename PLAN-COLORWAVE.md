# PLAN — v0.54.0 THE COLOR SPACE WAVE (color system finalize + picker polish + hub card uniformity)

Base: 8475d53 (v0.53.0-hub-icons-themes). Two user items this wave:

**ITEM 1 — the color/gradient system follows everywhere, no tiled feel, polished picker.**
**ITEM 2 — hub cards: uniform, bordered, truncated, stylized, text pops.**

## Root causes found (verified in code)

| Symptom | Cause | Where |
|---|---|---|
| mesh/checker "don't follow colors" | recipes consume only stops 1–4 (mesh), 1–2 (checker/patterns); stops 5–15 ignored | uikit.js:322-386 |
| changing options "does nothing" perceptually | collapsed-row banner ALWAYS previews a flat 135° linear, never the pattern | appearance.js:332-338 |
| dots/lines ignore mesh/checker/pattern dirs | specColorAt samples stops positionally but IGNORES dir; gridPaint degrades mesh/pat to solid | app.js:405-413, 627 |
| canvas "feels tiled" | viewport-sized tile mirror-tiled: zoom-out → tile < viewport (2+ tiles at rest); pan period = 2 screens; mirror sawtooth; mesh = 4 fixed glow spots; photo Rorschach | app.js:436-471, 509-523 |
| expanded picker rows "prototypish" | deliberate wobbly radii (10px 8px 11px 9px/…) + 1px-offset hand-drawn shadows | index.html:3005-3041 |
| cards broken by long text / icons pushed around | .hub-card CLASS COLLISION: in-chat v0.52 block (index.html:1794, `align-items:center; gap:10px·chat-scale`) cascades onto library cards (2670) which never redeclare them → library card children centered + shrunk to content width | index.html:1794-1838 vs 2670-2677 |

## Phase A — pattern recipes consume ALL stops (uikit.js)

1. `css(v, opts)` gains `opts.scale` (default 1) — every px constant in the
   pattern recipes multiplies by it (mesh fades, stripe periods, checker
   cells). Gradients (non-repeating) ignore scale.
2. mesh: spot count = `min(8, max(4, colors.length))`; positions/radii/fades
   from a fixed varied table (deterministic); spots cycle the FULL palette;
   base = last stop (unchanged).
3. checker: ≤2 stops → the classic 32px 2×2 SVG tile (unchanged); >2 stops →
   a quilt tile: `2×ceil(len/2)`-column SVG, cell color `stops[(i+j)%len]`,
   size 32px cells, tiles seamlessly.
4. pat-navy: stripes cycle ALL stops (period = len·stripe-width).
5. pat-gingham: horizontal bands cycle even stops, vertical odd stops, base last.
6. pat-sunburst: rays cycle ALL stops.
7. pat-pinstripe: base = first→last sweep; stripe color cycles stops at .35 α.
8. _selftest pins updated (existing pins for changed recipes rewritten;
   new pins for 5-color mesh/checker/navy/sunburst/gingham + the scale param).

## Phase B — the true banner preview (appearance.js + tweaks.js parity)

1. `colorRowCollapsed`: banner style = `background-image: GradientUI.css(spec,
   {scale: 0.28})` (checker 32px→9px cells, navy 28px→8px — visible in the
   64×18 strip). Fallback for bare hex: background-color.
2. Banner updates LIVE: hook the GradientUI wire callbacks to refresh the
   sibling `.color-row-banner` (query via row registry) on every change —
   no full re-render needed.

## Phase C — pattern-aware grid coloring (app.js)

1. New `patternColorAt(spec, fallback, sx, sy)` — the color for SCREEN point:
   - simple dirs: projection onto the sweep axis (matches bgGradientPass
     geometry — h: x/W, v: y/H, diag: (x+y)/(W+H), diag2: (y−x)/…, radial:
     dist from focal / radius, auto/135: diagonal projection).
   - swirl: conic t around (0.55W, 0.45H).
   - mesh: soft inverse-distance blend of the SAME spot table as Phase A
     (scaled to the parallax tile coords) + base mix.
   - pat-navy: band = floor((x+y)/(28·k)) mod len (45° stripes).
   - pat-checker: cell parity = (floor(x/32k)+floor(y/32k)) mod len.
   - pat-gingham: 2-axis band product → quantized stop index.
   - pat-sunburst: sector = floor(atan2 from bottom-center/15°) mod len.
   - pat-pinstripe/tex: the sweep (stripes/luminance don't quantize dot color).
   - 1-stop → solid fast path (unchanged).
   - Coordinates are the PARALLAX-world coords (x + offsetX·scale·BG_PARALLAX)
     so dot colors match the background art's pattern positions.
2. Replace every specColorAt call for dots/lines/segments with patternColorAt.
3. gridPaint: 1-stop mesh/pat specs get the Phase-A derived 2nd stop for the
   stroke gradient (no longer flat) — but per-element sampling now covers it.

## Phase D — kill the tiled feel (app.js paintCanvasBackground)

1. Tile painted at 2×W × 2×H (TILE_MULT=2) → mirror period 4 screens.
2. `zx = max(1, 1+(scale−1)·BG_PARALLAX)` — the tile NEVER renders smaller
   than the viewport; zoom-out shows no at-rest repeats.
3. Canvas mesh: same richer spot table as Phase A (6–8 varied spots, all
   stops appear) painted into the bigger tile.
4. Radial: radius → 0.75·tile-diagonal (rings rare); focal unchanged.
5. Textures: cover-fit into the 2× tile → Rorschach period 4 screens.
6. Update the stale v0.49 comment (app.js:305-310) — it contradicts the
   parallax code.
7. Performance check: tile repaint cost ~4× (4×W·H pixels) — once per spec/
   size change only; per-frame cost unchanged (drawImage of the same tile).

## Phase E — the picker polish (index.html .gr-*/.color-row-* + uikit.js markup)

1. Kill ALL wobbly radii in the editor + color rows: uniform 10px (mini 8px,
   swatch 12px, preview-bar 12px), uniform 1px borders var(--border), soft
   ambient shadow `0 1px 3px rgba(0,0,0,.18)`.
2. Swatches: 44×34 chips; the ✕ remove INSIDE the chip's top-right corner
   (16px circle, surface-3 bg, no more -7px floats); padding-top hack dies.
3. Style + pattern rows become SEGMENTED CONTROLS: pills joined in a rounded
   var(--surface-2) track, 4px gaps, active pill = accent tint bg + accent
   border + text-1.
4. Angle slider: styled thumb/track (accent on surface-3), value chip
   right-aligned.
5. Preview bar: 44px tall, radius 12px, hairline inner border.
6. Color-row head: smoother expand (0.26s cubic-bezier(0.32,0.72,0,1)),
   arrow rotates to ▼ when expanded, reset pill gets a hover/active tint.
7. Theme vars ONLY (zero hardcoded colors — rgba(0,0,0,…) shadows allowed as
   neutral elevation, matching existing house use).

## Phase F — hub cards (index.html + chatpanel.js + hub.js + hubitem.js)

1. **Rename the in-chat card classes** `.hub-card…` → `.hmsg-card…`
   (index.html:1794-1838 + chatpanel.js renderer + delegated handlers).
   Kills the collision → library cards stretch full width again.
2. Library cards: `.hub-card-body { align-self: stretch; }` belt-and-braces;
   icon column fixed 28px; name nowrap-ellipsis; desc 2-line clamp; author
   ellipsis; foot margin-top:auto (pinned bottom); border → 1.5px
   var(--border-strong); shadow `0 6px 18px rgba(0,0,0,.32)`.
3. Text pop: fade bottom stop 0.97→0.985 + 0.86→0.90; name text-shadow
   `0 1px 6px rgba(0,0,0,.45)`; desc/desc-weight unchanged.
4. Bunch cards: same body classes (already); give the collection card the
   fade layer too (uniform look).
5. hubitem detail header: title ellipsis (long names wrap today).
6. In-chat (.hmsg-*) cards: keep visuals, all truncations already present.

## Phase G — red-team (imitate a real user, full capabilities)

Driver: fresh engine build (embedded web) + agent-browser at 412×915:
1. Cycle all 10 themes × screenshot; check every surface follows.
2. Canvas bg: every dir (auto h v diag diag2 radial swirl mesh + 5 patterns
   + texture) with a 6-color palette; screenshots; PAN 2 screens + zoom out
   0.5 + screenshots → assert no visible tile seam/period in gradients.
3. Dots/lines: set mesh + checker + navy specs; screenshots → colors vary
   per pattern; pan → pattern stable (world-anchored).
4. Picker: expand rows in Settings→Colors AND ✦ tweaks; screenshots of the
   polished editor; change dir to checker → collapsed banner shows checks.
5. Hub: open library; long-title items (superpowers corpus) → uniform cards,
   borders, truncation, foot pinned; heart/download in place; in-chat cards
   via injected hublist events → renamed classes render + download works.
6. uikit _selftest (node) all green; go build/vet/test green.
7. Zero console errors throughout.

## Phase H — rebase + push

fetch → diff → merge (if moved) → commit "feat(v0.54): THE COLOR SPACE WAVE"
→ tag v0.54.0-color-space → push main+tag → release body → CI assets.

Out of scope: adding NEW gradient types, changing the twin-var pipeline,
theme catalog changes, non-color settings UI.
