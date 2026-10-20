# Doomalay

A sovereign self-hosted AI workspace with maximal capability.

## Architecture

```
Go Engine (universal runtime) + Python Brain (Strands agent, full tools)
+ PWA (spatial canvas, physics-driven chat icons)
```

**PrivateMode is engine-native** (v1.44 PLAN-V144, v1.45 PLAN-V145, v1.46
PLAN-V146): PM chat turns ride the engine's own E2E-encrypted wire —
`engine/internal/pm` vendors the MIT-licensed half of Edgeless's pure-Go
client (PROVENANCE.md records every delta), the engine pins the deployment's
mesh CA (TOFU; PM chats work on the pin with ZERO wasm), and the engine's
PM client dials through `netx` like every engine outbound (v1.45.1 — the
Android DNS fix; the vendored Go-default dialer was the one that died on
real devices). The ONLY thing licensed to run Edgeless's BSL-1.1 attestation
verifier is their own MIT-distributed wasm artifact (`web/vendor/pm/`), and
it runs STRICTLY on demand (v1.45.4 — the provider card's explicit "verify
attestation" button; nothing loads wasm automatically, at connect or
anywhere else). Net honesty (v1.45.2): a single provider being unreachable
while others work is reported as THAT provider being down ("your
connection is fine") with a bounded hold, never a fake "network
unreachable" — the infinite patient-engine wait stays reserved for true
device-offline shapes. The co-located brain rides
`POST /api/pm/local/v1/chat/completions` (api-key-fallback=never).
Reasoning honesty (v1.46): PM's gateway (vLLM 0.31) emits every reasoning
delta in BOTH wire spellings (`reasoning` + `reasoning_content`,
byte-equal — the rename compat shim); the engine's alias law
(`mergeWireReasoning`) merges the pair into ONE copy so PM-native thinking
streams clean (the "every word appears twice" bug), and the provider's own
`reasoning_tokens` share of the completion rides the usage ledger end-to-end
(the 🧠 stat on the usage panel).

## Structure

```
doomalay/
├── engine/          # Go — HTTP/WS, SQLite, secrets, sandbox
├── brain/           # Python — Strands agent, templates, panel, tools
├── app/             # PWA — Vite + React 19 + PixiJS + Matter.js
├── platforms/       # Platform-specific files
│   ├── android/     # Kotlin + Chaquopy APK
│   ├── windows/     # NSIS installer (future)
│   ├── linux/       # AppImage (future)
│   ├── macos/       # .dmg (future)
│   ├── ios/         # PWA-only (future)
│   └── hf-space/    # Docker (app-building machine)
├── docs/
└── scripts/
```

## Quick Start

```bash
# Setup brain (one-time)
cd brain && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Build + run
make build-engine
./engine/doomalay-engine
# Opens http://localhost:8080
```

## Dev

```bash
make dev  # 3 terminals: engine, brain, PWA hot-reload
```

## Platforms

| Platform | Build | Download |
|---|---|---|
| Android | `make build-apk` or CI | GitHub Releases (.apk) |
| Windows | CI | GitHub Releases (.exe) |
| Linux | CI | GitHub Releases (AppImage) |
| macOS | CI | GitHub Releases (.dmg) |
| HF Space | `make build-hf-space` | Docker image |

See `docs/` for platform-specific setup guides.
