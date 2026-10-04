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
var Version = "1.00.0"   // // v1.00.0 THE MASKS WAVE — THE POSITIVE LIST (the 6th #sheet-root death, at the root: the canvas input owns ONLY #c + #chatbots, every body-appended overlay gets native taps — rig-proven both directions, Playwright hasTouch) + the sticky-head popover fix + touch-action: manipulation; THE GRADIENT-TEXT TIERS (PART E: text goes LOCAL-BOX, the fixed illusion stays the object track's; zero projection, zero longtasks on drag); THE PHANTOM PURGE (the painted-set hygiene — image-none riders leave the set; the legacy-bake retirement proven: every visible painted element rides L2); THE WINDOW ENGINE vendored (@tanstack/virtual-core 3.17.11 — wiring = its own wave); THE CHEAP CONSOLIDATIONS (toast ×8 → DoomToast, keys.js rides the Overlay — the last hardcoded rgba scrim dies, localmodels double-✕ gone, the amber ts-star themed). The real-touch rig (v1000) catches the class mouse rigs are structurally blind to; the embed-cache gap documented (rigs build -a).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
