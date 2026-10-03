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
var Version = "0.97.0"   // v0.97.0 THE CANVAS WAVE + C3: the one-object lattice is LIVE - every parallax band renders as ONE pattern fill (baked per-band tiles: all dots act as two objects (checker-parity groups breathing in counter-phase), all segments as one; full-line mode stays immediate at <=2 fills; hero fireflies = the few glow-candidate cells drawn live; colors mirror-fold at tile granularity for seamless repetition; segments draw wrapped; 40MB memory budget with M-shrink degradation). The per-frame lattice cost goes from O(visible cells) (~1,100 dots + ~2,900 segments per frame) to O(fills) (~3-15). TEMPO 0.5 (lattice animT + AtomCore star/orbit time at half speed; physics and TabGroups omega untouched), the ambient cadence gate (ambient-only lattice frames at ~15fps, stars keep 60fps), zoom/params rebakes debounced 150ms (the worker bakes, main never pays). renderLegacy kept verbatim as the runtime fallback + A/B switch (window.__doomalayLatticeLegacy). C3 THE SPLIT TRANSCRIPT RENDER: the panel open mounts the last 30 messages (renderMessages tail slice), older history prepends in idle 80-message chunks scroll-compensated, the WS replay burst coalesces scrollBottom to one per rAF (was one forced layout per replayed message), jump-to-event/find flush the pending head on demand (ensureTranscriptMounted).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
