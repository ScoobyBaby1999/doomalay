# PLAN-V085 — THE FPS WAVE (renderer-path Phases 1–3)

User spec (verbatim): "Please if u may implement phases 1-3. To make
everything more responsive and achieve a higher fps."

Implements the first three phases of RESEARCH-V084-RENDERER-PATH.md:
  Phase 1 — measure + the remaining structural wins (vanilla)
  Phase 2 — OffscreenCanvas the grid painter into a worker
  Phase 3 — the PixiJS world layer (the icon ceiling)

The bar (unchanged from the research): 60fps desktop / 48fps sustained on a
mid-tier Android System WebView, at the phase's target load, measured by the
in-app FPS instrument, zero console errors. Every phase keeps a byte-stable
fallback path (the DOM/canvas code that runs today).

---

## v0.85.1 — PHASE 1: the instrument + the structural wins

### A. perfHUD.js (new file) + window.DoomalayPerf
- A rAF meter that runs ONLY while the HUD is visible (a fixed chip,
  `#perf-hud-chip`, top-left, theme tokens only): rolling display fps,
  avg/max frame ms, paints/s (renderGrid calls), atom frames/s.
- Long-task observer (PerformanceObserver 'longtask', buffered) → count +
  worst duration; window.DoomalayPerf = { fps, frameMs, frameMsMax,
  longTasks, longTaskWorst, paints, atomFrames, nodes, layers, batches }.
- DOM node count + compositor-layer ESTIMATE sampled every 2s
  (document.querySelectorAll('*').length; layers = .chatbot count +
  promoted chrome — labeled "est." honestly).
- Settings gains a 'Performance' page (Settings.registerPage): the meters
  rendered read-only + a `Show perf HUD` toggle (settings key perfHud,
  default false) + a `Painter` row that reports worker/main + Pixi mode
  (v0.85.2/.3 fill it live; rerender() on a 1s interval while the page is
  open — self-driving, stops when the page closes).
- app.js publishes into window.DoomalayPerf per paint: cache hit/miss
  counters (LC hits vs misses), paint batches (the new batcher), paint ms.

### B. THE MESH/AMBIENT BATCHER (app.js renderGrid)
The 44fps mesh case is per-element style churn: with a multi-stop dot spec
every dot sets its own fillStyle + beginPath/arc/fill (≈1500 fills/frame);
solid themes set ONE style and still fill per dot. THE FIX — bucket-batch:
- Dots: collect paint ops into buckets keyed (targetLayer, fillStyle string,
  alpha bucket 1/8 steps). Flush: one beginPath + moveTo+arc per dot, ONE
  fill per bucket. Solid+no-anim = 1 bucket 1 fill (was 1500 fills).
  Mesh fields are smooth → tens of buckets. >96 buckets → per-dot fallback
  (identical to today's path; never worse).
- Segments: same bucketing on (targetLayer, strokeStyle, lineWidth quantized
  to 0.25px, alpha bucket); the shuttle brightness ramp quantizes at 0.08
  alpha steps (invisible on 1px dashes). Full-line mode: batch by style+width
  exact. Extremes/debug counters (weight, dotStats, lineStats, overIcons,
  dbgDots/dbgSegs, band counts) computed from the UN-quantized values —
  the existing rigs' contracts hold.
- Glow-halo dots stay individual (rare, jr ≥ 1.6× base, near band only).
- DoomalayDebug gains { batches: n, buckets: n } per frame.

### C. THE ICON-LAYER BUDGET (CSS + app.js)
- `.chatbot { contain: layout style; }` — containment stops per-icon layout/
  style fallout at the element boundary (paint stays for children).
- Dynamic will-change: >40 icons → #chatbots gains `.many-icons` →
  `.many-icons .chatbot { will-change: auto; }` (40+ simultaneous
  compositor layers cost more than the rare re-promotion on drag; the
  dragged icon gets .dragging → will-change back on).
- Re-audit: every per-icon effect stays a CHILD of the one .chatbot
  (persona ring + sandbox badge already are — assert in the rig).

### D. PANEL HOT PATHS (bounded)
- v0.78.3 already made streaming appends surgical (two-tier render).
- The remaining bounded win: the composer toolbar pill row rebuild —
  guard with a dirty flag so identical state re-renders skip innerHTML
  (only if measurable; red-line: don't restructure panel code).

Rig: scripts/v0851-perf-phase1-test.sh
(1) Settings lists the Performance page; perfHud toggle paints the chip;
(2) DoomalayPerf meters live (fps>0 while animating; longTasks counter
    exists; nodes>0; layers>=icons);
(3) THE BATCHER: mesh dot+line specs + amp100 + both anims →
    DoomalayDebug.buckets>1 AND batches << dots (batching engaged) AND
    dotStats/weight/overIcons fields still populated (rig contracts);
    solid default → batches ≤ 2;
(4) >40 icons → .many-icons + will-change:auto (computed style);
    ≤40 after delete → class gone;
(5) visual proof: #c toDataURL non-empty under mesh (paint intact);
(6) zero console errors.
Re-verify: v0831 13/13, v0812 8/8, v0811 8/8, v0841 14/14 (unmodified —
no canvas-ownership change in this phase).

---

## v0.85.2 — PHASE 2: OffscreenCanvas the grid painter into a worker

### A. web/lattice.js — the extracted PURE painter (shared file)
- Moves from app.js: hashCell, the band machinery, shuttleRec/shuttleP,
  validStopsOf, shadeHex, rgbaStr, bgGradientPass, gridPaint (ctx param),
  makePatternSampler, MESH_SPOTS, paintBackgroundInto, bgTileFor +
  paintCanvasBackground (parallax camera + mirror tiling), the LC caches,
  and the full dot/line/segment/origin paint loops WITH the v0.85.1 batcher.
- Interface: `Lattice.render(gctx, gctx2, W, H, cam, P)` where
  cam={ox,oy,scale} and P = the resolved params blob {specs, fallbacks,
  effect params (scatter/size/bias/anim/amp/gridSize/hide), bgTileSpec,
  texReady}. Pure + stateless except the LC caches (module-level Maps).
  Worker-compatible: no DOM/window/document reads inside (texImageFor's
  Image → worker-side createImageBitmap via fetch(dataURL)).
- Exposes Lattice.stats (the DoomalayDebug twins: dots, segs, weight,
  overIcons, cache sizes, batches) — the caller publishes them.
- Loaded BOTH ways: <script src="lattice.js"> on the main thread (the
  fallback) AND importScripts('lattice.js') in the worker. One file, zero
  drift.

### B. web/gridworker.js — the paint worker
- Owns BOTH canvases: #c + #c2 via transferControlToOffscreen (transferred
  AFTER a 'ready' handshake — a failed boot never steals the canvases).
- Protocol (main → worker):
  {t:'ready-ack'} → {t:'transfer', off1, off2, W, H, dpr}
  {t:'resize', W, H}
  {t:'params', P}            (only when the fingerprint changes)
  {t:'frame', cam, atomsOnly, arrows[], entities[], atomCounts{},
   colors{accent,accent2,ring}, atomsOn}
- Worker → main: {t:'debug', blob} after every frame (the full
  DoomalayDebug lattice twin — rigs read it ~1 frame late, they sleep),
  {t:'tex-ready'} when a bumpmap finishes loading (main sends one more
  frame), {t:'stats', fps, ms} for DoomalayPerf every 500ms.
- The atom pass MOVES INTO THE WORKER (worker-side twin of atoms.js paint:
  stateless star math + counts + theme colors arrive per frame — the whole
  atom model is already stateless by design). The atom-only frame:
  atomsOnly=true → worker clears #c2 + paints atoms ONLY (the resting grid
  untouched — the v0.84.1 discipline, now worker-side).
- Arrows (renderOffScreenArrows) move into the frame payload (positions +
  resolved family hexes — no getComputedStyle in the worker).

### C. app.js — the Painter routing
- Painter = { mode: 'main'|'worker', post(frame) }: worker mode posts;
  main mode calls Lattice.render(ctx, ctx2, ...) directly (the EXACT
  today-path, byte-identical output).
- Settings key `workerPaint` (default TRUE). toggle → graceful switch:
  boot-time only for ON→OFF mid-session? The transfer is one-way —
  mid-session OFF requires a RELOAD (the toggle writes the setting +
  location.reload(); the rig drives it — documented in the page hint).
  Hmm — honest + simple. (Boot reads the setting: main-mode boots clean.)
- resize(): worker mode → post resize (worker sets both offscreen sizes;
  main sets only style.width/height — the bitmap belongs to the worker).
- ambientActive/tick/update: unchanged logic; tick's paint branch becomes
  Painter.post({cam, atomsOnly...}). The 'covered' panel check stays
  main-side (skip posting when fully covered).
- Boot failure paths: no OffscreenCanvas / worker script error / no
  'ready-ack' in 3s → mode 'main' (the fallback silently serves).
- DoomalayDebug continues to work: main side keeps camera/atoms stats;
  lattice twins arrive via {t:'debug'}.

### D. v0841 rig patch (1 line + comment)
The atom-orbits rig's toDataURL motion proofs read the DOM canvas bitmap —
a transferred canvas can't be read main-side. Patch: seed
`Settings.setState({workerPaint:false})` before load (the main-thread
fallback is the SAME paint code — the proof stays valid there), and the
NEW rig proves the worker path via the honest stats. v0831/v0812/v0811
don't touch toDataURL (verified) — untouched.

Rig: scripts/v0852-worker-paint-test.sh
(1) boot → DoomalayDebug.painter === 'worker' (transfer happened);
(2) dotAnimate ON → worker frames increase (DoomalayPerf.paints climbs);
    camera pans (synthetic drag) → frames climb + debug blob's camera moved;
(3) ATOM-ONLY: atoms bound + anims OFF → atomFrames climb, full frames
    FROZEN (the worker-side cheap frame);
(4) resize → worker W/H follow;
(5) fallback: setState workerPaint:false + reload → painter 'main' +
    toDataURL readable again;
(6) mesh + amp100 + both anims in WORKER mode → batches engaged (debug
    blob), zero console errors.
Re-verify: v0841 (patched) 14/14, v0831 13/13, v0812 8/8.

---

## v0.85.3 — PHASE 3: the PixiJS world layer (the icon ceiling)

### A. Vendor PixiJS v8 (web/vendor/pixi/pixi.min.js)
- pixi.js v8 core IIFE bundle from the official CDN (global PIXI).
  ~450KB gzipped — vendored like editor/pm/wunderbaum (licenses noted).
  LAZY-LOADED: a dynamic <script> only when the world layer activates —
  boot time untouched when off. NO WebGPU forced: default preference
  'webgl' (WebGL2), the v8 renderer falls back; if init() throws (no
  WebGL at all) → world layer off, DOM path unchanged.
- A Go test pins the vendor file (exists + >500KB — a drift guard).

### B. web/pixiworld.js — window.World3D
- ACTIVATION (the plan's gate, in code): settings `worldLayer` =
  'auto' (default) | 'on' | 'off'. auto → activates when chat icons ≥ 60
  (the measured DOM ceiling zone) AND WebGL available; deactivates below
  (app destroyed, GPU memory freed; re-boot ~100ms).
- THE STAGE: new canvas #c3 (fixed, z-index 100 — where #chatbots sits;
  pointer-events:none — input STAYS DOM). Application.init({
  canvas:#c3, backgroundAlpha:0, antialias:true, resolution:dpr(≤2),
  autoDensity:true, clearBeforeRender:true, preference:'webgl' }).
- ICONS AS SPRITES: texture per (icon, appearanceRev) — rasterize the disc
  to an offscreen canvas 2D exactly once per rev: family disc / letter /
  family glyph image / custom session icon / persona badge ring band
  (solid|gradient|image annulus) / sandbox badge chip. Sprite per chat,
  anchor 0.5, per-frame position from world entities (the ticker reads
  icon.x/y — physics + drag unchanged). Name labels: Pixi Text objects
  (canvas-rendered → cached texture), theme font/colors.
- THE DOM STAYS THE INPUT LAYER: #chatbots.pixi mode → .chatbot
  { opacity:0; will-change:auto; } — invisible hit-targets (taps, drags,
  long-press, elementFromPoint all keep working — pointer-events:auto
  intact); NO painted content, no compositor layer cost.
- ATOMS IN PIXI: stars = small Sprites (a pre-baked radial glow texture,
  additive BLEND_MODE — the emitted-light look) around each icon; per
  shell a faint Graphics ellipse (redrawn on layout change only); depth
  = zIndex (star z<0 sorts behind the icon sprite — the back-and-above
  occlusion, free via sortableChildren). In pixi mode the worker/main
  atom pass on #c2 is skipped (atomsOn:false in the frame payload).
- TAP FLASH: sprite scale pulse on icon.flash() (the DOM .tapped class is
  invisible in pixi mode).
- THEME: colors resolved via getComputedStyle → PIXI.Color; re-tint +
  re-rasterize ALL icon textures on doomalay:theme-changed /
  settings-change events (rare, cheap).
- CULLING: off-viewport sprites visible=false (the ticker checks bounds).
- window.World3D.debug = { active, mode, renderer, sprites, textures,
  stars } — the honest instrument (DoomalayPerf.layers flips to 'pixi').

### C. app.js + atoms.js wiring
- Boot + entity add/remove/serialize paths call World3D.sync(entities) —
  the world layer mirrors the entity list. icon.appearanceRev bumps on
  family/icon/persona/name changes (setName → re-raster; the DOM render
  path is untouched — both stay in sync).
- ambientActive: in pixi mode atoms ride Pixi's own ticker — the main rAF
  atom-only frame is skipped (the grid's animate toggles still drive it).
- The #c2 over-icons lattice routing unchanged (#c2 stays z150 — the big
  lattice elements still sweep over everything, including the world layer).

Rig: scripts/v0853-pixi-world-test.sh
(1) 65 seeded icons + worldLayer auto → World3D.debug.active + renderer
    'webgl' + sprites === 65 + textures ≥ 1 (batched atlas texture count);
(2) INPUT: elementFromPoint at an icon center → the .chatbot
    hit-target; a synthetic drag moves the entity AND the sprite follows
    (sample sprite x over frames);
(3) ATOMS: a bound workspace → star sprites > 0; sampled over ~1.6s the
    star zIndex/alpha varies (the back-and-above sweep);
(4) below 60 (10 icons) → inactive + .chatbot visible (opacity restored);
(5) worldLayer 'off' → inactive, DOM path untouched;
(6) theme change while active → debug.textures rebuilt (rev bumped);
(7) zero console errors.
Go: engine/internal/server/web_test pin for vendor/pixi (exists, >500KB).

---

## SEQUENCING + SHARED FILES
- v0.85.1 → v0.85.2 → v0.85.3 sequential (app.js is touched by all three:
  .1 owns renderGrid's batcher, .2 owns the Painter routing + lattice.js
  extraction (the batcher MOVES into lattice.js), .3 owns World3D wiring).
- Engine rebuilt after every web/ edit (go:embed all:web).
- Version → 0.85.0; tags v0.85.1-the-perf-instrument /
  v0.85.2-the-worker-painter / v0.85.3-the-pixi-world /
  v0.85.0-the-fps-wave; CI dispatched on tag refs; releases PATCHed.
- Red-team bar: the three new rigs + v0841 (patched) + v0831 + v0812 +
  v0811 + v0842 17/17 + theme twins.
