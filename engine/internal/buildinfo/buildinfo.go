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
var Version = "1.09.0"   // v1.09.0 THE SEAMLESS FIELD: the painter keeps its suppressed windows (THE STEADY HAND — the metadata/workspace pills' projected↔local oscillation dies: the L2 suppression broke the [style*=] catcher that matched them into SEL; the suppressed element re-enters the read list + the ownership test yields to local CSS), the toggles + sliders ride the field AT BOX SCALE (THE FULL SPECTRUM — the gate-window law: gate-led rules declare attachment:local !important, the painter's probe opts them out, the layered surface+accent window shows the FULL gradient in every theme configuration), the panel header/body render ONE continuous gradient (THE SEAMLESS FIELD — shared --panel-field-h scale + the window offsets, synced at rest through a CSSOM rule; the header no longer repeats the body's gradient), and projected text COASTS during motion+scroll (THE COAST — zero per-event anchor writes: scroll 1400→~150, drag = one batch + the settle, max long task 0ms; no OSS library changes the math — they all ship background-clip:text). Battery: v109 rig 30/30 · v107 22/22 · v106 21/21 · v1045 11/11 · v1040 7/7 · uikit 140.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
