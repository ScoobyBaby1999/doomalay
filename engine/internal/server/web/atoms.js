// atoms.js — v0.84.1 THE ATOM ORBITS (user spec, verbatim intent:
//   "Let's make each connected workspace spawn a small orbiting star around
//    the chat that orbits like an atom not a 2d plane basic circle. It goes
//    back and forth behind and above the icon. A chat with 10 workspaces has
//    10 stars. Like an atom, we cap each level of orbit to a set number of
//    stars then jump to another slightly further level of orbit orbiting
//    another axis. Cap the workspaces per chat at like 50 I guess.... Or 24?
//    Idk... Ur call.").
//
// THE MODEL — electron shells, not a flat ring:
//   · shell capacities [4, 6, 8, 8, 8] (a set cap per orbit level; overflow
//     jumps to the next, slightly further shell) — 34 slots total;
//   · the CHAT BINDING CAP is 32 (my call per "ur call": four full shells +
//     a partial fifth reads as a proper big atom, few enough to stay cheap —
//     worst case 32 star arcs + 5 shell ellipses per icon per frame);
//   · every shell rides its OWN AXIS: a fixed tilt pair (α around X, β around
//     Z) per level — level 2's ring visibly swings a different plane than
//     level 1's, exactly "another slightly further level of orbit orbiting
//     another axis";
//   · every star is STATELESS: phase / speed / direction / radius come from
//     stable string hashes of (iconId · shell · slot) — the grid's hashCell
//     discipline — so reloads and panning never pop or drift.
//
// THE PAINT — "back and forth behind and above the icon":
//   stars paint on the over-icons canvas #c2 (z 150, above #chatbots z 100):
//     · FRONT half (depth z ≥ 0): full alpha + a soft two-arc glow — the
//       star passes OVER the icon disc;
//     · BACK half (z < 0): dimmed to 55% AND clipped OUTSIDE the icon disc
//       (an evenodd clip: the viewport rect minus the disc circle) — the
//       star visibly slides BEHIND the disc, the classic atom-nucleus
//       occlusion, no third canvas needed.
//   One faint rotated-ellipse stroke per shell (64-segment polyline) makes
//   the orbits themselves read. Culling: off-viewport icons skip entirely.
//
// THE FEED — the count of BOUND workspaces per session:
//   refresh(icon) GETs /api/sessions/{sid}/workspaces; the boot path calls
//   refreshAll(); binding changes arrive as `doomalay:workspaces-changed`
//   (detail.sessionId) from workspace.js/chatpanel.js. The engine twin caps
//   the bind at 32 (409 with the exact message). Colors are THEME TOKENS
//   only (--accent / --accent-2 / --border-strong), resolved through the
//   computed style and cached (~1s TTL) so per-frame paints never touch
//   getComputedStyle.
//
// Exposes: window.Atoms = { refresh, refreshAll, setCount, countFor,
//                            active, paint, MAX_WS, SHELL_CAP, shellLayout }
// v0.85.2: the file is DUAL-ENVIRONMENT — the pure paint core (stateless
// star math + the shell painter, parameterized by counts/colors/time)
// attaches as globalThis.AtomCore so the grid WORKER can importScripts
// this exact file (zero drift: one file, two hosts). The DOM/fetch feed
// (refresh/colors via getComputedStyle) registers only on the main
// thread, where window exists.
(function () {
  'use strict';
  var ROOT = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : globalThis);

  var SHELL_CAP = [4, 6, 8, 8, 8];            // stars per orbit level
  var SHELL_R   = [46, 60, 74, 88, 102];      // shell radius, screen px @ scale 1
  var SHELL_TILT = [                          // (α° around X, β° around Z) — the axis per level
    [22, 0], [64, 45], [38, 120], [78, 210], [8, 300]
  ];
  // v0.88 THE STAR-CONSTANT CACHE: the tilt basis is a PER-LEVEL constant
  // (the old code re-ran 4 trig + the degree→rad conversions PER STAR PER
  // FRAME in starPos AND per shell per icon in paintCore — the measured
  // +atoms pixi/DOM frame cost). Precomputed once, shared by both twins.
  var TILT_BASIS = SHELL_TILT.map(function (t) {
    var a = t[0] * Math.PI / 180, b = t[1] * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return { e1x: cb, e1y: sb, e1z: 0, e2x: -sb * ca, e2y: cb * ca, e2z: sa };
  });
  // v0.88: per-star derived constants (the 4 string hashes → omega/phase/
  // radius) cached by star key — star keys are stable for a chat's whole
  // life (icon.id|level|slot), so the hashes run once per star, not per
  // frame. Bounded: icon ids churn across sessions; past 4096 entries the
  // map resets (a one-frame re-hash blip, never a leak).
  var STAR_CACHE = new Map();
  var MAX_WS = 32;                            // the chat binding cap (engine twin)

  var counts = {};        // sessionId → star count (the bound-workspace count)
  var t0 = performance.now() / 1000;

  // ── stable string hash → [0,1) ───────────────────────────────────
  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return (h % 1000000) / 1000000;
  }

  // shellLayout(n) — the electron-shell fill: how many stars sit on each
  // level for a total of n (capped at MAX_WS). Deterministic, stateless.
  function shellLayout(n) {
    n = Math.max(0, Math.min(MAX_WS, n | 0));
    var out = [];
    var left = n;
    for (var i = 0; i < SHELL_CAP.length && left > 0; i++) {
      var take = Math.min(SHELL_CAP[i], left);
      out.push(take);
      left -= take;
    }
    return out;
  }

  // ── the star's projected position on a shell ─────────────────────
  // Plane basis: Rz(β)·Rx(α) applied to the xy-plane's basis —
  //   e1 = (cosβ, sinβ, 0),  e2 = (−sinβ·cosα, cosβ·cosα, sinα)
  // A star at angle θ rides u=cosθ·e1 + v=sinθ·e2 (unit circle in the
  // tilted plane); screen = (p.x, p.y), depth = p.z (positive = viewer side).
  // v0.88: the per-star hashes + the per-level trig live in the caches
  // above — per frame this is 2 trig + a multiply, byte-identical output.
  function starPos(key, level, R, t) {
    var c = STAR_CACHE.get(key);
    if (c === undefined) {
      var h1 = hashStr(key + '~a'), h2 = hashStr(key + '~b'),
          h3 = hashStr(key + '~c'), h4 = hashStr(key + '~d');
      c = {
        omega: (0.35 + h1 * 0.45) * (h2 < 0.5 ? -1 : 1),   // rad/s ±
        phase: h3 * Math.PI * 2,
        r: 1.9 + h4 * 1.1                                  // star radius px @ scale 1
      };
      if (STAR_CACHE.size > 4096) STAR_CACHE.clear();
      STAR_CACHE.set(key, c);
    }
    var ang = t * c.omega + c.phase;
    var u = Math.cos(ang), v = Math.sin(ang);
    var B = TILT_BASIS[level] || TILT_BASIS[0];
    return {
      x: (u * B.e1x + v * B.e2x) * R,
      y: (u * B.e1y + v * B.e2y) * R,
      z: (u * B.e1z + v * B.e2z) * R,
      r: c.r
    };
  }

  // ── theme colors (cached — never per-frame getComputedStyle) ────
  var colCache = { at: 0, accent: '#a78bfa', accent2: '#38bdf8', ring: 'rgba(120,130,140,0.35)', origin: '#4a4a5e' };
  function cssVar(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) { return ''; }
  }
  function triplet(v) {
    // "r,g,b" (the theme's *-rgb twins) → 'r,g,b'; a #rrggbb → same; else ''
    v = String(v || '');
    var m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v);
    if (m) return m[1] + ',' + m[2] + ',' + m[3];
    var h = /^#([0-9a-fA-F]{6})$/.exec(v);
    if (h) return parseInt(h[1].slice(0, 2), 16) + ',' +
                 parseInt(h[1].slice(2, 4), 16) + ',' +
                 parseInt(h[1].slice(4, 6), 16);
    return '';
  }
  function colors() {
    var now = performance.now();
    if (now - colCache.at > 1000) {
      colCache.at = now;
      var acc = triplet(cssVar('--accent-rgb')) || triplet(cssVar('--accent'));
      if (acc) colCache.accent = acc;
      var acc2 = triplet(cssVar('--accent-2-rgb')) || triplet(cssVar('--accent-2'));
      if (acc2) colCache.accent2 = acc2;
      // v0.99.4: --border-strong is a DERIVED color-mix now (its computed
      // token stream is unevaluated) — the resolved hex comes from
      // DoomTheme (culori parity with what CSS paints).
      var DT = (typeof window !== 'undefined') ? window.DoomTheme : null;
      var bsHex = (DT && typeof DT.resolvedThemeVar === 'function')
        ? DT.resolvedThemeVar('--border-strong') : '';
      var bs = triplet(bsHex);
      colCache.ring = bs ? ('rgba(' + bs + ',0.35)') : 'rgba(120,130,140,0.35)';
      // v0.90.1: THE ORBIT STAR's family — the canvas center marker's
      // color (originColor: the user's setting → the theme's grid.origin
      // — the SAME resolution the lattice's origin dot rides).
      try {
        var DT = (typeof window !== 'undefined') ? window.DoomTheme : null;
        var ST = (typeof window !== 'undefined' && window.Settings) ? window.Settings.getState() : null;
        if (DT && DT.effectiveGrid && ST) {
          var oc = DT.effectiveGrid(ST).originColor;
          if (/^#[0-9a-fA-F]{6}$/.test(oc || '')) colCache.origin = oc;
        }
      } catch (e) {}
    }
    return colCache;
  }

  // ── the data feed ─────────────────────────────────────────────────
  function fireChanged(sid) {
    try {
      window.dispatchEvent(new CustomEvent('doomalay:atoms-changed', { detail: { sessionId: sid } }));
    } catch (e) {}
  }

  function refresh(icon) {
    if (!icon || !icon.sessionId || icon.type !== 'chat') return Promise.resolve();
    var sid = icon.sessionId;
    return fetch('/api/sessions/' + encodeURIComponent(sid) + '/workspaces')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var n = (d && Array.isArray(d.workspaces)) ? d.workspaces.length : 0;
        if (counts[sid] !== n) {
          counts[sid] = n;
          fireChanged(sid);
        } else {
          counts[sid] = n;
        }
        return n;
      })
      .catch(function () { return counts[sid] || 0; });
  }

  function refreshAll(entities) {
    var list = Array.isArray(entities) ? entities : [];
    list.forEach(function (icon) { refresh(icon); });
  }

  // setCount — the test hook + any local fast path (never fetches).
  function setCount(sid, n) {
    if (!sid) return;
    counts[sid] = Math.max(0, Math.min(MAX_WS, n | 0));
    fireChanged(sid);
  }

  function countFor(icon) {
    return (icon && icon.sessionId && counts[icon.sessionId]) || 0;
  }

  function active(entities) {
    var list = Array.isArray(entities) ? entities : null;
    if (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].sessionId && counts[list[i].sessionId]) return true;
      }
      return false;
    }
    for (var k in counts) if (counts[k]) return true;
    return false;
  }

  // v0.88: the shell-ellipse PATH cache — the 64-segment polyline is a
  // pure function of (level, scale); quantized at 3dp (≤0.1px drift on
  // the largest shell) it strokes from a cached Path2D translated to the
  // icon center instead of re-walking 64 cos/sin per shell per icon per
  // frame. Path2D exists in both hosts (window + worker).
  var SHELL_PATH = {};
  function shellPath(L, s) {
    var q = Math.round((s || 1) * 1000) / 1000;
    var e = SHELL_PATH[L];
    if (e && e.q === q) return e.p;
    var R = SHELL_R[L] * q;
    var B = TILT_BASIS[L] || TILT_BASIS[0];
    var p = new Path2D();
    for (var k = 0; k <= 64; k++) {
      var th = (k / 64) * Math.PI * 2;
      var uu = Math.cos(th), vv = Math.sin(th);
      var px = (uu * B.e1x + vv * B.e2x) * R;
      var py = (uu * B.e1y + vv * B.e2y) * R;
      if (k === 0) p.moveTo(px, py); else p.lineTo(px, py);
    }
    SHELL_PATH[L] = { q: q, p: p };
    return p;
  }

  // ── THE PAINT — the pure core, parameterized (v0.85.2) ────────────
  // ctx: a 2d context (main #c2 or the worker's transferred offscreen).
  // icons: [{id, type, sessionId, x, y, radius}] — live icon objects OR
  // the worker's cloned plain entities (the core reads those fields only).
  // counts: {sessionId → n}; colors: {accent, accent2, ring} triplets;
  // t: seconds (the host clock — worker frames arrive with their own).
  function paintCore(ctx, W, H, offsetX, offsetY, scale, icons, counts, colors, t) {
    t = t * MOTION_TEMPO;   // v0.97: the global slow-down (both hosts call this one function)
    if (!ctx) return { chats: 0, stars: 0, shells: 0 };
    var list = Array.isArray(icons) ? icons : [];
    if (!list.length) return { chats: 0, stars: 0, shells: 0 };
    var s = scale || 1;
    var c = colors || { accent: 'a,b,c', accent2: 'd,e,f', ring: 'rgba(120,130,140,0.35)' };
    var stats = { chats: 0, stars: 0, shells: 0, backHidden: 0, frontInside: 0 };
    var pad = (SHELL_R[SHELL_R.length - 1] + 24) * s + 30;
    // v0.88: hoisted shell-stroke state (constant for the whole frame —
    // the star fills below only touch fillStyle, so this stays valid
    // across every icon; the save/translate/restore per shell keeps the
    // path cache stroke isolated from the star geometry).
    ctx.strokeStyle = c.ring;
    ctx.lineWidth = Math.max(0.5, 0.75 * s);

    for (var i = 0; i < list.length; i++) {
      var icon = list[i];
      if (!icon || icon.type !== 'chat' || !icon.sessionId) continue;
      var n = counts[icon.sessionId] || 0;
      if (!n) continue;
      var cx = (icon.x - offsetX) * s;
      var cy = (icon.y - offsetY) * s;
      if (cx < -pad || cx > W + pad || cy < -pad || cy > H + pad) continue; // cull
      var layout = shellLayout(n);
      var discR = (typeof icon.radius === 'number' ? icon.radius : 28) * s + 2 * s;
      stats.chats++;

      // one pass: shell ellipses (faint) + the stars
      // v0.88: the shell strokes ride the PATH cache + hoisted canvas
      // state (strokeStyle/lineWidth set once per frame below); the
      // per-shell trig + 64-segment walk is gone.
      for (var L = 0; L < layout.length; L++) {
        var R = SHELL_R[L] * s;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.stroke(shellPath(L, s));
        ctx.restore();
        stats.shells++;

        // the stars on this shell — back half first (clipped behind the
        // disc), front half after (over the disc): within a shell the two
        // halves never overlap the same pixel for long, and back-first
        // keeps the front pass on top where they cross.
        var back = [];
        for (var j = 0; j < layout[L]; j++) {
          var p = starPos(icon.id + '|' + L + '|' + j, L, R, t);
          p.r *= s;
          var inside = (p.x * p.x + p.y * p.y) < discR * discR;
          if (p.z < 0) {
            // BACK — evenodd clip: everything EXCEPT the icon disc, dimmed —
            // the star slides behind the nucleus (an inside one vanishes).
            if (inside) { stats.backHidden++; stats.stars++; continue; }
            back.push(p);
          } else {
            if (inside) stats.frontInside++;
            // FRONT — full alpha, tiny glow halo (two arcs, no allocations)
            var rr = Math.max(0.9, p.r);
            ctx.fillStyle = 'rgba(' + (L % 2 ? c.accent2 : c.accent) + ',0.18)';
            ctx.beginPath();
            ctx.arc(cx + p.x, cy + p.y, rr * 2.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(' + (L % 2 ? c.accent2 : c.accent) + ',0.95)';
            ctx.beginPath();
            ctx.arc(cx + p.x, cy + p.y, rr, 0, Math.PI * 2);
            ctx.fill();
            stats.stars++;
          }
        }
        if (back.length) {
          // BACK — evenodd clip: everything EXCEPT the icon disc, dimmed —
          // the star slides behind the nucleus.
          ctx.save();
          ctx.beginPath();
          ctx.rect(-2 * pad, -2 * pad, W + 4 * pad, H + 4 * pad);
          ctx.arc(cx, cy, discR, 0, Math.PI * 2);
          ctx.clip('evenodd');
          for (var q = 0; q < back.length; q++) {
            var bp = back[q];
            var brr = Math.max(0.7, bp.r * 0.85);
            ctx.fillStyle = 'rgba(' + (L % 2 ? c.accent2 : c.accent) + ',0.5)';
            ctx.beginPath();
            ctx.arc(cx + bp.x, cy + bp.y, brr, 0, Math.PI * 2);
            ctx.fill();
            stats.stars++;
          }
          ctx.restore();
        }
      }
    }
    return stats;
  }

  ROOT.AtomCore = {
    paintCore: paintCore,
    paintDots: paintDotsCore,
    shellLayout: shellLayout,
    starPos: starPos,
    SHELL_CAP: SHELL_CAP,
    SHELL_R: SHELL_R,
    SHELL_TILT: SHELL_TILT,
    TILT_BASIS: TILT_BASIS,   // v0.88: the precomputed per-level basis (pixiworld's shells ride it)
    MAX_WS: MAX_WS,
    // v0.90.2: the sphere cache instrument (the rig's bound check)
    _sphereStats: function () {
      return { sprites: SPHERE_SPRITES.size, highlights: HIGHLIGHT_SPRITES.size };
    }
  };

  // ── v0.90.2 THE NEBULA SPHERE — the fog the star produces ─────────
  // USER SPEC: "Render the actual sphere or circle that the central
  // star/dot produces as an opaque sphere that looks more like fog,
  // clouds, nebula, a gas, kind of like it has a guassian filter and
  // these foggy effects on it, and make it responds to the amplify
  // parallax aswell to resemble a sphere. Also make it large… the
  // sphere should probably be 6-8x what it is now, and grow larger
  // with each icon."
  // THE MODEL: a PRE-RENDERED sprite (768px, half-res headroom) per
  // (colorKey, seed bucket) — the limb-bright gas shell (dense rim,
  // hollow core — the icons inside stay readable, the sphere READS),
  // 7 seeded wisps (radial-gradient blobs, 'lighter'), the gaussian
  // feel via multi-stop radial gradients (per-frame ctx.filter is the
  // measured 1fps class — NEVER). Per frame: ONE scaled drawImage (fog
  // upscales gracefully — it is literally blur) + a slow churn rotation
  // (±0.02-0.05 rad/s by seed) + the parallax highlight blob offset
  // toward the screen center (∝ the Amplify parallax slider — the lit
  // limb faces the viewer as the camera pans: it resembles a sphere).
  // The fog diameter = 2.2 × the group's visual radius (6-8× the old
  // ring at the base sizes) and grows with each member (Rv eases).
  var SPHERE_MULT = 2.2;          // fog radius = 2.2 × R (≈7-9× the old 130 ring)
  var SPHERE_SPRITES = new Map(); // colorKey|seed → canvas (LRU 6)
  var HIGHLIGHT_SPRITES = new Map();
  function mkCanvasLocal(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }
  function lruTouch(map, key) {
    var v = map.get(key);
    if (v) { map.delete(key); map.set(key, v); }
    return v;
  }
  function lruSet(map, key, v) {
    map.set(key, v);
    if (map.size > 6) {
      var oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }
  function hexTripletToRgb(hex) {
    var h = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!h) return [74, 74, 94];
    return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)];
  }
  // renderSphereSprite — the one-time fog bake (deterministic per seed).
  function renderSphereSprite(colors, seed) {
    var SZ = 768, C = SZ / 2;
    var cv = mkCanvasLocal(SZ, SZ);
    var g = cv.getContext('2d');
    var accArr = (typeof (colors && colors.accent) === 'string' && colors.accent.indexOf(',') >= 0)
      ? colors.accent.split(',').map(Number)
      : hexTripletToRgb(colors && colors.accent);
    var acc2Arr = (typeof (colors && colors.accent2) === 'string' && colors.accent2.indexOf(',') >= 0)
      ? colors.accent2.split(',').map(Number)
      : hexTripletToRgb(colors && colors.accent2);
    // deterministic per-seed rng (mulberry-style)
    var s = (seed || 0) * 2147483647 | 0;
    function rnd() { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 8) & 0xffffff) / 0xffffff; }
    var A = function (a) { return 'rgba(' + accArr[0] + ',' + accArr[1] + ',' + accArr[2] + ',' + a + ')'; };
    var B = function (a) { return 'rgba(' + acc2Arr[0] + ',' + acc2Arr[1] + ',' + acc2Arr[2] + ',' + a + ')'; };
    // 1) the base gas — transparent core → soft body → gaussian edge
    // (v0.90.2 red-team: the first bake read as a timid disc — the user's
    // word is OPAQUE; the body now carries real presence while the core
    // stays clear for the icons)
    var base = g.createRadialGradient(C, C, 0, C, C, C);
    base.addColorStop(0.00, A(0.02));
    base.addColorStop(0.30, A(0.18));
    base.addColorStop(0.55, A(0.34));
    base.addColorStop(0.78, A(0.48));
    base.addColorStop(0.92, A(0.55));
    base.addColorStop(1.00, A(0.00));
    g.fillStyle = base;
    g.fillRect(0, 0, SZ, SZ);
    // 2) the limb brightening (the shell — what makes it resemble a
    // sphere): a concentrated band just inside the rim
    var limb = g.createRadialGradient(C, C, C * 0.62, C, C, C);
    limb.addColorStop(0.00, A(0.00));
    limb.addColorStop(0.62, A(0.20));
    limb.addColorStop(0.84, A(0.46));
    limb.addColorStop(0.96, A(0.34));
    limb.addColorStop(1.00, A(0.00));
    g.fillStyle = limb;
    g.fillRect(0, 0, SZ, SZ);
    // 3) the wisps — 7 seeded radial blobs, 'lighter' (the clouds/nebula
    // structure), alternating accent/accent2 (the atoms' two-tone)
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 7; i++) {
      var ang = rnd() * Math.PI * 2;
      var rad = C * (0.32 + rnd() * 0.48);
      var wx = C + Math.cos(ang) * rad;
      var wy = C + Math.sin(ang) * rad;
      var wr = C * (0.16 + rnd() * 0.20);
      var al = 0.22 + rnd() * 0.20;
      var wg = g.createRadialGradient(wx, wy, 0, wx, wy, wr);
      var col = (i % 2) ? B : A;
      wg.addColorStop(0, col(al));
      wg.addColorStop(0.55, col(al * 0.45));
      wg.addColorStop(1, col(0));
      g.fillStyle = wg;
      g.beginPath();
      g.arc(wx, wy, wr, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  }
  // renderHighlightSprite — the parallax "lit limb" blob (256px)
  function renderHighlightSprite(colors) {
    var SZ = 256, C = SZ / 2;
    var cv = mkCanvasLocal(SZ, SZ);
    var g = cv.getContext('2d');
    var accArr = (typeof (colors && colors.accent) === 'string' && colors.accent.indexOf(',') >= 0)
      ? colors.accent.split(',').map(Number)
      : hexTripletToRgb(colors && colors.accent);
    var hg = g.createRadialGradient(C, C, 0, C, C, C);
    hg.addColorStop(0, 'rgba(' + accArr.join(',') + ',0.26)');
    hg.addColorStop(0.5, 'rgba(' + accArr.join(',') + ',0.12)');
    hg.addColorStop(1, 'rgba(' + accArr.join(',') + ',0)');
    g.fillStyle = hg;
    g.fillRect(0, 0, SZ, SZ);
    return cv;
  }
  function sphereSpritesFor(colors, seed) {
    var ck = ((colors && colors.accent) || '') + '|' + ((colors && colors.origin) || '');
    var sb = Math.min(3, Math.max(0, Math.floor((seed || 0) * 4)));   // 4 seed buckets
    var key = ck + '|' + sb;
    var sp = lruTouch(SPHERE_SPRITES, key);
    if (!sp) { sp = renderSphereSprite(colors, sb / 4 + 0.125); lruSet(SPHERE_SPRITES, key, sp); }
    var hl = lruTouch(HIGHLIGHT_SPRITES, ck);
    if (!hl) { hl = renderHighlightSprite(colors); lruSet(HIGHLIGHT_SPRITES, ck, hl); }
    return { fog: sp, hl: hl };
  }


  // THE ORBIT STARS + THE NEBULA SPHERES — painted on the over-icons
  // layer (#c2 — the per-frame atoms pass): the star MOVES (the weighty
  // centroid chase in tabgroups.js), so the old full-frame #c1 lattice
  // paint is retired. USER SPEC: "a larger dot/star that has the theme of
  // the canvas center marker (by default). This star represents the
  // center of the orbit" + the sphere it produces (v0.90.2). The pass
  // order: ALL the spheres first (a neighbor's fog never covers a
  // star), then the stars. Dual-environment: the worker paints the same
  // function (zero drift). par = the Amplify-parallax slider 0..1 (the
  // sphere's lit limb shifts toward the screen center — it resembles a
  // sphere as the camera pans).
  function paintDotsCore(ctx, W, H, offsetX, offsetY, scale, dots, colors, t, par) {
    t = t * MOTION_TEMPO;   // v0.97: the orbit stars + nebula churn slow with everything else
    if (!ctx || !dots || !dots.length) return 0;
    var s = scale || 1;
    var c = colors || {};
    var acc = c.accent || '167,139,250';
    var origin = (typeof c.origin === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.origin)) ? c.origin : '#4a4a5e';
    var parN = Math.max(0, Math.min(1, par || 0));
    var painted = 0;
    // ── pass 1: THE SPHERES ─────────────────────────────────────
    var sprites = null;
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if (!d) continue;
      var fogR = (d.R || 420) * s * SPHERE_MULT;
      if (fogR > 1500) fogR = 1500;             // the draw-size cap (upscaled fog is just fog)
      var fx = (d.x - offsetX) * s;
      var fy = (d.y - offsetY) * s;
      if (fx < -fogR - 40 || fx > W + fogR + 40 || fy < -fogR - 40 || fy > H + fogR + 40) continue;
      if (!sprites) sprites = sphereSpritesFor(c, d.seed);
      // the slow churn (the gas lives)
      var churn = ((d.seed || 0) - 0.5) * 0.09 * (t || 0);
      ctx.save();
      ctx.translate(fx, fy);
      if (churn) ctx.rotate(churn);
      ctx.drawImage(sprites.fog, -fogR, -fogR, fogR * 2, fogR * 2);
      ctx.restore();
      // the parallax highlight — the lit limb faces the screen center
      // (∝ the Amplify slider; 0 → centered, 1 → the full offset)
      if (parN > 0.01) {
        var hx = (W / 2 - fx), hy = (H / 2 - fy);
        var hl = Math.hypot(hx, hy) || 1;
        var off = (0.10 + 0.42 * parN) * fogR;
        var hR = fogR * 0.85;
        ctx.drawImage(sprites.hl,
          fx + (hx / hl) * off - hR, fy + (hy / hl) * off - hR, hR * 2, hR * 2);
      }
    }
    // ── pass 2: THE STARS ───────────────────────────────────────
    for (var j = 0; j < dots.length; j++) {
      var d2 = dots[j];
      if (!d2) continue;
      var vr = Math.max(2, (d2.vr || 11) * Math.min(s, 1.5));
      var x = (d2.x - offsetX) * s;
      var y = (d2.y - offsetY) * s;
      if (x < -vr - 120 || x > W + vr + 120 || y < -vr - 120 || y > H + vr + 120) continue;
      var pulse = 1 + 0.06 * Math.sin((t || 0) * 1.3 + (d2.seed || 0) * Math.PI * 2);
      // v0.90.1 RED-TEAM FIX: the plain originColor disc was INVISIBLE on
      // the dark themes (the user: "currently it is either not implemented
      // or does not render" — it rendered, it just didn't READ). The atom
      // stars' own visibility language rides the family: a broad accent
      // halo (the theme's visibility color) + the origin-family core + an
      // accent spark. The star is the CENTER OF THE ORBIT — it must glow
      // like the electrons do.
      ctx.fillStyle = 'rgba(' + acc + ',0.10)';
      ctx.beginPath();
      ctx.arc(x, y, vr * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(' + acc + ',0.22)';
      ctx.beginPath();
      ctx.arc(x, y, vr * 2.1 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = origin;
      ctx.beginPath();
      ctx.arc(x, y, vr * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(' + acc + ',0.95)';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, vr * 0.38), 0, Math.PI * 2);
      ctx.fill();
      painted++;
    }
    return painted;
  }

  // v0.97: THE MOTION TEMPO — the user's canvas ask: "make everything,
  // dots, stars, icons, workspace stars, everything that has movement,
  // much slower". 0.5 = half speed everywhere the AMBIENT world moves
  // (lattice dots/shuttle, atom shell orbits, orbit-star pulse). NOT
  // applied to: physics (drag/throw stays 1:1) or TabGroups ω (already
  // glacial at 1.7–10.5 min/orbit and rig-pinned).
  var MOTION_TEMPO = 0.5;

  // ── the main-thread twin (the feed + the themed wrapper) ──────────
  if (typeof document === 'undefined') return;   // worker: core only

  // ctx: the over-icons canvas 2d context (already cleared this frame).
  function paint(ctx, W, H, offsetX, offsetY, scale, entities) {
    var t = performance.now() / 1000 - t0;
    return paintCore(ctx, W, H, offsetX, offsetY, scale, entities, counts, colors(), t);
  }

  // countsOf — v0.85.2: the raw counts map (the worker frame payload
  // clones it; postMessage handles the copy). colorsFor — the cached
  // theme triplets for the worker's atom pass ("r,g,b" strings + the
  // v0.90.1 origin hex for the orbit stars).
  function countsOf() { return counts; }

  function paintDotsMain(ctx, W, H, offsetX, offsetY, scale, dots) {
    var par = 0;
    try {
      var st = window.Settings && window.Settings.getState();
      if (st && typeof st.spaceParallax === 'number') par = Math.max(0, Math.min(100, st.spaceParallax)) / 100;
    } catch (e) {}
    return paintDotsCore(ctx, W, H, offsetX, offsetY, scale, dots, colors(), performance.now() / 1000, par);
  }

  window.Atoms = {
    refresh: refresh,
    refreshAll: refreshAll,
    setCount: setCount,
    countFor: countFor,
    countsOf: countsOf,
    colorsFor: function () { return colors(); },
    active: active,
    paint: paint,
    paintDots: paintDotsMain,
    shellLayout: shellLayout,
    MAX_WS: MAX_WS,
    SHELL_CAP: SHELL_CAP,
    // the rig's geometric twin — same math the painter runs (v0.84.1).
    _starPos: starPos
  };
})();
