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
var Version = "0.94.0"   // v0.94.0: THE INTERACTION WAVE part 1 — the perf wave aimed at the user's live lag report (smooth while still; laggy only during POINTER interactions). Measured on the new 6x-CPU-throttled BlackView-class rig (scripts/v094-interaction-profile.py): (1) THE CANVAS INPUT COALESCER — touchmove/pinch/wheel render once per rAF, not per digitizer event, the finger owns the camera during PANNING (tick no longer double-integrates velocity); (2) THE POKE RETIREMENT — DoomProjection.poke() is gone from update() (a stale v0.67 relic: v0.92.1 evicted .chatbot roots, so every canvas pan paid ~100-selector walks + a gBCR per painted window to write NOTHING — rig: 479 paints per 4.6s pan -> 0); (3) THE WORLD-ANCHORED LATTICE COLORS — dot/line colors sample in parallax-world space keyed by world cell (the param caches' own space), so pure pan/zoom NEVER re-derives colors (rig: 946,076 cache misses per pan -> 662; at-rest pixels identical); (4) THE TYPING FIX — the autogrow only writes height when it actually changes (no more forced O(message-length) reflow + style writes per keystroke), SendMode.sync skips the innerHTML rewrite when mode+actionable are unchanged, and the sm-busy clear is contains-guarded (the unconditional classList.remove of an absent token still fired a no-op class mutation record -> one FULL projection paint per keystroke; rig: 436 paints per 630-char draft -> 24, typing fps 36 -> 50 = the 6x-throttled ceiling). Track 2 (the transform-carried gradient layers for the panel-drag raster storm — the repo's own RESEARCH-V092 endgame) is implemented in theme.js's L2 module with verified geometry (every audited layer's field origin = viewport origin) but DORMANT behind L2_ON=false pending a DevTools stacking-interaction debug (a later sibling's oversized layer paints over earlier elements' boxes); flip it on next wave. Net on the rig: canvas pan at the fps ceiling with ZERO projection paints, typing at the ceiling with 24 paints, panel-drag maxGap 247->196ms; the visual parity gate vs v0.93.3 passes (mean 0.54/255, 0.75% of pixels — a 73px composer-row init difference).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
