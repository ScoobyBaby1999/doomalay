# DISCIPLINE — the two standing UI rules (v1.04.5)

> The user's iron rules, made enforceable. Every future change must pass
> `scripts/v1040-discipline-audit.sh` — it fails on NEW violations.

## Rule A — Theme discipline

**Absolutely everything abides by the theme system. No hardcoded colors.**

### The system
- The 7-slot field model (`--field-surface/ink/canvas/accent-1..3`) + the
  derived products (`:root` color-mix block in index.html; theme.js's
  DERIVED_MIXES is the JS twin).
- **v1.04.2 THE ELEVATION**: `--shadow-ink` = `color-mix(in oklab,
  var(--field-canvas), #000 55%)` — the themed shadow color. Consumers
  compose `rgba(var(--shadow-ink-rgb), α)` (triplet re-derived per apply);
  the canvas needs a real hex → `DoomTheme.resolvedThemeVar('--shadow-ink')`.
  Alpha stays at the consumer. `--highlight-inset-rgb` = the inset white
  ring constant (--on-brand precedent).
- **v1.06.4 THE EXPOSURE**: both elevation tokens are now USER-EDITABLE —
  the `--field-shadow` / `--field-highlight` override slots (the Colors
  tab's Shadow + Highlight rows, solid fields like ink). An override wins
  (the hex lands on `--shadow-ink` / `--highlight-inset` + their
  triplets); unset = the derived defaults (the CSS color-mix / the
  :root static — never fought inline). The rows seed from the LIVE
  derived values (`DoomTheme.derivedShadowHex/derivedHighlightHex`) —
  the editor opens on what the app shows.
- **v1.04.4 THE CANON**: `DoomTheme.FALLBACKS` — the ONE literal map for
  pre-apply / var-unavailable paints. `DoomTheme.LEGACY_GRID` — the grid
  sentinels ("equal = never customized" → the theme's palette returns).
  settings.js loads BEFORE theme.js (load-order fact): its seed literals
  are CANON-TWINs the audit cross-checks.

### Canonical zones (colors that are BY DESIGN, not violations)
| Zone | Why |
|---|---|
| index.html `:root`/`[data-theme]`/`@property` blocks | the system itself |
| theme.js (FIELDS/DERIVED_MIXES/FALLBACKS/LEGACY_GRID) | the engine |
| themeeditor.js + the HSV wheel (incl. its `#fff` handle) | the picker IS the color space |
| formatter.js chat schemes; the fmt preset defaults | user-pickable palette data |
| Provider/family brand colors (chatsview.js, app.js, hub item art) | identity data, like logos |
| `.fmt-yt-play` red | YouTube brand recognition |
| Ink-on-art (`hub.js` WCAG contrast pick; the avatar initials) | contrast against USER art, not the theme |
| The crop frame's white edge + dark surround | contrast over arbitrary user images |
| Canvas light rendering (pixiworld star glow) | the glow IS white light |
| `paletteAt`'s `#000000` | the sampler's zero-point (veil-ink's root default) |
| Android `colors.xml` boot flash | native launch theme; equals midnight canvas |
| `rgba(…, 0)` gradient ends | transparency, not a color |

### Forbidden (the audit fails on these)
- Any new `rgba(0,0,0,…)` / `rgba(255,255,255,…)` / raw hex used as chrome.
- New scattered hex fallbacks — ride `DoomTheme.FALLBACKS` (or add the key).
- A reset path writing a paint hex instead of a LEGACY_GRID sentinel.

## Rule B — Surface discipline

**Every new front-facing screen rides ONE of the two sanctioned surfaces** —
unless it belongs on the canvas/grid itself.

### The ledger
| Surface | Owner | Notes |
|---|---|---|
| **The Panel** | panel.js + chatpanel.js | the slide-up chat panel, 2 snap points |
| **The Overlay Screen** | connectoverlay.js (`window.ConnectOverlay`) | the rounded box; static ✕, nav stack, history floor; themed scrim/chrome |
| Artifacts bottom-sheet | artifacts.js (`#artifacts-overlay`) | the SANCTIONED sheet-variant of the Overlay surface (drag-dismiss head, CodeMirror editor, unsaved guards). Re-hosting in the center box would break the interaction model — documented decision, do NOT migrate |
| Chrome ladder | uikit (toasts, crop), msgactions, perfhud, recovery (z-max, crash-only), webpanel park (hidden iframes), hidden copy anchors | transient chrome ABOVE the surfaces — not screens |

### The z-ladder (documented, keep coherent)
`2147483647` recovery (crash-only) · `3500` action sheet · `3400` chrome
(toasts/crop/keys sheet) · `3000` the two overlay surfaces (raise-on-open
keeps the most-recent on top) · `2600` send-menu.

### Forbidden
- A new body-appended full-screen UI outside the sanctioned set (the audit's
  B1 check catches new appenders — add yours to the allowlist ONLY with a
  documented reason).

## The enforcement loop
1. `scripts/v1040-discipline-audit.sh` — static gates (fast, battery-wireable).
2. `scripts/v1042-elevation.sh` + `scripts/v1043-shadow-sweep.sh` — the live
   rigs (themed shadows resolve, follow user theming, CSS≡JS parity).
3. When extending: extend the audit's allowlist WITH THE REASON, never
   delete a gate. If a change needs a gate deleted, that's a design
   conversation, not a commit.
