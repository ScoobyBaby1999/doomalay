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
(function () {
  'use strict';

  var SHELL_CAP = [4, 6, 8, 8, 8];            // stars per orbit level
  var SHELL_R   = [46, 60, 74, 88, 102];      // shell radius, screen px @ scale 1
  var SHELL_TILT = [                          // (α° around X, β° around Z) — the axis per level
    [22, 0], [64, 45], [38, 120], [78, 210], [8, 300]
  ];
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
  function starPos(key, level, R, t) {
    var h1 = hashStr(key + '~a'), h2 = hashStr(key + '~b'),
        h3 = hashStr(key + '~c'), h4 = hashStr(key + '~d');
    var omega = (0.35 + h1 * 0.45) * (h2 < 0.5 ? -1 : 1);   // rad/s ±
    var ang = t * omega + h3 * Math.PI * 2;
    var u = Math.cos(ang), v = Math.sin(ang);
    var tilt = SHELL_TILT[level] || SHELL_TILT[0];
    var a = tilt[0] * Math.PI / 180, b = tilt[1] * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    var e1x = cb,    e1y = sb,    e1z = 0;
    var e2x = -sb*ca, e2y = cb*ca, e2z = sa;
    return {
      x: (u * e1x + v * e2x) * R,
      y: (u * e1y + v * e2y) * R,
      z: (u * e1z + v * e2z) * R,
      r: 1.9 + h4 * 1.1                                  // star radius px @ scale 1
    };
  }

  // ── theme colors (cached — never per-frame getComputedStyle) ────
  var colCache = { at: 0, accent: '#a78bfa', accent2: '#38bdf8', ring: 'rgba(120,130,140,0.35)' };
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
      var bs = triplet(cssVar('--border-strong'));
      colCache.ring = bs ? ('rgba(' + bs + ',0.35)') : 'rgba(120,130,140,0.35)';
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

  // ── THE PAINT ─────────────────────────────────────────────────────
  // ctx: the over-icons canvas 2d context (already cleared this frame).
  function paint(ctx, W, H, offsetX, offsetY, scale, entities) {
    if (!ctx) return { chats: 0, stars: 0, shells: 0 };
    var list = Array.isArray(entities) ? entities : [];
    if (!list.length) return { chats: 0, stars: 0, shells: 0 };
    var t = performance.now() / 1000 - t0;
    var s = scale || 1;
    var c = colors();
    var stats = { chats: 0, stars: 0, shells: 0, backHidden: 0, frontInside: 0 };
    var pad = (SHELL_R[SHELL_R.length - 1] + 24) * s + 30;

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
      for (var L = 0; L < layout.length; L++) {
        var R = SHELL_R[L] * s;
        var tilt = SHELL_TILT[L] || SHELL_TILT[0];
        var a = tilt[0] * Math.PI / 180, b = tilt[1] * Math.PI / 180;
        var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
        var e1x = cb,    e1y = sb,    e1z = 0;
        var e2x = -sb*ca, e2y = cb*ca, e2z = sa;

        // the shell's projected path — 64 segments, faint stroke
        ctx.beginPath();
        for (var k = 0; k <= 64; k++) {
          var th = (k / 64) * Math.PI * 2;
          var uu = Math.cos(th), vv = Math.sin(th);
          var px = cx + (uu * e1x + vv * e2x) * R;
          var py = cy + (uu * e1y + vv * e2y) * R;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = c.ring;
        ctx.lineWidth = Math.max(0.5, 0.75 * s);
        ctx.stroke();
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

  window.Atoms = {
    refresh: refresh,
    refreshAll: refreshAll,
    setCount: setCount,
    countFor: countFor,
    active: active,
    paint: paint,
    shellLayout: shellLayout,
    MAX_WS: MAX_WS,
    SHELL_CAP: SHELL_CAP,
    // the rig's geometric twin — same math the painter runs (v0.84.1).
    _starPos: starPos
  };
})();
