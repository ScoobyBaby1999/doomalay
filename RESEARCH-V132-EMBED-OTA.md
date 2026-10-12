# RESEARCH-V132 — THE EMBED TRUTH (the embed/OTA/APK-wall analysis)

v1.32.3 · PLAN-V133 §3 · the analysis the frame-budget review deferred the
Vite/esbuild + gzip/immutable + lazy-wasm item behind, now done on the live
tree (v1.32.1 + v1.32.2 landed first).

## 1 · THE EMBED SHAPE (how the web tree ships)

- The engine embeds the PWA at compile time: `//go:embed all:web` (server.go)
  over `engine/internal/server/web/` — 143 files, ~11.0MB, the largest
  assets: pixi.min.js 809KB · chatpanel.js 395KB · index.html 317KB ·
  modelbrowser.js 169KB.
- The APK wall: any ENGINE (Go) change needs a rebuild → the CI APK → a user
  sideload. That wall is exactly what v1.17.4 THE LIVE UPDATE built around:
  **pure web-asset changes ride OTA** — no engine rebuild, no APK, live on
  the next reload through the ota-first overlay.
- The OTA machinery (internal/ota): `generate-ota-manifest.py` hashes EVERY
  file under `web/` from the repo tree (143 entries, 26KB manifest) → CI
  uploads it to the release → the engine diffs it against the live stack
  (overlay file else embedded bytes) → downloads only the changed files
  (sha256-verified) → serves them at the SAME URLs from
  `<dataDir>/ota/…` without a restart. `min_engine` gates anything needing
  the new binary.

## 2 · THE DELTA ECONOMICS (the number that decides the bundler question)

A one-line fix in chatpanel.js today:

- OTA cost: chatpanel.js only — 395KB raw, ~120KB over the wire
  (raw.githubusercontent serves text gzipped; the engine overlay then serves
  it locally). Everything else: 304-verified unchanged (v1.32.2's validators
  make even the *unchanged* check nearly free).
- The tree stays 143 independent patch units — the OTA's whole value.

Under a bundler (Vite/esbuild, the standard shape: hashed app bundle):

- The app JS collapses into one (or a few) fat artifacts: the tree's own JS
  (~2.9MB across the top files) bundles to ~2.5MB, gz ~700KB–1MB.
- EVERY web change — a one-line label fix included — re-downloads the whole
  bundle. The per-file delta property dies; OTA becomes "ship the app again".
- index.html + the vendored statics could stay unbundle-able, but the
  dominant churn (chatpanel/formatter/app/settings) is exactly the part that
  would merge into the bundle.

## 3 · THE ESBUILD/VITE VERDICT: **DEFERRED — to the React-islands strangle wave**

The review's list ("Vite/esbuild + gzip/immutable + lazy wasm") bundled four
different things; this wave took the three that pay for themselves now
(gzip ✓ v1.32.2, immutable-without-hashes = honestly impossible with
same-URL OTA patches → documented, lazy wasm ✓ verified below). The bundler
itself defers, for four concrete reasons:

1. **Delta economics** (§2): the OTA's per-file diffing is the update
   system's core feature; a bundler converts every patch into a full-app
   download. That trade only makes sense when a bundler is REQUIRED for
   another reason — which is exactly what the React-islands strangle is.
2. **The build gate on a multi-bot repo**: the tree is hand-authored plain
   files; parallel bots edit and push directly; the manifest hashes THE repo
   files and raw.githubusercontent serves THE repo files, so a patch is
   reproducible from the repo alone. A bundler inserts a build between edit
   and ship: every push needs Node + a build + committed dist (or CI-side
   build), and a hand hotfix on main stops being OTA-representable.
3. **The source-of-truth fork**: today repo tree = embedded tree = served
   bytes = manifest source (one truth, and v1.32.2's ETags hash it). A build
   forks embedded ≠ source; the manifest generator must hash the BUILT tree,
   CI must build before manifest-gen, and the failure modes (stale dist
   committed, manifest/source skew) are the exact drift class the v0.88.2
   stale-cache wave spent a phase killing.
4. **No double spaghetti**: a standalone bundler adoption now, then a second
   adoption for React islands later, means migrating the build twice. The
   islands wave arrives THROUGH a bundler (hashed chunks, code splitting);
   the bundler lands there, once.

**The cache endgame this reserves** (the bundler wave's shape, not built):
content-hashed filenames + `Cache-Control: max-age=31536000, immutable` for
hashed assets; index.html stays `no-cache` + ETag; the OTA overlay keeps
serving index.html + any non-hashed asset. Hashed URLs never collide with
same-URL patches, so immutability and OTA stop racing.

## 4 · THE LAZY WASM: verified already-lazy (and pinned)

- `vendor/pm/pmsdk.js` (48KB, `type="module"`) imports the PM SDK at boot —
  but `PrivatemodeCore` is constructed ONLY inside `getCore()`, which runs on
  the first PM turn (`streamChat`); the SDK then fetches
  `/vendor/pm/privatemode.wasm` (6.1MB .gz served pre-gzipped) and runs the
  attestation (`verify()` + `refreshSecret()`, the v0.16b retry ladder).
- So the 6.1MB WASM **never moves on a non-PM boot or a non-PM session** —
  the deferred item's goal is already the shipped behavior. The boot cost of
  PM is the ~100KB JS module graph (wasm_exec 17KB + wasm.js 10KB + SDK 25KB
  + pmsdk 48KB), ~30KB gzipped — acceptable, and it rides the v1.32.2 gzip
  variants + ETags like every other asset.
- The pin: `scripts/v1323-lazywasm-rig.mjs` boots the real engine, opens the
  PWA, runs a REAL non-PM streamed turn, and asserts the resource timing
  carries NO `privatemode.wasm` entry — the laziness is now a tested law,
  not a memory.

## 5 · WHAT THIS WAVE DELIVERED vs THE DEFERRED LIST

| Item | Verdict |
|---|---|
| gzip | ✅ v1.32.2 — engine-served variants, 30–34% of raw (chatpanel 395→119KB), own `-gz` validators + Vary |
| immutable | ⏸ honestly impossible pre-hashed-filenames with same-URL OTA patches → the §3 endgame sketch; ETag/304 (v1.32.2) delivers the byte win without the race |
| lazy wasm | ✅ verified already-shipped (§4) + the rig pin makes it a law |
| Vite/esbuild | ⏸ §3 — deferred to the React-islands strangle wave, four reasons, the endgame reserved |
| React islands / Pixi-in-worker | ⏸ the agreed later strangles — untouched; v1.32.1's worker client + the v1.32.2 validator layer are the primitives they will reuse |
