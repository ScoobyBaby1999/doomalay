// Package buildinfo carries the engine version.
//
// The default is a sensible fallback for local/dev builds; release builds
// override it at link time (all three CI workflows do this):
//
//      go build -ldflags "-X github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo.Version=v0.30.1" ./cmd/doomalay
//
// /api/health and /api/capabilities report this value, so the API always
// answers with the real release tag instead of a constant that silently
// drifts (the v0.28.0 red-team found "0.1.0" on a v0.28.0 build).
package buildinfo

import (
        "os"
        "strings"
)

// Version is the engine version string (overridable via -ldflags).
var Version = "1.18.0"   // v1.18.0 THE TERMUX WAVE (PLAN-V117, five phases): THE PIVOT — the sandbox picker dies; new chats are quick by birth (engine-side default too — API clients that omit the field get quick), the gatelock is ONE required box (the model) + ONE optional box (+ capabilities), and the CAPABILITY LIBRARY replaces the picker: a compact stackable-row overlay (web search / deep research / library / skills / templates toggles + persona / workspaces pickers + the APK-only Termux row with its live setup state) — legacy HF sessions still render, no new HF chats are creatable; the session gains the termux capability column (inert this wave by spec). THE BRIDGE — the Kotlin Termux intent layer + the loopback engine bridge: com.termux.permission.RUN_COMMAND + the queries visibility block, TermuxBridge.kt (the RUN_COMMAND sender with per-command one-shot MUTABLE PendingIntents + result Bundles, the honest installed/version/permission ladder, the probe, the open-intents), TermuxBridgeServer (token-authed loopback HTTP on 127.0.0.1:8081 — status/probe/run/act), the engine --termux-bridge flag + termuxbridge client package + GET /api/termux/status (probe cached 30s, refresh=1, honest ladder, never a 500) + POST /api/termux/act; the APK CI compiles the Kotlin green. THE SETUP — the first turn of Termux, as close to one-click as Termux security model permits (three taps: install, one pasted command, one permission): termux/setup.sh in the repo (the curl bootstrap — allow-external-apps + termux-reload-settings + termux-setup-storage + coreutils + the ~/storage/shared/Doomalay workspace), the setup overlay page with live 3s-poll step cards that auto-advance install -> bootstrap -> permission -> verify -> READY, the Done pop-back to the library. THE LIVE UPDATE — delta OTA: only what changed, never the whole APK (patch-manifest.json from the release, sha256-verified atomic downloads to filesDir/ota, the ota-first static overlay serves patched bytes with NO engine restart, the PWA banner with optional Update -> applied -> reload, min_engine = the honest full-APK wall, CI generates + uploads the manifest). THE REDTEAM — the 108-check rig (fake bridge + fake OTA against the live engine) + the agent-browser real-user E2E (zero console errors): convicted + fixed the quick-by-birth engine gap, the undefined renderTypePills that killed the chat panel render in the real browser while source rigs stayed green, the lost pre-session capability stack (the icon.caps stash — stacked caps survive reloads), the late pill repaint; docs/TERMUX-DEVICE-TEST.md carries the honest real-device checklist (the com.termux RUN_COMMAND round-trip needs real hardware). Battery: rig 108/108 + v1171 65/65 + v1173 76/76 + v1174 55/55 + v1151 19/19 + Go server/store/ota/termuxbridge/config/mcpbus + llm + linux+android builds. [prior: 1.16.0 THE CHOICE WAVE, 1.14.6 THE SOLID STREAM, 1.14.x THE HONEST ENGINE, 1.14.0 THE MCP WAVE, 1.12.0 THE BREATHING FIELD, 1.11.0 THE HF TRUTH WAVE.]

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
