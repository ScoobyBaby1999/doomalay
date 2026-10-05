# PLAN v1.02 — THE LIBRARY SESSION (local light → 9-slice → bundles → library)

The user order: fix the 8 gradient reports FIRST, then "continue with
the new 9-slice icon atlas and v1.02 the library". Phases push as
v1.01.5 / v1.01.6 / v1.01.7 …; the wave ships as **v1.02-the-library**.
Diagnosis + evidence: docs/RESEARCH-V102-LOCAL-LIGHT.md.

## v1.01.5 — THE LOCAL LIGHT (the 8 reports, one architecture)

1. **Fixed dies**: remove every `background-attachment: fixed`
   (index.html Layer 1/2/3 + catchers + gate families + the module
   <style> injections; theme.js GATES mint; chatpanel.js
   projPillStyle). Windows keep `background-image:
   var(--x-gradient, none)` — LOCAL now.
2. **DoomProjection deleted** (theme.js PROJ block + call sites in
   app.js/gesture.js/settings.js): the root registry, motion hooks,
   L2 pseudo minting, its MutationObserver, the topology repaint
   gate. A zero-cost stub keeps the API surface during the transition;
   rigs re-point (see gates).
3. **THE THEME EVENT**: applyTheme dispatches coalesced
   `doomalay:theme-applied` (120ms trailing) — pixiworld re-mints
   icon rasters (themeStamp++), app.js resetArrowHex lives again.
4. **Chrome pills follow the field**: #settings-btn / #dock pills get
   gate-scoped `background-image: var(--surface-1-gradient)` (local)
   over their color-mix glass; the gatelock boxes ride the same
   treatment via the existing Layer-2 family.
5. **Overlay screens ride the surface** (issue 8): ConnectOverlay card
   `background:var(--bg-app)` → `var(--surface-1)` (+ its catcher →
   the surface gradient window). Inner boxes unchanged.
6. **Canvas chrome** (issue 8 + 6): pixiworld name pill paints the
   resolved SURFACE (solid hex or parsed linear-gradient —
   paintCSSBackground already parses it) instead of hardcoded
   `rgba(10,10,11,0.92)`.
7. **Theme boxes reflect the theme** (issue 3): schemeThemeSwatches
   builds from the THEME'S OWN raw hexes (surface/canvas band + 3
   accent dots + label ink), zero CSS vars — via a new
   DoomTheme.themePreview(id) (blockCache fields + THEMES accents).
8. **Checkered library pills** (issue 5): libsHTML stamps positional
   tones `data-tone="acc1|acc2|acc3"` (i%3); rgba tint + gate rules
   per new tone; the accent-4 script assignment retires from the
   picker row.
9. **Chat metadata pills**: projPillStyle drops fixed → local
   gradient over the tint; label ink unchanged.

**Gates (rigs)**: new scripts/v1015-local-light.mjs — (a) surface
gradient live → #chat-panel/.settings-section/pill computed
background-image = the gradient; (b) ZERO elements with
background-attachment: fixed; (c) panel drag longtasks within budget;
(d) hub libpill tones = acc1,acc2,acc3,acc1,acc2; (e) swatches carry
raw hexes only; (f) overlay card = surface gradient when live; (g)
theme event fires → themeStamp bumps. Update the PROJ-reading rigs
(v097/v098/v099 panel batteries) to the no-painter contract. Full
battery + v1000 touch rig green.

## v1.01.6 — 9-SLICE + THE ICON ATLAS + REGISTRY (per PLAN-V101 §3)

- **The atlas**: maxrects packing of the app's shape assets (the
  pill/plate/box chrome glyphs) into one 2048² texture —
  pixiworld rasters per-fingerprint already; the atlas joins that
  pipeline (`packer.add(w,h,data)` → bins → rects).
- **9-slice**: Pixi `NineSliceSprite` for canvas member-class shapes;
  DOM side = `border-image` + the mask/background split where radius
  matters (Chrome clips border-image under border-radius — verified
  in v100-research/07-border-image/NOTES.md).
- **The icon registry**: sprite renderer + **Iconify JSON as DATA**
  (no runtime Iconify); theme bundles swap icon sets by name (the
  Android RRO pattern).

## v1.01.7 — .DOOMTHEME V2 (per PLAN-V101 §4)

- Zip container (fflate vendored): `manifest.json` (DTCG 2025.10
  tokens + `$extensions["com.doomalay"]`) + `assets/` + `fonts/`.
- The 8-rung security ladder (caps → zip-slip normalization → MIME
  sniff → DOMPurify → Ajv standalone manifest validation → decode
  bounds → font whitelist → failed-apply-rollback).
- Export/import round-trip rig + the security fuzz rig
  (corrupt/oversized/traversal/zip-bomb all rejected cleanly).

## v1.02.0 — THE LIBRARY (the wave ship)

- Hub browse/publish of .doomtheme v2 bundles (the "themes" library
  category already exists in the hub model — the v2 bundle becomes a
  first-class publishable).
- The catalogue rides the vendored @tanstack/virtual-core (the wiring
  deferred from v1.00.4 — this is its wave).
- Tag `v1.02-the-library` + release (CI: APK + desktop + HF Space).

## WHAT WE ARE NOT DOING

- No new editable color fields (borders stay derived solids — the
  user: "not necessary").
- No Houdini paint worklets, no shared-field replacement illusion —
  LOCAL is the model.
- No hub browse of v2 bundles before v1.02 (per PLAN-V101).
- No changes to the dual-track text system (v0.99/v1.00 contracts).
