// tabgroups.js — v0.90.1 THE STEERING ORBITS (the atom-sphere wave).
//
// USER SPEC (verbatim): "When two icons collide, instead of snapping to
// place, let's have them bounce off each other with physics and momentum
// with an exponential curve out that varies depending on impact velocity."
// "Instead of having fixed orbital grids, we have a large sphere/circle,
// where any icon inside orbits at the position it is in. We try to make the
// direction it orbits even to look like an atom without fixed orbits."
// "I like how when u pull on one icon the other follows, let's keeps that,
// let's have it so that icons can disturb other icons in the sphere when
// moved… If enough icons are moving at once in a certain direction the dot
// icon marking the center should also move but feel weightier."
// "The orbit itself is WAAAAAY to small" → R0 420 (3.2× the old 130).
//
// THE MODEL — v0.90's REWRITE: PHYSICS OWNS POSITIONS; THE ORBIT IS A
// VELOCITY FIELD. (v0.89.1 wrote member x/y from stored polar geometry —
// that model cannot bounce, propagate disturbances, or follow weightily.)
//   · Collisions BOUNCE (physics.js: restitution + the velocity-
//     proportional impact boost) — formation never zeroes velocities; the
//     pair bounces apart AROUND the newborn star, exactly like an atom.
//   · step() STEERS: each member's velocity blends (exponential, k 2.5/s —
//     the curve-out) toward the circular-orbit velocity at its CURRENT
//     radius — per-icon direction (join parity: even CW/CCW mix — "the
//     direction it orbits even"), ω(r) faster near the star — plus soft
//     radial containment (spring-in past 0.82R; core clearance push-out).
//     "The user can move an icon somewhere and have it orbit but stay in
//     that location": whatever the bounce/drag left behind IS the orbit.
//   · Members skip physics FRICTION while grouped (physics.js) — the blend
//     is their damping; friction would bleed the sustained orbit to a stop.
//   · THE STAR: a critically-damped spring chases the member centroid (the
//     dragged member weighs 3× — the pull-FOLLOW emerges: drag one to the
//     rim → the centroid shifts → the star follows → containment drags the
//     rest along). Stiffness falls with member count ("feel weightier").
//   · The depth cue: per-member tilt + phase (the stars' 3D language, tied
//     to the Amplify parallax slider) → _orbitScale/_orbitLift.
//
// PAINT: the star + the sphere render on #c2 (the per-frame atoms layer —
// the star MOVES now) via AtomCore.paintDots (atoms.js, dual-environment);
// v0.89.1's #c1 lattice paint is retired. The star is the canvas center
// marker's family (originColor), larger — "a larger dot/star that has the
// theme of the canvas center marker… This star represents the center of
// the orbit."
//
// v0.89.1 COMPAT: serialize v2 (member ids only); v1 saves (r/phi/ax
// members) load by id. The web-only formation filter stays until v0.90.3
// ("for now, we implement the functionality of tabs alone").
//
// Exposes: window.TabGroups = { collide, step, active, isGrouped,
//                                members, dotsFor, serialize, deserialize,
//                                _debug }
(function () {
  'use strict';

  var R0 = 420;             // the initial group radius — 3.2× the old 130
  var R_MAX = 1500;         // the growth ceiling
  var R_GROW = 100;         // +radius per collision-join
  var R_GROW_PASSIVE = 40;  // +radius per passive drift-in
  var LEAVE_SLACK = 70;     // release beyond R + slack (bounces stay inside; a deliberate fling leaves)
  var LEAVE_HOLD = 0.6;     // s SUSTAINED beyond the leave radius — transient overshoots
                           // (bounce recoil, push lag while the star catches up) never
                           // break the group; a real departure does
  var VR_BASE = 11;         // the star's painted radius — the origin dot's family (12)
  var VR_MEMBER = 1.7;      //   + per member ("grow larger with each icon")
  var VR_MAX = 34;
  var OMEGA_MIN = 0.010;    // rad/s at the radius edge (~10.5 min/orbit)
  var OMEGA_MAX = 0.060;    // rad/s near the star (~1.7 min/orbit)
  var BLEND_K = 2.5;        // 1/s — the steering blend (the exponential curve-out, τ≈0.4s)
  var CONTAIN_R = 0.82;     // the soft rim — the radial target pulls in past it
  var CONTAIN_K = 1.1;      //   inward px/s per px beyond the rim
  var CORE_K = 3.0;         // core clearance: outward px/s per px inside it
  var CORE_PAD = 26;        //   + star vr + icon radius
  var SPRING_K = 30;        // the star's critically-damped chase, 1 member
  var SPRING_KFALL = 0.35;  // stiffness falloff per extra member (weightier)
  var DRAG_WEIGHT = 3;      // the dragged member's centroid weight (the follow)

  var dots = [];            // {id, x, y, vx, vy, R, Rv, vr, members:Set, seed, joinCount}
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

  // ── capture: joining is REGISTRATION ONLY — no geometry, no position
  // writes. The member keeps whatever position + velocity it has; the
  // steering field picks it up from exactly there ("orbit at the position
  // it is in"). Per-member orbit character: direction by join parity (an
  // even CW/CCW mix — the atom look), tilt + phase from the stable hash.
  function capture(dot, icon) {
    if (icon._orbit) return;
    var idx = dot.joinCount++;
    icon._orbit = {
      dot: dot,
      dir: (idx % 2 === 0) ? 1 : -1,
      tilt: 0.18 + hash01(dot.id + '|' + icon.id + '~t') * 0.52,
      phase0: hash01(dot.id + '|' + icon.id + '~p') * Math.PI * 2
    };
    dot.members.add(icon);
  }

  function release(icon) {
    var dot = icon && icon._orbit && icon._orbit.dot;
    if (!dot) return;
    icon._orbit = null;
    icon._orbitScale = null;
    icon._orbitLift = null;
    dot.members.delete(icon);
    if (!dot.members.size) dissolve(dot);
  }
  function dissolve(dot) {
    dot.members.forEach(function (m) {
      m._orbit = null;
      m._orbitScale = null;
      m._orbitLift = null;
    });
    dot.members.clear();
    var i = dots.indexOf(dot);
    if (i >= 0) dots.splice(i, 1);
    byId.delete(dot.id);
  }

  function dotOf(icon) {
    return (icon && icon._orbit && icon._orbit.dot) || null;
  }

  // ── collide(a, b, cx, cy) — the contact tap's handler (web+web only
  // until v0.90.3; app.js filters). Returns true when the group topology
  // changed (app.js repaints the grid furniture). v0.90: NO velocity
  // zeroing — the bounce LIVES (physics.js owns it).
  function collide(a, b, cx, cy) {
    if (!a || !b || a === b) return false;
    if (a.type !== 'web' || b.type !== 'web') return false;
    var da = dotOf(a), db = dotOf(b);

    // an INTRA-GROUP touch (both already members of the SAME dot): the
    // members disturb each other through physics (v0.90 restored the
    // member-member collision response); no topology change, no growth.
    if (da && da === db) return false;

    // two dots meeting → MERGE (the smaller folds into the larger; the
    // larger renders bigger + its radius grows)
    if (da && db && da !== db) {
      var big = da.members.size >= db.members.size ? da : db;
      var small = big === da ? db : da;
      var moved = Array.from(small.members);
      big.R = Math.min(R_MAX, big.R + 60 + small.R * 0.25);
      big.vr = Math.min(VR_MAX, big.vr + VR_MEMBER * moved.length);
      dissolve(small);
      moved.forEach(function (m) { capture(big, m); });
      return true;
    }

    var dot = da || db;
    if (dot) {
      // a collision touching an existing group's space: the outsider
      // joins if its anchor is within the bubble — "instead of forming a
      // new dot inside the radius of a preexisting one, we make the
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
      // the free tab stays free (they bounced — physics handled it).
      return false;
    }

    // two free tabs collide → THE STAR forms at the collision point.
    // v0.90: the pair keeps its momentum — they bounce apart around the
    // newborn star and the steering bends them into their orbits.
    var id = newId();
    dot = {
      id: id,
      x: cx, y: cy,
      vx: 0, vy: 0,
      R: R0, Rv: R0,
      vr: VR_BASE + hash01(id + '~v') * 2.0,
      members: new Set(),
      seed: hash01(id + '~s'),
      joinCount: 0
    };
    dots.push(dot);
    byId.set(id, dot);
    capture(dot, a);
    capture(dot, b);
    return true;
  }

  // ── step(now) — THE STEERING FIELD (app.js's rAF cadence).
  var lastT = 0;
  function step(now) {
    if (!dots.length) { lastT = now; return false; }
    // dt clamp: non-negative (interleaved synthetic clocks from the rigs'
    // stepSim can arrive with timestamps "before" the last real tick),
    // capped at 0.1s (tab switches/background stalls).
    var dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000)) || 0.016;
    lastT = now;
    var parallax = 0;
    try {
      var st = window.Settings && window.Settings.getState();
      parallax = st && typeof st.spaceParallax === 'number' ? st.spaceParallax : 0;
    } catch (e) {}
    var depthK = 0.06 + 0.34 * (parallax / 100);   // the 3D cue (scale)
    var liftK = 4 + 14 * (parallax / 100);         // the 3D cue (y-lift, px)
    var blend = 1 - Math.exp(-BLEND_K * dt);       // the exponential curve-out

    var moved = false;
    for (var di = 0; di < dots.length; di++) {
      var dot = dots[di];

      // ── 1) THE STAR — the centroid chase, critically damped, weighty.
      // The dragged member weighs 3× (the pull-follow emerges); a FREE
      // member's pull FADES past the rim (0.82R → 0 at 1.32R). The weights
      // divide by max(Σw, 1) — a REFERENCE weight in OFFSET space (from
      // the star), not a renormalization: faded members drag the star
      // PARTWAY (a lone fleer pulls 30%-ish, not fully), and when everyone
      // fades the target collapses to the star itself (it never chases a
      // full exodus). The stiffness falls with member count ("weightier").
      var wx = 0, wy = 0, wsum = 0;
      dot.members.forEach(function (m) {
        var w;
        if (m.dragging) {
          w = DRAG_WEIGHT;      // the finger's intent IS to pull — never gated
        } else {
          w = 1;
          var mdx = m.x - dot.x, mdy = m.y - dot.y;
          var mr = Math.sqrt(mdx * mdx + mdy * mdy);
          // the fade completes just past the leave radius (1.16R) — a
          // fleeing member stops dragging the star BEFORE the release
          // decision, so the rim-fling escape band is real at any size.
          if (mr > dot.R * CONTAIN_R) {
            w = Math.max(0, 1 - (mr - dot.R * CONTAIN_R) / (dot.R * 0.34));
          }
          // INTENT gate (the leave rule's own signal): a member fleeing
          // FAST under its own momentum stops pulling the star — the
          // chase must not absorb the escape it's fleeing from. The
          // gentle collective push (<3 px/f) keeps its full weight
          // ("enough icons moving at once moves the dot").
          if (mr > 0.01) {
            var vOutM = (m.vx * mdx + m.vy * mdy) / mr;
            if (vOutM > 3) w *= Math.max(0, 1 - (vOutM - 3) / 8);
          }
        }
        wx += (m.x - dot.x) * w; wy += (m.y - dot.y) * w; wsum += w;
      });
      var wdiv = Math.max(wsum, 1);
      wx = dot.x + wx / wdiv; wy = dot.y + wy / wdiv;
      var K = SPRING_K / (1 + SPRING_KFALL * Math.max(0, dot.members.size - 1));
      var cd = 2 * Math.sqrt(K);                    // critical damping
      dot.vx += ((wx - dot.x) * K - dot.vx * cd) * dt;
      dot.vy += ((wy - dot.y) * K - dot.vy * cd) * dt;
      dot.x += dot.vx * dt;
      dot.y += dot.vy * dt;
      // the growth bloom: the visual radius eases to the target
      dot.Rv += (dot.R - dot.Rv) * Math.min(1, 2.5 * dt);

      // ── 2) THE STEERING — members orbit from wherever they are.
      // UNITS: physics velocities are px/FRAME (e.x += e.vx per step),
      // so the targets fold dt in (ω·r·dt = px/frame); the blend factor
      // stays dimensionless. Steady state: v == target exactly (members
      // skip friction) — the orbit speed holds; a disturbance decays as
      // e^{-k·t} (the exponential curve-out).
      dot.members.forEach(function (m) {
        var o = m._orbit;
        if (!o) return;
        if (m.dragging) return;   // the finger owns it — its render rides update()
        var dx = m.x - dot.x, dy = m.y - dot.y;
        var r = Math.sqrt(dx * dx + dy * dy) || 1;
        var rx = dx / r, ry = dy / r;              // radial unit (outward)
        // LEAVE — SUSTAINED + INTENT-aware. A member counts as leaving
        // only while NOT closing back: the star's transits (a drag-follow
        // chase) carry members transiently beyond the leave radius with
        // their velocity aimed AT the moving star — that is FOLLOWING,
        // not leaving (vOut ≤ -0.5 px/f freezes the accrual). A COMMITTED
        // departure (deep beyond +60px, or fleeing fast vOut > 3 px/f)
        // releases in 0.3s; a shallow non-closing overshoot holds 1.2s
        // while the containment recovers it. Bounces never reach the leave
        // radius (the boost clamps keep them inside) — this is flings,
        // hard shoves, and drag-drops far out.
        var vOut = m.vx * rx + m.vy * ry;
        var beyond = r - (dot.R + LEAVE_SLACK);
        if (beyond > 0) {
          if (vOut <= -0.5) {
            o.outT = 0;             // closing — following the star's transit
          } else {
            o.outT = (o.outT || 0) + dt;
            if (o.outT > (beyond > 60 || vOut > 3 ? 0.3 : 1.2)) { release(m); return; }
          }
        } else {
          o.outT = 0;
        }
        var tx = -ry * o.dir, ty = rx * o.dir;     // tangent (per-icon direction)
        // the targets at the CURRENT radius (px per frame):
        var omega = OMEGA_MAX - (OMEGA_MAX - OMEGA_MIN) * Math.min(1, r / dot.R);
        var vtT = omega * r * dt;                   // tangential px/frame
        var vrT = 0;                                // radial target px/frame
        if (r > dot.R * CONTAIN_R) {
          // the rim pull SATURATES at the leave radius — a member beyond
          // R+slack is leaving (the leave logic owns it); an ever-growing
          // inward target would absorb legitimate flings forever.
          var excess = Math.min(r - dot.R * CONTAIN_R, LEAVE_SLACK + dot.R * (1 - CONTAIN_R));
          vrT = -excess * CONTAIN_K * dt;
        }
        var coreR = dot.vr + (m.radius || 28) + CORE_PAD;
        if (r < coreR) vrT = (coreR - r) * CORE_K * dt;
        // decompose, blend (the exponential settle), recompose — but the
        // RADIAL capture WEAKENS past the leave radius: a departing member
        // (a fling) must escape, not be reeled back by the same first-order
        // pull that recovers shallow overshoots. The tangential blend is
        // untouched (the swirl survives the flight).
        var kRad = blend;
        if (beyond > 0) kRad *= Math.max(0.25, 1 - beyond / 200);
        var vt = m.vx * tx + m.vy * ty;
        var vr = m.vx * rx + m.vy * ry;
        vt += (vtT - vt) * blend;
        vr += (vrT - vr) * kRad;
        m.vx = tx * vt + rx * vr;
        m.vy = ty * vt + ry * vr;
        // the depth cue (the tilted-plane language, phase from the live
        // angle — one oscillation per revolution, spread by phase0)
        var phi = Math.atan2(dy, dx);
        var zn = Math.sin(phi + o.phase0) * Math.sin(o.tilt);
        m._orbitScale = 1 + zn * depthK;
        m._orbitLift = zn * liftK;
        moved = true;
      });

      // ── 3) PASSIVE capture: a free web tab resting inside the bubble
      // joins (drift-ins and drag-releases inside the radius)
      var ents = (window.doomalay && window.doomalay.world && window.doomalay.world.entities) || [];
      for (var ei = 0; ei < ents.length; ei++) {
        var e = ents[ei];
        if (e.type !== 'web' || e._orbit || e.dragging) continue;
        var edx = e.x - dot.x, edy = e.y - dot.y;
        if (Math.hypot(edx, edy) <= dot.R) {
          capture(dot, e);
          dot.R = Math.min(R_MAX, dot.R + R_GROW_PASSIVE);
          dot.vr = Math.min(VR_MAX, dot.vr + 0.6);
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
  // the paint payload (the #c2 pass: the star — and v0.90.2's sphere —
  // read these). R rides the VISUAL radius (the eased bloom).
  function dotsFor() {
    return dots.map(function (d) {
      return { x: d.x, y: d.y, R: d.Rv, vr: d.vr, n: d.members.size, seed: d.seed };
    });
  }
  // v2: member ids only (the orbit has no stored geometry anymore).
  // v1 saves (members [{id, r, phi}]) load by id — the geometry is ignored.
  function serialize() {
    return dots.map(function (d) {
      var ms = [];
      d.members.forEach(function (m) { ms.push(m.id); });
      return { v: 2, id: d.id, x: d.x, y: d.y, R: d.R, vr: d.vr,
               seed: d.seed, members: ms };
    });
  }
  function deserialize(data) {
    if (!Array.isArray(data)) return;
    var ents = (window.doomalay && window.doomalay.world && window.doomalay.world.entities) || [];
    data.forEach(function (dd) {
      if (!dd || !dd.id) return;
      var dot = {
        id: dd.id, x: dd.x || 0, y: dd.y || 0,
        vx: 0, vy: 0,
        R: Math.min(R_MAX, dd.R || R0), Rv: Math.min(R_MAX, dd.R || R0),
        vr: Math.min(VR_MAX, dd.vr || VR_BASE),
        members: new Set(),
        seed: (typeof dd.seed === 'number') ? dd.seed : hash01(dd.id + '~s'),
        joinCount: 0
      };
      dots.push(dot);
      byId.set(dot.id, dot);
      var src = dd.members || [];
      for (var i = 0; i < src.length; i++) {
        var mid = (typeof src[i] === 'string') ? src[i] : (src[i] && src[i].id);
        if (!mid) continue;
        for (var j = 0; j < ents.length; j++) {
          if (ents[j].id === mid && ents[j].type === 'web') { capture(dot, ents[j]); break; }
        }
      }
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
      R0: R0, R_MAX: R_MAX, OMEGA_MIN: OMEGA_MIN, OMEGA_MAX: OMEGA_MAX
    }
  };
})();
