# PLAN-V142 — THE MANY WORLDS

**Status: FEASIBILITY ANALYSIS (this session builds nothing — per the standing law: plan → websearch → real plan → build).**
Scope: bounded canvas · black holes · multi-canvas with per-canvas everything · canvas bundles on the public library · canvas-within-canvas.
Baseline: `v1.41.1` (rebased clean, 0 ahead/0 behind at plan time). Ship target: `v1.42.x` (renumber if a parallel wave claims it — the v1.35/v1.40 precedent).

---

## 0. THE ASK, DECOMPOSED

The user's request splits into six workstreams. Every one is assessed below against the
real tree (`engine/internal/server/web/` + `engine/internal/`), with file:line receipts,
web research, cost, and risk.

| # | Workstream | One-line ask |
|---|---|---|
| W1 | **THE EDGE** | Bounded world: width/height ≈ "7 seconds of scrolling at max zoom-out" |
| W2 | **THE SWAP** | Many canvases per user; each with own icons, chats, theme, settings; freeze/snapshot switching; OOP, no coupling, no perf loss |
| W3 | **THE SINGULARITY** | Black holes: new canvas entity, each customizable, each its own instance like chat |
| W4 | **THE DEEP** | Canvas-within-canvas (long-press → "+ canvas"); nested canvases |
| W5 | **THE VESSEL** | Export/import a whole canvas as a sanitized bundle; granular per-setting publish toggles; nested bundles; BYOK for providers |
| W6 | **THE LIBRARY SHIP** | Publish/download canvas bundles on the public hub; "download an entire setup" |

**Honest verdict up front: FEASIBLE without a rewrite.** The tree was accidentally (or
intuitively) pre-shaped for this: the whole world already round-trips through one
serialize/deserialize pair (`saveNow`/`loadState`, app.js:2425-2443); entities are a
registered-type factory (`GridIcon.register`, gridicon.js:39-52); the engine already owns
durable SQLite storage; the hub already ships multi-file items and collections; and
`lookio.js` already implements a hardened ZIP container with zip-slip/bomb ladders and
apply-rollback. The two genuinely hard parts are (a) unwiring ~8 module singletons for
world switching and (b) the bundle manifest/sanitizer — both have in-repo precedents to
extend, not invent.

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

---

## 3. FEASIBILITY & DESIGN (per workstream)

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

### 3.3 W3 — THE SINGULARITY (black holes) · **Cost: M (~450-650 LOC + rig)**

A black hole is a new entity type riding `GridIcon.register('hole', factory)` (§1.3) — it
gets DOM presence, physics, hit-testing, serialize/restore, and persistence nearly free.

**What it is (proposed — the one genuinely open design question, §7 Q2):** a customizable
gravity well that is its own instance, with a config panel like a chat's:
- **Mode A — Attractor**: O(members) pull in `Physics.World.step` (per-entity force toward
  the well, mass/radius params); orbiting icons visually cluster around it (an organizational
  gravity group — the "compartmentalization" tool on-canvas).
- **Mode B — Portal**: holds a `childWorldId` — the canvas-within-canvas launcher (W4 rides
  this entity; long-press → "enter"). This unifies the user's two asks elegantly: a nested
  canvas IS a black hole you fall into.
- Instance config (serialized per hole): name, mode, mass, reach radius, spin, visual params
  (accretion ring density, lensing wobble, distortion strength), palette (theme-token keyed —
  ZERO hardcoded colors; new theme slots only if needed, riding FALLBACKS discipline),
  label, pinned, portal target.
- Rendering: `#c2` paint pass (atoms.js precedent — Path2D-cached, sprite-baked) + a Pixi
  mirror when the GPU layer is live (shell-atlas precedent). Physics attractor is O(members)
  inside the existing step — no new per-frame systems.
- "Own instance like the chat": tapping a hole opens its panel (name/params/mode/portal
  target/contents list). Panel rides Panel/UIKit laws; config lands in `app_settings` or the
  entity serialize — whichever the state audit prefers.

Cost drivers: the visual (accretion disk done cheaply — baked sprites, no per-frame filters;
Pixi filters are explicitly perf-dangerous per R5 docs) and the attractor tuning. Everything
else is the factory pattern.

### 3.4 W4 — THE DEEP (canvas-within-canvas) · **Cost: M (~300-450 LOC on top of W2/W3)**

- `canvases.parent_id` makes the registry a tree. Depth cap **3** (root → child → grandchild)
  for memory sanity and navigation clarity.
- Entry: long-press canvas → radial "+ Canvas" (creates child + portal hole at drop point),
  or from a hole's panel. The user's exact words ("additional row when a canvas is held down").
- Navigation: breadcrumb chip row (World A ▸ World B) + system-back mapping; switch = W2's
  `switchTo` with a back-stack. Frozen ancestors are just rows.
- Bundles: a canvas bundle may embed child canvases (recursion capped by depth + size — §3.5).
- Thumbnails of children surface inside the parent's hole panel ("what's inside").

### 3.5 W5 — THE VESSEL (canvas bundles) · **Cost: L (~1,000-1,400 LOC incl. engine sanitizer)**

**Format: `.doomcanvas` — a ZIP** (fflate already vendored; lookio v2 precedent), versioned,
schema-checked:

```
manifest.json      schema v1: uuid, created_at, appVersion, name, author,
                   contents{} (the toggle tree's chosen includes), counts,
                   sizes (computed recursively), flags (provenance, requires[])
canvas.json        WorldState (camera, icons, dots, holes+configs, child refs)
settings.json      CANVAS-scope settings slice (per §3.2.4) — blocklist-enforced
iconsets.json      icon registry subset (lookio's existing shape, ≤2 MB cap as today)
chats/<sid>.json   per-chat: session row subset + events (TOGGLE, default per §7 Q3)
assets/…           custom icons/images (per-file caps, total cap)
children/<uuid>.doomcanvas   nested child canvases (depth-capped)
```

**The publish toggle tree (the user's "each setting within each setting" ask):** the manifest
schema IS the toggle tree — the publish sheet renders groups (Canvas layout / Settings ▸
Colors, Grid / Icon sets / Chats ▸ per-chat ▸ history, workspaces, persona, tweaks /
Black holes / Child canvases) with per-leaf switches. Banned keys are **structurally absent**
(not just unchecked): a `PUBLISH_BLOCKLIST` in one module — connected accounts, view-size
reset, performance knobs, import/export settings, text sizes, and (hard law) anything
vault-backed. The bundle builder physically cannot reach the vault (`/api/keys` returns
has_key flags only) — BYOK is enforced by architecture, not by discipline.

**Chatbot bundling:** a chat = session subset (name, model id, provider name, capabilities,
template/preamble/persona refs, tweaks, pinned, skills/mind) + optional history (seq-ordered
events, capped) + optional artifacts (per-file cap) + workspace **references** (host/repo/branch
— never tokens; device/Termux folders export as "reconnect required" rows). Custom chat icons
already engine-side (`/api/sessions/{sid}/icon`) — exported into assets/.

**Nested bundles:** a chat may reference library bundles it downloaded (the user's "bundled
libraries"); v1 exports those as **hub references** (type|repo|id) with an optional
"embed copies" switch for offline portability. Size accounting walks the tree recursively
(references counted at last-known size) and the publish sheet shows the total before upload.

**Import (the other half of V):**
- New world created from `canvas.json`; sessions POST engine-side with **fresh session ids**
  (collision policy: always rebind; the icons' session heals already tolerate this), mapping
  old→new kept in world state for future relationship links.
- Missing provider key/model → non-blocking warnings; model falls back to a recommended
  provider (capabilities precedent); the chat opens ready-to-configure.
- Imported personas land **inactive** with a provenance badge (current hub import law,
  hubitem.js:788-790); imported history is marked (R7); no tool/hook auto-activation from
  imports. Text size stays global (user's exclusion) — a bundle carrying it is a schema
  violation and rejected.
- Validation: full schema walk, zip ladder (R6), depth ≤ 3, entry caps, per-file + total caps
  (proposed: 96 MB total, 8 MB/chat history, 6 MB/asset), decompression-ratio guard,
  apply-with-rollback (lookio precedent).

### 3.6 W6 — THE LIBRARY SHIP (hub integration) · **Cost: M (~450-650 LOC)**

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
| Per-frame cost added by ALL of this | **0** | Bounds = O(1) clamps at existing write sites; attractor = O(members) in existing step; no new tick handlers; switch is a burst |
| World switch (100 icons) | < 400 ms burst, no dropped frame after settle | DOM rebuild ~100 nodes (existing boot path does this today), deferred raster, staggered destroys |
| Live memory | Active world unchanged; each frozen world ≈ its JSON (KBs–low MBs) + ≤64 KB thumb | R9: JSON stashes, not detached trees |
| Storage | N worlds ≈ N × (state JSON + thumb); 50 canvases ≈ low tens of MB engine-side | engine SQLite, no WebView quota |
| Lattice | Unchanged (periodic tiles are world-size-free) | §1.2 |
| Pixi | Unchanged while active; swap = removeChildren + staggered destroy | R5 |
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
| v1.42.1 | THE EDGE | v1.42.1 | W1 bounds + physics walls + settings key + edge rig | S |
| v1.42.2 | THE LEDGER | v1.42.1 | engine canvases table + /api/canvases + Worlds registry + state.v2 migration | M |
| v1.42.3 | THE SWAP | v1.42.2 | freeze/switch mechanics + canvas manager panel + settings layering + switch-budget rig | L |
| v1.42.4 | THE SINGULARITY | v1.42.2 | black holes (entity, attractor, portal stub, panel, serialize) + rig | M |
| v1.42.5 | THE DEEP | v1.42.3 | canvas-in-canvas (parent_id tree, "+ Canvas", breadcrumbs, depth cap) | M |
| v1.42.6 | THE VESSEL | v1.43.0 | .doomcanvas export/import + toggle tree + sanitizers + conflict policy + import rig | L |
| v1.43.0 | THE LIBRARY SHIP | v1.43.0 | hub 'canvas' type + publish/download + nested accounting + provenance + trust ladder | M |

Ordering rationale: bounds first (trivial, immediately felt, de-risks nothing else);
registry before swap (storage must exist); black holes before deep (portals need the entity);
vessel before library (format must be final before it's public). Phases 1-3 alone deliver a
usable multi-canvas app; 4-5 deliver the cosmology; 6-7 open the library.

**Cost summary (engineering)**: ~7 phases, 4 sessions-ish of phase-pushes at the current
cadence; largest single risk concentration in v1.42.3 (the swap). No rewrite anywhere; no
new dependencies; APK size unchanged.

### The will-NOT list (the spaghetti boundary)
- No code execution from bundles. No scripts in .doomcanvas, ever.
- No secrets/OAuth in bundles; no bundle-side account linking.
- No real-time collaboration, no multiplayer, no cloud sync (out of scope, unrequested).
- No React islands, no framework migration, no new UI surfaces outside Panel/Overlay.
- No per-frame cost additions of any kind.
- No private/encrypted hub listings in v1 (public library only).
- Browser stays unlisted on the hub (user's explicit call).

---

## 7. OPEN QUESTIONS (non-blocking; defaults chosen so work can start)

1. **Q1 — the 7 s metric**: default world 65,536 × 65,536 (±32,768), configurable
   16k→128k + off. Confirm or re-tune after feeling v1.42.1.
2. **Q2 — black hole semantics**: proposed = attractor + portal (canvas-in-canvas) in one
   customizable entity. If you meant purely visual/organizational (or something else —
   trash-can? warped region? spawn point?), W4 re-routes but W3's shape holds.
3. **Q3 — chat history in published bundles**: proposed default **OFF** (private until
   toggled), per-chat switch at publish.
4. **Q4 — canvas count cap**: proposed soft cap 50 with a friendly warning (perf headroom),
   hard limit none.
5. **Q5 — history cap per chat in a bundle**: proposed last 200 turns or 8 MB, whichever first.
6. **Q6 — thumbnail privacy**: thumbnails show layout, not content (icons are abstract) —
   publish toggle anyway. Confirm.
7. **Q7 — global font**: `fontFamily` global or canvas-scope? Proposed global (device
   preference) with a settings-bundle toggle to include it.

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
