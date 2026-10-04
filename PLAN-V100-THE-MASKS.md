# PLAN v1.00 — THE MASKS (the 6th #sheet-root dies at the root)

Version naming per user order: v0.100 → **v1.00** (the 1.x jump is the
user's explicit call — "push v1.00 and v1.01 together"). Phases push as
v1.00.1 / v1.00.2 / …; the wave ships as **v1.00-the-masks**. The wave
after this is v1.01 THE ASSETS (its own plan doc).

## THE OPENER — THE TOUCH BUG (user report, this session)

> "we currently have an issue where the new overlay screen to choose
> the colors don't register touches"

**Root cause (verified from primary sources — see
tool-results/v100-research/, W3C Touch Events Level 2 §9 + MDN +
Chrome blog):** the v0.99.6 slot-picker popover (`.slot-pop`,
appearance.js `slotPopover()`) is appended to **document.body**, so it
is NOT inside `panel.panelEl` — and app.js's canvas-input gate
`isInsideUI()` (the whitelist) never learned about it. On a real touch:

1. `touchstart` on a picker swatch bubbles to `document`.
2. `isInsideUI(target)` → false → `e.preventDefault()` (app.js touchstart
   handler, `{passive:false}`).
3. **Canceling touchstart suppresses every consequential mouse event,
   including the synthetic `click`** (W3C TE L2 §9: "If touchstart…
   are canceled, the user agent should not dispatch any mouse event";
   the tap note: "no mouse or click events will be fired"). MDN calls
   this exact pattern the known anti-pattern.
4. Every picker control is `click`-wired (GradientUI buttons
   uikit.js 850–931; the close ✕; the delegated slot-row listener;
   the outside-tap close) → **dead**. Popover scrolling dies too
   (touchmove preventDefault). Desktop mouse clicks fire regardless
   of touchstart preventDefault — which is why every desktop rig
   passed and the 6th recurrence of the **#sheet-root class**
   (v0.10.1 connect overlay, v0.17 artifacts/action sheet, v0.26
   sheet-root, v0.31.2 canvas dock, v0.34 crop/media-zoom) shipped.

**The fix — THE POSITIVE LIST (root-cause class-killer, not the 7th
whitelist patch):** panel.js `_wireDuck` already runs the pattern
(v0.69: "the touch must land on the canvas itself (#c) or the icon
layer (#chatbots)"). app.js's canvas input flips from *"everything the
whitelist doesn't own is mine"* to *"only what is actually canvas is
mine"*:

```
onCanvasSurface(t) = t.id === 'c' || !!t.closest('#chatbots')
```

- touchstart/touchmove/touchend/mousedown/wheel/contextmenu all gate on
  `!onCanvasSurface(e.target) → return` — a touch that starts anywhere
  else (popover, panel, dock, ANY future body-appended overlay) never
  reaches `preventDefault()`; clicks synthesize natively. The class is
  dead, not patched.
- Touch events keep firing on the START element for the whole gesture
  (DOM touch semantics), so the gate is consistent touchstart→touchend.
- `#c2` is pointer-events:none (never a target). Decorative
  pointer-events:none layers resolve to `#c` underneath (still pans).
  The empty-state card body passes through to `#c` (still pans); its
  CTA button is interactive (not canvas → no hijack, click fires).
- `isInsideUI()` RETIRES entirely (its 6 gates were the only
  consumers; the closing-panel v0.45 concern dissolves — a closing
  panel is not canvas-surface, and its pointer-events:none lets
  touches resolve to `#c` directly).
- Belt-and-braces: `.slot-pop { touch-action: manipulation }`
  (research Q2d: kills any residual double-tap-zoom intent on the
  popover; the viewport meta already removed the 300ms delay).
- Mouse parity: mousedown positive-list (same semantics); **wheel over
  the popover scrolls the popover** (today it zooms the canvas — the
  mouse twin of the same bug, fixed by the same line).

**The rig (scripts/v1000-touch-test.mjs + v1000-touch-tap.sh):**
Playwright `hasTouch:true` + `locator.tap()` dispatch REAL trusted
touches via CDP `Input.dispatchTouchEvent` (research Q3: ordinary
`click()` is structurally blind to this class — Playwright maintainers'
own note #2903; `dispatchEvent` can't catch it either). Asserts:
(T1) boot clean, settings → Colors (7 slot rows);
(T2) tap a slot row → popover `.open`;
(T3) tap a control INSIDE the popover → the click listener FIRES
(probe counter on `.slot-pop`) — the class-death proof;
(T4) tap ✕ → closed; (T5) outside-tap → closed;
(T6) CDP touch-drag on the canvas → the canvas touchstart handler
still runs + preventDefaults (probe listener registered after app's —
same-node same-phase registration order) — the refactor didn't kill
panning;
(T7) touch-drag inside the popover body → `scrollTop` moves (the
touchmove fix);
(T8) mouse parity: click + wheel over the popover;
(T9) zero console errors through the sweep.

## v1.00.2 — GRADIENT-TEXT TIERS (the bake, not the live gradient)

Research verdict (pixi.js 8.21.0 official dist source-read):
**BitmapText gradient fill is UNUSABLE in 8.21.0** — `DynamicBitmapFont
._setupContext` bakes the FillGradient into the glyph atlas WITHOUT
textMetrics (`width=height=1` → the gradient spans one atlas pixel);
a pre-installed plain font silently ignores gradients (tint=white).
The performant path is the epoch-bake the plan already loved:

- **hero/animated gradient text** = `Text` + `FillGradient` rendered
  ONCE via `renderer.generateTexture({target, resolution: 2,
  antialias})` → `Sprite` (research Q2: single-arg options object in
  v8; `frame` = crop region, NOT the atlas misuse). Live Text+
  FillGradient stays BANNED (upstream #10595/#10926).
- **short static gradient moments (DOM)** = local-box clip, one paint
  (the [data-fmt-grad] family already rides this).
- **body/long text** = solid ink tint (color-mix) — NEVER a window.

Audit targets: the chatbot name pills / any canvas-side gradient
labels (pixiworld.js rasters), the fmt title family (formatter.js).

## v1.00.3 — L2 PSEUDO-ONLY (the legacy inline bake retires)

The v0.99.5 census left the L2 window class 3-deep in places: the
wave finishes the retirement — every gradient surface window that
still paints via inline child elements moves to ::before/::after
pseudo (one paint, no layout join, the `#proj-layer-styles` observer
exclusion stays). Plate stacks: surface window + derived hairline
ring ONLY (2 layers, the v097 overlap-artifact class + the colors-panel
transient artifacts die with the third layer).

## v1.00.4 — VIRTUAL-CORE (the catalogue + the hub library)

Vendor `@tanstack/virtual-core` dist/esm (2 files, 26KB, zero deps —
research: exports `Virtualizer, observeElementRect,
observeElementOffset, elementScroll, measureElement`; `_didMount()`/
`_willUpdate()` lifecycle the adapters call — we call them ourselves,
the lit-example pattern). Wire: modelbrowser catalogue rows + hub
library grid → `onChange`-driven DOM diff, `data-index` +
`measureElement`, `estimateSize` from the measured class. Bounded
settings lists KEEP content-visibility (the v0.99.7 recipe — the
decision rule: virtualize the unbounded catalogue, cv the bounded).

## v1.00.5 — THE CHEAP CONSOLIDATIONS

- toast ×6 → ONE themed toast (audit: grep every ad-hoc .toast/.notice
  construction; one implementation, theme vars only).
- keys.js rogue overlay → the Overlay screen class (kills the last
  hardcoded `rgba(0,0,0,.48)`).
- localmodels double-✕.
- the amber star → the accent system (no hardcoded hue).

## v1.00.0 — WAVE SHIP

Full battery (twins 194-class, uikit, v097 oneobject, v092 orbit-rest,
v0911 native-layer3, v098 zoom/tiling/panel, v099 field/parity/
reassign/settings + the NEW v1000 touch rig) + version bump
0.99.0 → 1.00.0 + tag `v1.00-the-masks`.

## WHAT WE ARE NOT DOING

- No Pointer-Events migration of the canvas input this wave (research
  says it's the structural end-state, but it's a rewrite of the
  battle-tested pan/pinch/long-press path — the positive list kills
  the bug class without it; a future wave may take it deliberately).
- No new slots, no member-set changes, no runtime CSS compiler, no
  chroma.js, no Iconify runtime (standing verdicts).
- No test-only hooks in app.js — the rig observes real behavior only.
