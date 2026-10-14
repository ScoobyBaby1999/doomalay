# PLAN-V136 — THE FINISHER WAVE
### (an offline Termux setup must finish itself when the network comes back)

## THE REPORT (the user)

Termux setup run with NO network: the script ran, the package steps tried and
failed — yet Termux itself still worked (the bootstrap is bundled in the APK).
The user's ask: **add a recovery method — when the user later has network, the
setup completes what was missing**, so users still get Termux's full
capabilities after an offline first setup.

## THE RESEARCH (websearch, on the record)

- `pkg update` offline FAILS FAST: termux-tools' `pkg.in` probes mirrors first
  (`timeout 6 curl --head --fail --connect-timeout 5 <mirror>/dists/stable/Release`,
  10 parallel jobs) and exits 1 before apt runs when none answer; airplane-mode
  fails in 1–3s. → an offline resume attempt is CHEAP; a throttled auto-attempt
  cannot hang anything.
- **coreutils IS in the bootstrap** (`generate-bootstraps.sh`: apt, bash,
  coreutils, curl, sed, grep, tar, gawk, …). The real offline gap = EMPTY APT
  LISTS → `pkg install <anything>` = `E: Unable to locate package` until ONE
  successful `apt update`. So "full capabilities" = one successful
  `pkg update` + the coreutils confirm.
- No cleanup ever needed: apt downloads into `lists/partial/` + atomic renames,
  locks are flock-based → a later online `apt update` just works. Never
  `rm -rf var/lib/apt/lists` for network failures.
- The probe idiom (the one `pkg` itself uses; curl is IN the bootstrap):
  `timeout 6 curl --head --fail --connect-timeout 5 "$MIRROR/dists/stable/Release"`.
  Exit 6=DNS, 7=connect, 28=timeout. Default mirror:
  `packages-cf.termux.dev/apt/termux-main` (fallback `packages.termux.dev`).
- RUN_COMMAND with `allow-external-apps` SET + EXTRA_BACKGROUND → silent
  background exec; the notification spam is ONLY the UNSET case (the exact
  shape the v1.20.1 quiet gate already guards). Our recovery fires only
  post-bootstrap → quiet.

## THE LAW

A setup that RAN is a setup that FINISHES. The network may block a step; the
step waits in an honest ledger and completes when the network returns — the
user never has to remember, re-run, or babysit anything. The only manual act
is the user's own choice (the `finish setup now` button).

## THE DESIGN (three phases, ZERO Kotlin changes — everything rides the
existing bridge routes; the state lives in a ledger file the engine reads)

### §v1.35.1 THE PENDING LEDGER — `termux/setup.sh`

- The persistent ledger: `$HOME/.doomalay-setup/state` — one `key=value` line
  per step, written atomically (the script's own mv idiom) as each phase lands:
  `pkgs=ok|pending` · `storage=granted|missing` · `workspace=ok|skipped`.
- Phase 3 (packages): failure → `pkgs=pending` + `resume.sh` is WRITTEN.
  Success → `pkgs=ok` (a stale resume.sh stays — it is idempotent and doubles
  as the manual recovery tool; the banner teaches it).
- `resume.sh` (written by setup.sh; self-contained; the recovery method):
  1. the reachability probe FIRST (the research idiom) — offline → exit 0 in
     seconds, ledger untouched, nothing broken (the engine may fire it often;
     offline it must be a cheap no-op),
  2. only what is pending: `pkg update -y` + `pkg install -y coreutils`,
  3. the workspace mkdir when `~/storage/shared` is live (auto-completable;
     the storage PERMISSION itself is NEVER auto-retried — its dialog is
     interactive),
  4. ledger rewrite (`pkgs=ok|pending`, workspace),
  5. `--checkin <url>` (the caller's fresh URL; the engine passes it; the
     setup bakes its own as fallback default) → the checkin grows `&pkgs=0|1`
     (+ workspace) so the app-side truth stays live. A stale baked URL fails
     silently — non-fatal by the script's own law; the LEDGER is the truth,
     the checkin is only the bell.
- Honest banners: the all-ok completion line is untouched (byte-exact — the
  v1.24.1 rig pins it); the pending run adds its own honest variant.
- The render-demo grows the pending shape so the rigs can drive both outcomes.
- Re-running the one-liner ANY time stays valid: idempotent phases, the ledger
  refreshed, pending steps retried in place.
- Rig: `scripts/v1361-ledger-rig.mjs` — real script runs in a sandboxed HOME
  with stubbed pkg/curl/termux tools: the offline shape (ledger + resume.sh +
  honest banner + checkin pkgs=0), the online resume (pkgs=ok + checkin
  pkgs=1), the offline resume no-op (fast exit, ledger untouched).

### §v1.35.2 THE QUIET FINISHER — engine

- `engine/internal/server/termuxresume.go`, beside termuxapi.go:
  - THE STATE READ: bridge `/run` of
    `echo __doomalay_state__; cat "$HOME/.doomalay-setup/state" 2>/dev/null`
    — marker-law like the probe (no marker → the command never ran → honest
    unknown). TTL-cached + single-flight (the probe-cache pattern), gated on
    `bootstrapDone || propsOK` (THE QUIET GATE extends: zero RUN_COMMANDs
    pre-bootstrap, zero notification-spam risk).
  - THE RESUME EXECUTOR: `POST /api/termux/resume` → single-flight →
    `bash "$HOME/.doomalay-setup/resume.sh" --checkin <fresh st.CheckinURL>`
    (the URL regex-validated engine-side — the PWA's CHECKIN_URL_RE twin),
    a 12-minute budget (slow mirrors get it; offline fails fast per the
    research). The POST starts the executor and answers immediately; the
    UI's existing poll observes `resume_running` / `resume_last_*`.
  - THE THROTTLED AUTO-ATTEMPT: `handleTermuxStatus` sees `pkgs=pending` →
    fires the resume in a goroutine when the throttle allows: 10 min for
    background polls, 60 s for forced fetches (`?refresh=1` — the user's
    explicit moment: the page's check-now tap, the WebView's `online` event).
  - status JSON grows ADDITIVE fields: `pkgs_state` ("ok"|"pending"|""—
    the honest old-script absence), `pkgs_pending`, `resume_running`,
    `resume_last_at`, `resume_last_ok`, `resume_last_error`.
- Go tests on the stub-bridge harness (the /run stdout becomes configurable):
  the ledger parse + marker law, the quiet-gate gating, the throttle matrix,
  single-flight, the resume command composition (URL validation), the additive
  status fields, the old-script (no ledger) = the honest empty state.

### §v1.35.3 THE HONEST READY — PWA (`termuxsetup.js`, the sanctioned
ConnectOverlay page)

- The ready card grows the pending truth: when `pkgs_pending` —
  "packages finish installing when you're back online — this completes
  automatically" + a `finish setup now` button (POST /api/termux/resume →
  force refresh). The card's line updates IN PLACE when the ledger flips
  (the poll keeps watching while pending — the ready latch waits for the
  FULL truth; onReady still fires exactly once at the card render).
- The ladder's status line carries the pending state while the ladder lives;
  the bootstrap row's error slot teaches it (a state, never an error tone).
- The WebView's `online` event force-refreshes the status while the page is
  mounted (killed with the instance — no leaks); the engine's 60s forced
  throttle does the rest.
- Theme vars only; the v1290 companion-app pins hold untouched.
- Rig: `scripts/v1363-pending-ui-rig.mjs` — the pending shapes (_stepStates +
  readyHTML + the online wiring pins + the in-place flip law).

### §v1.36.0 THE SHIP

buildinfo 1.36.0 + the wave record + the full battery (the new rigs + the Go
suite + the regressions: v1241 pulse rig [one documented re-point: the checkin
curl line grows its third honest flag], v1290, v1350 62/62) + the rebase
protocol (download the latest release APK, diff, merge, publish) + tag
`v1.36.0-the-finisher-wave`.

## THE SPAGHETTI LINE (will-NOT)

- NO storage-permission auto-retry — an interactive dialog must never fire
  from a background executor; the ledger records it and the banner teaches it.
- NO full-offline script embedding — the one-liner's curl is Termux's own
  model; the ledger covers the reported shape ("the script ran, the network
  steps failed").
- NO new surfaces (the ready card + ladder already live on the ConnectOverlay
  — a sanctioned surface), NO Kotlin changes (additive checkin params ride the
  existing route; the ledger rides the existing /run).
