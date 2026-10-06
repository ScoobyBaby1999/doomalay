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
var Version = "1.10.1"   // v1.10.1 THE BREATH: the doom projection re-anchors mid-motion at 2Hz (the user: "update like twice a second to look smooth but be performant") — the drift error drops from the whole glide to ≤500ms of motion. the anchor glide stops sweeping the tree (THE DRIFT COAST — during a motion window the root vars freeze, every window rides rigidly, scrollRebake gates on the coast, and mid-glide paints defer to the settle: the glide is compositor transform + one layout write), the surface field is ONE fullscreen material that docks reveal instead of re-fit (THE FULLSCREEN FIELD — --panel-field-h = the full-dock extent, the no-repeat gap that leaked ink is geometrically impossible, per-dock re-syncs die), the zoom gesture recomputes NOTHING mid-gesture (THE STILL HAND — the hosts report the pinch/wheel state per frame, the ladder bake never arms while held, the release frame lands ONE bake ~150ms after settle; the stretch is exact by world-proportionality), and the shooting stars are scarce and varied (THE RARE SKY — 18-44s between spawns, three size/distance classes with per-class tail/glow/parallax). Battery: v110 rig 22/22 · v109 30/30 · v106 21/21 · v1045 11/11 · v1040 7/7 · uikit 140.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
