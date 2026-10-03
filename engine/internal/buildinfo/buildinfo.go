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
var Version = "0.96.0"   // v0.95.0: THE TRACK 2 WAVE — the transform-carried gradient layers are LIVE (L2_ON defaults true; window.__doomalayL2 = false is the runtime kill-switch for low-memory devices). The v0.94.3 "stacking bug" that kept Track 2 dormant is ROOT-CAUSED AND DEAD — it was self-cannibalization: the epoch RE-MINT (theme flip / gate-CSS injection) snapshotted elements whose own gradient our base rule had already suppressed, minting DEAD layers over suppressed elements; whatever raw background sat behind (the panel root's transform-squeezed fixed gradient, the surviving !important twins) showed through and read exactly like a stacking overrun. Four fixes: (1) THE LIFT-READ-RESTORE in L2.snapshot; (2) !important suppression on the base rule; (3) the INLINE !important suppression (the gate twins reach (0,2,0)+ specificity with their own !important gradients — no attribute rule out-specifies an ID-matched twin; the inline style + !important beats every selector, writeEpoch-stamped observer-invisible, cleared on drop + legacy fallthroughs); (4) contain:paint on overflow:visible bases (the oversized pseudo skirt was extending the transcript scroller 3511 vs 3029px and turning every bubble into a findScroller false positive). Rig-verified: all pseudos alive through a live theme flip, every own background suppressed, scroller parity, header parity 2.4-3.7% (noise), transcript +-1/255 — and the composer strip delta is the layers rendering TRUE windows where the legacy path was already broken (the twin attachment:fixed !important defeated the legacy inline attachment:scroll write). THE RESIZE WAVE: SEL survives resizes (it depends on stylesheets, never viewport size), re-bake + resizeAll + canvas bitmap realloc debounce 150ms (boot stays synchronous). THE PHYSICS WAVE: the O(n^2) pairwise scan retired for a uniform-grid spatial hash (the same broadphase Matter.js/planck use, hand-rolled; 400 entities step in 0.15ms — ~30-60x the old cost at that count; the canvas can now get much more complex for free) + time-scaled integration with <=1-frame substeps (at 60Hz byte-identical; at 30fps the world decelerates at the same rate instead of getting heavier). THE POLLER: webpanel.js's 2s scroll-save interval replaced by real scroll events (500ms debounce, scrollend, re-attached per same-origin navigation). GSAP verdict (re-researched): NOT vendored — the canvas world renders in a dedicated OffscreenCanvas worker where GSAP cannot operate, DOM motion now rides compositor-only transforms, and the measured bottlenecks (DOM build, style recalc, raster) are not drag-math problems. Residue for the next wave (CPU profile attached to PLAN-V094): the panel-open L2 overhead (~+12% busy under 6x — the eligibility probe + scroll-anchoring churn as containment lands mid-rise) + the transcript DOM build (one innerHTML parse). Battery: v092 orbit-rest 13/13, v0911 8/8 + 12/12, v0882 GREEN, v0881 GREEN, v0783 12/12, v088 colors-perf 10/10, theme twins 165, uikit 140.

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
