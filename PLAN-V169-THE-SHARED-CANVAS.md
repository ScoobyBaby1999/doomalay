# PLAN-V169 — THE SHARED CANVAS (foundations)

**The ask (2026-10-23, verbatim core):** "I wanna add sharable canvases… you may make sure the
foundations are in place… in a modular OOP method, aiming for a modular system made of
inheritance and components." The features: (1) per-canvas / per-bundle **management dashboard**
(view/edit/rename/delete published bundles); (2) **fork detection** (a derivative bundle is
tagged as a fork — "just a throwaway feature"); (3) THE core: **cross-canvas multi-user
multi-device sharing** — one user OR multiple users, each with one OR many devices, all live on
the SAME canvas simultaneously; per-canvas (NOT per-account) device authorization; portals that
carry their own device sets (a portal's target does NOT share the source canvas's members);
portal icons only render for devices with permission to jump ("until then it is unknown to
them"); live sync "as live as we can get" with **performance literally THE SAME for 1 device or
N**; access "ideally impossible for a random user to gain without a one-time manual human
authenticated handshake"; shared = icons (capabilities/toggles/relationships/locations),
browsers, all canvas things, chat history + chat settings (name/model/new chats reflect);
NOT shared = "personal customisations like the settings theme, text size, and generally most
if not all settings."

**The law carried from the owner:** plan all phases in detail → web-search the docs → real
plan → build → revise/test/redteam as a real user. (Done: see RESEARCH below.)

---

## THE RESEARCH (web + repo, before any build)

### The published answers (collab-research/REPORT.md, 37 primary sources)

1. **Figma's multiplayer architecture is the production-proven answer for our exact shape**
   (a small ID-keyed visual doc, one authoritative host): server-authoritative
   **property-level op-log**, merge = **LWW per (object, property) with server arrival order
   as the one clock** ("we don't need a timestamp because the server can define the order of
   events"), explicit create/delete ops, **client-generated object IDs** (offline-safe),
   optimistic local application (discard incoming changes that conflict with my un-acked
   ones), **reconnect = fresh snapshot + reapply local ops on top** ("no transform functions,
   no CRDT merge"), durability = checkpoint + per-doc seq journal (95% saved < 600ms).
   They explicitly rejected OT (combinatorial explosion) and true CRDTs (designed for no
   central authority — we HAVE one).
2. **Pure-Go CRDTs now exist** (reearth/ygo — production at Re:Earth, byte-compatible with
   yjs, CGO-free SQLite) but do NOT change the choice: our doc is a tiny flat ID-keyed map,
   the host is authoritative by requirement, the owner wants game-engine/rebase semantics,
   and a Yjs server implies a Yjs client engine — a second sync subsystem. **Recorded as
   Plan B** (multi-writer offline merge with no reachable host).
3. **The Go WebSocket room = the gorilla hub pattern, verbatim**: register/unregister/broadcast
   chans + one `run()` select-loop goroutine (single serialization point); per-conn
   `send chan []byte` 256; **broadcast = select-default → disconnect the slow client, never
   block the writer** (self-heals: reconnect + sinceSeq replay); pings **30s** (Cloudflare
   kills idle proxied WS at ~100s — the 75% rule), pongWait 60s, writeWait 10s.
4. **Enrollment = RFC 8628 shape, NO PAKE** (researched ADB SPAKE2, BT numeric comparison,
   Matrix SAS, WhatsApp QR): our gate is TLS-via-tunnel + the owner's PHYSICAL Allow tap —
   a 6-digit code (1-in-10⁶ ONLINE guess), ≤5min TTL, single-use, rate-limited start covers
   the actual threat. Minted credential = **opaque 256-bit random token, stored sha256-hashed**
   — revocation is one UPDATE, nothing forgeable offline. Production room tokens
   (Liveblocks/PartyKit/Supabase) validated the per-room scoped-token pattern.
5. **Presence = ephemeral awareness, Yjs law**: in-hub map, client re-broadcast ≥ every 15s,
   prune at 30s silence, latest-state semantics (coalesce cursor/viewport), NEVER persisted,
   never seq-stamped, never replayed.
6. **JSON Patch (RFC 6902) REJECTED** — positional pointers break under concurrent array
   mutation and it has no conflict semantics. Domain ops, ID-addressed, property-level.
7. **Unreal Engine mapping (the owner's mental model, validated)**: authoritative host state
   = the room's in-memory doc; clients send inputs (ops), never state; the op-log broadcast =
   the replication stream; **per-device ACL = relevancy** (IsNetRelevantFor → per-connection
   visibility); **dormancy = our zero-cost-when-idle requirement, structurally** (an empty
   room parks on select — zero timers, zero frames).
8. **Reconnect/rebase**: seq cursor + subscribe-first (buffer live) + durable catch-up
   (`ops?since=`) + ONE idempotent merge gate (opId dedupe + seq high-water) + reapply pending
   un-acked ops (drop if fresh state already reflects them). At-least-once + opId dedupe =
   exactly-once application.

### The repo truths (the two Explore maps)

- **The doc**: a canvas = one `canvases` row, `state` = opaque WorldState JSON
  `{offset, scale, currentFamily, icons[], dots[], settings(canvas-scope), savedAt, canvas,
  imported?}`. Icons are client-minted-id objects (`chat`|`web`|`hole` typed, GridIcon
  registry); dots = tab groups; portals = `hole` icons holding `targetWorldId` + `pairId`
  (flat ref graph, cycles fine, **NO permissions today**).
- **The two choke points**: client — `saveNow()` (app.js:3000) is the single serialization
  funnel (every one of ~25 mutation sites → scheduleSave/saveNow; the `lastSavedBody` content
  memo already diffs whole-state writes); server — `store.UpsertCanvas` + PUT
  `/api/canvases/{id}` (absent-fields-keep COALESCE law).
- **The proven in-house pattern to clone**: `chat_events` — append-only, `seq` per session,
  `UNIQUE(session_id, seq)`, `?since=` replay, persist-then-forward, turns survive
  disconnect. The op-log is this pattern promoted to the document.
- **The cadence laws to inherit**: client save 200ms debounce; engine sync calm ≥2s
  (SYNC_MIN_MS, the drag law); pagehide/visibility flushNow keepalive.
- **Zero identity today**: one global bearer or localhost-trust (`authMiddleware`
  server.go:1054); no users, no devices, no per-canvas ACL. Greenfield.
- **Hub/bundles**: `.doomcanvas` = zip (manifest `{format, formatVersion, uuid, name,
  author}` + canvas.json + chats/ + children/); publish = HF dataset repo commit
  (`ItemID(name,author)` — same name republish REPLACES, never forks); bundle = collection;
  **no author-filtered "mine" view, no unpublish, no lineage/content-hash** → the dashboard +
  fork tags are greenfield.
- **Settings split today**: CANVAS_SCOPE_KEYS (theme/grid — the LOOK) ride the world row;
  text sizes/renderer knobs/worldSize are device-global. **The owner now rules theme is
  PERSONAL** → the shared doc must exclude the settings slice; worldSize is STRUCTURAL
  (two devices with different plate sizes diverge) → worldSize moves INTO the doc.

---

## THE MODEL (the OOP foundation)

### The doc/view split (THE LAW OF TWO PLANES)

- **THE DOC** (shared when live): `icons[]`, `dots[]`, `currentFamily`, `worldSize`.
  The doc is what syncs — icons carry capabilities/toggles/relationships/locations; dots are
  the groups; portals are `hole` icons; worldSize is structural truth.
- **THE VIEW** (always personal, never broadcast): camera `{offset, scale}`, the settings
  slice (theme/grid/text sizes — "personal preference"), everything else in Settings.
- The single JSON blob STAYS the storage format (back-compat with every existing row, save,
  bundle); the doc is a PROJECTION of it: `docOf(state) = {icons, dots, currentFamily,
  worldSize}`. A guest keeps its view slice device-local (localStorage
  `doomalay.collab.view.<canvasId>`); the row's view slice stays the host's.
- **worldSize migrates into the blob**: `state.worldSize` (absent → the device's
  Settings.worldSize fallback → 16384). The dial writes the active canvas. Old canvases are
  byte-identical (fallback); new dial writes are per-canvas (a shared canvas MUST carry one
  plate size).

### The op protocol (Figma's, domain-shaped)

```jsonc
// client → server (one frame per op; ops batch per submit)
{ "opId": "<deviceId>:<counter>",          // retry-stable, dedupe key
  "kind": "icon.set" | "icon.add" | "icon.remove"
        | "dot.set" | "dot.add" | "dot.remove"
        | "doc.set",
  "id": "<iconId|dotId|'_'>",              // '_doc_' for doc.set
  "props": { ... },                        // icon.set/dot.set: the changed fields ONLY
  "value": <any>, "path": "currentFamily|worldSize",  // doc.set
  "icon": {...}, "dot": {...} }            // .add carries the full serialize()
// server → clients (the ack + ordering + fan-out are ONE mechanism)
{ ...the op, "seq": N, "device": "<deviceId>", "at": <unixms> }
```

- **LWW per (id, property), server arrival order is the one clock** (no client timestamps).
- Merge conflict policy = Figma's: a client with a PENDING un-acked op on (id, prop) ignores
  the incoming server value for that (id, prop) until its ack lands (optimistic local wins).
- Ops ride the EXISTING 200ms saveNow debounce — derivation diffs `docOf(state)` against the
  last-emitted doc snapshot (the `lastSavedBody` memo's own law, promoted to the doc plane).
  Zero new render-path cost; a drag settles into ONE `icon.set {x,y}` op.

### The room (server-authoritative, Unreal-mapped)

- `engine/internal/collab`: `Hub` (rooms map + one run() goroutine) → `Room` per shared
  canvas: subscriber set, in-memory folded doc (loaded once: row state + ops since
  `fold_seq`), presence map (ephemeral), recent-op ring for cheap catch-up.
- **Durability = checkpoint + journal** (Figma 2022): `canvas_ops` table
  (`seq INTEGER PRIMARY KEY AUTOINCREMENT, canvas_id, device_id, op, at` + index) is the
  journal; the existing `canvases.state` is the checkpoint, rewritten on a CALM 2s debounce
  (the same cadence law) with a `fold_seq` watermark column — cold boot folds
  `ops(seq > fold_seq)`. `ops?since=N` is the catch-up; WS is the optimization, HTTP the
  dependency.
- **Gated portals = relevancy**: the room serves each member a doc VIEW filtered by that
  device's visible-canvas set — a `hole` icon whose `targetWorldId` is not in the set does
  not exist for that device ("it is unknown to them"). The host (owner) sees all.

### The handshake (RFC 8628-shaped, human-gated)

- Tables: `collab_devices(id, name, token_hash, created_at, last_seen, revoked_at)`,
  `collab_members(canvas_id, device_id, role, joined_at)` — **per-canvas, not per-account**
  (the owner's explicit law: each canvas carries its own authorized device set; a portal's
  target never inherits the source's members), `collab_invites(canvas_id, code, device_code,
  expires_at, claimed_name, approved_at)`.
- Flow: owner mints invite (6-digit code, 5min TTL) in the SHARE SHEET (Overlay screen — the
  worldsmanager pattern) → joiner opens the JOIN SHEET (host URL + code + device name) →
  `POST /api/collab/pair` (rate-limited, code-gated, single-use claim → `device_code`) →
  joiner polls `/api/collab/pair/{device_code}` every 5s → the owner's sheet shows the claim
  ("Pixel 9 · code 482913") → **Allow tap** (the human handshake) → server mints the opaque
  token + member row → the poll returns `{device_id, token}` → the device stores it
  (localStorage, keyed by host origin) and connects the live room.
- **collabAuth**: the device token authenticates ONLY collab surfaces (pair, live, ops, the
  scoped doc read) and ONLY for canvases the device is a member of. Everything else stays
  behind the global bearer/localhost law. Revocation = one UPDATE + room eviction + doc
  re-filter.

### The performance law (the owner's hard requirement)

- **Solo = today, byte-for-byte**: unshared canvases never open a room, never start a timer,
  never send a frame (dormancy — an empty hub parks on select).
- Shared cost scales with MEMBERS, not with canvas size or frame rate: ops are ~100–500B
  JSON, derived on the existing save debounce, fanned out on the room goroutine (never the
  render path, never the SQLite hot path during turns — checkpoint is 2s-calm).
- Presence is latest-state coalesced (a pointer storm costs the room O(1) per device), never
  persisted, pruned at 30s.
- No polling anywhere except the RFC 8628 pair poll (5s, enrollment only, ends at approval).

---

## THE PHASES (three-dot pushes; ship x.1.x at the end)

### v1.69.1 — THE DOCUMENT (the model layer, zero behavior change)
- `store`: `canvas_ops` table + accessors (AppendOps/ListOps/since — the chat_events law
  cloned); `canvases.fold_seq` via ensureColumn; ops GC (compaction with checkpoint).
- `collab` package: `op.go` (Op types + strict validation), `doc.go` (DocOf projection,
  fold op→state), `codec.go` (JSON wire). Pure, testable.
- PWA `collabcore.js`: `OpCodec` — `diffDocs(prev, next) → ops[]` and `applyOp(doc, op) →
  doc'` (pure functions, node-rig path like worlds.js). The doc projection helpers +
  worldSize-into-blob migration in app.js (Settings fallback — old canvases byte-identical).
- **Pins**: fold law (ops → state == client state, property-level); diff→apply round-trip;
  validation rejects garbage; solo-save byte-identity.

### v1.69.2 — THE ROOM (the live sync core)
- `collab/room.go` + `hub.go`: the gorilla pattern (chans, 256-slot send, slow-client
  disconnect, 30s ping/60s pong, writeWait 10s), per-canvas rooms, in-memory fold + 2s calm
  checkpoint + fold_seq, sinceSeq replay on join, presence (15s/30s law).
- `server/collabapi.go`: `GET /api/collab/{canvas}/ops?since=`, `POST /api/collab/{canvas}/ops`,
  WS `GET /api/collab/live?canvas=&since=&token=` (owner-session-auth this phase); the room
  rebroadcasts chat-event notifications for the canvas's sessions (guest history sync rides
  the existing `GET /api/sessions/{id}/events?since=` twin).
- PWA: `CanvasLiveClient` (WS, lastSeq cursor, opId dedupe, pending-ack map, jittered
  reconnect ladder, 30s heartbeat) + `SharedCanvasStore extends LocalCanvasStore` +
  the OOP facade in app.js (`CanvasStore` base → `LocalCanvasStore` today's exact path →
  shared override derives ops at the saveNow diff and applies remotes with echo suppression).
- **Pins**: two-client live rig (A moves an icon → B sees it, real WS, real binary); since
  replay; dedupe; LWW; slow-client disconnect; **solo zero-cost pin** (no frames, no timers).

### v1.69.3 — THE HANDSHAKE (identity, ACL, gated portals)
- Tables (devices/members/invites) + `collab/enroll.go` (mint/claim/poll/approve/deny/
  mint-token/revoke) + `collabAuth` (token → member-of-canvas scope) + rate limits.
- PWA: the SHARE SHEET (owner: invite code, pending claims with Allow/Deny, member list
  with revoke) + the JOIN SHEET (joiner: host URL + code + name) — both Overlay screens,
  theme-law only (zero hardcoded colors).
- **Gated portals**: doc views filtered per device (unknown targets don't render); the
  guest canvas list = only shared-with-me; the joiner's view slice stays local.
- **Pins (redteam)**: no code → 404-ish rejection; wrong code ×5 → rate limit; unapproved →
  pending forever (honest TTL expiry); revoked mid-session → eviction + re-filter; guest
  cannot read unshared canvases; portal invisibility for non-members.

### v1.69.4 — THE DASHBOARD (bundles management + fork tags, the "starter")
- Hub: author-filtered `?mine=1` on Items → the MY PUBLISHED view (all bundles); unpublish
  (the commit machinery removes the item); rename = same-id republish; delete-local.
- Fork lineage: `.doomcanvas` manifest formatVersion **1.1** — `parentUuid`, `parentAuthor`,
  `contentHash` (sha256 of canvas.json) stamped at export; import stamps
  `imported.parentUuid`; the manager/library grows the fork badge ("fork of X") on lineage
  match. (The "throwaway feature" — kept minimal, the metadata is the foundation.)
- canvasespanel grows the sharing section (members/invite/revoke entry points).
- **Pins**: mine-filter; unpublish removes remotely; manifest 1.1 lineage round-trip; badge.

### v1.69.5 — THE LIVE PROOF (rig + redteam + ship)
- `scripts/v1690-shared-canvas-rig.mjs`: two fake devices (two WS clients + two op-derivers)
  against the REAL binary — the golden path (A moves → B applies; A creates chat icon → B
  materializes it; rename reflects; dots sync), the handshake arc (invite → claim → approve
  → token → join → live), the redteam ladder (wrong code, rate limit, revoke, portal
  invisibility, unshared-canvas blindness), the PERF pins (solo == shared steady-state: zero
  frames when alone; op fan-out O(members); checkpoint calm), reconnect (kill B's socket →
  rejoin → since-catchup → rebase), the full battery re-run, cross-compiles.
- Ship: buildinfo 1.69.0 + README v1.69 + the repo worklog record + the tag.

---

## THE CONSTRAINTS (the standing laws)

- **UI**: only the Panel or the Overlay screen for front-facing UI (share/join sheets =
  Overlay screens, the worldsmanager/ConnectOverlay pattern); canvas-native bits (portal
  gating) live on the grid itself.
- **Theme**: absolutely zero hardcoded colors — every new surface rides the CSS vars.
- **Solo parity**: an unshared canvas must behave byte-identically to v1.67 (the perf law).
- **No build step**: PWA edits are vanilla ES6-class modules; the engine embeds the web dir —
  every web change ships via engine rebuild (the rigs build their own binary).
- **Push discipline**: three-dot phases (v1.69.1 → …), rebase before every push (fetch,
  diff, merge, then publish), ship v1.69.0 at the end.

---

## THE RENUMBER ADDENDUM (v1.70.0 shipped mid-wave — the +1 law)

The ROBUST FIELD (PLAN-V170, the 4-provider campaign) shipped buildinfo 1.70.0
while phases 1–3 of this wave were already pushed (v1.69.1/.2/.3 stand). The
remaining phases renumber; the ship takes the next free minor:

- §v1.69.4 → **v1.71.1 THE DASHBOARD** (bundles management + fork tags + the
  canvasespanel sharing section)
- §v1.69.5 → **v1.71.2 THE LIVE PROOF** (the rig `scripts/v1710-shared-canvas-rig.mjs`,
  port 8710, pins `TestV171_…`)
- the ship: **v1.71.0 THE SHARED CANVAS** (buildinfo 1.71.0 + README v1.71 +
  the tag `v1.71.0-the-shared-canvas`)

Two build-time convictions from the live audit (2026-10-23) that the plan's
§v1.169.4 glossed over, resolved here: (a) **rename cannot be same-id republish**
(ItemID hashes the name) — the honest chain is local rename → republish (new
id) → unpublish the old item, surfaced as the MY PUBLISHED view + unpublish;
(b) **the join sheet cannot bind the guest's LOCAL canvas id** (a foreign
device under the deployment law has no host rows) — the CODE resolves the
canvas: mint is collision-free across live invites and Pair accepts an empty
canvas (code-only lookup); the approved poll returns the canvas so the guest
activates onto the real row. Plus the unwired journal GC (TrimCanvasOps had no
caller) rides the checkpoint calm, threshold-guarded.

Harness lesson (the session's own conviction): `rebuild-sandbox.sh` hard-resets
the tree — NEVER run it with uncommitted work; commit (or stash) first.
