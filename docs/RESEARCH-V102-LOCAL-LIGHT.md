# RESEARCH v1.02 — THE LOCAL LIGHT diagnosis (the user's 8 gradient reports)

Base: 1fb19f7e (post v1.01.0). All findings verified in the code + web
evidence (tool-results/v102-research/, v100-research/07-border-image/).

## The reports → root causes (all 8 traced)

1. **"The panel splits into two gradients, one we applied and another
   hidden one derived from it"** — every gradient "window" in the app
   paints with `background-attachment: fixed` (index.html Layer 1/2/3
   + catchers + gate families; theme.js GATES mint; chatpanel.js
   projPillStyle). Per CSS transforms + the containing-block rule
   (verified: an ancestor with a transform becomes the containing block
   for fixed-position — and Blink resolves fixed *backgrounds* the same
   way), elements inside the transformed draggable panels
   (#chat-panel etc.) sample a PANEL-SPACE field while elements
   outside sample the VIEWPORT field → two visibly different gradients
   in one screen. The DoomProjection JS painter exists precisely to
   compensate this (bakes background-position per element), but its
   repaint is gated on the TOPOLOGY fingerprint (solid↔gradient flips
   only) — gradient VALUE changes never re-bake → stale mixes of the
   two fields. The skipped families (.hub-libpill, .wsp, .wsx-,
   .color-row-banner…) get NO compensation at all.
2. **"Pills don't follow gradients… they do follow when surface isn't
   set"** — pills on the surface family paint `color-mix()`
   translucency (color-mix can't carry a gradient image — solid twin
   only): #settings-btn (`color-mix(in srgb, var(--surface-1) 88%,
   transparent)`), #dock pills, gatelock boxes. Accent pills
   (chatpanel projPillStyle) carry the gradient via fixed attachment
   → the two-field staleness above. The "irrational" mix = which field
   an element samples depends on its transformed-ancestor chain.
3. **"Theme select boxes appear white"** — the swatch cards paint
   `background:var(--surface-2)` (the CURRENT theme's derived surface),
   NOT the theme's own palette; with a live surface gradient the
   inline catcher + plate transients render them as washed/white
   boxes. THE FIX (user spec): theme boxes are the ONE place allowed
   to show the THEME'S OWN colors — raw hexes from the theme model,
   no CSS vars at all.
4. **"Moving the panel in the colors tab is worse with a gradient"** —
   `background-attachment: fixed` is the classic Chromium slow path
   (verified: full-page redraws while scrolling fixed backgrounds;
   Chromium special-cases them onto their own composited layer only
   for simple cases; iOS WebKit doesn't even support fixed). During a
   panel drag every fixed-attachment gradient in the tree re-rasters
   on the main thread + the painter's own JS per frame. The
   homegrown renderer (DoomProjection, ~1300 lines) is the thing to
   replace — with the platform's own compositor.
5. **"Chat metadata pills render white when I change accents; the
   script pill doesn't follow themes"** — projPillStyle (fixed +
   stale compensation) for the whites; `.hub-libpill[data-
   tone="script"]` rides **--accent-4**, a theme-carried STATIC (never
   user-editable) → never follows gradients by design. User's chosen
   fix: a checkers pattern over the 3 accents, positional
   (1,2,3,1,2,3…) by pill index.
6. **"Small circular opaque pills render only the first color"** —
   Pixi-side rasterized discs (pixiworld rasterIcon) fill with the
   cached resolved SOLID (first stop); the DOM twin of a tiny window
   + fixed attachment shows a ~uniform slice. Local gradients paint
   the full sweep across small boxes.
7. **"Surface gradient lag — make it 100% smoother"** — same root as
   #4. Borders stay DERIVED solids (color-mix of surface+ink) — no
   new borders field needed (the user agreed it's not necessary);
   derived hairlines already follow the fields.
8. **"Overlay screens use the canvas's first color, not surface"** —
   ConnectOverlay's card paints inline `background:var(--bg-app)`
   (derived from canvas) + the inline catcher tries a dead
   `--bg-app-gradient` (never written in the field model — bg-app is
   a derived solid). The canvas-side name pill beneath chat icons is
   HARDCODED `rgba(10,10,11,0.92)` (midnight's bg!) in
   pixiworld.js:297 — shows "the first color of the canvas" on every
   theme. Also: the `doomalay:theme-applied`/`theme-changed` events
   pixiworld + app.js listen for are NEVER DISPATCHED anywhere — the
   canvas icon rasters never re-mint on theme changes (themeStamp
   never bumps), which is the "the other 50% follows after I change
   an unrelated variable" class of staleness.

## THE VERDICT (the fix architecture)

**Retire `background-attachment: fixed` from the object track
entirely. Every gradient window goes LOCAL (scroll attachment — the
element's own border-box).** This is the same call v0.92.1 made for
the chatbot chrome and v1.00.2 for text — finish it for everything.

- ONE paint model everywhere: no transformed-ancestor split, no
  two fields, no compensation painter. The "public library" that
  replaces the homegrown renderer is the browser's own compositor.
- Local background layers are the fast path (compositor-friendly,
  no re-raster on scroll/drag, no JS).
- DELETE: the DoomProjection machinery (~1300 lines: root registry,
  motion hooks, L2 pseudo minting, its MutationObserver), every
  `background-attachment: fixed` declaration in index.html + the
  module-injected styles, GATES' minted fixed, projPillStyle's fixed.
- The gradient twin stays the ONLY gradient source; solid consumers
  keep the solid twin + color-mix derivations (unaffected).
- Small pills/discs get the full local sweep (issue #6 resolves
  itself).
- applyTheme dispatches a coalesced `doomalay:theme-applied` event
  (~120ms trailing) → pixiworld re-mints rasters, app.js arrow hex
  resets. The canvas name pill paints the resolved surface (solid or
  the parsed linear-gradient — paintCSSBackground already parses it).

## 9-slice / atlas (the continuation work — evidence already banked)

v100-research/07-border-image/ holds the verified base: Chrome clips
`border-image` with `border-radius` → the mask+background split (the
DOM side), Pixi `NineSliceSprite` (the canvas side), WebP supported
since WebView 32-era. The v1.01 vendors (maxrects-packer ESM, fflate,
MCU) are in place. Plan: PLAN-V101 §v1.01.3–1.01.4 → v1.02 LIBRARY.
