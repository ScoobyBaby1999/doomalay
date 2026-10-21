# PLAN-V154 — THE LIBRARY SHIP (PLAN-V142's final phase: hub types canvas + chat)

## 0. THE USER'S ASK (verbatim, distilled)

- "Great! I really apprieciate it, I'll test it later. Now, let's finish what we originally
  deferred. It was called the library ship." — the user, green-lighting the deferred finale.
- The deferral order (v1.50-era): "Not until we can have percise edits for artifacts and
  external and internal repos. We need an unbelibably solid tool for this." — THE SURGEON
  (v1.52) shipped that toolset and the bot proved it end-to-end (RIG C, the glow push).
  The library ship is NOW unblocked.
- The scope is PLAN-V142 §3.6 W6 (REV 2), the last unbuilt phase of THE MANY WORLDS wave:
  hub types `chat` + `canvas` — "download an entire setup" — chats as a whole library
  section themselves.
- The permanent law (the generic prompt): hypothesis → web search → real plan → build →
  revise/test/redteam as a real user.

## 1. INITIAL HYPOTHESIS (before research)

The v1.42.4-8 foundation (canvases table, .doomcanvas bundles, publishers, the manager)
plus the existing hub machinery (8 registered types, HF datasets backend, collections,
endorsement gates) make the library ship mostly a WIRING wave — with four real gaps:

1. The hub registry has NO canvas/chat types — `Register()` is the one door (hub.go:6-8).
2. The transport can't carry the payloads: 26MB publish body cap, 64KB payload cap
   (theme 24MB exception), 8MB hard FETCH cap (silent truncation!), SQLite TEXT payload
   column + /downloads returning ALL payloads inline (the "my items" poison).
3. A standalone chat publish doesn't exist: ChatsPublisher is world-scoped, read()
   hard-requires canvas.json, importBundle always births a canvas row.
4. The trust ladder gap: persona/preamble apply at hubitem.js:563-585 has ZERO validation;
   preambles AUTO-ACTIVATE on import (the counter-precedent to the R7 no-auto-activation
   law); bundle-imported personas ride their claimed mode verbatim.

## 2. RESEARCH (the law: before any build) — done, receipts in the worklog

### 2.1 Code survey (two parallel agents, file:line receipts)

**The hub (Go + web):**
- Registry: `hub/hub.go` LibrarySpec{Type,Label,Tag,PayloadExt,Desc,Hidden}; 8 types
  registered (persona/template/skill/theme/script/doc/python/preamble); `RepoName()` =
  "doomalay-"+Type+"s" → "canvas" would birth `doomalay-canvass` (the foot-gun).
  Hidden types (doc) stay routable but unlisted — the precedent for "no own listing".
- Backend: per-user-per-type HF datasets; item = files in the dataset (items/<id>.json
  meta + items/<id><ext> payload + index + card png); discovery via tag filter
  (?filter=doomalay-<tag>); metrics sidecar doomalay-metrics; collections ride
  item.Collection with self-bundle default (service.go:1234-1236).
- Publish: POST /api/hub/{type}/publish {name,…,payload(string),pngBase64,…} → 26MB body
  cap (server/hub.go:28); payload caps 64KB / theme 24MB (:468); theme precedent = a
  base64 ZIP riding the text payload (hubpublish.js:127-149).
- Commit path: CommitFiles → preupload (per-file uploadMode lfs|regular) → LFS batch →
  presigned PUT → NDJSON commit (hf.go:347-404). CommitFile.Content is []byte.
- Download: Service.Download → resolvePayload (FetchFile, 8MB cap — hubMaxBody hf.go:43,
  :145) → SaveLocalItem (SQLite TEXT) → response {item, payload} inline → client-side
  per-type dispatch (hubitem.js:563-584; bundle twin hub.js:1213-1227).
- Endorsement-gated-on-download: Service.Endorse → ErrNotDownloaded (service.go:1009-1019).
- The forward-wiring: worldsmanager.js:793-800 libHasCanvas checks /api/hub/libraries for
  type==='canvas' → the browse row flips live the moment the type registers (non-hidden).

**The vessel (v1.42.8):**
- `CanvasBundle.importBundle(bytes, opts)` takes Uint8Array DIRECTLY (no File needed —
  canvasbundle.js:410); opts.quiet suppresses the auto-landing; io injectable (the v1428
  rig already drives it headless). NOT BLOCKED for hub download→import.
- The chat landing precedent: openChatBySession's materialize branch (app.js:2443-2465) —
  createIconAt + setName/model/provider + icon.sessionId=sid + icon.save() — EXACTLY the
  "downloaded chat lands as an icon" pattern. NOT BLOCKED.
- ChatsPublisher.applyImport is layout-free (keys only off chats/* + staged assets) and
  ChatsPublisher/AssetsPublisher collect is worldState.icons-scoped — a synthetic
  one-icon worldState scopes them to ONE chat. The .doomchat blocker is only: read()
  requires canvas.json (canvasbundle.js:193-195) + format check (:181) + the driver
  always runs the canvas tail (:438-444). All three are new-format branches, not rewrites.

### 2.2 Web research (HF datasets + LFS)

- **10MB is HF's hard limit for NON-LFS files** (the git-push "file larger than 10MB"
  error; discuss.huggingface.co/t/49198). LFS-stored files carry no practical per-file
  limit for public datasets (discuss/t/14861).
- **HF seeds a default .gitattributes routing COMMON extensions to LFS** (*.zip, *.png,
  *.bin… — repositories-getting-started). **Custom extensions (.doomcanvas/.doomchat/
  .doomtheme) are NOT in the default patterns** → preupload answers "regular" → a >10MB
  payload commit would be REJECTED. This is a LATENT BUG for 10-24MB theme payloads
  TODAY. The cure: seed the repo's .gitattributes with our extensions marked
  `filter=lfs diff=lfs merge=lfs -text`.
- **The engine already follows preupload's answer** (hf.go:364-374) — the .gitattributes
  seed is the only server-side lever needed; no client protocol change.
- **uploadMode semantics** (deepghs mirror + hf.go comments): lfs = "file > threshold OR
  matches suffix rules" — the .gitattributes line makes the suffix rule deterministic.

### 2.3 Verdicts

- R1: Two new Register() calls + a RepoSuffix field fix the naming foot-gun cleanly
  (canvas → doomalay-canvases, chat → doomalay-chats).
- R2: The transport must go BINARY for the big types: multipart publish (FormData meta +
  payload Blob — no base64 inflation in the WebView) and a STREAMING payload GET (engine
  proxies the CDN response with io.Copy — zero engine-side RAM blowup, the 8MB FetchFile
  cap untouched for meta/small payloads). The JSON publish path stays byte-identical for
  every existing type.
- R3: Payload-bypass storage for canvas/chat: SaveLocalItem with payload="" (the meta row
  + downloaded mark is what the endorsement gate and "my items" need); the payload is
  re-streamed on demand via the payload route. The /downloads poison dies for these types.
- R4: .doomchat = a new manifest format ('doomalay-chat') + a read() variant (no
  canvas.json, exactly ONE chats/*.json, children/* NOT whitelisted) + a 2-publisher
  driver (assets→chats, no canvas tail) + the materialize landing. All components reused
  OOP-style (pickSession, BIRTH_KEYS, the history fold, AssetsPublisher staging,
  ChatsPublisher.applyImport verbatim).
- R5: The trust ladder: client-side caps (persona/preamble ≤64KB, honest reject), the
  preamble-unselected law (lands like personas: OFF, "switch it on from its editor" —
  closing the auto-activate counter-precedent), bundle personas forced mode:'inactive'
  at import (publishers.js), provenance chips surfaced (worldsmanager rows via a JSON1
  $.imported.from probe + hubitem detail).
- R6: Auto-written card: the publish prefill carries the manifest summary (icons · chats
  · portals · children · size · requires) as the editable default description; the card
  art pre-fills from the canvas thumbnail (captureThumb → pngBase64).
- R7: The bot-facing hublibPMTypes map (skills.go:935) stays untouched — it is ALREADY
  stale (python/preamble missing, a pre-existing inconsistency); bot-side canvas/chat
  publishing is a future wave's surface (documented, not scope-crept).
- R8: Version law: buildinfo on main = 1.52.8 (the bot's FIRST SPARK) → this wave ships
  as v1.54.x phases + the v1.54.0 ship. NEVER trust a reservation; re-check at push.

## 3. THE REAL PLAN (phases, each = built + rig-proven + pushed)

### Phase v1.54.1 — THE REGISTRY AND THE BIG PIPE (engine, Go)

1. `hub/hub.go`: LibrarySpec gains `RepoSuffix string` (default Type+"s"); RepoName uses
   it. Register `canvas` (Label "Canvases", Tag "doomalay-canvas", PayloadExt
   ".doomcanvas", RepoSuffix "canvases") + `chat` (Tag "doomalay-chat", PayloadExt
   ".doomchat", default suffix). NOT hidden (the browse row must flip).
2. `hub/model.go`: Item gains `Size int64 json:"size,omitempty"` (payload bytes — the
   detail/list size line; additive, old clients ignore).
3. Payload caps, one truth: `hub.PayloadMaxBytes(spec)` → canvas 96MB (the ladder
   ceiling), chat 40MB (history 8 + assets 24 + headroom), theme 24MB (moved from the
   hardcoded server exception), everything else 64KB. server/hub.go's publish gate uses
   it (the theme special-case dies).
4. **Multipart publish**: POST /api/hub/{type}/publish with Content-Type
   multipart/form-data → part `meta` (the JSON, ≤26MB — unchanged field set) + part
   `payload` (raw binary, streamed to a temp file under the per-type cap; os.Remove in a
   defer). JSON bodies keep the exact current path. PublishRequest gains PayloadBytes
   []byte (nil = string path). Publish sets item.Size.
5. **.gitattributes LFS seeding**: ensureRepo (service.go:1334) gains a follow-up for
   big-payload types: fetch .gitattributes; if the type's `*<ext> filter=lfs` line is
   absent, commit the merged file (one extra FetchFile per publish — cheap, small).
   Seeds *.doomcanvas, *.doomchat, *.doomtheme (the latent theme fix rides).
6. **Payload-bypass download**: for big-payload types, Download/downloadCore fetch meta
   only (no resolvePayload), SaveLocalItem with payload="", return {item, payload:""}
   + payloadSize. /api/hub/{type}/downloads returns rows as stored (empty payloads).
7. **The streaming payload route**: GET /api/hub/{type}/payload/{repo}/{id} → 404 unless
   the local row is downloaded (the endorsement gate rides) → StreamFile: HEAD-less
   proxy — GET the CDN resolve URL, verify Content-Length ≤ per-type cap, io.Copy the
   body to the client (application/octet-stream). Zero staging, zero engine RAM blowup,
   the 8MB FetchFile cap untouched for its existing callers.
8. Tests (extend the in-process fake HF in hub_test.go — httptest pattern at :351/:640):
   registry (specs, RepoName law, payload caps), multipart publish (caps enforced, LFS
   mode followed, .gitattributes seeded on first publish, item.Size set), payload-bypass
   download (no payload fetch, empty local payload), the payload route (403/404 gate,
   streaming, cap rejection), the existing JSON path regression-pinned byte-identical.

### Phase v1.54.2 — THE CANVAS DOOR (web)

1. hub.js maps: LIB_ICONS {canvas:'🗺', chat:'💬'}, mineLabel, shortType, the doDownload
   dispatch + applyHubSideEffects twin: canvas → atob-free binary GET /payload →
   arrayBuffer → CanvasBundle.importBundle(bytes) (the landing/switchTo is already
   inside importBundle); renderPayload: canvas/chat → the summary card (description +
   size + upstream — NO markdown dump of a zip).
2. hubpublish.js: prefill.payloadBlob (Uint8Array) + payloadSize → the payload textarea
   hides, a "· .doomcanvas — 1.2 MB (built from the world)" chip shows; the POST rides
   FormData when a blob is present (meta JSON + payload Blob); pngBase64 prefill rides
   unchanged. The 401 → connect-view stack law preserved.
3. worldsmanager.js publish sheet: a "⤒ publish to the library" button beside export →
   build() → HubPublish.open('canvas', {name, payloadBlob, description: the manifest
   summary (editable), pngBase64: the captured thumb}); the sheet stays (the user can
   still export after publishing). Auto-summary text: "N icons · N chats · N portals ·
   N child worlds · size · needs: <providers>".
4. The browse row flips itself (libHasCanvas) — verified, no code. Rig asserts it.

### Phase v1.54.3 — THE CHAT DOOR (web)

1. NEW `chatbundle.js` (dual-env, ~300 LOC): collect(picks, chatCtx{sid,title}) — one
   chat: pickSession + tweaks + history? (the fold reused) + assets refs (the
   AssetsPublisher collect logic scoped to one session); build → .doomchat (manifest
   format 'doomalay-chat' + chats/<sid>.json + assets/*); read(bytes) — the ladder
   (per-entry 8MB, total 40MB, 1024 entries, ratio 100:1, names, whitelist
   manifest/chats/assets ONLY — children/* rejected, format 'doomalay-chat' MAJOR ≤1,
   every chats/*.json parses, EXACTLY ONE chat file); importChat(bytes, opts) — stage
   assets → ChatsPublisher.applyImport (instantiated, synthetic ctx — NO canvas tail)
   → {ok, nsid, created, warnings}; download(); probe().
2. The chat publish sheet (the worldsmanager openPublishSheet pattern, pushed
   ConnectOverlay page): toggle tree (history, per-asset), live size, export .doomchat,
   publish to library. Entry: a "⤒ publish chat" row in the chat panel's export view
   (chatpanel.js openExportView — the sanctioned PANEL surface, the tweaks/export-pill
   neighborhood); no-session → the honest disabled row (the export view's own law).
3. hubitem.js/hub.js chat dispatch: payload route → arrayBuffer → ChatBundle.importChat
   → window.doomalay.openChatBySession(nsid) — the materialize branch lands the icon
   (sessionId + save) and opens the panel. The BYOK requires[] warnings surface in the
   honest report (the worldsmanager import-report pattern).

### Phase v1.54.4 — THE TRUST LADDER (web + engine)

1. hubitem.js importPersona/importPreamble + hub.js twins: payload must be a string,
   trimmed, ≤64KB (honest reject toast — matching the engine's own preamble cap); the
   preamble lands UNSELECTED (preamble_sel untouched; "switch it on from its editor").
2. publishers.js ChatsPublisher.applyImport: every imported persona forced
   mode:'inactive' (the bundle's claim never survives — the R7 law).
3. Provenance chips: store/canvases.go ListCanvases gains
   COALESCE(json_extract(state,'$.imported.from'),'') AS imported_from → CanvasRow.
   Imported string; worldsmanager rowHTML renders a "◇ <name>" chip (theme-law tokens).
4. hubitem detail: the canvas/chat summary card shows the provenance line
   ("imported from <author>'s world" when re-published from an imported world).

### Phase v1.54.0 — THE SHIP

- buildinfo "1.53.0" (renumber past 1.52.8 — re-check origin right before the push),
  README v1.54 section, this plan doc committed, the full battery, rebase, push.

## 4. RIGS (the proof)

- `scripts/v1530-library-rig.mjs` (node): a FAKE-HF in-process server implementing the
  REAL protocol surface hf.go speaks (whoami, datasets?filter=, repos/create, preupload
  → lfs/objects/batch → presigned PUT, commit NDJSON, resolve/main, GET repo) — the
  engine boots with hf_base pointed at it (yaml override, config.go:68). RIG A: canvas
  publish E2E (multipart bytes land in the fake's LFS store byte-identical; .gitattributes
  seeded; index regen; item.Size) → browse (the filter serves the repo) → download
  (payload-bypass) → payload route streams the exact bytes → importBundle → the world
  lands + switchTo + provenance stamped. RIG B: chat publish → .doomchat shape →
  download → importChat → session reborn (personas INACTIVE, auto-tools OFF, preamble
  unselected) → the icon materializes. RIG C: the trust ladder (the 64KB rejects, the
  preamble-unselected law, the bundle-persona inactive law, the provenance chips) +
  the caps matrix (96MB canvas OK / over-cap rejected honestly at BOTH gates) +
  regression pins (theme publish JSON-path byte-shape unchanged, the 8MB FetchFile law
  untouched for small types).
- `scripts/v1530-library-walk.mjs` (agent-browser, the real finger): connect hub (fake
  HF token) → manager → publish sheet → toggles → publish → the canvas appears in the
  library browse (the browse row subtitle FLIPPED) → download → the world lands (the
  switch happens) → the chat door (export view → publish chat → download → the icon
  lands + the panel opens with history) → zero errors + theme pin + B1 + the
  provenance chip on the imported row.

## 5. BUDGETS (the "keep it as is if not better" law)

| Budget | Target | Basis |
|---|---|---|
| Per-frame cost | **0** (nothing touches tick/physics/camera) | all surfaces are open-time DOM |
| Engine RAM (publish) | 1× payload (the temp-file stream + one read) | the current theme path already holds 1× |
| Engine RAM (download) | ~0 (io.Copy proxy) | the payload route streams |
| WebView RAM | the zip bytes only (FormData/Blob — NO base64 string) | R2 |
| SQLite | unchanged (payload-bypass for big types) | R3 |
| Publish body | meta ≤26MB JSON part + payload ≤ per-type cap (96/40MB binary) | R2 |
| Switch/download bursts | importBundle's existing budgets | v1.42.8 |

Red lines inherited: zero hardcoded colors (pin A5), UI only via Panel/Overlay, B1 (no
body appenders), BYOK (keys structurally absent from bundles — the v1428 rig-asserted
law), no per-frame style-var streams.

## 6. WILL NOT (this wave)

- No bot-facing canvas/chat publish (hublibPMTypes untouched — documented R7).
- No WebIcon hub listing (plan's own call — it ships INSIDE canvas bundles only).
- No moderation/report endpoint (out of scope per plan §3.6; documented risk).
- No real writes to the user's HF account from the sandbox — the fake-HF protocol twin
  is the proving ground; a real publish is one tap from the user's device.
- No .doomchat child nesting (children/* rejected — a chat is a leaf).
