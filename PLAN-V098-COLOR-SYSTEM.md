# PLAN-V098-COLOR-SYSTEM — THE FIELD & THE MASKS (the color system rework)

> The user's directive (2026-10-03): "My recommendation… is to scrap the
> whole color system. Scan the entire repo (not in a single turn - we can go
> in batches) find every single thing that uses a color, completely reassign
> what shapes and objects use which colors. And do it all with a plan in
> mind… Our color system has the right idea, we want the user to select an
> image, gradient, solid fill and have every single object in the screen with
> that color variable reflect a projection of that color as if that color
> was the apps background only visible thru the objects that inherit that
> color… Ideally each object in the entire panel should be a swappable image
> that can hold any color, or a gradient."

## WHERE WE STAND (the evidence)

- The concept is RIGHT and the user wants it kept: ONE background-like field
  per color variable, objects are WINDOWS onto it.
- The implementation is three cooperating engines: CSS var twins +
  DoomGates (a runtime CSS compiler deriving window/glyph/plate treatments)
  + DoomProjection (fixed-attachment emulation with L2 compositor layers).
  v0.98 killed the mount stall (POS_SEL sweep, read-phase mints, lazy
  editors — the Colors tab is 289 nodes / 0 longtasks) — the ACUTE pain is
  gone; the CHRONIC complexity remains.
- The v097 audit adjudicated the user's suspicion: objects do NOT render
  every gradient stacked — the visible layer is always the element's own
  slot — but themed boxes paint 5-7-layer stacks whose under-layers (the
  slot solid plate + the border slot's 135° sweep) peek at edges when the
  window math desyncs. THE plate/ring redesign is still open.
- The repo's own 84-source research (RESEARCH-COLOR-REWORK.md) converged:
  stop compiling colors in JavaScript — CSS-native OKLCH + color-mix for
  DOM derivation, the GPU for gradients, culori-class math only where JS
  must know a color (canvas, exports).

## THE NEW DESIGN — "THE FIELD & THE MASKS"

1. **ONE FIELD PER SLOT.** A slot's field (solid | gradient | image) is
   rasterized ONCE per epoch into a field atlas. The slot set SHRINKS from
   10 customizable vars + 5 fmt slots + 3 grid slots to a curated model:
   `--field-surface` (panels/cards), `--field-ink` (text family —
   color-mix derived, never a window), `--field-accent-1..3`,
   `--field-canvas` (the world), `--field-fmt` (chat accents). Fewer,
   composable, honest.
2. **EVERY COLORED OBJECT IS A MASK.** An element that "has" a color shows
   a window onto its slot's field, anchored as if the field were the app
   background. This is the user's projection concept — and the L2 pseudo
   layers are ALREADY that shape. The rework makes them the ONLY path
   (retire the legacy inline bake), and the pseudo's background becomes
   ANY user image (the swappable asset).
3. **SWAPPABLE UI ELEMENTS.** The masks themselves become textures: a
   9-slice asset per element class (pill, bubble, card, input, chip),
   tinted by compositing onto the field. v1: pseudo backgrounds accept
   user images. v2: shape assets (border-image + mask compositing).
4. **THE DELIVERY.** CSS-native derivation for inks/borders (color-mix in
   oklch — zero JS); L2 layers for field windows (transform-carried, no
   re-raster in motion); one atlas per slot (every window shows the SAME
   raster — the "same background" illusion is exact).
5. **THE EDITOR.** One picker per slot (solid / gradient / image tabs with
   live preview). The colors tab becomes a slot list + one picker —
   not 18 editors. Per-drag stays on the diffed-ledger write path.

## THE BATCHED REPO SCAN (the census)

- **Batch 1 (done, v0.98):** the inventory — theme.js (2,611: twins/OKX/
  applyTheme/PROJ+L2/GATES), index.html (5,643: 54 static vars + ~67
  var(--X-gradient) consumers + the inline catchers), uikit.js GradientUI
  (1,628), appearance.js (1,163), formatter.js fmt twins, tweaks.js per-chat
  looks, lookio.js export, the canvas consumers (app/atoms/lattice/
  pixiworld), the adjacents (hubitem/hubpublish/persona/templatesheet/
  webpanel).
- **Batch 2:** the index.html consumer census — every rule consuming
  var(--X)/-gradient/-rgb, classified: mask-candidate / ink / border /
  shadow / already-native. Output: THE SLOT ASSIGNMENT TABLE (which
  elements join which field).
- **Batch 3:** the JS consumers — canvas colors (the lattice spec path),
  chat fmt, hub art, .doomtheme export — the culori-class boundary list.
- **Batch 4:** the GATES retirement ladder — which derived families go
  CSS-native in which order, each step gated by the 165-assertion twins
  suite + visual parity rigs.
- **Batch 5:** the storage migration — themeOverrides → the field model;
  .doomtheme bundles stay import-compatible (the loader folds legacy
  shapes into the new model on read).

## THE WAVES

- **v0.99 THE FIELD:** the slot model + the field atlas + the new picker.
  The colors tab becomes the slot list (the lazy-editor pattern retired
  with it). Gate: the twins suite + a field-parity rig + the v098 panel
  rig (289-node class stays).
- **v0.100 THE MASKS:** pseudo-only L2 (the legacy inline bake retires) +
  the plate/ring under-layer redesign (the overlap-artifact fix, the
  v097 audit's declared next wave). Gate: native-layer3 + orbit-rest +
  a new mask-parity rig.
- **v0.101 THE ASSETS:** user-uploadable field images + 9-slice shape
  assets (pills, bubbles, cards) + the swappable-UI editor. Gate: an
  asset-picker rig + the full battery.

## WHAT WE ARE NOT DOING

- No runtime CSS compiler for derivations (color-mix instead).
- No per-element re-raster during motion (transform-carried layers only).
- No WebGL DOM painting (Android's 8-context cap; Pixi keeps the world).
- No theme-twins breakage — every step is gated by the suite.
