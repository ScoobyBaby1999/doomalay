#!/bin/bash
# v1036-doom-projection.sh — RETIRED (v1.04.2): the canvas-projector
# contract died with the module it tested (the user verdict: "the
# current doom projection system u built from scratch honestly is
# entirely broken"). THE RESTORE (the pre-v1.01.5 viewport projection,
# ported) lives in doomprojection.js; its contract rig is
# scripts/v1042-the-restore.sh — this stub forwards to it so the
# battery's name + invocation stay stable.
set -u
cd "$(dirname "$0")/.."
echo "v1036: superseded by v1042 (the restore) — forwarding"
exec bash scripts/v1042-the-restore.sh "$@"
