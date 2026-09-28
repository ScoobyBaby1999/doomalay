# PLAN-V066 — THE PROJECTION REFACTOR (the user's canvas-per-variable model)

## The user's spec (verbatim intent)

> "for everything, all pills, color, gradients. We lay out the gradient or color
> or anything as a background, so every color changing variable in the settings
> projects its own background... the background is invisible to everything but
> the pills and texts and objects that have it as the variable... imagine every
> variable fitting the users screen or canvas... every single object, if it be
> a pill, text, anything, only renders the canvas it's variable is assigned to.
> That way, all objects of accent 1 render the same accent 1 background
> projection, nothing else."

Translated: **one viewport-sized projection per customizable variable; every
object is a window into its variable's projection** — exactly how the canvas
already paints --bg-panel, and exactly CSS `background-attachment: fixed`.

## Root cause of the user's complaints (why v0.65's fixes weren't enough)

1. **Accent gradients render per-element.** Most accent consumers
   (`.app-switch`, fmt rules, hub pills, `--accent-2-gradient` at index.html
   :3562, chatpanel's pill-row tone tints, fmt-slot text) never got
   `background-attachment: fixed` — each tiny pill squeezes the whole
   viewport-worth of gradient into 30px → "accent 4 is barely noticeable",
   "every object follows the gradient in its own weird way".
2. **The veil stack milks objects white.** v0.57 layered
   `linear-gradient(var(--veil-card))` / `--veil-head` ink washes over the
   fields; when --veil-ink derives white (light surface-1 first stop — the
   user's gradient), every card/header/pill under it is 36–48% WHITE-washed.
   The v0.65 s1Lum fix narrowed one path; the model pill + sandbox pill sit in
   `#chat-header` (veil-head over bg-app) → still stained in the APK. Verified:
   the shipped APK contains the fix (s1Lum present in libdoomalayengine.so),
   yet the user still sees the wash → the veil architecture itself is the bug.
3. **Pills are rgba tone tints, not projections** (chatpanel.js pill-row:
   `background:rgba(tone,0.16)` + veil ancestors) → colors "don't render".

## The architecture (v0.66 PROJECTION SYSTEM)

- Every customizable var keeps its twin pair: `--X` (solid compat hex) +
  `--X-gradient` (the full GradientUI layer stack or 'none').
- **Every** `--X-gradient` consumer renders the viewport-fixed projection:
  `background-image: var(--X-gradient); background-attachment: fixed;` —
  Chromium sizes gradient layers to the *viewport* under fixed attachment, so
  percent-based recipes (mesh `at 20% 25%`) and px patterns (navy/gingham/
  checker tiles) all share ONE viewport-fitted field per var. All objects of
  that var are windows into it. `background-color: rgba(var(--X-rgb), tint)`
  stays as the fallback when the twin is 'none'.
- **The veils are GONE from fills.** No ink washes over any gradient. The only
  survivors: `--veil-ink` feeds `--text-shadow` (a shadow, never a fill) and
  the scrim rgba() family (overlay dimmers — separate mechanism, unchanged).
- **Pills are projections of their accent variable** (new pattern):
  `background-color: rgba(var(--accent-N-rgb),0.14)` (the 'none' fallback) +
  `background-image: var(--accent-N-gradient)` + `background-attachment: fixed`
  + `border:1px solid rgba(var(--accent-N-rgb),0.5)` + readable ink
  `var(--on-accent-N)` (new per-accent luminance twins) + text-shadow.
- **Text gradients** (data-text-grad + fmt slots): same fixed field → all
  titles/headings sample one text-1 projection (verify clip:text+fixed live).
- **The canvas** (app.js, --bg-panel) already paints the viewport projection.
  Unchanged.

## Phases

1. **theme.js** — write `--on-accent-2/3/4` (luminance of each resolved
   accent solid) alongside --on-accent; keep veil-ink derivation (text-shadow
   source only); keep twins. No other changes.
2. **index.html** — replace the v0.57 layer-system block with the v0.66
   projection system: strip every `linear-gradient(var(--veil-…))` fill
   layer; every gradient consumer (inline catchers, Layer 1/2/3, headers,
   text-grad, fmt slots, .app-switch :924, :1009, :3562, ts-stage, pv-btn,
   cwd, fmt links…) carries `background-attachment: fixed`. Radius-safe
   border rings keep the 3-layer double-background trick (fixed).
3. **chatpanel.js** — the pill row (sandbox→accent, model→accent-2,
   artifacts→accent-2, persona→accent, mind→accent-3, +workspace pill) +
   libPill + effort/lib composer segments + gatelock + util-btn: convert to
   the projection pattern (inline longhand background-image/color/attachment —
   no shorthand resets, no catcher dependence).
4. **Sweep the modules** — grep every js module for inline
   `-gradient)` consumers and veil fills; align (hub.js hub pills, workspace
   wsx pills, sandboxpicker hf pill, modelbrowser, providers, uikit
   .dx-pill…). GradientUI preview bars/color-row banners stay LOCAL
   (editor previews, documented exception).
5. **Suite v066** — update v065-theme-suite.sh invariants: every phase also
   probes computed `background-attachment` contains 'fixed' on a pill +
   a card + a header, asserts NO `linear-gradient(var(--veil` fill layer
   remains, and records `--on-accent-*`. New PROJECTION CONSISTENCY phase:
   accent-1 gradient with strong left/right split → VLM verifies two
   pills at opposite screen edges show the OPPOSITE ends of the same
   gradient (the window proof).
6. **Full sweep + audit** (seeded random theme, 26 phases × 20 screens) +
   VLM audit → fix loop.
7. **Ship** — gates (node --check all touched, test_theme_twins 165,
   test_uikit 140, go build/vet/test), rebuild engine, install Android SDK
   (cmdline-tools), build arm64 libdoomalayengine.so + assembleDebug APK,
   buildinfo → 0.66.0, commit, tag v0.66.0-projection-rework, release with
   APK + binaries, push.
