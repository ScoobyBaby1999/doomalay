# PLAN-V067 — THE EVERY-WINDOW PASS + THE TRANSFORM-PROOF PAINTER + THE DEEP FIELD

## The user's report on v0.66

> "pill boxes, especially the ones that are outlines or borders (all of
> them, except for title cards and headers) and all text that isn't a
> title text or header don't follow gradients still, but this is a much
> better version, things follow the gradient better. But a lot still
> don't. If we can also add a little more of a parallax feel when
> scrolling between the canvas, the lines, the dots, and the icons on
> screen. Make it feel more spacey like it's in space."

## The root cause found (the big one)

`background-attachment: fixed` is viewport-anchored ONLY outside
transformed ancestors — and the chat panel is an ALWAYS-TALL SHEET that
carries a PERMANENT transform (v0.42). **Every gradient inside the
panel — every pill, card, bubble, text clip — rendered ELEMENT-SIZED**:
each object squeezed the whole viewport gradient into its own little
box. Live-proven on the rig: a 100px test strip inside the panel showed
the full red→blue compressed into itself; outside it showed the correct
10% slice. This is the literal "every object follows the gradient in its
own weird way" report, and it was there since v0.49's text-grad.

### THE TRANSFORM-PROOF PROJECTION PAINTER (theme.js → window.DoomProjection)

Re-anchors every window by hand, immune to transforms:

```
background-size: <viewport>px <viewport>px
background-position: -<el.viewportLeft>px -<el.viewportTop>px
background-attachment: scroll      (element-relative, deterministic)
```

Mathematically identical to a fixed attachment — the element displays
exactly the viewport region it covers. Elements OUTSIDE transformed roots
keep the real fixed attachment (canvas chatbots) untouched.

- **Selectors derive FROM THE STYLESHEETS** (every rule with a fixed
  attachment or a `var(--X-gradient` image) — can never drift from the
  CSS, including runtime-injected module styles (re-collected when
  `<style>` nodes appear). NOTE: modern Chromium gives EVERY
  CSSStyleRule a cssRules list (CSS nesting) — recurse only when
  non-empty, never skip the rule itself.
- Triggered by: MutationObserver (childList/style/class), capture-phase
  scroll, resize, transform transitionrun/end, applyTheme, and app.js's
  physics tick (`DoomProjection.poke()` — icons ride transforms too).
- Paint scope: the transformed roots only (#chat-panel,
  #connect-overlay, .chatbot…). Solid twins are skipped; elements that
  revert to solid are cleaned back to the pure CSS state.

## The every-window pass (the stragglers)

theme.js flags `[data-a1..a4-grad]` per accent when its gradient twin
is live (mirrors data-text-grad). index.html's v0.67 block converts:

- **WINDOWS** — the accent-tinted pill families paint their accent's
  projection and their label flips to the derived ink: #panel-model-btn,
  #edit-banner, #tpl-chip, the active settings tabs (a1/a2/a3 by page),
  .ts-row-on, .ts-stage-n, .chat-working, table heads, #chat-send.sm-on,
  .sm-row.on, .tool-pill-use, .fmt-artifact-dl, .hmsg-dl, .hmsg-card-ico,
  .hub-count, .src-card-dom, .vw-tab, .vw-arch-fmt, .ph-scope-pill,
  .mb-pill/.mb-ufchip, .wsx-chip/.wsx-type
- **GLYPHS** — accent-colored text with no fill clips the same field
  through the letters (.ts-on-ico, .hub-step-val, .ts-stage-fo)
- **INLINE CATCHERS** — the JS-built pills (model browser tone pills,
  provider Free/Paid badges, workspace chips, composer segments) match
  `[style*="background:rgba(var(--accent-N-rgb)"]` → window + ink
- **BODY TEXT** — [data-text-grad] extends to .fmt (the chat body —
  the big ask), row labels, card names, viewer prose. color: transparent
  only (no -webkit-text-fill-color) so links/code keep their own colors.
- chatpanel.js: the composer segment pills render the a1 projection when
  active; their labels ride var(--on-accent) (was accent-on-accent).

## The deep field (the parallax)

The lattice is no longer one plane — lines and dots each ride their own
parallax factor, so a pan reveals four depth planes:

```
canvas bg (0.35 − 0.09·depth) → lines (1 − 0.38·depth) →
dots (1 − 0.20·depth) → icons (1.0 — the interaction plane)
```

- `spaceParallax` setting (Sizing → Grid Effects, default 60 →
  0.296/0.772/0.88), 0 = the v0.52 flat lattice exactly.
- The per-cell jitter hashes re-anchor in each layer's OWN frame
  (deterministic while sliding — no shimmer).
- **Pixel-proven**: a 348.8px pan measured lines +18 / dots +29 (mod 48)
  — exactly P×0.772 and P×0.88; flat would be +35 for both.

## Verification

- Focused + full sweeps (seed 909/forest): **260 screenshots, 31 phases,
  ZERO console errors**; PARALLAX_CONFIRMED in the manifest.
- VLM: model button SOLID RED by screen position; pills left-red /
  right-blue (cross-element window proof); sizing tab a magenta a2
  window; body text letters show the mesh flowing; all readable.
- VLM audit (p00/p06/p07/p17/p19): 47 shots, 14 flags — ALL the
  documented "no consumers on this screen" expectation mismatches;
  zero real readability/layout/white-box issues.
- Gates: node --check all touched, test_theme_twins 165 ✓,
  test_uikit 140 ✓, go vet EXIT 0.

## Suite additions (permanent)

- phase_invariants now records the gates + the painter anchor
  (viewport-sized layer at the element's own viewport offset).
- p19 THE PAINTER PROOF — deterministic computed-style assertion.
- p20 THE EVERY-WINDOW PASS — the sizing tab + the .fmt body text.
- p21 THE DEEP FIELD — fold-profile displacement analysis →
  PARALLAX_CONFIRMED verdict in the manifest.
- PHASE_EXPECT entries for p19/p20/p21.
