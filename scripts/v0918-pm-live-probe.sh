#!/bin/bash
# v0918-pm-live-probe.sh — run the REAL app PM path end-to-end:
# engine (key seeded) + agent-browser on the app origin + PMBridge.streamChat
# (the vendored v1.55 SDK: verify → refreshSecret → encrypted chat turn).
# This is exactly what a user's PM chat turn does — the honest diagnosis for
# "privatemodeai not having any access".
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=8521
DATA=/tmp/doomalay-v0918-pm
BASE=http://127.0.0.1:$PORT
export AGENT_BROWSER_SESSION=v0918-pm

PMKEY="$(grep -oP '(?<=PRIVATEMODE_KEY=).*' /home/z/my-project/.secrets)"

rm -rf "$DATA"
"$ENG" --port $PORT --data-dir "$DATA" >/tmp/v0918-pm-engine.log 2>&1 &
ENGPID=$!
trap 'kill $ENGPID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null "$BASE/api/health" && break; sleep 0.3; done
echo "engine up (pid $ENGPID)"

curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
  -d "{\"env_var\":\"PRIVATEMODEAI_API_KEY\",\"provider\":\"privatemodeai\",\"key\":\"$PMKEY\"}" | head -c 120; echo

# the real-user browser pass on the app origin (the SDK is same-origin here)
agent-browser open "$BASE/" >/dev/null 2>&1
sleep 3
echo "== PMBridge probe (the production path) =="
timeout 150 agent-browser eval "
(async () => {
  try {
    const r = await window.PMBridge.streamChat({
      model: 'glm-latest',
      messages: [{role: 'user', content: 'Reply with exactly: ACCESS OK'}],
      onStatus: (s) => console.log('[status]', s)
    });
    return JSON.stringify({ok: true, text: (r.text||'').slice(0,200), usage: r.usage});
  } catch (e) {
    return JSON.stringify({ok: false, name: e.name, isPM: !!e.isPM, msg: String(e.message||e).slice(0,400)});
  }
})()
" 2>&1 | tail -3
