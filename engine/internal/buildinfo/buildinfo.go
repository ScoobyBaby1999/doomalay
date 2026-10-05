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
var Version = "1.03.0"   // v1.02.0 THE LIBRARY: the .doomtheme v2 ZIP CONTAINER ships end-to-end — export builds the zip (manifest + iconsets via the vendored fflate; v1 JSON folds on read forever), the reader walks THE SECURITY LADDER (size caps that REJECT bomb-shaped bundles, entry-name normalization, the known-entries whitelist, the v1 manifest contract, icon sets through the registry sanitize ladder, the failed-apply rollback), the base64 bridge carries v2 payloads through the text-safe hub pipeline (publish prefill + download-apply). Rig: v1017-doomtheme-v2 11/11. The checkered icon pills + the registry ride the hub (v1.01.5/6). The virtual-core catalogue wiring stays the next wave (the catalogue is PAGE-capped today).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
