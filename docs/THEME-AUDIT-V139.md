# THEME-AUDIT-V139 — the element→theme-variable inventory + violation report

> **EXECUTED in v1.39.2 THE RESLOT**: all 9 violations re-slotted (the
> table's "proposed re-slot" column is now the shipped code), G1 closed
> (`--border-strong-rgb` rides `TRIPLET_VARS`), G2 folded (the duplicate
> v0.45 `--bg-app-rgb` block retired — the main `[data-theme]` blocks
> carried identical values, verified pair-by-pair), F1 retired (the dead
> `theme-changed` listeners), F2 fixed (atoms' `theme-applied` cache
> reset), F3 re-slotted (the two canvas soft fallbacks ride the canon).
> **The pin's ledger is EMPTY** — zero literal colors outside the
> canonical zones; the census's line ranges re-anchored to the edited
> tree. Verify: v1390 30/30 · v1391 10/10 · pin PASS · audit 7 PASS
> (+ the documented pre-existing B1).

> The audit the user ordered: "GOAL: a complete element→theme-variable
> inventory + violation report" over the embedded web tree
> (`engine/internal/server/web/`, the go:embed root). Read-first docs
> honored: PLAN-V098-COLOR-SYSTEM.md, PLAN-V091-COLOR-REWORK.md,
> docs/RESEARCH-COLOR-REWORK.md — the slot semantics below come from them.
>
> And the enforcement deliverable: **the source pin** —
> `scripts/v1390-theme-source-pin.py` + `scripts/v1390-theme-pin-baseline.json`,
> wired as gate **A5** into `scripts/v1040-discipline-audit.sh`. Any NEW
> literal color outside the canonical zones now fails the battery.

## 0. THE INTENDED MODEL (from the three read-first docs)

- **PLAN-V098 (THE FIELD & THE MASKS)**: one field per slot —
  `--field-surface` (panels/cards), `--field-ink` (the text family,
  solid-only), `--field-accent-1..3`, `--field-canvas` (the world);
  every colored object is a WINDOW onto its slot's field.
- **PLAN-V091 (Track 1, CSS-native)**: the derivations are
  `color-mix(in oklab, …)` in the `:root` block (index.html); theme.js's
  `DERIVED_MIXES` is the culori-parity JS twin; `OKX` is the perceptual
  core; GATES skip self-deriving (`color-mix`) rules.
- **RESEARCH-COLOR-REWORK**: stop compiling colors in JS — the browser
  derives the DOM side, the GPU draws the gradients, JS keeps a thin
  color-math layer only where JS must know a color (canvas, exports).

The shipped system matches the model: **6 fields + 2 elevation extras**
(`--field-shadow`, `--field-highlight`, the v1.06.4 exposure) drive
everything; 10 themes × `[data-theme]` blocks carry the field values +
per-theme semantic tones (`--ok/--warn/--err/--notice`) and accent-4.

## 1. THE INVENTORY (STEP 1 + STEP 2, the numbers)

- **1136 literal-color occurrences** across 61 files (vendor excluded),
  fully classified by `scripts/v1390-theme-census.py`
  (`scripts/v1390-theme-census.csv` is the row-per-occurrence ledger):
  | zone | count | what it is |
  |---|---|---|
  | var-composition | 558 | `rgba(var(--x-rgb), α)` — the sanctioned pattern |
  | theme-def | 127 | index.html `:root`/`[data-theme]`/`@property` blocks |
  | engine | 114 | theme.js (FIELDS/DERIVED_MIXES/FALLBACKS/onColorFor) |
  | gradient-engine | 105 | uikit.js rendering USER spec colors (data, not chrome) |
  | fmt | 51 | formatter.js SCHEMES (the 10 fmt palettes) |
  | not-a-color | 43 | id selectors, url(#) refs, indexOf('rgba('), mask shapes |
  | picker | 36 | themeeditor HSV wheel + the index.html .te-* wheel |
  | brand | 29 | provider/family identity colors (chatsview/app/config) |
  | mask-shape | 14 | `linear-gradient(#000 0 0)` mask cutouts (alpha, not paint) |
  | dynamic-var-composition | 48→7 | `'rgba(' + triplet + ',α)'` with provenance |
  | var-fallback | 12 | `var(--x, #fff)` dead in-var fallbacks |
  | media-black | 8 | YT letterbox + PiP theater (surfaces with no theme DOM) |
  | ink-on-art | 7 | hub.js WCAG ink + the hash-of-id generated art |
  | self-test | 98 | uikit `_selftest` oracle hexes (test data) |
  | other adjudicated | remainder | canon markers, zero-points, probes, crop, converters |
- **188 distinct `--var` tokens** appear in the tree (minus template
  placeholders); the JS write set (setProperty/ledger `want`) lives in
  theme.js (the diffed-ledger writer), doomprojection, workspace,
  appearance, tweaks, chatpanel, gesture.
- **Consumption**: index.html consumes `var(--…)` 1320×; the JS getComputedStyle
  reads are concentrated in theme.js/appearance/atoms/pixiworld/browserdock
  (+ doomprojection's panel-vis reads). No `var()` read resolves without a
  definition surface (section 4).

## 2. THE VIOLATIONS (STEP 4 — hypothesis 1 CONFIRMED, small and enumerable)

**9 tokens / 7 sites.** These are the only literal colors outside the
canonical zones in the whole tree — the pin's baseline enumerates each.

| surface | element (selector/id) | file:line | semantic slot | vars used | hardcoded? | theme gap? | proposed re-slot |
|---|---|---|---|---|---|---|---|
| Panel | the Shadow row's editor seed fallback | appearance.js:953 | --field-shadow (elevation) | `DoomTheme.derivedShadowHex(st) \|\| '#020202'` | YES | yes — FALLBACKS.shadow exists and is the exact same value | `\|\| DoomTheme.FALLBACKS.shadow` |
| Panel | the Highlight row's editor seed fallback | appearance.js:956 | --field-highlight (elevation) | `derivedHighlightHex(st) \|\| '#ffffff'` | YES | yes — FALLBACKS.highlight exists | `\|\| DoomTheme.FALLBACKS.highlight` |
| Panel | the Ink row's editor seed fallback (js) | appearance.js:1003 | --field-ink | `spec.colors[0] \|\| '#e0e0e8'` | YES | yes — FALLBACKS.ink is midnight's ink | `\|\| DoomTheme.FALLBACKS.ink` |
| Panel | the Ink row's `<input type=color>` value fallback | appearance.js:1007 | --field-ink | same shape | YES | yes | `\|\| DoomTheme.FALLBACKS.ink` |
| Canvas (world) | the DOM-twin art fallback paint (no url, no accent) | pixiworld.js:432 | --field-accent-1 | literal `rgba(167,139,250,0.9)` = midnight's accent | YES | yes — the exact fallback-drift the FALLBACKS canon exists to kill | compose `rgba(' + triplet(FALLBACKS.accent) + ',0.9)'` (the atoms.js `colors()` shape) |
| Chat | `.chat-search-mark` highlight | index.html:3384 | --warn family (semantic tone) | literal `rgba(250,204,21,0.35)` | YES | yes — every theme carries --warn-rgb | `rgba(var(--warn-rgb), 0.35)` |
| Chat | `.chat-search-mark.chat-search-current` bg | index.html:3385 | --warn family | literal `rgba(250,204,21,0.85)` | YES | yes | `rgba(var(--warn-rgb), 0.85)` |
| Chat | the current-mark ink | index.html:3385 | on-warn ink | literal `#1a1a0e` | YES | yes — the on-color constants precedent (--on-ok) | `var(--on-ok)` (the near-black readable ink on a warn fill) |
| Panel | `.panel-header .avatar` glyph ink | index.html:1076 | on-accent-2 ink (the .wsp default tone is accent-2) | literal `#fff` | YES | yes — light themes' bright accents break the white glyph (onColorFor picks dark ink there) | `color: var(--on-accent-2)` |

Severity: all are LOW visual impact (two are dead fallbacks whose live
paths already derive correctly; the search-mark yellow is theme-blind;
the avatar ink only misreads on bright accents) — but each is exactly the
drift the discipline forbids, and the pin now holds the line at nine.

**Negative-test receipt**: injecting `#ff0044` into hubitem.js → pin FAILS
(`NEW literal color outside the canonical zones`); fixing a violation
without updating the ledger → pin FAILS (STALE); zone markers rotting →
pin FAILS. Restored to green after each probe.

## 3. THE CANVAS LAYER (STEP 3 — the resolution paths + the timing contract)

| file | reads | conversion | cache | theme-flip re-resolution |
|---|---|---|---|---|
| lattice.js (#c/#c2) | `DoomTheme.effectiveGrid(Specs)(s)` — the THEMES[id].grid palette → specs | `gridPaint` → `lcPaint` (cache keyed by spec+fallback+WxH) → `quantColor` (64-level) | LC.paints/sprites (keyed, bounded) | Settings.onChange → canvasFingerprint (carries the P.t hexes) → scheduleCanvasUpdate → the P blob re-resolves → repaint. The worker twin (gridworker.js) carries PRE-RESOLVED hexes (zero literals in the file). SOUND |
| atoms.js (shells/stars) | `--accent-rgb`/`--accent`, `--accent-2-rgb`, `--border-strong` via `DoomTheme.resolvedThemeVar`, `effectiveGrid().originColor` | `triplet()` → `rgba(triplet,α)` strings | colCache, **1s TTL** | **NO theme-applied listener** — re-resolves only through the TTL (≤1s stale ring/star tint after a flip). Finding F2 below |
| pixiworld.js (the world layer) | everything via `DoomTheme.resolvedThemeVar` (--surface-2/-1, --text-1/2/3-dim, --bg-app, --ok, --accent/2, --border-strong, --card, --shadow-ink) + FALLBACKS canon | `hexToInt` (fallback 0xffffff), `tripletToInt` (the v0.88 white-star fix) | colCache 1s TTL **but reset on the theme event** | `doomalay:theme-applied` → `themeStamp++` + colCache reset + sync + layoutAtoms + poke → every icon fingerprint carries themeStamp → full re-raster; the shell ATLAS re-keys on `themeStamp\|r,g,b` → re-bake. **This is the Pixi-atlas-reinit contract — intact** |
| app.js (bg/rainbow/arrow) | `effectiveGrid(Specs)`, `canvasBgSpec`, `resolvedThemeVar('--accent')` | hexToRgb → HSL tone | rainbowToneCache | theme-applied listener → resetRainbowTone; canvasFingerprint path above. The chatbot family tint re-derives INSIDE applyTheme (derived border-strong, culori parity) |

Timing contract verdict: **theme flip → #c/#c2 repaint + Pixi atlas re-init
holds**. Findings:

- **F1 (dead event)**: `doomalay:theme-changed` is listened to by app.js:378
  and pixiworld.js:946 but dispatched by NOBODY (only `doomalay:theme-applied`
  fires, theme.js:1000). Harmless dead code — retire the two listeners or
  dispatch it, one or the other.
- **F2 (the 1s TTL lag)**: atoms.js registers no theme event, so the DOM
  atom shells (and pixi's shell atlas via `Atoms.colorsFor()`) can paint the
  PREVIOUS theme's ring/accent for up to 1s after a flip. The verify rig
  measured the re-resolve inside 1.3s. Proposed re-slot: add a
  `theme-applied` listener that zeroes `colCache.at` (the pixiworld.js:941
  shape, 3 lines).
- **F3 (fallback literals inside the canvas files)**: pixiworld.js:432's
  `rgba(167,139,250,0.9)` (in the violation table) and the two soft
  fallbacks `0x5b5b6b` (shellAtlasFrames' hexToInt fallback) +
  `'120,130,140'` (atomColors' ring fallback) — both differ from
  FALLBACKS.borderStrong `#34344a`, the exact drift the canon forbids.
  They only bite when DoomTheme/Atoms are absent (never in the app; the
  rig harnesses stub them) — re-slot them to the canon when touched.

## 4. THE THEME-SET GAPS (STEP 5 — hypothesis 3 PARTIALLY CONFIRMED)

`scripts/v1390-theme-gaps.py` parsed every definition surface:

- **The 6 fields + --accent-4 + ok/warn/err/notice: defined in ALL 10
  `[data-theme]` blocks + :root. NO gaps.** theme.js THEMES meta: all 10
  ids × 4 grid keys — complete. formatter.js: 10 schemes × 5 slots
  (a1/a2/a3/bright/link) — no slot drift.
- **Root-default-only vars (intentional)**: the derived set (--surface-2/3,
  --card, --border[-strong], --bg-app, --text-2/3[-dim], --shadow-ink,
  --raised-chrome/ring) is :root-only BY DESIGN — applyTheme re-derives
  every one per apply (DERIVED_MIXES + TRIPLET_VARS, culori parity). The
  chrome constants (--on-accent/-brand/-ok, --veil-ink, --highlight-inset,
  --text-shadow, sizes) are :root statics by design (the --on-brand precedent).
- **--persona-tint/--template-tint (and -rgb): overridden only by
  paper+frost** (the documented light-theme contrast overrides; the dark
  themes ride the :root values). Intentional, documented in the v0.33 block.
- **GAP G1 — `--border-strong-rgb` has NO definition surface**: read by
  appearance.js:339 as `var(--border-strong-rgb, 52,52,74)` — the dead
  fallback literal (52,52,74 = midnight's border-strong) is the ONLY thing
  that ever resolves. It is missing from theme.js TRIPLET_VARS. Re-slot:
  add `'--border-strong-rgb': '--border-strong'` to TRIPLET_VARS (one line;
  applyTheme then derives it for every theme) and drop the literal fallback.
- **GAP G2 — the `--bg-app-rgb` definition split**: the per-theme
  boot-fallback statics for --bg-app-rgb live in a SECOND `[data-theme]`
  block set at index.html:6045-6056 (the v0.45 statics) while every other
  triplet static lives at ~100-110. Both are boot-only (applyTheme
  re-derives at runtime) — a coherence note, not a bug: fold the late
  block into the main static block when someone is in there next.
- **READ-BUT-UNDEFINED sweep**: after folding in the JS writers and the
  JS-injected stylesheet strings (the `.artt` component-scoped props,
  the `--fmt-*` dynamic construction, the `--wsp-*` provider map, the
  `--proj-*` physics pokes, the `--panel-vis-h` streaming var), **no var()
  read lacks a resolution path**. G1 is the one real hole.

## 5. THE ENFORCEMENT (the rig pin — house convention)

- `scripts/v1390-theme-census.py` — the classifier (the zone table IS the
  documentation; every range zone carries an anti-rot marker the pin checks).
- `scripts/v1390-theme-pin-baseline.json` — the committed ledger: exactly
  the 9 violations, keyed `file:line:kind:token|zone`.
- `scripts/v1390-theme-source-pin.py` — the pin: census → diff vs baseline
  → fail on NEW / STALE / rotted markers. `--update` is the explicit,
  reviewed regeneration path.
- `scripts/v1040-discipline-audit.sh` gate **A5** — wired into the battery
  (`PASS A5-source-pin-census-baseline`).
- docs/DISCIPLINE.md's law holds: extend allowlists WITH THE REASON, never
  delete a gate. The B1 body-appender failure on today's main is
  PRE-EXISTING (ota.js/termuxsetup.js joined after v1.04.5) — its upkeep
  belongs to that wave, documented here so it isn't lost.

## 6. VERIFY (the receipts)

- `scripts/v1390-theme-verify.py`: **30/30 PASS** — all 10 themes flip via
  the API AND via the theme_editor UI card (`data-action="set-theme"`);
  effectiveGrid bg / meta theme-color / family tint / computed --accent are
  10-for-10 distinct; the atoms cache re-resolves across the flip;
  ocean-re-apply settings chrome is pixel-IDENTICAL (deterministic
  re-derivation) while ocean-vs-frost is pixel-DIFFERENT; zero page errors.
  Screenshots: `.rig/v1390-<theme>.png`.
- `bash scripts/v1040-discipline-audit.sh`: A1/A2/A3/A4/A5/C1/C2 PASS
  (B1 pre-existing, section 5).
- Battery: theme twins 198/199 and uikit 140/140 — both on the documented
  baseline (the twins' "page 6 slot banners" failure exists on clean main;
  confirmed by stash-test).
- The pin's own red-team: new literal → FAIL; stale ledger → FAIL;
  marker rot → FAIL; restored → PASS.
