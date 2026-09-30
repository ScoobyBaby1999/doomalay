#!/bin/bash
# v0783-run.sh — engine + NVIDIA key + the v0.78.3 panel-perf rig, one group
cd "$(dirname "$0")/.."
PORT=8792
pkill -f "doomalay-engine --port $PORT" 2>/dev/null
sleep 1
./engine/bin/doomalay-engine --port $PORT --data-dir /tmp/doomalay-v0783-data --open=false > /tmp/engine-v0783.log 2>&1 &
ENG=$!
for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 0.5
done
# arm the NVIDIA key (the stream test is a REAL model turn)
NVIDIA_KEY=$(grep NVIDIA_KEY /home/z/my-project/.credentials | cut -d= -f2)
curl -s -X POST "http://127.0.0.1:$PORT/api/keys" \
  -H 'Content-Type: application/json' \
  -d "{\"provider\":\"nvidia\",\"env_var\":\"NVIDIA_API_KEY\",\"key\":\"$NVIDIA_KEY\"}" | head -c 200
echo
python3 scripts/v0783-panel-perf-test.py $PORT
RC=$?
kill $ENG 2>/dev/null
exit $RC
