# PLAN-V157 — THE BOUNDED FIELD

The user's ask (verbatim): *"The canvas is unfortunately still too large, for this turn. Focus solely on making the canvas a limit manageable size. Currently it's as if it is still infinite. Please let's try to make the canvas limited in size, and let's focus this turn on improving the rending of the canvas or how the canvas is rendered or when the canvas is rendered to improve it's performance by a target of x2. Try to do so without reworking the entire canvas but finding optimisations in our current setup. For something to warrant a rework you must be able to built it in a more effective way without degrading the visuals too much."*

Two deliverables, one wave. No canvas rework — surgical optimizations on the current setup, zero visual degradation.

## THE DIAGNOSIS (code survey, v1.56.1 tree)

**Why the world "still feels infinite"** (v1.42.3 THE EDGE shipped bounds, but):
1. The default world is **65,536 px** (±32,768). At MIN_SCALE 0.125 a phone viewport (~400 CSS px) sees 3,200 px of world — **1/20th of the width**. You can NEVER see the whole world; the edge is a rumor. That is "as if it is still infinite."
2. The smallest dial option is 16k — still 5× wider than the max zoom-out view on a phone.
3. Existing installs carry the old default in localStorage; a default change alone never reaches them.

**Where the render time actually goes** (the already-optimized tree: tile-baked lattice pattern fills, 30fps ambient gate, atom-only rest frames, O(visible) culling, sleep-ledger physics, rAF input coalescing):
1. **THE ICON LAYER is the last O(visible-N) per-frame cost.** Every camera frame (pan/momentum/glide/pinch/drag) rewrites `style.transform` on EVERY in-view icon (`renderIconsCulled` → `GridIcon.render` bakes the camera into each icon's translate3d+scale string). A 60-icon world at 60fps = 3,600 style writes/sec + the style-recalc on each, forever during motion. The `__lastTf` guard is dead weight during camera motion — every string changes.
2. **DOUBLE PHYSICS + DOUBLE PAINT during input** when ambient animation is on (dotAnimate/lineAnimate default available; atoms; orbits): the ambient `tick()` rAF loop AND the input-coalesced `update()` both run per frame. During PANNING, tick correctly skips its render — but still runs `world.step(dtF)` while `update()` runs `world.step()` too (double integration). During ICON_DRAG with movers, tick renders a full frame AND update renders a full frame (double paint) + double step.
3. The lattice itself is already pattern fills (~10-40 fillRects) — NOT the bottleneck.

## THE RESEARCH (web agent, sourced — receipts in the wave commit)

- **R1 THE CONTAINER RIDE** (React Flow's production pattern, `.react-flow__viewport`): ONE transform (`translate3d+scale`, `transform-origin: 0 0`) on the parent container moves all children as pixels of one compositor layer — per-child writes during camera motion become unnecessary; transform-only changes never invalidate raster (Chromium cc: "composited effects... are done by modifying the active tree"). Pitfalls audited: fixed-position descendants break inside transformed containers (#chatbots children are `position:absolute` icons only — verified, 3 appendChild sites); hit-testing resolves through transforms natively (Pointer Events §11.2.5); transform-origin must be 0 0.
- **R2 LAYERS**: one viewport-sized compositor layer (~11-21MB at phone dpr) beats N child layers; per-child `will-change` is a last resort (MDN/web.dev). The existing 40-icon child budget law stays (it only matters when icons THEMSELVES move); the container gains `will-change: transform` — one layer, compositor-thread motion.
- **R3 rAF**: Chrome aligns continuous input to rAF (35% less hit-testing) — our coalescer matches the doctrine. Two rAF callbacks in one frame both painting = redundant double work (derived, not spec-named) — the fix is an ownership gate, not a loop rework.
- **R4 ZOOM-TO-FIT** (xyflow `getViewportForBounds`, pixi-viewport `fitWorld`, excalidraw `zoomToFitBounds`, tldraw `fit-max`): the canonical formula is `fit = min((vw−pad)/worldW, (vh−pad)/worldH)`, clamped to a floor. Industry floors: 0.1 (excalidraw MIN_ZOOM, tldraw min step) — but those apps fit CONTENT bounds; our bounded WORLD is fixed-size, so the fit scale is what it is (0.024 on a phone at 16k) and needs its own floor.
- **R5 FAR-FIELD**: at fit scale the lattice spacing (48·gridSize·scale ≈ 1.1px) is sub-pixel mush — the dot sea must gracefully fade below the spacing where it stops reading (a clean "map view": field + icon dots + portal rings + edge lines).

## THE REAL PLAN

### Phase v1.57.1 — THE TRUE BOUNDS (the manageable size)

1. **Default 65,536 → 16,384** (settings.js defaultState). The 7-second traverse becomes a ~1.5s traverse; ~136 icons across at scale 1 — roomy, not endless.
2. **The one-time migration** (the `spaceParallaxV69` precedent): on load, `saved.worldSize === 65536 && !saved.worldSizeV157` → `16384` + flag. An explicitly re-chosen 64k survives forever after. Fresh installs get 16k. Recorded honestly in the OTA notes.
3. **The dial ladder** (appearance.js + app.js applyWorldSize snap array): `8k intimate · 16k cozy (default) · 32k roomy · 64k vast · 128k endless · off infinite` — 8192 joins, nothing is removed, ∞ stays (the dial is the user's, not a wall).
4. **THE ADAPTIVE FIT-ALL MIN ZOOM** (R4): `minScale() = WORLD_SIZE ? clamp(min(W,H)/WORLD_SIZE, 1/64, 0.125) : 0.125`. At max zoom-out the WHOLE world fits the viewport (16k fits on any phone: 390/16384 = 0.0238 > 1/64) — the bounds become VISIBLE, the world reads as a finite plate. Applied at: zoomAt, the pinch clamp, the saved-scale restore clamp (applyWorldState re-clamps after resize), the camera probe (additive: `minScale` becomes the live value). MIN_SCALE stays as the infinite-world floor + the cap of the ladder.
5. **THE FAR-FIELD FADE** (R5, lattice.js): `farK = clamp((spacingNow − 2.5) / 3.5, 0, 1)` where `spacingNow = GRID_BASE·gridSize·scale`. Full (1.0) at ≥6px spacing — exactly today's minimum (48·1·0.125) → **byte-identical at every currently-reachable zoom**; ramps to 0 at ≤2.5px. Multiplies the tile-fill alphas, the full-line pass, the hero fireflies, the breath; skips the fills entirely at 0 (overview frames get CHEAPER). The background field, origin dot, modulation, icons, portals, and edge lines stay — the map view. `stats.oneObject.farK` exposes it (the rig's contract).
6. Edge affordance (the boundary lines) already exists — unchanged.

### Phase v1.57.2 — THE RIDE (the ×2 render)

7. **The container camera** (app.js + index.html + gridicon.js): `#chatbots` carries `transform: translate3d(−ox·s, −oy·s, 0) scale(s)` with `transform-origin: 0 0` + `will-change: transform` — ONE skip-if-identical style write per camera frame (`paintCameraRide()`). Written at the top of `renderIconsCulled` (every full-frame funnel passes there: update, tick, boot via applyWorldState→update) + on ride-mode toggles.
8. **Camera-free icon transforms** (`GridIcon.render` ride branch, mathematically exact — proof in the code comment): plain icons write `translate3d(x, y, 0) translate(−50%,−50%) scale(1)` (never changes during camera motion — the `__lastTf` guard becomes REAL during pans); orbit-scaled members express the screen-relative tilt locally: `px = x·os + ox·(1−os)`, `py = y·os + oy·(1−os) − lift/scale` — container·local ≡ the legacy matrix, term for term (scale·os·(x−ox), scale·os·(y−oy) − lift). Total visual scale = s·os, identical to today. The dragged icon still writes per-frame (it MOVES — the write is genuine).
9. **The kill switch** `window.__doomalayRideOff` (the lattice A/B precedent): flips every icon back to legacy camera-baked renders + clears the container transform + resets `__lastTf`. The rig proves both paths.
10. Culling, hit-testing (math-based `findIconAt` + browser-native DOM hit tests), z-order (the container is already a stacking context), the pixi3d hit-target mode, world switches (`iconLayer.textContent = ''` + applyWorldState→update), and the arrow compass (pure math) — all verified compatible; unchanged.

### Phase v1.57.3 — THE ONE FRAME (the when)

11. **The step dedupe**: in `tick()`, when the input owns the frame (`inputState === 'PANNING'`, or `ICON_DRAG` with a pointermove in the last 48ms), tick skips `world.step(dtF)` — the coalesced `update()` (guaranteed poked by the same input) owns the step. One integration per frame, always. A stationary drag-hold (no recent move) still steps in tick — settling icons never freeze.
12. **The render ownership gate**: tick's render block skips when `ICON_DRAG` has recent input (the PANNING case already skips) — kills the double full-paint during icon drags with ambient on. Rest, momentum, glide, orbits: unchanged (tick is the only painter).
13. `DoomalayPerf` gains the honest instrument: `stepCalls`, `framePaints`, `iconWrites`, `rideWrites` (the rigs' contract; the perf HUD reads them).

### Phase v1.57.4 — THE PROOF (rig + walk + battery + ship)

14. **scripts/v1570-bounded-field-rig.mjs** (the house pattern — real engine, real browser, agent-browser close --all at boot):
    - A-section SIZE: fresh default 16384; the migration (65536→16384 once, re-chosen 64k survives); the 8k rung applies + conform pulls a stranded icon; the adaptive min scale exact at 400×800 (0.0238…) + zoomAt/pinch stop there; the whole world visible at min zoom (edge lines in-viewport); the far-field fade (farK 1.0 at 0.125 — byte-identical stats; farK 0 + zero dot fills at 0.03).
    - B-section RIDE: per-icon gBCR center parity ride-on vs ride-off (≤0.5px, mixed world: plain + pinned + orbit members + a hole); a scripted pan's write census (MutationObserver): ride ON = 0 iconWrites during pan frames + ≥1 rideWrite/frame; ride OFF = iconWrites > 0; the ×2 evidence — mean frame ms + long-frame (>22ms) census over a scripted 2s fling with a 60-icon world, both modes, reported honestly (the write-count is the deterministic proof; the timing is the honest report).
    - C-section CADENCE: with dotAnimate ON + a scripted pan: stepCalls ≤ frames+1 (was ~2× frames); a drag-hold with movers keeps rendering (no freeze); the double-paint gone (framePaints ≤ 1/frame).
    - Zero console errors + the theme pin (no new literals) + B1 (the overlay law — no new UI surfaces needed).
15. **scripts/v1570-bounded-field-walk.mjs** (the real finger): pan edge-to-edge (feel the bounds + the edge lines), pinch out to the map view (the whole world + the fade), zoom back in (the sea returns), drag an icon, long-press an icon, open a chat, switch worlds, zero errors.
16. **The battery**: the full regression suite (v1350, v1400, v1421-v1428 rigs, the census re-anchored if vars change — none planned, discipline, node --check, the go battery, cross-compile). Then rebase + push per phase; the ship lands buildinfo 1.58.0 (read the live buildinfo at ship time — never trust a reservation; renumber past whatever stands).

## THE LAWS THAT BIND THIS WAVE

- Zero visual change at every currently-reachable zoom/state (the fade engages only BELOW today's floor; the ride is matrix-identical — rig-proven).
- Zero hardcoded colors (the fade is alpha math, no color literals; the theme census stays at 142).
- New UI: none needed (the dial edits existing rows only — the Panel/Overlay law untouched).
- No engine/Go changes (the whole wave is web-layer: app.js, gridicon.js, lattice.js, settings.js, appearance.js, index.html) — except the buildinfo bump at ship.
- The user's dial philosophy: ∞ stays available; the migration moves only the never-touched old default, once, honestly recorded.
