#!/bin/bash
# v0918-poll.sh — wait for both spaces to show pm_sidecar in /health
for i in $(seq 1 40); do
  FT=$(curl -s -m 10 "https://scoobybaby1999-doomalay-final-test.hf.space/health" 2>/dev/null)
  SC=$(curl -s -m 10 "https://scoobybaby1999-doomalaysocreate.hf.space/health" 2>/dev/null)
  FTOK=$(echo "$FT" | grep -c pm_sidecar || true)
  SCOK=$(echo "$SC" | grep -c pm_sidecar || true)
  echo "[$i] final-test:pm_sidecar=$FTOK socreate:pm_sidecar=$SCOK"
  if [ "$FTOK" -ge 1 ] && [ "$SCOK" -ge 1 ]; then
    echo "FT: $FT"
    echo "SC: $SC"
    echo "BOTH DEPLOYED"
    exit 0
  fi
  sleep 25
done
echo "TIMEOUT"
exit 1
