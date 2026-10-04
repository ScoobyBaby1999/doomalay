#!/bin/bash
# v1000-touch-tap.sh — THE REAL-TOUCH RIG wrapper (v1.00.1 gate).
#
# The #sheet-root class (six recurrences, phone-only: canceling
# touchstart suppresses the synthetic click — W3C Touch Events L2 §9)
# was invisible to every mouse-driven rig. This wrapper boots the
# engine and runs the Playwright hasTouch rig (real CDP touches).
#
# ALWAYS rebuilds with -a: the Go build cache does NOT invalidate on
# embedded-file changes (measured: stashed web/app.js → fresh go
# build → binary still served the OLD assets — golang's embed+cache
# gap), so a build-if-missing wrapper would silently run stale rigs.
#
# Usage: scripts/v1000-touch-tap.sh
# Env:   PLAYWRIGHT_PATH=<node_modules dir with playwright> (optional)
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8414
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1000touch

echo "building engine (forced -a; embed cache gap)…"
(cd engine && PATH="$PATH:$HOME/.local/go/bin:/usr/local/go/bin" go build -a -o "$ENG" ./cmd/doomalay) || { echo "BUILD FAIL"; exit 1; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v1000t-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 120); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

node scripts/v1000-touch-test.mjs "$BASE"
RC=$?
exit $RC
