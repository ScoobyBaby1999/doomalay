# HF Space — App-Building Machine

A pure-backend Docker container on Hugging Face Spaces. Full build toolchain
+ Strands SDK + Go engine. Can compile web/mobile/Python/Go/Rust apps.

## What it can build
- Web apps (React, Vue, Svelte — npm run build)
- Python packages (pip wheel)
- Go binaries (go build)
- Rust binaries (cargo build — small/medium)
- Android APKs (gradle build, no GPU emulation)
- Static sites, CLI tools, shell scripts

## What it can't build
- Unreal Engine (needs 32GB+ RAM + GPU)
- KVM VMs (no /dev/kvm in Docker)
- Docker images (no docker-in-docker)
- GPU compute (CUDA, ML training)

## Setup
1. Create a new HF Space with SDK=docker
2. Copy the Dockerfile + brain/ + engine/ to the Space repo
3. Set HF secrets: provider API keys (optional — users bring their own)
4. The Space URL becomes the engine URL users connect to

## Capabilities reported
```json
{
  "canChat": true,
  "canBuild": true,
  "canShell": true,
  "hasGPU": false,
  "hasKVM": false,
  "type": "hf-space"
}
```
