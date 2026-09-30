#!/bin/bash
# rebuild the engine (embeds engine/internal/server/web) + restart on :8099
cd /home/z/doomalay/engine
export PATH=$HOME/.local/go/bin:$PATH
pkill -f doomalay-engine-test 2>/dev/null; sleep 0.3
go build -o doomalay-engine-test ./cmd/doomalay || { echo BUILD FAIL; exit 1; }
rm -rf /tmp/dv79; mkdir -p /tmp/dv79
setsid nohup ./doomalay-engine-test -open=false -port=8099 -data-dir=/tmp/dv79 > /tmp/v79-eng.log 2>&1 < /dev/null &
for i in $(seq 1 60); do curl -s http://127.0.0.1:8099/api/health >/dev/null 2>&1 && { echo "engine up"; exit 0; }; sleep 0.25; done
echo "BOOT FAIL"; tail -5 /tmp/v79-eng.log; exit 1
