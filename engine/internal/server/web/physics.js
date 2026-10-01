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
    }

    add(e) { this.entities.push(e); }

    remove(id) {
      const i = this.entities.findIndex(e => e.id === id);
      if (i !== -1) this.entities.splice(i, 1);
    }

    get(id) { return this.entities.find(e => e.id === id); }

    // Step the simulation by one frame.
    // 1) Integrate motion + apply friction (skip dragged entities).
    // 2) Pairwise circle-circle collision detection + response.
    step() {
      const ents = this.entities;

      // ── 1) Integration ────────────────────────────────────────
      // v0.90.1: grouped members (e._orbit) skip friction — their damping
      // is the orbit steering's exponential blend (a sustained orbit
      // speed must not decay); MIN_VEL zeroing would stall slow orbits.
      for (const e of ents) {
        if (e.dragging) continue;
        e.x += e.vx;
        e.y += e.vy;
        if (!e._orbit) {
          e.vx *= FRICTION;
          e.vy *= FRICTION;
          if (Math.abs(e.vx) < MIN_VEL && Math.abs(e.vy) < MIN_VEL) {
            e.vx = 0; e.vy = 0;
          }
        }
      }

      // ── 2) Pairwise collisions ────────────────────────────────
      const n = ents.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = ents[i];
          const b = ents[j];
          const dx = b.x - a.x;          // vector from a → b
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy;
          const minDist = a.radius + b.radius;
          if (distSq >= minDist * minDist) continue;  // not touching

          const dist = Math.sqrt(distSq);
          let nx, ny;                    // unit normal from a → b
          if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; }
          else { nx = 1; ny = 0; }       // perfectly overlapping — pick arbitrary
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
          if (a.dragging && !b.dragging) {
            b.x += nx * overlap;
            b.y += ny * overlap;
          } else if (b.dragging && !a.dragging) {
            a.x -= nx * overlap;
            a.y -= ny * overlap;
          } else if (!a.dragging && !b.dragging) {
            a.x -= nx * overlap * 0.5;
            a.y -= ny * overlap * 0.5;
            b.x += nx * overlap * 0.5;
            b.y += ny * overlap * 0.5;
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
      }

      // v0.88.2: THE CONTACT TAP fires (once per step, all of this
      // frame's touches) — the collision dots form from these.
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
