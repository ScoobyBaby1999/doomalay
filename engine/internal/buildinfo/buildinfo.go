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
var Version = "0.98.0"   // v0.98.0 THE FINISH WAVE: THE ZOOM FIX - the tile pair derives from the budget + params at a REFERENCE spacing, never from the zoom (all bake geometry is world-proportional so the mid-gesture ps stretch is exact and rebakes never pop; rebakes trigger on a 1.25x raster quantum (sharpness only); heroes are baked-stable with bake-time layer assignment; fpNow drops scale; rig v098-zoom-stability 10/10 - the pair (10,16,80) identical across 1x/2.14x/0.75x, world centroids match, bakeGen advances). THE TILING KILL - PARITY PERIOD-INTERLEAVE: dots split by world parity (even cells layer A at M_A, odd layer B at M_B; both even); joint period = lcm(M_A,M_B) cells = 80 cells = 3840px at the default pair - wider than any phone screen; fill count UNCHANGED (the animDots checker groups ARE the parity layers); lines interleave by column/row parity; colors sample an identity window (no mirror); budget 40->96MB with the raster shrinking before the pair ladder drops; rig v098-tiling-period 13/13 (paintMs 0.4ms, defaults exactly 2 dot tiles). THE PANEL: C1 POS_SEL - one native querySelector sweep replaces the per-descendant getComputedStyle walk in L2.ok(); C2 the mint decision (okv) computes in the read phase - the write phase never reads (the colors-tab mount stall + the black-flash window); C3 LAZY EDITORS - collapsed color rows build their GradientUI editor on FIRST expand (the Colors tab mounts 289 nodes, was ~979, 0 longtasks); C4 #proj-layer-styles joins the observer style-exclusion list; C5 hydrateAccounts 60s cache; C6 settings close wipes the heavy body after the animation; rig v098-panel-colors 21/21. Battery: v097 oneobject 29/29, v092 orbit-rest 13/13, v0911 native-layer3 12/12, theme twins 165/165, uikit 140/140.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
