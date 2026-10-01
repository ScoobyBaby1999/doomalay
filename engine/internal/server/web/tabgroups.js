// tabgroups.js — v0.88.2 THE COLLISION DOTS + THE GROUP ORBITS.
//
// USER SPEC (verbatim): "we can make tab icons form connections if the
// user moves them and collides the icons on the canvas with one
// another… When two icons collide, a dot forms in the collision point
// that has a radius around it, all icons in that radius are connected.
// So for now, we will focus on two tabs, two tabs that are in a
// collision dots radius bubble act as grouped tabs. If two icons
// collide inside the radius of a collision dot, instead of forming a
// new dot inside the radius of a preexisting one, we make the
// preexisting one render as a larger dot and increase its radius."
// +
// "All icons inside the radius of a collision dot should orbit the
// collision dot sort of like how the stars orbit the icons, icons
// inside the same radius should orbit slightly faster the closer they
// are to the dot, and slower the closer they are to the radius, they
// should orbit around without moving to a determined fixed path, for
// example, the user can move and icon somewhere and have it orbit but
// stay in that location or trejectory of orbit. We have them orbit
// very slowly to not be annoying for the user. And also try to make
// them orbit in 3d like the stars do for icons if increase Parallax
// slider is adjusted."
//
// THE MODEL:
//   · A DOT forms at the collision midpoint of two WEB TAB icons (chat
//     icons never join — "we focus only on handling tab icons not chat
//     + tab"): a small painted mark (varying size, the origin dot's
//     theme family, ALWAYS smaller than the center-of-grid dot) + a
//     group radius (R0 130) — the connection bubble.
//   · MEMBERSHIP: any web tab whose anchor sits within a dot's radius
//     ("all icons in that radius are connected") — collision joins and
//     passive drift-ins both capture; dragging an icon out releases it.
//   · GROWTH: a collision INSIDE an existing dot's radius grows the dot
//     (a larger render + an increased radius, capped) — never a nested
//     dot. Overlapping dots MERGE.
//   · THE ORBIT: each member keeps its own (r, φ) around the dot — the
//     position = dot + polar-on-a-TILTED-3D-plane(r, φ(t)) — written
//     DIRECTLY into icon.x/y (the physics anchor: hit tests, drags,
//     serialization and the pixi mirror all inherit it for free). The
//     angle advances at ω(r) — faster near the dot, slower near the
//     radius — VERY slowly (a full orbit takes minutes). "Without a
//     determined fixed path": moving an icon re-baselines its (r, φ)
//     and it orbits from wherever the user left it. The depth (z on the
//     tilted plane) feeds a subtle scale + lift cue tied to the
//     Parallax slider (the stars' 3D language).
//   · GROUPED TABS are the keep-alive's protected class (webpanel.js
//     consults isGrouped): "only tabs that are connected or associated
//     with each other remain untouched and act as grouped loaded tabs".
//
// Exposes: window.TabGroups = { collide, step, active, isGrouped,
//                                members, dotsFor, serialize, deserialize,
//                                _debug }
(function () {
  'use strict';

  var R0 = 130;             // the initial group radius (world units)
  var R_MAX = 340;          // the growth ceiling
  var R_GROW = 40;          // +radius per collision-join
  var R_GROW_PASSIVE = 12;  // +radius per passive drift-in
  var VR_BASE = 4.2;        // the dot's painted radius: base
  var VR_VAR = 2.2;         //   + per-dot hash variation ("make it vary")
  var VR_MEMBER = 0.55;     //   + per member ("render as a larger dot")
  var VR_MAX = 6.9;         //   — ALWAYS < the origin dot's 12
  var OMEGA_MIN = 0.008;    // rad/s at the radius edge (~13 min/orbit)
  var OMEGA_MAX = 0.045;    // rad/s near the dot (~2.3 min/orbit)
  var SLACK = 22;           // the leave threshold (radius + slack)
  var LEAVE_SLACK = 20;

  var dots = [];            // {id, x, y, R, vr, members:Set, ax:{x,y,z}, dir, seed}
  var byId = new Map();

  function hash01(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return (h % 1000000) / 1000000;
  }
  function newId() { return 'dot_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  // the orbit plane's tilt — a deterministic axis per dot (the atoms'
  // SHELL_TILT language: α around X, β around Z)
  function axisFor(id) {
    var a = (12 + hash01(id + '~a') * 62) * Math.PI / 180;   // 12°..74°
    var b = hash01(id + '~b') * Math.PI * 2;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    // plane basis (e1, e2) — the normal is their cross product
    return {
      e1: { x: cb, y: sb, z: 0 },
      e2: { x: -sb * ca, y: cb * ca, z: sa },
      dir: hash01(id + '~c') < 0.5 ? -1 : 1
    };
  }

  // ── capture: an icon joins a dot at its CURRENT position (r, φ on
  // the tilted plane). "Stay in that location or trajectory": the orbit
  // continues from exactly where the icon sits.
  function capture(dot, icon) {
    var dx = icon.x - dot.x, dy = icon.y - dot.y;
    // φ from the screen angle; r from the screen distance (the plane's
    // tilt would need a z to solve exactly — a fresh capture starts
    // flat: z = 0, the angle = the screen angle; the tilt generates
    // depth as it advances)
    var r = Math.sqrt(dx * dx + dy * dy) || 1;
    var phi = Math.atan2(dy, dx);
    icon._orbit = {
      dot: dot,
      r: r,
      phi: phi,
      dragging: false
    };
    if (!dot.members.has(icon)) {
      dot.members.add(icon);
      // the angular spread: a joiner landing within 18° of a member at
      // a similar radius nudges into the gap (intra-group overlap is
      // ugly; the physics correction skips same-group pairs)
      dot.members.forEach(function (m) {
        if (m === icon || !m._orbit) return;
        var dr = Math.abs(m._orbit.r - r);
        if (dr > r * 0.45) return;
        var dphi = normAng(m._orbit.phi - phi);
        if (Math.abs(dphi) < 0.31) icon._orbit.phi = normAng(phi + (dphi >= 0 ? 0.36 : -0.36));
      });
    }
  }
  function normAng(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function release(icon) {
    var dot = icon && icon._orbit && icon._orbit.dot;
    if (!dot) return;
    icon._orbit = null;
    dot.members.delete(icon);
    if (!dot.members.size) dissolve(dot);
  }
  function dissolve(dot) {
    dot.members.forEach(function (m) { m._orbit = null; });
    dot.members.clear();
    var i = dots.indexOf(dot);
    if (i >= 0) dots.splice(i, 1);
    byId.delete(dot.id);
  }

  function dotOf(icon) {
    return (icon && icon._orbit && icon._orbit.dot) || null;
  }

  // ── collide(a, b, cx, cy) — the contact tap's handler (web+web only;
  // app.js filters). Returns true when the group topology changed
  // (app.js repaints the grid furniture).
  function collide(a, b, cx, cy) {
    if (!a || !b || a === b) return false;
    if (a.type !== 'web' || b.type !== 'web') return false;
    var da = dotOf(a), db = dotOf(b);

    // an INTRA-GROUP touch (both already members of the SAME dot): the
    // orbit owns these — no re-capture (a per-frame re-baseline would
    // freeze the swirl — every contact reset the phase), no growth, no
    // velocity fiddling. Just a touch.
    if (da && da === db) return false;

    // the sticky cluster: a fresh formation absorbs the impact (the
    // icons settle into their orbits instead of bouncing apart)
    if (!a.dragging) { a.vx = 0; a.vy = 0; }
    if (!b.dragging) { b.vx = 0; b.vy = 0; }

    // two dots meeting → MERGE (the smaller folds into the larger; the
    // larger renders bigger + its radius grows)
    if (da && db && da !== db) {
      var big = da.members.size >= db.members.size ? da : db;
      var small = big === da ? db : da;
      var moved = Array.from(small.members);
      big.R = Math.min(R_MAX, big.R + 30 + small.R * 0.25);
      big.vr = Math.min(VR_MAX, big.vr + VR_MEMBER * moved.length);
      dissolve(small);
      moved.forEach(function (m) { capture(big, m); });
      return true;
    }

    var dot = da || db;
    if (dot) {
      // a collision touching an existing group's space: the outsider
      // joins if its anchor is within the bubble — "instead of forming
      // a new dot inside the radius of a preexisting one, we make the
      // preexisting one render as a larger dot and increase its radius"
      var outsider = da ? b : a;
      var d = Math.hypot(outsider.x - dot.x, outsider.y - dot.y);
      if (d <= dot.R + outsider.radius) {
        var isNew = !dot.members.has(outsider);
        capture(dot, outsider);
        if (isNew) {
          dot.R = Math.min(R_MAX, dot.R + R_GROW);
          dot.vr = Math.min(VR_MAX, dot.vr + VR_MEMBER);
        }
        return true;
      }
      // the contact point sits inside the dot's bubble even though the
      // outsider's center is out: still a growth event (the spec's
      // inside-collision), and the outsider joins from its edge
      var dcy = Math.hypot(cx - dot.x, cy - dot.y);
      if (dcy <= dot.R) {
        var isNew2 = !dot.members.has(outsider);
        capture(dot, outsider);
        if (isNew2) {
          dot.R = Math.min(R_MAX, dot.R + R_GROW);
          dot.vr = Math.min(VR_MAX, dot.vr + VR_MEMBER);
        }
        return true;
      }
      // a genuinely outside contact between a member and a free tab:
      // the member keeps its group; a NEW dot would nest at the edge —
      // no. The free tab simply stays free (the member's orbit holds).
      return false;
    }

    // two free tabs collide → THE DOT forms at the collision point
    var id = newId();
    dot = {
      id: id,
      x: cx, y: cy,
      R: R0,
      vr: Math.min(VR_MAX, VR_BASE + hash01(id) * VR_VAR),
      members: new Set(),
      ax: axisFor(id),
      seed: hash01(id + '~s')
    };
    dots.push(dot);
    byId.set(id, dot);
    capture(dot, a);
    capture(dot, b);
    return true;
  }

  // ── step(now) — the orbit stepper (app.js's rAF cadence). VERY slow:
  // ω(r) = OMEGA_MAX − (OMEGA_MAX−OMEGA_MIN)·(r/R) — faster near the
  // dot, slower near the edge. Members' positions are written straight
  // into x/y (the physics anchor). Dragging members freeze (the finger
  // owns the anchor) and re-capture on release.
  var lastT = 0;
  function step(now) {
    if (!dots.length) { lastT = now; return false; }
    var dt = Math.min(0.1, (now - lastT) / 1000) || 0.016;
    lastT = now;
    var parallax = 0;
    try {
      var st = window.Settings && window.Settings.getState();
      parallax = st && typeof st.spaceParallax === 'number' ? st.spaceParallax : 0;
    } catch (e) {}
    var depthK = 0.06 + 0.34 * (parallax / 100);   // the 3D cue (scale)
    var liftK = 4 + 14 * (parallax / 100);         // the 3D cue (y-lift, px)

    var moved = false;
    for (var di = 0; di < dots.length; di++) {
      var dot = dots[di];
      // v0.88.2 (the red-team's catch): THE FOLLOW tracks ONLY A DRAGGED
      // member's pull — the members' orbit-written positions are
      // dot-relative (a centroid of them is a self-chasing feedback loop:
      // an off-center cluster dragged the dot ~48px/s forever). A finger
      // stretching a member past half the radius pulls the cluster; a
      // resting dot stays at its collision point.
      var dragM = null;
      dot.members.forEach(function (m) { if (m.dragging) dragM = m; });
      if (dragM) {
        var fx = dragM.x - dot.x, fy = dragM.y - dot.y;
        var fl = Math.hypot(fx, fy);
        if (fl > dot.R * 0.5 && fl > 0.01) {
          var pull = Math.min(0.8, (fl - dot.R * 0.5) * 0.03) / fl;
          dot.x += fx * pull; dot.y += fy * pull;
        }
      }
      dot.members.forEach(function (m) {
        var o = m._orbit;
        if (!o) return;
        if (m.dragging) { o.dragging = true; return; }
        if (o.dragging) {
          // the finger just let go — re-baseline from where it landed:
          // "the user can move an icon somewhere and have it orbit but
          // stay in that location"
          o.dragging = false;
          var dx = m.x - dot.x, dy = m.y - dot.y;
          o.r = Math.sqrt(dx * dx + dy * dy) || 1;
          o.phi = Math.atan2(dy, dx);
        }
        // v0.88.2 (the red-team's catches): THE ORBIT OWNS THE POSITION —
        // (a) any residual velocity (a drag-release fling) is meaningless
        // under an orbit-owned anchor: zero it (the flinging member used
        // to fly out of the group and get released);
        // (b) the membership test reads the CAPTURED radius o.r — the
        // LIVE anchor gets transiently pushed by physics position
        // corrections (an overlapping chat, say) and the orbit write
        // snaps it back next frame; a live-distance test would wrongly
        // release members mid-push
        m.vx = 0; m.vy = 0;
        if (o.r > dot.R + LEAVE_SLACK) { release(m); return; }
        // ω(r): faster near the dot, slower near the radius
        var w = OMEGA_MAX - (OMEGA_MAX - OMEGA_MIN) * Math.min(1, o.r / dot.R);
        o.phi += w * dot.ax.dir * dt;
        // the position on the tilted 3D plane (polar → basis e1/e2)
        var ax = dot.ax;
        var cp = Math.cos(o.phi), sp = Math.sin(o.phi);
        var px = (cp * ax.e1.x + sp * ax.e2.x) * o.r;
        var py = (cp * ax.e1.y + sp * ax.e2.y) * o.r;
        var pz = (cp * ax.e1.z + sp * ax.e2.z) * o.r;
        m.x = dot.x + px;
        m.y = dot.y + py;
        // the depth cues (the stars' 3D language, tied to Parallax)
        var zn = o.r ? Math.max(-1, Math.min(1, pz / o.r)) : 0;
        m._orbitScale = 1 + zn * depthK;
        m._orbitLift = zn * liftK;
        moved = true;
      });
      // passive capture: a free web tab resting inside the bubble joins
      // (drift-ins and drag-releases inside the radius)
      var ents = (window.doomalay && window.doomalay.world && window.doomalay.world.entities) || [];
      for (var ei = 0; ei < ents.length; ei++) {
        var e = ents[ei];
        if (e.type !== 'web' || e._orbit || e.dragging) continue;
        var edx = e.x - dot.x, edy = e.y - dot.y;
        if (Math.hypot(edx, edy) <= dot.R) {
          capture(dot, e);
          if (!e._orbitDragging) { e.vx = 0; e.vy = 0; }
          dot.R = Math.min(R_MAX, dot.R + R_GROW_PASSIVE);
          dot.vr = Math.min(VR_MAX, dot.vr + 0.18);
          moved = true;
        }
      }
    }
    return moved;
  }

  // ── the public surface ─────────────────────────────────────────────
  function active() { return dots.length > 0; }
  function isGrouped(icon) {
    return !!(icon && icon._orbit && icon._orbit.dot && icon._orbit.dot.members.has(icon));
  }
  function members() {
    var out = [];
    dots.forEach(function (d) { d.members.forEach(function (m) { out.push(m); }); });
    return out;
  }
  // the paint payload (lattice.js's frame: the dot + the bubble ring)
  function dotsFor() {
    return dots.map(function (d) {
      return { x: d.x, y: d.y, R: d.R, vr: d.vr };
    });
  }
  function serialize() {
    return dots.map(function (d) {
      var ms = [];
      d.members.forEach(function (m) {
        ms.push({ id: m.id, r: m._orbit ? m._orbit.r : 0, phi: m._orbit ? m._orbit.phi : 0 });
      });
      return { id: d.id, x: d.x, y: d.y, R: d.R, vr: d.vr, ax: d.ax, members: ms };
    });
  }
  function deserialize(data) {
    if (!Array.isArray(data)) return;
    var ents = (window.doomalay && window.doomalay.world && window.doomalay.world.entities) || [];
    data.forEach(function (dd) {
      var dot = {
        id: dd.id, x: dd.x, y: dd.y, R: dd.R || R0,
        vr: Math.min(VR_MAX, dd.vr || VR_BASE),
        members: new Set(),
        ax: (dd.ax && dd.ax.e1) ? dd.ax : axisFor(dd.id || newId()),
        seed: 0.5
      };
      dots.push(dot);
      byId.set(dot.id, dot);
      (dd.members || []).forEach(function (mm) {
        var icon = null;
        for (var i = 0; i < ents.length; i++) {
          if (ents[i].id === mm.id && ents[i].type === 'web') { icon = ents[i]; break; }
        }
        if (icon) {
          capture(dot, icon);
          if (icon._orbit && typeof mm.r === 'number' && mm.r > 0) {
            icon._orbit.r = mm.r;
            icon._orbit.phi = mm.phi || 0;
          }
        }
      });
      if (!dot.members.size) dissolve(dot);
    });
  }

  window.TabGroups = {
    collide: collide,
    step: step,
    active: active,
    isGrouped: isGrouped,
    members: members,
    dotsFor: dotsFor,
    serialize: serialize,
    deserialize: deserialize,
    _debug: {
      dots: function () { return dots.slice(); },
      dotCount: function () { return dots.length; },
      membersOf: function (dot) { return Array.from(dot.members); },
      release: release,
      clear: function () { dots.slice().forEach(dissolve); },
      R0: R0, R_MAX: R_MAX
    }
  };
})();
