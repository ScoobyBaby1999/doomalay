// gridworker.js — v0.85.2 THE PAINT WORKER (renderer-path Phase 2:
// "OffscreenCanvas the grid painter into a worker" — PLAN-V085 §B).
//
// THE MODEL: #c (the lattice) and #c2 (the over-icons layer + the atom
// stars) arrive via transferControlToOffscreen — their BITMAPS belong to
// this thread; the main thread keeps the DOM elements (style, position,
// input) and only composites the transferred frames. The main thread
// remains the frame AUTHORITY (it knows when physics moves, when the
// camera pans, when the panel covers the canvas, when ambient animation
// must keep the loop alive) — it posts one message per frame it wants;
// this worker paints it:
//
//   {t:'frame', cam:{ox,oy,scale}, atomsOnly, arrows[], entities[],
//    counts{}, colors{}, atomsOn, P?}
//     · P (the resolved params blob: specs, theme hexes, effect knobs)
//       rides ONLY when its fingerprint changed — texture dataURLs can be
//       100s of KB; the worker caches the last P verbatim.
//     · atomsOnly → THE CHEAP FRAME (v0.84.1's discipline, worker-side):
//       clear #c2 + the atom pass ONLY — a resting grid with orbiting
//       atoms stays near-free, exactly as on the main thread.
//     · arrows[] carry pre-resolved family hexes (no getComputedStyle
//       in the worker); entities[] are the plain {id,type,sessionId,x,y,
//       radius} clones the atom core reads.
//
// Every frame answers {t:'debug', …} — the full lattice twin of
// window.DoomalayDebug (dots/segments/weight/overIcons/cache/batches +
// the atom stats), which the main thread writes into window.DoomalayDebug
// the moment it arrives (rigs sleep past the ~1-frame latency). Bumpmaps
// finishing decode answer {t:'tex-ready'} (the main thread sends one more
// frame). Per-frame failures are CAUGHT — a paint error reports and the
// worker lives on (the canvases are un-transferable; killing the worker
// would freeze the app's bitmaps forever).
importScripts('lattice.js', 'atoms.js');

var gctx = null, gctx2 = null;
var gcan = null, gcan2 = null;   // v0.89.9: the transferred OffscreenCanvas
                               // objects THEMSELVES — after the transfer the
                               // bitmaps belong to THIS thread; only here can
                               // they be sized (the stretch fix)
var W = 0, H = 0, dpr = 1;
var P = null;          // the cached params blob
var Pf = '';           // its fingerprint (main-side computed, passed along)
var E = [];            // v0.88: the cached entity clones — they ride the frame
                      // message ONLY when the main-side checksum changed;
                      // a resting canvas posts zero clones
var entsMsgs = 0;      // v0.88: how many messages actually carried clones
var frames = 0, atomFrames = 0, fullFrames = 0;
var t0 = performance.now() / 1000;

self.onmessage = function (ev) {
  var m = ev.data || {};
  try {
    switch (m.t) {
      case 'hello':
        self.postMessage({ t: 'ready' });
        break;
      case 'init':
        gcan = m.off1 || null; gcan2 = m.off2 || null;
        gctx = gcan ? gcan.getContext('2d') : null;
        gctx2 = gcan2 ? gcan2.getContext('2d') : null;
        W = m.W || 0; H = m.H || 0; dpr = m.dpr || 1;
        sizeBitmaps();
        if (m.P) { P = m.P; Pf = m.pf || ''; }
        self.postMessage({ t: 'booted', W: W, H: H });
        break;
      case 'resize':
        W = m.W || 0; H = m.H || 0; dpr = m.dpr || dpr;
        sizeBitmaps();
        break;
      case 'frame':
        paintFrame(m);
        break;
    }
  } catch (e) {
    // a paint error must never kill the owner of the transferred bitmaps
    try { self.postMessage({ t: 'paint-error', message: String(e && e.message || e) }); } catch (e2) {}
  }
};

// v0.89.9 THE STRETCH FIX. For four versions this worker only applied
// the DPR TRANSFORM and never set the BITMAP DIMENSIONS — after
// transferControlToOffscreen the bitmaps live HERE, so both #c and #c2
// stayed at the canvas elements' 300×150 boot default while the main
// thread CSS-stretched them to the window (a tall phone: ~×4 horizontal,
// ~×18 vertical — the user's "stretched ridiculously, very nauseating,
// the movement is very weird"). Size the bitmaps at init AND on every
// resize, then re-apply the transform (setting width/height resets all
// context state, transform included).
function sizeBitmaps() {
  var bw = Math.max(1, Math.floor(W * dpr));
  var bh = Math.max(1, Math.floor(H * dpr));
  if (gcan && (gcan.width !== bw || gcan.height !== bh)) {
    gcan.width = bw; gcan.height = bh;
  }
  if (gcan2 && (gcan2.width !== bw || gcan2.height !== bh)) {
    gcan2.width = bw; gcan2.height = bh;
  }
  applyDpr();
}

function applyDpr() {
  if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (gctx2) gctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  // v0.97: the one-object lattice bakes its tiles at the host's DPR —
  // sharp, and geometry-independent (the pattern fill compensates).
  try { if (globalThis.Lattice && globalThis.Lattice.setDpr) globalThis.Lattice.setDpr(dpr); } catch (e) {}
}

function paintFrame(m) {
  if (!gctx) return;
  if (m.P !== undefined) { P = m.P; Pf = m.pf || ''; }
  // v0.88: the entity-clone omission — clone set arrives only on change
  if (m.entities !== undefined && m.entities !== null) { E = m.entities; entsMsgs++; }
  var stats = null, atomStats = null;
  var paintedDots = 0;
  if (m.atomsOnly) {
    // v0.84.1 THE ATOM-ONLY FRAME (worker-side twin): nothing else moved —
    // the grid and the icons are pixel-stable; repaint ONLY the star layer.
    if (gctx2) gctx2.clearRect(0, 0, W, H);
    if (m.atomsOn !== false && gctx2) {
      atomStats = AtomCore.paintCore(gctx2, W, H, m.cam.ox, m.cam.oy, m.cam.scale,
        E, m.counts || {}, m.colors || null,
        performance.now() / 1000 - t0);
      atomFrames++;
    }
    // v0.90.1: THE ORBIT STARS paint on #c2 EVERY cheap frame — the star
    // MOVES (the weighty centroid chase), independent of atom ownership
    // (the World3D layer may own the atom stars; the orbit stars are ours).
    // v0.90.2: par rides the message (the nebula sphere's lit limb).
    if (m.dots && m.dots.length && gctx2) {
      paintedDots = AtomCore.paintDots(gctx2, W, H, m.cam.ox, m.cam.oy, m.cam.scale,
        m.dots, m.colors || null, performance.now() / 1000, m.par || 0);
    }
    // v1.06.3: the cheap frame is LOSSLESS — the over furniture (the
    // tiles + heroes that ride #c2 above the icons) repainted, and the
    // live layer (comets + twinklers) stepped + painted at 60fps. The
    // old cheap frame wiped #c2 and never restored it: the icons' front
    // layer vanished at rest (animDots off) or flickered at full-frame
    // cadence (animDots on).
    if (P && gctx2) {
      try { Lattice.renderOver(gctx2, W, H, m.cam, P); } catch (e) {}
      try { Lattice.paintLive(gctx2, W, H, m.cam, P); } catch (e) {}
    }
  } else {
    // v0.88.2: m.cam.dots rides the per-frame payload (the collision
    // dots are world state, like entities — never fingerprint-cached)
    var camWithDots = m.cam;
    if (m.dots && m.dots.length) {
      camWithDots = { ox: m.cam.ox, oy: m.cam.oy, scale: m.cam.scale, dots: m.dots };
    }
    stats = Lattice.render(gctx, gctx2, W, H, camWithDots, P);
    // the off-screen arrows (positions + hexes resolved main-side)
    if (m.arrows && m.arrows.length && gctx) {
      for (var i = 0; i < m.arrows.length; i++) {
        var ar = m.arrows[i];
        gctx.save();
        gctx.translate(ar.x, ar.y);
        gctx.rotate(ar.angle);
        gctx.fillStyle = ar.color;
        gctx.beginPath();
        gctx.moveTo(14, 0);
        gctx.lineTo(-8, -9);
        gctx.lineTo(-4, 0);
        gctx.lineTo(-8, 9);
        gctx.closePath();
        gctx.fill();
        gctx.restore();
      }
    }
    if (m.atomsOn !== false && gctx2) {
      atomStats = AtomCore.paintCore(gctx2, W, H, m.cam.ox, m.cam.oy, m.cam.scale,
        E, m.counts || {}, m.colors || null,
        performance.now() / 1000 - t0);
    }
    // v0.90.1: the orbit stars ride the full frame's #c2 pass too
    if (m.dots && m.dots.length && gctx2) {
      paintedDots = AtomCore.paintDots(gctx2, W, H, m.cam.ox, m.cam.oy, m.cam.scale,
        m.dots, m.colors || null, performance.now() / 1000, m.par || 0);
    }
    // v1.06.3: the movers ride the full frame's #c2 pass too (renderTiled
    // painted the over furniture; paintLive re-steps + re-paints the movers
    // after that #c2 clear)
    if (P && gctx2) {
      try { Lattice.paintLive(gctx2, W, H, m.cam, P); } catch (e) {}
    }
    fullFrames++;
    // v0.97.1: this frame painted with a STALE tile bake (the rebake
    // debounce is pending) — ask main for ONE follow-up frame to land
    // the fresh bake (the tex-ready pattern, minus the texture)
    if (Lattice.rebakePending && Lattice.rebakePending()) {
      try { self.postMessage({ t: 'repaint-wanted' }); } catch (e) {}
    }
  }
  frames++;
  // the honest instrument: the full lattice twin + the atom twin
  var out = stats || (Lattice.lastStats ? Lattice.lastStats() : null);
  var blob = {};
  if (out) {
    for (var k in out) blob[k] = out[k];
  }
  blob.frames = frames;
  blob.atomFrames = atomFrames;
  blob.fullFrames = fullFrames;
  // v0.89.9: the honest instrument — the worker's OWN bitmap dims, so
  // rigs can prove the stretch is dead (bw/bh === viewport × dpr)
  blob.bw = gcan ? gcan.width : 0;
  blob.bh = gcan ? gcan.height : 0;
  blob.vw = W; blob.vh = H; blob.dpr = dpr;
  blob.ents = E.length;        // v0.88: the honest instrument — the cached clone count
  blob.entsMsgs = entsMsgs;    // v0.88: how many frames actually carried clones
  blob.worker = true;
  blob.orbitStars = paintedDots;   // v0.90.1: the honest star-paint counter (worker mode)
  // v0.97.1: the worker's one-object state rides the blob (the rigs + the
  // perf HUD read it main-side; the worker's TL is otherwise unreachable)
  if (Lattice.oneObject) { try { blob.oneObject = Lattice.oneObject(); } catch (e) {} }
  if (atomStats) blob.atoms = atomStats;
  else if (m.atomsOnly) blob.atoms = atomStats || blob.atoms || { chats: 0, stars: 0, shells: 0 };
  self.postMessage({ t: 'debug', blob: blob, pf: Pf });
}

// a bumpmap finished decoding (fetch → createImageBitmap) — the main
// thread answers with one more frame request
if (Lattice) {
  Lattice.onTexReady(function () {
    try { self.postMessage({ t: 'tex-ready' }); } catch (e) {}
  });
  // v1.06.1: an async LADDER bake landed (the zoom level's tile set is
  // cached + swapped) — ask main for the one follow-up frame that paints
  // it (a resting canvas would otherwise keep the stretched set on screen)
  if (Lattice.onBakeReady) {
    Lattice.onBakeReady(function () {
      try { self.postMessage({ t: 'repaint-wanted' }); } catch (e) {}
    });
  }
}
