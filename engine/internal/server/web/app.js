// app.js — main controller.
//
// v0.44: the grid canvas paints GRADIENTS — the four grid colors may
// hold gradient specs ({colors[1..15], dir, angle?}; theme.js's
// effectiveGridSpecs resolves them); gridPaint() turns a spec into a
// canvas fill/stroke style (linear h/v/diag/diag2 + radial; swirl /
// mesh / patterns fall back to the solid — see the comment there).
//
// Uses the modular components:
//   • Physics.Entity, World (physics.js)
//   • GridIcon base + registry (gridicon.js) — any icon on the grid
//   • ChatIcon (chatbot.js) — extends GridIcon, registers 'chat' type
//   • Panel (panel.js) — content-agnostic slide-up panel
//   • Settings (settings.js) — modular settings with pages
//   • Appearance (appearance.js) — first settings page
//
// Responsibilities:
//   • Render the infinite grid (colors from Settings, live-editable)
//   • Maintain the World of GridIcon entities (chats, and future: polls, monitors)
//   • Long-press → "New Chat" menu → create a ChatIcon at the press point
//   • Tap an icon → flash → 500ms later → Panel slides up with icon's content
//   • Tap the settings gear → Panel opens with Settings (Appearance page)
//   • Pan (inverted), pinch-zoom, momentum — all preserved from v0.7.1
//   • Persist icons + view state to localStorage

(function () {
  'use strict';

  // ── Config (loaded from /config/*.json, falls back to defaults) ──
  const DEFAULT_NAMES = [
    "Scooby", "Doobie", "4rth Grade", "Crippy", "Lippy", "Trippy",
    "Baby", "Boonboon", "Dock", "Faqous", "Lip", "Sky", "Kenny"
  ];
  const DEFAULT_FAMILIES = {
    default:   { label: "Default",   color: "#4a4a5e", icons: [] }, // canvas-drawn data hex — theme re-tints at draw time
    anthropic: { label: "Anthropic", color: "#d97757", icons: [] },
    openai:    { label: "OpenAI",    color: "#10a37f", icons: [] },
    google:    { label: "Google",    color: "#4285f4", icons: [] },
    deepseek:  { label: "DeepSeek",  color: "#4f46e5", icons: [] },
    qwen:      { label: "Qwen",      color: "#6c4cf1", icons: [] },
    glm:       { label: "GLM",       color: "#3b82f6", icons: [] },
    meta:      { label: "Meta",      color: "#0866ff", icons: [] },
    mistral:   { label: "Mistral",   color: "#fa520f", icons: [] }
  };

  const config = {
    names: DEFAULT_NAMES,
    families: DEFAULT_FAMILIES,
    defaultFamily: 'default'
  };
  window.DoomalayConfig = config;

  let currentFamily = 'default';

  // ── Canvas / grid state ────────────────────────────────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  // v0.81.2 THE OVER-ICONS LAYER: the twin canvas ABOVE #chatbots —
  // same camera, same DPR, pure paint (pointer-events:none). renderGrid
  // routes the biggest dots/lines here when the amplifier is ≥ 50%.
  const canvas2 = document.getElementById('c2');
  const ctx2 = canvas2 ? canvas2.getContext('2d') : null;
  // v0.83.3 THE FRAME-RATE CAP: DPR is capped at 2. A 3× phone was painting
  // 2.25× the pixels of the cap for zero visible gain on a 1–4px dot
  // lattice (2× is already retina-sharp); raster fill-rate is the single
  // biggest frame cost when both lattices animate (the user's "canvas gets
  // low frame rate when animating both lines and dots"). DOM surfaces
  // (panel, icons, BIB) are unaffected — only the canvas raster halves.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let W = 0, H = 0;
  let offsetX = 0, offsetY = 0;
  let scale = 1;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3.0;
  let velX = 0, velY = 0;
  let animating = false;

  const PAN_FRICTION = 0.88;
  const MAX_PAN_VELOCITY = 18;

  const GRID_BASE = 48;    // base grid spacing in px (at scale 1, gridSize 1)
  const DOT_RADIUS = 1.4;
  const ORIGIN_RADIUS = 5;

  // Grid colors + size now come from Settings (live-editable via
  // Appearance page). These are the fallbacks if Settings hasn't loaded.
  function theme() { return window.Settings.getState(); }
  // Effective grid spacing = base * gridSize setting (1x to 5x).
  function gridSpacing() {
    const t = theme();
    const gs = (t && typeof t.gridSize === 'number') ? t.gridSize : 1;
    return GRID_BASE * gs;
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // v0.81.2: the over-icons twin rides the EXACT same geometry
    if (canvas2 && ctx2) {
      canvas2.width = Math.floor(W * dpr);
      canvas2.height = Math.floor(H * dpr);
      canvas2.style.width = W + 'px';
      canvas2.style.height = H + 'px';
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    update();
  }

  function worldToScreen(wx, wy) {
    return { x: (wx - offsetX) * scale, y: (wy - offsetY) * scale };
  }
  function screenToWorld(sx, sy) {
    return { x: sx / scale + offsetX, y: sy / scale + offsetY };
  }

  // ── v0.83.3 THE LATTICE CACHE ────────────────────────────────────────
  // Every per-element parameter renderGrid derives is a PURE function of
  // the world cell + settings (the stable-hash no-shimmer contract), so
  // the ambient loop was re-deriving ~75k hash calls, a stack of Math.pow
  // warps and per-element canvas state per frame for values that never
  // change between settings edits. THE CACHE: per-cell derived records
  // keyed by world cell, invalidated by a settings/scale fingerprint
  // (params) and a camera+theme fingerprint (colors — the pattern
  // samplers read screen positions, stable while the canvas rests). Pans
  // invalidate colors only (world-cell params are pan-invariant); zoom
  // rides the params fingerprint (scale feeds the sizes); ambient frames
  // hit the cache 100%. The glow halo gets a per-color prerendered SPRITE
  // (createRadialGradient per glowing dot per frame → one drawImage), the
  // samplers + gridPaint styles are cached by spec (they were rebuilt
  // per frame per band — the mesh 8-spot table ×6/frame), and the paint
  // paths drop save/translate/rotate/restore (rotation is invisible on
  // circles; line segments get exact manual endpoint transforms).
  var LC = {
    fp: '', gen: 0,                       // settings+scale fingerprint → params
    cfp: '', cgen: 0,                     // +camera+theme fingerprint → colors
    dot: new Map(), vline: new Map(), hline: new Map(),
    vseg: new Map(), hseg: new Map(),
    dotC: new Map(), vlineC: new Map(), hlineC: new Map(),
    vsegC: new Map(), hsegC: new Map(),
    dotG: new Map(),                      // v0.85.1 (glow wave): per-dot LIFTED glow hexes
    samplers: new Map(), paints: new Map(), sprites: new Map(),
    hits: 0, misses: 0                    // v0.85.1 (perf wave): the cache hit-rate ledger (DoomalayPerf)
  };
  function lcKey(a, b) { return (a + 65536) * 131072 + (b + 65536); }
  function lcClearParams() {
    LC.dot.clear(); LC.vline.clear(); LC.hline.clear(); LC.vseg.clear(); LC.hseg.clear();
    LC.dotC.clear(); LC.vlineC.clear(); LC.hlineC.clear(); LC.vsegC.clear(); LC.hsegC.clear();
    LC.dotG.clear();
  }
  function lcClearColors() {
    LC.dotC.clear(); LC.vlineC.clear(); LC.hlineC.clear(); LC.vsegC.clear(); LC.hsegC.clear();
    LC.dotG.clear();
  }
  function lcSampler(spec, fallbackHex) {
    var k = fallbackHex + '|' + (spec ? JSON.stringify(spec) : '');
    var s = LC.samplers.get(k);
    if (s === undefined) { s = makePatternSampler(spec, fallbackHex); LC.samplers.set(k, s); }
    return s;
  }
  function lcPaint(spec, fallbackHex) {
    var k = fallbackHex + '|' + (spec ? JSON.stringify(spec) : '') + '|' + W + 'x' + H;
    var v = LC.paints.get(k);
    if (v === undefined) { v = gridPaint(spec, fallbackHex); LC.paints.set(k, v); }
    return v;
  }
  // the glow sprite: the radial halo prerendered per color at a unit
  // outer radius (inner 0.35/2.6 of it — the exact gradient geometry the
  // per-dot createRadialGradient painted), scaled per dot via drawImage
  // (gradients scale perfectly).
  function lcGlowSprite(hexColor) {
    var sp = LC.sprites.get(hexColor);
    if (sp) return sp;
    // v0.85.1: the cap — per-dot glows (gradient/pattern dot specs) mint
    // MANY distinct colors; the sprite map would grow unbounded across a
    // long session. 256 live sprites is ~4MB worst-case; a clear drops
    // them all and the next frame re-mints only what's on screen.
    if (LC.sprites.size > 256) LC.sprites.clear();
    var S = 128, c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    var rg = g.createRadialGradient(S / 2, S / 2, S / 2 * (0.35 / 2.6), S / 2, S / 2, S / 2);
    rg.addColorStop(0, hexColor);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    sp = { c: c };
    LC.sprites.set(hexColor, sp);
    return sp;
  }
  // the honest instrument rides along (red-team reads it): rolling fps
  var lcFps = 0, lcLastT = 0;
  // v0.85.1: the frame timer — renderGrid's own wall cost (the HUD's
  // paintMs meter; measured around the WHOLE paint incl. background)
  var frameT0 = 0;

  // v0.85.1: the batcher's color quantizer — 16 levels/channel, cached
  // per exact hex (the mesh field's continuous colors collapse into tens
  // of local buckets; ±8/255 is invisible on 1–4px lattice elements).
  // Non-hex styles (CanvasGradient objects — one per band per frame) pass
  // through verbatim: within a frame they're a single object, so the
  // bucket key still can't collide across distinct gradients.
  var QUANT_COLORS = new Map();
  function quantColor(c) {
    if (typeof c !== 'string' || c.charAt(0) !== '#') return c;
    var q = QUANT_COLORS.get(c);
    if (q !== undefined) return q;
    var m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c);
    if (!m) { QUANT_COLORS.set(c, c); return c; }
    function lv(hh) { return Math.min(255, Math.round(parseInt(hh, 16) / 17) * 17); }
    function h2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    q = '#' + h2(lv(m[1])) + h2(lv(m[2])) + h2(lv(m[3]));
    if (QUANT_COLORS.size > 4096) QUANT_COLORS.clear();
    QUANT_COLORS.set(c, q);
    return q;
  }

  function renderGrid() {
    frameT0 = performance.now();
    // v0.24: grid colors resolve through the THEME (user picks win over
    // the theme's grid palette; pre-v0.24 default values = never
    // customized → follow the theme).
    const t = (window.DoomTheme && window.DoomTheme.effectiveGrid)
      ? window.DoomTheme.effectiveGrid(window.Settings.getState())
      : window.Settings.getState();
    // v0.44: the SPEC view — the same resolver, returning each color as a
    // gradient spec (legacy hexes fold into 1-color specs).
    const specs = (window.DoomTheme && window.DoomTheme.effectiveGridSpecs)
      ? window.DoomTheme.effectiveGridSpecs(window.Settings.getState())
      : null;
    // v0.25 guards (kept): canvas fillStyle REJECTS invalid values
    // silently. Validate every SOLID fallback before it reaches the
    // canvas; spec stops are validated inside gridPaint.
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    // v0.49 REWORK (user spec: "The panel background color should be the
    // one to determine the canvas background, not the app background
    // setting… follows the complex gradients and bumpmaps very poorly"):
    // the canvas background reads the CANVAS BG spec (the --bg-panel
    // override; the theme's grid bg when never customized) and paints it
    // at FULL fidelity — linear/radial/conic sweeps, the mesh multi-pass,
    // every pattern, and TEXTURES (bumpmaps) blended with a real 'color'
    // composite pass — into a cached tile that rides a PARALLAX camera
    // (see paintCanvasBackground; v0.52: it moves with the canvas).
    const DT = window.DoomTheme || {};
    var canvasSpec = (DT.canvasBgSpec || DT.appBgSpec)
      ? (DT.canvasBgSpec || DT.appBgSpec)(window.Settings.getState())
      : (specs && specs.bg);
    paintCanvasBackground(canvasSpec, (HEX_RE.test(t.bg || '')) ? t.bg : '#0a0a0b');

    // v0.45 ITEM 6: grid quick options — read once per redraw.
    var st = window.Settings.getState();
    // ── v0.75 THE AMPLIFIER (user spec: rename the slider, REPLACE the
    // method — the v0.67 differential lag "makes it worse not better
    // visually"; at 0 the default behavior is untouched) ──
    // v0.77.9 THE SIZE-DEPTH LATTICE (user spec: "upping the parallax
    // should not just spawn big circles in random positions… it should
    // detect programatically and deterministically using our animate
    // and size and scale random settings and make larger circles and
    // lines appear closer then everything, even icons, and the smaller
    // they get the further they look in parallax. So instead of hard
    // coding it, make it so that it depends on the user settings, where
    // biggest dots and lines parallax the furthest and smallest ones
    // parallax the least. The current effect and method is nice, I like
    // it, but I just would like it to use the user settings instead of
    // hard coding the parallax dots and lines."). The v0.77 spawned
    // starfield (FAR/MID/NEAR orbs at hardcoded pan factors) is GONE;
    // the depth now derives from the LATTICE'S OWN elements:
    //   · each dot's size hash (the user's size-variation + bias warp)
    //     picks its depth band — 5 bands, far→near;
    //   · each LINE's width hash picks the line's band (its segments
    //     ride together — a line stays coherent);
    //   · band k rides pan factor 1 + amp·(0.25 + 0.75·spread_k),
    //     spread ∈ [-0.85, +0.65] — at full amp the pf range is
    //     [0.61, 1.74]: the biggest dots move FASTER than the icons
    //     (pf > 1, in front), the smallest nearly pin (pf < 1, behind);
    //   · uniform sizes (variation off) = the mid plane (pf ≈ 1.18 at
    //     full amp) — the whole lattice floats, no fake stars;
    //   · the biggest elements keep the soft-glow halo + light-lifted
    //     tone of the v0.77 stack (the look the user likes) — on the
    //     USER'S OWN dots, not spawned circles;
    //   · the backdrop camera still slows 0.35 → 0.08 at full amp.
    // amp 0 is the byte-identical single-plane default (ONE band,
    // pf exactly 1, no filter, zero glow).
    var amp = (typeof st.spaceParallax === 'number') ? st.spaceParallax : 0;
    amp = Math.max(0, Math.min(100, amp)) / 100;
    var hideLines = !!st.hideGridLines;
    var hideDots = !!st.hideDots;
    // v0.75 THE TWO COLUMNS: every effect is per-side (dots/lines). The
    // legacy shared keys still leak through numOr (imported pre-v0.75
    // look bundles keep painting without a reload).
    function numOr(v, legacy) {
      if (typeof v === 'number') return v;
      if (typeof legacy === 'number') return legacy;
      return 0;
    }
    var scatterL = numOr(st.lineScatter, st.gridScatter);   // 0-100
    var scatterD = numOr(st.dotScatter, st.gridScatter);    // 0-100
    var sizeVarL = numOr(st.lineSizeVariation, st.gridSizeVariation);
    var sizeVarD = numOr(st.dotSizeVariation, st.gridSizeVariation);
    var rotVarL = numOr(st.lineRotation, st.gridRotation);  // 0-100 → deg
    var rotVarD = numOr(st.dotRotation, st.gridRotation);   // 0-100 → deg
    var biasL = (typeof st.lineSizeBias === 'number') ? st.lineSizeBias : 0;  // -100..100
    var biasD = (typeof st.dotSizeBias === 'number') ? st.dotSizeBias : 0;    // -100..100
    var animDots = !!st.dotAnimate;   // v0.75: twinkle
    var animLines = !!st.lineAnimate; // v0.75: axis drift
    var scatterPxL = scatterL * 0.6;        // 100 → 60px max
    var scatterPxD = scatterD * 0.6;
    // v0.75 (user spec item 2): the variation limit is DOUBLED — 100 now
    // means ±170%, so some dots nearly vanish and some grow huge, lines
    // get hair-thin and extra long. The paint floors keep them visible.
    // v0.83.1 THE WEIGHT (user spec: "make the largest and smallest sizes
    // double or 1.5x what they are now"): ±170% → ±340% — the biggest
    // dots reach 4.4× base (was 2.7×, +63%, inside the user's 1.5–2×
    // window) and the smallest ride the paint floors as before. The paint
    // floors keep them visible.
    var sizeFracL = sizeVarL / 100 * 3.4;  // 100 → ±340% of base
    var sizeFracD = sizeVarD / 100 * 3.4;
    // v0.81.1 THE BIAS ODDITY + v0.83.1 THE WEIGHT (user spec: "make the
    // size bias effect more… setting size bias to min makes big stars
    // very rare, same with lines, and vise versa"). Three halves:
    //   · BIAS INJECTS ITS OWN SPREAD — effFrac = max(sizeFrac,
    //     |bias|/100 · 1.7): full bias alone now paints the OLD full
    //     variation spread (was ±50%), so outliers always exist and the
    //     lattice/depth machinery (depthT/bandOf, the over-icons
    //     threshold) rides the SAME effFrac so depth follows what's painted.
    //   · the warp EXPONENT doubles (2^(-b) → 2^(-2b)): at ±100 the size
    //     hash warps as h⁴ / ∜h — at MIN the big hashes are pushed hard
    //     down (big stars genuinely RARE), at MAX the small hashes are
    //     pushed to ~1 (smalls RARE — the vise versa). Mid-bias stays a
    //     smooth tilt.
    //   · bias 0 → effFrac = sizeFrac and the warp is the identity → the
    //     pre-v0.81 frame, byte-identical (the no-bias path never shifts).
    var effFracL = Math.max(sizeFracL, Math.abs(biasL) / 100 * 1.7);
    var effFracD = Math.max(sizeFracD, Math.abs(biasD) / 100 * 1.7);
    var rotDegL = rotVarL * 0.6;           // 100 → 60deg max
    var rotDegD = rotVarD * 0.6;
    // v0.75 SIZE BIAS: a power warp on the per-element size hash — a
    // positive bias pushes the draw toward LARGER sizes, negative toward
    // smaller. v0.81.1 softened the warp (2^(-b), a ~75/25 split — the
    // then-spec wanted the opposite tail COMMON). v0.83.1 THE WEIGHT
    // (user spec: "setting size bias to min makes big stars very rare,
    // same with lines, and vise versa"): the warp SHARPENS to
    // 2^(-2.5·b) — at ±100 the exponent is 5 / 0.2, so at MIN the big
    // hashes are pushed hard down (P(h⁵ > 0.55) ≈ 11% barely-big,
    // ≈ 8% clearly-big ≥1.6× — RARE vs ~41% unbiased) and at MAX the
    // small hashes are pushed to ~1 (P(h^0.2 < 0.47) ≈ 2% — smalls
    // VERY rare, the vise versa). The effFrac floor rides the same
    // extremes (1.7 at full bias), so the favored side spans the full
    // doubled range. 0 stays the identity (no warp, and with
    // effFrac = sizeFrac there, byte-identical).
    var bExpL = Math.pow(2, -2.5 * (biasL / 100));
    var bExpD = Math.pow(2, -2.5 * (biasD / 100));
    function warpL(h) { return bExpL === 1 ? h : Math.pow(h, bExpL); }
    function warpD(h) { return bExpD === 1 ? h : Math.pow(h, bExpD); }
    // v0.83.3 THE FINGERPRINTS. fp = everything the DERIVED params read
    // (settings + scale + viewport); a change rebuilds the param caches.
    // cfp adds the camera (offsets) + the color specs — the pattern
    // samplers read screen positions and spec colors, which only move
    // with the camera or the theme. Settings edits rebuild both; pans
    // invalidate colors only (world-cell params are pan-invariant — the
    // stable-hash contract); ambient frames change NEITHER → 100% hits.
    var dotSpec = specs && specs.dotColor;
    var dotFallback = (HEX_RE.test(t.dotColor || '')) ? t.dotColor : '#2e2e3a';
    var lineSpec2 = specs && specs.lineColor;
    var lineFallback2 = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
    var fpNow = [scatterL, scatterD, sizeVarL, sizeVarD, rotVarL, rotVarD,
      biasL, biasD, animDots ? 1 : 0, animLines ? 1 : 0,
      scale.toFixed(4), st.gridSize, hideLines ? 1 : 0, hideDots ? 1 : 0,
      amp.toFixed(4), W, H,
      dotSpec ? JSON.stringify(dotSpec) : '', dotFallback,
      lineSpec2 ? JSON.stringify(lineSpec2) : '', lineFallback2].join('|');
    if (fpNow !== LC.fp) { LC.fp = fpNow; LC.gen++; lcClearParams(); }
    var cfpNow = fpNow + '|' + offsetX.toFixed(2) + ',' + offsetY.toFixed(2);
    if (cfpNow !== LC.cfp) { LC.cfp = cfpNow; LC.cgen++; lcClearColors(); }
    // v0.75 ANIMATE: the ambient clock (stable per-element phases come
    // from the hashes — no per-dot state, no drift).
    var animT = performance.now() / 1000;
    var dbgDots = 0, dbgSegs = 0;
    // v0.85.1: the glow twin (the rig proves the per-dot derivation: how
    // many dots glowed this frame + the DISTINCT colors they used — a
    // gradient dot spec must mint >1 color; a solid theme exactly 1).
    var dbgGlow = 0, dbgGlowCols = [];
    // v0.81.1: the bias-oddity instrument — per-frame size distribution
    // counters (the rigs prove "outliers appear at size 0 + bias" and
    // "the opposite tail is common, not rare"). Thresholds are ±10% off
    // the element's own base (dotRBase for dots, 1 for line widths).
    // Lines count EVERY painted element (full lines + segments) against
    // base width 1 so n matches what the counters saw.
    var dbgDotSmall = 0, dbgDotBig = 0, dbgLineSmall = 0, dbgLineBig = 0;
    var dbgFullLines = 0;
    // v0.83.1: the weight twin — per-frame size EXTREMES (the red-team
    // proves the doubled range + the bias tilt: min/max jr ratio and
    // min/max segment width, in units of their base).
    var dbgJrMin = Infinity, dbgJrMax = 0, dbgWMin = Infinity, dbgWMax = 0;

    const scaledGrid = gridSpacing() * scale;
    // v0.75: ONE frame — the lattice never lags (the v0.67 per-plane
    // anchoring is gone with the lag itself).
    const startX = ((-offsetX * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const startY = ((-offsetY * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const dStartX = startX;
    const dStartY = startY;

    // ── v0.45 ITEM 6: stable per-cell hash so jitter is deterministic ──
    // (the same grid cell always gets the same offset/size/rotation — no
    // shimmer on pan/zoom repaint). A 32-bit integer hash of (ix, iy).
    function hashCell(ix, iy) {
      var h = (ix | 0) * 374761393 + (iy | 0) * 668265263;
      h = (h ^ (h >>> 13)) * 1274126177;
      h = h ^ (h >>> 16);
      // normalize to [0,1)
      return ((h >>> 0) % 1000000) / 1000000;
    }

    // ── v0.77.9 THE DEPTH-BAND MACHINERY ─────────────────────────────
    // BANDS planes, far → near; the biggest elements ride the LAST band.
    // Deterministic: membership comes from the stable per-cell size
    // hashes (the same ones that size the elements), so nothing shimmers
    // or respawns while sliding — the v0.77 stack's random spawns are
    // gone entirely.
    var AMP_BANDS = 5;
    var bandSpread = function (k) { return -0.85 + 1.5 * (k / (AMP_BANDS - 1)); };
    var bandPF = function (k) { return 1 + amp * (0.25 + 0.75 * bandSpread(k)); };
    // the plane starts: each band wraps its own modulo (the starLayer
    // pattern — self-consistent infinite planes at their own pf)
    var bandStart = function (off, pf, grid) {
      return ((-off * scale * pf) % grid + grid) % grid;
    };
    // membership: the depth rides the SAME hash that sizes the element
    // (uniform sizes → the mid plane, no spread to fake)
    var depthT = function (h, sizeFrac) { return sizeFrac > 0.02 ? h : 0.5; };
    var bandOf = function (t) {
      var k = Math.floor(t * AMP_BANDS);
      return k < 0 ? 0 : (k >= AMP_BANDS ? AMP_BANDS - 1 : k);
    };
    // v0.83.3: the glow tint derives from the DOT'S OWN solid paint (the
    // light-lifted tone — the v0.77 intent). The old code read
    // ctx.fillStyle at frame start, which was whatever painted LAST the
    // previous frame (the origin dot, usually) — the halo tint silently
    // rode the wrong color whenever the origin was on screen.
    // v0.85.1 THE GLOW THEME WAVE (user spec: "Larger animated dots that
    // glow in the canvas panel don't follow theme colors nor does their
    // glow"): the spec-scope derivation had a real hole — for a 2+-stop
    // gradient dot color gridPaint returns a CanvasGradient OBJECT, so
    // the string test failed and the glow was NULL: the glow + the
    // lifted tone VANISHED entirely on gradient dot colors (the
    // appearance page's GradientUI makes those the default customization
    // UX!); for mesh/pat specs it collapsed to stops[0] — every glow dot
    // painted the FIRST stop while the regular dots sampled the pattern
    // per-dot. THE FIX: the glow derives from each DOT'S OWN COLOR at
    // paint time — the per-cell sampled color (colD, the exact color the
    // dot already paints, cached in LC.dotC) when a sampler is live,
    // else the spec's solid. Per-dot lifted hexes cache in LC.dotG
    // (cleared with the color caches); halo sprites stay per-color
    // (lcGlowSprite, capped). Now the cores AND the halos follow EVERY
    // dot-color source: theme solids, user gradients, mesh, patterns.
    var dotSolidFill = lcPaint(dotSpec, dotFallback);
    var specGlowFill = null;
    if (typeof dotSolidFill === 'string' && HEX_RE.test(dotSolidFill)) {
      specGlowFill = shadeHex(dotSolidFill, 0.42);
    }

    // the dot color + pattern sampler (v0.77: hoisted to function scope —
    // the amplifier's far/mid star layers sample the same field, and they
    // paint before the dots block runs; v0.83.3: cached by spec — the
    // mesh 8-spot table was rebuilt per frame)
    var dotSampler = lcSampler(dotSpec, dotFallback);

    // the base dot radius (v0.76: hoisted to function scope — the
    // amplifier's star layers scale against it and the far/mid layers
    // paint before the dots block runs)
    var dotRBase = Math.max(0.6, DOT_RADIUS * Math.min(scale, 1.3));

    // ── v0.81.2 THE OVER-ICONS LAYER ────────────────────────────
    // User spec: "with grid parallax at max AND amplify parallax ≥50%,
    // dots/lines exceeding 70% of max allowed random size must render
    // ABOVE canvas icons instead of beneath them." The app has ONE
    // parallax dial — Amplify parallax (the v0.75 rename of Space
    // parallax; grid + amplify are the same slider) — so "grid parallax
    // at max AND amplify ≥50%" resolves to the amplifier ≥ 50% (its own
    // hint already promised "YOUR biggest dots + lines sweep closest
    // (past the icons)" — the MOTION kept that promise via pf > 1; this
    // wave makes the PAINT ORDER honor it too: the qualifying elements
    // draw on #c2, a twin canvas ABOVE #chatbots, below dragged bots).
    // Thresholds: 70% of the MAX ALLOWED RANDOM SIZE — dots: 0.7 ×
    // dotRBase·(1+effFracD); lines: 0.7 × 1·(1+effFracL) (base width 1).
    // Uniform sides exempt themselves exactly like the depth lattice
    // (depthT's own > 0.02 rule — no spread → no "biggest" to bring
    // forward): with effFrac ≤ 0.02 nothing routes over the icons.
    // The c2 frame is cleared every paint (below); amp < 0.5 leaves it
    // empty — byte-identical default at any size settings.
    var overDotsOn = !!(ctx2 && amp >= 0.5 && effFracD > 0.02);
    var overLinesOn = !!(ctx2 && amp >= 0.5 && effFracL > 0.02);
    var overThreshD = 0.7 * dotRBase * (1 + effFracD);
    var overThreshL = 0.7 * (1 + effFracL);
    var dbgOverDots = 0, dbgOverLines = 0;
    if (ctx2) ctx2.clearRect(0, 0, W, H);

    // v0.77 THE SHOOTING-STAR SHUTTLE (user spec: "make them shoot like
    // shooting stars back and forth, moving slowly at first, then at an
    // exponential curve they move fast to the new location then back at
    // another exponential curve with slight variations"). Each segment
    // flies ALONG its own axis between two points: the forward leg eases
    // IN on one exponent (slow start → hard arrival), the return leg on
    // ANOTHER (per-segment variation: distance, duration, sharpness,
    // direction, phase — all from the stable cell hashes, no state). The
    // normalized speed rides back for the brightness ramp — the meteor
    // brightens as it rushes.
    // v0.77 THE SHOOTING-STAR SHUTTLE … v0.83.1 THE PENDULUM (user spec:
    // "Lines should also not snap back to their starting position when
    // animate is on, instead, they should swing back like they do forth,
    // and go for larger distances"). The v0.77 return leg INVERTED the
    // travel (0.5 − eased with s = 2−u), so at the leg boundary u=1 the
    // segment TELEPORTED from +0.5·dist to −0.5·dist — every return began
    // with the snap-back the user saw. THE FIX: both legs share
    // travel = eased − 0.5; on the return s = 2−u runs eased 1→0, so
    // travel runs +0.5→−0.5 CONTINUOUSLY — a true swing back along the
    // same axis, easing out of the far point and decelerating into the
    // near one (the mirror of the forth's slow-start/hard-arrival), with
    // the per-segment kB variation intact. The distance DOUBLES the
    // reach: 0.45–1.2× spacing → 0.8–2.0× (the "larger distances").
    function shuttleP(p) {
      // p = the cached per-segment record {dur, kF, kB, ekF, ekB, dist, dir, ph}
      var u = ((animT + p.ph) / p.dur) % 2;
      var legFwd = u < 1;
      var s = legFwd ? u : 2 - u;                             // leg progress 0..1
      var k = legFwd ? p.kF : p.kB;
      var eased = (Math.exp(k * s) - 1) / ((legFwd ? p.ekF : p.ekB) - 1); // exponential ease-in
      var travel = eased - 0.5;                               // −0.5…+0.5, CONTINUOUS at both leg boundaries
      return { off: p.dir * p.dist * travel, spd: Math.exp(k * (s - 1)) };
    }
    // the cached shuttle record for a segment cell (6 stable hashes + the
    // two per-leg exp bases — all settings-derived, none time-dependent)
    function shuttleRec(hx, hy) {
      var dur = 1.6 + hashCell(hx + 17, hy + 17) * 2.4;
      var kF = 2.6 + hashCell(hx + 19, hy + 19) * 1.6;
      var kB = 2.2 + hashCell(hx + 21, hy + 21) * 1.6;
      return {
        dur: dur, kF: kF, kB: kB, ekF: Math.exp(kF), ekB: Math.exp(kB),
        dist: 0.8 + hashCell(hx + 23, hy + 23) * 1.2,          // × spacing (v0.83.1: larger)
        dir: hashCell(hx + 25, hy + 25) < 0.5 ? -1 : 1,        // along its axis
        ph: hashCell(hx + 27, hy + 27) * dur                    // phase stagger
      };
    }

    // v0.77.9: the line passes run PER BAND (far → near); amp 0 is the
    // single unfiltered plane (pf exactly 1 — byte-identical default).
    // v0.85.1 THE BATCHER: every dot/segment/full-line paint op collects
    // into BUCKETS keyed (target layer, QUANTIZED style, quantized alpha)
    // — same-style elements share ONE path and ONE fill/stroke. Two
    // structural choices make the mesh worst case (continuous per-cell
    // colors, the 44fps case) actually collapse:
    //   · COLOR QUANTIZATION — the bucket key AND the painted color round
    //     to 16 levels/channel (steps of 17). A smooth mesh field yields
    //     tens of local colors instead of one-per-element; on 1–4px
    //     lattice elements a ±8/255 banding step is invisible.
    //   · SEGMENTS AS FILLED QUADS — a butt-capped stroke of width w is
    //     EXACTLY the rectangle with the segment as centerline (the
    //     corners ride the cached rotation cos/sin — no per-segment
    //     hypot). Filling quads removes lineWidth from the canvas state,
    //     so segments bucket by (color × alpha) alone — the per-element
    //     width stays per-element as GEOMETRY.
    // Alpha quantizes at 1/8 (dots) / 1/10 (segments); the shuttle
    // brightness ramp stays visually smooth. >640 buckets → the
    // per-element fallback (the pre-batcher path; never worse).
    var segBuckets = new Map();
    var dotBuckets = new Map();
    var dbgBatches = 0;
    var lineBands = amp > 0 ? AMP_BANDS : 1;
    var dbgLineBands = [];
    if (!hideLines) {
     for (var lb = 0; lb < lineBands; lb++) {
      var lPF = lineBands === 1 ? 1 : bandPF(lb);
      var lStartX = lineBands === 1 ? startX : bandStart(offsetX, lPF, scaledGrid);
      var lStartY = lineBands === 1 ? startY : bandStart(offsetY, lPF, scaledGrid);
      var lBandN = 0;
      var lineSpec = specs && specs.lineColor;
      var lineFallback = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
      // v0.83.3: the band style + sampler ride the spec caches (they were
      // rebuilt — a fresh CanvasGradient + the mesh 8-spot table — every
      // band of every frame). v0.85.1: hoisted to a var — the batcher's
      // style resolution (colS || lineBandStyle) must never read the live
      // ctx.strokeStyle (whose value the mesh path repainted last).
      var lineBandStyle = lcPaint(lineSpec, lineFallback);
      ctx.strokeStyle = lineBandStyle;
      ctx.lineWidth = 1;
      // v0.54: pattern-aware per-line sampling — multi-stop line specs
      // paint each line (and, in segment mode, each segment) at its own
      // point on the gradient/pattern, mirroring the background's exact
      // geometry (sweeps, mesh spots, checker cells, stripe bands…).
      var lineSampler = lcSampler(lineSpec, lineFallback);
      var lineIdx = 0;
      // v0.49 (user spec: "for grid lines it should change both height
      // and width, not just width"): when Size variation is on, each line
      // renders as per-cell SEGMENTS centered on the intersections —
      // the segment's LENGTH and THICKNESS both ride the variation (the
      // dots' behavior, applied to lines). size 0 = full continuous
      // lines exactly as before.
      // v0.75: animated lines render as segments too — a full line
      // translated along its own axis is invisible, so the drift needs
      // the finite form (the base length 1.35× spacing overlaps the
      // neighbors and still reads continuous).
      var segMode = effFracL > 0 || animLines;
      var baseSegLen = scaledGrid * 1.35;
      for (let x = lStartX; x < W; x += scaledGrid) {
        // v0.45 ITEM 6: per-line jitter (scatter + rotation + size) —
        // v0.83.3: the whole derived record is cached per line (the
        // stable-hash contract means it never changes between settings
        // edits); cos/sin of the rotation are cached with it.
        var ix = Math.round((x + offsetX * scale * lPF) / scaledGrid);
        var LP = LC.vline.get(ix);
        if (LP === undefined) {
          var lwH = warpL(hashCell(ix, 2));
          var rotD = rotDegL * (hashCell(ix, 1) - 0.5) * 2;   // degrees
          var rr = rotD * Math.PI / 180;
          LP = {
            dx: scatterPxL * (hashCell(ix, 0) - 0.5) * 2,
            lwB: 1 * (1 + effFracL * (lwH - 0.5) * 2),
            band: bandOf(depthT(lwH, effFracL)),
            c: Math.cos(rr), s: Math.sin(rr)
          };
          LC.vline.set(ix, LP);
          if (LC.vline.size > 8192) LC.vline.clear();
        }
        // v0.77.9: the line's depth band rides its WIDTH hash — the
        // whole line (all its segments) stays one coherent plane
        if (lineBands > 1 && LP.band !== lb) continue;
        lBandN++;
        if (LP.lwB < 0.9) dbgLineSmall++; else if (LP.lwB > 1.1) dbgLineBig++;
        // v0.81.2: the whole line's plane — over-icons when its width
        // hash exceeds 70% of the max allowed random width (full-line
        // mode rides the line's own width; segment mode re-decides per
        // segment below — segments are the per-element form)
        var lc = (overLinesOn && !segMode && LP.lwB > overThreshL) ? ctx2 : ctx;
        if (lc === ctx2) dbgOverLines++;
        // v0.83.3: NO canvas transforms — the rotated frame's points map
        // manually: translate(tx,0)∘rotate(θ) sends (0,ly) → (tx−ly·s, ly·c)
        var tx = x + LP.dx;
        if (!segMode) {
          // the per-line color (cached; segments decide their own below)
          var colL = LC.vlineC.get(ix);
          if (colL === undefined) { colL = lineSampler ? lineSampler(x, H / 2) : null; LC.vlineC.set(ix, colL); LC.misses++; } else LC.hits++;
          dbgFullLines++;
          // v0.85.1: batched — the full line is a FILLED QUAD (the
          // butt-stroke rectangle; width rides the geometry) → the bucket
          // key is (layer × quantized color), width never enters state
          var styleL = quantColor(colL || lineBandStyle);
          var lwFull = Math.max(0.3, LP.lwB);
          var pxv = LP.c * lwFull / 2, pyv = LP.s * lwFull / 2;  // perp offset
          var fbk = (lc === ctx2 ? '2|' : '1|') + styleL;
          var fb = segBuckets.get(fbk);
          if (!fb) { fb = { sc: lc, s: styleL, a: 1, ops: [] }; segBuckets.set(fbk, fb); }
          fb.ops.push(tx - pxv, 0 - pyv, tx + pxv, 0 + pyv,
                      (tx - H * LP.s) + pxv, H * LP.c + pyv, (tx - H * LP.s) - pxv, H * LP.c - pyv);
        } else {
          for (let y = lStartY - scaledGrid; y < H + scaledGrid; y += scaledGrid) {
            var iyS = Math.round((y + offsetY * scale * lPF) / scaledGrid);
            // v0.83.3: the per-segment record (length + width + shuttle
            // params) cached by cell — the hashes are stable, only the
            // time-dependent flight is computed live.
            var skey = lcKey(ix, iyS);
            var SP = LC.vseg.get(skey);
            if (SP === undefined) {
              // v0.77: in animate mode (with size variation off) the dash
              // gets its own random length and width — the user's
              // "shrinking them by width or height or both at random
              // variations", folded into the shooting-star spec. The lengths
              // stay WELL UNDER the spacing (0.3–0.85×): v0.75.1's 1.35×
              // overlaps read as a CONTINUOUS line (the VLM red-team saw
              // zero motion) — a shooting star needs the separated form.
              // (the v0.73 wave's ±170% floor rides the size-variation
              // path: the small end would draw a NEGATIVE length — an
              // inverted segment; the floor keeps it a visible speck-streak.)
              SP = {
                len: (animLines && effFracL === 0)
                  ? scaledGrid * (0.30 + hashCell(ix + 31, iyS + 33) * 0.55)
                  : Math.max(scaledGrid * 0.06,
                      (effFracL > 0 ? scaledGrid : baseSegLen) * (1 + effFracL * (warpL(hashCell(ix + 5, iyS)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(ix + 35, iyS + 37) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(ix + 9, iyS)) - 0.5) * 2)),
                sh: shuttleRec(ix + 41, iyS + 43)
              };
              LC.vseg.set(skey, SP);
              if (LC.vseg.size > 24576) LC.vseg.clear();
            }
            var segW = SP.w;
            if (segW < 0.9) dbgLineSmall++; else if (segW > 1.1) dbgLineBig++;
            if (segW < dbgWMin) dbgWMin = segW;
            if (segW > dbgWMax) dbgWMax = segW;
            // v0.77 ANIMATE LINES — THE SHOOTING STAR: the segment
            // shuttles ALONG the line's own (rotated) axis — with the
            // exponential two-curve flight (see shuttleP). Brightness
            // rides the speed: the dash dims at rest, flashes as it
            // rushes.
            var drift = 0, tal = 1;
            if (animLines) {
              var sh = shuttleP(SP.sh);
              drift = sh.off * scaledGrid;
              tal = 0.42 + 0.58 * sh.spd;
            }
            // v0.81.2: each segment qualifies by its OWN width — the
            // per-element form of a line ("lines get the dots' behavior"
            // extended to layering: the fat dashes pass in front of the
            // icons, the thin ones stay behind)
            var sc = (overLinesOn && segW > overThreshL) ? ctx2 : ctx;
            if (sc === ctx2) dbgOverLines++;
            // v0.83.3: the per-segment color, cached per cell while the
            // camera rests (was a live sampler call per segment per frame)
            var colS = LC.vsegC.get(skey);
            if (colS === undefined) { colS = lineSampler ? lineSampler(x, y) : null; LC.vsegC.set(skey, colS); LC.misses++; } else LC.hits++;
            // v0.85.1: batched — the segment is a FILLED QUAD (the exact
            // butt-stroke rectangle: centerline ± perp×w/2, corners from
            // the cached rotation cos/sin) → buckets key on (layer ×
            // quantized color × 1/10 alpha) only; the width rides geometry
            var styleS = quantColor(colS || lineBandStyle);
            var aQ = tal < 1 ? Math.round(tal * 10) / 10 : 1;
            var sbk = (sc === ctx2 ? '2|' : '1|') + styleS + '|' + aQ;
            var sb = segBuckets.get(sbk);
            if (!sb) { sb = { sc: sc, s: styleS, a: aQ, ops: [] }; segBuckets.set(sbk, sb); }
            // manual transform of translate(tx,0)∘rotate(θ): (0,ly) → (tx−ly·s, ly·c)
            var ly1 = y - SP.len / 2 + drift, ly2 = y + SP.len / 2 + drift;
            var ax1 = tx - ly1 * LP.s, ay1 = ly1 * LP.c;
            var ax2 = tx - ly2 * LP.s, ay2 = ly2 * LP.c;
            var pxs = LP.c * segW / 2, pys = LP.s * segW / 2;   // perp offset × w/2
            sb.ops.push(ax1 - pxs, ay1 - pys, ax1 + pxs, ay1 + pys,
                        ax2 + pxs, ay2 + pys, ax2 - pxs, ay2 - pys);
            dbgSegs++;
          }
        }
        lineIdx++;
      }
      for (let y = lStartY; y < H; y += scaledGrid) {
        var iy = Math.round((y + offsetY * scale * lPF) / scaledGrid);
        // v0.83.3: the horizontal line's cached derived record (band +
        // jitter + rotation cos/sin + width) — the vertical block's twin
        var HP = LC.hline.get(iy);
        if (HP === undefined) {
          var lw2H = warpL(hashCell(2, iy));
          var rot2D = rotDegL * (hashCell(1, iy) - 0.5) * 2;
          var rr2 = rot2D * Math.PI / 180;
          HP = {
            dy: scatterPxL * (hashCell(0, iy) - 0.5) * 2,
            lwB: 1 * (1 + effFracL * (lw2H - 0.5) * 2),
            band: bandOf(depthT(lw2H, effFracL)),
            c: Math.cos(rr2), s: Math.sin(rr2)
          };
          LC.hline.set(iy, HP);
          if (LC.hline.size > 8192) LC.hline.clear();
        }
        // v0.77.9: the horizontal line's band rides its width hash
        if (lineBands > 1 && HP.band !== lb) continue;
        lBandN++;
        if (HP.lwB < 0.9) dbgLineSmall++; else if (HP.lwB > 1.1) dbgLineBig++;
        // v0.81.2: the horizontal twin of the vertical block's routing
        var lc2 = (overLinesOn && !segMode && HP.lwB > overThreshL) ? ctx2 : ctx;
        if (lc2 === ctx2) dbgOverLines++;
        // v0.83.3: manual transform — translate(0,ty)∘rotate(θ) sends
        // (lx,0) → (lx·c, ty+lx·s)
        var ty = y + HP.dy;
        if (!segMode) {
          var colL2 = LC.hlineC.get(iy);
          if (colL2 === undefined) { colL2 = lineSampler ? lineSampler(W / 2, y) : null; LC.hlineC.set(iy, colL2); LC.misses++; } else LC.hits++;
          dbgFullLines++;
          // v0.85.1: batched — the horizontal full-line quad twin
          var styleL2 = quantColor(colL2 || lineBandStyle);
          var lwFull2 = Math.max(0.3, HP.lwB);
          var pxh = -HP.s * lwFull2 / 2, pyh = HP.c * lwFull2 / 2;  // perp of (c,s)
          var fbk2 = (lc2 === ctx2 ? '2|' : '1|') + styleL2;
          var fb2 = segBuckets.get(fbk2);
          if (!fb2) { fb2 = { sc: lc2, s: styleL2, a: 1, ops: [] }; segBuckets.set(fbk2, fb2); }
          fb2.ops.push(0 - pxh, ty - pyh, 0 + pxh, ty + pyh,
                       W * HP.c + pxh, ty + W * HP.s + pyh, W * HP.c - pxh, ty + W * HP.s - pyh);
        } else {
          for (let x2 = lStartX - scaledGrid; x2 < W + scaledGrid; x2 += scaledGrid) {
            var ixS = Math.round((x2 + offsetX * scale * lPF) / scaledGrid);
            // v0.83.3: the horizontal segment record — the vertical twin
            var hkey = lcKey(ixS, iy);
            var HS = LC.hseg.get(hkey);
            if (HS === undefined) {
              // v0.77: the shooting-star twin of the vertical block —
              // separated random dash lengths + widths in animate mode
              // (with the v0.73 ±170% floor riding the size-variation path,
              // exactly as the vertical block).
              HS = {
                len: (animLines && effFracL === 0)
                  ? scaledGrid * (0.30 + hashCell(ixS + 33, iy + 31) * 0.55)
                  : Math.max(scaledGrid * 0.06,
                      (effFracL > 0 ? scaledGrid : baseSegLen) * (1 + effFracL * (warpL(hashCell(ixS, iy + 5)) - 0.5) * 2)),
                w: Math.max(0.12,
                  (animLines ? (0.9 + hashCell(ixS + 37, iy + 35) * 0.9) : 1) *
                  (1 + effFracL * (warpL(hashCell(ixS, iy + 9)) - 0.5) * 2)),
                sh: shuttleRec(ixS + 47, iy + 49)   // decorrelated salts from the vertical axis
              };
              LC.hseg.set(hkey, HS);
              if (LC.hseg.size > 24576) LC.hseg.clear();
            }
            var segW2 = HS.w;
            if (segW2 < 0.9) dbgLineSmall++; else if (segW2 > 1.1) dbgLineBig++;
            if (segW2 < dbgWMin) dbgWMin = segW2;
            if (segW2 > dbgWMax) dbgWMax = segW2;
            var drift2 = 0, tal2 = 1;
            if (animLines) {
              var sh2 = shuttleP(HS.sh);
              drift2 = sh2.off * scaledGrid;
              tal2 = 0.42 + 0.58 * sh2.spd;
            }
            // v0.81.2: per-segment routing — the horizontal twin
            var sc2 = (overLinesOn && segW2 > overThreshL) ? ctx2 : ctx;
            if (sc2 === ctx2) dbgOverLines++;
            var colS2 = LC.hsegC.get(hkey);
            if (colS2 === undefined) { colS2 = lineSampler ? lineSampler(x2, y) : null; LC.hsegC.set(hkey, colS2); LC.misses++; } else LC.hits++;
            // v0.85.1: batched — the horizontal segment quad twin
            var styleS2 = quantColor(colS2 || lineBandStyle);
            var aQ2 = tal2 < 1 ? Math.round(tal2 * 10) / 10 : 1;
            var sbk2 = (sc2 === ctx2 ? '2|' : '1|') + styleS2 + '|' + aQ2;
            var sb2 = segBuckets.get(sbk2);
            if (!sb2) { sb2 = { sc: sc2, s: styleS2, a: aQ2, ops: [] }; segBuckets.set(sbk2, sb2); }
            // manual transform: (lx,0) → (lx·c, ty+lx·s)
            var lx1 = x2 - HS.len / 2 + drift2, lx2 = x2 + HS.len / 2 + drift2;
            var bx1 = lx1 * HP.c, by1 = ty + lx1 * HP.s;
            var bx2 = lx2 * HP.c, by2 = ty + lx2 * HP.s;
            var pxs2 = -HP.s * segW2 / 2, pys2 = HP.c * segW2 / 2;  // perp × w/2
            sb2.ops.push(bx1 - pxs2, by1 - pys2, bx1 + pxs2, by1 + pys2,
                         bx2 + pxs2, by2 + pys2, bx2 - pxs2, by2 - pys2);
            dbgSegs++;
          }
        }
      }
      dbgLineBands.push(lBandN);
     }
    }
    // v0.85.1: FLUSH THE SEGMENT BUCKETS — every segment is a filled
    // quad; one beginPath + one fill per bucket (moveTo per quad +
    // closePath = no connectors). >640 buckets → the per-element
    // fallback (the pre-batcher path — never worse than before).
    if (segBuckets.size && segBuckets.size <= 640) {
      segBuckets.forEach(function (bk) {
        var sc = bk.sc;
        sc.fillStyle = bk.s;
        if (bk.a < 1) sc.globalAlpha = bk.a;
        sc.beginPath();
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 8) {
          sc.moveTo(ops[oi], ops[oi + 1]);
          sc.lineTo(ops[oi + 2], ops[oi + 3]);
          sc.lineTo(ops[oi + 4], ops[oi + 5]);
          sc.lineTo(ops[oi + 6], ops[oi + 7]);
          sc.closePath();
        }
        sc.fill();
        if (bk.a < 1) sc.globalAlpha = 1;
        dbgBatches++;
      });
    } else if (segBuckets.size) {
      segBuckets.forEach(function (bk) {
        var sc = bk.sc;
        sc.fillStyle = bk.s;
        if (bk.a < 1) sc.globalAlpha = bk.a;
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 8) {
          sc.beginPath();
          sc.moveTo(ops[oi], ops[oi + 1]);
          sc.lineTo(ops[oi + 2], ops[oi + 3]);
          sc.lineTo(ops[oi + 4], ops[oi + 5]);
          sc.lineTo(ops[oi + 6], ops[oi + 7]);
          sc.closePath();
          sc.fill();
        }
        if (bk.a < 1) sc.globalAlpha = 1;
        dbgBatches++;
      });
    }

    // v0.77.9: the dot passes run PER BAND (far → near); amp 0 is the
    // single unfiltered plane (pf exactly 1 — byte-identical default).
    var dotBands = amp > 0 ? AMP_BANDS : 1;
    var dbgDotBands = [];
    if (!hideDots) {
     for (var db = 0; db < dotBands; db++) {
      var dPF = dotBands === 1 ? 1 : bandPF(db);
      var dStartX2 = dotBands === 1 ? dStartX : bandStart(offsetX, dPF, scaledGrid);
      var dStartY2 = dotBands === 1 ? dStartY : bandStart(offsetY, dPF, scaledGrid);
      var dBandN = 0;
      // v0.83.3: the band style rides the spec cache (a fresh
      // CanvasGradient was created per band per frame)
      ctx.fillStyle = dotSolidFill;
      // v0.54: pattern-aware per-dot sampling — each dot picks its color
      // from the SAME gradient/pattern field the background paints
      // (sweeps, mesh spots, checker cells, stripe bands, ray sectors…),
      // world-anchored so panning slides the palette through the lattice
      // without shimmer. (dotSpec/dotSampler live at function scope.)
      const dotR = dotRBase;
      for (let x = dStartX2; x < W; x += scaledGrid) {
        for (let y = dStartY2; y < H; y += scaledGrid) {
          // v0.45 ITEM 6: per-dot jitter (scatter + size) — v0.83.3: the
          // whole derived record is cached per world cell (stable hashes;
          // the pre-pulse size, the jitter, the band, and — when the
          // twinkle is on — the pulse/orbit parameters; only the
          // time-dependent sin/cos run live).
          var dix = Math.round((x + offsetX * scale * dPF) / scaledGrid);
          var diy = Math.round((y + offsetY * scale * dPF) / scaledGrid);
          var dkey = lcKey(dix, diy);
          var DP = LC.dot.get(dkey);
          if (DP === undefined) {
            var hd = hashCell(dix, diy);
            // v0.75: the size hash is BIAS-WARPED (favor larger/smaller).
            var hd2 = warpD(hashCell(dix + 7, diy + 7));
            DP = {
              jx: scatterPxD * (hd - 0.5) * 2,
              jy: scatterPxD * (hashCell(dix + 3, diy + 5) - 0.5) * 2,
              jrB: dotR * (1 + effFracD * (hd2 - 0.5) * 2),
              band: bandOf(depthT(hd2, effFracD))
            };
            if (animDots) {
              DP.tsp = 0.5 + hashCell(dix + 21, diy + 21) * 1.8;   // pulse rad/s
              DP.tph = hashCell(dix + 23, diy + 23) * 6.283;
              DP.ospd = (0.25 + hashCell(dix + 27, diy + 27) * 0.9)  // orbit rad/s
                        * (hashCell(dix + 29, diy + 29) < 0.5 ? -1 : 1);
              DP.orR = scaledGrid * (0.06 + 0.08 * hashCell(dix + 31, diy + 31));
            }
            LC.dot.set(dkey, DP);
            if (LC.dot.size > 24576) LC.dot.clear();
          }
          // v0.77.9: the SIZE picks the DEPTH — biggest = closest
          if (dotBands > 1 && DP.band !== db) continue;
          dBandN++;
          var jr = DP.jrB;
          if (jr < dotRBase * 0.9) dbgDotSmall++; else if (jr > dotRBase * 1.1) dbgDotBig++;
          // v0.83.1: the weight twin — ratio extremes (pre-pulse, pre-floor
          // floors would mask the true spread)
          var jrRaw = jr / dotRBase;
          if (jrRaw < dbgJrMin) dbgJrMin = jrRaw;
          if (jrRaw > dbgJrMax) dbgJrMax = jrRaw;
          // v0.81.2 THE OVER-ICONS LAYER: this dot renders ABOVE the
          // chatbot icons when the amplifier is ≥ 50% and its (stable,
          // pre-pulse) size exceeds 70% of the max allowed random size —
          // the paint-order half of the "past the icons" promise. The
          // animate pulse scales whichever layer the dot rides (no
          // threshold flicker — qualification uses the hash size).
          var dc = (overDotsOn && jr > overThreshD) ? ctx2 : ctx;
          if (dc === ctx2) dbgOverDots++;
          // v0.75 ANIMATE DOTS — the twinkle (user spec: "rotate and
          // grow/shrink at varying speeds"): a scale PULSE (grow/shrink,
          // ±40%) + a small ORBIT around the lattice anchor (the visible
          // rotation — a circle spinning in place is invisible), each
          // dot at its own speed/phase/direction, brightness riding the
          // pulse so it reads as a twinkle. Stable hashes = no state.
          var tox = 0, toy = 0, tal = 1;
          if (animDots) {
            var pulse = Math.sin(animT * DP.tsp + DP.tph);
            jr *= 1 + 0.4 * pulse;
            tal = 0.62 + 0.38 * (0.5 + 0.5 * pulse);
            var orA = animT * DP.ospd + DP.tph;
            tox = Math.cos(orA) * DP.orR; toy = Math.sin(orA) * DP.orR;
          }
          // v0.83.3: the per-dot color, cached per cell while the camera
          // rests (was a live sampler call per dot per frame — the mesh
          // spot loop + sqrt ×1508/frame)
          var colD = LC.dotC.get(dkey);
          if (colD === undefined) { colD = dotSampler ? dotSampler(x + DP.jx, y + DP.jy) : null; LC.dotC.set(dkey, colD); LC.misses++; } else LC.hits++;
          var styleD = quantColor(colD || dotSolidFill);
          // v0.77.9: the near band's BIGGEST dots catch the light — the
          // v0.77 glow look on the user's own elements (a halo under the
          // core + the light-lifted tone), never spawned circles.
          // v0.83.3: the halo is a prerendered SPRITE per color (the
          // per-dot createRadialGradient is gone); the core paints
          // WITHOUT save/translate/rotate/restore — rotation is invisible
          // on circles, so the arc lands directly at screen coords.
          // v0.85.1 (perf wave): the glow dots stay INDIVIDUAL (rare — near
          // band, jr >= 1.6x base, big-dot only); every other dot collects
          // into a bucket — same (style x alpha) dots share ONE path + ONE
          // fill (moveTo to the arc's own start kills the connector).
          // v0.85.1 (glow wave): the glow tint is PER-DOT — this dot's
          // lifted color, derived from its OWN paint color (colD when a
          // sampler is live, else the spec solid), cached in LC.dotG with
          // the same invalidation as colD. Gradient/mesh/pattern dot
          // colors now glow in their own per-dot colors (the v0.83.3
          // spec-scope glowFill silently killed the glow on gradient specs
          // and flattened it to stops[0] on patterns).
          var isGlowCand = dotBands > 1 && db === AMP_BANDS - 1 && jr >= dotRBase * 1.6;
          var glowFill = undefined;
          if (isGlowCand) {
            glowFill = LC.dotG.get(dkey);          // undefined | hex | false
            if (glowFill === undefined) {
              var base = (typeof colD === 'string' && HEX_RE.test(colD)) ? colD : null;
              if (base !== null) glowFill = shadeHex(base, 0.42);
              else if (specGlowFill) glowFill = specGlowFill;
              else glowFill = false;               // no derivable color — glow-less
              LC.dotG.set(dkey, glowFill);
            }
            if (!glowFill) glowFill = null;
          }
          var nearGlow = isGlowCand && !!glowFill;
          if (nearGlow) dc.fillStyle = glowFill;          var cx = x + DP.jx + tox, cy = y + DP.jy + toy;
          var rrD = Math.max(0.15, jr);
          if (nearGlow) {
            dc.fillStyle = glowFill;
            if (tal < 1) dc.globalAlpha = tal;
            if (jr >= 1.6) {
              var spG = lcGlowSprite(glowFill);
              var R = jr * 2.6;
              var ga2 = dc.globalAlpha;
              dc.globalAlpha = ga2 * 0.55;
              dc.drawImage(spG.c, cx - R, cy - R, R * 2, R * 2);
              dc.globalAlpha = ga2;
            }
            dc.beginPath();
            dc.arc(cx, cy, rrD, 0, Math.PI * 2);
            dc.fill();
            if (tal < 1) dc.globalAlpha = 1;
          } else {
            var aQ = tal < 1 ? Math.round(tal * 8) / 8 : 1;
            var dbk = (dc === ctx2 ? '2|' : '1|') + styleD + '|' + aQ;
            var dob = dotBuckets.get(dbk);
            if (!dob) { dob = { dc: dc, s: styleD, a: aQ, ops: [] }; dotBuckets.set(dbk, dob); }
            dob.ops.push(cx, cy, rrD);
          }
          dbgDots++;
          if (nearGlow) {
            dbgGlow++;
            if (dbgGlowCols.indexOf(glowFill) < 0) dbgGlowCols.push(glowFill);
          }
        }
      }
      dbgDotBands.push(dBandN);
     }
    }
    // v0.85.1: FLUSH THE DOT BUCKETS — one beginPath + ONE fill per
    // (style × alpha × layer) bucket. Solid specs collapse the whole
    // lattice to a single fill (was ~1500 fills); mesh fields paint in
    // tens. The >640-bucket guard falls back to per-dot fills.
    if (dotBuckets.size && dotBuckets.size <= 640) {
      dotBuckets.forEach(function (bk) {
        var dc = bk.dc;
        dc.fillStyle = bk.s;
        if (bk.a < 1) dc.globalAlpha = bk.a;
        dc.beginPath();
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 3) {
          var ocx = ops[oi], ocy = ops[oi + 1], orr = ops[oi + 2];
          dc.moveTo(ocx + orr, ocy);
          dc.arc(ocx, ocy, orr, 0, Math.PI * 2);
        }
        dc.fill();
        if (bk.a < 1) dc.globalAlpha = 1;
        dbgBatches++;
      });
    } else if (dotBuckets.size) {
      dotBuckets.forEach(function (bk) {
        var dc = bk.dc;
        dc.fillStyle = bk.s;
        var ops = bk.ops;
        for (var oi = 0; oi < ops.length; oi += 3) {
          var ocx = ops[oi], ocy = ops[oi + 1], orr = ops[oi + 2];
          if (bk.a < 1) dc.globalAlpha = bk.a;
          dc.beginPath();
          dc.moveTo(ocx + orr, ocy);
          dc.arc(ocx, ocy, orr, 0, Math.PI * 2);
          dc.fill();
        }
        if (bk.a < 1) dc.globalAlpha = 1;
        dbgBatches++;
      });
    }

    const o = worldToScreen(0, 0);
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      ctx.fillStyle = lcPaint(specs && specs.originColor, (HEX_RE.test(t.originColor || '')) ? t.originColor : '#4a4a5e');
      ctx.beginPath();
      ctx.arc(o.x, o.y, ORIGIN_RADIUS * Math.min(scale, 1.5), 0, Math.PI * 2);
      ctx.fill();
    }
    // v0.83.3: the rolling fps instrument + the cache telemetry (red-team
    // reads both: fps proves the wave, the cache sizes prove the hits —
    // stable sizes during ambient = everything served from the Maps)
    var lcNow = performance.now();
    if (lcLastT) lcFps = lcFps * 0.9 + (1000 / (lcNow - lcLastT)) * 0.1;
    lcLastT = lcNow;
    window.DoomalayDebug = { stars: 0, dots: dbgDots, segs: dbgSegs, amp: amp,
      dotBands: dbgDotBands, lineBands: dbgLineBands,
      // v0.81.1: the size-distribution twin (bias-oddity contract)
      dotStats: { small: dbgDotSmall, big: dbgDotBig, n: dbgDots },
      lineStats: { small: dbgLineSmall, big: dbgLineBig, n: dbgSegs + dbgFullLines },
      // v0.83.1: the weight twin — the frame's size EXTREMES (ratios vs
      // base; Infinity/0 when that side painted nothing this frame)
      weight: { jrMin: dbgJrMin, jrMax: dbgJrMax, wMin: dbgWMin, wMax: dbgWMax,
        effFracD: effFracD, effFracL: effFracL },
      // v0.81.2: the over-icons twin — what routed ABOVE #chatbots this
      // frame (dots + lines: full lines AND segments), plus the gate
      overIcons: { on: !!(overDotsOn || overLinesOn),
        dots: dbgOverDots, lines: dbgOverLines,
        threshD: overDotsOn ? overThreshD : null,
        threshL: overLinesOn ? overThreshL : null },
      // v0.81.2: the camera twin — rigs prove pans actually moved it
      camera: { x: offsetX, y: offsetY, scale: scale },
      // v0.83.3: the fps + cache twins
      fps: Math.round(lcFps),
      // v0.85.1: the batcher twin — buckets collected + fills issued (the
      // perf HUD + the rigs prove the collapse: solid ≈ 1–2 fills)
      batches: dbgBatches, buckets: dotBuckets.size + segBuckets.size,
      cache: { gen: LC.gen, colorGen: LC.cgen,
        dot: LC.dot.size, vline: LC.vline.size, hline: LC.hline.size,
        vseg: LC.vseg.size, hseg: LC.hseg.size },
      // v0.85.1 (glow wave): the glow twin — the per-dot derivation contract
      glow: { n: dbgGlow, colors: dbgGlowCols, sprites: LC.sprites.size } };
    // v0.85.1 (perf wave): the perf HUD feed (DoomalayPerf — the honest instrument)
    try {
      if (window.DoomalayPerf) {
        var DP = window.DoomalayPerf;
        DP.paints++;
        DP.batches = dbgBatches;
        DP.buckets = dotBuckets.size + segBuckets.size;
        DP.cacheHits = LC.hits; DP.cacheMisses = LC.misses;
        DP.paintMs = Math.round((lcNow - frameT0) * 10) / 10;
      }
    } catch (e) {}  }

  // ── v0.49 THE CANVAS BACKGROUND PAINTER ─────────────────────────────
  // Full-fidelity spec → COLOR-SPACE tile paint (the reported bug: "the
  // panel background setting follows the complex gradients and bumpmaps
  // very poorly and inaccurately"). v0.52: the tile rides a PARALLAX
  // camera — the background pans at 35% of the grid's rate and zooms at
  // 35% of the grid's scale (a far plane behind the lattice).
  // v0.54 (user spec: "the huge scrollable canvas displays the color like
  // space… but it feels tiled sometimes, we don't want it to feel tiled"):
  //   · the tile is 2× the viewport (pan period = 4 screens, not 2)
  //   · zx is CLAMPED ≥ 1 — zooming out never shrinks the tile below the
  //     viewport (no at-rest double tiles)
  //   · mesh paints the SAME 8-spot table the CSS recipe uses (every
  //     palette stop lands, richer field, rarer recurrence)
  //   · patterns cycle the FULL palette (matching the v0.54 css recipes)
  //   · textures cover-fit into the bigger tile → the mirror period
  //     doubles (the Rorschach repeat halves)
  // While a texture is still loading the gradient paints alone; the
  // onload triggers one repaint (update()).
  var texCache = {};   // dataURL → { img, ready }
  function texImageFor(url) {
    if (!url || typeof url !== 'string') return null;
    var e = texCache[url];
    if (e) return e.ready ? e.img : null;
    var img = new Image();
    e = { img: img, ready: false };
    texCache[url] = e;
    img.onload = function () { e.ready = true; bgCache = { key: '', tile: null }; update(); };
    img.onerror = function () { e.dead = true; };
    img.src = url;
    return null;
  }

  function validStopsOf(spec) {
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    if (!spec || !Array.isArray(spec.colors)) return [];
    return spec.colors.filter(function (c) { return HEX_RE.test(c); });
  }
  // shade helpers for the single-color pattern synths (mirror uikit's)
  function shadeHex(hex, amt) {   // amt > 0 lighten, < 0 darken (0..1)
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = function (v) {
      v = Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
      return Math.max(0, Math.min(255, v));
    };
    return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
  }
  function rgbaStr(hex, a) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // bgGradientPass — the linear/radial/conic sweeps shared by the bg and
  // (via gridPaint) the strokes. v0.54: parameterized by (w, h) — the
  // background tile paints at 2× the viewport while gridPaint keeps the
  // viewport geometry. Returns a fillable style or null.
  function bgGradientPass(stops, dir, angle, gctx, w, h) {
    gctx = gctx || ctx;
    w = w || W; h = h || H;
    if (stops.length < 2 || w <= 0 || h <= 0) return null;
    var g = null;
    var half = Math.hypot(w, h) / 2;
    if (dir === 'h') g = gctx.createLinearGradient(0, 0, w, 0);
    else if (dir === 'v') g = gctx.createLinearGradient(0, 0, 0, h);
    else if (dir === 'diag2') g = gctx.createLinearGradient(0, 0, w, h);
    else if (dir === 'radial') g = gctx.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, half);
    else if (dir === 'swirl') {
      // v0.49: a real conic sweep when the browser has it
      if (typeof ctx.createConicGradient === 'function') {
        g = gctx.createConicGradient(240 * Math.PI / 180, w * 0.55, h * 0.45);
      } else return null;
    } else { // 'diag' + 'auto'
      var ang = (dir === 'auto' || typeof angle !== 'number') ? 135 : angle;
      if (ang === 135) g = gctx.createLinearGradient(0, h, w, 0);
      else {
        var rad = (ang - 135) * Math.PI / 180;
        var c = Math.cos(rad), s = Math.sin(rad);
        var dx = (c + s) / Math.SQRT2, dy = (s - c) / Math.SQRT2;
        g = gctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
      }
    }
    for (var i = 0; i < stops.length; i++) g.addColorStop(i / (stops.length - 1), stops[i]);
    return g;
  }

  // ── v0.54 THE COLOR SPACE — pattern-aware per-element sampling ────
  // The v0.52 specColorAt sampled the STOPS positionally but ignored
  // the dir — switching the dots/lines to mesh/checker/stripes changed
  // nothing about their coloring (user report: "changing the options
  // (mesh, bumpmaps, checkers, ext) doesn't seem to affect the coloring
  // much"). makePatternSampler() mirrors the background painter's
  // geometry so EVERY option paints the lattice too:
  //   simple dirs → the sweep projection (bgGradientPass's exact axes)
  //   swirl → the conic sweep around the tile's focal
  //   mesh → soft inverse-distance blend of the SAME spot table
  //   pat-navy → the 45° stripe bands (28px period)
  //   pat-checker → the cell parity (32px cells, cycle ≤ 8 stops)
  //   pat-gingham → the two-axis band product (40px bands)
  //   pat-sunburst → the ray sectors from the bottom-center focal
  //   pat-pinstripe / tex → the base sweep (a stripe or the bumpmap's
  //     luminance doesn't quantize a dot's hue)
  // Sampling happens in PARALLAX-WORLD coordinates — the background
  // camera's frame — so the dot colors ride the SAME moving pattern the
  // background paints: pan and the palette flows through the lattice;
  // everything is world-anchored (no shimmer). Returns null for 1-stop
  // specs (the solid fast path — zero per-element cost).
  var MESH_SPOTS = [
    { x: 20, y: 25, f: 55 }, { x: 80, y: 15, f: 50 },
    { x: 75, y: 80, f: 55 }, { x: 15, y: 85, f: 50 },
    { x: 55, y: 8, f: 45 }, { x: 38, y: 55, f: 50 },
    { x: 92, y: 58, f: 48 }, { x: 8, y: 45, f: 52 }
  ];

  function makePatternSampler(spec, fallbackHex) {
    var stops = validStopsOf(spec);
    if (stops.length < 2) return null;
    var dir = (spec && spec.dir) || 'auto';
    var angle = (typeof spec.angle === 'number') ? spec.angle : 135;
    var rgb = [];
    for (var i = 0; i < stops.length; i++) {
      var m = /^#([0-9a-fA-F]{6})$/.exec(stops[i]);
      if (m) rgb.push(parseInt(m[1], 16));
    }
    if (rgb.length < 2) return null;

    function h2c(v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    function hexAt(idx) {          // a DISCRETE stop (patterns)
      var n = rgb[((idx % rgb.length) + rgb.length) % rgb.length];
      return '#' + h2c((n >> 16) & 255) + h2c((n >> 8) & 255) + h2c(n & 255);
    }
    function sampleRGB(t) {        // interpolated (sweeps + mesh spots)
      t = ((t % 1) + 1) % 1;
      var f = t * (rgb.length - 1);
      var i2 = Math.min(rgb.length - 2, Math.floor(f));
      var tt = f - i2;
      var a = rgb[i2], b = rgb[i2 + 1];
      return [
        ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * tt,
        ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * tt,
        (a & 255) + ((b & 255) - (a & 255)) * tt
      ];
    }
    function hex(c) { return '#' + h2c(c[0]) + h2c(c[1]) + h2c(c[2]); }

    // the sweep projection (bgGradientPass's exact geometry, tile dims)
    function sweepT(lx, ly, tw, th, ang) {
      if (dir === 'h') return lx / tw;
      if (dir === 'v') return ly / th;
      if (dir === 'diag2') return (lx * tw + ly * th) / (tw * tw + th * th);
      if (dir === 'radial') {
        var rdx = lx - tw / 2, rdy = ly - th * 0.35;
        return Math.sqrt(rdx * rdx + rdy * rdy) / (Math.hypot(tw, th) / 2);
      }
      if (dir === 'swirl') {
        var sa = Math.atan2(ly - th * 0.45, lx - tw * 0.55) * 180 / Math.PI;
        return (sa - 240) / 360;
      }
      // diag (custom angle) + auto (135)
      var a2 = (dir === 'auto') ? 135 : ang;
      if (a2 === 135) return (lx * tw - ly * th + th * th) / (tw * tw + th * th);
      var rad = (a2 - 135) * Math.PI / 180;
      var c = Math.cos(rad), s = Math.sin(rad);
      var dx = (c + s) / Math.SQRT2, dy = (s - c) / Math.SQRT2;
      return 0.5 + ((lx - tw / 2) * dx + (ly - th / 2) * dy) / Math.hypot(tw, th);
    }

    // mesh pre-pass: the spot rgb table (palette interpolation for the
    // long palettes — every stop lands, same as the css recipe)
    var meshK = Math.max(4, Math.min(MESH_SPOTS.length, stops.length));
    var meshSpots = [];
    for (var mi = 0; mi < meshK; mi++) {
      var cr;
      if (stops.length <= MESH_SPOTS.length) {
        var pn = parseInt(stops[mi % stops.length].slice(1), 16);
        cr = [(pn >> 16) & 255, (pn >> 8) & 255, pn & 255];
      } else {
        cr = sampleRGB(mi / Math.max(1, meshK - 1));
      }
      meshSpots.push({ x: MESH_SPOTS[mi].x / 100, y: MESH_SPOTS[mi].y / 100,
        f: MESH_SPOTS[mi].f / 100, c: cr });
    }
    function meshHex(lx, ly, tw, th) {
      // the tile's mesh base is a diag-160 sweep of [first,last] —
      // sample that projection for the base color
      var t160 = 0.5 + ((lx - tw / 2) * ((Math.cos((160 - 135) * Math.PI / 180) + Math.sin((160 - 135) * Math.PI / 180)) / Math.SQRT2) +
        (ly - th / 2) * ((Math.sin((160 - 135) * Math.PI / 180) - Math.cos((160 - 135) * Math.PI / 180)) / Math.SQRT2)) / Math.hypot(tw, th);
      var bc = sampleRGB(t160);
      var acc = [0, 0, 0], wsum = 0;
      var rmax = Math.max(tw, th);
      for (var si = 0; si < meshSpots.length; si++) {
        var sp = meshSpots[si];
        var dx = lx - sp.x * tw, dy = ly - sp.y * th;
        var d = Math.sqrt(dx * dx + dy * dy);
        var r = sp.f * rmax;
        if (d < r) {
          var w = 1 - d / r;
          w = w * w;
          acc[0] += w * sp.c[0]; acc[1] += w * sp.c[1]; acc[2] += w * sp.c[2];
          wsum += w;
        }
      }
      if (wsum <= 0.0001) return hex(bc);
      var blend = Math.min(1, wsum);
      var sc = [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum];
      return hex([bc[0] * (1 - blend) + sc[0] * blend,
        bc[1] * (1 - blend) + sc[1] * blend,
        bc[2] * (1 - blend) + sc[2] * blend]);
    }

    return function (sx, sy) {
      // parallax-world fold: screen → the tile's bitmap coordinates
      var tw = bgView.tw || W, th = bgView.th || H, zx = bgView.zx || 1;
      var tw2 = 2 * tw, th2 = 2 * th;
      var bx = ((sx - bgView.px) % tw2 + tw2) % tw2;
      var by = ((sy - bgView.py) % th2 + th2) % th2;
      if (bx > tw) bx = tw2 - bx;
      if (by > th) by = th2 - by;
      var lx = bx / zx, ly = by / zx;
      var bw = tw / zx, bh = th / zx;   // the tile's bitmap dims
      switch (dir) {
        case 'mesh':
          return meshHex(lx, ly, bw, bh);
        case 'pat-navy': {
          var xr = (lx + ly) / Math.SQRT2;
          return hexAt(Math.floor(xr / 28));
        }
        case 'pat-checker': {
          var cyc = Math.max(2, Math.min(8, rgb.length));
          var cell = Math.floor(lx / 32) + Math.floor(ly / 32);
          return hexAt(((cell % cyc) + cyc) % cyc);
        }
        case 'pat-gingham':
          return hexAt(Math.floor(ly / 40) + Math.floor(lx / 40));
        case 'pat-sunburst': {
          var a = Math.atan2(ly - bh, lx - bw / 2) * 180 / Math.PI;
          var wedge = Math.max(3, Math.round(30 / rgb.length));
          var sector = Math.floor((((a % 360) + 360) % 360) / wedge);
          return hexAt(sector);
        }
        case 'pat-pinstripe':
          return hex(sampleRGB(sweepT(lx, ly, bw, bh, 160)));
        default: // auto/h/v/diag/diag2/radial/swirl/tex
          return hex(sampleRGB(sweepT(lx, ly, bw, bh, angle)));
      }
    };
  }

  // v0.52 THE PARALLAX BACKGROUND (user spec item 7: "let's change the
  // canvas background color to not be static… have the colors and
  // background move with the canvas as the user scrolls… giving a 3d
  // space effect") ──
  //
  // The v0.49 full-fidelity painter now renders ONCE into an offscreen
  // tile (cached per spec+size); every frame the tile is drawn MIRROR-
  // TILED with a parallax camera — the background pans at 35% of the
  // grid's rate and zooms at 35% of the grid's scale, so it reads as a
  // far plane behind the lattice. Mirrored tiling is seamless for ANY
  // artwork (gradients, patterns, textures — values match at the seam),
  // and the wrap keeps the parallax infinite without ever sliding off.
  var bgCache = { key: '', tile: null };
  var BG_PARALLAX = 0.35;
  // v0.75 THE AMPLIFIER: the far plane deepens with the Amplify
  // parallax setting (0 — the default — is exactly the v0.52 0.35; the
  // camera only slows when the user dials the amplifier up, pairing
  // with the star layers for the deep-space read).
  // v0.77: the deepening is DRAMATIC (user spec: "not very noticeable") —
  // 0.35 → 0.08 at full amp (the old 0.20 barely read). The background
  // nearly pins in place while the lattice sweeps — unmistakable depth.
  function bgParallaxNow() {
    var st = window.Settings.getState();
    var d = (typeof st.spaceParallax === 'number') ? st.spaceParallax : 0;
    d = Math.max(0, Math.min(100, d)) / 100;
    return Math.max(0.08, BG_PARALLAX - 0.27 * d);
  }
  // v0.54: the color-space tile is MULT× the viewport — the mirror
  // period grows to 2·MULT screens of pan, textures cover-fit larger
  // (the Rorschach repeat halves), and the mesh spots spread over a
  // field twice the screen (softer, rarer glows).
  var BG_TILE_MULT = 2;
  // the live parallax camera (read by makePatternSampler so the grid
  // elements ride the same moving pattern the background paints)
  var bgView = { tw: 0, th: 0, zx: 1, px: 0, py: 0 };

  function bgTileKey(spec, fallbackHex, tw, th) {
    var s = '';
    try { s = JSON.stringify(spec); } catch (e) { s = String(spec); }
    return s + '|' + tw + 'x' + th + '|' + fallbackHex;
  }

  function bgTileFor(spec, fallbackHex, tw, th) {
    var key = bgTileKey(spec, fallbackHex, tw, th);
    if (bgCache.key === key && bgCache.tile) return bgCache.tile;
    var off = document.createElement('canvas');
    off.width = Math.max(1, tw);
    off.height = Math.max(1, th);
    paintBackgroundInto(off.getContext('2d'), spec, fallbackHex, tw, th);
    bgCache = { key: key, tile: off };
    return off;
  }

  function paintCanvasBackground(spec, fallbackHex) {
    var BG_P = bgParallaxNow();
    var TW = Math.max(16, Math.round(W * BG_TILE_MULT));
    var TH = Math.max(16, Math.round(H * BG_TILE_MULT));
    var tile = bgTileFor(spec, fallbackHex, TW, TH);
    // v0.54: zx CLAMPED ≥ 1 — zooming out never shrinks the tile below
    // the viewport (the old 0.825× at min-zoom painted 2+ tiles at rest,
    // the most visible "it feels tiled" artifact)
    var zx = Math.max(1, 1 + (scale - 1) * BG_P);   // bg zoom = the far plane's rate
    var tw = TW * zx, th = TH * zx;
    // the parallax pan, wrapped into the mirror period [0, 2·tw)
    var px = ((-offsetX * scale * BG_P) % (2 * tw) + 2 * tw) % (2 * tw);
    var py = ((-offsetY * scale * BG_P) % (2 * th) + 2 * th) % (2 * th);
    bgView = { tw: tw, th: th, zx: zx, px: px, py: py };   // for the samplers
    for (var ix = 0; ; ix++) {
      var x0 = px - 2 * tw + ix * tw;
      if (x0 >= W) break;
      var flipX = (ix % 2 === 1);
      for (var iy = 0; ; iy++) {
        var y0 = py - 2 * th + iy * th;
        if (y0 >= H) break;
        var flipY = (iy % 2 === 1);
        ctx.save();
        ctx.translate(flipX ? x0 + tw : x0, flipY ? y0 + th : y0);
        ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        ctx.drawImage(tile, 0, 0, tw, th);
        ctx.restore();
        if (y0 + th >= H) break;
      }
      if (x0 + tw >= W) break;
    }
  }

  // paintBackgroundInto — the full-fidelity painter, into ANY 2d
  // context at (tw, th) — the 2× color-space tile since v0.54.
  function paintBackgroundInto(gctx, spec, fallbackHex, tw, th) {
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    tw = tw || W; th = th || H;
    var stops = validStopsOf(spec);
    var dir = (spec && spec.dir) || 'auto';
    var texUrl = (spec && typeof spec.tex === 'string') ? spec.tex : '';
    var texImg = texImageFor(texUrl);
    if (!stops.length && !texImg) {
      // nothing valid — the legacy hex path
      gctx.fillStyle = HEX_RE.test(spec == null ? '' : String(spec)) ? String(spec) : fallbackHex;
      if (spec && Array.isArray(spec.colors) && HEX_RE.test(fallbackHex)) gctx.fillStyle = fallbackHex;
      gctx.fillRect(0, 0, tw, th);
      return;
    }
    // the TEXTURE pass (bumpmap): cover-fit the image, then paint the
    // gradient/pattern over it with 'color' — hue+sat of the gradient,
    // luminance of the bumpmap (the CSS blend contract).
    if (texImg) {
      var ir = texImg.width / texImg.height;
      var vr = tw / th;
      var dw, dh;
      if (ir > vr) { dh = th; dw = th * ir; } else { dw = tw; dh = tw / ir; }
      gctx.drawImage(texImg, (tw - dw) / 2, (th - dh) / 2, dw, dh);
      gctx.globalCompositeOperation = 'color';
    }
    // ── the gradient / pattern passes ──
    var c = stops.length ? stops : ['#0a0a0b'];
    var c0 = c[0];
    var c1 = c.length > 1 ? c[1] : null;
    var paintPlain = function () {   // the sweep (or solid) over everything
      var g = bgGradientPass(c, dir, spec && spec.angle, gctx, tw, th);
      gctx.fillStyle = g || c0;
      gctx.fillRect(0, 0, tw, th);
    };
    if (dir === 'mesh') {
      // v0.54: the SAME 8-spot table the css recipe uses — spot count
      // follows the palette (4–8), every stop lands, palette
      // interpolation beyond the table. The base sweeps first→last.
      var meshK = Math.max(4, Math.min(MESH_SPOTS.length, c.length));
      var base = c.length > 1 ? c[c.length - 1] : shadeHex(c0, -0.2);
      gctx.fillStyle = bgGradientPass([c0, base], 'diag', 160, gctx, tw, th) || base;
      gctx.fillRect(0, 0, tw, th);
      var rmax = Math.max(tw, th);
      for (var i = 0; i < meshK; i++) {
        var sp = MESH_SPOTS[i];
        var sx = tw * sp.x / 100, sy = th * sp.y / 100;
        var rg = gctx.createRadialGradient(sx, sy, 0, sx, sy, rmax * sp.f / 100);
        rg.addColorStop(0, c[i % c.length]);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        gctx.fillStyle = rg;
        gctx.fillRect(0, 0, tw, th);
      }
    } else if (dir === 'pat-navy') {
      // v0.54: stripes cycle ALL stops (28px period · n stripes)
      var nc = c.length > 1 ? c : [c[0], shadeHex(c0, -0.18)];
      gctx.fillStyle = nc[0];
      gctx.fillRect(0, 0, tw, th);
      gctx.save();
      gctx.translate(tw / 2, th / 2);
      gctx.rotate(-Math.PI / 4);   // CSS 45deg axis → stripes ⟂ to it
      var span = Math.hypot(tw, th);
      var swid = 28 / nc.length;
      for (var nb = 0; nb < nc.length; nb++) {
        gctx.fillStyle = nc[nb];
        for (var b = -span + nb * 28; b < span; b += 28 * nc.length) {
          gctx.fillRect(b, -span, swid, span * 2);
        }
      }
      gctx.restore();
    } else if (dir === 'pat-pinstripe') {
      var p2 = c1 || shadeHex(c0, 0.18);
      gctx.fillStyle = bgGradientPass([c0, c[c.length - 1]], 'diag', 160, gctx, tw, th) || c0;
      gctx.fillRect(0, 0, tw, th);
      gctx.strokeStyle = rgbaStr(c0, 0.35);
      gctx.lineWidth = 1;
      for (var ps2 = 9; ps2 < tw; ps2 += 18) {
        gctx.beginPath();
        gctx.moveTo(ps2, 0);
        gctx.lineTo(ps2, th);
        gctx.stroke();
      }
    } else if (dir === 'pat-gingham') {
      // v0.54: horizontal bands cycle the even stops, vertical the odd
      // (≤3 stops = the classic trio), base = the last stop
      var gEven = [], gOdd = [];
      for (var gi = 0; gi < c.length; gi++) (gi % 2 === 0 ? gEven : gOdd).push(c[gi]);
      if (c.length > 3) {
        if (gEven[gEven.length - 1] === c[c.length - 1]) gEven.pop();
        else if (gOdd[gOdd.length - 1] === c[c.length - 1]) gOdd.pop();
      }
      var gBase = c.length > 3 ? c[c.length - 1]
        : (c.length > 2 ? c[2] : shadeHex(c0, 0.30));
      gctx.fillStyle = gBase;
      gctx.fillRect(0, 0, tw, th);
      for (var hb = 0; hb < gEven.length; hb++) {
        gctx.fillStyle = rgbaStr(gEven[hb], 0.55);
        for (var gy = hb * 80; gy < th; gy += 80 * gEven.length) gctx.fillRect(0, gy, tw, 40);
      }
      for (var vb = 0; vb < gOdd.length; vb++) {
        gctx.fillStyle = rgbaStr(gOdd[vb], 0.35);
        for (var gx = vb * 80; gx < tw; gx += 80 * gOdd.length) gctx.fillRect(gx, 0, 40, th);
      }
    } else if (dir === 'pat-sunburst') {
      // v0.54: rays cycle ALL stops — wedge = max(3, 30/n)°
      var sc = c.length > 1 ? c : [c[0], shadeHex(c0, 0.18)];
      var cx = tw / 2, cy = th;
      var span2 = Math.hypot(tw, th);
      var wedge = Math.max(3, Math.round(30 / sc.length));
      gctx.fillStyle = sc[0];
      gctx.fillRect(0, 0, tw, th);
      for (var a = 0; a < 360; a += wedge) {
        var ri = (a / wedge) % sc.length;
        gctx.fillStyle = sc[ri];
        var r0 = a * Math.PI / 180, r1 = (a + wedge) * Math.PI / 180;
        gctx.beginPath();
        gctx.moveTo(cx, cy);
        gctx.lineTo(cx + Math.cos(r0) * span2, cy + Math.sin(r0) * span2);
        gctx.lineTo(cx + Math.cos(r1) * span2, cy + Math.sin(r1) * span2);
        gctx.closePath();
        gctx.fill();
      }
    } else if (dir === 'pat-checker') {
      // v0.54: the QUILT — cell color = stops[(row+col) % cyc] with the
      // cycle capped at 8 (matching the css recipe); 32px cells.
      var cyc2 = Math.max(2, Math.min(8, c.length));
      for (var cy2 = 0, row = 0; cy2 < th; cy2 += 32, row++) {
        for (var cx2 = 0, col = 0; cx2 < tw; cx2 += 32, col++) {
          gctx.fillStyle = c[((row + col) % cyc2 + cyc2) % cyc2];
          gctx.fillRect(cx2, cy2, 32, 32);
        }
      }
    } else {
      paintPlain();
    }
    if (texImg) {
      gctx.globalCompositeOperation = 'source-over';   // restore
    }
  }

  // ── v0.44 gridPaint — spec-or-hex → a canvas paint style ──────────
  // The four grid colors may hold gradient specs (Settings keys written
  // by the appearance GradientUI editors; theme.js resolves legacy
  // hexes into 1-color specs). A spec paints:
  //   · 1 valid stop            → the solid hex (today's behavior)
  //   · ≥2 stops, dir h/v/diag/diag2/radial/auto → a REAL canvas
  //     gradient (createLinearGradient / createRadialGradient) across
  //     the viewport — the bg fill, line strokes, dots and origin all
  //     take it (dots pick up the gradient at their own position)
  //   · swirl / mesh / pat-* / tex strokes → the SOLID first color for
  //     the FALLBACK style; the per-element pattern sampling
  //     (makePatternSampler, v0.54) paints those dirs per dot/line at
  //     the pattern's own geometry — this path only serves consumers
  //     that paint one continuous style (the origin dot, arrows) and
  //     the pre-sampler fallback.
  // ANGLE MAP (h/v/diag2/radial are exact; diag's default 135 too — a
  // CUSTOM angle rotates the default direction about the center):
  //   h      (0,0) → (W,0)          v      (0,0) → (0,H)
  //   diag   (0,H) → (W,0)          diag2  (0,0) → (W,H)
  //   radial circle at 50% 35% (the CSS recipe's focal), r = ½ diagonal
  //   1-color + any dir → the solid (canvas gradients need ≥2 stops)
  function gridPaint(spec, fallbackHex) {
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    // legacy plain value (no spec view, or a bare hex): validate + return
    if (!spec || !Array.isArray(spec.colors)) {
      const s = String(spec == null ? '' : spec);
      return HEX_RE.test(s) ? s : fallbackHex;
    }
    const stops = spec.colors.filter(function (c) { return HEX_RE.test(c); });
    if (!stops.length) return fallbackHex;      // nothing valid → caller's
    if (stops.length < 2 || W <= 0 || H <= 0) return stops[0];
    // v0.49: the shared sweep pass (linear / radial / custom-angle diag /
    // CONIC swirl — createConicGradient when the browser has it)
    var g = bgGradientPass(stops, spec.dir || 'auto',
      (typeof spec.angle === 'number') ? spec.angle : undefined);
    if (!g) return stops[0];   // mesh / pat-* strokes → solid (bg paints them full)
    return g;
  }

  function renderOffScreenArrows() {
    const margin = 50;
    for (const bot of world.entities) {
      const s = worldToScreen(bot.x, bot.y);
      if (s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H) continue;

      const ax = Math.max(margin, Math.min(W - margin, s.x));
      const ay = Math.max(margin, Math.min(H - margin, s.y));
      const angle = Math.atan2(s.y - ay, s.x - ax);

      const fam = (config.families[bot.family] || config.families.default || {});
      // v0.24: the default family follows the theme — canvas fill needs a
      // REAL hex, so resolve the CSS var at draw time.
      let color = fam.color || '#4a4a5e';
      if (bot.family === 'default' || !fam.color) {
        color = getComputedStyle(document.documentElement)
          .getPropertyValue('--border-strong').trim() || color;
      }

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // ── World + icons ──────────────────────────────────────────────
  const world = new Physics.World();
  const iconLayer = document.getElementById('chatbots');
  // v0.85.1 THE ICON-LAYER BUDGET: past 40 icons every .chatbot's
  // will-change:transform costs more in standing compositor layers +
  // texture memory than the rare re-promotion on drag — the .many-icons
  // class swaps it OFF (the CSS twin), .dragging puts it back for the
  // ONE icon that needs it. Below the threshold the hint returns (the
  // tens-of-icons default rides full GPU compositing as before).
  function updateIconBudget() {
    if (!iconLayer) return;
    var many = world.entities.length > 40;
    if (many !== updateIconBudget.many) {
      updateIconBudget.many = many;
      iconLayer.classList.toggle('many-icons', many);
    }
  }
  const namePicker = new ChatIcon.NamePicker(config.names);
  const iconPickers = {};

  function getIconPicker(family) {
    if (!iconPickers[family]) {
      const fam = (config.families[family] || { icons: [] });
      iconPickers[family] = new ChatIcon.IconPicker(family, fam.icons || []);
    }
    return iconPickers[family];
  }

  function usedNames() {
    return new Set(world.entities.map(c => c.name));
  }
  function usedIconIndices(family) {
    return new Set(
      world.entities
        .filter(c => c.family === family)
        .map(c => c.iconIndex)
        .filter(i => i >= 0)
    );
  }

  function createIconAt(worldX, worldY) {
    const family = currentFamily;
    const name = namePicker.pick(usedNames());
    const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
    // v0.17 FIX: nextId resets to 1 on every reload — a new chat created
    // after a restart got "chat_1" which COLLIDED with the first restored
    // icon → the new chat reused the OLD chat's state (same conversation,
    // "identical to the old one") and third chats dead-ended. Generate an
    // id guaranteed unused across the restored world.
    const used = new Set(world.entities.map(e => e.id));
    let n = 1;
    while (used.has('chat_' + n)) n++;
    const icon = new ChatIcon.ChatIcon({ id: 'chat_' + n, name, family, iconIndex, x: worldX, y: worldY });
    world.add(icon);
    iconLayer.appendChild(icon.el);
    icon.render(offsetX, offsetY, scale);
    updateIconBudget();   // v0.85.1: the icon-layer budget follows the count
    hideCanvasEmpty();  // v0.82.2: any creation ends the first-run state
    scheduleSave();
    return icon;
  }

  // v0.82: THE VISIBLE CREATE-AND-OPEN PATH — shared by the dock's ＋
  // (0.82.1) and the first-run empty-state's CTA (0.82.2). Creates the
  // chat at the viewport CENTER (always visible, never under the dock
  // cluster), gives it the same little nudge + physics as the long-press
  // menu, then opens it via the EXACT tap-to-open sequence the canvas
  // icon itself uses (flash → 150ms → panel). Pressing "New chat" IS
  // the intent to chat.
  function createChatAtCenterAndOpen() {
    const center = screenToWorld(W / 2, H / 2);
    const icon = createIconAt(center.x, center.y);
    icon.vx = (Math.random() - 0.5) * 6;
    icon.vy = (Math.random() - 0.5) * 6;
    startAnimation();
    icon.flash();
    setTimeout(function () {
      var modelBtn = document.getElementById('panel-model-btn');
      if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
      panel.bodyEl.style.padding = '0';
      panel.open({
        title: icon.getPanelTitle(),
        subtitle: icon.getPanelSubtitle(),
        avatarHTML: icon.getAvatarHTML(),
        bodyHTML: icon.getPanelBodyHTML(),
        context: icon
      });
      if (icon.type === 'chat' && window.ChatPanel) {
        window.ChatPanel.render(panel.bodyEl, icon, panel);
      }
    }, 150);
    return icon;
  }

  function setFamily(family) {
    if (!config.families[family]) return;
    currentFamily = family;
    delete iconPickers[family];
    for (const bot of world.entities) {
      const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
      bot.setFamily(family, iconIndex);
    }
    scheduleSave();
  }

  window.doomalay = {
    setFamily,
    getFamily: () => currentFamily,
    getConfig: () => config,
    scheduleSave,
    // v0.41: global-search jump — open a chat by engine session id
    // (materializing an icon if the grid has none) + optional jump to a
    // specific engine event (scrollIntoView + find-hit pulse).
    openChatBySession,
    // v0.52: the canvas icon bound to an engine session id (the hub's
    // chat-connection pill asks for the icon's avatar + name after a
    // pick in the all-chats overlay). null when no icon carries it.
    findIconForSession: function (sid) {
      if (!sid) return null;
      for (const bot of world.entities) {
        if (bot.sessionId === sid) return bot;
      }
      return null;
    },
    resetView: function () {
      offsetX = 0; offsetY = 0; scale = 1; velX = 0; velY = 0;
      update(); scheduleSave();
    },
    // Handle Android back press. Returns true if we closed something (overlay
    // or panel), false if nothing was open. Called by MainActivity.onBackPressed
    // so the back gesture closes overlays/panels instead of exiting the app.
    handleBack: function () {
      // v0.62: the overlay pops ONE page per press (the APK path — the
      // old unconditional close() dumped the user back on the chat instead
      // of the previous overlay page, e.g. connect-a-workspace →
      // workspaces). backOne() pops nested pages; closes at the root.
      if (window.ConnectOverlay && window.ConnectOverlay.isOpen()) {
        window.ConnectOverlay.backOne();
        return true;
      }
      // v0.18: the artifacts drawer/editor + the long-press action sheet
      // are appended to document.body (not inside the chat panel) — the
      // back gesture MUST know about them or a stuck overlay traps the
      // user in the app ("had to close the app completely").
      var artOverlay = document.getElementById('artifacts-overlay');
      if (artOverlay && artOverlay.style.display !== 'none' && artOverlay.style.display !== '') {
        // v0.18: dirty-aware — an editor with unsaved changes shows the
        // in-DOM discard banner instead of losing edits ('blocked').
        var r = (window.Artifacts && window.Artifacts.backClose)
          ? window.Artifacts.backClose() : 'closed';
        if (r !== false) return true;
      }
      // v0.27: THE PANEL VIEW STACK — personas, usage, export, mind all
      // render as views on the master panel. Back pops one view; when the
      // stack is empty it closes the panel itself (panel.back()).
      var actionSheet = document.getElementById('msg-action-sheet');
      if (actionSheet && window.MsgActions && window.MsgActions.isOpen && window.MsgActions.isOpen()) {
        window.MsgActions.dismiss();
        return true;
      }
      // Close the chat panel (a view pops first, the root closes after)
      // (v0.64.0: the panel browser's back is NATIVE now — MainActivity
      // consumes Android back for the sheet's WebView history before
      // the SPA is ever consulted; the web dock is retired.)
      if (panel && panel.isOpen()) {
        if (panel.back && panel.back()) return true;
        panel.close();
        return true;
      }
      // Close the long-press menu
      if (menuEl && !menuEl.classList.contains('hidden')) {
        hideMenu();
        return true;
      }
      return false;
    }
  };

  // ── Animation loop ──────────────────────────────────────────────
  // v0.75 AMBIENT: the grid animate toggles (dot twinkle / line drift)
  // keep the rAF loop alive on their own — no motion, no save spam
  // (the offsets don't change, so scheduleSave is never touched).
  // v0.84.1: the atom orbits keep it alive too — every chat with bound
  // workspaces carries orbiting stars, and those stars move every frame.
  function ambientActive() {
    var st = window.Settings.getState();
    if (st && (st.dotAnimate || st.lineAnimate)) return true;
    return !!(window.Atoms && window.Atoms.active(world.entities));
  }
  // v0.84.2: refreshPersonaRings — resolve each chat's ACTIVE persona and
  // paint its badge ring on the canvas icon (Persona.activePersonaOf is
  // the canvas-side twin: always > shuffle-pick > none; triggers need
  // live metrics only the engine resolves per turn). Optional sid limits
  // the refresh to one chat (the persona-saved event's target).
  function refreshPersonaRings(sid) {
    for (const icon of world.entities) {
      if (icon.type !== 'chat' || !icon.sessionId) continue;
      if (typeof icon.setPersonaBadge !== 'function') continue;
      if (sid && icon.sessionId !== sid) continue;
      (function (target) {
        fetch('/api/sessions/' + encodeURIComponent(target.sessionId))
          .then(function (r) { return r.json(); })
          .then(function (sess) {
            var list = [];
            try { list = JSON.parse((sess && sess.Personas) || '[]') || []; } catch (e) { list = []; }
            var active = (window.Persona && window.Persona.activePersonaOf)
              ? window.Persona.activePersonaOf(list) : null;
            target.setPersonaBadge(active);
          })
          .catch(function () {});
      })(icon);
    }
  }
  // v0.84.1: the GRID's own animate toggles (the atom-orbit branch of
  // ambientActive above must NOT force the full lattice repaint — that's
  // what the atom-only frame avoids).
  function ambientGridActive() {
    var st = window.Settings.getState();
    return !!(st && (st.dotAnimate || st.lineAnimate));
  }
  // v0.84.1: paintAtoms — the atom pass, AFTER renderGrid (it cleared #c2
  // this frame). The stats join the honest instrument (DoomalayDebug.atoms).
  function paintAtoms() {
    if (!window.Atoms || !ctx2) return;
    var stats = window.Atoms.paint(ctx2, W, H, offsetX, offsetY, scale, world.entities);
    atomStats = stats;
    try {
      if (!window.DoomalayDebug) window.DoomalayDebug = {};
      window.DoomalayDebug.atoms = stats;
      if (window.DoomalayPerf) window.DoomalayPerf.atomFrames++;   // v0.85.1: the HUD's atom meter
    } catch (e) {}
  }
  var atomStats = null;
  function update() {
    world.step();
    renderGrid();
    for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
    renderOffScreenArrows();
    paintAtoms();
    // v0.67: the icons ride transforms — the projection painter
    // re-anchors their gradient windows to the viewport each frame.
    if (window.DoomProjection) window.DoomProjection.poke();
    // v0.75: an animate toggle ON means the canvas never rests.
    // v0.84.1: so do the atom orbits.
    if (ambientActive()) startAnimation();
  }

  function tick() {
    let moving = false;
    if (Math.abs(velX) >= 0.15 || Math.abs(velY) >= 0.15) {
      offsetX += velX; offsetY += velY;
      velX *= PAN_FRICTION; velY *= PAN_FRICTION;
      moving = true;
    } else if (velX !== 0 || velY !== 0) {
      velX = 0; velY = 0;
    }
    world.step();
    for (const e of world.entities) {
      if (!e.dragging && (Math.abs(e.vx) > 0.01 || Math.abs(e.vy) > 0.01)) {
        moving = true; break;
      }
    }
    // v0.78.3: the per-frame POKED PAINT is GONE. Canvas motion moves no
    // DOM inside the transformed roots (arrows are plain fixed elements —
    // native fixed works there), so the tick's full projection paint per
    // frame was pure jank (the panel glide already rides writeY→motion,
    // DOM changes ride the observer, scrolls ride --proj-sy). The ambient
    // animate loop used to burn one full paint per frame, forever.
    let covered = false;
    const pEl = document.getElementById('chat-panel');
    if (pEl && pEl.classList.contains('open')) {
      const pr = pEl.getBoundingClientRect();
      covered = pr.top <= 1 && pr.bottom >= window.innerHeight - 1;
    }
    if (!covered) {
      var atomsOnly = !moving && !ambientGridActive() &&
                      window.Atoms && window.Atoms.active(world.entities);
      if (atomsOnly) {
        // v0.84.1: THE ATOM-ONLY FRAME — nothing else is moving (no pan
        // momentum, no physics drift, no grid animate), so the grid and
        // the icons are pixel-stable: repaint ONLY the star layer (clear
        // #c2 + the atom pass). A resting canvas with orbiting atoms stays
        // near-free instead of re-running the full lattice paint per frame.
        if (ctx2) ctx2.clearRect(0, 0, W, H);
        paintAtoms();
      } else {
        renderGrid();
        for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
        renderOffScreenArrows();
        paintAtoms();
      }
    }
    if (moving) { scheduleSave(); requestAnimationFrame(tick); }
    else if (ambientActive()) { requestAnimationFrame(tick); } // v0.75: animate — offsets unchanged, no save; v0.84.1: atoms too
    else { animating = false; scheduleSave(); }
  }

  function startAnimation() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
  }

  // ── Panel (content-agnostic) ──────────────────────────────────
  const panel = new window.Panel({
    panelEl:  document.getElementById('chat-panel'),
    scrimEl:  document.getElementById('chat-scrim'),
    handleEl: document.getElementById('panel-handle'),
    headerEl: document.querySelector('#chat-panel .panel-header'),
    avatarEl: document.getElementById('panel-avatar'),
    nameEl:   document.getElementById('panel-name'),
    subEl:    document.getElementById('panel-sub'),
    bodyEl:   document.getElementById('panel-body')
  });

  // ── v0.19: manual chat rename ─────────────────────────────────
  // The user's spec: "don't have the chat rename from the default random
  // name from the list unless the user manually changes the chat name
  // themselves." The auto-title (first message → icon label) is GONE;
  // tapping the chat's name in the panel header is now THE way to rename.
  // Inline input (Android-safe — no window.prompt), commits on Enter/blur,
  // cancels on Escape, and persists to the icon + the engine session
  // (with manually_renamed so nothing ever overwrites it again).
  const panelNameEl = document.getElementById('panel-name');
  if (panelNameEl) {
    panelNameEl.addEventListener('click', function () {
      var icon = panel.currentContext;
      if (!icon || icon.type !== 'chat') return;
      // v0.27: a stacked view owns the header (its title lives here) —
      // never start a rename while views are open.
      if (panel.viewDepth && panel.viewDepth()) return;
      // v0.19: a header DRAG that ended on the name still fires this click —
      // ignore it (the drag just moved the panel).
      if (panel.gestures && panel.gestures.justDragged && panel.gestures.justDragged()) return;
      if (panelNameEl.querySelector('input')) return; // already editing
      var old = icon.name || '';
      panelNameEl.textContent = '';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = old;
      inp.maxLength = 48;
      inp.style.cssText = 'width:100%;font-size:15px;font-weight:600;color:var(--text-1);background:transparent;border:none;border-bottom:1px solid var(--ok);outline:none;font-family:inherit;padding:0;box-sizing:border-box';
      panelNameEl.appendChild(inp);
      inp.focus();
      try { inp.select(); } catch (e) {}
      var settled = false;
      var done = function (commit) {
        if (settled) return;
        settled = true;
        var v = String(inp.value || '').trim();
        panelNameEl.textContent = (commit && v) ? v : old;
        if (commit && v && v !== old) {
          if (typeof icon.setName === 'function') icon.setName(v);
          if (typeof icon.save === 'function') icon.save();
          var st = window.ChatPanel && window.ChatPanel.getState(icon.id);
          if (st && st.sessionId) {
            fetch('/api/sessions/' + st.sessionId, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: v, override_manual: true, manually_renamed: true })
            }).catch(function () {});
          }
        }
      };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { settled = true; panelNameEl.textContent = old; inp.blur(); }
      });
      inp.addEventListener('blur', function () { done(true); });
    });
  }

  // ── Long-press dropdown menu ───────────────────────────────────
  const menuEl = document.getElementById('menu');

  // ── v0.82.2: THE FIRST-RUN EMPTY-STATE ─────────────────────────
  // A fresh install booted to an empty grid whose only creation path
  // was the hidden long-press menu — the single worst first-run funnel
  // step (live red-team finding). Shown ONCE per fresh install (boot:
  // no saved layout AND zero restored icons); every creation path
  // (long-press / dock ＋ / the card's own CTA / materialize-from-
  // search) lands in createIconAt → hideCanvasEmpty, so it never
  // shadows an icon. Returning users who deleted all their chats have
  // a saved layout → never see it.
  const canvasEmptyEl = document.getElementById('canvas-empty');
  let canvasEmptyDismissed = false;

  function hideCanvasEmpty() {
    if (canvasEmptyDismissed) return;
    canvasEmptyDismissed = true;
    if (canvasEmptyEl) canvasEmptyEl.classList.add('hidden');
  }

  function maybeShowCanvasEmpty(isFreshInstall) {
    if (!canvasEmptyEl || canvasEmptyDismissed) return;
    if (!isFreshInstall) return;               // returning user — they know
    if (world.entities.length > 0) { hideCanvasEmpty(); return; }
    canvasEmptyEl.classList.remove('hidden');  // the card itself is
    // pointer-events:none — pan/zoom stay fully alive; only .ce-btn
    // is interactive (exempted from the canvas gesture swallow below).
  }

  function showMenu(x, y) {
    menuEl.classList.remove('hidden');
    const menuW = menuEl.offsetWidth || 160;
    const menuH = menuEl.offsetHeight || 50;
    const cx = Math.max(menuW / 2 + 8, Math.min(W - menuW / 2 - 8, x));
    const cy = Math.max(menuH / 2 + 8, Math.min(H - menuH / 2 - 8, y));
    menuEl.style.left = cx + 'px';
    menuEl.style.top = cy + 'px';
  }
  function hideMenu() { menuEl.classList.add('hidden'); }

  menuEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'new-chat') {
      const r = menuEl.getBoundingClientRect();
      const wp = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
      const icon = createIconAt(wp.x, wp.y);
      icon.vx = (Math.random() - 0.5) * 6;
      icon.vy = (Math.random() - 0.5) * 6;
      startAnimation();
    }
    hideMenu();
  });

  // ── Input state machine ───────────────────────────────────────
  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD = 10;

  let inputState = 'IDLE';
  let startScreenX = 0, startScreenY = 0;
  let lastScreenX = 0, lastScreenY = 0;
  let lastTime = 0;
  let longPressTimer = null;
  let draggedIcon = null;
  let dragVel = { vx: 0, vy: 0, t: 0 };

  function findIconAt(screenX, screenY) {
    const bots = world.entities;
    for (let i = bots.length - 1; i >= 0; i--) {
      const bot = bots[i];
      const sx = (bot.x - offsetX) * scale;
      const sy = (bot.y - offsetY) * scale;
      const dx = screenX - sx;
      const dy = screenY - sy;
      // Hit-test radius: the icon's visual radius * scale, plus a
      // generous slack (20px) so icons are easy to tap even when zoomed
      // out. Also enforce a minimum hit radius of 28px so tiny icons
      // at low zoom are still tappable — finger-friendly.
      const visualR = bot.radius * scale;
      const r = Math.max(28, visualR + 20);
      if (dx * dx + dy * dy <= r * r) return bot;
    }
    return null;
  }

  function inputStart(screenX, screenY) {
    if (!menuEl.classList.contains('hidden')) {
      const r = menuEl.getBoundingClientRect();
      if (screenX >= r.left && screenX <= r.right &&
          screenY >= r.top && screenY <= r.bottom) return;
      hideMenu();
      return;
    }
    inputState = 'PENDING';
    startScreenX = lastScreenX = screenX;
    startScreenY = lastScreenY = screenY;
    lastTime = performance.now();
    velX = 0; velY = 0;
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      if (inputState === 'PENDING') {
        inputState = 'MENU_OPEN';
        showMenu(startScreenX, startScreenY);
      }
    }, LONG_PRESS_MS);
  }

  function inputMove(screenX, screenY) {
    if (inputState === 'IDLE' || inputState === 'MENU_OPEN') return;

    if (inputState === 'PENDING') {
      const dx = screenX - startScreenX;
      const dy = screenY - startScreenY;
      if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      draggedIcon = findIconAt(startScreenX, startScreenY);
      if (draggedIcon) {
        inputState = 'ICON_DRAG';
        draggedIcon.dragging = true;
        draggedIcon.el.classList.add('dragging');
        draggedIcon.vx = 0; draggedIcon.vy = 0;
      } else {
        inputState = 'PANNING';
      }
    }

    const now = performance.now();
    const dx = screenX - lastScreenX;
    const dy = screenY - lastScreenY;

    if (inputState === 'PANNING') {
      // INVERTED: content follows the finger.
      const ddx = -dx, ddy = -dy;
      offsetX += ddx; offsetY += ddy;
      const dt = now - lastTime;
      if (dt > 0) {
        velX = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, (ddx / dt) * 16));
        velY = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, (ddy / dt) * 16));
      }
      update();
    } else if (inputState === 'ICON_DRAG' && draggedIcon) {
      draggedIcon.x += dx / scale;
      draggedIcon.y += dy / scale;
      const dt = now - lastTime;
      if (dt > 0) {
        dragVel.vx = (dx / dt) * 16;
        dragVel.vy = (dy / dt) * 16;
        // Cap fling velocity so even a hard flick doesn't send the icon
        // flying off-screen. With the airy friction (0.92 in physics.js),
        // a max-velocity fling (18px/frame) travels ~225px — satisfying
        // slide distance, not lost in the void.
        const MAX_FLING = 18;
        dragVel.vx = Math.max(-MAX_FLING, Math.min(MAX_FLING, dragVel.vx));
        dragVel.vy = Math.max(-MAX_FLING, Math.min(MAX_FLING, dragVel.vy));
        dragVel.t = now;
      }
      update();
    }
    lastScreenX = screenX; lastScreenY = screenY; lastTime = now;
  }

  function inputEnd() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

    if (inputState === 'PENDING') {
      // Tap with no movement + no long-press.
      const icon = findIconAt(startScreenX, startScreenY);
      if (icon) {
        icon.flash();
        // Reduced delay: was 500ms (felt too long). 150ms gives a quick
        // flash-then-panel feel without the lag.
        setTimeout(function () {
          // v0.14: reset per-open header state — the far-left model button
          // is hidden until ChatPanel shows it (chat icons with a model).
          var modelBtn = document.getElementById('panel-model-btn');
          if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
          // v0.34: the ★ quick-switch reset is gone with the button itself.
          // v0.14: the chat UI is full-bleed (its own padding); other panel
          // types keep the default 20px from the stylesheet.
          panel.bodyEl.style.padding = icon.type === 'chat' ? '0' : '';
          panel.open({
            title: icon.getPanelTitle(),
            subtitle: icon.getPanelSubtitle(),
            avatarHTML: icon.getAvatarHTML(),
            bodyHTML: icon.getPanelBodyHTML(),
            context: icon
          });
          // If the icon is a ChatIcon, render the interactive chat panel
          // into the panel body (replaces the static placeholder HTML).
          if (icon.type === 'chat' && window.ChatPanel) {
            window.ChatPanel.render(panel.bodyEl, icon, panel);
          }
        }, 150);
      }
      inputState = 'IDLE';
      return;
    }

    if (inputState === 'PANNING') {
      inputState = 'IDLE';
      if (performance.now() - lastTime < 100) startAnimation();
      else velX = 0, velY = 0;
      scheduleSave();
    } else if (inputState === 'ICON_DRAG' && draggedIcon) {
      if (performance.now() - dragVel.t < 100) {
        draggedIcon.vx = dragVel.vx; draggedIcon.vy = dragVel.vy;
      } else { draggedIcon.vx = 0; draggedIcon.vy = 0; }
      draggedIcon.dragging = false;
      draggedIcon.el.classList.remove('dragging');
      draggedIcon = null;
      inputState = 'IDLE';
      startAnimation();
      scheduleSave();
    } else { inputState = 'IDLE'; }
  }

  // ── Zoom ──────────────────────────────────────────────────────
  function zoomAt(factor, cx, cy) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    if (newScale === scale) return;
    const f = 1 / scale - 1 / newScale;
    offsetX = offsetX + cx * f;
    offsetY = offsetY + cy * f;
    scale = newScale;
    update();
  }

  // ── Pinch state ───────────────────────────────────────────────
  let pinching = false;
  let pinchStartDist = 0, pinchStartScale = 1;
  let pinchStartOffsetX = 0, pinchStartOffsetY = 0;
  let pinchCenter = { x: 0, y: 0 };

  function touchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Event listeners ───────────────────────────────────────────
  const settingsBtnEl = document.getElementById('settings-btn');
  // v0.31.2: the canvas dock — the › arrow + its strip, left of the gear.
  const dockToggleEl = document.getElementById('dock-toggle');
  const dockStripEl = document.getElementById('dock-strip');

  function isInsideUI(target) {
    if (!target) return false;
    // v0.45 ITEM 1: a closing panel never blocks canvas touches — the
    // sheet is sliding away; touches must reach the grid immediately.
    // (Belt-and-suspenders: pointer-events:none on the closing panel
    // already routes touches past it, but this guarantees it.)
    if (panel.panelEl.classList.contains('closing')) return false;
    // ConnectOverlay covers the full screen (inset:0) while open — any
    // touch during that state is a UI touch. v0.10.1 MISSING THIS CHECK
    // WAS THE "nothing is interactable, not even the X" BUG: touches in
    // the overlay fell through to the document handlers, whose
    // preventDefault() suppressed the synthetic click events the
    // overlay's buttons need. (Mouse clicks fire regardless of
    // preventDefault on touchstart — which is why desktop dogfooding
    // never caught it.)
    if (window.ConnectOverlay && window.ConnectOverlay.isOpen()) return true;
    // v0.17: the artifacts drawer/editor overlay + the long-press action
    // sheet are appended to document.body (NOT inside the chat panel) —
    // without these checks their buttons were dead on touch for the
    // exact same reason.
    var artOverlay = document.getElementById('artifacts-overlay');
    if (artOverlay && artOverlay.contains(target)) return true;
    var actionSheet = document.getElementById('msg-action-sheet');
    if (actionSheet && actionSheet.contains(target)) return true;
    // v0.34: the crop overlay (uikit.js CropUI) + the fullscreen media zoom
    // (formatter.js MediaZoom) both append themselves to document.body —
    // WITHOUT these checks their touches fell through to the canvas pan
    // handlers (the grid moved behind the cropper!) and the document-level
    // preventDefault() killed the zoom slider's native touch drag — the
    // exact #sheet-root class of bug, phone-only (mouse clicks fire
    // regardless of touchstart preventDefault, so Playwright never saw it).
    if (target.closest && target.closest('.crop-ui')) return true;
    var mediaZoom = document.getElementById('media-zoom');
    if (mediaZoom && mediaZoom.contains(target)) return true;
    // (v0.26's #sheet-root was NEVER in this list — that omission is why
    // the sheet's buttons were dead on Android while desktop dogfooding
    // and Playwright both passed. It is deleted now; the master panel and
    // the connect overlay are the only two panel types left.)
    // v0.31.2: the canvas dock joins its gear sibling — without these
    // checks the strip's buttons die the same death on Android.
    // v0.85.2: the expando capsule wraps the toggle + strip now — one
    // contains() covers the whole cluster (toggle/strip/sub).
    if (dockExpandoEl && dockExpandoEl.contains(target)) return true;
    if (dockStripEl && dockStripEl.contains(target)) return true;
    if (dockToggleEl && dockToggleEl.contains(target)) return true;
    // v0.82.2: the first-run empty-state card — the card body is
    // pointer-events:none (touches pass through to the canvas), but its
    // CTA button is interactive and must not be swallowed by the canvas
    // pan handlers (the same preventDefault death the dock buttons
    // needed exempting from).
    if (canvasEmptyEl && canvasEmptyEl.contains(target)) return true;
    return menuEl.contains(target) ||
           settingsBtnEl.contains(target) ||
           panel.panelEl.contains(target) ||
           panel.scrimEl.contains(target);
  }

  // Touch
  document.addEventListener('touchstart', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      inputState = 'IDLE'; velX = 0; velY = 0;
      if (draggedIcon) {
        draggedIcon.dragging = false;
        draggedIcon.el.classList.remove('dragging');
        draggedIcon = null;
      }
      pinching = true;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      pinchStartOffsetX = offsetX; pinchStartOffsetY = offsetY;
      pinchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      inputStart(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  document.addEventListener('touchmove', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2 && pinching) {
      e.preventDefault();
      const d = touchDist(e.touches[0], e.touches[1]);
      const factor = d / pinchStartDist;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * factor));
      const worldX = pinchCenter.x / pinchStartScale + pinchStartOffsetX;
      const worldY = pinchCenter.y / pinchStartScale + pinchStartOffsetY;
      offsetX = worldX - pinchCenter.x / newScale;
      offsetY = worldY - pinchCenter.y / newScale;
      scale = newScale;
      update();
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      inputMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  document.addEventListener('touchend', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 0) {
      if (pinching) pinching = false;
      e.preventDefault(); inputEnd();
    } else if (e.touches.length === 1 && pinching) {
      pinching = false; inputState = 'IDLE'; velX = 0; velY = 0;
    }
  }, { passive: false });

  document.addEventListener('touchcancel', function () {
    if (pinching) pinching = false;
    if (inputState !== 'IDLE') inputEnd();
  });

  // Mouse
  document.addEventListener('mousedown', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault(); inputStart(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', function (e) { inputMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { inputEnd(); });

  // Wheel zoom
  document.addEventListener('wheel', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY);
  }, { passive: false });

  document.addEventListener('contextmenu', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
  });

  // Settings gear → spin animation + open settings panel.
  settingsBtnEl.addEventListener('click', function () {
    // Trigger the spin animation: add .spinning, remove after 0.4s.
    // The CSS rotates the SVG 180° while .spinning is active; removing
    // it snaps back, giving a quick spin-and-return effect.
    settingsBtnEl.classList.add('spinning');
    setTimeout(function () { settingsBtnEl.classList.remove('spinning'); }, 400);
    window.Settings.openInPanel(panel);
  });

  // Listen for custom action events (e.g. "reset-view" from Appearance page).
  window.addEventListener('doomalay:action', function (e) {
    if (!e.detail) return;
    if (e.detail.action === 'reset-view') {
      window.doomalay.resetView();
    }
  });

  // ── v0.41: openChatPanelFor — shared by the canvas-dock views (the
  // hub) and window.doomalay.openChatBySession (global search jumps).
  // Opens a chat panel exactly the way a chatbot tap does — so a
  // canvas-side view has the master panel to ride on.
  function openChatPanelFor(icon) {
    // v0.14: reset per-open header state — the far-left model button
    // is hidden until ChatPanel shows it (chat icons with a model).
    var modelBtn = document.getElementById('panel-model-btn');
    if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
    // v0.14: the chat UI is full-bleed (its own padding).
    panel.bodyEl.style.padding = icon.type === 'chat' ? '0' : '';
    panel.open({
      title: icon.getPanelTitle(),
      subtitle: icon.getPanelSubtitle(),
      avatarHTML: icon.getAvatarHTML(),
      bodyHTML: icon.getPanelBodyHTML(),
      context: icon
    });
    if (icon.type === 'chat' && window.ChatPanel) {
      window.ChatPanel.render(panel.bodyEl, icon, panel);
    }
  }

  // findIconBySession — the grid IS the chat list; icons carry their
  // engine session id (v0.15).
  function findIconBySession(sid) {
    if (!sid) return null;
    for (const e of world.entities) {
      if (e.type === 'chat' && e.sessionId === sid) return e;
    }
    return null;
  }

  // openChatBySession(sid, { ei }) — v0.41 GLOBAL SEARCH JUMP.
  // Finds (or recreates) the chat icon for an engine session, opens its
  // panel, and optionally scrolls to + flashes a specific engine event
  // (the WhatsApp/Telegram "tap result → jump to message" pattern).
  // A NULL sid opens the first chat icon — the hub/search "host panel"
  // fallback when the dock fires from the bare canvas. Returns a
  // Promise<boolean>: did a panel open?
  function openChatBySession(sid, opts) {
    opts = opts || {};
    var done = function (icon) {
      openChatPanelFor(icon);
      if (opts.ei !== undefined && opts.ei !== null) {
        jumpToEvent(opts.ei);
      }
    };
    var icon = sid ? findIconBySession(sid) : null;
    if (!sid) {
      // host-panel mode: any chat icon will do (the view that called
      // us rides the panel stack; the chat underneath is a backdrop).
      for (var i = 0; i < world.entities.length; i++) {
        if (world.entities[i].type === 'chat') { icon = world.entities[i]; break; }
      }
      if (!icon) return Promise.resolve(false);
      done(icon);
      return Promise.resolve(true);
    }
    if (icon) { done(icon); return Promise.resolve(true); }
    // No icon on the canvas (session created outside the grid, or the
    // icon was never made): fetch the session and materialize an icon
    // for it near the viewport center.
    return fetch('/api/sessions/' + encodeURIComponent(sid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return false;
        var wx = (W / 2 / scale) + offsetX + (Math.random() * 60 - 30);
        var wy = (H / 2 / scale) + offsetY + (Math.random() * 60 - 30);
        var ic = createIconAt(wx, wy);
        try {
          if (s.Title) ic.setName(s.Title);
          if (s.Model) ic.model = s.Model;
          if (s.Provider) ic.provider = s.Provider;
          if (s.Sandbox) ic.sandbox = s.Sandbox;
        } catch (e) {}
        ic.sessionId = sid;
        if (typeof ic.save === 'function') ic.save(); else scheduleSave();
        done(ic);
        return true;
      })
      .catch(function () { return false; });
  }

  // jumpToEvent — after a panel opens, the transcript loads async (WS
  // replay). Poll for the row carrying the engine event id, then scroll
  // it to the center and pulse it with the find-hit highlight.
  function jumpToEvent(ei) {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var row = panel.bodyEl && panel.bodyEl.querySelector('[data-ei="' + ei + '"]');
      if (row) {
        clearInterval(t);
        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {
          row.scrollIntoView(true);
        }
        row.classList.add('find-hit');
        setTimeout(function () { row.classList.remove('find-hit'); }, 2600);
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
      } else if (tries > 60) { // ~6s: transcript never materialized
        clearInterval(t);
      }
    }, 100);
  }

  // ── v0.31.2: THE CANVAS DOCK ──────────────────────────────────
  // A › arrow sits left of the settings gear. Tapping it flips to ‹ and
  // expands a vertical strip holding the two relocated entries: the
  // cloud provider screen (was Settings → Cloud) and the hub library
  // (was the chat util row's ◈ pill). The collapsed/expanded state
  // persists (doomalay.dock.v1) and is re-applied on every boot.
  const DOCK_KEY = 'doomalay.dock.v1';

  // v0.85.2: THE DOCK CAPSULE — one expando element owns the fixed slot;
  // the strip + sub live inside it. dockApply also drives the expando's
  // .open (the capsule bubble + the toggle's own pill dissolving into it).
  var dockExpandoEl = document.getElementById('dock-expando');
  var dockSubEl = document.getElementById('dock-sub');
  function dockApply(expanded, instant) {
    if (dockToggleEl) {
      dockToggleEl.classList.toggle('open', !!expanded);
      dockToggleEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      dockToggleEl.setAttribute('aria-label', expanded ? 'Collapse dock' : 'Expand dock');
    }
    if (dockExpandoEl) dockExpandoEl.classList.toggle('open', !!expanded);
    if (dockStripEl) {
      // v0.78.4: transform/opacity animation (motion-grade) — expand
      // unhides first then opens next frame; collapse reverses and
      // hides after the transition (boot restores skip the animation).
      if (expanded) {
        dockStripEl.classList.remove('hidden');
        if (instant) dockStripEl.classList.add('open');
        else requestAnimationFrame(function () {
          requestAnimationFrame(function () { dockStripEl.classList.add('open'); });
        });
      } else {
        dockStripEl.classList.remove('open');
        // v0.85.2: collapsing the dock also collapses the ＋ sub-expansion
        // (the sub pills only exist while the capsule is up).
        dockSubApply(false, instant);
        if (instant) dockStripEl.classList.add('hidden');
        else setTimeout(function () {
          if (!dockStripEl.classList.contains('open')) dockStripEl.classList.add('hidden');
        }, 180);
      }
    }
  }
  // v0.85.2: THE ＋ SUB-EXPANSION (user spec 3.2) — pressing ＋ grows the
  // capsule to fit the two creator pills (new chat panel / new browser
  // panel). Motion-grade entrance, the strip's own recipe.
  function dockSubApply(open, instant) {
    if (!dockSubEl) return;
    if (open) {
      dockSubEl.classList.remove('hidden');
      if (instant) dockSubEl.classList.add('open');
      else requestAnimationFrame(function () {
        requestAnimationFrame(function () { dockSubEl.classList.add('open'); });
      });
    } else {
      dockSubEl.classList.remove('open');
      if (instant) dockSubEl.classList.add('hidden');
      else setTimeout(function () {
        if (!dockSubEl.classList.contains('open')) dockSubEl.classList.add('hidden');
      }, 160);
    }
  }
  function dockSubIsOpen() {
    return !!(dockSubEl && !dockSubEl.classList.contains('hidden'));
  }
  function dockIsExpanded() {
    return !!(dockStripEl && !dockStripEl.classList.contains('hidden'));
  }

  if (dockToggleEl && dockStripEl) {
    let savedDock = null;
    try { savedDock = JSON.parse(localStorage.getItem(DOCK_KEY)); } catch (e) {}
    dockApply(!!(savedDock && savedDock.expanded), true);   // boot: instant, no animation

    dockToggleEl.addEventListener('click', function () {
      // v0.78.4: save the LOGICAL state — dockIsExpanded() reads the
      // .hidden class, which the collapse animation delays by 180ms
      // (the old save caught the transitional True and undid itself).
      var now = !dockIsExpanded();
      dockApply(now);
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify({ expanded: now }));
      } catch (e) {}
    });

    // v0.85.2: ＋ IS THE SUB-EXPANSION TOGGLE now (user spec 3.2: "when
    // pressing the + icon that creates a new chat (when the arrow icon
    // is expanded) we should have it, and the background pill bubble,
    // expand to fit 2 more pills") — the create intent moved onto the
    // revealed "new chat panel" pill (createChatAtCenterAndOpen, the
    // shared v0.82 path).
    const dockNewBtn = dockStripEl.querySelector('#dock-new');
    if (dockNewBtn) dockNewBtn.addEventListener('click', function () {
      var now = !dockSubIsOpen();
      dockSubApply(now);
      dockNewBtn.setAttribute('aria-expanded', now ? 'true' : 'false');
    });

    // v0.85.2: THE SUB PILLS (spec 3.2) — new chat panel + new browser
    // panel, each its own icon. The chat pill rides the shared
    // create-and-open path (the v0.82.1 intent, preserved); the browser
    // pill creates a web TAB entity + opens its browser-in-browser
    // panel (the v0.85.3 machinery — guarded while that loads).
    const dockNewChatBtn = dockStripEl.querySelector('#dock-new-chat');
    if (dockNewChatBtn) dockNewChatBtn.addEventListener('click', function () {
      createChatAtCenterAndOpen();
    });
    const dockNewWebBtn = dockStripEl.querySelector('#dock-new-web');
    if (dockNewWebBtn) dockNewWebBtn.addEventListener('click', function () {
      if (window.WebTabs && window.WebTabs.createAtCenterAndOpen) {
        window.WebTabs.createAtCenterAndOpen();
        return;
      }
      if (window.Hub && window.Hub.toast) window.Hub.toast('browser panels arrive in the next phase of this build');
    });

    // v0.82.2: the empty-state CTA rides the SAME create-and-open path —
    // one primary action, one behavior, from both surfaces.
    const emptyBtn = canvasEmptyEl ? canvasEmptyEl.querySelector('#canvas-empty-btn') : null;
    if (emptyBtn) emptyBtn.addEventListener('click', function () {
      createChatAtCenterAndOpen();
    });

    // v0.85.2: the web globe pill is RETIRED from the main list (user
    // spec 3.2: "Remove the browser panel icon aswell as now it is moved
    // under the +") — browser creation lives on the ＋ sub-expansion's
    // "new browser panel" pill now. The legacy dock-web handler is gone
    // with the button.

    // Cloud glyph → the provider screen, relocated from Settings → Cloud.
    // Same panel, same wiring (the overlay works from anywhere).
    const dockCloudBtn = dockStripEl.querySelector('#dock-cloud');
    if (dockCloudBtn) dockCloudBtn.addEventListener('click', function () {
      if (window.ProvidersScreen) window.ProvidersScreen.open(null, {});
    });

    // v0.52: ONE chats glyph — the merged all-chats index + global search
    // (chatsview.js). The separate ⌕ glyph is gone (user item 4: "they
    // serve almost the same purpose"); GlobalSearch.open() delegates to
    // the same view, so the keys.js shortcut is unchanged.
    const dockChatsBtn = dockStripEl.querySelector('#dock-chats');
    if (dockChatsBtn) dockChatsBtn.addEventListener('click', function () {
      if (window.ChatsView) window.ChatsView.open();
    });

    // Library glyph → the hub library, relocated from the chat util
    // row's ◈ pill — the SAME open path the pill had: the hub view
    // rides the master panel's view stack (panel.js pushView + the
    // slide-up animation).
    // v0.52 (user item 5): the library is DECOUPLED from chats. Opened
    // from the canvas it carries NO chat connection ({chat:null} — the
    // pill reads "no chat"); opened from an already-open chat panel it
    // still auto-connects that chatbot's chat.
    const dockLibraryBtn = dockStripEl.querySelector('#dock-library');
    if (dockLibraryBtn) dockLibraryBtn.addEventListener('click', function () {
      if (!window.Hub) return;
      // A chat panel is already up → the pill's exact path applies
      // (Hub.open derives + connects THIS chat).
      var cur = window.ChatPanel && window.ChatPanel.current();
      if (cur && cur.panel && cur.panel.isOpen()) { window.Hub.open(); return; }
      // From the bare canvas (the dock sits under an open panel's scrim,
      // so this is the only other case) — open a host panel first, then
      // push the hub view on top of it with NO chat connected.
      var icon = (cur && cur.icon) || null;
      if (!icon) {
        for (const e of world.entities) { if (e.type === 'chat') { icon = e; break; } }
      }
      if (!icon) { window.Hub.open(); return; }  // toasts "open a chat first"
      openChatPanelFor(icon);
      // v0.60 pt B: canvasHost — the panel below is just a HOST for the
      // library. Back/✕ on the library's main browsing page closes the
      // whole panel (canvas), never the synthetic host chat.
      window.Hub.open(undefined, { chat: null, canvasHost: true });
    });
  }

  // ── v0.79.1: THE CANVAS FINGERPRINT GATE + rAF COALESCING ──────
  // The settings onChange listener used to run update() — a FULL canvas
  // repaint (the 2× colorspace background tile + every dot/line/icon +
  // offscreen arrows) — on EVERY settings event, even when the change
  // had zero canvas effect (an accent, a text color, a fmt slot), and
  // 5–10 input events per frame stacked 5–10 full repaints in one tick.
  // The fingerprint captures exactly what renderGrid() reads; the rAF
  // coalescing guarantees at most ONE update() per frame (latest-wins —
  // the canvas state is a pure function of the settings).
  function canvasFingerprint() {
    const s = window.Settings.getState();
    const DT = window.DoomTheme || {};
    const ov = (s.themeOverrides && s.themeOverrides[s.theme || 'midnight']) || null;
    return [
      s.theme, s.gridSize, s.spaceParallax, s.hideGridLines, s.hideDots,
      s.dotScatter, s.lineScatter, s.dotSizeVariation, s.lineSizeVariation,
      s.dotSizeBias, s.lineSizeBias, s.dotRotation, s.lineRotation,
      s.dotAnimate, s.lineAnimate,
      s.gridScatter, s.gridSizeVariation, s.gridRotation,   // legacy fallbacks
      JSON.stringify(s.bg), JSON.stringify(s.lineColor),
      JSON.stringify(s.dotColor), JSON.stringify(s.originColor),
      // the CANVAS-relevant override only: --bg-panel paints the canvas
      // background (spec + texture); --border-strong tints the canvas
      // icons. The REST of the overrides (accents, surfaces, text) have
      // zero canvas effect — an accent drag must NOT repaint the canvas.
      JSON.stringify((ov && ov['--bg-panel']) || null),
      (typeof DT.resolvedThemeVar === 'function')
        ? DT.resolvedThemeVar('--border-strong') : ''
    ].join('|');
  }
  let lastCanvasFp = null;
  let canvasUpdateRaf = 0;
  function scheduleCanvasUpdate() {
    if (canvasUpdateRaf) return;
    canvasUpdateRaf = requestAnimationFrame(function () {
      canvasUpdateRaf = 0;
      update();
    });
  }

  // Re-render on settings change (live color updates).
  window.Settings.onChange(function () {
    // v0.79.1: only canvas-relevant changes repaint the canvas, and at
    // most once per frame.
    const fp = canvasFingerprint();
    if (fp !== lastCanvasFp) {
      lastCanvasFp = fp;
      scheduleCanvasUpdate();
    }
    // v0.75: an animate toggle flipping ON starts the ambient loop (a
    // plain update() renders one frame — the twinkle/drift needs rAF).
    if (ambientActive()) startAnimation();
    // Also sync the names list to the NamePicker so new chatbots use edited names.
    const names = window.Settings.getState().names;
    if (Array.isArray(names) && names.length > 0) {
      namePicker.names = [...names];
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 100); });

  // ── Persistence ──────────────────────────────────────────────
  const STORAGE_KEY = 'doomalay.state.v2';
  let saveScheduled = false;

  function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(function () { saveScheduled = false; saveNow(); }, 200);
  }
  function saveNow() {
    const state = {
      offset: { x: offsetX, y: offsetY },
      scale: scale,
      currentFamily: currentFamily,
      icons: world.entities.map(function (c) { return c.serialize(); }),
      savedAt: Date.now()
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('doomalay: save failed', e); }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    // Load config from the server (best-effort — fall back to defaults).
    try {
      const [namesRes, famRes] = await Promise.all([
        fetch('config/names.json'),
        fetch('config/families.json')
      ]);
      if (namesRes.ok) {
        const d = await namesRes.json();
        if (Array.isArray(d.names) && d.names.length > 0) config.names = d.names;
      }
      if (famRes.ok) {
        const d = await famRes.json();
        if (d.families && typeof d.families === 'object') {
          config.families = Object.assign({}, DEFAULT_FAMILIES, d.families);
        }
        if (typeof d.defaultFamily === 'string') config.defaultFamily = d.defaultFamily;
      }
    } catch (e) {
      console.warn('doomalay: config fetch failed, using defaults', e);
    }

    currentFamily = config.defaultFamily;

    // Settings names override config names if the user has edited them.
    const settingsNames = window.Settings.getState().names;
    if (Array.isArray(settingsNames) && settingsNames.length > 0) {
      config.names = [...settingsNames];
    }
    namePicker.names = [...config.names];

    // Restore saved state.
    const saved = loadState();
    if (saved) {
      offsetX = (saved.offset && saved.offset.x) || 0;
      offsetY = (saved.offset && saved.offset.y) || 0;
      if (typeof saved.scale === 'number') {
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.scale));
      }
      if (saved.currentFamily && config.families[saved.currentFamily]) {
        currentFamily = saved.currentFamily;
      }
      // Migrate: old storage key (v1) stored chatbots; new key (v2) stores icons.
      // Try both 'icons' (new) and 'chatbots' (old v0.7.0/v0.8.0).
      const savedIcons = saved.icons || saved.chatbots;
      if (Array.isArray(savedIcons)) {
        // v0.20 HEAL: installs saved before the unique-id fix can carry
        // DUPLICATE ids (the nextId reset bug) — two chats sharing one id
        // cross-wired their panel states. Rename later duplicates BEFORE
        // construction so every restored chat gets its own state entry.
        // The renamed chat keeps its sessionId, so its history stays
        // attached — only the internal id changes.
        // v0.38 SESSION-ISOLATION HEAL: the same era of saves can also
        // carry TWO icons bound to the SAME engine sessionId — both then
        // replay each other's full history on every WS connect and write
        // into one event log (the data-level chat leak). The FIRST icon
        // keeps the session; later duplicates are unbound and create a
        // fresh engine session on their next open.
        const seenIds = new Set();
        const seenSessions = new Set();
        for (const c of savedIcons) {
          // v0.35 WHITE-SCREEN GUARD: one corrupt entry (a string, null, or
          // a malformed object from a crashed write) used to throw here in
          // strict mode → init() aborted → __doomalayReady never set → the
          // app booted to a dead blank screen, permanently. Skip poison
          // entries; the rest of the chats still load.
          if (!c || typeof c !== 'object') continue;
          try {
            if (!c.id) c.id = 'chat_' + Math.random().toString(36).slice(2, 10);
            while (seenIds.has(c.id)) {
              c.id = c.id + '_' + Math.random().toString(36).slice(2, 6);
            }
            seenIds.add(c.id);
            if (c.sessionId) {
              if (seenSessions.has(c.sessionId)) c.sessionId = ''; // own sandbox on next open
              else seenSessions.add(c.sessionId);
            }
          } catch (e) { continue; }
        }
        for (const c of savedIcons) {
          try {
            if (!c || typeof c !== 'object') continue;
            if (!c.type) c.type = 'chat';  // migration from v0.7.0
            const icon = window.GridIcon.create(c);
            if (icon) {
              world.add(icon);
              iconLayer.appendChild(icon.el);
            }
          } catch (e) {
            console.warn('doomalay: skipped a corrupt saved chat entry', e);
          }
        }
      }
    }

    // v0.82.2: the first-run empty-state — only a FRESH install (no
    // saved layout at all) with ZERO restored icons sees the card.
    // `saved` null = this device has never placed an icon (returning
    // users who deleted everything still have a saved layout → skip).
    maybeShowCanvasEmpty(!saved);

    updateIconBudget();   // v0.85.1: the restored world sets the icon budget
    resize();

    // v0.84.1 THE ATOM FEED — every restored chat with bound workspaces
    // gets its orbiting stars: one count fetch per session (parallel,
    // best-effort), then the rAF loop starts itself through the
    // atoms-changed event below.
    if (window.Atoms) window.Atoms.refreshAll(world.entities);

    // v0.84.2 THE PERSONA BADGE — the ACTIVE persona's ring paints around
    // each chat's icon (boot + every persona save; persona.js's persist()
    // dispatches doomalay:persona-saved after every PATCH).
    refreshPersonaRings();
    window.addEventListener('doomalay:persona-saved', function (e) {
      var sid = e && e.detail && e.detail.sessionId;
      if (sid) refreshPersonaRings(sid); else refreshPersonaRings();
    });

    // v0.84.1: binding changes (workspace.js bind/unbind, the pill's live
    // count, chatpanel's session swap) re-fetch exactly the touched chat;
    // the atoms-changed event (Atoms' own, on a count change) starts the
    // animation loop so the stars begin moving.
    window.addEventListener('doomalay:workspaces-changed', function (e) {
      if (!window.Atoms) return;
      var sid = e && e.detail && e.detail.sessionId;
      if (sid) {
        for (const icon of world.entities) {
          if (icon.sessionId === sid) { window.Atoms.refresh(icon); break; }
        }
      } else {
        window.Atoms.refreshAll(world.entities);
      }
    });
    window.addEventListener('doomalay:atoms-changed', function () {
      startAnimation();
    });

    // v0.15: recovery.js's boot watchdog — flip the flag once the canvas +
    // icons are live. (A stalled boot shows the recovery screen instead of
    // a dead white screen.)
    window.__doomalayReady = true;
  }

  init();
})();
