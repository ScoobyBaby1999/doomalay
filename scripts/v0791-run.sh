#!/bin/bash
# v0791-run.sh — start the engine + run the rig in ONE process group
# (the sandbox kills background survivors between tool calls).
cd "$(dirname "$0")/.."
PORT="${1:-8790}"
pkill -f "doomalay-engine --port $PORT" 2>/dev/null
sleep 1
./engine/bin/doomalay-engine --port $PORT --data-dir /tmp/doomalay-v0791-data --open=false > /tmp/engine-v0791.log 2>&1 &
ENG=$!
for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -s "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  echo "ENGINE FAILED TO START:"; tail -5 /tmp/engine-v0791.log; kill $ENG 2>/dev/null; exit 2
fi
shift 2>/dev/null
"$@" "scripts/v0791-theme-perf-test.py" $PORT
RC=$?
kill $ENG 2>/dev/null
exit $RC
