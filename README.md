## v1.63 THE SIX FIXES

The user's six-list, all shipped and live-proven. (1) **THE DYNAMIC WALL**: the walled-tier chat message names the phone's OWN missing rungs — "Opencode requires Termux setup and the Opencode install… setup Termux by expanding the chat metadata → Capabilities → Termux, then the cloud provider menu's '+ install opencode' pill (one-time ~72.5MB)" when nothing is installed, "Termux is set up ✓ — one step left…" once it is, with the MODEL and the LIVE download size carried, plus the honest installing/live-bridge variants (llm.OcPocketProbe, injected by the server). (2) **THE CLOUD GATE**: the model catalogue's header grows a cloud glyph left of the ★ tab (the tab's own size) — press → the cloud provider screen opens as a REAL pushed stack level, and the Android back gesture pops back to the MODEL CATALOGUE, never the canvas. (3) **THE HONEST PILL**: the opencode row's gate pill never disappears and names EVERY missing rung — "opencode requires API key + termux setup + opencode install (one-time ~SIZE)" (the missing pieces only; the termux truth survives the key gate — THE ALWAYS-TRUTH LADDER). (4) **THE SETUP COPY**: the termux ladder's step ② pill reads "Open Termux ↗ then hold and Paste" (the whole gesture), the auto-copy explanation hint is gone, the paste phrase under "Bootstrap once" rides the theme accent, and step ③ names the real screens (Additional Permissions → Run commands in Termux environment; Manage app optional). (5) **THE LIVING TERMUX PILL**: the "+ setup termux" pill flips to "✓ termux setup" the moment termux is ready — THREE convictions fixed: the µs-fast bridge status landed before the panel opened and swallowed the poll arm forever (the frozen pills), the poll's render() could swap a pushed page (TermuxSetup mid-flow) away, and popping back restored the open-time html SNAPSHOT (the stale pre-setup pills) — the arm retries until open (counter OUTSIDE the callback: its first arg is the fetch RESULT — the live conviction), #prov-root marks our page, and popPage's new onPop hook re-renders FRESH. (6) **THE BIG CELLS**: GRID_BASE 48 → 480 — each cell ×10; the 16,384 world spans ~34.1 cells per axis (1,165 total — a countable number of cells, ~8 grid periods), and the lattice renders through **THE LIVE SPATIAL PATH** (renderCells — the battle-tested walk promoted): per-visible-cell LAZY records (a cache miss IS a cell load — "spatial loading can load one or few cells at a time"), batched quantized fills at device resolution — SHARP BY CONSTRUCTION (the periodic-tile budget collapses the bake raster to 0.28–0.4 at ×10 cells; the live walk paints at DPR), the A/B parity breath at flush, the true far-field ramp, the modulation field at the same pixel period (32 big cells = the old 320×48 law), and THE PITCH LAW for the movers (the twinkler density is the screen's 48px field, not the cell count — the ×10 cells thinned them ×10 live). The floor re-pin: the sea never fades at any reachable zoom (the floor spacing is 11.4px) — THE COUNTABLE GRID IS THE MAP VIEW. The tile machinery ships untouched behind the `__doomalayLatticeTiled` hatch (rides the worker through the frame message); the "like 8 grids give or take" law SURVIVES (16384/(12·480) = 8.09). **Proof**: the v1630 rig 41/41 (the six laws live: the pushed back-stack dance, the armed poll with the fetch-count, the stack guard under a stacked setup page, the onPop fresh render) + v1620 55/55 + the real-finger walk 9/9 (the neutral VLM: "geometrically regular and aligned, no rendering defects, 8/10 clean, precise") + v1570 46/46 + v1173 113/113 + the full battery (v1422 26/26, v1310 58/58, v1424 46/46, v1350 62/62, v1400 51+58, v1428 48/48, v1590-live 18/18 on the real 2.1.2 + real key, v1204 38/38, v1363 22/22, v1175 155/155, go ALL + vet + the linux/android-arm64 cross-compiles). The pre-existing failures are byte-identical to origin/main, recorded and untouched.

## v1.62 THE HONEST FIELD
Zooming out is finally honest, the stride scales with the zoom, and the starfield's wallpaper read is dead. THE CONTINUOUS CLAMP: the camera's edge law is now the canonical contain form every reference library uses — the viewport spans exactly the world (the finger reaches the exact edge, no lopsided half-viewport margin) and the transition into the fit-all overview is provably continuous (the old law snapped half a screen in ONE frame at the crossing — the "grid goes diagonally then snaps back" lurch, twice per deep zoom-out on a phone; now the whole zoom-out sweep moves ≤2px of screen per step). The pinch anchors at the LIVE two-finger centroid (a drifting pinch pans 1:1 instead of the content slipping under the fingers). THE PROPORTIONAL STRIDE: the pan's world delta is the screen delta ÷ scale — the content tracks the finger 1:1 at ANY zoom, so the more you're zoomed out the further the same stride carries the grid (a 100px drag = 100 world units at 1.0×, 2,000 at 0.05× — was a flat 100 everywhere; crossing the whole world at the overview takes one stride, not ten seconds of dragging), with the momentum cap riding the same on-screen speed feel at every zoom. THE EIGHT TILES: the star sea's joint period widens lcm(10,16)=80 → lcm(10,24)=120 cells (5,760px — the whole 16,384 world at the map view now consists of ~8 tile periods instead of ~18, each 2.25× the area), and every period-instance is painted with its own rigid transform — rotation (i+2j) mod 4 (the Latin-square law: all 8 neighbors of any tile carry a different rotation) plus a checkerboard mirror — world-anchored and deterministic (~4 bit-ops, zero compute): the effective joint period lands at 480 cells = 23,040px, BEYOND the whole world — no two visible tiles repeat (VLM-verified: "varied/natural, no two regions exact copies"). THE SEEN ONLY audit: off-view icons display:none, the pan writes zero at-rest icon styles (the container owns the camera), the movers paint on-camera, the lattice rides the worker — the main thread is reserved for the app + the backend. Pinned live: the 52-check rig + the 9-check real-finger CDP walk (a real pinch with a built-in centroid drift: no snap, lands at the floor, the sea gone) + the full battery (v1570 re-anchored to the canonical bound; v1590 re-anchored after the parallel wave's rename).
## v1.61 THE PATIENT HAND

The two user reports, both killed: (1) the worst models' tool hiccups — they fumble an argument shape, the call fails, and instead of retrying they SIMPLIFY ("a simpler approach", 4x in kenny's own thinking) — every fumble now executes mechanically repaired, and the residual verdicts FORBID the downgrade; (2) the parked turns — a 429/network/5xx ended the turn and the chat sat dead until a human tapped Continue — the RETRY SENTINEL now arms a shared dynamic timer that probes the signal and the conversation CONTINUES ITSELF when it clears.

- **v1.61.1 THE REPAIR HAND** — the Unfumble Law: a call that can be mechanically repaired IS repaired, the model never learns it failed. The byte-exact kenny convictions (from the live chat export): the legacy tag grammar inside tool args (`\u003c/arg_key\u003e\u003carg_value\u003e` — 4x), raw newlines + early-close quotes in nested args (2 parse deaths), recursive args envelopes, the action field glued to its payload — TagsToJSON/SplitTaggedAction/RepairJSONQuotes (with THE QUOTE DEBT: the model's closing quote was both the JSON close and the command's content) repair all of them; THE ARG-INFERENCE ENGINE (ws-from-path, the read-continue last-read map, grep query aliases); the landmines (patch/commit/sync/tag_create nil-deref panics, the wsArgInt >=500-inverts-to-UNLIMITED bug); THE SCHEMA TRUTH (all 30 workspace verbs + 16 missing props + termux patch taught); every verdict carries "Retry the SAME call — do not simplify, downgrade, or switch strategy."
- **v1.61.2 THE PATIENT WIRE** — tool-side transients retry before the model ever reads them (kenny's 3 forge errors + trippy's DNS fetch reached the model verbatim): netx.IsTransient (one truth — the turn ladder and the tool wire classify with one regex; the rig convicted bare `: EOF` missing) + netx.RetryDo (the forge 3x 1s/3s, WebFetch 2x, ghLoginFor off the raw DefaultClient; validation 4xx never re-hammers; the honest "(retried Nx)").
- **v1.61.3 THE RETRY SENTINEL** — the Sentinel Law (the user's order, superseding the old no-auto-continue law for RETRYABLE classes only): a turn parked on net/429/5xx arms a shared dynamic timer keyed class|provider; every chat parked on the same cause JOINS it; cheap probes (the provider's /models with the provider's own Retry-After clamping the first probe, the WakeNet broadcast short-circuiting the device classes, the opencode bridge health for the free-limit); the recovery FANS OUT — every listener auto-continues through the same continueCore the manual tap rides (staggered 1.5s; a busy chat re-listens honestly); the manual send/tap/delete always disarm (the user is always faster); the kv durability rows survive engine restarts with the attempt counts (the boot scan re-arms parked chats); non-retryable classes (auth/quota/modelgone) NEVER auto-resume.
- **v1.61.4 THE RETRY PILL** — the PWA face: ONE live pill per parked turn (theme-law only: var(--warn) live / var(--ok) recovered — zero literals), the countdown ticking to the next probe, "probe 3 failed — next probe in 4:32", the recovered closing on the user's own grammar ("continued after 5 retries — 23:14 elapsed"); the ✦ Auto-retry section (all chats): the enabled toggle + the per-signal intervals (network/rate-limit/server, 1-15 min, default 5); the exports show every probe forever (md `> ↻`, txt `[retry]`, html).
- **THE PROOF** — 8 llm + 13 server + netx + export pins, the full battery, and the v1610 rig 17/17 LIVE on the real binary: a 429 parks a real turn, the sentinel arms, the probe pills pace on the WS exactly as the PWA sees them, the fake provider recovers, the conversation CONTINUES ITSELF (no tap) and the reply lands with the honest attempts+elapsed; a second chat parks on the SAME signal and both recover on the ONE timer; kenny's byte-exact tagged termux call EXECUTES through the real /mcp route + the real bridge with the teach head. The rig's own live convictions fixed in-flight: the emit wire was missing the retry case (frames carried nothing), ProviderProbeTarget ignored DOOMALAY_BASE_URL_* (probes hit the real API — an instant false recovery), the connection-abort class missing from the transient set.

## v1.60 THE MIRROR TONGUE
OpenCode chats are now 1:1 with native ones — and the model picks from BOTH tool shelves. Tool pills speak the engine's own grammar: the bare tool name (never "opencode:grep") plus a derived operand (grep shows its pattern, read shows the file, websearch shows the query — never a static "running"), rendered through the existing pill component with zero new code. Tool results are never silently amputated: the 6000-char clamp is dead, results ride the window-physics budget, and the serve's own truncation verdict surfaces honestly. Mid-tool progress streams live into the pill (Code Mode's nested call statuses, shell sessions), and result/stream pairing is id-first — parallel same-name calls can never cross-wire. THE OPEN HANDS: the permission config becomes the V2 rules array — question is denied (the headless honesty), everything else rides the agent's own allow-all base policy (the v157 probes proved open hands pass the free gate), the doomalay_* MCP tools are explicitly allowed, .env secrets reads are denied, and websearch rides the tavily selection through the serve's own account (the device's "cancelled" disease dies). THE WIDE SHELF: the app's own 31 tools (calculator, documents, archives, journal, fleet, hublib, workspace, termux…) ride the opencode serve as a per-chat MCP server — each serve session is moved into its own config directory whose opencode.json points at the engine's new /mcp/oc/<chat-id> route (direct bare-named tools, so the pills read natively), and the {tools} placeholder — the persona system's own block machinery — carries the merged catalog live-built from the tool registry (bound: both shelves; unbound: the honest native-only note; native chats: unchanged). The bridge pill now moves with the turn's truth ("Connecting to OpenCode…" → "<model> is thinking…"), a pocket-bridge chat self-heals its Termux flag, and the provider screen's opencode pills render from the first paint in every state — never fetch-gated, with a state-aware always-on poll (2s installing / 5s at rest) that keeps the last truth through hiccups. The permission/pill/binding laws are pinned by 15 Go tests + the v1580 live rig: 16 machinery pins pass against the real 2.1.2 serve (the open-hands config bytes, the per-chat binding, the serve's MCP attach dance through the per-chat route, the live progress lines captured on the websocket exactly as the PWA sees them); the model-dependent pins rotate the live catalog with the honest-refusal law (the account's free-quota windows, burned by the day's probing, hold them as honest skips — rerun the rig when a window rolls).

## v1.59 THE HONEST RETURN
Conversations now load from the bottom, opencode keeps its memory across engine restarts, instantly-failing turns can never spin forever, and deleting a chat truly deletes it. Reopening a panel after the app reloaded (the Android WebView reality) bulk-loads the log in one fetch, folds it silently, and mounts the tail at the bottom — the WS then connects cursor-armed so the engine ships only the gap + the live tail (a 240-event log lands in ~1.5s instead of minutes of top-down replay). The opencode serve binding persists: after an engine restart the next turn ADOPTS the serve's own durable session — no fresh session, no compressed recap, the model keeps its full context and thinking. The volatile-stream no-hang guard lands honest terminals for instant failures (a free-limit 429 now answers in ~2s, never an eternal spinner). And the ghost is dead: a deleted chat's state, stash, client, and localStorage rows all die with it, new chat ids are monotonic, and the export view verifies the session before offering dead URLs.

## v1.58 THE BOUNDED FIELD
The canvas is now a limited, manageable size you can SEE — and the render is 2×. The default world drops 64k→16k (the whole world fits the viewport at max zoom-out on any phone — the adaptive fit-all floor), one-time migration from the old default, 8k joins the dial, ∞ stays. The starfield gracefully fades below readable spacing into a clean map view (and that frame is cheaper than any before it). The icon layer's camera is now ONE container transform (React Flow's pattern) — camera motion costs one style write instead of one per visible icon, mathematically identical visuals (rig-proven ≤0.1px). And input frames step physics + paint exactly once per frame (the ambient double-step/double-paint is dead). Proven live: the 46-check rig + the 16-check real-finger walk + the full regression battery.

## v1.55 THE LIVING PILL (PLAN-V155) — the user's five opencode-patch convictions, all fixed + live-proven: the honest ladder, the row of pills, the living catalog, the live effort

- v1.55.1 THE HONEST LADDER — THE NO-LONG-HOLD LAW: ocServeMu guards only the manager pointer (the 20-minute Android install can never block /api/opencode/bridge, /api/models or /api/keys — the audit convicted the old all-hold that starved the WebView pool and rendered "No providers"); the live InstallProgress (stage + bytes/total via the dl.bytes sidecar — the pill pings REAL byte counts, never static); the resumable download; the AbortController single-flight poll.
- v1.55.2 THE ROW OF PILLS — the opencode card renders byte-identical to every other provider (the state box GONE); providerPills is the GENERIC left→right mechanism beside the Get API key link; THE PILL LADDER: '+ install opencode' → 'installing opencode N%' (accent-2 + the pulse breath, pinging the download) → 'failed, retry' (err tone + the honest last_error, the retry resumes from the byte checkpoint) → dim '✓ opencode setup'; '+ setup termux' → dim '✓ termux setup'; the order law (privatemodeai → nvidia → opencode); the org-less service-accounts deep link.
- v1.55.3 THE LIVING CATALOG — "no static lists, not even fallback": models.dev fetched LIVE (OpenCode's own org's registry; ETag/304 + disk cache) replaces the build-time snapshot; the zen list keyed-first with the keyless belt; the deprecated drop via the registry's own status; free/paid from the live cost fields; the healthy serve bridge's own /api/model merges in as the device-local truth; THE NEGATIVE-CACHE LAW (an errored group never caches fresh — a poisoned-empty group can never sit for the 10-minute TTL; the PWA's poisoned-cache law matches); hf joins the engine catalog; the brain proxy dies (desktop and Android byte-identical).
- v1.55.4 THE LIVE EFFORT — models.dev's reasoning_options is the per-model effort source (the exact documented ladders/toggles/budget dials; mandatory derived from the data); the effort knob reaches the 2.x serve through the model's OWN variant ladder (the '#variant' grammar on SelectModel, fetched live from the serve's /api/model); the free dispatch + probe picks + prices + context windows all read the live registry (unknown = honestly unpriced; the 65536 floor).
- v1.55.5 THE LIVE PROOF — scripts/v1550-living-pill-rig.py live with the user's real keys: DESKTOP 23/23 (zen 46 models keyed, big-pickle free + 200k ctx, gpt-5.5's ladder verbatim, every group live — openrouter 439 · nvidia 75 · mistral 44 · privatemodeai 9 · hf 138; the negative-cache law) + ANDROID-CHAIN 27/27 (the starvation test: the screen answers <2.5s through a throttled install while the pill pings the monotonic bytes; the checkpoint test: killed mid-flight → the partial SURVIVES → the retry resumes BYTE-EXACT (Range: bytes=19136512-) → UP → a real turn, cost 0). THE RIG CONVICTED TWO REAL BUGS, both fixed: curl's own --retry restarts a mid-body drop from BYTE ZERO (the shell retry ladder now makes every attempt a FRESH curl -C - — the resume holds at every level) + the install route now answers the REAL failure (not "no data dir or key" for a dead download).
- THE MANUAL ANSWER: nothing — the phone keeps its same one tap. Device mode: the tunnel was down at ship (honest skip) — the rig's --device mode re-runs the phone red-team at the next tunnel-up. Battery: go 17/17 + vet · v1552 28/28 · v1554 21/21 · the rig 23/23 + 27/27 live.

## v1.54 THE LIBRARY SHIP (PLAN-V142's final phase + PLAN-V154) — hub types canvas + chat: whole worlds and single conversations, shareable

- The user's ask verbatim: "Now, let's finish what we originally deferred. It was called the library ship." — the finale the SURGEON unblocked ("Not until we can have percise edits for artifacts and external and internal repos"). The plan's own words (PLAN-V142 §3.6): hub types chat + canvas — "download an entire setup" — and "chats are a whole lib section themselves".
- v1.54.1 THE REGISTRY AND THE BIG PIPE — canvas (.doomcanvas, doomalay-canvases — the RepoSuffix field kills the double-s foot-gun) + chat (.doomchat, doomalay-chats) registered; the per-type payload caps in the registry ONE truth (persona 64KB · theme 24MB · canvas 96MB · chat 40MB); THE MULTIPART PUBLISH (meta JSON + raw bytes — no base64 inflation in the WebView; the JSON path byte-identical for every existing type); THE LFS SEED (custom extensions are NOT in HF's default .gitattributes — a >10MB payload dies at the non-LFS wall without the seeded *.doomcanvas/*.doomchat/*.doomtheme filter=lfs lines; the latent >10MB theme bug fixed too); THE PAYLOAD-BYPASS LAW (big-type payloads never enter SQLite or a JSON body — meta rows only; the "my items" poison dies); THE STREAMING PAYLOAD ROUTE (GET /api/hub/{type}/payload/{repo}/{id} — gated on the downloaded row, repo-matched, Content-Length-verified io.Copy proxy; the 8MB read ceiling never applies).
- v1.54.2 THE CANVAS DOOR — the worlds manager's publish sheet gains ⤒ publish to the library (the auto-written summary description + the canvas-thumbnail card art); the publish rides the multipart pipe; the manager's browse row FLIPPED exactly as the v1.42.7 forward-wiring planned; a download streams the payload into CanvasBundle.importBundle — the world lands (switchTo + provenance + the ◇ chip on the manager rows). THE OVERLAY HOST: a publish form opened from the manager rides the sanctioned overlay (the two-surface law) — the chat-panel path stays byte-identical.
- v1.54.3 THE CHAT DOOR — chatbundle.js: the .doomchat container (manifest 'doomalay-chat' + chats/<sid>.json + assets/*; EXACTLY ONE conversation, children rejected — a chat is a leaf; the full read ladder incl. the lying-central-directory rung). THE OOP LAW: AssetsPublisher + ChatsPublisher run VERBATIM against a synthetic one-chat worldState — zero twin drift. The export view's 💬 Publish .doomchat row → the sheet (history/assets toggles + live size) → the library; a download rebirths the session and MATERIALIZES the icon on the current canvas (openChatBySession's branch), panel open, history aboard.
- v1.54.4 THE TRUST LADDER — persona/preamble imports: the 64KB cap + type gate, honest refuses, both download twins; THE UNSELECTED LAW (a downloaded preamble lands ADDED, never active — R7's no-auto-activation); bundle personas are FORCED inactive at the border (the bundle's 'always' claim never survives); THE HONEST HISTORY (a mid-replay failure is a warning, never a rollback — the birth is the commitment, history is cargo; the rig convicted the old throw-before-journal session leak); the provenance chip ($.imported.from surfaced through the canvases list probe).
- THE PROOF — scripts/v1540-library-rig.mjs 41/41 (the format law · the ladder · the import E2E · the trust ladder · the rollback + honest-history · BYOK) + scripts/v1540-library-walk.mjs 55/55: the REAL FINGER against a PROTOCOL-HONEST fake HF (scripts/fakehf.mjs — the exact hf.go surface incl. the preupload→.gitattributes→LFS causality): publish → browse → download → land for BOTH types end-to-end, the LFS + NDJSON truth asserted on the fake's own state, the trust ladder LIVE (persona always→inactive · preamble unselected · auto-tools off · history rode), zero page errors, theme pin, B1.
- Battery on the ship tree: go 17/17 packages + vet · v1428 48+30 · v1427 57+33 (the browse pins updated — the flip was the plan's own words) · v1426 34+16 · v1425 45+28 · v1424 46+20 · v1421 24/24 · v1400-stream 51/51 (a stale v1.50-rename pin fixed) · v1350 ALL GREEN · v1310 58/58 · the v1390 source-pin PASS (baseline re-anchored) · discipline 7+B1 (the pre-existing trio, byte-identical).
- WILL NOT (documented, per plan): no bot-facing canvas/chat publish yet (the hublib map is a future wave); the WebIcon ships inside canvas bundles with no own listing; no moderation endpoint (documented risk); no real HF writes from the sandbox — a real publish is one tap from the user's device.

## v1.52 THE SURGEON (PLAN-V152) — the chat-honesty fixes + surgical editing + the autonomous push

- The user's ask verbatim: "I've attached the trippy logs, u can read the ends to see if any new insight on issues with our chat. We want to fix as much issues with our current chat implementation before we build more. Defer the library ship once more. Not until we can have percise edits for artifacts and external and internal repos. We need an unbelibably solid tool for this." + "We need the bot to be able to seamless push from its local repo to the cloud repo using our strict push philosophy on its own."
- THE DIAGNOSIS (the (2).md log, read in full — the bot's own final-turn self-diagnosis included): SIX issue classes convicted — (1) engine restarts kill turns mid-flight ("interrupted by engine restart" ×2, 5,600 events of work, zero durable output — "I asked for very simple requests and nothing was done"); (2) the same user message persisted 5× (every failed send re-persisted); (3) DNS death was TERMINAL (isTransientNetErr had no DNS class — the pause ladder never ran); (4) the 600s termux exec black hole; (5) the 69,775-byte workspace tree flood ×3 (~210KB of context); (6) THE MASKED FAILURE (convicted LIVE by the v1520 rig: a 403 emitted its error chunk then returned nil/nil/nil — the callers read SILENCE, the failed turn fell through to the "(the model returned an empty response…)" note + terminal IDLE: a provider failure masked as success, the no-dup law disarmed, continue never arming).
- v1.52.1 THE DNS RUNG — the DNS class (no such host | no address | lookup | dns | SERVFAIL) joins isTransientNetErr: a DNS outage rides the pause ladder (fresh-dial retries, the bounded hold, the suspended mode) instead of an instant terminal; friendlyError gains the DNS/offline class ("Network trouble… tap Continue when you're back online") — and the net-hold's exit lost its last "Tap Retry" string (the continue-only law).
- v1.52.2 THE NO-DUP SEND — a re-send of the FAILED last turn's own text is a CONTINUE in disguise: sendIsFailedRepeat (the last user row == the text AND the last terminal is error — an 8,000-row tail window so a 5,600-event flood still finds its row) dispatches the resume and persists NOTHING; the busy-reject's same-text shape persists no second row either. The 5-tap storm = ONE user row.
- v1.52.3 THE HEALED SEAM — the boot heal ANSWERS a restart-killed turn's dangling tool_use with the honest never-ran truth ("interrupted by engine restart — this call never ran; re-issue it if still needed") BEFORE the healed terminal (now carrying "hint":"continue") — the history fold DROPPED unanswered uses entirely (the model lost the knowledge it made the call; provider wires that validate the tool_use→tool_result chain got invalid shapes). The composer arms CONTINUE on the healed seam (the _interrupted stamp — live AND replayed; tool pills never own the tail verdict).
- v1.52.4 THE HONEST TREE — past 200 entries the tree verb's DEFAULT view is the DIR SUMMARY (every top-level dir with file counts + sizes, direct files, honest totals, the two narrowing verbs); {"recursive":true} returns the full listing VERBATIM — a smarter VIEW, never a truncation (the v1.19.1 whole-truth law holds). The ls-at-root no-op filter is FIXED (ls at / = direct children — the old code leaked the full recursive dump).
- v1.52.5 THE BLADE — engine/internal/surgeon: the ONE edit engine (EXACT match → INDENT-FLEX recovery with re-indentation of the replacement to the file's own indentation → the NEAREST-CONTEXT miss diagnostic naming the closest line; all/occurrence resolution that never guesses; DiffPreview unified-style, hand-rolled LCS, zero dependencies). Surfaces: the workspace `patch` verb (read a range → edits[] → dry_run preview or the sha-guarded API commit) + the termux `patch` verb (the SAME engine on local jailed files) — the OOP law: one truth, no twin drift. The research verdict honored: search/replace blocks applied in-memory + whole-file write IS the industry pattern (Claude Code Edit / the MCP filesystem server's edit_file v2 / Aider); unified-diff application is the brittle minority.
- v1.52.6 THE ONE COMMIT — forge CommitFiles (the GitHub git data API: branch head → base_tree → POST /git/trees with inline content + sha:null deletes → POST /git/commits → PATCH /git/refs/heads/{branch} force:false — THE STRICT-PUSH GUARD; a 422 answers "the branch moved under you — re-read and re-apply", NEVER forced) + the workspace `commit` verb (multi-file: edits | content | delete | rename_from, ONE atomic commit, the per-file report).
- v1.52.7 THE SYNC EYE — forge CompareRefs (base...head with each side's changed files since the merge-base) + the workspace `sync` verb: ahead/behind, the files base moved (with the ⚠ ALSO-CHANGED-ON-YOUR-BRANCH overlap marks), and the verdict — disjoint changes → pr_merge method:rebase lands cleanly; overlap → re-branch from base and re-apply the surgical edits. The rebase awareness the strict-push protocol demands BEFORE every push.
- THE HONEST TERMINAL (the rig's live conviction, fixed in-phase) — a provider HTTP failure (403/401/…) now ends the turn TERMINAL ERROR: the errHTTPAlreadyEmitted sentinel marks failures whose friendly chunk already rode (emitTurnError owes only the terminal — no double bubble; the plain-path drain is sentinel-aware through llm.IsAlreadyEmitted). The masked empty-response-idle shape is dead.
- THE LLM ARG COERCION (the rig's second live conviction) — dry_run:"true" (a STRING — the classic LLM shape) skipped the preview and committed directly; wsArgBool/editArgBool/termuxArgsBool now coerce the honest string forms ("true"/"1"/"yes"), and occurrence accepts strings too.
- THE PROOF (scripts/v1520-surgeon-rig.py — real engines + the real browser page + REAL model turns through the app's own composer): RIG A 15/15 (A1 the no-dup law LIVE: 5 same-text sends → EXACTLY ONE user row, 5 honest errors, the composer arms CONTINUE; A2 the healed seam: the REST-seeded dangling tool_use → engine REBOOT → the synthesized never-ran answer + the continue hint + the composer arms continue; A3 the DNS face: the log's verbatim netx error renders friendly, the raw string gone, the affordance is Continue) · RIG B 10/10 (the blade LIVE on Nvidia glm-5.3-flash through the app: the scratch repo bound, 8 tool calls, dry-run FIRST, the PATCHED commit, the GitHub truth = the glow flag flipped surgically, renderPill/enableGlow untouched, the old line replaced not appended) · RIG C THE GLOW PUSH (the finale, run post-ship: the bot pushes its glow feature as a sub-wave x.x.# COMPLETELY ON ITS OWN through the new tools). Go battery 17/17 packages green (the new surgeon package aboard).

## v1.50 THE UNLOST MIND (PLAN-V150) — the trippy chatlog fixes: the whole return, the one truth, the honest mask, the single voice, the continue button

- The user's report verbatim: "despite the push to stop truncated returns on tool pills we still have some tools pills that slipped under the cracks and return truncated returns. All tool pills must return the entirety of the output. This is a weird bug as the UI that renders the tool pills output for the user seems to be fine and return the full output even if it's a extremely large file. If they don't use the same methods then how is that working with our OOP standards for loose coupling and best coding practices" + "the chat repeating itself. It should always be caught up, matter of fact, rework the (retry) botton that we have (the one alogslide send, queue, and stop) and turn it to a continue botton. No more retry whatsoever existing in the app. Only continue, continue exactly where it left off. Or as close to exactly as possible."
- THE OOP ANSWER — the pill UI and the model never shared a path: the pill rendered the persisted tool_result event (full since v1.19.1) while the model path re-clamped through THREE independent sites (the v0.38 24,000-byte in-turn clamp, the v1.30.4 6,000-byte cross-turn clamp + the 12-pair stub law, and the tool-level caps the push never swept). ONE source of truth restored: the persisted event feeds both; the fold renders SHAPE (no policy); budget policy lives in exactly ONE place (the auto-compactor + the context-aware in-turn guard).
- v1.50.1 THE WHOLE RETURN — every tool-level cap dies: skills read 8000 / load 40000 / search top-8 / the hublib 6000-12-3000-40000 family + 14 clip sites · delegate 2000 · fleet roster 30 + detail 90-char snips (the known JSON shapes render field-by-field, full text) · archive_extract 60-file cap + 4000-byte inline gate (the DESIGNED 400KB ceiling remains) · archive_create + xlsx_create silent drops become NAMED drops · web_search snippet/title collection clamps.
- v1.50.2 THE ONE TRUTH — the fixed 24,000-byte in-turn clamp becomes CONTEXT-AWARE (turnObsBudget: 90% of the model's documented window minus the in-turn history, floor 24,000, honest ClampMarked totals when physics says no); the 6,000-byte cross-turn clamp + the 12-pair stub law are DEAD (every tool pair rides history WHOLE — Redact stays: the pasted-PAT law is security, not truncation). Budget = the auto-compactor (70% trigger, counts tool_result bytes) + the count window + the 92% guard.
- v1.50.3 THE HONEST MASK — buildHistoryCompacted builds the hidden set from the log's hide rows (the old foldSlots(liveEvents, nil) sent a nil map: every retry/edit/regenerate hide was ignored by the PRODUCTION history builder — the model kept seeing the dead turn + the re-sent user message = the chat repeating itself).
- v1.50.4 THE SINGLE VOICE — deltas ACCUMULATE into one slot, the full assistant event SEALS (replaces the accumulated prefix); the old first-delta-sealed-itself made every later delta its OWN model-history message plus the full event as another copy — a streamed reply rode context N+1 times (in-context self-repetition + window flooding).
- v1.50.5 THE CONTINUE — the retry era is over: the WS 'continue' frame + handleContinueTurn (NO user event ever re-persisted; trailing error rows masked engine-side; the SeamNudgeText nudge for the cut shape; the plain answer for the died-before-content shape) + the frontend 4th-mode swap (arms on a trailing error OR a cut tail — finish_reason length / output_cut consumed from the terminal usage; every "tap Retry" string dies; the model-switch chip rides the same frame).
- THE PROOF (scripts/v1500-unlost-mind-rig.py — real engines + the real browser page + REAL model turns through the app's own composer): RIG A the loop conviction 9/9 (turn 1 reads the 55,336-byte skills.go in ONE call; turn 2 recalls 10 function names + BOTH deep-tail doc comments VERBATIM with ZERO tool calls; the pre-fix flip: 14-tool-call storm + the tail comments GONE — the trippy loop convicted live) · RIG B the original prompt 5/5 (Nvidia GLM works the real repo task: the 145,832-byte workspace.js read WHOLE, 52 tool rounds, no loop, exactly-once prompt) · RIG C the continue button 10/10 (stop mid-stream → menu continue → NO new user event, new content, zero errors). Go battery 16 packages green on the merged tree (the pocket-bridge + seen-signal waves aboard).

# Doomalay

A sovereign self-hosted AI workspace with maximal capability.

## Architecture

```
Go Engine (universal runtime) + Python Brain (Strands agent, full tools)
+ PWA (spatial canvas, physics-driven chat icons)
```

**PrivateMode is engine-native** (v1.44 PLAN-V144, v1.45 PLAN-V145, v1.46
PLAN-V146): PM chat turns ride the engine's own E2E-encrypted wire —
`engine/internal/pm` vendors the MIT-licensed half of Edgeless's pure-Go
client (PROVENANCE.md records every delta), the engine pins the deployment's
mesh CA (TOFU; PM chats work on the pin with ZERO wasm), and the engine's
PM client dials through `netx` like every engine outbound (v1.45.1 — the
Android DNS fix; the vendored Go-default dialer was the one that died on
real devices). The ONLY thing licensed to run Edgeless's BSL-1.1 attestation
verifier is their own MIT-distributed wasm artifact (`web/vendor/pm/`), and
it runs STRICTLY on demand (v1.45.4 — the provider card's explicit "verify
attestation" button; nothing loads wasm automatically, at connect or
anywhere else). Net honesty (v1.45.2): a single provider being unreachable
while others work is reported as THAT provider being down ("your
connection is fine") with a bounded hold, never a fake "network
unreachable" — the infinite patient-engine wait stays reserved for true
device-offline shapes. The co-located brain rides
`POST /api/pm/local/v1/chat/completions` (api-key-fallback=never).
Reasoning honesty (v1.46): PM's gateway (vLLM 0.31) emits every reasoning
delta in BOTH wire spellings (`reasoning` + `reasoning_content`,
byte-equal — the rename compat shim); the engine's alias law
(`mergeWireReasoning`) merges the pair into ONE copy so PM-native thinking
streams clean (the "every word appears twice" bug), and the provider's own
`reasoning_tokens` share of the completion rides the usage ledger end-to-end
(the 🧠 stat on the usage panel).

**The seen signal** (v1.48 PLAN-V148 — every phase live-convicted with a
pre-fix flip): **the single echo** — every user message reached the model
TWICE on every provider since the brain-history build (the turn persisted
the user event before history assembled, then appended it again; the brain
appended it a third time on its path) — `trimInFlightUser` now drops the
log's own trailing copy (byte-equal match only; no history byte is ever
dropped) at both construction sites, and a stub-provider probe counts the
real wire payload (`:2` pre-fix, `:1` post). **The live stars** —
connecting a workspace never refreshed the orbiting stars until the icon
was physically moved: the worker clone cache only re-sent entities when
the position-based checksum changed, so a session bound at rest left a
`sessionId:''` clone and the painter skipped the icon; the sig now folds a
memoized per-entity session hash and the count-change signal forces one
clone-bearing frame. **The direct plus** — the ＋ badge on a workspace row
adds it to the chat in ONE press (its own click, `stopPropagation`, the
same bind chain the expanded pill runs). **The informative pill** — the
workspace tool's collapsed pill speaks its verb + operand
(`grep | readme`, `view | issues`, `pr_diff | #12`) instead of the static
`workspace | repo` fallback: the full verb table off the tool's own param
grammar. **The serve bridge** — OpenCode's FREE models at last, the honest
way: the hosted API's free tier is walled below-HTTP to OpenCode's own
clients (byte-faithful CLI-identity replays still 403), so the engine
manages the GENUINE client itself (`engine/internal/ocserve`: the pinned
1.19.3 CLI, the gate-law permission config — execution + writes denied —
one serve session per chat, THE RECYCLE LAW on the free-tier wall,
persona/context riding the message text, reasoning deltas → thinking
events, serve's own tokens + reasoning share on the usage ledger). On the
desktop engine `big-pickle` and friends stream live through the engine's
own WS protocol; where the bridge cannot run (Android — the CLI is
glibc-linked), the honest copy names the wall, the desktop truth, and the
alternatives.

**The pocket bridge** (v1.49 PLAN-V149; v1.51 PLAN-V151 THE SECOND
TONGUE) — OpenCode's free models on ANDROID, the honest way with the
fewest gates Android allows. The official CLI has no Android build (glibc
+ non-PIE; upstream closed it as not-planned), but guysoft's
opencode-termux line cross-compiles OpenCode NATIVELY for Android/Termux
aarch64 — the engine provisions that client itself: with Termux installed
and the one-line bootstrap run (both existing doomalay flows), ONE TAP on
the OpenCode card's "Install OpenCode" drives the whole thing through the
app's jailed-exec path — download (the pinned 72.5MB opencode2 v1.0.3-rc3
= OpenCode 2.0.0-android, SHA256-verified) → unzip (+ the retired 1.x
files leave best-effort) → the 2.x gate-law permission config → a
wake-locked `opencode2 serve` on the shared loopback. The WHOLE bridge now
speaks the OpenCode 2.x serve API (PLAN-V151): the desktop pin is the npm
@opencode/cli 2.1.2 tarball (sha512-verified against the registry's own
integrity — OpenCode 2 ships as npm; GitHub releases stay 1.x), the serve
is HTTP-basic-auth (the password derives stably from the key so a pocket
serve that outlives the engine stays adoptable), the turn flow is session
create → model select → text-only prompt → the v2 SSE vocabulary, and the
usage ledger carries serve's own tokens + cache + cost (0) end-to-end. Free-model turns
run through the engine's own WS protocol with serve's own usage on the
ledger; an engine restart adopts the live serve instead of stacking one,
a died serve re-provisions itself, and every missing gate answers its own
honest state on the card (Termux missing → the setup hand-off; no key →
the key prompt; a dead bridge → the wall + alternatives). Desktop
behavior is byte-unchanged.

**Two new native hands + a retired bridge** (v1.47 PLAN-V147): the
engine's tool registry grew to 31. `djournal` — the personal journal
(the authentic Go port of `brain/tools/dt_journal.py`: moods, tags,
highlights, gratitude, energy, day streaks, rotating prompts, weekly
reviews, md/json exports) — one append-only diary per install at
`<data-dir>/journal/entries.jsonl`; exports also land in the chat's
artifact drawer. The port is pinned byte-for-byte against the Python
spec itself (`engine/internal/djournal/djournal_parity_test.go` runs
both implementations over one scenario — banker's rounding, the
own-zone date law, and the JSON entry shape all agree exactly).
`fleet` — the other-chatbots roster + detail (the A2A agent-card
grammar over the engine's own truth: title/model/canvas/live state/
turns, the q filter, and one chat's full card with its CURRENT action
from the live events tail + the running/idle turn-gauge truth).
And the old PM bridge's orphaned `/api/tools/*` tool-server routes are
GONE (the WebView-bridge chat that consumed them died with the native
PM; a full-tree sweep found zero consumers) — the mcpbus, `/mcp`, and
the brain's `/api/pm/local` bridge all stay.

## Structure

```
doomalay/
├── engine/          # Go — HTTP/WS, SQLite, secrets, sandbox
├── brain/           # Python — Strands agent, templates, panel, tools
├── app/             # PWA — Vite + React 19 + PixiJS + Matter.js
├── platforms/       # Platform-specific files
│   ├── android/     # Kotlin + Chaquopy APK
│   ├── windows/     # NSIS installer (future)
│   ├── linux/       # AppImage (future)
│   ├── macos/       # .dmg (future)
│   ├── ios/         # PWA-only (future)
│   └── hf-space/    # Docker (app-building machine)
├── docs/
└── scripts/
```

## Quick Start

```bash
# Setup brain (one-time)
cd brain && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Build + run
make build-engine
./engine/doomalay-engine
# Opens http://localhost:8080
```

## Dev

```bash
make dev  # 3 terminals: engine, brain, PWA hot-reload
```

## Platforms

| Platform | Build | Download |
|---|---|---|
| Android | `make build-apk` or CI | GitHub Releases (.apk) |
| Windows | CI | GitHub Releases (.exe) |
| Linux | CI | GitHub Releases (AppImage) |
| macOS | CI | GitHub Releases (.dmg) |
| HF Space | `make build-hf-space` | Docker image |

See `docs/` for platform-specific setup guides.
