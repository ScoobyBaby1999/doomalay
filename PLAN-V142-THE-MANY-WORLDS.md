# PLAN-V142 — THE MANY WORLDS

**Status: FEASIBILITY ANALYSIS (this session builds nothing — per the standing law: plan → websearch → real plan → build).**
Scope: bounded canvas · install-age degradation audit + spatial-render rework · multi-canvas with per-canvas everything · black-hole portals (two-way, uncapped) · worlds manager · OOP component publishers · chat + canvas bundles on the public library.
Baseline: `v1.41.1` (rebased clean, 0 ahead/0 behind at plan time). Ship target: `v1.42.x` (renumber if a parallel wave claims it — the v1.35/v1.40 precedent).

**REV 2 — post-user-review refinements (applied surgically per the user's ask — no rewrite):**
1. NEW **W0 THE LONG HAUL**: diagnose the reported install-age degradation ("degrades the longer the app is downloaded… even if I never really use the app") and rework the spatial renderer while the world is in play — now is the opportunity.
2. Black holes REDEFINED as **simple two-way portals** (a ref to a canvas, like a browser tab holds a URL): zoom-through transition with move-to-cancel, auto-paired return portal, **no caps, no depth limit** — the registry is a ref graph, not a containment tree.
3. W4 becomes **THE MANAGER**: the worlds overlay — rows of owned + downloaded canvases, a browse-the-library row, a create-new row, local rename everywhere, generic default names.
4. **Chats join the library** as a first-class hub type with a fully toggleable metadata tree.
5. The publish system re-architected as **OOP component publishers** (interface + composition, per the user's C# OOP reference): ONE ChatPublisher serves the chat library AND canvas bundles — edit one instance, it reflects everywhere.

---

## 0. THE ASK, DECOMPOSED

The user's request splits into seven workstreams (REV 2 adds W0; W3/W4/W5/W6 re-shaped
per the user's review). Every one is assessed below against the
real tree (`engine/internal/server/web/` + `engine/internal/`), with file:line receipts,
web research, cost, and risk.

| # | Workstream | One-line ask |
|---|---|---|
| W0 | **THE LONG HAUL** | Diagnose the install-age degradation ("degrades the longer it's downloaded, even unused"); rework the spatial renderer — O(visible), not O(world) |
| W1 | **THE EDGE** | Bounded world: width/height ≈ "7 seconds of scrolling at max zoom-out" |
| W2 | **THE SWAP** | Many canvases per user; each with own icons, chats, theme, settings; freeze/snapshot switching; OOP, no coupling, no perf loss |
| W3 | **THE SINGULARITY** | Black holes = simple two-way portals (a ref to a canvas, browser-tab style); zoom-through transition, cancel-on-move, no caps |
| W4 | **THE MANAGER** | The worlds overlay: rows of owned + downloaded canvases, browse-the-library row, create-new row, local rename, generic defaults |
| W5 | **THE VESSEL** | OOP component publishers (chat/settings/iconsets/portals/layout/assets) composed into sanitized canvas bundles; per-leaf publish toggles; BYOK |
| W6 | **THE LIBRARY SHIP** | Hub types chat + canvas; "download an entire setup" — and chats as a whole library section |

**Honest verdict up front: FEASIBLE without a rewrite.** The tree was accidentally (or
intuitively) pre-shaped for this: the whole world already round-trips through one
serialize/deserialize pair (`saveNow`/`loadState`, app.js:2425-2443); entities are a
registered-type factory (`GridIcon.register`, gridicon.js:39-52); the engine already owns
durable SQLite storage; the hub already ships multi-file items and collections; and
`lookio.js` already implements a hardened ZIP container with zip-slip/bomb ladders and
apply-rollback. The two genuinely hard parts are (a) unwiring ~8 module singletons for
world switching and (b) the bundle manifest/sanitizer — both have in-repo precedents to
extend, not invent.

**REV 2 verdict additions:** the reported install-age degradation makes W0 the new FIRST
phase — measure before anything else (the v1.12 PROFILER-FIRST law), then rework the
renderer's cost shape from O(world) to O(visible); and the user's OOP publisher mandate
turns W5 from a monolithic exporter into a component-publisher composition, which also
adds `chat` as a standalone hub type in W6. The portal redefinition makes W3/W4 SIMPLER
than REV 1 (refs instead of trees — no depth caps, no containment logic).

---

## 1. GROUND TRUTH (what exists today — the receipts)

All paths relative to `engine/internal/server/web/` unless noted. Verified on `v1.41.1`.

### 1.1 World & camera
- Infinite world, **no bounds anywhere**: camera is module state `{offsetX, offsetY, scale}` (app.js:89-91); `screen = (world − offset) × scale` (app.js:164-169). Physics states it outright: "no edge collisions: the canvas is infinite" (physics.js:55-56).
- **Five unclamped pan-write sites**: finger pan app.js:1730, momentum app.js:1213-1216 (friction 0.88, velocity clamp ±18 px/frame, app.js:106-107), compass glide app.js:495-496, rig `setView` app.js:934-935, boot restore app.js:2484-2485.
- Zoom clamps exist: `MIN_SCALE = 0.125`, `MAX_SCALE = 2.1` (app.js:101-102), enforced at 4 sites (`zoomAt` 1836, pinch 1945, `setView` 936, boot heal 2487). Reset view = (0,0,1) (app.js:910-913).

### 1.2 Rendering layers & cost shape
- Layer stack: `#c` 2D lattice background (index.html:6059) → `#chatbots` DOM icons (z100) → `#c3` Pixi v8.21.0 canvas, lazy, only at ≥60 entities (pixiworld.js:74, 503-506) → `#c2` 2D over-icons (z150).
- Lattice is **tile-periodic** (joint period 80 cells ≡ 3840 world px at defaults, lattice.js:731-739): it works at ANY world coordinate and any world size — bounding the world costs the lattice NOTHING. Tile budget 32 MB/set, LRU ladder 128 MB (lattice.js:747, 719).
- Per-frame cost: N DOM transform writes (gridicon.js:94-100, skip-if-identical) + N Pixi container writes when the GPU layer is on (pixiworld.js:888-895) + ~5-20 pattern fills + 1 Pixi render only when dirty (`autoStart:false` on-demand driver, pixiworld.js:55-59, 92-113). Pixi culls (`pad = 130·sc + 40`, pixiworld.js:886-891); the DOM path does not (guarded only by string-skip).
- Worker offload default-on: `#c`/`#c2` bitmaps live in gridworker.js; 1 postMessage/frame (app.js:573-577).

### 1.3 Entities & persistence
- Entity types: `ChatIcon` (`'chat'`), `WebIcon` (`'web'`), registered via `GridIcon.register(type, factory)` (gridicon.js:39-52) — **the sanctioned extension point**; a new type gets DOM presence, physics, hit-testing, serialize/restore for free.
- THE CANVAS = one localStorage blob `doomalay.state.v2` (app.js:2417): `{offset, scale, currentFamily, icons: world.entities.map(serialize), dots: TabGroups.serialize(), savedAt}`, debounced 200 ms (`scheduleSave` app.js:2420-2424). `ChatIcon.serialize` already carries name/model/provider/sessionId/caps/pinned (chatbot.js:353-384); `WebIcon.serialize` carries url/title/favicon/scrollY/iconMode/imageData/tweaks (webtab.js:327-338).
- Restore path heals duplicate ids/sessions (app.js:2492-2528) — **import tolerance already exists**.
- **Multi-canvas today: none.** One `Physics.World` (app.js:736), one camera, one save slot, one lattice cache set (`TL`/`LC`/`bgCache`), one `TabGroups.dots`, one `#chatbots` layer, one `World3D` (pixiworld.js:83). ~8 singletons total to unwire (enumerated in §3.2).
- Chat *content* is already engine-side: `chat_sessions` (model, provider, personas, preambles, template, tweaks, skills, effort, mode, tools…) in `store/db.go:60-88`; history is append-only `chat_events` (store/db.go:93-103). localStorage holds only per-chat UI maps (scroll/draft/bundle/export-latest).
- Settings = one JSON object `doomalay.settings.v1` (settings.js:17, 22-90) — **global today**, not per-canvas.

### 1.4 Hub / library
- Hub = real Hugging Face datasets, direct REST (`engine/internal/hub/hf.go`), fan-out discovery over per-user repos tagged `doomalay-<type>` (service.go:401-436). Item registry (hub.go:78-166): persona, template, skill, theme (.doomtheme), script, doc (hidden), python, preamble.
- Publish caps (server/hub.go:27-35): body ≤26 MB, payload ≤64 KB (themes 24 MB), PNG ≤6 MB, icon ≤64 KB, companions ≤20 × 64 KB with extension whitelist + path-traversal refusal (service.go:1088-1123). Deterministic ids `slug+6-hex(sha256(slug+author))` (model.go:173-186).
- **Collections = bundles already**: an id shared by member items + `collections/<id>.json` manifest (service.go:110-120, collections.go). Download = per-member fan-out with resume registry (hub.js:1107-1161).
- Trust ladder today: transport caps + format validators on themes only (lookio.js:38-40, 148-207 — magic field, version, 24 MB, zip-slip/bomb ladder, failed-apply **rollback**). Persona/preamble/template payloads apply with no schema validation (hubitem.js:563-585) — noted as a gap W6 must close for canvas-scale payloads.

### 1.5 Secrets / BYOK
- All keys/tokens live in the AES-256-GCM vault (`secrets/vault.go`; `secrets.json` + `master.key` in DataDir). `/api/keys` never returns values — `has_key` flags only (server/keys.go:14-31). Provider registry: free + paid lists (providers.js:37-44).
- **BYOK is already the architecture**: a bundle physically cannot carry a key it never had. Device folder handles (IndexedDB `doomalay-ws/handles`) are non-extractable by spec — they can only be recorded as "reconnect required".

---

## 2. RESEARCH VERDICTS (the web pass)

| # | Question | Verdict | Sources |
|---|---|---|---|
| R1 | How big can the world be before float32/Pixi precision breaks? | Safe to ~2^24; jitter folklore in game engines starts 2k–50k *units* in camera-relative 3D. Our 2D world at ±2^16 px: float32 ulp ≈ 0.008 px — sub-pixel, invisible. **A 65,536 × 65,536 world is 256× inside the danger zone.** | Babylon large-world docs; Godot large_world_coordinates; Unity DOTS thread (50 km advice, 2 km jitter reports) |
| R2 | Do other canvas apps bound the world? | tldraw: content-bounds + camera constraints API; Excalidraw: unbounded (export-size pain reports); Miro: large-but-finite frames. Bounded-with-configurable-size is a mainstream, defensible choice. | tldraw docs/blog; excalidraw issues #2723, #8741 |
| R3 | Where should multi-canvas state live on Android WebView? | **NOT localStorage** (5 MiB recommended / 10 MiB hard cap; Android WebView reported as low as ~2.5 MB) and **not IndexedDB alone** (WebView eviction under storage pressure; `navigator.storage.persist()` unreliable on WebView). The durable home is the engine's own SQLite/files (app-private dir, survives WebView wipes). Engine-side is already where chats live. | MDN storage quotas (10 MiB, Jan 2026); web.dev storage-for-the-web; super-productivity #7901 (WebView eviction); SO Android WebView quota threads |
| R4 | Snapshot format precedent? | **JSON Canvas** (Obsidian's open format: `nodes[]` + `edges[]`, typed, versioned) and **tldraw `.tldr`** (JSON StoreSnapshot with schema version + automatic migrations). Both validate: one JSON document per canvas, schema version field mandatory. | jsoncanvas.org; tldraw persistence docs + file.ts |
| R5 | Pixi scene-swap lifecycle? | Keep the Application/renderer alive; swap stage children; `texture.destroy(true)` per removed sprite — **stagger mass destroys** (perf tips: random-delay destroys to avoid freezing); `TextureGCSystem` only as backstop. Deferred re-raster on first-sight is the cheap path for switching. | PixiJS v8 Garbage Collection guide + Performance Tips |
| R6 | ZIP container security? | Validate every entry path (no `..`, absolute, backslash, dotfiles), cap entries/depth/per-file/total/uncompressed-ratio, timeout. `lookio.js` already implements this ladder — extend, don't reinvent. | Android zip-path-traversal guidance; Snyk Zip Slip research |
| R7 | Imported chat history risk? | **Indirect prompt injection (OWASP LLM01:2025)** — imported history/personas are untrusted content that the model will read. Mitigations: provenance marking (visual "imported" badges), personas land inactive (current hub import already does this), no auto-activation of tools/hooks from imports, docs. Cannot be fully "fixed" — must be surfaced. | OWASP GenAI LLM01:2025; Microsoft MSRC indirect-injection post |
| R8 | HF hosting capacity? | LFS files up to 50 GB; no practical limit for MB-scale canvas bundles. Public datasets are publicly readable — no privacy tier in v1. | HF storage-limits docs + forum |
| R9 | Frozen-view memory pattern? | Detach DOM into a stash (the app already has per-chat `_domStash` + the panel view-stack precedent); keep only the active world's DOM/Pixi live. Detached-node retention must be avoided (web.dev detached-window leaks) — stash JSON, not nodes, for long-lived freezes. | web.dev detached-window memory leaks; in-repo stash precedents |
| R10 | BYOK multi-provider pattern? | Keys never leave the device; bundles carry provider *names* + model ids only; import validates `has_key` per provider and warns. This is exactly the current vault design — W5 just obeys it. | in-repo vault + keys API; LibreChat/Open WebUI pattern (same shape) |
| R11 | Browser-native offscreen skip for DOM icons? | `content-visibility: auto` (Baseline 2024) skips layout+paint for offscreen content and fires `contentvisibilityautostatechange` so JS can pause work. ⚠ CAVEAT for our icon layer: icons are positioned by `transform: translate3d` inside a fixed viewport container — transforms are *visual*, not layout, so CV's cull rect may not track them. The rig must verify CV-respects-transforms on the target WebView first; the JS-driven visible-toggle (we own the camera, so we KNOW what's offscreen) is the guaranteed fallback. | web.dev content-visibility; MDN content-visibility (Baseline 2024) |
| R12 | Pixi v8 native culling? | `CullerPlugin` (opt-in via `extensions.add`) + `container.cullable` + optional `cullArea`; manual `Culler.shared.cull()` also available. We already hand-roll culling in `updateWorld` (pad 130·sc+40) — keep ours (wired, rig-proven) and note the plugin as the sanctioned alternative. | PixiJS Culler Plugin docs; richardfu.net v8 culling deep-dive |
| R13 | Why might the app degrade with install age? | Three structural suspects with documented mechanisms: (a) SQLite WAL growth — WAL files grow until checkpointed (default ~1000 pages); VACUUM in WAL mode writes to the WAL and only shrinks the DB after a CHECKPOINT — vacuum-without-checkpoint is wasted work; (b) WebView origin storage (localStorage/IDB/http-cache) accumulating with no in-app eviction path; (c) append-only stores (metrics.jsonl, hub_items rows, chat_events) with no TTL. All measurable, all fixable — W0's rig proves which bite on-device. | sqlite.org WAL (checkpoint cadence); photostructure WAL-vacuum study; super-productivity #7901 |

---

## 3. FEASIBILITY & DESIGN (per workstream)

### 3.0 W0 — THE LONG HAUL (install-age degradation audit + spatial-render rework) · **Cost: M audit + M-L rework**

**The symptom (user, REV 2):** "it seems to degrade the longer the app is downloaded… even
if I never really use the app." Not the v092 shape (that was theme-gradient paint,
root-caused and shipped) — this is *age*-correlated, *usage-independent* degradation,
which points at something that GROWS WITHOUT USE. The house law applies: **the profiler
first** (the v1.12 lesson; RESEARCH-V092's rig lineage continues).

**The hypothesis ledger (each gets a rig verdict before any fix):**
- **H1 — SQLite growth without maintenance**: `doomalay.db-wal` grows between checkpoints
  (R13a); `hub_items` rows accumulate on every hub browse/refresh cycle with no eviction;
  metrics JSONL is append-only. Fix shape: checkpoint + `VACUUM` +
  `wal_checkpoint(TRUNCATE)` cadence (idle-time, not boot), hub-cache LRU/TTL, metrics
  rotation.
- **H2 — WebView origin-storage creep**: localStorage keys with no eviction
  (`modelcache.v1` 100s KB, `iconreg.v1` ≤2 MB, `chatscroll`/`chatdraft` maps grow with
  chat count forever, `state.v2` icons carrying `imageData` dataURLs), plus the WebView
  http cache. Fix shape: TTL/age-out + size-aware pruning per key + a storage-usage row
  in Settings (the worlds manager already shows usage — generalize it).
- **H3 — boot storms**: boot-time work that scales with account/hub age (keys validate,
  model-catalog resync, OTA manifest, hub stale-while-revalidate fan-out at 6-way
  concurrency). "Never used it" still boots it — every boot pays. Fix shape: defer
  non-critical syncs (hub refresh on first hub open, not boot), a boot-cost budget
  measured on the rig, a boot-budget regression test.
- **H4 — world-size creep**: icons accumulate (the user never deletes); the DOM path has
  NO culling (§1.2) — per-frame cost is O(world), not O(visible). An "unused" app with
  300 accumulated icons pays 300 transform writes + physics + hash rebuilds per frame.
  Fix shape: THE FIELD rework below.
- **H5 — background cadence while visible**: the 33 ms ambient gate runs whenever visible
  even with zero input; fine alone, multiplied by H4 it reads as "slow".

**THE FIELD (the spatial-render rework — the user's "now is an opportunity"):**
1. **The visibility law**: per-frame cost becomes O(visible), not O(world). The DOM path
   gains the same cull the Pixi path already has (pad-culled): offscreen icons get
   `display:none` (JS-driven, camera-authoritative — we own the camera so we KNOW what's
   offscreen; `content-visibility: auto` is tried in the rig first as a freebie, per
   R11's transform caveat). Offscreen icons skip their transform writes entirely (the
   skip-if-identical guard does not help for moving icons).
2. **The sleep law**: physics sleeps entities at rest outside the active radius; wake on
   touch, camera proximity, or portal influence. The spatial hash only bins awake
   entities. At-rest worlds approach zero JS per frame (the 33 ms cadence gate already
   limits full frames — this makes the gated work ~free too).
3. **The lattice is already right** (tile-periodic, viewport-tested, cached) — untouched.
4. **The Pixi side**: keep the hand-rolled cull (R12); render-group promotion of stageRoot
   children if the rig shows batch cost; staggered destroys stay (R5).
5. **Option B (evaluated, behind a settings flag, ONLY if 1-2 miss the rig budget)**: a
   full-Pixi icon path (RenderLayer + Culler) retiring the DOM icon layer. Honest costs:
   CSS-var theming of icons, accessibility, text rendering — documented, default OFF.
6. **The rig**: an aged-state harness — inflate stores to 30/90-day equivalents (H1/H2)
   + 100/250/500-icon worlds (H4) → measure boot, interaction latency, frame cost
   before/after. Regression budgets enter the battery.

**Sequencing note:** W0's rigs run FIRST (v1.42.1-2) because every later phase (bounds,
swap, portals) inherits its cost shape, and its findings may re-order the queue. The
visibility/sleep laws are also preconditions for a clean swap: a frozen world must cost
exactly zero, and a live one must stay cheap enough that "one live world" stays true
under many worlds.

### 3.1 W1 — THE EDGE (bounded world) · **Cost: S (~120-180 LOC + rig)**

**The 7-second metric, formalized.** At max zoom-out (scale 0.125) a steady drag moves
~1,000-1,500 screen px/s → ÷0.125 = **8,000-12,000 world px/s**; × 7 s ≈ **56k-84k world px**
of full traverse. The default bound is therefore **65,536 × 65,536 world px centered on the
origin (±32,768)** — 2^16, a power of two (friendly to tile math), inside R1's precision
safety by 256×, and mid-band of the user's metric. It becomes a Settings key
(`worldSize`: 16k / 32k / 64k / 128k / ∞-off) under Sizing, so the metric stays the user's
dial, not a hardcoded wall.

Mechanics:
1. Clamp `offsetX/offsetY` at the five write sites (§1.1) so the *viewport* never leaves the world: `offset ∈ [−W/2 + viewW/scale·k, W/2 − viewW/scale·k]` (k = margin; degenerates gracefully when zoomed-in beyond world size).
2. Physics walls: soft damped walls (velocity reflecting with restitution ~0.4 + drag) in `Physics.World.step` — icons thrown at the edge settle, not bounce forever. Edge case from physics.js:55-56 ("icons fly off-screen") becomes impossible.
3. Lattice: **zero changes** (tile-periodic). Origin dot already renders only in view.
4. Compass arrows / off-screen indicators: already viewport-tested; degrade gracefully.
5. Edge affordance (cheap, theme-native): a 1-2 px world-edge line painted by the lattice worker when in view, riding `--border-strong-rgb` — no new color literals (the pin holds).
6. `setView` rig + boot-restore heal clamp too (no stale snapshot can escape).

Risk: clamping during momentum needs care at the corners (clamp both axes independently).
Rig: fling-test at all 4 edges × 3 zoom levels; assert camera inside bounds after settle;
assert an icon flung outward rests inside.

### 3.2 W2 — THE SWAP (multi-canvas) · **Cost: L (~900-1,300 LOC + engine + rig)**

**The architecture (OOP, compartmentalized, no coupling):**

```
Worlds (new module, worlds.js) — the registry + switch state machine
 ├─ CanvasStore (engine /api/canvases CRUD; localStorage fallback disabled by design)
 ├─ WorldState  {id, name, parent, camera, icons[], dots[], settingsSlice, thumb, updatedAt}
 ├─ activeWorld (the ONE live world) + switchTo(id) coroutine
 └─ WorldSettings layer (canvas-scope settings keys shadow globals; §3.2.4)
```

**3.2.1 Storage home — engine-side SQLite (decision).**
New table `canvases(id TEXT PK, name, parent_id, sort, state JSON, thumb BLOB, created_at, updated_at)`
+ endpoints `GET/POST /api/canvases`, `GET/PUT/DELETE /api/canvases/{id}`, `PUT /api/canvases/{id}/thumb`.
Rationale (R3): WebView localStorage (5-10 MB, evictable, wiped by WebView updates) cannot
hold N worlds + thumbnails; the engine dir is durable, already the chats' home, already the
sync/export origin. The existing `saveNow` debounce keeps its shape — it gains a POST target
instead of (in addition to) `doomalay.state.v2`. Migration v1: boot reads `state.v2`, creates
world `default`, POSTs it, leaves the blob as a tombstone fallback. localStorage keeps only
`doomalay.canvas.current` (the active pointer) — tiny, expendable.

**3.2.2 Switch mechanics (freeze/snapshot — the user's "inactive panels freeze" law).**
Exactly one world is ever live (DOM + Pixi + physics + caches). `switchTo(id)`:
1. `saveNow()` the active world (serialize camera/entities/dots/settingsSlice) → PUT engine.
2. **Detach** the active `#chatbots` children into a per-world `DocumentFragment` stash ONLY if
   switching back within the session AND world ≤ N icons (fast-path reuse, the existing
   `_domStash`/view-stack pattern); otherwise discard DOM (rebuild from JSON on return —
   R9: long-lived detached nodes are leak bait).
3. Pixi (when active): `stageRoot.removeChildren()`; destroy per-world textures **staggered**
   (R5) — or keep textures keyed per-world if total texture memory ≤ budget (measure first;
   both paths coded behind one decision point). Renderer/Application persist.
4. Clear lattice caches (`LC`, `TL`, `bgCache` + worker params blob) — they are world-agnostic
   (periodic tiles) but keyed to params/camera fingerprints; a clean swap avoids stale bakes.
5. Physics: `world.entities` swapped (frozen world = plain JSON; no ticking).
6. Load target `WorldState` → `GridIcon.create` factory rebuild (existing restore path,
   app.js:2529-2547, incl. dedup heals) → camera restore → `World3D.sync()/evaluate()` +
   `Atoms.refreshAll()` (both keyed by sessionId today — survive the swap) → one poke.
7. Settings slice applied (§3.2.4) via the existing `canvasFingerprint` gate (app.js:2356-2383) —
   repaint only on actual key deltas.

**Switch budget: < 400 ms for 100 icons on a mid-tier device** (rig-measured, CDP trace).
Deferred texture raster: only on-screen icons re-raster on arrival; offscreen icons raster on
first sight (a small `sync()` variant). The 33 ms ambient cadence gate + coast architecture
are untouched — **zero added per-frame cost**; switching is a burst, not a tax.

W0's visibility/sleep laws carry into the swap: a frozen world is zero-cost by
construction, and a freshly-restored one is cheap immediately (only visible icons
raster + render; the rest sleep until first sight).

**3.2.3 The singleton unwiring list (the real work).**
`Physics.World` (1) → per-world instance in registry; camera triple (2) → world-scoped;
`doomalay.state.v2` slot (3) → engine rows; lattice caches (4) → clear-on-swap; `TabGroups.dots`
(5) → serialized in WorldState; `#chatbots` children (6) → stash/rebuild; `World3D.S.chats` (7)
→ rebuilt per world; Settings global object (8) → layered (below). Each is a small, mechanical
change with a file:line map already in hand.

**3.2.4 Per-canvas theme & settings ("each canvas comes with its own…").**
Settings keys partition into two scopes:
- **CANVAS-scope** (world slice, ships in bundles): `theme`, `themeOverrides`, `fmtOverrides`,
  `chatScheme`, grid keys (`gridSize`, `bg/line/dot/originColor`, `hideGridLines/Dots`,
  `gridScatter`, `sizeVariation`, `gridRotation`, per-side twins, `spaceParallax`).
- **GLOBAL-scope** (device): `chatTextSize`, `uiTextSize`, `smallTextSize` (user excluded text
  size), `perfHud`, `workerPaint`, `worldLayer`, `worldAA`, `worldDpr`, `names`, OTA opt-out,
  Connected Accounts (engine-side anyway).
Resolution: `Settings.get(key)` = active-world slice → global default. On switch: diff
canvas-scope keys → the existing apply/repaint gates fire only on deltas. The theme flip
contract (themeStamp re-raster + atlas re-key, proven in the audit) runs unchanged.

**3.2.5 Canvas manager UI.** Panel/Overlay-law UI (no new surfaces): a "Canvases" panel —
gallery grid (thumbnail cards riding theme vars), create/rename/duplicate/delete, sort,
storage usage row. Thumbnails: `renderer.extract` (Pixi) or a one-frame lattice+icons
composite → PNG ≤ 64 KB (hub icon cap parity). Long-press canvas → radial gains "+ Canvas"
(W4's entry point).

**3.2.6 Chats stay continuous across switches.** Icons carry `sessionId`; chat *content* is
engine-side, so a turn streaming in a frozen world keeps streaming (WS is world-agnostic).
Opening a chat in world B while a turn runs in world A just works — the composer-routing law
and the UNINTERRUPTED TURN law (v1.40/v1.41) already guarantee honesty here. This is a major
feasibility win: **multi-canvas needs ZERO changes to the turn lifecycle.**

### 3.3 W3 — THE SINGULARITY (black holes = simple two-way portals) · **Cost: M (~350-500 LOC + rig)**

**REV 2 redefinition (the user's call): a black hole is a very simple two-way portal.**
No attractor mode, no gravity tuning, no depth mechanics — it holds a **reference** to
another canvas, exactly like a browser tab holds a URL. One mode, one job: fall through.

**Data model (OOP, ref-shaped):**
```
HoleEntity extends GridIcon('hole')      // the factory's freebies: DOM, physics, hit-test, serialize
  ├─ targetWorldId   // the REF — the whole point; portals are edges in a worlds graph
  ├─ pairId          // the two-way law: A→B and B→A share one pairId
  ├─ label, style    // name + theme-token palette + ring style (minimal, customizable)
  └─ x, y, r         // position + radius, physics-entity as always
```
- **The two-way law**: creating a portal A→B atomically ensures the return portal exists
  in B (auto-created at the target's arrival point, same pairId). Deleting a world marks
  its inbound/outbound portals "lost" (a re-target state, never a crash). Cycles are fine —
  A→B→A is just two hops; refs need no containment logic and **no caps** (the user's
  call: "no caps needed really").
- **Customizable, own instance like chat**: tap a portal → its panel (rename, palette,
  ring style, retarget via a world-picker, delete pair). Zero hardcoded colors — theme
  tokens only, riding FALLBACKS discipline (the pin A5 holds).
- **Rendering**: `#c2` paint pass (atoms.js precedent — Path2D-cached, sprite-baked) + the
  Pixi mirror when the GPU layer is live. Baked sprites only — no per-frame filters (R5).
- Persistence: `GridIcon.register('hole', factory)` gives serialize/restore nearly free
  (§1.3); portal state lives in WorldState like every other entity.

**The transition (the user's spec, verbatim-shaped):**
`PortalTransition` — a small state machine riding W2's `switchTo` (ONE code path, ONE rig):
1. **DIVE**: press → the camera zooms INTO the portal (ease-in, ~700 ms; the portal's
   aperture consumes the view = the loading veil). Any move/gesture **cancels** (ease
   back; nothing has swapped yet, so cancel is trivial).
2. **SWAP** (under the veil, at max zoom): the target world loads via the normal
   `switchTo` (registry fetch → rebuild → settings slice). If it can't load: gentle
   zoom-back + toast.
3. **EMERGE**: the view zooms OUT from the target's paired portal (~700 ms) to the
   target's saved camera. Total ~1.4 s; both legs cancellable up to the swap point.

Cost drivers: the aperture visual (baked sprites, theme tokens) and the dive/emerge
camera choreography (pure `offsetX/offsetY/scale` interpolation — the existing camera
pipeline, no new systems). Everything else is the factory pattern.

### 3.4 W4 — THE MANAGER (the worlds overlay) · **Cost: M (~350-500 LOC on top of W2/W3)**

**REV 2 reshape: the registry is a flat ref GRAPH (portal edges), not a containment
tree — `parent_id` is retired, the depth cap is retired (the user's "no caps"), and
"+ Canvas" opens a manager overlay instead of immediately creating a child.**

**Entry**: long-press canvas → radial gains "+ Canvas" → the worlds overlay opens
(the user: "a follow-up overlay screen or the tab itself should change"). Three zones,
top to bottom:
1. **Your canvases** — rows for every canvas the user owns or downloaded: thumbnail,
   display name, updated-at, size. Tap = jump (plain `switchTo`, or the portal dive when
   entered from a portal's panel). Long-press row = rename / duplicate / delete / publish.
   **Rename is local-only and works on downloaded canvases too** — `display_name` rides
   the local row; the hub's published name is never touched. New canvases get generic
   names (`canvas_1`, first free index).
2. **Browse worlds** — a row that opens the hub pre-filtered to the canvas type (W6).
   Downloading a canvas adds it to zone 1's rows automatically (the hub download pipeline
   exists; the canvas import creates the local row).
3. **+ Create new canvas** — a row that creates a blank world, adds it to the rows, and
   (when entered from a portal) wires the return portal per W3's two-way law.

Navigation stays trivial BECAUSE refs are flat: a back-stack (visited worlds in this
dive) plus the manager as home base. No breadcrumbs-of-a-tree — the graph is the user's
mental model, the overlay is its map. Bundles may carry portal refs as world uuids +
optional embedded canvases (§3.5); a ref whose target didn't ship = "lost" state with
re-target.

### 3.5 W5 — THE VESSEL (component publishers → canvas bundles) · **Cost: L (~1,100-1,500 LOC incl. engine sanitizer)**

**REV 2 re-architecture (the user's mandate): no monolithic canvas exporter. The publish
system is a set of OOP component publishers sharing ONE contract; the canvas bundle is
their composition.** The user's C# reference (interfaces, encapsulation, composition over
inheritance, polymorphism) maps directly onto the JS idioms:

```js
// THE CONTRACT (the C# interface, duck-typed — every component implements exactly this)
Publisher {
  id                    // 'settings' | 'iconsets' | 'chat' | 'portals' | 'layout' | 'assets'
  togglesSchema(world)  // → the toggle-tree node (groups → leaves), GENERATED from live state
  collect(world, picks) // → { manifestSlice, files[] } — the chosen includes only
  size(picks)           // → bytes, RECURSIVE for nested refs (bundle-info math lives HERE, once)
  sanitize(picks)       // → the blocklist law enforced HERE, inside the component (encapsulation)
  applyImport(payload, ctx) // → side effects + rollback journal + warnings[] (BYOK, provenance)
}

// THE COMPOSITE (composition, has-a — NOT inheritance)
CanvasPublisher { publishers: [SettingsPublisher, IconsetPublisher, LayoutPublisher,
                                PortalPublisher, ChatPublisher[], ChildCanvasPublisher[]] }
// polymorphic walk: one loop drives the toggle sheet, the size sum, collect, applyImport —
// the composite never knows any concrete publisher's fields.
```

**The publishers:**
- **ChatPublisher** — the star of REV 2: ONE instance serves (a) the standalone **chat hub
  type** (W6), (b) chats inside a canvas bundle, (c) the import validator for both. Toggle
  tree per chat: name · persona(s) · preambles · model+provider (names/ids only) ·
  capabilities · tweaks · template/skills/mind · pinned · history (default OFF, §7 Q3) ·
  artifacts (capped) · connected workspaces (as refs — host/repo/branch, never tokens;
  device/Termux folders become "reconnect required" rows) · **the library bundles the chat
  uses** (hub refs `type|repo|id`, optional embed — nested bundles, `size()` walks them).
  Editing this one instance changes the chat-lib publish sheet, the canvas sheet, AND the
  import validator — the user's "edit 1 instance, reflects everywhere" law, literally.
- **SettingsPublisher** — the CANVAS-scope settings slice (§3.2.4): theme, colors-tab,
  grid effects & spacing. Blocklist enforced here (text sizes, performance knobs,
  view-size reset, connected accounts, import/export keys NEVER ride — structurally
  absent, not unchecked).
- **IconsetPublisher** — the icon-registry subset (lookio's iconsets shape, ≤2 MB).
- **LayoutPublisher** — icons, positions, dots, families, the canvas camera.
- **PortalPublisher** — portal entities + the pair graph + target uuids (+ optional
  embedded target canvases via ChildCanvasPublisher, size-accounted).
- **AssetsPublisher** — custom images/icons with per-file + total caps.

**Format: `.doomcanvas` — a ZIP** (fflate vendored; lookio v2 precedent), versioned,
schema-checked. `manifest.json` = uuid/created_at/appVersion/name/author + `contents{}`
(the merge of every publisher's manifestSlice = the toggle tree's chosen state) +
`sizes{}` + `flags{provenance, requires[]}`, plus per-publisher payload files
(`settings.json`, `iconsets.json`, `canvas.json` = layout+portals, `chats/<sid>.json`,
`assets/…`, `children/<uuid>.doomcanvas`).

**Import (per-publisher, polymorphic — one driver loop):**
- The composite walks publishers in dependency order (assets → iconsets → settings →
  chats → layout → portals); each `applyImport` writes a rollback journal entry
  (lookio's failed-apply-rollback precedent, now per-component).
- Chats POST engine-side with **fresh session ids** (collision law: always rebind; the
  restore-time heals already tolerate it), old→new map kept for future relationship links.
- Missing provider key/model → warnings + a recommended-model fallback; personas land
  **inactive** with provenance badges; no tool/hook auto-activation from imports (R7).
  Text size stays global (the user's exclusion) — a bundle carrying it is a schema
  violation and rejected.
- Validation: schema walk per publisher slice, zip ladder (R6), entry/size caps
  (proposed: 96 MB total, 8 MB/chat history, 6 MB/asset), decompression-ratio guard,
  portal-target integrity (uuid refs resolve, else "lost").

### 3.6 W6 — THE LIBRARY SHIP (hub integration) · **Cost: M-L (~600-800 LOC)**

- **New hub type `chat` (tag `doomalay-chat`) — the user's REV 2 ask: "chats are a whole
  lib section themselves".** Publishing a chat = ChatPublisher standalone (§3.5): the
  full toggleable metadata tree + the downloaded bundles it uses; downloading = a new
  chat icon on the current canvas (a choose-canvas picker when portals exist). BYOK
  warnings, provenance marks, and history toggles ride the SAME applyImport as the canvas
  path — one publisher, two front doors, zero divergence.
- New hub type `canvas` (tag `doomalay-canvas`, payload `.doomcanvas`), riding the existing
  registry/publish/download/collections machinery. Publish caps: total ≤ 96 MB via LFS (R8 —
  trivial for HF), card = canvas thumbnail, description + toggle-tree summary auto-written.
- The browser (`WebIcon`) ships **inside** canvas bundles but gets **no own hub listing**
  (the user's call — it's still primitive). It needs no new hub code — that's just W5
  serialization.
- Trust ladder upgrade (shared with W5): schema validation for ALL payload types the canvas
  path touches (closing the "no validation on persona/preamble apply" gap at hubitem.js:563-585
  for canvas-sourced imports), provenance badges, and the existing endorsement-gated-on-download.
- No report/moderation endpoint exists on HF datasets today — out of scope for v1; documented
  risk (public library = public content).

---

## 4. PERFORMANCE & MEMORY BUDGET (the "keep it as is if not better" law)

| Budget | Target | Basis |
|---|---|---|
| Per-frame cost added by ALL of this | **0** (and W0 removes existing cost) | Bounds = O(1) clamps at existing write sites; portals = refs, no per-frame physics work; the sleep law makes at-rest icons ~free; no new tick handlers; switch is a burst |
| World switch (100 icons) | < 400 ms burst, no dropped frame after settle | DOM rebuild ~100 nodes (existing boot path does this today), deferred raster, staggered destroys |
| Live memory | Active world unchanged; each frozen world ≈ its JSON (KBs–low MBs) + ≤64 KB thumb | R9: JSON stashes, not detached trees |
| Storage | N worlds ≈ N × (state JSON + thumb); 50 canvases ≈ low tens of MB engine-side | engine SQLite, no WebView quota |
| Lattice | Unchanged (periodic tiles are world-size-free) | §1.2 |
| Pixi | Unchanged while active; swap = removeChildren + staggered destroy | R5 |
| Frame cost (W0 THE FIELD) | O(visible), not O(world) — a 500-icon world costs like a 20-icon viewport; at-rest icons ~zero JS | R11/R12 + the sleep law; rig-budgeted |
| Boot cost (W0) | Flat with install age; hub/model syncs deferred to first use | H3 + the boot-budget regression test |
| Portal transition | ~1.4 s total (700 ms dive + 700 ms emerge), cancellable until the swap point | §3.3 state machine on the existing camera pipeline |
| APK size | +0 (no new libs; fflate/Pixi already vendored) | §1 |

Red lines inherited: no hardcoded colors (pin A5 enforces), UI only via Panel/Overlay,
no per-frame style-var streams (the v1.12 lesson), nothing in the coast path.

---

## 5. SECURITY THREAT MODEL (canvas bundles are untrusted input)

1. **Secrets**: structurally impossible in-bundle (vault unreachable from the builder; keys
   API has no read path). Verified by a rig assertion: no bundle field matches vault entry shapes.
2. **Malicious bundles**: data-only by law — a bundle can never carry executable code
   (`.sh`/`.py` hub types stay manual-run and are NOT part of canvas bundles). Schema
   validation + zip ladder + caps + rollback on every import path.
3. **Resource exhaustion**: nested zip bombs / nested canvas recursion → depth cap 3, entry
   caps, per-file + total caps, ratio guard, timeout (R6 checklist).
4. **Prompt injection via imported history/personas** (R7): provenance badges, personas
   inactive on import, no auto tool/hook activation, spotlighting docs. Residual risk
   honestly documented — it is a property of LLMs, not of our pipeline.
5. **Path traversal in assets/**: lookio's whitelist + normalization, reused.
6. **SVG/dataURL assets**: existing validators (`validateIconSVG`, dataURL ≤ caps) reused;
   image decode in a sanitized pass (already the theme-texture path's behavior).
7. **Device handles / Termux roots**: non-serializable → "reconnect required" rows; a bundle
   cannot silently re-grant folder access (FSA permission prompt re-fires by browser law).

---

## 6. PHASED DELIVERY (each phase = rig-proven, committed, pushed — house convention)

| Phase | Name | Ship | Content | Size |
|---|---|---|---|---|
| v1.42.1 | THE LONG HAUL (audit) | v1.42.1 | W0: the hypothesis rigs (WAL/cache/boot-storms/world-size creep) + rig-proven hygiene (checkpoint/vacuum cadence, TTLs, deferred boot syncs) + the aged-state harness joins the battery | M |
| v1.42.2 | THE FIELD | v1.42.1 | W0: the visibility law (O(visible) DOM culling) + the sleep law + the frame-budget rig; Option B (full-Pixi icons) only if the rig demands | M-L |
| v1.42.3 | THE EDGE | v1.42.2 | W1 bounds + physics walls + settings key + edge rig | S |
| v1.42.4 | THE LEDGER | v1.42.2 | engine canvases table + /api/canvases + Worlds registry + state.v2 migration | M |
| v1.42.5 | THE SWAP | v1.42.3 | freeze/switch + settings layering + switch-budget rig + the manager panel core | L |
| v1.42.6 | THE SINGULARITY | v1.42.3 | portals: HoleEntity + two-way pairing + dive/emerge transition + cancel + rig | M |
| v1.42.7 | THE MANAGER | v1.42.3 | the worlds overlay full spec (rows / browse-the-library row / create row / local rename incl. downloaded / generic defaults) | M |
| v1.42.8 | THE VESSEL | v1.43.0 | the Publisher contract + the six publishers + CanvasPublisher composite + .doomcanvas + import rig | L |
| v1.43.0 | THE LIBRARY SHIP | v1.43.0 | hub types chat + canvas + publish/download + nested accounting + provenance + trust ladder | M-L |

Ordering rationale (REV 2): the audit runs FIRST because everything else inherits its
cost shape and its findings may re-order the queue; the render rework precedes the swap
(a frozen world must be provably zero-cost, and a live one must stay cheap under many
worlds); bounds stay trivial and early; registry before swap; portals before the manager
(the manager wires portal pairs); the publisher framework before the library (chat and
canvas types share ChatPublisher — build it once, front-door it twice).

**Cost summary (engineering)**: ~9 phases, ~5 sessions-ish of phase-pushes at the current
cadence; the two risk concentrations are v1.42.2 (the render rework — measurement-led,
fallback-coded) and v1.42.5 (the swap — the singleton unwiring). No rewrite anywhere; no
new dependencies; APK size unchanged.

### The will-NOT list (the spaghetti boundary)
- No code execution from bundles. No scripts in .doomcanvas, ever.
- No secrets/OAuth in bundles; no bundle-side account linking.
- No real-time collaboration, no multiplayer, no cloud sync (out of scope, unrequested).
- No React islands, no framework migration, no new UI surfaces outside Panel/Overlay.
- No per-frame cost additions of any kind.
- No full-Pixi icon-layer rewrite (W0 Option B) unless the rig proves the cull/sleep laws miss budget — and then behind a settings flag, default OFF.
- No private/encrypted hub listings in v1 (public library only).
- Browser stays unlisted on the hub (user's explicit call).

---

## 7. OPEN QUESTIONS (non-blocking; defaults chosen so work can start)

1. **Q1 — the 7 s metric**: default world 65,536 × 65,536 (±32,768), configurable
   16k→128k + off. Confirm or re-tune after feeling v1.42.1.
2. **Q2 — black hole semantics: ANSWERED (REV 2)** — simple two-way portals holding a
   canvas ref, zoom-through transition with move-to-cancel, auto-paired return portal,
   no attractor mode, no caps. §3.3 as specified.
3. **Q3 — chat history in published bundles**: proposed default **OFF** (private until
   toggled), per-chat switch at publish.
4. **Q4 — canvas count cap: REVISED (REV 2)** — no cap. The registry is rows in SQLite;
   frozen worlds are just rows + thumbnails. Perf guidance lives in the manager (a size/
   count readout), not a wall. The old soft-cap-50 proposal is withdrawn.
5. **Q5 — history cap per chat in a bundle**: proposed last 200 turns or 8 MB, whichever first.
6. **Q6 — thumbnail privacy**: thumbnails show layout, not content (icons are abstract) —
   publish toggle anyway. Confirm.
7. **Q7 — global font**: `fontFamily` global or canvas-scope? Proposed global (device
   preference) with a settings-bundle toggle to include it.
8. **Q8 — naming (REV 2)**: UI keeps "canvases" (the user's word — "canvas or world or
   whatever we name it"); "worlds" stays the code/module name; portals are "portals" in
   UI. One string map if you rename later.
9. **Q9 — portal transition timing (REV 2)**: proposed 700 ms dive / 700 ms emerge
   ("slowly as a loading" per your spec; tunable after feeling it). Move-to-cancel
   confirmed.
10. **Q10 — chat history default (REV 2)**: unchanged default OFF (Q3), now enforced
    through ChatPublisher so the chat hub type and canvas bundles share one switch.

---

## 8. SOURCES (the web pass)

- Babylon.js — Large World Rendering / Floating Origin: https://doc.babylonjs.com/features/featuresDeepDive/scene/large_world
- Godot Docs — Large world coordinates: https://docs.godotengine.org/en/stable/tutorials/physics/large_world_coordinates.html
- Unity DOTS double-precision discussion (50 km guidance; 2 km jitter field reports): https://discussions.unity.com/t/large-world-coordinates-double-precision-data/902530
- tldraw — Persistence & snapshots (.tldr StoreSnapshot, schema migrations): https://tldraw.dev/sdk-features/persistence · https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/utils/tldr/file.ts
- JSON Canvas (Obsidian) — open infinite-canvas file format (nodes/edges, versioned): https://jsoncanvas.org
- Excalidraw export-size pain (issue #2723) + zoom-range ask (#8741): https://github.com/excalidraw/excalidraw/issues/2723 · /8741
- MDN — Storage quotas and eviction criteria (10 MiB web storage cap): https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- web.dev — Storage for the web; Persistent storage: https://web.dev/articles/storage-for-the-web · https://web.dev/articles/persistent-storage
- super-productivity #7901 — hardening against Android WebView IndexedDB eviction: https://github.com/super-productivity/super-productivity/issues/7901
- MDN — Origin Private File System (evaluated; not needed — engine owns storage): https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- PixiJS v8 — Garbage Collection; Performance Tips (staggered destroys, filters cost): https://pixijs.com/8.x/guides/concepts/garbage-collection · https://pixijs.com/8.x/guides/concepts/performance-tips
- Android Developers — Zip path traversal: https://developer.android.com/privacy-and-security/risks/zip-path-traversal
- Snyk — Zip Slip research (ecosystem-wide): https://security.snyk.io/research/zip-slip-vulnerability
- OWASP GenAI — LLM01:2025 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection
- Microsoft MSRC — Defending against indirect prompt injection: https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks
- Hugging Face — Storage limits (LFS per-file up to 50 GB): https://huggingface.co/docs/hub/en/storage-limits · https://discuss.huggingface.co/t/is-there-a-size-limit-for-dataset-hosting/14861
- web.dev — Detached window memory leaks: https://web.dev/articles/detached-window-memory-leaks
- web.dev + MDN — content-visibility (offscreen render skip; Baseline 2024; the transform-culling caveat): https://web.dev/articles/content-visibility · https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility
- PixiJS v8 — Culler Plugin (opt-in cullable/cullArea; manual Culler.shared.cull): https://pixijs.download/dev/docs/app-3.html · https://www.richardfu.net/optimizing-rendering-with-pixijs-v8-a-deep-dive-into-the-new-culling-api
- SQLite — Write-Ahead Logging (checkpoint cadence) + the WAL-vacuum study (vacuum needs a checkpoint to shrink): https://www.sqlite.org/wal.html · https://photostructure.com/coding/how-to-vacuum-sqlite
