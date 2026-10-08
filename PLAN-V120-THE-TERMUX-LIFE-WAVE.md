# PLAN-V120 — THE TERMUX LIFE WAVE

The Termux capability comes ALIVE: the setup stops spamming, the chat metadata
pill dies, local device-storage workspaces actually work through Termux, and the
bot gets the full jailed Termux hand (exec / file verbs / pkg / background
process sessions). Phases v1.20.1 → v1.20.4, ship **v1.21.0**.

User fronts (verbatim intents):
1. "gate step 3 until step 2 is complete or the user gets spammed with
   notifications until they complete step 2" → THE QUIET GATE.
2. "remove the termux pill from the chat metadata that gets added when termux
   is live" → the ⌨ pill dies (the capability library row stays).
3. "fix the connect a workspace to support connecting local device storage
   repos for both read and write access… we display the output in a formatted
   manner of files the user can select… and an option to create a new folder"
   → THE LOCAL HAND.
4. "focus on adding capabilities and maxing out termux… sessions might be
   something that the bot should be able to create and kill on the fly like
   python processes" → THE ARM.

## Research receipts (verified this wave, primary sources)

- **THE SPAM SOURCE (termux-app master, RunCommandService.java)**: every
  RUN_COMMAND while `allow-external-apps` is unset calls
  `TermuxPluginUtils.processPluginExecutionCommandError(…, forceNotification=true)`
  — a FORCED notification, by design ("the user knows someone tried to run a
  command in termux context"). Our 30s-TTL probe re-fires = one forced
  notification per 30s while the user reads the bootstrap. THE FIX: never fire
  RUN_COMMANDs while props are unconfirmed — the checkin route proves props
  with ZERO commands.
- **Result caps (ResultSender.java + DataUtils)**: stdout+stderr ride the
  result Bundle capped at `TRANSACTION_SIZE_LIMIT_IN_BYTES = 100 * 1024`
  (÷2 when both present); `stdout_original_length`/`stderr_original_length`
  carry the true sizes → the engine can report truncation HONESTLY.
- **EXTRA_STDIN (`com.termux.RUN_COMMAND_STDIN`)**: the intent accepts a stdin
  String for the command → file writes ride `bash -c 'cat > "$1"' _ <path>`
  with stdin content — ZERO shell-escaping surface.
- **Runners (RunCommandService.java)**: `EXTRA_RUNNER` "terminal-session"
  (default, visible session) vs "app-shell" (background — what we send via
  EXTRA_BACKGROUND=true). SESSION_ACTION extras (0-3) only apply to
  terminal-session runner — visible Termux tabs, not needed this wave.
- **Session control (TermuxService.java + AndroidManifest.xml)**:
  `TermuxService` is `exported="false"` — NO external list/kill API exists.
  The bot-facing session model = BACKGROUND PROCESSES (nohup + log + pid
  under `$HOME/.doomalay/sessions/<name>/`), created/killed/tail-read through
  one-shot RUN_COMMANDs — exactly the "python processes" the user described.
- **Workdir validation (TermuxFileUtils)**: RunCommandService auto-creates/
  fixes permissions ONLY under Termux-owned paths; external-storage workdirs
  must EXIST (mkdir -p first) — they validate read/write fine when present.
- **Live device (tunnel trend-almost-ltd-overall.trycloudflare.com)**: engine
  v1.19.3, Termux 0.119.0-beta.3 (versionCode 1022), probe round-trip green
  (props/storage/permission/bridge all true) — the v1.17.2 contract HOLDS on
  real hardware.
- **The FS Access dead end**: `window.showDirectoryPicker` does not exist in
  the Android WebView → the current device-storage page can never work on the
  APK (the user's report). ALL device I/O routes through Termux (one jail
  point) — the v1.17.2 decision, now proven.

## v1.20.1 — THE QUIET GATE (agent A, worktree -a)

The setup stops spamming, step ③ gates on step ②, the metadata pill dies.

- **Kotlin `TermuxBridge.kt`**: a SECOND random token (checkinToken) with ONE
  route `GET /<checkinToken>/checkin?storage=0|1&props=0|1` — records
  bootstrap_done + the script's own step outcomes + a timestamp.
  `statusJson()` grows `checkin_url` (full loopback URL), `bootstrap_done`,
  `checkin_at`, `checkin_storage`, `checkin_props`. The main token stays the
  ONLY key to /run|/probe|/act (a checkin-token holder can only mark the
  bootstrap — worst case an honest failed probe, never command execution).
  `runJson`/`bundleToResult` also pass `stdout_original_length`/
  `stderr_original_length` through (honest truncation data, used by .3).
- **`termux/setup.sh`**: `--checkin <url>` arg; at the end (non-fatal, honest
  echo) `curl -fsS --max-time 6 "<url>?storage=…&props=…"`.
- **Engine `termuxapi.go`**: status passthrough (checkin_url, bootstrap_done,
  checkin_storage/props/at) + **THE SUPPRESSION LAW**:
  `termuxProbeCached` auto-probes (TTL expiry) ONLY when
  `lastProbe.propsOK || bootstrapDone || cache-empty-first-look` — i.e. once
  the state is honestly known-not-props, NO further auto probes fire until
  the checkin arrives or an explicit `refresh=1` (user-driven act/verify
  taps). `?refresh=1` still forces (explicit user action — a single honest
  notification, never a loop).
- **`termuxsetup.js`**: the bootstrap command is built DYNAMICALLY when
  `status.checkin_url` exists (`curl … setup.sh | bash -s -- --checkin <url>`);
  static fallback for old engines. Step ②'s done marker =
  `bootstrap_done || bridge_ok`; a "check now" ghost button on step ② forces
  one explicit probe (the old-flow escape hatch). **Step ③'s Open-settings
  button is DISABLED until step ② is done** (the user's gate ask) with the
  honest "complete step ② first" chip text. Step ② keeps its Open Termux
  button (the user's nice-to-have — already there, stays).
- **PILL DEATH**: `chatframework.js` loses the `pill-termux` push; chatpanel
  loses the late-repaint hook + PILL_TONES entry (the ⌨ pill was chat
  METADATA noise; the capability stays visible in the 🧩 library row).
- Rigs re-pinned honestly: v1171 (pill), v1173 (ladder + command), v1175
  (S2 status shape + pill pins). New Go tests: checkin passthrough + the
  suppression matrix.

## v1.20.2 — THE LOCAL HAND (agent B, worktree -b)

Connect-a-workspace actually works for local device storage on the APK.

- **Engine `termuxfs.go` (NEW)**: `GET /api/termux/fs?path=<p>` — a jailed
  listing (safe roots: `/storage/emulated/0` mapped through
  `$HOME/storage/shared`, `$HOME`, `$HOME/storage/downloads|documents|…`).
  The Termux-side script emits `type|name|size|mtime` lines (ls -1 class
  data, dirs first, hidden dotted entries INCLUDED, 500-entry cap with an
  honest `truncated` flag); the engine parses → JSON entries + the resolved
  absolute path. `POST /api/termux/fs` `{action:"mkdir", path}` → `mkdir -p`
  + honest result. Both refuse (HTTP-honest, never 500) when the bridge
  isn't ready. Path jail: every path is resolved to an ABSOLUTE Termux-side
  path, must sit under a safe root — `..` escapes and symlink-laundered
  paths refused (readlink -f resolution Termux-side, prefix-checked
  engine-side).
- **`workspaces.go`**: `handleWorkspaceDevice` accepts `termux_path` → rows
  saved `Kind: "termux"` with meta `termux_path` (+display path). 
- **Engine file I/O for termux rows**: `GET /api/workspaces/{id}/file?path=`
  (cat, binary-honst) + `PUT` (stdin write law — `bash -c 'cat > "$1"' _`
  with EXTRA_STDIN, no shell escaping) — the SAME REST shape the cloud rows
  speak, so the PWA viewer/editor twins apply.
- **`workspace.js`**: `openDevicePage` on APK+ready renders THE TERMUX
  BROWSER (the File-Access API page stays for desktop): root picker (📱
  device storage, 📥 downloads, 📄 documents, ⌂ termux home, ★ Doomalay
  folder) → formatted entry rows (icon + name + size + date, dirs first) →
  tap to descend, breadcrumb back, ＋ new folder (mkdir → navigate in),
  name field, "use this folder" → POST bind → toast + back to picker.
  Termux rows in the picker/drawer render 📱 with the real path as the sub.
  The viewer/editor for termux rows rides the engine REST (the cloud-file
  twin). NOT-ready state renders the honest "Termux needs setup" teach row
  (opens the setup overlay) — the page never dead-ends.
- New rig `scripts/v1202-local-hand-test.js` + Go tests (jail matrix, mkdir,
  listing parse, refusal ladder, device workspace round-trip).

## v1.20.3 — THE ARM (agent C, worktree -c)

The bot's Termux hand, maxed out and jailed.

- **mcpbus**: `GateTermux` + ONE `termux` Def (props: action + args JSON —
  the workspace tool's proven one-tool/verb-map shape):
  `exec | ls | read | write | append | rm | mkdir | grep | find | pkg |
  session_start | session_list | session_log | session_kill | help`.
  `Gates.Termux` + `Turn.Termux` closure wired through `llm/mcpbridge.go` +
  `llm/chat.go` (`TermuxToolFn`) + `server/chat.go`.
- **`server/termuxtool.go` (NEW)**: `runTermuxAction(sessionID, argJSON)` —
  the verb dispatch over the bridge's `/run`:
  - exec: workdir-jailed to the bound workspace, blocklist (the PLAN-V116
    laws: rm -rf /, dd, mkfs, reboot, sync/flush, shutdown, :(){ fork bombs),
    timeout cap, FULL stdout+stderr+exit_code with the 100KB truncation
    HONESTLY reported (`[termux: output truncated at 100KB by Termux]`).
  - file verbs: HARD path jail (prefix-check against the chat's bound
    termux workspace roots, readlink-resolved); write/append via EXTRA_STDIN.
  - grep: unlimited hits (the v1.19.1 whole-truth law).
  - pkg: `pkg install -y …` / update / remove (per-op, non-interactive).
  - sessions: `$HOME/.doomalay/sessions/<name>/{run.sh,out.log,pid}` —
    session_start (nohup, `echo $! > pid`), session_list (dir + `kill -0`
    liveness + ps line), session_log (tail, default 200 lines, whole bytes),
    session_kill (SIGTERM → 3s → SIGKILL, honest report).
  - Per-chat cooldown on exec (the shell-wave law: ≥4s between one-shots,
    bursts refused honestly) + per-turn op cap.
  - Arming: session.termux AND ≥1 bound termux workspace — otherwise the
    tool is not in the manifest and the ACTION answers the honest teach.
- **`sessionctx.go`**: the inert note dies; the armed line teaches the
  workspace paths + verbs + the sessions model + honesty caps.
- Rig `scripts/v1203-arm-test.js` + sessionctx_test re-pin + mcpbus def
  tests (manifest gating matrix).

## v1.20.4 — THE REDTEAM + SHIP (orchestrator)

- Merge .1 → .2 → .3 sequentially (rebase + conflict audit between each),
  pushing each phase commit to main.
- The rig extension: checkin ladder + suppression matrix, fs jail matrix,
  tool verb matrix + blocklist + cooldown + sessions lifecycle (fake bridge
  against the live sandbox engine).
- agent-browser real-user E2E: setup walk (checkin-driven auto-advance, the
  gated step ③), workspace connect (fake bridge fs), a chat turn with the
  termux tool (scripted carrier), the metadata pill's ABSENCE, theme + 390px
  mobile checks, zero console errors.
- Real device through the tunnel: status/act + the updated device-test
  checklist (the new APK is the gate for on-device checkin/fs/run proof —
  v1.19.3 device can't serve the new endpoints).
- buildinfo 1.21.0 + the wave record. Push. CI builds the APK.

## The laws (all phases)

- Theme vars ONLY (zero hardcoded colors). UI rides the ConnectOverlay (the
  overlay screen law) — no new floating surfaces.
- Every failure is a visible honest state, never silence, never a 500 for
  a Termux-side problem.
- Full output (the whole-truth law); the ONLY caps are Termux's own physics
  (100KB result Bundle), reported honestly.
- File-disjoint phase surfaces; the orchestrator owns pushes + the worklog
  merge.
