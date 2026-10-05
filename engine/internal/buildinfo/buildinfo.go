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
var Version = "1.05.0"   // v1.05.0 THE DISCIPLINE WAVE: the two standing UI rules made self-enforcing. THEME: --shadow-ink joins the field model (shadows are derived theme products — a themed canvas casts tinted shadows; light themes read soft ink-gray per the M3 finding), the 37-literal shadow sweep (exact-alpha parity; the JS stragglers + the WCAG ink-on-art upgrade in hub.js), DoomTheme.FALLBACKS (the one literal owner for pre-apply paints) + LEGACY_GRID exposed (the sentinel owner — resets return to theme-following, never pin a hex). SURFACE: docs/DISCIPLINE.md (the canonical-zone table, the surface ledger incl. the artifacts-sheet-variant decision, the z-ladder). ENFORCEMENT: scripts/v1040-discipline-audit.sh (7 static gates — the two rules fail builds now) + v1042/v1043/v1045 rigs (CSS≡JS parity, the live discipline proof — a canvas drag re-tints shadows; the human-imitation red-team 11/11 on both theme polarities). Battery: v1031 16/16, v098 24/24, twins 199, uikit 140, go green.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
