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
var Version = "1.14.0"   // v1.14.0 THE MCP WAVE (PLAN-V113, six phases): mark3labs/mcp-go is the tool system end to end — the mcpbus (28 tool Defs as the single source of truth, in-process client, Observer hooks, THE CONTAINED PANIC), every tools-capable provider runs the native tool_calls loop against it with the OpenRouter web plugin as the blacklisted fallback (THE THIRD CARRIER), the ACTION text protocol is DELETED on every path (engine ReAct, engine native, PM browser — ~2,000 lines of parser glue gone), external MCP servers chain onto the bus over stdio + streamable HTTP (the 100+ tools horizon: any server, one calling convention) and /mcp serves external consumers the same registry (the PM bridge's browser loop speaks it natively). v1.13.6 THE REDTEAM: 67-check adversarial rig (deterministic stub personas + the 100-tool mcpdemo fault fleet) convicted two engine bugs, both fixed + pinned: the honesty line's execution side (a cut/malformed call emitted "NOT executed" then executed anyway — Skip/SkipText makes the fault text the tool's answer) and the openrouter plugin-first routing that starved its turns of the bus. Battery: rig 67/67 · v1135 12/12 · v0817 14/14 · v0822 11/11 · v0823 15/15 · llm · server · mcpbus -race · live 19/19 (nemotron). [prior: 1.12.0 THE BREATHING FIELD: the doom projection re-anchors mid-motion at 2Hz (THE BREATH), the amplifier keeps only the honest per-depth parallax and retires the amp-only fireflies/glow/over-icons split (THE HONEST SKY), gains per-band zoom parallax (THE TRUE DEPTH), the sliders return to native with accent-color = the gradient's first stop (THE NATIVE HAND), and the profiler-convicted per-frame inherited --panel-vis-h recascade is throttled to the same 2Hz (THE MEASURED FIX: UpdateLayoutTree 445-524ms -> 71-110ms per traced glide window). [prior: 1.11.0 THE HF TRUTH WAVE: the honest turn, the black-hole guard, the space knows itself, token honesty, the guided first-run.]]

// Dev reports whether this is a DEV build (v0.48 task 5): local builds
// (default Version carries "-dev") or an explicit DOOMALAY_DEV=1. Release
// builds stamp a clean tag via -ldflags, so the flag is off in production.
// Dev builds unlock developer-only surface (e.g. the cloud-providers
// "use public key" pill).
var Dev = strings.Contains(Version, "-dev") || os.Getenv("DOOMALAY_DEV") == "1"
