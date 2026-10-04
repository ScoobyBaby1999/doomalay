# PLAN v1.01 — THE ASSETS (everything becomes a swappable image)

The second wave of the 1.x push (user order: "push v1.00 and v1.01
together"). Phases push as v1.01.1 / v1.01.2 / …; the wave ships as
**v1.01-the-assets**. Verdicts inherited from the v099 library scan +
the v100 research (tool-results/v099-research/, v100-research/).

## v1.01.1 — VENDOR

- **fflate** (MIT, 12.6KB gz UMD) → vendor/fflate.min.js. The
  `.doomtheme` v2 zip container read/write: `unzipSync` +
  `strFromU8`; the zip-bomb defense is OURS to pass
  (`filter(file) { return file.originalSize < LIMIT }` per entry +
  total-size cap; fflate never touches the fs — zip-slip entry names
  with `../` must be rejected by OUR normalization before any use).
- **maxrects-packer** (MIT, 3.3KB gz UMD+ESM) → vendor/maxrects.umd.js.
  The field atlas: `new MaxRectsPacker(2048, 2048, padding,
  {square: true, allowRotation: false})`, `packer.add(w, h, data)` →
  bins → rects (x/y/w/h); we own pixel extraction (drawImage from the
  user's decoded image).
- **Ajv standalone validators** — compile our .doomtheme manifest
  schema at AUTHORING time (a one-off node script in scripts/), vendor
  the generated JS (zero runtime Ajv, CSP-safe). Draft-07 (the DTCG
  official schema is draft-07-shaped). Untrusted-DATA discipline: no
  allErrors, maxLength/maxItems caps everywhere, depth + string-size
  limits before validation.
- **@material/material-color-utilities** (Apache-2.0, ESM single-file
  25.2KB gz) → vendor/mcu.esm.js. GENERATION-TIME ONLY (image →
  source color → a suggested 7-slot palette the user accepts/rejects;
  HCT never becomes a second runtime truth — culori OKLCH stays the
  one truth).
- Script tags + route map + LICENSEs in vendor/licenses/ (the v0.99.3
  pattern).

## v1.01.2 — FIELD IMAGES (the user-uploadable canvas field)

- Upload path: file input (image/webp+png+jpg) → decode → optional
  MCU suggester → the canvas field spec gains `{ type: 'image',
  src }`.
- The atlas: maxrects packing of the theme's images, 2048² clamp on
  low-end (16MB RGBA), `MAX_TEXTURE_SIZE` queried at runtime, spill to
  extra bins (pixiworld already rasters per-fingerprint — the atlas
  joins that pipeline).
- WebP-first (full WebView support since 32-era); DOMPurify on every
  imported SVG (already vendored).

## v1.01.3 — 9-SLICE + THE ICON REGISTRY

- Shape assets per member class: Pixi `NineSliceSprite` (canvas side);
  CSS `border-image` + `mask` compositing (DOM side). Known Chrome
  behavior: border-radius CLIPS border-image — the rounded corners +
  9-slice combo needs the mask+background split where radius matters
  (member-class decision, not a per-site one-off).
- The icon-pack registry: homegrown sprite renderer + the **Iconify
  JSON import format as DATA** (no runtime Iconify); theme bundles swap
  icon sets by name (the Android RRO pattern).

## v1.01.4 — .DOOMTHEME V2 (the bundle)

- Zip container: `manifest.json` (DTCG 2025.10 tokens — color incl.
  OKLCH, gradient composite type, dimension/typography; our
  `$extensions["com.doomalay"]` for slots/atlas/icon-set metadata
  since DTCG doesn't spec assets) + `assets/` + `fonts/`.
- The 8-rung security ladder: size caps → entry-name normalization
  (zip-slip) → MIME sniff → DOMPurify (SVG) → Ajv-standalone manifest
  validate (caps armed) → decode bounds (2048²/MAX_TEXTURE_SIZE) →
  font-face registration only for whitelisted families → apply in a
  failed-apply-rollback transaction.
- v1 JSON folds on read (the lookio.js loader pattern).
- Export: the CURRENT theme + overrides → a .doomtheme v2 that
  round-trips (export → import → identical computed fields).

## v1.01.0 — WAVE SHIP

Gates: an asset-picker rig, the security rig (fuzzed/corrupt/
oversized/traversal/zip-bomb bundles ALL rejected cleanly), the
round-trip rig, the full battery. Tag `v1.01-the-assets`.

## WHAT WE ARE NOT DOING

- No MCU in the runtime derivation path (HCT ≠ OKLCH — one truth).
- No Iconify runtime, no zip.js (BSD-3), no Zod/valibot (standing).
- No new native screens (the picker rides the panel/Overlay classes).
- No hub publish/browse of v2 bundles before v1.02 THE LIBRARY.
