# PLAN-V116 — THE SHELL WAVE

The user's directive (2026-10-08, the v1.15 wave's tail): "let's see how
to implement modal- or any other method, to deliver bash, shell, and real
Linux capabilities to quick chat. We do that then move to local thru
termux." This is the DESIGN wave — no implementation ships here; v1.16.x
builds it phase by phase.

## The research receipts (2026-10-08)

- **xterm.js** is the canonical browser terminal (ttyd, gotty, gotty
  successors, every "shell in a web page" product). Frontend-only; the app
  already vendors everything under web/vendor (no CDN — same rule).
- **PTY backend**: the classic pattern is a Go (or any) backend bridging
  WebSocket ↔ PTY (creack/pty). The engine IS a local Go process on the
  host — the shell it exposes is the host's own real Linux/Unix shell.
  Full-Linux-in-WASM (v86, CheerpX, LinuxOnTab) boots 30–100MB images and
  EMULATES a kernel we already have — rejected for the engine path,
  reconsidered only if a future "no-host shell" is ever demanded.
- **Android/CGO**: creack/pty needs cgo; the engine's android build is
  deliberately CGO-free (the MCP wave's android-safe contract). Two
  answers: (a) build-tag gate the PTY module off android builds and have
  the endpoint degrade honestly, (b) the Termux path runs the engine FROM
  Termux where the toolchain + /bin/sh exist natively. `go-pty` is a
  CGO-free fallback candidate for a later phase if the APK itself must
  own the PTY.

## The architecture

### v1.16.1 — THE PTY (engine/internal/term)

- `Session`: one PTY per chat (creack/pty via `pty.Start(cmd)`), rooted at
  a per-chat sandbox dir (`<dataDir>/term/<sessionID>/`), shell picked per
  platform (`/bin/bash` → `/bin/sh` fallback; PATH honored), env scrubbed
  (provider keys NEVER visible in the terminal's env), `TERM=xterm-256color`.
- The endpoint: **WS `/api/term?session_id=`** — a sibling of
  `/api/chat`, obeying the SAME isolation law: one pipe per session
  (generation-checked swap, serialized writes, the busy/stop semantics
  don't apply — terminals are interactive, no turn lock), input frames
  `{type:'input', data}` / resize frames `{type:'resize', cols, rows}` /
  output frames `{type:'output', data}` (base64), the connect replays the
  last SCROLLBACK window (capped 8k lines / 512KB, ring buffer), idle
  reaper closes shells unused for 10 minutes.
- Build gates: `term.go` (+`//go:build !android`), an android stub
  answers `{"error":"terminal unavailable on this build"}` honestly.
- Security gates (the user's own device, still jailed): the cwd never
  escapes the per-chat dir (a `cd ..` chain is allowed — it's the user's
  own machine and the USER drives the terminal; the BOT path is the one
  that's jailed, see v1.16.3), output byte caps (16MB hard, then the
  session closes honestly), no env keys.

### v1.16.2 — THE OVERLAY (web/terminal.js + vendor/xterm)

- xterm.js + its fit/serialize addons vendored under `web/vendor/xterm/`
  (the license file rides along like every other vendor dir).
- **THE CONTAINER LAW**: the terminal renders in the OVERLAY (the rounded
  box above everything — one of the two legal front-facing containers).
  A ⌨ terminal pill in the chat's toolbar (next to the lib/workspace
  pills) opens it; the overlay's ✕ closes. One terminal overlay at a
  time, bound to the chat that opened it (its session's shell).
- **THE THEME LAW**: xterm's theme object is fed from the LIVE CSS vars
  (`--bg-app`, `--text-1`, `--accent`, …) at open + on
  `doomalay:theme-changed`; zero hard colors.
- The wiring: WebSocket client mirroring chatclient.js's proven patterns
  (absolute ws URL, reconnect ladder, replay quiet-gap tagging) with the
  terminal's own frame types; resize observer → resize frames; focus
  handling (the overlay traps keyboard input while open; Esc closes).
- Mobile: the overlay's input row (a hidden input for the soft keyboard +
  common-key chips: Ctrl, Esc, Tab, arrows) — the pattern every mobile
  terminal uses.

### v1.16.3 — THE TOOL (the bot bridge)

- A `shell` tool on the MCP bus (mcpbus Def): ONE-SHOT exec, NOT the
  interactive PTY — `{command, timeout_s?, cwd?}` → `{exit_code, stdout,
  stderr}` with: timeout (default 20s, hard 120s), combined output cap
  (256KB, truncated + flagged), cwd jailed to the chat's term dir (path
  escapes refused), a BLOCKLIST (rm -rf on /, dd, mkfs, fork bombs,
  `shutdown`, `reboot` — matched on the parsed command + args, not
  substrings), env scrubbed, and a per-session cooldown (max 12
  execs/minute — runaway loops must not hammer the user's CPU).
- The tool is armed per-chat via a toolbar pill (default OFF — a chat
  must OPT IN to shell access; the pill's state rides the session like
  web_search/deep_research, persisted + shown in the metadata preamble so
  the bot knows its own switch).
- Observer coverage: every exec rides the bus observer hooks (traces,
  usage of the tool in the ledger) exactly like every other tool.

### v1.16.4 — THE TERMUX BRIDGE (local Android)

- The engine detects its host: `runtime.GOOS == "android"` + the Termux
  prefix (`/data/data/com.termux/files/usr` exists). When running FROM
  Termux (the user runs the engine binary in Termux directly — documented
  flow), the PTY module un-stubs: Termux's own `/data/.../usr/bin/bash`
  IS a real shell; creack/pty needs cgo there too, so the bridge uses
  Termux's `termux-exec` semantics — exec without PTY when unavailable,
  or the CGO build from Termux's toolchain (documented).
- The APK-embedded engine keeps the honest stub; the APK's 'terminal'
  sandbox chat (⌨️, already labeled in chatbot.js) binds to the Termux
  bridge when reachable over localhost (a Termux-side companion command
  `doomalay-term-bridge` — a tiny Go binary the user builds/installs in
  Termux that speaks the same /api/term WS contract on a local port).
- The chat type: a TerminalChatType (chatframework.js ChatType subclass —
  the framework was built for exactly this) with its own gatelock step
  ("install the Termux bridge") and its own send pipeline
  (command-forwarding through the terminal WS).

### v1.16.5 — THE REDTEAM

- The rig: stub-shell scenarios (fast/slow/never-ending output — the caps
  + reaper), the blocklist (every banned pattern + near-misses that MUST
  run: `rm -rf ./build`, `dd if=file of=file`), the jail (cwd escapes
  refused), the isolation law (two chats' terminals never cross: the
  same 6-scenario shape as the decouple rig, ported to /api/term), the
  theme law (theme-swap screenshot diff), agent-browser real-user E2E
  (open a chat → ⌨ pill → type real commands → ls/cat/echo receipts →
  the bot runs `shell` tool calls in the SAME chat and reports real
  output), PWA reload mid-command (scrollback replays), the Android stub
  honesty.

## The contracts this plan keeps

- ONE of the two legal containers (the overlay) — never a third surface.
- Theme vars only, everywhere (xterm theme included).
- The isolation law: per-session pipes, generation-checked, the decouple
  rig's patterns.
- The bus is the tool system: `shell` is an mcpbus Def like the other 28
  — observers, specs, the honest-degrade contracts for free.
- Honest unavailability (the android stub, the timeout caps, the
  blocklist refusals with reasons).
- No new hard latency: the terminal overlay mounts xterm lazily (only on
  first open — the vendor JS never blocks app boot).
