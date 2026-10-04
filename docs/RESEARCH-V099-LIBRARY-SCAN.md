# RESEARCH-V099-LIBRARY-SCAN — the consolidated final library decision record

> The user's ask (2026-10-04): "research more about any opensource mit or
> apache frameworks or libraries we can integrate… Choose a library over
> home grown from scratch… look at the things we currently are doing from
> scratch in the plan, and check for swappable libraries that can get this
> job done."
>
> This doc CONSOLIDATES this turn's four parallel research streams (2-a
> color engines · 2-b UI primitives · 2-c text/atlas/bundles · the repo
> census) with RESEARCH-V0982-ELEMENT-CATALOG.md (the parallel wave's
> element catalog + swap study) into ONE decision record for the
> v0.99–v0.101 build. Every license, version and size below was verified
> first-hand — npm registry JSON, raw LICENSE files from the shipped
> tarballs, measured gzip of the actual dist files — nothing from memory.
> Artifacts: tool-results/v099-research/ (search JSONs + fetched primary
> sources) and docs/CENSUS-V099-SLOT-SCAN.md (the variable census).

---

## THE DECISION TABLE (everything homegrown, adjudicated)

| # | Homegrown today | Decision | Library / format | SPDX (verified) | Version | Cost (gz) | Lands |
|---|-----------------|-----------|------------------|-----------------|---------|-----------|-------|
| 1 | uikit.js color math (`shadeHex`/`lighten`/`darken`/`mixHex`/`hslToHex`, L188-276) + lattice `quantColor` (lattice.js:155-194) + theme.js OKLab blends (L565-577) | **SWAP** | **culori** | MIT | 4.0.2 (2025-06-27, active) | 23.3KB (prebuilt IIFE + ESM + UMD all ship in the tarball) | v0.99 |
| 2 | Popover/dropdown anchoring (the v0.99 slot picker + every Select box member) | **SWAP** | **@floating-ui/dom** | MIT | 1.8.0 (2026-07-11) | 4.0KB (UMD + browser ESM) | v0.99 |
| 3 | Long-list windowing (model catalogue rows, hub library grid, chat search) | **SWAP** | **@tanstack/virtual-core** | MIT | 3.17.11 (2026-09-14, 0 deps) | 7.0KB (ESM; `Virtualizer` class is framework-native vanilla) | v0.100 |
| 4 | `.doomtheme` v2 container (images/shapes/fonts cannot ride bare JSON sanely) | **SWAP** | **fflate** | MIT | 0.8.3 (2026-05-16, 0 deps) | 12.6KB (UMD global `fflate`, workers auto-spawned) | v0.101 |
| 5 | Field-atlas packing of user-uploaded theme images | **SWAP** | **maxrects-packer** | MIT | 2.7.3 (2022-02-02 — finished algorithm, 0 deps) | 3.3KB (UMD global `MaxRectsPacker`) | v0.101 |
| 6 | Untrusted bundle validation | **SWAP** | **Ajv standalone** | MIT | 8.20.0 (2026-04-24) | ~KBs (author-time-compiled validators; zero runtime Ajv, CSP-safe, no `new Function`) | v0.101 |
| 7 | Image → accents (user picks an image → every slot derives) | **SWAP** | **@material/material-color-utilities** | Apache-2.0 | 0.4.0 (2026-01-21, active) | 25.2KB (ESM single-file via `+esm`; HCT at generation-time only, never a second runtime truth) | v0.101 |
| 8 | `.doomtheme` keys | **ADOPT FORMAT** | **DTCG 2025.10** (Design Tokens Community Group) | open spec + official draft-07 JSON Schema | spec 2026-09-08 | 0 (it's our bundle's JSON shape) | v0.101 |
| 9 | 9-slice scaling · GPU text · field atlas | **ALREADY VENDORED** | PixiJS v8.21.0 (`NineSliceSprite`, `RenderTexture`, `FillGradient`) | MIT | vendored | shipped | v0.100/101 |
| 10 | GradientUI editor (1,628 lines) | **KEEP** | — (no maintained permissive vanilla gradient editor exists — proof below) | — | — | — | — |
| 11 | L2 field windows · panel drag · canvas lattice | **KEEP** | — (this IS the optimization; compositor-only, bake-once) | — | — | — | — |
| 12 | Icon system (Lucide 52 glyphs + registry) | **KEEP + format** | Iconify JSON as the theme icon-pack IMPORT format (data only — never the runtime) | ISC (Lucide) / MIT (data) | — | 0 | v0.101 |
| 13 | Scrollbars | **KEEP NATIVE** | `::-webkit-scrollbar` CSS theming (a themed visual for the chrome slot) | — | — | 0 | v0.99 |
| 14 | Micro-transition animation | **NO SWAP** (optional: `motion/mini`, WAAPI-only, 2.8KB — full engine REJECTED, see below) | — | — | — | — | — |

**Adopt-weight math for v0.99:** culori 23.3 + floating-ui 4.0 = **27.3KB
gz** of new vendored code — offline, classic-script compatible, all MIT.
The v0.101 additions (fflate + maxrects + validators + MCU) total ~44KB,
of which MCU is opt-in per feature.

---

## THE FIVE ADOPTS BEYOND RESEARCH-V0982 (the deltas, verified)

### 1. @floating-ui/dom — the picker/popover/select anchor
- `computePosition` + `offset/flip/shift/size/hide/inline/arrow` middleware
  + `autoUpdate` (observers only while open). The ex-Popper engine Radix/
  Base UI build on. Zero styling — our masks stay ours.
- Maps to: the **v0.99 slot picker popover** (anchored to each slot row),
  every **Select box** member (send-menu, long-press menu, native-select
  replacements), tooltips, the model-browser compare drawer.
- Perf: one positioning call on open; no rAF loop; negligible on 2-4GB
  phones. Keyboard nav stays ours (~40 lines) — the helpers live in the
  React packages we don't ship.
- Note: CSS anchor positioning (Chrome 125+) covers only the simple cases
  and needs WebView 125; floating-ui is the collision/adaptive layer that
  works on the 111 floor.

### 2. @tanstack/virtual-core — the list windowing engine
- Genuinely framework-agnostic: `new Virtualizer({count, getScrollElement,
  estimateSize, overscan})` → `getVirtualItems()` → `measureElement(node)`
  (verified in the shipped dist; the framework adapters just wire these
  built-ins). Zero dependencies, `sideEffects:false`.
- Decision rule (web.dev-corroborated): **unbounded/streaming → windowing;
  bounded/moderate → content-visibility.** In our app: the model catalogue
  rows and the hub library grid qualify; the (post-v0.99, short-by-design)
  colors slot list does NOT — it keeps content-visibility.
- Maps to member **List renderer** + the hub **Library card** grid.

### 3. fflate — the bundle container
- UMD global build, streaming `Zip`/`Unzip`, files to 4GB, async APIs
  auto-spawn Workers.
- Zip-bomb defense is DOCUMENTED: `unzipSync(data, {filter: f =>
  f.originalSize <= LIMIT})` — `originalSize` is exposed per-file before
  decompression. Zip-slip: fflate never touches the filesystem (returns
  `{name: Uint8Array}`) — path normalization is OUR job (below).
- Why a container at all: DTCG tokens + user images + 9-slice shapes +
  optional fonts cannot ride one bare JSON without base64 bloat; zip keeps
  the manifest human-readable (manifest.json + assets/ + fonts/).

### 4. maxrects-packer — the field-atlas packer
- UMD + ESM, `add/addArray/repack`, `OversizedElementBin` fallback for
  art too big for the atlas. Default max edge 4096 → we clamp 2048 for
  the low-end GPU class (a 2048² RGBA atlas = 16MB decoded; 4096² = 64MB).
- Runs once per theme-epoch import — milliseconds for dozens of images;
  zero steady-state cost. The lattice tile atlas stays homegrown
  (deterministic, budget-guarded — see PLAN-V098); maxrects is for the
  ARBITRARY user-uploaded images of v0.101.

### 5. Ajv standalone — the untrusted-bundle validator
- The official standalone mode compiles our `.doomtheme` schema to plain
  JS functions at AUTHORING time → we vendor kilobytes of validators, ship
  no Ajv at runtime, and never call `new Function` (CSP-safe).
- Model: trusted schema, untrusted DATA — Ajv's own documented
  security stance (ajv.js.org/security: "Ajv treats JSON schemas as trusted
  as your application code"). Hardening we inherit: no `allErrors` in
  production, `maxLength`/`maxItems` caps on slow vectors (pattern /
  uniqueItems), no circular refs.
- DTCG publishes an official draft-07 JSON Schema
  (designtokens.org/schemas/2025.10/format.json — fetched, 56.5KB); we
  extend it with `$extensions["com.doomalay"]` for our asset/shape/member
  bindings. Ajv consumes draft-07 natively.

### THE IMPORT SECURITY LADDER (public-library bundles — v0.101/v0.102)
1. Byte-cap the archive BEFORE parse (e.g. 32MB).
2. `filter` every entry: `originalSize ≤ cap` (zip-bomb), file-count cap.
3. Reject encrypted/unknown-compression entries.
4. Normalize + allowlist paths: strip leading `/`, reject `..`, only the
   manifest's declared asset names (zip-slip).
5. MIME allowlist: WebP/PNG/JPG/SVG/woff2/json only.
6. **DOMPurify every SVG** (already vendored) before it ever renders.
7. Ajv-validate the manifest BEFORE decoding assets.
8. Atlas clamp 2048² + `gl.getParameter(gl.MAX_TEXTURE_SIZE)` query; spill
   to multiple bins, never grow past the cap.

---

## CORRECTIONS + REFINEMENTS ON RESEARCH-V0982 (we agree; these amend)

1. **chroma.js license record:** npm says `(BSD-3-Clause AND Apache-2.0)`
   — the CODE is BSD-3-Clause (clause 3 no-endorsement); Apache-2.0 covers
   only the bundled colorbrewer data. The v0982 table's "Apache-2.0" is
   incorrect. Verdict unchanged (REJECT — culori dominates on packaging,
   OKLCH-first design, and prebuilt browser bundles), but the record now
   matches reality: chroma is OUTSIDE the MIT/Apache-only rule.
2. **Pixi Text+FillGradient carries two live upstream bugs** (#10595 style
   regression, #10926 documented-gradient-does-not-apply). The GPU text
   tier of v0982 PART E should ride **BitmapText fill** (no glyph re-raster
   on fill change — the atlas quads re-tint) or a **RenderTexture bake**
   (the pixiworld per-fingerprint epoch model), NOT raw `Text` +
   `FillGradient`. Any Text+FillGradient use gets rig-gated.
3. **The vendored Pixi is v8.21.0.** The "11.4.7" string found by grep is
   not a Pixi version (bundle header reads `PixiJS - v8.21.0`; npm
   dist-tags show no v11 exists). All v8 APIs cited by both docs apply.
4. **The CSS-native floor (verified via MDN browser-compat-data):**
   `oklch()` + `color-mix()` = **WebView 111+** (Mar 2023 — every
   Play-updated Android 8+ device has it); `@property` = 85+; relative
   color syntax = 131+ (**OFF the critical path** — redundant with
   color-mix; don't depend on it). Guardrails: register slot vars with
   `@property`; flip slots ONCE per theme-apply, never per frame (the
   v092 orbit storm is the repo's own measured proof of the alternative).
5. **Igalia's custom-property invalidation work confirms the edit-cost
   model:** a `:root` slot flip costs O(consumers) style recalc in native
   code — sub-ms at panel scale for SOLID colors. The expensive part is
   gradient PAINT on large surfaces, which is exactly what the L2
   compositor layers + per-epoch field raster eliminate.

---

## WHAT THE CENSUS ADJUDICATED (the user's lag reports, in numbers)

- **"Changing border / surface-raised lags way more than canvas
  background" — CONFIRMED, mechanism found.** Census C: border family
  fans over ~86 rules, `--surface-2` over ~110 (plus `--raised-chrome` 46)
  — including fixed-attachment gradient rasters and every L2 pseudo
  window; a change re-mints DoomGates derived stylesheets + re-snapshots
  every L2 window (theme.js epoch re-mint). The canvas path is
  fingerprint-gated + worker-debounced (150ms) — ONE atlas rebake. The
  FIELD model applies the canvas's bake-once economics to every slot:
  one raster per field per epoch, N windows re-composite on GPU.
- **"Variables don't make sense" — CONFIRMED, five overlap findings**
  (census B3): 25 rules consume BOTH border and raised families;
  74+ rules paint BORDERS with SURFACE vars (every divider/hairline
  rides `--surface-2`/`--surface-3` — e.g. `.fmt hr` on surface-3 at
  index.html:2119); border vars used as FILLS (scrollbar thumb at :1926,
  handle-bar, press states); `--raised-ring = color-mix(border,
  surface-2 30%)` (:4707) — the families are mathematically entangled;
  `--surface-3` = a 53-consumer ghost with no editor row. The ratified
  slot mapping (v0982 PART C: raised + hairlines become DERIVED
  color-mix products of surface+ink) ends the fight by construction.
- **"Nested boxes lag" — CONFIRMED structurally.** Census D: the Colors
  tab is 3 nesting levels (4 collapsible sections → 18 collapsible color
  rows → GradientUI internals), and `GATES` emits ~83 gated selectors
  from index.html alone (~double with injected sheets). Mitigation (no
  library — the technique is the platform's own): see the recipe below.

## THE NESTED-BOX RECIPE (v0.99.7 — all settings tabs)
1. `content-visibility: hidden` on collapsed panes — the WHATWG `<details>`
   rendering spec now mandates exactly this pattern for native
   disclosures; collapsed = skipped style/layout/paint, instant re-open
   with rendering state preserved (vs `display:none` remount).
2. `content-visibility: auto` + `contain-intrinsic-size` on open-but-
   offscreen rows (7× initial-render boost in web.dev's demo class).
3. Cap simultaneously-open sections (accordion) — bounded DOM = bounded
   invalidation + memory.
4. Keep the v0.98 lazy-editor pattern (build on first expand).
5. **L2 must not force layout reads on skipped subtrees** — a forced
   `getBoundingClientRect` on a cv-skipped element re-renders it (web.dev
   hazard note); the POS_SEL sweep ordering already keeps reads in the
   read phase — the reassignment wave must preserve that discipline.
6. The slot model itself is the deepest cut: 18 color rows → 7 slot rows,
   3 nesting levels → 2 (section → slot row → popover).

---

## WHAT STAYS HOME-GROWN (and why that IS the library-grade answer)

- **GradientUI (1,628 lines):** four searches + the full npm registry
  prove NO maintained permissive vanilla-JS gradient editor exists
  (grapick: MIT, 4.4KB — dormant since 2021-02; everything else React/Vue
  or BSD). Ours is the maintained one; optionally borrow grapick's
  stop-handle drag model. The v0.99 slimming (styles 8→2, patterns 5→1
  texture) does more for the tab than any swap could.
- **The Field & Masks core (L2 windows, per-epoch atlas, lattice):** the
  optimization IS the architecture — compositor-only transforms,
  bake-once rasters, worker debounce. No library ships this (the
  background-attachment:fixed mobile breakage that forced L2 is the same
  reason no library solved it).
- **The panel drag engine:** compositor-only since v0.96 (paint −92%);
  Motion's full engine is a main-thread rAF loop — a measured-class
  regression risk for exactly the path we already won. `motion/mini`
  (2.8KB, pure WAAPI) is the only optional add, for discrete pill
  micro-transitions — deferred until a need is measured.
- **Iconify runtime:** REJECTED — designed around an HTTP API (we are
  100% offline); per-set data is 0.6–9MB; subsetting needs a build step
  we don't have. Home Assistant/Grafana precedent: vendored sprite +
  registry. The Iconify JSON shape (`{prefix, icons:{name:{body,w,h}}}`)
  is still adopted as the IMPORT format for theme icon packs — users
  curate subsets offline with ecosystem tooling.
- **OverlayScrollbars:** REJECTED — Android WebView scrollbars are
  already overlay-style; 15KB gz + per-scroller Mutation/ResizeObservers
  for cosmetics. `::-webkit-scrollbar` + chrome-slot vars theme them free.

## REJECTED (verified once — do not revisit without new evidence)

| Candidate | Verified SPDX | One-line reason |
|---|---|---|
| chroma.js 3.2.0 | **(BSD-3-Clause AND Apache-2.0)** — code is BSD-3 | Outside the MIT/Apache rule; no official prebuilt browser bundle; culori dominates every axis |
| colorjs.io 0.7.1 | MIT | W3C reference harness; +8KB over culori; no release since 2024-06 |
| node-vibrant 4.0.4 | MIT | Five-package browser barrel (import-map friction) for the MMCQ job MCU already does better |
| Shoelace 2.20.1 / Web Awesome | MIT (sunset) / Core-MIT + Pro | Styled Lit kits fight the 22-member closed set; wa-color-picker is free-MIT but the wrong architecture — port behaviors, never link styles |
| Style Dictionary 5.6.0 (runtime) | Apache-2.0 | Build-time distribution tool; our editor IS the runtime (format already adopted via DTCG) |
| @pixi/ui 2.4.1 | MIT | Peers pixi.js v8 widgets on DOM events — the worker world has no pointer events; rendering-only use adds nothing over plain display objects |
| Motion (full) 14.0.0 | MIT (engine) | Main-thread rAF springs vs our compositor-only panel path |
| Iconify runtime 3.x | MIT | HTTP-API design vs 100% offline; set data 0.6–9MB |
| OverlayScrollbars 2.16.0 | MIT | Mobile WebView already overlay-scrollbars; observers-for-cosmetics |
| zip.js 2.23.0 | **BSD-3-Clause** | License rule; fflate is smaller anyway |
| free-tex-packer-core 0.3.9 | MIT | Node-only (sharp/jimp/tinify), CJS, and it WRAPS maxrects-packer |
| Zod 4 / valibot 1.5 | MIT | No JSON-Schema consumption edge for untrusted JSON; standalone Ajv is smaller and schema-native |
| vanilla-picker 2.12.3 | **ISC** | License rule; Pickr is the MIT fallback if the homegrown solid tab ever needs replacing (1.10.2, 2026-09-08, 9.2KB gz + CSS) |

---

## PRECEDENT CONFIRMATIONS (bundle v2 shape)

- **Telegram `.attheme`:** single file, named slots, wallpaper = part of the
  theme — we keep single-file simplicity via zip + manifest.json.
- **VS Code themes:** semantic keys + `include` inheritance; assets live
  in a SEPARATE contribution type (file-icon themes) — we mirror the
  discipline: colors/fields in DTCG tokens, shapes/images in the assets
  manifest, never entangled.
- **Android RRO overlays:** swap assets BY NAME via a resources map
  (`overlays.xml`), target declares itself overlayable — our manifest
  does the same: `member → asset name` indirection, versioned targets,
  never addresses.

**Bottom line:** the build swaps in culori + floating-ui for v0.99,
virtual-core for v0.100, fflate + maxrects + Ajv-standalone + MCU for
v0.101 — all MIT/Apache, all offline-vendorable, ~71KB gz total — and
keeps homegrown exactly the four things the open-source world has not
solved: the gradient editor, the field/mask architecture, the panel
drag, and the offline icon registry.
