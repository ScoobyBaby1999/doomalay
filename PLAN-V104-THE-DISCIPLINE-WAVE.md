# PLAN-V104 — THE DISCIPLINE WAVE (theme-color + two-surface, to completion)

> User mission (2026-10-06): NOT generic "review & improve engineering details".
> Specifically drive the two standing disciplines to their non-spaghetti end:
> (A) ZERO hardcoded colors — everything rides the theme system.
> (B) Every front-facing surface rides the Panel or the Overlay Screen.
> Iron law per phase: hypothesis → web search → real plan → build →
> red-team with REAL tests (imitate a user) → push as x.x.N; wave tag when done.

## 0. RECON FINDINGS (this session, main @ 5d53b786 v1.04.1)

### A. Theme discipline — what actually remains
- **No elevation/shadow tokens exist.** The derivation block owns color fields
  (canvas/ink/surfaces/border/accents) but NOT shadows. Result: 37 shadow
  literals in index.html chrome rules (`rgba(0,0,0,α)` / `rgba(255,255,255,α)`)
  + stragglers: chatpanel.js:584, modelbrowser.js:163, msgactions.js:24,
  artifacts.js `.art-panel`, uikit.js:75 (white inset ring), uikit crop chrome.
- **Scattered hex fallbacks** (drift risk, not visible bugs): uikit.js:168
  DEFAULT_COLORS `['#38bdf8','#a78bfa']`; webtweaks.js ×4 the same pair;
  appearance.js `#14141a/#e0e0e8/#101016/#22d3ee` + `rgba(255,255,255,0.10)`
  swatch border; atoms.js colCache fallbacks; lattice.js `#2e2e3a/#131318/
  #4a4a5e/#0a0a0b`; pixiworld.js rv() fallbacks; doomprojection.js `#14141a`;
  tweaks.js `#22d3ee`; settings.js grid defaults; persona.js
  `rgba(var(--border-rgb,60,60,60),.6)` (numeric fallback inside var()).
- **hub.js ink-on-art** (`#fff` / `rgba(10,10,14,.92)`): functional — ink is
  chosen against USER gradient art, not the theme. Canonical-by-design, but
  the luma math (0.299/0.587/0.114, threshold 168) can be upgraded to WCAG
  relative luminance + the 4.5:1 check (small, contained).

### B. Canonical zones (NOT violations — enforced allowlist)
- index.html `:root`/`[data-theme]`/`@property` blocks + derivation (the system itself).
- theme.js field engine; appearance.js/themeeditor.js (the EDITOR: hex is the data format;
  picker spectrum stops + COMMON swatches are the color space itself).
- formatter.js chat SCHEME palettes (user-pickable named schemes = data).
- Brand identity data: chatsview.js provider colors, app.js FAMILY colors (logo-like data).
- Canvas paint code (atoms/lattice/pixiworld/doomprojection): the sanctioned canvas zone —
  but their FALLBACK hexes get canonized in v1.04.4.
- Android `colors.xml` `bg` = boot flash (native launch theme can't read JS vars; value =
  the default theme's canvas). Documented canonical.
- app/ React dir: DEAD code (no CI reference) — out of scope.

### C. Surface discipline — the ledger
- **Panel** (panel.js + chatpanel.js): the slide-up chat panel, 2 snap points. ✅
- **Overlay Screen** (connectoverlay.js `window.ConnectOverlay`): rounded box,
  static ✕, nav stack, history floor, themed scrim/chrome. Sandbox/model pickers,
  settings, keys sheet (v1.00.5) ride it. ✅
- **#artifacts-overlay** (artifacts.js): bottom-SHEET form (`.art-panel`,
  drag-dismiss head, CodeMirror editor, unsaved guards, ghost-click guard,
  v0.81.5 raise interleave). Already theme-compliant except one shadow literal.
  DECISION: sanctioned exception (sheet variant of the Overlay surface) —
  re-hosting in the center-box would break drag-dismiss + cost regression risk
  for zero user value = the spaghetti boundary. Documented, not migrated.
- **Chrome ladder** (settled by prior waves, stays): toasts, msg-action sheet,
  crop/media-zoom, perfhud chip, recovery screen (z-max, crash-only), webpanel
  park/deck (hidden iframes), hidden copy anchors/textareas. All themed already.

### D. Web research (tool-results/v105-research/)
- M3: dark themes de-emphasize raw shadows → tonal elevation; shadows derived
  per theme (light themes need stronger ink-based shadows). → tokens calibrated
  per theme, not one constant.
- DTCG v1 stable (Oct 2025): noted as FUTURE residue (namespacing), not this wave.
- color-mix: safe on the established WebView-111 floor (repo precedent: oklab mixes ship).
- WCAG 1.4.11/1.4.3: 4.5:1 normal text — the ink-flip upgrade target.
- z-index: shared ladder over scattered values (repo already has 3000/3400/3500/
  2147483647 — document it in the rig).
- WebView perf: a handful of new @property registrations ≈ negligible (25k ≈ 30ms).

## 1. THE BUILD (phases; each: build → rig → battery → push x.x.N)

### v1.04.2 — THE ELEVATION TOKENS (systemic foundation)
- index.html: `--shadow-1` (chips/inputs: `0 2px 6px …`), `--shadow-2` (sheets/
  cards: `0 8px 32px …`), `--shadow-3` (overlays/modals: `0 16px 48px …`),
  `--highlight-inset` (the `rgba(255,255,255,0.04)` inner ring). Derived in the
  derivation block from field values via color-mix (canvas+ink), calibrated per
  theme — light themes get stronger ink shadows (M3 finding). @property-free
  (shadow tokens are plain custom props — no animation need, zero perf cost).
- theme.js: expose through the field pipeline (applyTheme twins) so .doomtheme
  round-trips + lookio legacy folds stay coherent; appearance.js: NO new editor
  rows (derived products, like border twins — the anti-spaghetti call).
- GATES: boot clean ×10 themes cascade; twins + uikit + go green; a before/after
  shadow READ rig (computed box-shadow contains var-resolved values, no literal).

### v1.04.3 — THE SHADOW SWEEP
- index.html: all 37 literals → the 3 tokens + --highlight-inset (per-depth
  mapping documented in the diff). artifacts.js .art-panel → --shadow-3.
- JS: chatpanel.js:584 → --shadow-2; modelbrowser.js:163 → --shadow-3 (drag lift);
  msgactions.js:24 → --shadow-3; uikit.js:75 ring → --highlight-inset; crop
  chrome shadows → tokens.
- hub.js: ink flip → WCAG relative luminance + 4.5:1 branch (math upgrade ONLY,
  same call sites; art colors are data). Comment marks it canonical.
- GATES: v1043 rig — greps prove ZERO `rgba(0,0,0`/`rgba(255,255,255` shadows
  outside canonical zones; visual: overlay open, sheet drag, drag-a-provider-row
  screenshots on midnight + paper (dark+light) — shadows read, VLM check;
  full battery (twins/uikit/v098/v1000/v1031-36/go).

### v1.04.4 — THE FALLBACK CANON
- theme.js gains `Theme.FALLBACKS` — ONE literal map (canvas, line, dot, origin,
  accent, accent2, ink, surface…) = today's exact values (zero visual change).
- Consumers re-pointed: atoms colCache, lattice/pixiworld/doomprojection rv()
  fallbacks, webtweaks ×4, uikit DEFAULT_COLORS + ink `#000000`, appearance.js
  presets, tweaks.js, persona.js numeric var-fallback (→ var(--border-rgb) clean).
- settings.js grid defaults: reads the canon (same values).
- GATES: canvas rigs green (atoms/lattice suites where present); the audit grep
  passes; boot on a FRESH profile (vars resolve, no flash).

### v1.04.5 — THE PERMANENT AUDIT RIG + THE LEDGER DOC
- scripts/v1040-discipline-audit.sh: (1) color-literal scan with the canonical
  allowlist (this doc §B) — fails on NEW violations; (2) surface scan — fails on
  any NEW body-appended full-screen UI outside {ConnectOverlay, artifacts sheet,
  chrome ladder}; (3) prints the z-ladder + surface ledger. Battery-wireable.
- docs/DISCIPLINE.md: the two rules, §B allowlist, §C ledger, the exception
  rationale — so future bots extend the system instead of relitigating it.
- RED-TEAM (human imitation, agent-browser): fresh engine+profile → boot, open
  Overlay (settings → colors → edit a field live), open Panel (drag between both
  snap points), open artifacts sheet (drag-dismiss), long-press message → action
  sheet, crop tool, theme switch midnight↔paper↔nebula, .doomtheme export/import
  round-trip — shadows/ink/contrast verified on dark AND light, zero console
  errors, zero rogue z-fighting.
- GATES: audit rig + full battery green.

### SHIP — v1.04.0-the-discipline
- version bump → wave tag → release (CI: APK + desktop + HF Space) → worklog.
- Before EVERY push: fetch origin, diff vs local, merge amicably (parallel bots),
  `go build -a` (the embedded-assets landmine), then publish.

## 2. THE SPAGHETTI BOUNDARY (will-NOT list)
- No DTCG refactor (future wave). No artifacts-drawer re-host (§C decision).
- No chrome relitigation. No new editor rows for derived shadows.
- No touching canonical data (schemes/picker/brand/canvas paint math).
- Stop condition: if a phase's change fans past ~6 files or needs a new
  abstraction layer, STOP and document instead.
