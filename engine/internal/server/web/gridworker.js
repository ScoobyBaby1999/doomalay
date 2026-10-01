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
        gctx = m.off1 ? m.off1.getContext('2d') : null;
        gctx2 = m.off2 ? m.off2.getContext('2d') : null;
        W = m.W || 0; H = m.H || 0; dpr = m.dpr || 1;
        applyDpr();
        if (m.P) { P = m.P; Pf = m.pf || ''; }
        self.postMessage({ t: 'booted', W: W, H: H });
        break;
      case 'resize':
        W = m.W || 0; H = m.H || 0; dpr = m.dpr || dpr;
        applyDpr();
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

function applyDpr() {
  if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (gctx2) gctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function paintFrame(m) {
  if (!gctx) return;
  if (m.P !== undefined) { P = m.P; Pf = m.pf || ''; }
  // v0.88: the entity-clone omission — clone set arrives only on change
  if (m.entities !== undefined && m.entities !== null) { E = m.entities; entsMsgs++; }
  var stats = null, atomStats = null;
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
    fullFrames++;
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
  blob.ents = E.length;        // v0.88: the honest instrument — the cached clone count
  blob.entsMsgs = entsMsgs;    // v0.88: how many frames actually carried clones
  blob.worker = true;
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
}
