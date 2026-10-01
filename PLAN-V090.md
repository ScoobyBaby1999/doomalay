# PLAN-V090 — THE ATOM SPHERE WAVE (the icon collision system rework)

The user's 6 points, verbatim intent:
1. **ANY two icons** start the orbit + a communication layer (not just tabs); for now
   the tab functionality alone (two tabs in the same orbit = grouped, no constant
   refresh) — "Ext..." (future).
2. Collisions **bounce with physics + momentum** (no snapping to place), an
   **exponential curve-out that varies with impact velocity** — a bouncier feel.
3. **Free orbits**: no fixed orbital grids — one large sphere/circle where any icon
   inside orbits **from the position it is in**; directions spread **even** — an
   atom without fixed orbits.
4. The collision mark = a **larger dot/star themed like the canvas center marker**
   (by default) at the impact point — the **center of the orbit**. Currently
   ~invisible (vr 4.2–6.9px) or not rendering.
5. The orbit is **WAAAY too small** — collision/bounce distance ~**3–4x** current;
   keep the pull-follow; **many icons** disturb each other; enough collective
   motion in one direction moves the star — **weightier**.
6. **Render the sphere** the star produces: fog/cloud/nebula/gas with a
   gaussian-filter feel, **responds to the amplify parallax** to resemble a
   sphere; ~**6–8x** current size, **grows with each icon**; the star grows too.

## THE CRUX — the architecture change

v0.89.1's model: the orbit OWNS member positions (polar write per frame,
same-group collisions skipped, velocities zeroed on formation = the sticky
cluster). That model cannot bounce, cannot propagate disturbances, and cannot
follow weightily — positions are overwritten.

**v0.90 model: PHYSICS OWNS POSITIONS; THE ORBIT IS A VELOCITY FIELD.**
- Members keep real velocities (bounces, flings, drags — all physics.js).
- `TabGroups.step` steers: blend each member's velocity toward the circular
  orbit velocity at its CURRENT radius (per-icon direction ±, ω(r) faster near
  the star), plus soft radial containment (spring-in past 0.82R, star-clearance
  push-out at the core). The exponential blend **is** the curve-out.
- Members **skip physics friction** while grouped (the blend is the damping —
  no steady-state speed loss; a released/flung member regains friction and its
  flight decays classically).
- The star: a **critically-damped spring** chasing the member centroid
  (dragged member weighted 3x — the pull-follow EMERGES: drag to rim →
  centroid shifts → star follows → containment drags the rest). Stiffness
  falls with member count → "weightier" as the group grows.

Paint model (point 4/6 — the star now MOVES per frame):
- The star + the sphere paint on **#c2** (the per-frame atoms layer, z 150) —
  REMOVED from lattice.js/#c1 (full frames only). The sphere = a
  **pre-rendered half-res sprite** (limb-bright gas shell + core glow + 5–8
  wisps, multi-stop radial gradients, one-time render per size/color/seed
  bucket, LRU ≤ 6 — MDN's discipline; per-frame ctx.filter is forbidden —
  live-confirmed 1fps class), blitted per frame with slow churn rotation + a
  parallax **highlight blob** (lit limb faces the screen center; strength ∝
  the Amplify-parallax slider) + breathing star pulse.
- Dual-environment: the painter lives in **atoms.js** (AtomCore — the worker
  imports it; the main thread paints the same function — zero drift).

## Phases (each ships + red-teams on its own tag)

### v0.90.1 — THE BOUNCE + THE STEERING ORBITS
Files: `physics.js`, `tabgroups.js` (rewrite), `atoms.js` (paintDots core),
`lattice.js` (remove the c1 dot+ring paint), `gridworker.js` (dots on c2 in
both frame types), `app.js` (wiring + the `moving` classification fix),
`scripts/v0901-sphere-physics-test.sh` (new), `scripts/v0882-…` (re-pin).
- physics.js: (a) sameGroup skip REMOVED (members collide + disturb each
  other); (b) `_orbit` members skip friction + MIN_VEL zeroing; (c) the
  impact boost becomes **velocity-proportional**: free-free
  `boost = clamp(approach·1.9, 3, 26)`, drag-case `clamp(dragSpeedN·1.4, 4, 30)`
  (the old constant 17.5); restitution 0.98 stays.
- tabgroups.js rewrite: R0 130→**420**, R_MAX 340→**1500**, R_GROW 40→**100**,
  passive 12→**40**, LEAVE_SLACK 20→**110**; star vr base 4.2→**11** (+1.7 per
  member, cap 34, pulse ±6%); formation at the contact midpoint (BOTH icons)
  with NO velocity zeroing; steering (k_blend 2.5/s, ω(r) 0.010–0.060 rad/s,
  containment 0.82R / core clearance vr+icon.radius+26); per-member state =
  hash(joinIndex parity → direction, seed → tilt/phase0 for the depth cue);
  the star's critically-damped spring (K = 30/(1+0.35·(n−1)), ζ=1, centroid
  with drag weight 3x); serialize v2 (ids only) + v1 compat (reads ids).
- atoms.js: `AtomCore.paintDots(ctx, W, H, ox, oy, scale, dots, colors, t)` —
  the star (originColor-family fill + accent glow halo) — colors payload gains
  `origin` (resolved main-side like lattice's fallback).
- app.js: moving-loop skips `_orbit` members (orbital drift is ambient —
  the atomsOnly cheap frame + members' render covers it); dotsFor payload
  gains {n, seed}; contact filter unchanged for now (v0.90.3 opens it).
- Gates (v0901): bounce separation ≈ 3–4x the old sticky zero (≥300px on a
  mid drag, stays grouped); orbit holds after 10s (no release, r stable ±35%);
  disturbance propagates member→member; drag-follow moves the star + rest;
  collective push moves the star slower than members (weighty) then settles;
  fling past R+slack releases; persistence reload; keep-alive intact; zero
  console errors. v0882 re-pinned to the new contract (bounce replaces
  absorb; chat-joins replaces chat-never in v0903).

### v0.90.2 — THE NEBULA SPHERE
Files: `atoms.js` (sprite renderer + paintDots extension), `app.js` (parallax
feed into the frame payload — the screen-center/star delta + spaceParallax),
`scripts/v0902-nebula-sphere-test.sh`.
- The sprite: half-res (768px) offscreen canvas per (radius bucket 160px,
  colorKey, seed bucket 4) — limb-bright shell (dense rim, hollow core),
  inner core glow, 5–8 seeded wisp blobs (radial gradients, `lighter`), drawn
  at `R·scale·2.2` diameter (cap 3000px), slow churn (±0.02–0.05 rad/s), the
  highlight blob offset toward the screen center ∝ (0.12 + 0.5·parallax/100).
- Growth: `Rv` (visual radius) eases to R exponentially (τ 0.8s — the bloom).
- Theme: originColor family + accent tint only (zero hardcoded colors).
- Gates: pixels present on c2 in the sphere area; limb brighter than core
  direction (asymmetric at parallax>0, symmetric at 0); sprite cache ≤6 with
  no growth; joiner grows R + vr; theme switch re-renders (colorKey); zero
  errors; frame budget: atomsOnly frames stay cheap (DoomalayPerf counts).

### v0.90.3 — ANY-ICON ORBITS (the communication layer's scope)
Files: `tabgroups.js` (filter removal + serialize v2 final), `app.js`
(onContacts filter), `scripts/v0903-any-icon-orbits-test.sh`, v0882 final
re-pin.
- Any two icons form/join (chat+chat, chat+web, web+web); passive capture
  any type; keep-alive stays TAB-scoped (webpanel isProtected untouched).
- Old v1 saves load (members by id; r/phi/ax ignored gracefully).
- Gates: chat pair forms + orbits (nested with their atom stars); mixed
  group; a chat member never protects an iframe (LRU unchanged); reload
  restores mixed groups; zero errors.

### v0.90.0 — WAVE SHIP
`buildinfo.go` version 0.90.0, tag `v0.90.0-the-atom-sphere-wave`, release
polish (APK from CI), the full-suite sweep (v0901/2/3 + v0783 + theme twins +
uikit + v31), tunnel verification when up.

## NOT-doing (anti-spaghetti)
- No pixi/World3D sphere twin (c2 stays visible at z150 above #c3 — the
  sphere paints there even in world-layer mode; a GL-native sphere can ride
  a later wave if the user asks).
- No new UI surfaces (canvas-native feature).
- No keep-alive changes for chats; no settings UI additions.
- No orbit color/theming knobs in settings (rides originColor + accent).
