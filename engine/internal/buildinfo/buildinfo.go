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
var Version = "0.93.5"   // v0.93.5: THE REPO-CREATION WAVE — kind=hf lives (the "kind must be GitHub|gitea|gitlab" error is dead): the TYPE-FIRST HF create (space/dataset/model/STORAGE BUCKET — buckets via their own Xet API, spaces carry sdk, license rides the hub's real 83-key enum), GitHub licenses render key—Name pairs and load on EVERY form open (the async race behind "license stays none"), gitignore options are the real 161-template list (verified: LICENSE + .gitignore land on the fresh repo), and hfDeleteFile rides the NDJSON deletedFile op (the "this forge does not support that operation" delete error is dead — live-proven on a real dataset). The workspace create tool + the brain hf tool (bucket_create/buckets) can create every kind on the user's behalf, and the fresh repos land as FULL-access workspaces (the pill count climbs).

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
