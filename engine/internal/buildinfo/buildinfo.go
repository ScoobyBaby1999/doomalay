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
var Version = "1.08.0"   // v1.08.0 THE SELECTIVE FIELD (the canvas-opt wave shipped v1.07.0 ahead of us — the ledger shifts): the projection becomes selective — the surface exempts itself (the user's lag call: the panel body + overlay card were the viewport-sized, most-rebaked windows), the fmt TEXT field joins (fixed+clip:text, both legs), the Layer-3 CHROME follows locally (sliders · switch tracks · the tiny pills — zero painter cost, the surface var is out of the allow-list), the metadata pills' OWN inline tint is owned again (THE OWNERSHIP LAW — the painter strips only what it painted; the author's background is saved at suppression and restored at drop — the white-pill report dead), the doom projection switch flips live (no settings reopen), and the SHADOW + HIGHLIGHT tokens become editable theme slots (the Colors tab rows seed from the derived values). Battery: v107 rig 22/22 · v106 21/21 · v1045 11/11 (the on-disk doctrine) · v1040 7/7.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
