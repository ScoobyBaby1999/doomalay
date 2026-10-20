// physics.js — 2D physics for chatbot icons on the infinite canvas.
//
// No external dependencies. Exposes window.Physics = { Entity, World }.
//
// Design notes:
//   • Entities live in WORLD space (not screen space). The app controller
//     applies the canvas pan offset when rendering, so panning the grid
//     also moves the chatbots visually without changing their world coords.
//   • Friction is per-16ms-frame (target 60fps). It's frame-rate-dependent
//     on purpose — keeping the math simple. At 30fps the chatbots will
//     decelerate faster; on 144Hz displays, slower. Acceptable for a
//     touch-driven UI.
//   • v0.94.4 F2: THE SPATIAL HASH — the pairwise O(n²) scan is gone.
//     A uniform grid broadphase (cell = the max pair distance, rebuilt
//     per substep — n Map inserts) checks only same-cell + half-neighbor
//     cells; each pair is visited at most once. This is the same grid
//     broadphase Matter.js/planck use internally, hand-rolled dependency-
//     free (~40 lines) — the world now scales to hundreds of chatbots at
//     flat per-step cost. “Pairwise O(n²) is fine for n < ~50” is retired.
//   • v0.94.4 F3: TIME-SCALED INTEGRATION — step(dtFrames) normalizes
//     friction AND position advance to real elapsed time (substeps of ≤1
//     frame so fast entities can't tunnel). At 60Hz the math is byte-
//     identical to the old fixed-frame step; on a throttled/busy phone at
//     30fps the chatbots decelerate at the SAME rate instead of twice as
//     fast (the old “the world literally gets heavier the longer it
//     runs” — F3 in the perf audit).
//   • v0.94.4 F2: THE SPATIAL HASH — the pairwise O(n²) scan is gone.
//     A uniform grid broadphase (cell = the max pair distance, rebuilt
//     per substep — n Map inserts) checks only same-cell + half-neighbor
//     cells; each pair is visited at most once. This is the same grid
//     broadphase Matter.js/planck use internally, hand-rolled dependency-
//     free (~40 lines) — the world now scales to hundreds of chatbots at
//     flat per-step cost. “Pairwise O(n²) is fine for n < ~50” is retired.
//   • v0.94.4 F3: TIME-SCALED INTEGRATION — step(dtFrames) normalizes
//     friction AND position advance to real elapsed time (substeps of ≤1
//     frame so fast entities can't tunnel). At 60Hz the math is byte-
//     identical to the old fixed-frame step; on a throttled/busy phone at
//     30fps the chatbots decelerate at the SAME rate instead of twice as
//     fast (the old “the world literally gets heavier the longer it
//     runs” — F3 in the perf audit).
//   • Collisions are circle-circle, equal-mass elastic. When one entity
//     is being dragged (dragging=true), it's treated as infinite mass —
//     it doesn't move from physics, and other entities bounce off it.
//   • v0.90.1 THE BOUNCE: the impact boost is VELOCITY-PROPORTIONAL ("an
//     exponential curve out that varies depending on impact velocity") —
//     the injected separation speed scales with the closing speed
//     (momentum), clamped so every bounce stays inside the group sphere
//     (R0 420 — a full-speed hit separates the pair ~300-450px and they
//     stay grouped). Grouped members collide with EACH OTHER too (v0.89.1's
//     same-group skip is gone — "icons can disturb other icons in the
//     sphere when moved") and grouped members skip FRICTION while
//     _orbit is set (tabgroups.js's steering blend is their damping —
//     friction would bleed the sustained orbit speed to a stop; a
//     released icon regains friction and its flight decays classically).
//   • There are no edge collisions: the canvas is infinite, so chatbots
//     can fly off-screen if flung hard. The user pans to find them.

(function () {
  'use strict';

  // Friction coefficient per 16ms frame. Lower = stops sooner = heavier feel.
  // 0.92 = airy/bouncy feel — icons slide freely after a fling, decelerating
  // gradually like an 8-ball on felt. Combined with the velocity cap in app.js,
  // flings travel a satisfying distance without flying off-screen.
  const FRICTION = 0.92;

  // Below this speed (px/frame), snap to zero. Prevents perpetual
  // micro-jitter from accumulated floating-point error.
  const MIN_VEL = 0.05;

  // Restitution (bounciness) for collisions. 1.0 = perfectly elastic
  // (no energy lost), 0.0 = perfectly inelastic (stick together).
  // 0.98 = near-perfectly elastic — chats bounce off each other like
  // 8-balls on a pool table, retaining almost all impact energy.
  const RESTITUTION = 0.98;

  // Impact boost: extra velocity injected into the separation on
  // collision, on top of the elastic exchange. v0.90.1: VELOCITY-
  // PROPORTIONAL — the harder the hit, the harder the bounce (momentum
  // feel). Clamps keep every bounce INSIDE the group sphere (R0 420:
  // a full-speed free-free hit separates the pair ~300-450px — "3-4× the
  // old visual scale" — and they stay grouped; the orbit blend's k 2.5/s
  // is the exponential curve-out, τ≈0.4s).
  const BOOST_K = 0.7;        // free-free: separation ≈ 0.7× closing speed each
  const BOOST_MIN = 1.5;
  const BOOST_MAX = 14;
  const DRAG_BOOST_K = 0.85;   // dragged plow: the finger's speed along the normal
  const DRAG_BOOST_MIN = 2;
  const DRAG_BOOST_MAX = 16;

  // An Entity is anything that has a position, velocity, and radius.
  // Chatbot extends this (see chatbot.js).
  class Entity {
    constructor({ id, x, y, radius = 28, mass = 1 }) {
      this.id = id;
      this.x = x;          // world-space X
      this.y = y;          // world-space Y
      this.vx = 0;         // world-space velocity X (px / 16ms frame)
      this.vy = 0;
      this.radius = radius;
      this.mass = mass;
      this.dragging = false;  // when true: physics skips integration +
                              // collision response treats this entity
                              // as infinite mass
    }
  }

  // The World owns all entities and steps the simulation one frame at a
  // time. Pairwise O(n²) collision check is fine for n < ~50 chatbots;
  // for larger worlds, swap in a spatial hash later.
  class World {
    constructor() {
      this.entities = [];
      // v0.88.2: THE CONTACT TAP — after each step, every pair that
      // touched this frame is reported once ({a, b, x, y} — the contact
      // midpoint). app.js wires this into TabGroups.collide (the web-tab
      // collision dots). Null = nobody's listening (zero overhead).
      this.onContacts = null;
      this._contacts = [];
      // v0.94.4 F2: the spatial hash (rebuilt per substep — entities
      // move every frame; a persistent grid's update cost exceeds the
      // rebuild for n ≤ a few thousand).
      this._grid = new Map();
      // v1.42.2 THE FIELD (PLAN-V142 §3.0 — the sleep law): the SLEEPER
      // grid. At-rest entities (vx=vy=0, no drag, no orbit) can neither
      // move nor initiate a collision — they bin into a STATIC grid that
      // rebuilds only when the sleeper set changes (a wake/sleep
      // transition or a position correction). A fully-resting world
      // costs O(1) per step; a fling costs O(awake + sleepers-near-the-
      // fling), never O(world). The old path binned EVERY entity on
      // EVERY substep — a 500-icon resting world paid 500 Map inserts +
      // the broadphase walk per 33ms ambient frame, forever (the H4/H5
      // install-age shape: cost scaled with how much the user ever
      // placed, not with what was happening).
      this._staticGrid = new Map();
      this._staticDirty = true;   // first step builds it
      this._staticCell = 0;
    }

    add(e) { this.entities.push(e); }

    remove(id) {
      const i = this.entities.findIndex(e => e.id === id);
      if (i !== -1) this.entities.splice(i, 1);
    }

    get(id) { return this.entities.find(e => e.id === id); }

    // Step the simulation. dtF = elapsed time in 16.667ms frames
    // (default 1 = the classic fixed-frame step, byte-identical math).
    // Internally substeps in <=1-frame slices (no tunneling: a fast
    // entity never advances more than one frame's travel between
    // collision checks).
    //   1) Integrate motion + apply friction (skip dragged entities).
    //   2) Grid-broadphase circle-circle collision detection + response.
    step(dtF) {
      if (!dtF || dtF <= 0 || !isFinite(dtF)) dtF = 1;
      if (dtF > 3) dtF = 3;             // a stalled tab resumes gently
      var remaining = dtF;
      while (remaining > 0.001) {
        var slice = remaining > 1 ? 1 : remaining;
        this._substep(slice);
        remaining -= slice;
      }
    }

    _substep(dt) {
      const ents = this.entities;

      // -- 1) Integration + the sleep ledger -------------------------
      // v0.90.1: grouped members (e._orbit) skip friction -- their damping
      // is the orbit steering's exponential blend (a sustained orbit
      // speed must not decay); MIN_VEL zeroing would stall slow orbits.
      // v0.94.4 F3: friction + travel scale by the real elapsed time.
      // v1.42.2: the pass also settles ASLEEP flags — an entity is asleep
      // iff it is at exact rest (vx=vy=0), not dragged, not orbiting.
      // Transitions dirty the static grid (rebuilt lazily below).
      const fr = dt === 1 ? FRICTION : Math.pow(FRICTION, dt);
      let anyAwake = false;
      for (let ei = 0; ei < ents.length; ei++) {
        const e = ents[ei];
        // v1.42.2: the STILL-ASLEEP FAST PATH — a sleeper whose rest is
        // unchanged (no drag, no orbit, exact-zero velocity) has nothing
        // to integrate. This one compound check is the whole per-sleeper
        // cost of a resting frame (~4 reads + a branch); external writes
        // (an app nudge setting vx) fall through to the full path and
        // re-derive asleep honestly — the fast path is SAFE by
        // re-verification, not by trust.
        if (e._asleep && e.vx === 0 && e.vy === 0 && !e.dragging && !e._orbit) continue;
        if (e.dragging) {
          anyAwake = true;
          if (e._asleep) { e._asleep = false; this._staticDirty = true; }
          continue;
        }
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (!e._orbit) {
          e.vx *= fr;
          e.vy *= fr;
          if (Math.abs(e.vx) < MIN_VEL && Math.abs(e.vy) < MIN_VEL) {
            e.vx = 0; e.vy = 0;
          }
        }
        const asleep = !e._orbit && e.vx === 0 && e.vy === 0;
        if (asleep !== e._asleep) {
          e._asleep = asleep;
          this._staticDirty = true;
        }
        if (!asleep) anyAwake = true;
      }

      // v1.42.2 THE SLEEP LAW, the O(1) case: nothing awake means
      // nothing can move and no pair can be approached — the broadphase
      // (and its hash rebuild) is skipped entirely. A resting world of
      // any size steps for free.
      if (!anyAwake) {
        this.fireContacts();
        return;
      }

      // -- 2) THE TWO-TIER BROADPHASE (v1.42.2 THE FIELD) ------------
      // Fine grid: AWAKE entities only (rebuilt per substep — they can
      // move). Static grid: sleepers (rebuilt only when dirty). Cell =
      // the max pair distance (2x max radius, min 64).
      const n = ents.length;
      let maxR = 0;
      for (let i = 0; i < n; i++) if (ents[i].radius > maxR) maxR = ents[i].radius;
      const cell = Math.max(64, maxR * 2);

      const grid = this._grid;
      grid.clear();
      let awakeN = 0;
      for (let i = 0; i < n; i++) {
        const e = ents[i];
        if (e._asleep && !e.dragging) continue;   // sleepers ride the static grid
        e._gi = awakeN++;                         // own-bin pair ordering
        // integer merge key -- a hash collision only adds a harmless
        // extra check (the pair test verifies the real distance)
        const k = ((e.x / cell) | 0) * 46341 + ((e.y / cell) | 0);
        let bin = grid.get(k);
        if (!bin) { bin = []; grid.set(k, bin); }
        bin.push(e);
      }

      this._ensureStaticGrid(cell);
      const sgrid = this._staticGrid;

      for (let i = 0; i < n; i++) {
        const a = ents[i];
        if (a._asleep && !a.dragging) continue;   // sleepers never initiate
        const cx = (a.x / cell) | 0, cy = (a.y / cell) | 0;
        // awake-vs-awake: the half-neighborhood walk (each pair once)
        this._collideBin(a, grid.get(cx * 46341 + cy), true);
        this._collideBin(a, grid.get((cx + 1) * 46341 + cy), false);
        this._collideBin(a, grid.get((cx - 1) * 46341 + (cy + 1)), false);
        this._collideBin(a, grid.get(cx * 46341 + (cy + 1)), false);
        this._collideBin(a, grid.get((cx + 1) * 46341 + (cy + 1)), false);
        // awake-vs-sleeper: the static grid's same neighborhood (a is
        // never in it — the b !== a guard is structural, kept for
        // symmetry). A hit can wake the sleeper (impulse) or shove it
        // (position correction) — both dirty the static grid.
        this._collideBin(a, sgrid.get(cx * 46341 + cy), false);
        this._collideBin(a, sgrid.get((cx + 1) * 46341 + cy), false);
        this._collideBin(a, sgrid.get((cx - 1) * 46341 + (cy + 1)), false);
        this._collideBin(a, sgrid.get(cx * 46341 + (cy + 1)), false);
        this._collideBin(a, sgrid.get((cx + 1) * 46341 + (cy + 1)), false);
      }
      this.fireContacts();
    }

    // _ensureStaticGrid rebuilds the sleeper grid when (and only when)
    // the sleeper set or its positions changed (the dirty flag). Cost:
    // O(sleepers), paid on transitions — never per frame in a world at
    // rest.
    _ensureStaticGrid(cell) {
      if (!this._staticDirty && this._staticGrid && this._staticCell === cell) return;
      const g = this._staticGrid;
      g.clear();
      for (const e of this.entities) {
        if (!e._asleep || e.dragging) continue;
        const k = ((e.x / cell) | 0) * 46341 + ((e.y / cell) | 0);
        let bin = g.get(k);
        if (!bin) { bin = []; g.set(k, bin); }
        bin.push(e);
      }
      this._staticDirty = false;
      this._staticCell = cell;
    }

    // check entity a against a bin's members. sameBin = only entries
    // AFTER a (each own-bin pair is visited exactly once, i<j order --
    // identical to the retired pairwise loop).
    _collideBin(a, bin, sameBin) {
      if (!bin) return;
      const lim = bin.length;
      for (let k = 0; k < lim; k++) {
        const b = bin[k];
        if (sameBin ? (b === a || b._gi <= a._gi) : b === a) continue;
        this._collidePair(a, b);
      }
    }

    // one circle-circle pair: detection + contact report + response.
    // (the exact v0.90.1 math, verbatim)
    _collidePair(a, b) {
          const dx = b.x - a.x;          // vector from a -> b
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy;
          const minDist = a.radius + b.radius;
          if (distSq >= minDist * minDist) return;  // not touching

          const dist = Math.sqrt(distSq);
          let nx, ny;                    // unit normal from a -> b
          if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; }
          else { nx = 1; ny = 0; }       // perfectly overlapping -- pick arbitrary
          const overlap = minDist - dist;

          // v0.88.2: report the contact (both entities touched this
          // frame — the collision-dot formation listens for web-tab
          // pairs). v0.90.1: the same-group skip is GONE — members
          // collide with and disturb each other (the orbit no longer
          // owns positions; physics does, and the steering re-settles
          // whatever the bounce disturbs).
          if (this.onContacts) {
            this._contacts.push({ a: a, b: b, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          }

          // ── Position correction ──────────────────────────────
          // Push entities apart so they're just touching. If one is
          // being dragged (infinite mass), only the other moves.
          // Otherwise split the overlap 50/50.
          // v1.42.2: a SLEEPER that is shoved (position-corrected)
          // marks the static grid dirty — its binned position is stale.
          if (a.dragging && !b.dragging) {
            b.x += nx * overlap;
            b.y += ny * overlap;
            if (b._asleep) this._staticDirty = true;
          } else if (b.dragging && !a.dragging) {
            a.x -= nx * overlap;
            a.y -= ny * overlap;
            if (a._asleep) this._staticDirty = true;
          } else if (!a.dragging && !b.dragging) {
            a.x -= nx * overlap * 0.5;
            a.y -= ny * overlap * 0.5;
            b.x += nx * overlap * 0.5;
            b.y += ny * overlap * 0.5;
            if (a._asleep || b._asleep) this._staticDirty = true;
          }
          // (both dragging = rare; leave them overlapping rather than
          // fighting the cursor)

          // ── Velocity response ────────────────────────────────
          // The elastic exchange + the velocity-proportional boost
          // together make collisions feel weighty — the target gets
          // visibly "swung" away with real momentum.
          if (a.dragging && !b.dragging) {
            // a = infinite mass, b reflects off it. n points from a → b.
            // b's velocity along n: vbn. If vbn < 0, b is moving toward
            // a (against the a→b direction) — reflect that component.
            const vbn = b.vx * nx + b.vy * ny;
            if (vbn < 0) {
              b.vx -= (1 + RESTITUTION) * vbn * nx;
              b.vy -= (1 + RESTITUTION) * vbn * ny;
            }
            // v0.90.1: the boost scales with the FINGER's plow speed
            // along the normal (a.vx/vy carries the live drag velocity
            // — app.js wires it) — "varies depending on impact velocity".
            const impact = Math.max(0, a.vx * nx + a.vy * ny);
            const boost = Math.min(DRAG_BOOST_MAX,
              Math.max(DRAG_BOOST_MIN, impact * DRAG_BOOST_K));
            b.vx += nx * boost;
            b.vy += ny * boost;
          } else if (b.dragging && !a.dragging) {
            // b = infinite mass, a reflects off it. n points from a → b.
            // a's velocity along n: van. If van > 0, a is moving toward
            // b (along the a→b direction) — reflect.
            const van = a.vx * nx + a.vy * ny;
            if (van > 0) {
              a.vx -= (1 + RESTITUTION) * van * nx;
              a.vy -= (1 + RESTITUTION) * van * ny;
            }
            // v0.90.1: velocity-proportional (b's plow speed toward a).
            const impact = Math.max(0, -(b.vx * nx + b.vy * ny));
            const boost = Math.min(DRAG_BOOST_MAX,
              Math.max(DRAG_BOOST_MIN, impact * DRAG_BOOST_K));
            a.vx -= nx * boost;
            a.vy -= ny * boost;
          } else if (!a.dragging && !b.dragging) {
            // Both free — equal-mass elastic collision along the normal.
            // Exchange normal components, scaled by restitution.
            // Only respond if they're approaching (van > vbn means a is
            // moving toward b faster than b is moving away).
            const van = a.vx * nx + a.vy * ny;
            const vbn = b.vx * nx + b.vy * ny;
            if (van - vbn > 0) {
              // 1D elastic collision with restitution, equal mass:
              //   van' = ((1-e)*van + (1+e)*vbn) / 2
              //   vbn' = ((1+e)*van + (1-e)*vbn) / 2
              // At e=1: van'=vbn, vbn'=van (pure exchange). ✓
              // At e=0: van'=vbn'=(van+vbn)/2 (stick). ✓
              const new_van = ((1 - RESTITUTION) * van + (1 + RESTITUTION) * vbn) / 2;
              const new_vbn = ((1 + RESTITUTION) * van + (1 - RESTITUTION) * vbn) / 2;
              a.vx += (new_van - van) * nx;
              a.vy += (new_van - van) * ny;
              b.vx += (new_vbn - vbn) * nx;
              b.vy += (new_vbn - vbn) * ny;
              // v0.90.1: the boost scales with the APPROACH speed
              // (momentum) — "an exponential curve out that varies
              // depending on impact velocity". No saturation at 5 —
              // the clamp keeps a hard fling inside the world scale.
              const approach = van - vbn;
              const boost = Math.min(BOOST_MAX, Math.max(BOOST_MIN, approach * BOOST_K));
              b.vx += nx * boost;
              b.vy += ny * boost;
              a.vx -= nx * boost;
              a.vy -= ny * boost;
            }
          }
    }

    // v0.88.2: THE CONTACT TAP fires (once per substep, all of this
    // frame's touches) — the collision dots form from these.
    fireContacts() {
      if (this.onContacts && this._contacts.length) {
        try { this.onContacts(this._contacts); } catch (e) { /* a bad listener never breaks physics */ }
        this._contacts.length = 0;
      }
    }
  }

  window.Physics = { Entity, World, FRICTION, MIN_VEL, RESTITUTION,
                     BOOST_K, BOOST_MIN, BOOST_MAX,
                     DRAG_BOOST_K, DRAG_BOOST_MIN, DRAG_BOOST_MAX };
})();
