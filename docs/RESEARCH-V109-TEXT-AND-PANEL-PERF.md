# RESEARCH-V109 — Projected text + panel lag (the two research asks)

> The user (v1.08.1 post-ship): "Try and research 2 things, one is how we can
> further reduce panel lag, the next is what opensource library or another
> method we can use to handle doom projected text as currently our doom
> projected text causes extreme lag, switching doom projection off fixes it
> tho."
> Searches: tool-results/v109-research/ (8 query sets, this repo).

## 1. The projected-text landscape (the library question)

**Verdict: there is no open-source library that handles gradient-projected
text better than we do — every one of them ships the same mechanism we
already have, `background-clip: text` over a gradient background image.**

- The "gradient text" OSS space (GradientTextify, the CodePen dynamic-text-
  gradient patterns, design-system gradient-text components — s6-libs.json,
  s2-text-alt.json) is a *styling* space: they generate the gradient or split
  the string; the rendering is always `-webkit-background-clip: text` +
  `color: transparent`. Adopting any of them changes nothing about the cost.
- String-splitting libraries (the SplitType/GSAP-SplitText family) make it
  *worse* on our model: they multiply the number of clipped elements (one per
  word/glyph), and our cost driver is precisely the per-element clipped
  raster + the per-element anchor writes.
- SVG `<text fill="url(#grad)">` renders a gradient through glyphs with ONE
  paint and no clip mask — the theoretically cheaper shape — but it cannot
  reflow, wrap, select, or stream. Non-viable for a chat transcript.
- Canvas-baked text (rasterize the string with a gradient fill) has the same
  reflow/selection/streaming problem, plus a per-message canvas budget.

So the answer is architectural, not a dependency: **stop paying the cost
while nothing is being looked at.** That is v1.08.5 THE COAST.

## 2. Where our extreme lag actually came from (measured)

Inside the transformed roots, fmt text rides the LEGACY inline bake
(`background-attachment: scroll` + viewport `background-size` + a
`calc(var(--proj-tx/ty) + B)` position). Two write storms followed:

- **Scroll**: every scroll delta re-anchored EVERY painted text element
  (`scrollRebake` → one inline style write per element per scroll event).
  Rig-measured on a 60-block fmt transcript (129 painted windows): a 14-step
  scripted scroll produced **~1400 anchor writes** (≈11 per element) — each
  one a style recalc + a viewport-sized gradient raster clipped to glyphs,
  on the main thread, mid-gesture. This is the textbook layout-thrashing
  shape the literature warns about (s7-thrashing.json: read/write
  interleaving forces synchronous layout; Chrome's Android scroll-jank work
  is explicitly about keeping frames on the compositor — s1/s4).
- **Motion**: every panel-drag frame rewrote the root `--proj-tx/--proj-ty`
  vars, which every text position consumed (`calc(var(--proj-ty) + B)`) —
  a style recalc + repaint of every text window, per frame, for the whole
  transcript. The L2 layer path avoids this via compositor transforms, but
  `background-clip: text` can never ride an L2 layer (the oversized ::before
  cannot clip to the element's glyphs) — text was the one population left on
  the per-frame repaint leg.

Projection OFF never bakes text (the fmt twins render local, zero JS) —
which is exactly why "switching doom projection off fixes it".

## 3. The coast (what v1.08.5 ships)

During motion and scroll the text windows **coast**: their gradients ride
the content rigidly (a bounded drift from the viewport field — invisible on
a smooth gradient), and ONE settle paint re-anchors everything.

- Baked text is flagged at decision time (`__projClip` from the snapshot's
  clip, decided on the carry path too — the transcript's offscreen
  population lives there).
- `scrollRebake` skips flagged windows; un-viewed carries skip the constant
  true-up; a window entering the viewport still takes its ONE first-sight
  bake (a correct anchor the moment it appears — the flash fix preserved).
- The motion-window edge performs ONE batched disconnect (every text
  position rewritten to its currently-resolved constant), so the per-frame
  var writes stop touching text entirely.
- `paint()` un-coasts: the settle re-anchors every window.

Rig numbers (v109 rig §D, 420×800, 129 painted text windows):
| script | pre-coast | post-coast |
|---|---|---|
| 14-step transcript scroll | ~1400 writes | **178–213** (first-sight bakes + settles) |
| full panel drag | per-frame recalc+raster | **79 writes** (one batch), **max long task 0 ms** |

## 4. The panel-lag question (what remains)

- The remaining per-frame layout during a slide is the sheet's own reveal
  (`.panel-body` height) — inherent to the height-driven sheet model. The
  v1.06 research (pure-web-bottom-sheet) already priced the transform-only
  rewrite and it was declined as a scope-cut; with the text coast shipped,
  the projection adds **zero** main-thread work to a drag frame (L2 = one
  CSSOM var write consumed by compositor transforms; text = coasted).
- `content-visibility: auto` on message rows remains available as a future
  offscreen paint/layout skip (s8), but interacts with the painter's carry
  model and the sticky composer — noted, not scheduled (the anti-spaghetti
  cap).
- `background-attachment: fixed` stays the expensive leg on mobile (s5, and
  the v107 research) — the v1.06.1 surface exemption already removed it
  from the two viewport-sized surfaces; nothing re-adds it.
