# RESEARCH — The Color System Rework (v0.89.8)

> The user's ask: "I believe we have to completely use a different framework,
> library/s, and language/s on how we render colors and gradients. Let's
> completely rework and rebuild our color system. Let's first just do a huge
> web search covering 5-10 alternative libraries and languages we can use
> compared to our own. Gather as much insight for me please and give me ur
> opinion. Let's come to a consensus."
>
> 11 searches, 84 sources (tool-results/color-research/), 2026-10-01.

## What we run today (the honest baseline)

- **The DOM/theme side**: ~30 CSS custom properties per theme + a
  home-grown "variable projection" engine (theme.js): a runtime CSS
  compiler that scans stylesheets, derives gate rules, and maintains
  derived-gate stylesheets + `[style*]` substring selectors so gradients
  follow the theme. Inline styles everywhere in the settings UI.
- **The canvas side**: a hand-rolled 2D batcher (lattice.js) — color
  quantization (16 levels/channel — banding), alpha quantization (8-10
  levels — the nauseating shimmer on pulsing dots/fading lines, fixed
  today in v0.89.7 by raising to 64/100 levels), segments as filled
  quads, per-frame spec fingerprints. PixiJS is already vendored for the
  icon world layer (WebGL, 828KB, lazy-loaded).
- **The symptom** (user, live): opening the settings on the COLORS tab is
  extremely laggy on the device (empty panel smooth, sizing tab smooth);
  the canvas dots/lines looked "awful and nauseating" after the fps wave.

## The candidates (what the research says)

### 1. Modern CSS-native color — OKLCH + color-mix() + relative color syntax + @property
- OKLCH is **perceptually uniform** — gradients interpolate evenly (no
  muddy gray band in rgb() blue→yellow), and palette steps LOOK even
  (CSS-Tricks; the OKLCH guides; multiple 2026 design-token write-ups).
- `color-mix(in oklch, var(--accent), white 30%)` derives tints/shades
  **natively in the browser's C++ engine** — no JS, no re-derivation.
- Relative color syntax (`oklch(from var(--accent) calc(l + 0.1) c h)`)
  derives a WHOLE family (borders, surfaces, hover states) from ONE var.
- The @property benchmark: 25,000 registered properties = ~30ms initial
  recalc — i.e. dozens of registered vars are effectively free.
- **Support**: Chromium 111+ — our Android WebView and desktop are
  Chromium; this is the native path.
- **My take**: the FOUNDATION of the rebuild. It deletes the entire
  home-grown derivation layer (the gates, the [style*] catchers, the
  JS-side shade/blend functions) and replaces it with the browser's own
  engine — the colors-tab lag is EXACTLY the cost of our home-grown layer.

### 2. culori (JS color math)
- The modern consensus pick over chroma.js (PkgPulse 2026, the culori
  ecosystem): full OKLab/OKLCH/Lab/P3 support, tree-shakeable to ~5KB,
  functional API, TypeScript.
- **My take**: the CANVAS-side engine (the lattice paints from JS; it
  needs JS color math). Replaces our hand-rolled shadeHex/quantColor with
  correct perceptual math. Not needed on the DOM side once CSS-native
  lands.

### 3. chroma.js
- The classic; scales/bezier/calls; sRGB-centric + Lab; ~13KB.
- **My take**: superseded by culori for our needs (perceptual spaces are
  the point). Skip.

### 4. Color.js (colorjs.io)
- The W3C CSS Color editors' reference implementation — the most CORRECT
  conversions available.
- **My take**: keep as the ORACLE for our test suites (verify our CSS and
  canvas colors agree), not as runtime weight.

### 5. d3-interpolate / d3-scale-chromatic
- Data-visualization color scales (sequential/diverging/categorical).
- **My take**: wrong domain — we theme a UI, not choropleths. Skip.

### 6. CSS Houdini Paint Worklets (the Paint API)
- Custom `paint()` in CSS; runs off-thread; Chromium-only (fine for us).
- **My take**: RIGHT for our STATIC decorations — the border plate/ring
  gates (the v0.77.8 derived plates) could become one paint worklet with
  zero JS observers. WRONG for anything animated (the lattice) — repaint
  triggers and debugging in WebView are painful. A targeted tool, not a
  foundation.

### 7. WebGL/WebGPU fragment-shader gradients (via PixiJS — already vendored)
- The benchmarks: Canvas 2D ceilings at 1-3K draws/frame; WebGL passes
  50K+. A fullscreen fragment shader computes per-PIXEL gradients in
  float precision — **banding becomes impossible by construction**, and
  mesh/gradient fields cost ONE quad, not 1,500 batched fills.
- **My take**: the CANVAS-side endgame. The lattice's gradient/mesh/
  pattern background becomes a shader; the 2D quantizing batcher retires.
  We already ship PixiJS for the world layer — same infra, one runtime.

### 8. PixiJS / Two.js / p5.js (canvas frameworks)
- PixiJS wins the engine comparisons for our shape (scene-graph 2D on
  WebGL with a Canvas2D fallback); Two/p5 are authoring-oriented.
- **My take**: PixiJS only — and only because it's already vendored.

### 9. Rust `palette` crate → WebAssembly
- Near-native color math in the browser.
- **My take**: over-engineering — culori's math costs microseconds at our
  scale, and a Rust/WASM toolchain is a new build system for zero user-
  visible gain. Skip.

### 10. Style Dictionary (design tokens)
- Amazon's build-time token system: JSON tokens → CSS/Android/iOS.
- **My take**: solves multi-platform token DISTRIBUTION — a problem we
  don't have. Our themes are RUNTIME-user-editable (the appearance page
  IS the token editor). Skip.

## The diagnosis that ties it together

Both pains — the colors-tab lag AND the damaged canvas — come from the
same architectural choice: **we built a runtime color compiler + a
quantizing software rasterizer in JavaScript, on top of a browser that
already ships both engines** (the CSS color engine, and the GPU). The
lag is our JS layer re-deriving what the browser could derive natively;
the banding is our 8/16-level quantization of what the GPU renders in
float.

## My recommendation (the consensus I propose)

**A two-track rebuild, incremental, no big bang:**

- **TRACK 1 — the DOM/theme side goes CSS-NATIVE.**
  Theme values become OKLCH; ONE accent root variable per family; every
  derived color (borders, surfaces, tints, the text gradients) derives
  via `color-mix()`/relative colors in CSS. The JS gates/projection
  engine retires family by family (each step verified by the theme twins
  suite — 165 assertions — and the v065 visual gate). The colors tab
  stops deriving anything at open time: the lag dies with the layer that
  caused it.

- **TRACK 2 — the canvas gradient field goes GPU (PixiJS, already vendored).**
  A fullscreen shader for the lattice's gradient/mesh/pattern background
  (float precision — no banding, ever); dots/lines ride the existing
  world-layer infra. The 2D batcher stays as the fallback (small/
  no-WebGL devices) with TODAY's precision fix.

- **Immediately shipped (today, v0.89.7)**: the quantization precision
  fix (alpha 8/10 → 100 levels, color 16 → 64 levels) — the shimmer and
  banding die now, before any rework starts.

- **Not recommended**: Rust/WASM (toolchain for nothing), Houdini for
  animated things (flaky in WebView), d3 (wrong domain), Style
  Dictionary (build-time ≠ runtime), chroma.js (culori strictly better).

**The one-sentence consensus**: stop compiling colors in JavaScript —
let the browser's CSS engine derive the DOM side (OKLCH + color-mix),
let the GPU draw the gradients (the Pixi shader), and keep a thin
culori-powered layer only where JS must know a color (the canvas dots,
the export paths).
