# PLAN-V103 — THE EDITOR & THE PROJECTION

The user's 4-point order (after v1.02.0-the-library), delivered as the v1.03 wave.
Methodology honored: recon (v103-recon) → web research (v103-research-A/B, evidence in
/home/z/my-project/tool-results/v103-research/) → this plan → phased build → rigs per phase.

## THE FOUR POINTS (verbatim intent)

1. **Surface de-tiling** — nested elements (+model/+sandbox gatelocks, chat metadata,
   panel headers, the card family) must stop riding the surface field (they tile
   surface-on-surface). Fix: a NEW derived card color + reassignment. OR the doom
   projection (point 2) makes same-variable elements render one shared field.
   → WE SHIP BOTH: card treatment as the default look, doom projection as the toggle.
2. **Doom Projection re-introduced** — recoverable from 1fb19f7e for reference, but the
   v1.01.5 diagnosis stands (fixed-attachment = the transformed-ancestor split +
   Chromium's full-re-raster slow path). v2 = the research-validated **2D canvas field
   projector** (BUILD-HOMEGROWN verdict; element()/fixed/Houdini/WebGL-2nd-context all
   REJECTED with source evidence). Render the 4-5 gradient fields ONCE as offscreen
   bitmaps; project them into consumer rects viewport-anchored; compositor-cheap;
   a toggleable switch in the Colors tab.
3. **Text style promotion** — from a nested row inside "The Fields · <theme>" to its own
   collapsible header row placed directly under that section (expands the scheme
   swatches + the 5 fmt stops + reset).
4. **THE THEME EDITOR** — a reusable PANEL PAGE that opens when any color is pressed.
   Fixed layout, dynamic content. Spec:
   - Row 1 (2 cols): variable name | "Expand all tagged elements" pill → Overlay list
     of every element using that color (the census as a runtime registry).
   - Row 2 (wide): the colors banner (the live gradient/color preview).
   - Rows 3-4 (2 half rows, FIXED): the gradient stops, cap 6 (was 15); a small +
     next to the last stop; small polished shuffle + random pills; the selected stop
     carries a tiny × (remove, min 2).
   - LEFT col: the type pills — linear, radial, mesh, pinstripe, checker, texture/image
     — LOCKED where the variable can't hold them (ink: all locked; DOM fields: mesh
     unlocked via the stack recipe, pinstripe/checker/texture canvas-locked; canvas:
     all unlocked; fmt stops: all locked) + the ANGLE slider below, continuous 0-360,
     affecting EVERY type (linear native angle; radial = focal orbit; mesh = spot
     rotation; canvas patterns = setTransform rotation; texture = same).
   - RIGHT col: a large hex color WHEEL (homegrown canvas — research verdict: no
     maintained MIT wheel lib exists; iro.js=MPL-2.0, farbtastic=GPL, reinvented=WTFPL)
     + slim H/S/V/A sliders (native range over CSS-gradient tracks) + two half rows:
     common colors (curated ~18) | last used (max 7, dedup, most-recent-first,
     localStorage).
   - It REPLACES the floating picker (v0.99.6) entirely. The canvas field keeps its
     extras (grid children + MCU suggester) as full-width sections below.
   - HSV math via the already-vendored culori 4.x (research-verified API).

## THE PHASES

### v1.03.1 — THE CARD
- `--card` = derived flat solid: color-mix(in oklab, var(--field-surface), var(--field-ink) ~9%)
  (+ `--card-rgb` triplet for tints). NO gradient twin — a card can never tile. Calibrate
  the % across the 10 themes (culori least-squares vs. the old surface-3 target — the
  v0.99 calibration script pattern).
- Reassign the nested tiling offenders:
  gatelock boxes (chatpanel renderGatelock), panel headers (.settings-section h3,
  #chat-header, .pub-head-bar — bg-app-gradient → card), the Layer-2 card family
  (.settings-section, .hub-card, .pv-row, .msg-assistant, .ts-row, .starter-chip,
  .fmt-codecard, .gr-editor internals, .slot-row), .src-wrap/.hub-wrap plates,
  pixiworld's name-pill raster + sandbox badge (flat tints, no local gradient tile),
  the Overlay's content boxes (the big overlay card keeps the surface field — the
  user sanctioned that).
- Chat metadata pills stay accent-tint (already correct post-v1.01.5).
- RIG v1031: computed-style audit (nested boxes have NO gradient background-image),
  contrast pass (text on card), screenshot parity on 3 themes.

### v1.03.2 — THE TEXT-STYLE HEADER
- Colors tab: "The Fields · <theme>" keeps 6 rows; "Text style" becomes a collapsible
  SECTION-HEADER row directly beneath it (the accordion pattern, ≤2-open cap, cv:hidden
  collapse), expanding: scheme swatches + 5 fmt stop rows + reset chat colors.
- The fmt stop rows keep their current editing path until v1.03.3 wires them to the editor.
- RIG v1032: structure (the header exists as a sibling section row), expand/collapse,
  accordion cap, fmt writes still land, zero longtasks.

### v1.03.3 — THE EDITOR SCAFFOLD + THE TAGGED REGISTRY
- New module `engine/internal/server/web/themeeditor.js` → `window.ThemeEditor.open(target)`
  (target: {kind:'field',field} | {kind:'fmt',stop} | {kind:'stop'}). Panel.pushView
  page, title "Theme Editor".
- The fixed layout: header row (name + tagged pill), banner, 2 fixed stop rows (cap 6,
  existing >6 specs trim on first write with a toast note), the + affordance, small
  shuffle/random, the × on the selected stop, LEFT type pills (locked states), RIGHT
  placeholder for the wheel (v1.03.4).
- THE TAGGED REGISTRY: slot → [{name, desc}] content derived from
  docs/CENSUS-V099-SLOT-SCAN.md (surface ~14 entries, ink, canvas, accents, fmt stops).
  "Expand all tagged elements" → ConnectOverlay.pushPage(list) — name + desc + live
  swatch; wire as a themed list.
- The Colors tab rows open the Theme Editor (slotPopover stays alive only until
  v1.03.4 removes it — canvas picker extras migrate in v1.03.4).
- RIG v1033: open-from-every-row, structure, tagged overlay open/scroll/close, live
  writes, stop add/remove/shuffle, no longtasks.

### v1.03.4 — THE WHEEL + THE PICKER RETIREMENT
- The wheel: canvas disc, hue-by-angle + saturation-by-radius (atan2 math, research-
  banked), conic-gradient + radial white overlay rendering, the value dimension via
  the V slider (the Photoshop/iro convention), pointer capture + touch-action:none,
  dpr-aware sizing, handle rendering.
- The slim sliders: H (hue ramp track), S, V, A (checkerboard track) — native range
  inputs, styled; culori hsv round-trips.
- Common colors (curated: near-white→black grays + Open Color dark-first set) and
  last used (max 7, localStorage 'doomalay.recentColors', hex-normalized dedup,
  most-recent-first, updated on commit).
- Selected stop ↔ wheel binding (live writes, rAF-coalesced).
- RETIRE the floating picker: slotPopover/openSlotPopover/wireSlotRows-popover-path
  deleted; every data-slot-open → ThemeEditor.open; the canvas extras (grid children,
  MCU suggester) become full-width sections of the canvas editor page.
- Ink + fmt stops: solid mode (wheel only; type pills locked; stop rows single).
- RIG v1034: wheel math probes, culori round-trips, recent persistence/dedup/cap,
  picker-retirement audit (no .slot-pop ever), canvas extras still reachable.

### v1.03.5 — THE TYPES + THE UNIVERSAL ANGLE
- The 6 pills switch specs: linear→'auto' (angle-continuous), radial→'radial',
  mesh→'mesh', pinstripe→'pat-pinstripe', checker→'pat-checker', texture→tex.
  Legacy dirs normalize on open (swirl→radial, pat-navy→pat-pinstripe, pat-gingham/
  pat-sunburst→pat-checker).
- Angle semantics per type (all research-verified feasible):
  linear = native CSS angle; radial = the focal-point orbit (center on the angle ray —
  layerless, no minting); mesh = spot positions rotated around the box center;
  pinstripe/checker/texture = canvas-side pattern setTransform(DOMMatrix rotate) +
  the DOM css() recipes get angle-parameterized where expressible.
- GradientUI.css() rework + the canvas rasterizer's pattern transforms.
- RIG v1035: every type's visual hash changes with angle; spec round-trips; v2
  bundles with angled specs load; parity vs the old angle behavior for linear.

### v1.03.6 — THE DOOM PROJECTION v2 (the 2D canvas field projector)
- New module `engine/internal/server/web/doomprojection.js` (the name returns; the
  compat stub retires).
- ONE fixed fullscreen `<canvas #doom-proj>` (pointer-events:none, z above the
  lattice/pixi canvases, below UI DOM; dpr≤2; no willReadFrequently).
- Fields rasterized ONCE per theme change: surface + accent-1/2/3 (4 opaque offscreen
  bitmaps; the canvas field lives on the body already — one field at root, nothing to
  project). Solid slots = no-op.
- Discovery: the DoomGates-style stylesheet crawl for `var(--field-*-gradient)`
  consumers → SEL; toggle ON mints an override sheet (`html[data-doom-proj] …` →
  gradient consumers transparent so the canvas shows through); OFF removes it and
  hides the canvas (pixel-identical restore).
- The loop: dirty-flag driven; rAF-coalesced gBCR reads (transform-only motion keeps
  layout clean — research Q4) → 9-arg drawImage crops, viewport-anchored = one shared
  continuous field. Panel drags, scroller trues, resize, and debounced mutations all
  ride the same discipline (batched reads → one redraw).
- Pixiworld pills stay local (the 56px-invisibility precedent — v0.92.1); documented
  as the v1.04 bridge point.
- THE TOGGLE: a switch row in the Colors tab (top of "The Fields" section), persisted
  in Settings state; solid themes render it inert with a hint.
- RIG v1036: on/off pixel parity at rest; consumers transparent + canvas rect matches
  gBCR; drag with doom on = zero longtasks, ≤17ms frames; theme flip re-rasters;
  scroll/resize true-up; off restores byte-identical styles.

### v1.03.0 — THE WAVE SHIP
- Version bump, full battery (twins 194, uikit 140, go 8 pkgs, v098 21, v099 5/6/6,
  v1000 19, v1015 15, v1016 19, v1017 11, v1031-v1036 new), tag
  `v1.03.0-the-editor` + release (CI: APK + desktop + HF Space), worklog + plans pushed.

## STANDING RULES (unchanged)
- Zero hardcoded colors (the wheel's spectrum + common swatches + theme chips are the
  sanctioned self-colored exceptions — color DATA, not chrome).
- New UI = the panel (the editor page) or the Overlay (the tagged list) only.
- Rebase before every push (the parallel bot may have moved main).
- Rigs run against a fresh `go build -a` binary (the embedded-assets cache landmine).
