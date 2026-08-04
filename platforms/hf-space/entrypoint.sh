#!/bin/bash
# Entrypoint for the HF Space Docker container.
# Starts the Go engine (which spawns the Python brain + serves the PWA).
set -e
echo "Starting Doomalay HF Space (app-building machine)..."
echo "  Build tools: gcc, node 20, python 3.11, go, rust, java 17, cmake, qemu"
echo "  Brain: Strands SDK + litellm + all tools + 14 templates"
echo "  Engine: Go binary with embedded PWA"
exec /app/doomalay-engine --port ${PORT:-8080} --bind 0.0.0.0
