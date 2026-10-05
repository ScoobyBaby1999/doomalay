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
var Version = "1.01.5"   // v1.01.5 THE LOCAL LIGHT: background-attachment:fixed RETIRED from the object track (the two-hidden-gradient-fields split + the Chromium slow path — docs/RESEARCH-V102-LOCAL-LIGHT.md), the 1300-line DoomProjection painter DELETED (the browser compositor replaces it), THE THEME EVENT ('doomalay:theme-applied', coalesced — never dispatched before: stale canvas icons), the self-colored theme chips (raw hexes, never white), the checkered library pills (positional accents 1-2-3), the overlay screens + the chat-icon name pills ride the SURFACE, the canvas chrome pills (#settings-btn + dock) follow the surface gradient. Rig: v1015-local-light 15/15 (zero fixed elements, zero longtasks, locked 60fps drags).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
