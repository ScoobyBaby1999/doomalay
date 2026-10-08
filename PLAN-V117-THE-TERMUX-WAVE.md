# PLAN-V117 — THE TERMUX WAVE (v1.17.x)

The user's directive (the v1.16 pivot): "let's setup termux. The current turn,
and all other future turns related to termux should only be packaged or come
with the APK version… Instead of having quick chat, HF chat, and all these. We
only have quick chat… pressing the +sandbox should instead act as a
+capabilities overlay screen… the user can stack them… For now, let's work on
the first turn for termux [the setup experience]."

THE SHELL WAVE's desktop-PTY phases (PLAN-V116 §1–3) stay parked; Termux is
the first real Linux to arrive. This wave: the capabilities pivot, the Termux
one-click-as-close-as-possible setup (APK only), and the live dynamic update
system. Termux workspaces + the MCP tool layer = the NEXT wave (PLAN-V118) —
this wave the capability is inert by default, exactly per spec.

## The research receipts (2026, verified against primary sources)

- **RUN_COMMAND intent** (`com.termux` / `com.termux.app.RunCommandService`,
  action `com.termux.RUN_COMMAND`): the official external-app execution
  contract. Extras: `RUN_COMMAND_PATH` (mandatory), `RUN_COMMAND_ARGUMENTS`
  (String[]), `RUN_COMMAND_WORKDIR`, `RUN_COMMAND_BACKGROUND`,
  `RUN_COMMAND_SESSION_ACTION`, `RUN_COMMAND_STDIN`, and — the result
  mechanism (Termux ≥ 0.109) — **`RUN_COMMAND_PENDING_INTENT`**: Termux fires
  our PendingIntent with a Bundle at key `result` carrying `stdout`, `stderr`,
  `stdout_original_length`, `stderr_original_length`, `exitCode`, `err`,
  `errmsg`. Background mode returns SEPARATE stdout/stderr + exit code.
  Output capped ~100KB combined (original lengths reported) — full output
  must ride files in the workspace (the next wave's tools page through them).
- **Permission gate**: both apps declare `com.termux.permission.RUN_COMMAND`
  (protectionLevel dangerous); the USER grants it in Settings → Apps →
  Doomalay → Permissions → Additional permissions. Plus
  `allow-external-apps = true` in `~/.termux/termux.properties`. Plus
  `<queries><package android:name="com.termux"/></queries>` for package
  visibility (targetSdk ≥ 30). PendingIntent needs FLAG_MUTABLE (S+), unique
  requestCode per command.
- **F-Droid stable verified**: 0.118.3 / versionCode 1002 —
  `https://f-droid.org/repo/com.termux_1002.apk` (checked live: HTTP 200,
  ~114MB). GitHub mirror:
  `https://github.com/termux/termux-app/releases/download/v0.118.3/…`.
- **termux-setup-storage on Android 11+** opens the All-Files-Access screen;
  after it, Termux reads/writes `/storage/emulated/0` with plain POSIX
  (except other apps' `Android/data|obb`).
- **Bootstrap one-liner precedent** (Hermes Agent):
  `curl -fsSL <url> | bash`. `termux-reload-settings` exists (re-reads
  termux.properties). Play-store Termux is dead (0.101) — F-Droid/GitHub
  builds only.
- **Loopback between apps: fully allowed** — Termux can reach the engine at
  127.0.0.1:8080 and vice versa. (Future: an in-Termux MCP server can attach
  straight onto our bus — DroidMCP, MIT, pure-Go, is the reference.)
- **SAF from pure Go: impossible** (content:// resolves only through Java
  ContentResolver). Decision: ALL Termux-side file I/O is executed BY Termux
  (RUN_COMMAND with jailed workdir) — the engine never touches shared
  storage itself; one path language (workspace POSIX paths), one jail point
  (the tool layer's prefix checks). SAF tree picking (ACTION_OPEN_DOCUMENT_
  TREE, persistable grant, docId `primary:Rel/Path` → real path derivation)
  is the workspace picker of the NEXT wave.
- **Delta updates**: assets inside an installed APK are immutable; the
  practical GitHub-distributed pattern is a **server-hosted asset overlay**
  — the app downloads only changed web files into `filesDir/ota/`, the
  engine serves ota-first/embedded-fallback, the PWA prompts a reload. The
  repo already carries the prior design (`docs/OTA.md`,
  `scripts/generate-patch-manifest.py` — the Kotlin OtaUpdater died in the
  Brick-1 reset); this wave rebuilds it ENGINE-side (the engine has outbound
  HTTPS already — web_search lives there).

## The decision (the user's own decision tree, resolved)

"would [one-click] require the user to also download an update that on the
fly bundles a script… then defer termux and build the update system first."
→ **No.** The setup script is fetched by `curl` from the REPO (raw GitHub
URL), not bundled in the APK — fixing the script never needs an APK update.
So Termux ships FIRST; the live update system ships as its own phase in the
same wave (wanted regardless: "we need an update system… only downloading the
update instead of the whole thing").

**The honest one-click floor** (Termux's own security model forces exactly
three user actions — by design, not by our limitation): ① install Termux
(F-Droid tap), ② run ONE pasted command in Termux (the curl bootstrap), ③
grant the "Run commands in Termux environment" permission (settings tap).
Everything else — detection, probing, state transitions, workspace defaults —
is automatic. We document this floor in the setup screen itself.

## The architecture

### v1.17.1 — THE PIVOT (web)

- **The sandbox picker dies.** New chats are `quick` by birth (state.sandbox
  = 'quick' at icon creation); no picker. The `hf` / `device` / `terminal`
  cards are deleted — existing HF sessions keep rendering (legacy display
  labels stay; no new HF chat creation).
- **`sandboxpicker.js` → `capabilities.js`** (same file slot in index.html):
  `window.Capabilities.open(ctx)` renders THE CAPABILITY LIBRARY on the
  ConnectOverlay — a compact scrollable list of small-icon rows (the future
  "port capabilities + list them" library): stackable toggles bound to the
  session's existing fields (🔍 web search · default-on, 🔬 deep research,
  🛠 library, ✨ skills, 📄 templates), action rows that open their existing
  pickers (🎭 persona, ▣ workspaces), and — APK builds only (`__doomalayKotlin`
  present + device detect) — **⌨ Termux** with its setup state machine row.
  Theme vars only; every row state (on/off/setup-needed) is a var-styled chip.
- **chatframework.js**: gatelock = ONE required box (👾 model) + ONE optional
  box (**+ capabilities · stack what you need**); `isFulfilled` = model only.
  `pills()`: model pill + a `+ capabilities` pill replacing pill-sandbox.
  `sessionTermux` rides `extraSessionFields`.
- **chatpanel.js**: `applySandbox` logic thins to legacy PATCH compat; caps
  pill row wiring; termux pill appears in the metadata dropdown when active
  (accent-styled per the user's "pill turns primary/accent" spec).
- **Engine**: `chat_sessions` gains `termux INTEGER DEFAULT 0` (the stacked
  capability field, inert this wave); sessions create/PATCH round-trip it;
  `pills_test` pin; `sessionctx.go` teaching line moves from sandbox-type
  prose to capabilities prose ("capabilities stacked on this chat: …").
- Tests: `scripts/v1171-pivot-test.js` (source pins + behavior via a stubbed
  DOM/JS environment consistent with prior rigs) + Go session round-trip.

### v1.17.2 — THE BRIDGE (Kotlin + engine plumbing)

- **AndroidManifest**: `<uses-permission
  android:name="com.termux.permission.RUN_COMMAND"/>` + `<queries>` entry.
- **`TermuxBridge.kt`** (new, in the APK shell): Termux installed +
  versionCode ≥ 1002 check; RUN_COMMAND permission-granted check; the
  RUN_COMMAND sender with a per-command PendingIntent (unique requestCode,
  FLAG_ONE_SHOT|FLAG_MUTABLE|FLAG_UPDATE_CURRENT; dynamic receiver with a
  token-suffixed unguessable action, RECEIVER_EXPORTED on 34+); probes;
  launch-Termux / open-F-Droid intents.
- **The loopback bridge server** (EngineService hosts a minimal ServerSocket
  HTTP server on 127.0.0.1:8081, token = per-boot random, passed to the
  engine as `--termux-bridge http://127.0.0.1:8081/<token>`): endpoints
  `GET /status` (installed/version/permission), `POST /probe` (the one-shot
  verification command round-trip), `POST /run` (the generic jailed exec —
  used by setup verification + tests this wave; the MCP tool lands next
  wave), `POST /act` (open Termux / open F-Droid / open permission settings).
  Same-UID loopback, token-authed, engine-side client only.
- **Engine**: `--termux-bridge` flag; `internal/termuxbridge` client package
  (http POST, timeout ladder); `GET /api/termux/status` — the aggregation
  endpoint (GOOS==android gate: non-android builds answer
  `{available:false}` honestly; on android without the flag/bridge: honest
  degraded state). Status cached with TTL + `?refresh=1` force.
- Tests: Go client against a stub bridge server (status/probe/run/act +
  token rejection + timeout); Kotlin compiled by the existing gradle build.

### v1.17.3 — THE SETUP (the first turn of Termux, user-visible)

- **`termux/setup.sh`** in the repo (the curl bootstrap target — lives in
  git, not the APK, so it evolves without app updates): sets
  `allow-external-apps = true` + `termux-reload-settings`, runs
  `termux-setup-storage` (interactive — the All-Files dialog), `pkg update +
  coreutils`, prints an honest step log. One-liner:
  `curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh | bash`
  (with the GitHub release mirror as fallback comment).
- **The setup overlay page** (ConnectOverlay — THE CONTAINER LAW): live
  step cards that auto-advance by polling `/api/termux/status`:
  ① Install Termux (F-Droid primary + GitHub mirror links; detects install)
  ② Bootstrap (the copy button + "Open Termux" button + the one-liner shown;
  detects bridge_ok) ③ Grant permission (settings deep link; detects grant)
  ④ Verify (the probe: storage_ok + bridge_ok → **READY**). The three-tap
  honesty note rides at the top. Exit → back to the capability library; the
  Termux row flips to its ready state (accent chip).
- **The capability activation**: with the device READY, the library row's
  toggle stacks ⌨ Termux onto the chat (session.termux=1, PATCH, pill appears
  accent-styled). Inert by default ✓ — no tools, no workspace, nothing until
  the next wave.
- Tests: setup-overlay state machine against a fake `/api/termux/status`
  ladder (agent-browser); `bash -n` on setup.sh; the one-liner verified
  against a local HTTP stub of the raw URL.

### v1.17.4 — THE LIVE UPDATE (delta OTA)

- **Engine `internal/ota`**: manifest check (default
  `https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/patch-manifest.json`,
  override via `DOOMALAY_OTA_URL` for tests/offline mirrors): {min_engine,
  files:[{path, sha256, size}]} — hashes compared against the LIVE serve
  stack (ota-file → else embedded). Changed files download to
  `<dataDir>/ota/` atomically (.tmp → rename), sha256-verified, corrupt =
  delete + honest error. The static handler serves ota-first/embedded-
  fallback — pure web-asset patches apply WITHOUT an engine restart; the PWA
  reloads on the next prompt. Manifest `min_engine` > buildinfo.Version →
  honest "full APK update" state with the release link (engine binary can
  never be hot-patched — documented).
- **PWA**: boot + 5-min-interval `/api/ota/status` → a theme-var toast/banner
  ("update available · N files · ~KB") with an optional Update action →
  progress (poll) → "reload to apply" → reload. Opt-out persisted locally.
- **CI**: build-apk.yml generates + uploads `patch-manifest.json` (hash the
  built web tree) to the GitHub release; the tag flows into min_engine
  bookkeeping.
- Tests: full OTA round-trip against a local manifest+files stub (download →
  verify → overlay serving → corrupt-file rejection → min-engine gate →
  status states), with a real engine restart cycle.

### v1.17.5 — THE REDTEAM

- The rig: `scripts/v1175-redteam-rig.mjs` — stub bridge servers (healthy /
  slow / dead / wrong-token), the status aggregation ladder, the setup
  overlay's every transition, the OTA round-trip + failure ladder, the pivot
  pins (no sandbox-picker strings left, quick default at birth, capabilities
  stack round-trip).
- agent-browser real-user E2E against the live engine (sandbox): the pivot
  flow (new chat → model teach flow → capabilities library → stack toggles →
  persistence across reload), the Termux setup overlay against a fake bridge
  state ladder (all 4 states), the OTA banner + apply + reload flow.
- The honest gap, stated in the worklog: the REAL RUN_COMMAND round-trip
  (com.termux receiving our intent) can only be proven on a real Android
  device with real Termux — the sandbox has neither. The rig proves our side
  of the contract exactly as the research receipts specify; the user's device
  (tunnel or direct APK) is the final judge. A device-test checklist ships
  in the release notes.

### Ship v1.18.0

buildinfo bump + wave record + the parallel-wave rebase check.

## The contracts this plan keeps

- ONE of the two legal containers (the ConnectOverlay hosts the library, the
  setup page, and the update banner's action surface).
- Theme vars only, everywhere (xterm-style hard colors never appear; the
  capability rows' accent chips ride `--accent`/`--on-accent`).
- APK-only Termux: engine gate `runtime.GOOS == "android"`, PWA gate
  `__doomalayKotlin` — desktop/exe builds never see a Termux surface.
- The bus is the future tool system (next wave: `termux_exec`/file verbs as
  mcpbus Defs with GateTermux — observers + honest degrade for free).
- Honest states everywhere: not-installed / permission-missing / dead /
  timed-out are first-class statuses, never silent failures.
- Session-field persistence rides the existing pills/PATCH machinery.
- No new hard latency: the capability library is plain DOM; Termux status is
  cached + lazily fetched only when its surfaces are visible.
