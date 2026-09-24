---
title: Doomalay Sandbox
emoji: 🤖
colorFrom: indigo
colorTo: purple
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
---

# Doomalay Sandbox (auto-created by the Doomalay app)

This Space was created automatically through the Doomalay app's
**HF chat** sandbox flow. It hosts the Doomalay brain — a full agent
runtime with real bash, python, git and a build toolchain — on free
ZeroGPU hardware.

- Chat protocol: `POST /chat` (SSE) — called by your Doomalay engine
- Auth: `X-Space-Token` (minted by your engine at create time)
- Status UI: `/ui`
- ZeroGPU: the GPU is a startup shape-check only — chats never consume
  GPU quota

Workspaces are per-chat, scoped server-side, and ephemeral (the Space
sleeps after ~48h idle and storage is not persistent on the free tier —
download artifacts you want to keep).
