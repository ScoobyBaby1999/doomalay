# Doomalay

A sovereign self-hosted AI workspace with maximal capability.

## Architecture

```
Go Engine (universal runtime) + Python Brain (Strands agent, full tools)
+ PWA (spatial canvas, physics-driven chat icons)
```

**PrivateMode is engine-native** (v1.44, PLAN-V144): PM chat turns ride
the engine's own E2E-encrypted wire — `engine/internal/pm` vendors the
MIT-licensed half of Edgeless's pure-Go client (PROVENANCE.md records
every delta), the engine pins the deployment's mesh CA (TOFU, upgraded
to verified by the one-shot WASM oracle at PM connect — the only thing
licensed to run Edgeless's BSL-1.1 attestation verifier is their own
MIT-distributed wasm artifact, `web/vendor/pm/`), and the WebView SDK
bridge is the oracle ONLY — no PM turn runs in the web layer. The
co-located brain rides `POST /api/pm/local/v1/chat/completions`
(api-key-fallback=never).

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
