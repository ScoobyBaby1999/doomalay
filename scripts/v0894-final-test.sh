#!/bin/bash
# v0894-final-test.sh — THE FINAL TEST (v0.89.4). Phase A: engine + keys +
# the ZeroGPU test space, then the real-user browser session that drives
# both chats. Long-running: the space build takes minutes; the HF turn
# runs dozens of tool calls.
#
# Usage:
#   bash scripts/v0894-final-test.sh setup     # boot + keys + create space
#   bash scripts/v0894-final-test.sh status    # space build/status
#   bash scripts/v0894-final-test.sh hfturn    # create the HF chat + send THE ASK
#   bash scripts/v0894-final-test.sh watch     # poll the HF transcript
#   bash scripts/v0894-final-test.sh quick     # the quick-chat capability test
#   bash scripts/v0894-final-test.sh game      # verify the served game as a user
#   bash scripts/v0894-final-test.sh down      # stop the engine
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=8489
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0894
SPACE_NAME=doomalay-final-test
SPACE_REPO=ScoobyBaby1999/$SPACE_NAME
SPACE_URL=https://scoobybaby1999-${SPACE_NAME}.hf.space
export AGENT_BROWSER_SESSION=doomalay-v0894
PM_KEY="${PM_KEY:-76277df9-5fd3-4fcc-8173-5705e83bc067}"
HF_KEY="${HF_KEY:-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}"

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')"; }

case "${1:-}" in
setup)
  rm -rf $DATA; mkdir -p $DATA
  nohup $ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0894-eng.log 2>&1 &
  echo $! > /tmp/v0894-eng.pid
  for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
  OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ "$OWNER" = "$(cat /tmp/v0894-eng.pid)" ] || { echo "BOOT FAIL (owner=$OWNER)"; exit 1; }
  echo "engine up on :$PORT (pid $(cat /tmp/v0894-eng.pid))"
  # seed the keys: PM (the model) + the HF hub token (space create/manage)
  curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"privatemodeai\",\"key\":\"$PM_KEY\"}" | head -c 120; echo
  curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"huggingface\",\"env_var\":\"DOOMALAY_HF_TOKEN\",\"key\":\"$HF_KEY\"}" | head -c 120; echo
  echo "── creating the ZeroGPU test space (the app's own flow)…"
  curl -s -X POST "$BASE/api/hf/space/create" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$SPACE_NAME\"}" | python3 -m json.tool 2>/dev/null | head -25
  ;;
status)
  echo "── space status:"
  curl -s "$BASE/api/hf/space/status?repo=$SPACE_REPO" | python3 -m json.tool 2>/dev/null | head -20
  echo "── direct probe:"
  curl -s -o /dev/null -w "  $SPACE_URL → HTTP %{http_code} (%{time_total}s)\n" "$SPACE_URL/health" --max-time 30
  ;;
hfturn)
  echo "── opening the app…"
  agent-browser close >/dev/null 2>&1; sleep 0.6
  agent-browser open "$BASE" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 8; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
  ev "localStorage.clear()" >/dev/null 2>&1
  R=$(ev "(async function(){
    for (var i=0;i<30 && !document.getElementById('dock-sub');i++) await new Promise(r=>setTimeout(r,300));
    document.getElementById('canvas-empty-btn').click();
    await new Promise(r => setTimeout(r, 1200));
    var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
    if (!cx || !cx.applyModel) return 'NO-CTX';
    // arm the OWN space on this chat (the app's own-space binding)
    cx.applyModel('privatemodeai', 'privatemodeai/kimi-latest');
    await new Promise(r => setTimeout(r, 1500));
    var st = window.ChatPanel.current().state;
    st.sandbox = 'hf'; st.sandboxMode = 'own'; st.sandboxRepo = '$SPACE_REPO';
    // THE ASK (one user message, the whole final test)
    var inp = document.getElementById('chat-input');
    if (!inp) return 'NO-INPUT';
    inp.value = 'FINAL CAPABILITY TEST. Do these in order, showing real outputs: (1) Read HARNESS.md in your workspace and list what you can do. (2) Prove the sandbox: run uname -a, df -h /data, python3 --version, and install a pip package (e.g. rich) showing it works. (3) Write and run a small Python simulation (e.g. 3-body orbits or bouncing balls) that outputs a summary; attach the script as an artifact. (4) STORAGE TEST: generate data files until at least 5GB is used (show df/du before and after), then delete them and show the space is healthy again. (5) THE GAME: build an evolution simulator as a single self-contained index.html served at your /pub/ root (write it to the public root): three spawnable colored dot species on a canvas — GREEN never dies; BLUE must eat a GREEN dot within 20 seconds or it dies; RED must eat a BLUE dot within 20 seconds or it dies. Every dot only ever flees or chases (predators chase prey, prey flee predators). Buttons to spawn each type + a reset, live counters, and a visible 20s starvation countdown ring on each hungry dot. Keep it beautiful and smooth. When done, reply with the /pub/ URL.';
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    var snd = document.getElementById('chat-send');
    if (!snd) return 'NO-SEND';
    snd.click();
    return 'SENT';
  })()")
  echo "hf turn: $R"
  ;;
watch)
  TIMEOUT="${2:-600}"
  echo "── polling the HF transcript (up to ${TIMEOUT}s)…"
  START=$(date +%s)
  LASTLEN=0; STALL=0
  while [ $(( $(date +%s) - START )) -lt "$TIMEOUT" ]; do
    R=$(ev "(function(){
      var rows = document.querySelectorAll('#chat-messages .msg-row-assistant, #chat-messages .msg-row-user, #chat-messages .msg-row-error, #chat-messages [class*=tool], #chat-messages [class*=status]');
      var last = rows.length ? (rows[rows.length-1].textContent||'').slice(0,160) : '';
      var st = window.ChatPanel && window.ChatPanel.current();
      var streaming = !!(st && st.state && st.state.isStreaming);
      return JSON.stringify({n: rows.length, streaming: streaming, last: last});
    })()")
    N=$(echo "$R" | python3 -c "import sys,json
try: print(json.loads(sys.stdin.read())['n'])
except Exception: print(0)")
    NOW=$(date +%s)
    echo "[${NOW}s] rows=$N $R" | head -c 400; echo
    if [ "$N" = "$LASTLEN" ]; then STALL=$((STALL+1)); else STALL=0; fi
    if [ "$STALL" -ge 12 ]; then echo "STALL: no new rows for ~60s and not streaming — checking…"; fi
    LASTLEN=$N
    STREAM=$(echo "$R" | python3 -c "import sys,json
try: print(json.loads(sys.stdin.read()).get('streaming'))
except Exception: print('None')" 2>/dev/null || true)
    if [ "$STREAM" = "False" ] && [ "$N" != "0" ] && [ "$STALL" -ge 12 ]; then
      echo "turn appears complete (not streaming, stalled)"; break
    fi
    sleep 5
  done
  ev "(function(){
    var rows = document.querySelectorAll('#chat-messages .msg-row-assistant');
    var txt = rows.length ? rows[rows.length-1].innerText : '';
    return JSON.stringify({ finalAnswer: txt.slice(0, 1200) });
  })()" | python3 -m json.tool 2>/dev/null || true
  ;;
quick)
  echo "── the quick-chat capability test…"
  agent-browser close >/dev/null 2>&1; sleep 0.6
  agent-browser open "$BASE" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 8; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
  ev "localStorage.clear()" >/dev/null 2>&1
  R=$(ev "(async function(){
    for (var i=0;i<30 && !document.getElementById('dock-sub');i++) await new Promise(r=>setTimeout(r,300));
    document.getElementById('canvas-empty-btn').click();
    await new Promise(r => setTimeout(r, 1200));
    var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
    if (!cx) return 'NO-CTX';
    cx.applyModel('privatemodeai', 'privatemodeai/glm-5.2');
    await new Promise(r => setTimeout(r, 2000));
    var inp = document.getElementById('chat-input');
    if (!inp) return 'NO-INPUT';
    inp.value = 'CAPABILITY TEST for a QUICK chat (runs on my device, not a cloud sandbox): (1) List honestly what you can and cannot do in THIS kind of chat — do you have a bash shell? a calculator? web search? the library? artifacts? (2) Compute 17*23 + sqrt(1024) and show the result. (3) Attach a tiny text artifact named capabilities.txt listing your quick-chat capabilities. Be honest — do not claim abilities you lack.';
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    var snd = document.getElementById('chat-send'); if (!snd) return 'NO-SEND';
    snd.click();
    return 'SENT';
  })()")
  echo "quick turn: $R"
  ;;
game)
  echo "── verifying the served game as a real user…"
  agent-browser close >/dev/null 2>&1; sleep 0.6
  agent-browser open "$SPACE_URL/pub/" >/dev/null 2>&1
  sleep 4
  R=$(ev "(function(){
    var cv = document.querySelector('canvas');
    var btns = Array.prototype.map.call(document.querySelectorAll('button'), function(b){return (b.textContent||'').trim().toLowerCase();});
    return JSON.stringify({ title: document.title, hasCanvas: !!cv, cw: cv?cv.width:0, ch: cv?cv.height:0, buttons: btns, bodyLen: (document.body.innerText||'').length });
  })()")
  echo "$R" | python3 -m json.tool 2>/dev/null || echo "$R"
  ;;
down)
  [ -f /tmp/v0894-eng.pid ] && kill "$(cat /tmp/v0894-eng.pid)" 2>/dev/null
  agent-browser close >/dev/null 2>&1
  echo "engine down"
  ;;
*)
  echo "usage: $0 {setup|status|hfturn|watch|quick|game|down}"
  ;;
esac
