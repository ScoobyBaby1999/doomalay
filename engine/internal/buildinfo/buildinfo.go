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
var Version = "1.01.0"   // v1.01.0 THE ASSETS WAVE (phase 1+2): the assets vendors (fflate 0.8.3 MIT + maxrects-packer 2.7.3 MIT + material-color-utilities 0.4.0 Apache-2.0 — all browser-verified, zero page errors) + THE IMAGE→PALETTE SUGGESTER (the canvas picker: pick an image → MCU sourceColorFromImage → SchemeContent dark-first → the 6-swatch proposal → apply writes the seven fields; rig 7/7 end-to-end with a real file upload; culori OKLCH stays the one runtime truth — MCU is generation-time only). The field atlas, the 9-slice/icon registry and the .doomtheme v2 zip container carry forward per PLAN-V101.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
