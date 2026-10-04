# PLAN-V099 — THE FIELD (the color system build order)

> Umbrella vision: PLAN-V098-COLOR-SYSTEM.md ("The Field & the Masks" —
> unchanged, canonical). Inputs feeding this build order:
> - docs/CENSUS-V099-SLOT-SCAN.md — the variable census (91 vars, 701
>   var-consuming rules, the overlap evidence, the colors-tab structure,
>   the canvas path, the `.doomtheme` shape)
> - docs/RESEARCH-V0982-ELEMENT-CATALOG.md — the 22-member swappable set
>   (~400 elements mapped file:line), the slot mapping (PART C), the
>   gradient-text tiers (PART E), the prune list (PART D)
> - docs/RESEARCH-V099-LIBRARY-SCAN.md — the consolidated library
>   manifest (verified SPDX/sizes) + the import security ladder + the
>   nested-box recipe
>
> Nothing in this doc re-litigates the ratified decisions — it sequences
> them into shippable phases with gates.

## THE GOAL (one screen)

10 customizable vars + 5 fmt slots + 3 grid slots **→ 7 fields**
(`--field-surface`, `--field-ink` (derived tones), `--field-accent-1..3`,
`--field-canvas`, `--field-fmt` with 5 named stops fed from accents).
Raised + hairlines + overlay-bg become DERIVED `color-mix(in oklch)`
products of surface+ink — the border-vs-surface fight ends by
construction. ONE raster per field per epoch; every colored object a
window. The Colors tab becomes 7 slot rows + one popover picker. All
per the approved plan, now with libraries assigned and the census
verifying the reassignment.

## IMPLEMENTATION DECISIONS (v0.99.3/.4 — measured, documented)

- **The derivation space is OKLAB, not oklch.** The rig
  (scripts/v099-field-parity.sh) caught the browser landmine: Chromium's
  `color-mix(in oklch, …)` renders near-achromatic inputs with a
  POWERLESS hue (serialized `oklch(… none)`) and paints them hue-0
  warm-gray — midnight/mono borders drifted 7/255 off the calibrated
  value. `color-mix(in oklab, …)` is degeneracy-free and culori matches
  it PIXEL-EXACTLY (parity rig worst diff = 0/channel). The calibration
  fits are identical in both spaces (all field pairs are hue-adjacent);
  the table below is unchanged.
- **The gradient-twin aliases.** Only FIELDS hold gradient twins
  (--field-X-gradient); the ~60 consumer sites keep their historical
  spellings (--surface-1-gradient, --accent-N-gradient) as pure aliases
  applyTheme writes both. Zero consumer churn in .4.
- **The JS hex boundary.** @property-registered fields compute to
  'rgb(…)' and derived vars keep unevaluated 'color-mix(…)' streams, so
  every JS consumer that needs a REAL hex (canvas arrows, Pixi fills,
  the Kotlin panel, atoms' rings) resolves through
  DoomTheme.resolvedThemeVar (fields via the block cache, derived names
  via FieldMath culori) instead of getComputedStyle.
- **uikit's HSL recipe math stays.** The plan said route
  shadeHex/lighten/darken/mixHex through culori — but those outputs are
  byte-pinned by 140 test assertions AND every saved user gradient; oklch
  rerouting would change every recipe's look. Picky call: culori owns the
  NEW field derivations (the CSS-parity truth); the HSL recipes are a
  settled contract.
- **Ink is solid-only** (the dual track): a legacy --text-1 gradient
  override folds to its FIRST COLOR; text gradients live in the fmt field.

## THE RATIFIED SLOT MODEL (from v0982 PART C — unchanged)

| Today | Field model |
|-------|-------------|
| `--surface-1` (panels/cards/bubbles) | `--field-surface` (the plate) |
| `--surface-2` + `--surface-3` (ghost) + `--raised-chrome` | DERIVED: `color-mix(in oklch, var(--field-surface), var(--field-ink) 6%/14%)` |
| `--border` + `--border-strong` + `--raised-ring` | DERIVED: `color-mix(in oklch, var(--field-surface), var(--field-ink) 18%)` — ONE hairline owner |
| `--text-1/2/3/-dim` | `--field-ink` + color-mix tints (ink is never a window) |
| `--accent` + `--accent-2/3/4` | `--field-accent-1..3` (accent-4 folds into the tone-pair system) |
| `--bg-panel` + grid bg | `--field-canvas` (solid/gradient/image → the field atlas) |
| `--bg-app` | DERIVED from `--field-surface` |
| `--fmt-a1/a2/a3/bright/link` | `--field-fmt` (5 named stops, accent-fed defaults) |
| grid line/dot/origin | `--field-canvas` children (lattice already consumes a spec object, not CSS vars) |
| `--ok/--warn/--err/--notice`, persona/template tints | SYSTEM colors (theme-carried, not user slots) |

**Reassignment walk (the census specifics — phase v0.99.5):** the 74+
divider/hairline rules on surface-2/3 → the derived hairline; the
border-as-fill minis (scrollbar thumb :1926, handle-bar, press states)
→ derived hairline (renamed honestly as "thin things"); the ghost
surface-3 splits fills→raised / strokes→hairline by census B; the 16
text-vs-accent rules migrate to ink tones unless interactive/active
(the accent rule: actionable or active only); `BLOCK_READ_SET` gains
`--border` (census finding 6); the usage-panel surface-2 divider leak
(usagepanel.js:42) rides the general hairline derivation.

**CSS floor (verified):** WebView 111+ for `oklch()`/`color-mix()`;
`@property` (85+) registers every field var; slots flip ONCE per
theme-apply — never per frame (the v092 orbit storm is the standing
counter-example).

---

## THE WAVES (phase cadence — every phase pushes, per the standing rule)

### v0.99 THE FIELD (the slot model + the picker)

- **v0.99.1 ✅ (shipped this turn):** the census
  (docs/CENSUS-V099-SLOT-SCAN.md) + the library decision record
  (docs/RESEARCH-V099-LIBRARY-SCAN.md).
- **v0.99.2 ✅ (shipped this turn):** this build order.
- **v0.99.3 ✅ VENDOR:** culori 4.0.2 (`vendor/culori/culori.min.js`, IIFE,
  23.3KB gz) + @floating-ui/dom 1.8.0
  (`vendor/floating-ui/floating-ui.dom.umd.min.js`, 4.0KB gz) + LICENSE
  files into `vendor/licenses/`. index.html gains the two script tags
  (before theme.js — culori is used by theme/uikit/lattice; the Go
  embed picks up the files automatically). Route uikit's
  shadeHex/lighten/darken/mixHex/hslToHex/rgbToHsl + lattice quantColor
  + theme OKLab blends through culori (same call sites, one math truth).
  **Gate:** boot smoke (0 errors), theme twins 165/165, uikit 140/140,
  go build/vet/test.
- **v0.99.4 ✅ SLOTS (SHIPPED, gates green:**
  twins 196/196 · uikit 140/140 · v099-field-parity 5/5 (the NEW rig:
  CSS≡JS pixel-exact + drift ≤ 0.028 + 10-theme cascade + triplets) ·
  v098 panel 21/21 (257 nodes) · v097 oneobject 29/29 · v092 orbit-rest
  13/13 · v0911 native-layer3 12/12 (re-pinned to the field contract) ·
  go build/vet/test green):** theme.js implements the 7-field model with
  `@property` registration; legacy vars become derived aliases on the
  same epoch (`--surface-2: color-mix(...)` etc. — index.html rules keep
  working UNTOUCHED during migration, the reassignment is CSS-free until
  v0.99.5); the themeOverrides storage gains the field shape (legacy
  folds on read — the lookio.js loader pattern). Grid Colors rides
  `--field-canvas` children. **Gate:** the 165-twins suite + a NEW
  `scripts/v099-field-parity.sh` (pixel-parity of a boot screen before/
  after the alias flip — mean diff < 1/255 class) + the v098 panel rig
  (289-node class holds).
- **v0.99.5 REASSIGN:** the census walk above (the index.html + JS
  consumers move OFF the entangled vars onto the derived aliases; the
  v0982 PART C 8 findings each get fixed + verified). **Gate:** a NEW
  `scripts/v099-reassign-audit.sh` — per finding: before/after computed
  style of the affected selectors + a visual-parity probe per screen
  (the 8 findings are the checklist).
- **v0.99.6 TAB:** the Colors tab becomes 7 slot rows, 2 nesting levels
  (section → slot row; the GradientUI internals collapse into the
  popover): one picker per slot — solid / gradient / image tabs,
  floating-ui anchored, live preview in-popover. GradientUI slims:
  styles 8 → 2 (linear/radial) + angle + stops; patterns 5 → 1 (texture);
  the fmt row family collapses to the single field-fmt row (per-chat
  tweaks unchanged). **Gate:** the v098 panel rig (mount ≤ 289 nodes,
  0 longtasks — the slot count cut should land well under), the
  interaction rig (expand/interact in-place), pickr-class popover open/
  close/flip assertions.
- **v0.99.7 NESTED BOXES:** the settings-wide recipe — cv:hidden on
  collapsed panes, cap-open accordion per section, cv:auto +
  `contain-intrinsic-size` on offscreen rows, L2 read-phase discipline
  preserved (no forced reads on skipped subtrees). Applies to General/
  Sizing/Tweaks/Webtweaks/Usage/Persona too — the user's report was the
  whole settings surface, not just Colors. **Gate:** a NEW
  `scripts/v099-settings-open.sh` (open + expand-all + collapse-all +
  reopen on every tab: 0 long tasks, node counts, second-open reuse via
  cv:hidden state preservation).
- **v0.99.0 WAVE SHIP:** full battery (twins, uikit, v097 oneobject,
  v092 orbit-rest, v0911 native-layer3, v098 zoom/tiling/panel rigs) +
  version bump + APK + tag `v0.99.0-the-field`.

### v0.100 THE MASKS (pseudo-only + the artifact class dies)

- L2 pseudo-only (the legacy inline bake retires); the plate/ring
  3-layer stack → 2 (surface window + derived hairline ring) — kills the
  v097 overlap-artifact class AND the colors-panel transient artifacts
  the user reported; the `#proj-layer-styles` observer exclusion stays.
- Gradient-text tiers (v0982 PART E + the refinement): body/long text =
  solid ink (color-mix) — NEVER a window; short static gradient moments =
  local-box clip (one paint, no per-scroll re-projection) unless the
  shared-field illusion is load-bearing → L2 layer; hero/animated = Pixi
  via **BitmapText fill or RenderTexture bake** (NOT raw Text+
  FillGradient — upstream #10595/#10926; rig-gate any exception).
- @tanstack/virtual-core lands: the model-catalogue rows + the hub
  library grid (the two screens where the census + the user's own
  "catalogue is the busiest screen" report meet); bounded lists keep
  content-visibility.
- The cheap consolidations ride: toast ×6 → 1, keys.js rogue overlay →
  Overlay (kills the last hardcoded `rgba(0,0,0,.48)`), localmodels
  double-✕, the amber star → accent system.
- **Gates:** native-layer3, orbit-rest, a NEW mask-parity rig (theme
  flip + scroll + drag with pixel probes), the catalogue rig with
  virtualization on.

### v0.101 THE ASSETS (everything becomes a swappable image)

- fflate + maxrects-packer + compiled Ajv validators vendored; MCU
  (Apache-2.0) lands as the image→accents suggester (HCT at
  generation-time only — it never becomes a second runtime truth).
- User-uploadable field images (the field atlas: maxrects packing,
  2048² clamp, `MAX_TEXTURE_SIZE` query, spill to bins); 9-slice shape
  assets per member class (Pixi `NineSliceSprite` on the canvas side,
  CSS `border-image` + `mask` compositing in the DOM — WebP-first
  assets, DOMPurify on every imported SVG).
- The icon-pack registry: homegrown sprite + the Iconify JSON import
  format; theme bundles can swap icon sets by name (the RRO pattern).
- `.doomtheme` v2: zip container (manifest.json DTCG tokens with
  `$extensions["com.doomalay"]` + assets/ + fonts/) behind the full
  import security ladder; v1 JSON folds on read (lookio compat).
- The Library card member becomes user-designable (the hub's existing
  card-design system + the bundle manifest); wunderbaum + the
  duplicated `.artt-*` tree CSS pruned.
- **Gates:** an asset-picker rig, a security rig (fuzzed/corrupt/
  oversized/traversal/zip-bomb bundles all rejected cleanly), a
  round-trip rig (export → import → identical computed fields), the
  full battery.

### v0.102 THE LIBRARY (the public-sharing endgame)

- Hub publish/browse/download/apply of v2 bundles (hubpublish.js is the
  existing rail); per-user bundle looks reflected to every browser (the
  Library card carries the bundle's own design); download counts +
  hearts already exist. **Gates:** the security rig at GA strictness +
  an end-to-end "stranger's bundle" red-team pass (the ladder, every
  rung exercised by a hostile corpus).

## THE SWAPPABLE-ELEMENT CONTRACT (the 22 members — v0982 PART A, ratified)

Every member renders from the same recipe: **a 9-slice/raster asset (or
the field window where no shape is needed) + the member's slot
assignment + the system layers** (icon set, typography, sketch-stroke,
tone pairs). New UI ships ONLY as members (plus the panel/overlay
screens per the standing rule). The member list is CLOSED — a new
visual need either maps to a member or triggers a census + a deliberate
set-change decision, never a one-off styled box.

## WHAT WE ARE NOT DOING

- Everything PLAN-V098-COLOR-SYSTEM.md lists (no runtime CSS compiler,
  no per-element re-raster in motion, no WebGL DOM painting, no twins
  breakage).
- No component-library adoption (Shoelace/Web Awesome/Lion/UI5 — the
  22-member set IS the contract; port behaviors, never styles).
- No chroma.js (BSD-3-Clause code — corrected record in the library
  scan), no Iconify runtime, no OverlayScrollbars, no full Motion
  engine, no GSAP (standing v0.96 verdict).
- No MCU in the runtime derivation path (HCT ≠ OKLCH — one truth).
- No new native screens, no build step (vendored files only), no slot
  count growth past 7 without a user decision.
