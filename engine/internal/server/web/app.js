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
  // v0.85.2: WHO owns the #c/#c2 BITMAPS is decided at LOAD
  // (Settings.workerPaint) — transferControlToOffscreen must precede
  // ANY getContext, so the worker path DEFERS ctx acquisition until the
  // handshake resolves (bootPainter); the fallback takes them here.
  const canvas2 = document.getElementById('c2');
  let ctx = null;
  let ctx2 = null;
  // v0.83.3 THE FRAME-RATE CAP: DPR is capped at 2. A 3× phone was painting
  // 2.25× the pixels of the cap for zero visible gain on a 1–4px dot
  // lattice (2× is already retina-sharp); raster fill-rate is the single
  // biggest frame cost when both lattices animate (the user's "canvas gets
  // low frame rate when animating both lines and dots"). DOM surfaces
  // (panel, icons, BIB) are unaffected — only the canvas raster halves.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // v0.85.2 THE PAINTER — 'main' (lattice.js on our ctxs) | 'worker'
  // (gridworker.js owns the bitmaps; see the Painter routing block)
  var Painter = { mode: 'main', worker: null, pf: '', pending: false,
                   framesPosted: 0, atomFramesPosted: 0,
                   entsSig: null };   // v0.88: the entity-clone omission's last-sent checksum
  (function decidePainter() {
    var st = window.Settings.getState();
    if (st && st.workerPaint && canvas && canvas2 &&
        typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
      Painter.pending = true;   // bootPainter completes the handshake
    } else {
      ctx = canvas.getContext('2d');
      ctx2 = canvas2 ? canvas2.getContext('2d') : null;
      try { window.DoomalayPerf.painter = 'main'; } catch (e) {}
    }
  })();

  let W = 0, H = 0;
  let offsetX = 0, offsetY = 0;
  let scale = 1;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3.0;
  let velX = 0, velY = 0;
  let animating = false;

  const PAN_FRICTION = 0.88;
  const MAX_PAN_VELOCITY = 18;

  const GRID_BASE = 48;    // lattice.js's twin (kept for any future
                           // main-thread spacing math; the painter owns
                           // the real one)

  // v0.94.4 (D2): THE RESIZE WAVE — a resize burst (Android inset
  // animations fire one per frame) used to resize the canvas BITMAPS on
  // every event (a realloc + full clear per frame — the bitmap churn
  // behind the post-gesture-nav lag). The CHEAP part (the CSS style
  // sizing) stays per-event so the canvas never visually desyncs; the
  // EXPENSIVE part (bitmap realloc + repaint) debounces 150ms — one
  // realloc at the end of the burst.
  var resizeDebounce = 0;
  var resizeBooted = false;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    if (canvas2) {
      canvas2.style.width = W + 'px';
      canvas2.style.height = H + 'px';
    }
    // the BOOT resize applies synchronously (the first frame must be
    // true-geometry — a 300×150 default for 150ms would flash on the
    // non-worker path)
    if (!resizeBooted) { resizeBooted = true; applyBitmapResize(); return; }
    if (resizeDebounce) return;
    resizeDebounce = setTimeout(function () {
      resizeDebounce = 0;
      applyBitmapResize();
    }, 150);
  }
  function applyBitmapResize() {
      // v0.85.2: worker mode — the BITMAPS belong to the worker; it sizes
      // them + reapplies the DPR transform (the DOM style above is ours)
      if (Painter.mode === 'worker' || Painter.pending) {
        try { if (Painter.worker) Painter.worker.postMessage({ t: 'resize', W: W, H: H, dpr: dpr }); } catch (e) {}
        update();
        return;
      }
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // v0.97: the one-object lattice bakes at the host DPR (sharp tiles;
      // the pattern fill compensates for any mismatch geometrically)
      try { if (window.Lattice && window.Lattice.setDpr) window.Lattice.setDpr(dpr); } catch (e) {}
      // v0.81.2: the over-icons twin rides the EXACT same geometry
      if (canvas2 && ctx2) {
        canvas2.width = Math.floor(W * dpr);
        canvas2.height = Math.floor(H * dpr);
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

  // ── v0.85.2 THE PAINTER ROUTING (renderer-path Phase 2) ──────────
  // The whole lattice paint (the parallax background tile painter, the
  // pattern samplers, the v0.83.3 lattice cache, the v0.85.1 batcher,
  // the depth bands, the shooting-star shuttle, the over-icons routing,
  // the origin dot) moved VERBATIM into lattice.js — the ONE file the
  // main thread and the grid worker both execute (zero drift by
  // construction). app.js keeps: the settings/theme resolution
  // (buildLatticeParams — the same reads the old renderGrid made), the
  // camera, the frame AUTHORITY (tick/update decide when a frame is
  // wanted — the worker never self-drives), and the DOM (icons, arrows,
  // panel). Painter.mode:
  //   'main'   → Lattice.render(ctx, ctx2, …) — the fallback path,
  //              byte-identical to the pre-worker frame.
  //   'worker' → gridworker.js owns the #c/#c2 BITMAPS (transferred
  //              after a ready handshake — a failed boot never steals
  //              the canvases); paintGridFrame posts one message per
  //              paint, P riding only when its fingerprint changed
  //              (texture dataURLs are heavy).
  function buildLatticeParams() {
    const t = (window.DoomTheme && window.DoomTheme.effectiveGrid)
      ? window.DoomTheme.effectiveGrid(window.Settings.getState())
      : window.Settings.getState();
    const specs = (window.DoomTheme && window.DoomTheme.effectiveGridSpecs)
      ? window.DoomTheme.effectiveGridSpecs(window.Settings.getState())
      : null;
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    const DT = window.DoomTheme || {};
    var canvasSpec = (DT.canvasBgSpec || DT.appBgSpec)
      ? (DT.canvasBgSpec || DT.appBgSpec)(window.Settings.getState())
      : (specs && specs.bg);
    var st = window.Settings.getState();
    function numOr(v, legacy) {
      if (typeof v === 'number') return v;
      if (typeof legacy === 'number') return legacy;
      return 0;
    }
    var amp = (typeof st.spaceParallax === 'number') ? st.spaceParallax : 0;
    amp = Math.max(0, Math.min(100, amp)) / 100;
    // v0.52: the backdrop camera slows 0.35 → 0.08 at full amp — the
    // worker has no Settings, so the resolved rate rides the P blob
    var bgP = Math.max(0.08, 0.35 - 0.27 * amp);
    return {
      t: t, specs: specs,
      canvasSpec: canvasSpec,
      bgFallback: (HEX_RE.test(t.bg || '')) ? t.bg : '#0a0a0b',
      gridSize: (typeof st.gridSize === 'number') ? st.gridSize : 1,
      hideLines: !!st.hideGridLines,
      hideDots: !!st.hideDots,
      scatterL: numOr(st.lineScatter, st.gridScatter),
      scatterD: numOr(st.dotScatter, st.gridScatter),
      sizeVarL: numOr(st.lineSizeVariation, st.gridSizeVariation),
      sizeVarD: numOr(st.dotSizeVariation, st.gridSizeVariation),
      rotVarL: numOr(st.lineRotation, st.gridRotation),
      rotVarD: numOr(st.dotRotation, st.gridRotation),
      biasL: (typeof st.lineSizeBias === 'number') ? st.lineSizeBias : 0,
      biasD: (typeof st.dotSizeBias === 'number') ? st.dotSizeBias : 0,
      animDots: !!st.dotAnimate,
      animLines: !!st.lineAnimate,
      amp: amp,
      bgP: bgP
    };
  }

  // the params fingerprint — everything the P blob carries (same content
  // the old renderGrid's fpNow joined; posted to the worker only when it
  // CHANGES so dataURL-heavy specs ride exactly once per settings edit).
  // v0.88 ROOT FIXES: (1) the spec digests ride Lattice.cheapJSON — a
  // dataURL-bearing canvasSpec used to re-serialize its 100s-of-KB on
  // EVERY full frame (the resting-ambient stringify tax); (2) scale/W/H
  // are OUT — they ride the cam message per frame and the resize message
  // on viewport changes, so a pan/zoom no longer re-posts the whole P
  // blob (the zoom re-post was the worker path's heaviest frame).
  function latticeFingerprint(P) {
    var cj = (window.Lattice && window.Lattice.cheapJSON) || JSON.stringify;
    return [P.scatterL, P.scatterD, P.sizeVarL, P.sizeVarD, P.rotVarL, P.rotVarD,
      P.biasL, P.biasD, P.animDots ? 1 : 0, P.animLines ? 1 : 0,
      P.gridSize, P.hideLines ? 1 : 0, P.hideDots ? 1 : 0,
      P.amp.toFixed(4),
      P.specs && P.specs.dotColor ? cj(P.specs.dotColor) : '', P.t.dotColor,
      P.specs && P.specs.lineColor ? cj(P.specs.lineColor) : '', P.t.lineColor,
      cj(P.canvasSpec), P.bgFallback, P.bgP.toFixed(4)].join('|');
  }

  // publishLatticeStats — the honest instrument (DoomalayDebug is the
  // rigs' contract; DoomalayPerf feeds the HUD)
  function publishLatticeStats(stats) {
    if (!stats) return;
    var prev = window.DoomalayDebug || {};
    var blob = {};
    for (var k in stats) blob[k] = stats[k];
    if (blob.atoms === undefined && prev.atoms !== undefined) blob.atoms = prev.atoms;
    if (blob.stars === undefined) blob.stars = prev.stars !== undefined ? prev.stars : 0;
    window.DoomalayDebug = blob;
    try {
      if (window.DoomalayPerf) {
        var DP = window.DoomalayPerf;
        DP.paints++;
        DP.batches = stats.batches || 0;
        DP.buckets = stats.buckets || 0;
        DP.cacheHits = stats.hits || 0;
        DP.cacheMisses = stats.misses || 0;
        DP.paintMs = stats.paintMs || 0;
      }
    } catch (e) {}
  }

  // computeArrows — the off-screen chat arrows (positions + family hexes
  // resolved HERE: the worker never touches getComputedStyle).
  // v0.88 ROOT FIX: --border-strong resolves through a 1s-TTL cache (+ a
  // theme-event reset) instead of a getComputedStyle per DEFAULT-family
  // off-screen bot PER FRAME — a panned canvas with a dozen off-screen
  // default chats burned a dozen computed-style reads every frame.
  var arrowHexCache = { at: -1e9, v: '' };
  function borderStrongHex() {
    var now = performance.now();
    if (now - arrowHexCache.at > 1000) {
      arrowHexCache.at = now;
      try {
        arrowHexCache.v = getComputedStyle(document.documentElement)
          .getPropertyValue('--border-strong').trim();
      } catch (e) {}
    }
    return arrowHexCache.v;
  }
  function resetArrowHex() { arrowHexCache.at = -1e9; }
  window.addEventListener('doomalay:theme-changed', resetArrowHex);
  window.addEventListener('doomalay:theme-applied', resetArrowHex);
  function computeArrows() {
    const margin = 50;
    var out = [];
    var bs = '';
    for (const bot of world.entities) {
      const s = worldToScreen(bot.x, bot.y);
      if (s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H) continue;
      const ax = Math.max(margin, Math.min(W - margin, s.x));
      const ay = Math.max(margin, Math.min(H - margin, s.y));
      const angle = Math.atan2(s.y - ay, s.x - ax);
      const fam = (config.families[bot.family] || config.families.default || {});
      let color = fam.color || '#4a4a5e';
      if (bot.family === 'default' || !fam.color) {
        if (!bs) bs = borderStrongHex();
        color = bs || color;
      }
      out.push({ x: ax, y: ay, angle: angle, color: color });
    }
    return out;
  }
  function paintArrows(g, list) {
    if (!g || !list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var ar = list[i];
      g.save();
      g.translate(ar.x, ar.y);
      g.rotate(ar.angle);
      g.fillStyle = ar.color;
      g.beginPath();
      g.moveTo(14, 0);
      g.lineTo(-8, -9);
      g.lineTo(-4, 0);
      g.lineTo(-8, 9);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
  function renderOffScreenArrows() { paintArrows(ctx, computeArrows()); }

  // entitiesForWorker — the plain clones the atom core reads.
  // v0.88 ROOT FIX (the entity-clone omission): the clones rode EVERY
  // frame message — a resting canvas with atoms re-cloned + structured-
  // cloned N icons per frame for positions that never changed. The
  // Painter.entsSig checksum (length + quantized positions) is O(N)
  // arithmetic with zero allocations; the clones only ride the message
  // when it CHANGES (add/remove/motion/radius), and gridworker caches
  // the last set. Boot/first frame: sig starts null → always sends.
  function entitiesSig() {
    var list = world.entities;
    var sig = list.length;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      sig = (sig * 31 + ((e.x * 8) | 0)) | 0;
      sig = (sig * 31 + ((e.y * 8) | 0)) | 0;
    }
    return sig;
  }
  function entitiesForWorker() {
    var out = [];
    for (const e of world.entities) {
      out.push({ id: e.id, type: e.type, sessionId: e.sessionId || '',
                 x: e.x, y: e.y, radius: e.radius });
    }
    return out;
  }
  // atomColorsForWorker — atoms.js's cached color triplets ("r,g,b")
  function atomColorsForWorker() {
    return (window.Atoms && window.Atoms.colorsFor) ? window.Atoms.colorsFor() : null;
  }

  // paintGridFrame — THE ONE paint entry (update/tick/renderGrid funnel
  // here). atomsOnly → the v0.84.1 cheap frame (clear #c2 + the star
  // layer ONLY — the resting grid untouched); otherwise the full lattice
  // + arrows + atoms. Worker mode posts the frame; main mode paints it
  // inline on OUR contexts — byte-identical pipelines either way.
  function paintGridFrame(atomsOnly, forceEnts) {
    if (Painter.mode === 'worker' && Painter.worker) {
      var par01 = 0;
      try {
        const stp = window.Settings.getState();
        if (stp && typeof stp.spaceParallax === 'number') par01 = Math.max(0, Math.min(100, stp.spaceParallax)) / 100;
      } catch (e) {}
      var msg = {
        t: 'frame',
        cam: { ox: offsetX, oy: offsetY, scale: scale },
        par: par01,   // v0.90.2: the Amplify parallax rides the frame (the nebula's lit limb)
        dots: (window.TabGroups && window.TabGroups.active()) ? window.TabGroups.dotsFor() : [],
        atomsOnly: !!atomsOnly,
        arrows: atomsOnly ? [] : computeArrows(),
        entities: null,
        counts: (window.Atoms && window.Atoms.countsOf) ? window.Atoms.countsOf() : {},
        colors: atomColorsForWorker(),
        atomsOn: !!(window.Atoms && window.Atoms.active(world.entities) &&
                    !(window.World3D && window.World3D.atomsOwned()))   // v0.85.4: pixi owns the stars when active
      };
      // v0.88: the clones ride ONLY on change (checksum above) or a
      // forced frame (boot/resize settles) — the worker caches the rest.
      var esig = entitiesSig();
      if (forceEnts || Painter.entsSig === null || esig !== Painter.entsSig) {
        Painter.entsSig = esig;
        msg.entities = entitiesForWorker();
      }
      if (!atomsOnly) {
        var P = buildLatticeParams();
        var fp = latticeFingerprint(P);
        if (fp !== Painter.pf) { Painter.pf = fp; msg.P = P; msg.pf = fp; }
      }
      try {
        Painter.worker.postMessage(msg);
        Painter.framesPosted++;
        if (atomsOnly) Painter.atomFramesPosted++;
      } catch (e) { /* reported by the watchdog; the worker owns the bitmaps */ }
      return;
    }
    // main mode — the exact pre-worker pipeline (lattice.js on our ctxs)
    if (atomsOnly) {
      if (ctx2) ctx2.clearRect(0, 0, W, H);
      paintAtoms();
      paintOrbitStars();   // v0.90.1: the orbit stars ride the cheap frame too
      return;
    }
    var stats = Lattice.render(ctx, ctx2, W, H,
      { ox: offsetX, oy: offsetY, scale: scale,
        dots: (window.TabGroups && window.TabGroups.active()) ? window.TabGroups.dotsFor() : null },
      buildLatticeParams());
    publishLatticeStats(stats);
    // v0.97.1: a pending debounced rebake means this frame painted stale
    // tiles — land the fresh bake with ONE follow-up frame (the ambient
    // loop may be resting; without this the stale raster sat forever)
    if (window.Lattice && window.Lattice.rebakePending && window.Lattice.rebakePending())
      schedulePostBakeFrame();
    renderOffScreenArrows();
    paintAtoms();
    paintOrbitStars();   // v0.90.1: the stars on the over-icons layer (they move)
  }
  function renderGrid() { paintGridFrame(false); }

  // v0.97.1: THE POST-BAKE FRAME — the tile lattice rebakes params/zoom
  // changes 150ms after they settle (tlBakeTiles' debounce); the interim
  // frames render the previous bake. This one-shot follow-up lands the
  // fresh tiles once the bake fires — in BOTH painter modes (the worker
  // asks for it via the repaint-wanted reply).
  var postBakeT = 0;
  function schedulePostBakeFrame() {
    if (postBakeT) return;
    postBakeT = setTimeout(function () {
      postBakeT = 0;
      renderGrid();
    }, 240);
  }

  // ── v0.85.2 THE WORKER BOOT ──────────────────────────────────────
  // transferControlToOffscreen is ONE-WAY and must precede ANY getContext
  // — the decision (Settings.workerPaint) is read at module load (the
  // decidePainter block above the resize fn), the transfer happens only
  // after the worker answers 'ready' (a failed boot falls back to main
  // mode with the canvases untouched), and init() AWAITS the handshake so
  // no paint races the transfer.
  function bootPainter() {
    return new Promise(function (resolve) {
      if (!Painter.pending) { resolve(); return; }
      var settled = false;
      var w = null;
      var to = 0;
      var done = function (ok) {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        if (ok) {
          Painter.mode = 'worker';
          Painter.entsSig = null;   // v0.88: a fresh worker has an empty entity cache — force the clones on the next frame
          try { window.DoomalayPerf.painter = 'worker'; } catch (e) {}
        } else {
          if (w) { try { w.terminate(); } catch (e) {} }
          Painter.worker = null;
          // the canvases were never transferred — take the main contexts
          ctx = canvas.getContext('2d');
          ctx2 = canvas2 ? canvas2.getContext('2d') : null;
          Painter.mode = 'main';
          try { window.DoomalayPerf.painter = 'main'; } catch (e) {}
        }
        Painter.pending = false;
        resolve();
      };
      try { w = new Worker('gridworker.js'); }
      catch (e) {
        Painter.pending = false;
        ctx = canvas.getContext('2d');
        ctx2 = canvas2 ? canvas2.getContext('2d') : null;
        resolve(); return;
      }
      Painter.worker = w;
      to = setTimeout(function () { done(false); }, 3000);
      w.onerror = function () { done(false); };
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.t === 'ready') {
          try {
            // v0.89.9 THE STRETCH FIX: the transferred OffscreenCanvas
            // INHERITS the element's bitmap at transfer time — and the
            // element default is 300×150. bootPainter runs BEFORE the
            // first resize() (init line order), so nothing had sized the
            // bitmaps yet. Size them HERE (the worker re-sizes on every
            // later resize message — its bitmaps, its job, but the very
            // first composited frame must already be true-geometry).
            if (!W) { W = window.innerWidth; H = window.innerHeight; }
            var bw = Math.max(1, Math.floor(W * dpr));
            var bh = Math.max(1, Math.floor(H * dpr));
            canvas.width = bw; canvas.height = bh;
            if (canvas2) { canvas2.width = bw; canvas2.height = bh; }
            var off1 = canvas.transferControlToOffscreen();
            var offs = [off1];
            var off2 = null;
            if (canvas2) { off2 = canvas2.transferControlToOffscreen(); offs.push(off2); }
            w.postMessage({ t: 'init', off1: off1, off2: off2,
                            W: W, H: H, dpr: dpr }, offs);
            done(true);
          } catch (e) { done(false); }
        } else if (m.t === 'debug') {
          publishLatticeStats(m.blob);
          try {
            if (window.DoomalayPerf && m.blob && m.blob.atomFrames !== undefined) {
              window.DoomalayPerf.painter = 'worker';
              window.DoomalayPerf.atomFrames = m.blob.atomFrames;
            }
          } catch (e) {}
        } else if (m.t === 'tex-ready') {
          update();
        } else if (m.t === 'repaint-wanted') {
          // v0.97.1: the worker's tile lattice rebaked (or is about to) —
          // one follow-up frame lands the fresh tiles on the bitmap
          schedulePostBakeFrame();
        } else if (m.t === 'paint-error') {
          console.warn('doomalay: grid worker paint error:', m.message);
        }
      };
      try { w.postMessage({ t: 'hello' }); } catch (e) { done(false); }
    });
  }

  // ── World + icons ──────────────────────────────────────────────
  const world = new Physics.World();
  const iconLayer = document.getElementById('chatbots');
  // v0.88.2: THE CONTACT TAP — every physics frame's touches report here
  // once; v0.90.3: ANY icon pair feeds the orbit groups ("if any two icons
  // they start the orbit and create a communication layer, not just tabs"
  // — chats orbit too, their workspace stars nested atop). A topology
  // change repaints the grid furniture (the star + its sphere are painted
  // state on #c2).
  world.onContacts = function (contacts) {
    if (!window.TabGroups) return;
    var changed = false;
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.a && c.b && window.TabGroups.collide(c.a, c.b, c.x, c.y)) changed = true;
    }
    if (changed) { update(); startAnimation(); }
  };
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
    // v0.85.4: the same entity-count change feeds the WORLD LAYER's gate
    // (auto activates at ≥ 60 — the DOM icon ceiling zone).
    if (window.World3D) window.World3D.evaluate();
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
    if (window.World3D) window.World3D.sync();   // v0.85.4: the world layer mirrors the new entity
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
      // v0.85.3: only chat icons carry a family (web tabs + future types
      // keep their own icon systems — setFamily is the chat picker's).
      if (bot.type !== 'chat' || typeof bot.setFamily !== 'function') continue;
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
    world: world,
    // v0.85.3: the web-tab entity paths (webtab.js's WebTabs controller
    // calls back into these — the app owns world/iconLayer/save).
    addEntity: function (icon) {
      if (!icon) return;
      world.add(icon);
      iconLayer.appendChild(icon.el);
      icon.render(offsetX, offsetY, scale);
      hideCanvasEmpty();
      scheduleSave();
      if (window.World3D) window.World3D.sync();   // v0.85.4: the mirror follows
    },
    createWebTabAtCenterAndOpen: function (opts) {
      opts = opts || {};
      const center = screenToWorld(W / 2, H / 2);
      const icon = WebTabs.createAt(center.x, center.y, opts);
      if (!icon) return null;
      icon.vx = (Math.random() - 0.5) * 6;
      icon.vy = (Math.random() - 0.5) * 6;
      startAnimation();
      // the exact tap-to-open sequence the canvas icon itself uses
      icon.flash();
      setTimeout(function () { openWebPanelFor(icon); }, 150);
      return icon;
    },
    // v0.41: global-search jump — open a chat by engine session id
    // (materializing an icon if the grid has none) + optional jump to a
    // specific engine event (scrollIntoView + find-hit pulse).
    openChatBySession,
    // v0.88.1: the web-tab panel opener, exposed for the E2E rigs + future
    // surfaces (canvas taps route through it internally — the ONE-PANEL
    // split + the keep-alive attach live there)
    openWebPanelFor: function (icon, opts) { openWebPanelFor(icon, opts); },
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
    // v0.90.1: the camera readback for the E2E rigs (the collision rigs
    // map world targets to screen mouse events).
    getView: function () { return { ox: offsetX, oy: offsetY, scale: scale }; },
    // v0.90.1: the camera writer (its twin) — the visual rigs center the
    // group for the screenshot probes.
    setView: function (ox, oy, s) {
      if (typeof ox === 'number') offsetX = ox;
      if (typeof oy === 'number') offsetY = oy;
      if (typeof s === 'number') scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
      update();
    },
    // v0.90.1: THE SIM STEPPER for the E2E rigs — advances physics + the
    // orbit steering TOGETHER at the tick's own 60Hz pairing with a
    // synthetic clock (headless pages suspend rAF in bursts; the rigs
    // drive the dynamics deterministically). Real usage never calls this.
    stepSim: function (frames) {
      var n = Math.max(1, frames | 0);
      var t0 = performance.now();
      for (var i = 1; i <= n; i++) {
        world.step();
        if (window.TabGroups && window.TabGroups.active()) window.TabGroups.step(t0 + i * 16.67);
      }
    },
    // v0.85.4: repaint — the world layer calls this when it (de)activates
    // (the handover needs exactly one fresh frame: activation clears the
    // stale #c2 stars, deactivation restores them).
    repaint: function () { update(); },
    // v0.87.4: openWebTweaksFor — the NATIVE handoff's landing (the
    // sheet's circle dismisses the native sheet + spaEval's
    // WebTweaks.openFor(tabId)): the master panel opens on the tab's
    // browser view with the tweaks stacked over it. On BIB builds the
    // native panel just stepped away; here the master panel takes the
    // stage (ONE panel at a time, still).
    // v0.87.5: the SPA's browser twin is NO LONGER rendered under the
    // tweaks view (it was a wasted verdict fetch + iframe load — and
    // the ‹-back TRAP: popping the view surfaced the SPA's card for
    // frame-refusers, the "two pills + a description" screen, instead
    // of the user's actual browser). The panel now opens with a bare
    // placeholder; the tweaks view owns the stage; ‹ back (the view's
    // onClose) re-opens the NATIVE SHEET — its WebView was only
    // paused, so the user's real browsing state (scroll, forms,
    // history) returns untouched.
    openWebTweaksFor: function (tabId) {
      var tabs = (window.WebTabs && window.WebTabs.all()) || [];
      var icon = null;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].id === tabId) { icon = tabs[i]; break; }
      }
      if (!icon) return false;
      var modelBtn = document.getElementById('panel-model-btn');
      if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
      panel.bodyEl.style.padding = '';
      panel.open({
        title: icon.getPanelTitle(),
        subtitle: icon.getPanelSubtitle(),
        avatarHTML: icon.getAvatarHTML(),
        bodyHTML: '<div class="wt-loading"><span>·</span><span>·</span><span>·</span></div>',
        context: icon
      });
      // the circle mirrors the tab (the panel's own header twin)
      paintTabCircle(icon);
      if (window.WebTweaks && typeof window.WebTweaks.open === 'function') {
        window.WebTweaks.open(panel, icon, { fromSheet: true });
      }
      return true;
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
    // v0.92.3 THE TRIM BRIDGE: Android's onTrimMemory (running-critical
    // + the UI-hidden signal, bridged from MainActivity through
    // window.__doomalayTrim) parks the ambient drivers — the lattice
    // worker's frame posts, the atoms, the orbits all rest until the
    // next real user interaction or a return to visibility. The user's
    // settings are NEVER touched (their animate toggles stay as chosen;
    // this is a pressure response, not a preference write).
    if (ambientPausedByTrim) return false;
    var st = window.Settings.getState();
    if (st && (st.dotAnimate || st.lineAnimate)) return true;
    // v0.85.4: while the WORLD LAYER owns the atom stars (Pixi's own
    // ticker drives them), the main rAF loop does NOT keep itself alive
    // on the atoms' account — the stars are off this thread's books.
    if (window.World3D && window.World3D.atomsOwned()) return false;
    // v0.88.2: the collision-dot ORBITS keep the loop alive too (the
    // grouped tabs swirl forever — VERY slowly, but alive)
    if (window.TabGroups && window.TabGroups.active()) return true;
    return !!(window.Atoms && window.Atoms.active(world.entities));
  }
  // ── v0.92.3: the trim state + the resume contract ───────────────
  // Native call: window.__doomalayTrim(level) — levels per Android's
  // ComponentCallbacks2 (15 = RUNNING_CRITICAL, 20 = UI_HIDDEN).
  // Resume: the first pointerdown or a visibilitychange→visible.
  var ambientPausedByTrim = false;
  window.__doomalayTrim = function (level) {
    ambientPausedByTrim = true;
    try {
      if (window.DoomalayPerf) window.DoomalayPerf.trimLevel = level;  // the honest instrument
    } catch (e) {}
  };
  function resumeFromTrim() {
    if (!ambientPausedByTrim) return;
    ambientPausedByTrim = false;
    if (ambientActive()) startAnimation();
  }
  document.addEventListener('pointerdown', resumeFromTrim, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') resumeFromTrim();
  });
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
  // v0.90.1: paintOrbitStars — the collision groups' stars on #c2, the
  // per-frame layer (they MOVE — the weighty centroid chase). Painted in
  // BOTH frame paths (the cheap atom-only frame and the full frame),
  // independent of atom ownership (World3D may own the atom stars; the
  // orbit stars are the group system's).
  function paintOrbitStars() {
    if (!window.Atoms || !window.Atoms.paintDots || !ctx2) return;
    var dots = (window.TabGroups && window.TabGroups.active()) ? window.TabGroups.dotsFor() : [];
    if (!dots.length) return;
    var n = window.Atoms.paintDots(ctx2, W, H, offsetX, offsetY, scale, dots);
    try {
      if (!window.DoomalayDebug) window.DoomalayDebug = {};
      window.DoomalayDebug.orbitStars = n;
    } catch (e) {}
  }
  function update() {
    world.step();
    // v0.85.2: renderGrid funnels through paintGridFrame — the lattice
    // + arrows + atoms ride ONE call (the worker message or the inline
    // main-thread paint)
    renderGrid();
    for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
    // v0.88: the world layer's on-demand driver — a full-frame funnel
    // (a pan, a drag, a repaint) means the camera or the icons moved; one
    // poke re-lights its rAF driver (it self-stops when the world rests).
    if (window.World3D && window.World3D.poke) window.World3D.poke();
    // v0.94.1: THE POKE RETIREMENT — DoomProjection.poke() (a FULL
    // projection paint every canvas frame) is GONE. It was a v0.67 relic:
    // "the icons ride transforms — the projection painter re-anchors
    // their gradient windows to the viewport each frame" — but v0.92.1
    // evicted .chatbot from the root registry, so a canvas pan moves NO
    // tracked root and every one of those paints walked ~100 selectors +
    // a gBCR per painted window to write NOTHING. Canvas motion is inert
    // to the projection (real DOM changes still ride the MutationObserver;
    // panel motion rides motion(); scrolls ride scrollRebake).
    // v0.75: an animate toggle ON means the canvas never rests.
    // v0.84.1: so do the atom orbits.
    if (ambientActive()) startAnimation();
  }

  // v0.94.1: THE INPUT COALESCER — touchmove/wheel events arrive at
  // digitizer rate (up to 120Hz on this class of device) but the display
  // paints at 60: every synchronous update() past the first per frame was
  // pure wasted work (physics + a full lattice frame + icon transforms
  // + the worker post, per EVENT). The state math (offset/velocity, the
  // per-event dt EMA) stays per-event — only the RENDER is coalesced to
  // one rAF, latest-wins. (Chrome's aligned-input guidance — the same
  // discipline the browser applies to pointermove.)
  var updateQueued = false;
  function scheduleUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(function () {
      updateQueued = false;
      update();
    });
  }

  // v0.94.4 F3: the physics step rides REAL elapsed time (frames of
  // 16.667ms) — at 60Hz dt=1 (byte-identical to the old fixed step);
  // on a throttled/busy phone the world decelerates at the same rate
  // instead of getting literally heavier (the audit's F3).
  var lastStepAt = 0;
  var lastAmbientFull = 0;   // v0.97: the ambient cadence gate's clock
  function tick() {
    let moving = false;
    var now = performance.now();
    var dtF = lastStepAt ? Math.min(3, (now - lastStepAt) / 16.667) : 1;
    lastStepAt = now;
    if (inputState === 'PANNING') {
      // v0.94.1: THE FINGER OWNS THE CAMERA — while an active finger pan
      // is in flight, tick does NOT integrate velX/velY (the input path
      // applies the finger deltas; the old double-integration drifted the
      // content ahead of the finger) and does NOT re-render (the coalesced
      // scheduleUpdate() owns the frame). Momentum takes over at release.
    } else if (Math.abs(velX) >= 0.15 || Math.abs(velY) >= 0.15) {
      offsetX += velX; offsetY += velY;
      velX *= PAN_FRICTION; velY *= PAN_FRICTION;
      moving = true;
    } else if (velX !== 0 || velY !== 0) {
      velX = 0; velY = 0;
    }
    world.step(dtF);
    // v0.88.2: THE ORBIT PASS — the collision dots' members swirl (their
    // x/y is the orbit's; the ICONS' DOM transforms re-render — the
    // canvas furniture stays pixel-stable, no repaint needed for the
    // drift)
    var orbitMoved = false;
    if (window.TabGroups && window.TabGroups.active()) orbitMoved = window.TabGroups.step(performance.now());
    for (const e of world.entities) {
      // v0.90.1: grouped members' orbital drift is AMBIENT (the atoms-only
      // cheap frame + the members' own render below cover it) — it must not
      // classify the canvas as "moving" (that meant a full lattice frame
      // + a save EVERY frame, forever, while a group exists).
      if (e._orbit) continue;
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
    if (!covered && inputState !== 'PANNING') {   // v0.94.1: during an active pan the coalesced update() owns the render
      var atomsOnly = !moving && !ambientGridActive() &&
                      ((window.Atoms && window.Atoms.active(world.entities) &&
                        !(window.World3D && window.World3D.atomsOwned())) ||   // v0.85.4: the world layer owns the stars
                       (window.TabGroups && window.TabGroups.active()));   // v0.88.2: the ORBITS' resting frame is CHEAP — the members are DOM (their transforms update below), the dots + rings are stable painted furniture (full frames only on camera moves + topology changes)
      if (atomsOnly) {
        // v0.84.1: THE ATOM-ONLY FRAME — nothing else is moving (no pan
        // momentum, no physics drift, no grid animate), so the grid and
        // the icons are pixel-stable: repaint ONLY the star layer (clear
        // #c2 + the atom pass). A resting canvas with orbiting atoms stays
        // near-free instead of re-running the full lattice paint per frame.
        // v0.85.2: the cheap frame rides the same paintGridFrame funnel —
        // worker mode posts {atomsOnly:true}, main mode clears + paints.
        paintGridFrame(true);
      } else {
        // v0.97 THE AMBIENT CADENCE GATE — when ONLY the ambient lattice
        // animation moves (no pan, no physics, no camera), the full
        // lattice frame runs at ≥66ms cadence (~15fps) instead of every
        // rAF: the one-object lattice is a few pattern fills, but the
        // over-icons fills + hero fireflies + the worker round-trip still
        // cost — and a 15fps twinkle READS as calm (the TEMPO slow-down
        // makes the stepping invisible). Stars/atoms keep their own 60fps
        // cheap frame between lattice frames. Pans/momentum pin full
        // cadence exactly as before (v0779's pan proof rides it).
        var atomsLive = (window.Atoms && window.Atoms.active(world.entities) &&
                         !(window.World3D && window.World3D.atomsOwned())) ||
                        (window.TabGroups && window.TabGroups.active());
        var latticeDue = moving || !ambientGridActive() ||
                         (now - lastAmbientFull >= 66);
        if (latticeDue) {
          renderGrid();
          lastAmbientFull = now;
          for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
        } else if (atomsLive) {
          paintGridFrame(true);
        }
        // else: nothing is due this frame — the canvas keeps its last
        // raster (the compositor owns it); grouped members still render
        // below when their orbit moved.
      }
    }
    // v0.88.2: the orbiting members re-render even on a resting canvas
    // (the atoms-only path skips icon.render — the members DID move)
    if (orbitMoved) {
      var mems = window.TabGroups.members();
      for (var mi = 0; mi < mems.length; mi++) mems[mi].render(offsetX, offsetY, scale);
    }
    if (moving) { scheduleSave(); requestAnimationFrame(tick); }
    else if (ambientActive()) { requestAnimationFrame(tick); } // v0.75: animate — offsets unchanged, no save; v0.84.1: atoms too
    else { animating = false; scheduleSave(); }
    // v0.88: pan MOMENTUM + ambient frames keep the camera/entity state
    // flowing through tick (not update) — one poke keeps the world layer's
    // on-demand driver following; a clean frame renders nothing (the
    // driver self-stops the moment nothing moves).
    if (window.World3D && window.World3D.poke) window.World3D.poke();
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

  // ── v0.87.1: THE CIRCULAR TAB ICON ───────────────────────────
  // User spec: "let's add a circular icon right of the middle dash in
  // the panel and left of the back arrow pill. That circle icon should
  // update with and be the same as the icon of the tab itself on the
  // canvas." The web master panel's twin lives in the handle strip's
  // free right cell (right of the dash — the exact spot the native
  // sheet's circle takes between the dash and the ‹ back pill). It
  // mirrors the tab's icon LIVE (the doomalay:tab-icon event every
  // icon mutation fires) and pressing it opens the browser tweaks
  // (v0.87.4 webtweaks.js — the chatbot tweaks panel's twin: icon,
  // text sizes, colors). Non-web panels never show it.
  const tabIconBtn = document.getElementById('panel-tab-icon');
  function paintTabCircle(icon) {
    if (!tabIconBtn) return;
    // NOTE: no isOpen() gate here — panel.open() lands the .open class
    // on the NEXT animation frame, so a synchronous paint right after
    // open() would read isOpen()===false and hide itself (the red-team
    // caught this: the circle never showed on the freshly opened panel).
    // The panel-closed listener paints null — that is the hide path.
    if (!icon || icon.type !== 'web') {
      tabIconBtn.style.display = 'none';
      tabIconBtn.innerHTML = '';
      return;
    }
    tabIconBtn.style.display = '';
    var src = (typeof icon.iconSrc === 'function') ? icon.iconSrc() : null;
    if (src) {
      tabIconBtn.innerHTML = '<img src="' + src + '" alt="' +
        (icon.title || icon.host() || 'tab') + '">';
    } else {
      // gradient mode — the placeholder disc twin (theme accent pair
      // or the entity's own spec; the globe glyph says "browser tab")
      var g = (typeof icon.themeGradientCSS === 'function')
        ? icon.themeGradientCSS(icon.gradient) : '';
      tabIconBtn.innerHTML = '<span class="wt-circle-grad"' +
        (g ? ' style="background-image:' + g + '"' : '') + '>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 12h19" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span>';
    }
  }
  if (tabIconBtn) {
    tabIconBtn.addEventListener('click', function () {
      var icon = panel.currentContext;
      if (!icon || icon.type !== 'web') return;
      // v0.87.4: the tweaks view (the chatbot tweaks panel's twin)
      if (window.WebTweaks && typeof window.WebTweaks.open === 'function') {
        window.WebTweaks.open(panel, icon);
      }
    });
    // LIVE: every icon mutation (navigation favicon refresh, mode
    // switch, upload) repaints the circle while its tab's panel shows
    document.addEventListener('doomalay:tab-icon', function (e) {
      var d = (e && e.detail) || {};
      if (panel.currentContext && d.id === panel.currentContext.id) {
        paintTabCircle(panel.currentContext);
      }
    });
    // the circle leaves with the panel (a closed panel shows nothing —
    // v0.38 broadcasts the close for exactly this kind of listener)
    document.addEventListener('doomalay:panel-closed', function () {
      paintTabCircle(null);
    });
  }

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
    } else if (btn.dataset.action === 'new-tab') {
      // v0.85.3: NEW TAB (user spec: "new tab creates a browser in
      // browser panel, that saves the current website address it holds
      // and scroll position within that website, ext..") — creates the
      // web entity at the press point (create-only, the New Bot
      // convention) + opens its panel so the address is one tap away.
      const r = menuEl.getBoundingClientRect();
      const wp = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
      const icon = window.WebTabs.createAt(wp.x, wp.y);
      if (icon) {
        icon.vx = (Math.random() - 0.5) * 6;
        icon.vy = (Math.random() - 0.5) * 6;
        startAnimation();
        setTimeout(function () { openWebPanelFor(icon); }, 150);
      }
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
      scheduleUpdate();   // v0.94.1: one render per frame, not per event
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
        // v0.90.1: the LIVE drag velocity rides the entity (world units)
        // — physics reads it for the velocity-proportional impact boost
        // ("an exponential curve out that varies depending on impact
        // velocity"). Physics never integrates a dragging entity, so
        // this is purely the impact math's input.
        draggedIcon.vx = dragVel.vx / scale;
        draggedIcon.vy = dragVel.vy / scale;
      }
      scheduleUpdate();   // v0.94.1: one render per frame, not per event
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
          // types keep the default 20px from the stylesheet. v0.85.3: the
          // browser tab view is full-bleed too (its own chrome).
          panel.bodyEl.style.padding = (icon.type === 'chat' || icon.type === 'web') ? '0' : '';
          // v0.87.1: web tabs route through openWebPanelFor — it owns the
          // ONE-PANEL split (BIB builds: the native sheet only, no master
          // panel; everywhere else: the master panel + WebPanel).
          if (icon.type === 'web') {
            openWebPanelFor(icon);
            return;
          }
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
    scheduleUpdate();   // v0.94.1: wheel bursts coalesce to one frame
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
      scheduleUpdate();   // v0.94.1: pinch moves coalesce to one frame too
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
  // v0.85.3: openWebPanelFor — the web-tab twin of openChatPanelFor:
  // opens the master panel with the tab's header (host + url + the
  // favicon/gradient avatar) and hands the body to WebPanel (the
  // browser-in-browser view — webpanel.js).
  // v0.87.1: ONE PANEL — on BIB-capable builds the master panel NEVER
  // opens for a web tab (the user spec: "We only want one panel. Remove
  // the one with the gradient selector that doesn't work and the mini
  // browser in panel view"): the native sheet is the browser panel and
  // WebTabs.openNative fires it (the entity-level sheet sync in
  // webtab.js keeps the tab's state current without any panel). Every
  // other surface keeps the master-panel render below.
  function openWebPanelFor(icon, opts) {
    // v0.87.4: skipNative — the tweaks handoff lands HERE even on BIB
    // builds (the native sheet just stepped away; the master panel
    // takes the stage for the tweaks view, one panel at a time).
    if (!(opts && opts.skipNative) &&
        window.WebTabs && typeof window.WebTabs.openNative === 'function' &&
        window.__doomalayKotlin && typeof window.__doomalayKotlin.openPanel === 'function') {
      window.WebTabs.openNative(icon);
      return;
    }
    var modelBtn = document.getElementById('panel-model-btn');
    if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
    panel.bodyEl.style.padding = '0';   // the browser view is full-bleed
    panel.open({
      title: icon.getPanelTitle(),
      subtitle: icon.getPanelSubtitle(),
      avatarHTML: icon.getAvatarHTML(),
      bodyHTML: icon.getPanelBodyHTML(),
      context: icon
    });
    if (window.WebPanel) {
      window.WebPanel.render(panel.bodyEl, icon, panel);
    }
    // v0.87.1: the circular tab icon paints the moment its panel opens
    paintTabCircle(icon);
  }

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
      // v0.97 C3: the transcript's head backfills in idle chunks — a jump
      // targeting history that is not mounted yet flushes it now (one
      // synchronous slice, then the row exists to scroll to).
      try { if (window.ChatPanel && window.ChatPanel.ensureMounted) window.ChatPanel.ensureMounted(); } catch (e) {}
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
    // v0.88 ROOT FIX: the spec digests ride Lattice.cheapJSON — s.bg can
    // carry the texture dataURL, and this gate ran on EVERY settings
    // event (the measured ~133ms cascade behind the unusable colors pill:
    // five full stringifies, one dataURL-heavy, per drag event).
    const cj = (window.Lattice && window.Lattice.cheapJSON) || JSON.stringify;
    return [
      s.theme, s.gridSize, s.spaceParallax, s.hideGridLines, s.hideDots,
      s.dotScatter, s.lineScatter, s.dotSizeVariation, s.lineSizeVariation,
      s.dotSizeBias, s.lineSizeBias, s.dotRotation, s.lineRotation,
      s.dotAnimate, s.lineAnimate,
      s.gridScatter, s.gridSizeVariation, s.gridRotation,   // legacy fallbacks
      cj(s.bg), cj(s.lineColor),
      cj(s.dotColor), cj(s.originColor),
      // the CANVAS-relevant override only: --bg-panel paints the canvas
      // background (spec + texture); --border-strong tints the canvas
      // icons. The REST of the overrides (accents, surfaces, text) have
      // zero canvas effect — an accent drag must NOT repaint the canvas.
      cj((ov && ov['--bg-panel']) || null),
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
      dots: (window.TabGroups) ? window.TabGroups.serialize() : [],
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
    // v0.85.2: the painter handshake GATES the boot — the worker's
    // canvas transfer (or its failure → main mode) must settle before
    // the first paint posts. Main mode resolves immediately.
    await bootPainter();
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

    // v0.88.2: THE COLLISION DOTS restore — the grouped web tabs re-bind
    // (each member re-baselines its (r, φ) from its saved position —
    // "the user can move an icon somewhere and have it orbit but stay in
    // that location")
    if (window.TabGroups && saved && Array.isArray(saved.dots)) {
      try { window.TabGroups.deserialize(saved.dots); } catch (e) { console.warn('dots restore failed', e); }
    }

    updateIconBudget();   // v0.85.1: the restored world sets the icon budget
    // v0.85.4: the world layer evaluates its gate on the restored count
    if (window.World3D) { window.World3D.evaluate(); window.World3D.sync(); }
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
