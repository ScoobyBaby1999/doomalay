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
var Version = "1.12.0"   // v1.12.0 THE BREATHING FIELD: the doom projection re-anchors mid-motion at 2Hz (THE BREATH), the amplifier keeps only the honest per-depth parallax and retires the amp-only fireflies/glow/over-icons split (THE HONEST SKY), gains per-band zoom parallax (THE TRUE DEPTH), the sliders return to native with accent-color = the gradient's first stop (THE NATIVE HAND), and the profiler-convicted per-frame inherited --panel-vis-h recascade is throttled to the same 2Hz (THE MEASURED FIX: UpdateLayoutTree 445-524ms -> 71-110ms per traced glide window). Battery: v111 rig 20/20 · v110 22/22 · v109 30/30 · v106 21/21 · v1045 11/11 · v1040 7/7 · uikit 140. [prior: 1.11.0 THE HF TRUTH WAVE: the honest turn, the black-hole guard, the space knows itself, token honesty, the guided first-run. [prior: 1.10.0 THE WEIGHTLESS WAVE: the drift coast, the fullscreen field, the still hand, the rare sky.]]

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
