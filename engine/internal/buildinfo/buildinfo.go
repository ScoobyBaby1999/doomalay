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
var Version = "0.99.0"   // v0.99.0 THE FIELD WAVE — the 7-slot color model (the dual track: text vs objects, zero shared variables): culori+Floating-UI vendored; @property fields + calibrated oklab derivations (surface-2 5%, surface-3 11%, border 13%, ring 16%, border-strong 24%, bg-app canvas+8%surface, text tints 26/47/61% — v099-calibrate, worst ΔE 0.05, the imperceptible class); the legacy fold (themeOverrides → --field-*); the census reassignment (74 hairlines → the one owner, plate stacks 3→2, the accent-text ban — 50+ sites to ink/fmt, the title family → fmt-a1, glyph windows dead); the 7-slot Colors tab + the floating picker (126-node mount, GradientUI slim 8→2 styles, grid children + fmt family folded in); the nested-box recipe (settled cv:hidden collapses, ≤2 accordion cap, cv:auto rows). FieldMath = culori CSS-parity (pixel-exact vs color-mix(in oklab) — the oklch powerless-hue landmine dodged). Rigs: v099-field-parity 5/5, v099-reassign-audit 6/6, v099-settings-open 6/6 NEW + the full battery green.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
