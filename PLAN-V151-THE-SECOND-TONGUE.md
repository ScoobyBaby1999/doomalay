# PLAN-V151 — THE SECOND TONGUE

The user's ask (verbatim anchor): "Ur next goal is to update all our opencode
integration to 2.x, tell me if I MUST do anything manually, else you do it.
And test opencode big pickle, have it test every tool capabilities in the app."

Standing laws honored: plan → research → build → red-team; phases v1.51.x then
the v1.51.0 ship; two-surface UI; theme tokens only; rebase before every push
(THE MERGED-TREE LAW: re-run the rig on the merged tree before the ship).

## THE RESEARCH (live from this sandbox, 2026-10-21 — CAPTURED-TRUTH.md)

- **OpenCode 2.x is an npm line.** `@opencode/cli` 2.1.2 (published TODAY
  2026-10-21T03:39) is the latest; platform binaries ship as
  `@opencode/cli-{linux-x64,linux-arm64,darwin-arm64,darwin-x64}` tarballs on
  registry.npmjs.org. GitHub releases remain **1.x only** — the official
  install script literally says "This installer only installs OpenCode 1…
  OpenCode 2 ships as @opencode/cli". Our desktop pin must move to npm.
- **The Android line exists for 2.x**: guysoft **opencode2 v1.0.3-rc3**
  (Oct 18 2026) = OpenCode **2.0.0-android-termux**. Flat zip
  (opencode2 wrapper + opencode2.bin 173MB + libopentui.so), SHA256
  `0725f327…d13893` verified against the release's own SHA256SUMS. The
  wrapper self-handles every Android trap (OPENTUI_LIB_PATH,
  LD_LIBRARY_PATH, disables @parcel/watcher) — flat unzip→run, no pkg
  manager. Its route strings carry EVERY core route we need.
- **The serve changed under us** (live-probed against the REAL 2.1.2):
  - HTTP **basic auth by default** — user `opencode`, password from
    `OPENCODE_SERVER_PASSWORD` (if unset the serve generates a RANDOM one
    and prints it to stdout — we must SET ours, never parse it).
  - The API moved under **`/api/`** (the docs' bare paths are the NEXT
    version; the 2.1.2 binary is the truth: routes extracted from its own
    strings, then every one probed live).
  - `POST /api/session {title}` → `{"data":{"id":"ses_…"}}`.
  - **Model selection moved to the session**: `POST /api/session/{id}/model`
    `{"model":{"id":"<model>","providerID":"opencode"}}` → 204; the turn
    echoes it in `session.step.started`.
  - The prompt is `POST /api/session/{id}/prompt` `{"text": "…"}` — the
    PromptInput is `{text, files?, agents?, skills?}` only: **the 1.x
    shape-poison gate law is MOOT in 2.x** (no tools/system fields exist to
    send). The persona + context keep riding the text (unchanged adapter
    law).
  - SSE `GET /api/event` (auth'd) must start with `server.connected`; the
    envelope is `{id, created, type, data:{sessionID,…}}` and the whole
    vocabulary is NEW: `session.reasoning.delta` / `session.text.delta`
    (data.delta), `session.tool.input.started/ended` +
    `session.tool.called/success(/failed)` (data.id/name/text/content),
    `session.usage.updated` (data.cost + data.tokens{input,output,reasoning,
    cache{read,write}} — the ledger), terminals
    `session.execution.succeeded` / `session.execution.failed`
    (data.error{type,message,status}).
- **THE GATE PASSES ON 2.x** (the decisive probe): the genuine 2.1.2 client +
  our key answers real big-pickle turns, **cost 0**, reasoning + text + tool
  turns + session reuse all live-proven. The 2.x permission config (legacy
  `permission` object still valid, deprecated) keeps the agent honest — with
  shell/edit/webfetch/task denied the model answers "I don't have a shell
  tool available"; read/grep/glob stay and a read-tool turn read a file
  live. The 2.x free agent's own tools: `execute` (sandboxed Code Mode), read,
  glob, grep, question, skill, websearch.
- Failures answer `session.execution.failed` with
  `data.error{type:"provider.auth",status:401,…}` on a bad key — the honest
  error ladder extends.
- The app's model catalog is UNAFFECTED: `opencode.ai/zen/v1/models` is
  public and lists big-pickle + the *-free family (86 models).

## THE ANSWER TO THE USER'S MANUAL QUESTION

**Nothing is manual.** Desktop: the engine downloads the pinned 2.1.2 npm
tarball itself (sha512-verified). Android: the same ONE TAP installs
opencode2 (72.5MB) through the jailed exec — and a NEW best-effort cleanup
removes the old 1.x client files after the unzip (phone storage honesty).
The old recorded-serve reuse stays honest: the authenticated health poll
refuses any 1.x serve left on the recorded port.

## THE PHASES

- **v1.51.1 THE NEW TONGUE** — `ocserve.go`: the 2.x client. The pinned
  `Version = 2.1.2`; the npm tarball pin (per-OS/arch URL + sha512
  integrity constants, crypto/sha512 + base64 verify — THE PIN LAW moves
  from GitHub releases to npm); extraction of `package/bin/opencode` to the
  managed path; the 2.x gate-law config (2.x permission names); the server
  password (generated at New, env-overridable for rigs/tests, carried by
  the spawn env — NEVER the command line); basic auth on EVERY request
  incl. SSE; `healthyUp` = auth'd `GET /api/provider`; `CreateSession`
  (data.id), NEW `SelectModel` (per-turn model law), `Prompt` (text-only
  body), `StreamEvents` with the v2 envelope + event family + terminals +
  the auth'd route; `IsFreeTierError`/`IsAuthError` off
  `session.execution.failed`. Unit pins: the captured live frames as
  fixtures, the /api prefix, auth-on-every-call, the npm URL + sha512 law,
  the password-never-on-cmdline law.
- **v1.51.2 THE YOUNGER GUEST** — `termux.go`: the opencode2 v1.0.3-rc3 pin
  (URL/SHA256/size 72.5MB/version copy); wrapper/binary names (`opencode2`,
  `opencode2.bin`); install-check + unzip + chmod shapes; the legacy-1.x
  cleanup line; key.env carries BOTH the API key AND the server password
  (stdin-written, 0600, ps-safe — the tests pin both); spawn
  `…/opencode2 serve --port N --hostname 127.0.0.1` sourcing key.env; the
  health poll rides the client's authenticated check. Unit pins updated
  byte-for-byte (the 64-hex law, the command shapes, idempotence, reuse,
  the honest gates).
- **v1.51.3 THE TURN PUMP** — `ocserveturn.go`: the 2.x→engine mapping:
  `session.reasoning.delta`→thinking, `session.text.delta`→assistant_delta,
  `session.tool.input.started`+`input.ended`→tool_use (name + serialized
  input), `session.tool.success`/`failed`→tool_result,
  `session.usage.updated`→the ledger (input/output/reasoning/cache/cost,
  finish from the last step.ended), `session.execution.succeeded`→the
  idle terminal, `execution.failed`→the honest error (recycle law on
  free-tier refusals, honest key-error copy on provider.auth);
  `SelectModel` before every prompt (the per-turn model law, 1.x had the
  model ride the prompt). Unit pins from the captured frames.
- **v1.51.4 THE APP SURFACE** — `ocbridgeapi.go` version/copy strings
  (OpenCode 2.0.0, opencode2 v1.0.3-rc3, 72.5MB), `providers.js` card size
  hints + copy, the bridge state ladder copy — two-surface law, theme tokens
  only.
- **v1.51.5 THE LIVE PROOF (BIG PICKLE)** — `scripts/v1510-second-tongue-rig.py`:
  (a) DESKTOP MODE, the real chain: fresh dir → the engine's own
  EnsureBinary downloads the npm tarball + sha512-verifies → spawn (password
  env) → health → **a big-pickle turn testing every tool capability**:
  thinking deltas, text deltas, a read-tool multi-step turn (the pill),
  the usage ledger, session reuse, a mid-chat model switch, GET /message
  fetch, the bad-key honest failure, the watchdog, the honest gates;
  (b) ANDROID-CHAIN MODE: the fake termuxbridge + the opencode2 flat-layout
  twin (the real linux 2.1.2 renamed into the opencode2 zip layout) → the
  FULL pocket-bridge chain: one tap → install → spawn → real turn → reuse →
  kill → watchdog re-provision → third turn;
  (c) DEVICE MODE (the tunnel if up, honest SKIP if down): the real phone
  installs the real aarch64 opencode2 and answers a real turn.
- **v1.51.0 THE SHIP** — rebase (fetch; parallel-bot commits; merged-tree
  law) → the full Go battery + the rig on the merged tree → buildinfo
  1.51.0 → README paragraph → cross-compile linux + android-arm64 → tag
  v1.51.0-the-second-tongue → push.

## THE HONEST LIMITS (on the record)

- The desktop pin is 2.1.2 (npm); the Android pin is opencode2 v1.0.3-rc3
  (a prerelease build of 2.0.0 — the only 2.x Android line that exists; the
  rc is the newest, 3 days old, fixing an Android seccomp SIGSYS + Ctrl+B).
  Both are env-overridable without a release (THE PIN LAW).
- The 2.x serve speaks the 2.x API only — the adapter drops the 1.x shapes
  (the env override `DOOMALAY_OPENCODE_BIN` pointing at a 1.x binary will
  start it but the client will honestly fail health; the answer is: don't
  pin 1.x).
- The websearch tool stays allowed (OpenCode's own free-product capability);
  question/task/external_directory/doom_loop now deny (a headless serve
  has no human to answer `ask` — deny answers the agent honestly instead
  of hanging).
