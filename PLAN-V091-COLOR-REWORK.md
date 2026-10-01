# PLAN-V091 — THE COLOR SYSTEM REWORK, PHASE 1 (Track 1: CSS-native)

The user's mandate: "implement the new color system that u researched to
solve the canvas issue… I honestly prefer rust/wasm since it may help us
later when we have 50+ concurrent tabs and chats… Ultimately it's ur
choice… I want the theme system done. Try to maintain as much functionality
from our current very complex theme system while maintaining a solid fps
thru and theu by using better foundations."

## THE RUST/WASM DECISION (my call, per the mandate)

**Not for the color system.** The measured costs are NOT JS-math costs:
1. The colors-tab lag (live-diagnosed this session) = the PROJECTION layer
   fanning `--proj-tx/ty` var pokes into 534 inline-projected elements on
   the tab (271 gr-mini chips alone), EACH rastering a full-viewport-sized
   gradient field (`background-size: 1280px 577px`) on every canvas physics
   tick. No WASM module can help: the cost is style recalc + GPU raster,
   and WASM cannot participate in either — it would ADD a JS↔WASM round
   trip plus more inline writes.
2. CSS-native derivation (`color-mix()`, OKLCH) runs inside the browser's
   C++ style engine during normal recalc — strictly faster than any WASM
   alternative, zero JS.
3. The canvas-side color math (shadeHex/avgStops class) is microseconds
   per theme flip — a Rust toolchain in a no-build vanilla-JS repo buys
   nothing user-visible.
4. For the future 50+ tabs/chats goal, the levers are: fewer recalc'd
   elements (this wave), fewer rasters (this wave), and the already-shipped
   off-main-thread infra (the worker painter + the Pixi world layer).
   Rust/WASM has a REAL future home in the physics/sim core (tabgroups,
   collisions) — noted as a candidate wave, NOT the color system.

## THE DIAGNOSIS (live, this session — scripts/probe-colors-structure.sh)

- Colors tab open: **534 inline-styled elements** of 754 nodes; 126 color
  rows; 271 `.gr-mini` chips. Every one carries
  `background-position: calc(var(--proj-tx) - Xpx) calc(var(--proj-ty) - Ypx);
  background-size: <viewport>; background-attachment: scroll` — the PROJ
  painter's projection of `background-attachment: fixed` Layer-3 chrome.
- The canvas physics tick pokes `--proj-tx/--proj-ty` per frame (the v0.72
  stale-window contract) → on a phone GPU the colors tab re-rasters hundreds
  of viewport-sized gradient fields per animation frame → THE LAG (empty
  panel smooth, sizing tab smooth — fewer projected elements).
- Root architectural cause (the research's sentence): we built a runtime
  color compiler + a manual projection rasterizer in JS on top of a browser
  that ships both engines natively (CSS color engine + compositor).

## THE WAVE (three phases, each verified by the twins + rigs)

### v0.91.1 — OKX: the perceptual core (theme.js)
- `OKX`: dependency-free OKLab/OKLCH (sRGB↔linear↔OKLab↔OKLCH, mix in
  OKLab, edges passthrough-exact). ~90 lines, zero deps (culori's math,
  our file — the repo has no build step; a vendored UMD would be the only
  alternative and adds 40KB for the same formulas).
- `mixHex`/`avgStops` (theme.js) route through OKX: derived tints/shades/
  avg-stops become perceptually even (no muddy rgb midpoints). Edge cases
  (t=0/1, single color) byte-identical passthrough — the twins' identity
  assertions hold.
- Exposed as `window.DoomalayTheme.OKX` for the canvas side (lattice.js
  shadeHex adopts it in a follow-up phase; this wave keeps the canvas
  byte-stable to protect the v0831 weight contract).

### v0.91.2 — Layer-3 goes native (index.html + theme.js)
- The ~40 Layer-3 control classes (`.gr-mini`, `.gr-color`, inputs, chips,
  pills — the `background-attachment: fixed` 3-layer windows) switch to:
  `background: color-mix(in oklch, var(--surface-2), var(--bg-app) 12%)`
  + `border-color: color-mix(in oklch, var(--border), var(--surface-2) 30%)`
  — NATIVE, browser-derived, theme-following with zero JS, zero projection,
  raster cost = the chip's own box.
- Feature-detect `CSS.supports('color','color-mix(in oklch,red,blue)')`;
  the fallback keeps today's projected rule (old devices only).
- GATES: any stylesheet value containing `color-mix(` is SELF-DERIVING —
  the SURF auto-window derivation skips it (no re-projection).
- PROJ's painted set collapses (the Layer-3 selectors leave SEL) — the
  big surfaces (panels, sections, banners) keep the projected field
  (the coherent "one big box" look survives where it's visible).

### v0.91.3 — the colors tab dere-projects (uikit.js + appearance.js)
- The gradient EDITOR previews (gr-preview-bar, row banners, gr-tex-thumb)
  go STATIC local gradients (an editor shows the gradient itself; viewport
  projection at 52px is invisible) — they leave SEL too.
- The settings sections (4 big cards) keep projection.

### Verification
- theme twins 165 (identity cases must stay byte-identical) + uikit 140.
- NEW rig `v0911-native-layer3-test.sh`:
  (1) color-mix supported → the chips' computed background is the mix (no
      background-attachment:fixed chrome), zero [style] projection pokes on
      .gr-mini;
  (2) the projected set on the colors tab collapses 534 → ≤ 60;
  (3) theme-following: flip --surface-2 → chips' computed color changes
      (native recalc, no repaint call);
  (4) the look: chips still raised (contrast vs surface-1 measurable);
  (5) fallback path honored (supports=false stub → old rule);
  (6) zero console errors; canvas rigs re-run (theme.js is load-everywhere).
- The v0766 leak auditor logic rides the rig (no border floods).

## NOT-doing (this wave; documented for the next)
- Track 2 (the GPU shader for the lattice gradient field) — separate wave;
  the 2D batcher carries today's v0.89.7 precision fix.
- The PROJ engine's retirement for BIG surfaces (needs the scroll-driven
  animation / @property groundwork — the honest endgame per the research).
- lattice.js shadeHex → OKX (byte-stability for the weight rig this wave).
