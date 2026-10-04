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
var Version = "0.98.1"   // v0.98.1 THE CATALOGUE & SHEETS POLISH WAVE (the remaining open items of the user's 8-issue batch; 4-8 closed by the parallel waves v0.91.5-v0.95.4). ISSUE 1 THE SINGLE X - modelbrowser's own #mb-close is GONE (ConnectOverlay's static #connect-overlay-x owns the close on every instance; the header row pads its right edge 34px so the tab group never renders underneath) + THE AUTO-REFRESH - every browser open revalidates the catalog in the background (SWR; the first-open-only rule left a mid-session key save invisible until a manual resync) and every providers.js key-save success (manual save + public-key install) dispatches doomalay:catalog-changed which busts the localStorage modelcache.v1 + the quick-switch quickCat so the next open re-fetches (rig-proven: key saved -> cache gone -> reopen auto-syncs, no manual resync). ISSUE 2 THE THEMED LOADER - the workspaces picker + the connect page's repos box render the themed loader (accent-colored label via var(--accent), the primary sweep bar - accent-rgb gradient on an accent-tinted track, the same recipe as the chat's .cwk-bar - and a tabular-nums live elapsed counter; startLoader self-clears its interval the moment the counter leaves the DOM so overlay navigations never leak timers; the loader leaves when the list resolves). ISSUE 3 THE SHEET DRAG-DOWN - the artifacts drawer/editor head is a drag handle (wireSheetDrag: pointer capture, button exclusion so taps on X/tree controls stay theirs, 8px slop, rigid finger-follow with the transition frozen, commit past 25%/160px or a ~0.5px/ms downward fling - gesture.js's own thresholds, the SAME dirty-check guard the X uses blocks dismiss on unsaved editors, else a 105% dismiss slide + spring-back). .art-head touch-action:none. Rig v0981: single-X, SWR+cache-bust, loader present+accent+sweep+ticking+cleanup, synthetic drag dismisses + springs back + button exclusion, zero console errors. Battery: go test ./... ok.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
