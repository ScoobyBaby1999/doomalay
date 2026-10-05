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
var Version = "1.01.6"   // v1.01.6 THE ICON REGISTRY + ATLAS + 9-SLICE: swappable icon sets as DATA (the Iconify-JSON import format — sanitize ladder: tag/attr whitelist, script bodies drop, url() refs strip; sets persist capped), IconLib renders through the layered lookup (active set > builtin Lucide — zero call-site changes), DoomAtlas.pack (vendored maxrects — one texture, zero overlaps, deterministic; rig-proven), DoomChrome 9-slice (DOM border-image + the radius-safe mask split; the Pixi NineSliceSprite twin), the Settings·General Icon Set section. Rig: v1016-icon-registry 19/19.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
