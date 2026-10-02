#!/bin/bash
# v0914-game-turn.sh — THE HF CHAT GAME TURN (Phase 3's core deliverable).
# The user's spec: the 3-dots game VISIBLE at the Space's page, built BY
# the HF chat (enhanced capabilities), persisting restarts, chatlog attached.
#
# Usage:
#   bash scripts/v0914-game-turn.sh setup    # engine (persistent) + keys + ADOPT the space
#   bash scripts/v0914-game-turn.sh turn     # the app flow: chat + own-space + THE ASK
#   bash scripts/v0914-game-turn.sh watch    # poll the transcript (arg: timeout secs)
#   bash scripts/v0914-game-turn.sh verify   # real-user check: the game at the ROOT
#   bash scripts/v0914-game-turn.sh persist  # restart the space + survival proof
#   bash scripts/v0914-game-turn.sh chatlog  # export the session md
#   bash scripts/v0914-game-turn.sh down     # stop the engine
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=8521
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0914
PIDFILE=/tmp/v0914-eng.pid
SPACE_REPO=ScoobyBaby1999/doomalay-final-test
SPACE_URL=https://scoobybaby1999-doomalay-final-test.hf.space
export AGENT_BROWSER_SESSION=doomalay-v0914
PM_KEY="${PM_KEY:-76277df9-5fd3-4fcc-8173-5705e83bc067}"
HF_KEY="${HF_KEY:-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}"

ev() { timeout 120 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }

engine_up() {
  curl -s $BASE/api/health >/dev/null 2>&1 && return 0
  return 1
}

case "${1:-}" in
setup)
  if engine_up; then echo "engine already up (pid $(cat $PIDFILE 2>/dev/null))"; else
    rm -rf $DATA; mkdir -p $DATA
    nohup $ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0914-eng.log 2>&1 &
    echo $! > $PIDFILE; disown
    for i in $(seq 1 120); do engine_up && break; sleep 0.5; done
  fi
  engine_up && echo "engine up on :$PORT (pid $(cat $PIDFILE))" || { echo "BOOT FAIL"; exit 1; }
  OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ "$OWNER" = "$(cat $PIDFILE)" ] || { echo "ZOMBIE PORT (owner=$OWNER)"; exit 1; }
  curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"privatemodeai\",\"key\":\"$PM_KEY\"}" | head -c 60; echo
  curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
    -d "{\"env_var\":\"DOOMALAY_HF_TOKEN\",\"provider\":\"huggingface\",\"key\":\"$HF_KEY\"}" | head -c 60; echo
  echo "── ADOPTING the space (the user-reinstall flow: re-commit + re-mint the vault token)"
  curl -s -X POST "$BASE/api/hf/space/create" -H 'Content-Type: application/json' \
    -d "{\"name\":\"doomalay-final-test\"}" | head -c 400; echo
  echo "── space status:"
  curl -s "$BASE/api/hf/space/status?repo=$SPACE_REPO" | head -c 300; echo
  ;;
turn)
  engine_up || { echo "ENGINE DOWN — run setup first"; exit 1; }
  agent-browser close >/dev/null 2>&1; sleep 1.2
  agent-browser open "$BASE" >/dev/null 2>&1
  for i in 1 2 3 4 5; do
    U=$(ev "location.href" 2>/dev/null)
    case "$U" in *127.0.0.1*|*localhost*) break;; esac
    sleep 1; agent-browser open "$BASE" >/dev/null 2>&1; sleep 1.5
  done
  case "$U" in *127.0.0.1*|*localhost*) echo "  app loaded";; *) echo "APP LOAD FAILED ($U)"; exit 1;; esac
  ev "localStorage.clear()" >/dev/null 2>&1; sleep 0.5
  R=$(ev "(async function(){
    for (var i=0;i<40 && !document.getElementById('dock-sub');i++) await new Promise(r=>setTimeout(r,300));
    var b = document.getElementById('canvas-empty-btn');
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1500));
    var c = window.ChatPanel.current(); var cx = c && (c.ctx || c);
    if (!cx || !cx.applyModel) return 'NO-CTX';
    cx.applyModel('privatemodeai', 'privatemodeai/kimi-latest');
    await new Promise(r => setTimeout(r, 1500));
    var st = window.ChatPanel.current().state;
    st.sandbox = 'hf'; st.sandboxMode = 'own'; st.sandboxRepo = '$SPACE_REPO';
    var inp = document.getElementById('chat-input');
    if (!inp) return 'NO-INPUT';
    inp.value = 'THE GAME, PERSISTENT THIS TIME. Your previous evolution game was wiped by a space restart (the ephemeral public root does not survive). Do this, in order, showing real outputs: (1) Read HARNESS.md in your workspace, especially the section MAKING IT SURVIVE RESTARTS. (2) Build the evolution game as ONE self-contained index.html: a canvas with three spawnable colored dot species - GREEN never dies; BLUE must eat a GREEN dot within 20 seconds or it dies; RED must eat a BLUE dot within 20 seconds or it dies. Every dot only ever flees or chases (predators chase prey, prey flee predators). Buttons to spawn each species + a reset button, live counters per species, and a visible 20-second starvation countdown ring on each hungry dot. Keep it beautiful and smooth. (3) VERIFY IT HEADLESS first: load the file in a headless browser (or node) and prove ~300 animation frames run with zero exceptions and the spawn buttons work. (4) PUBLISH IT PERSISTENTLY: use the hf tool publish action to upload the file as public/index.html to THIS space repo - repo name ScoobyBaby1999/doomalay-final-test, repo_type space. The repo IS the space disk: the space root (https://scoobybaby1999-doomalay-final-test.hf.space/) serves public/index.html as its landing page, and it survives restarts. (5) VERIFY THE PUBLISH: fetch the space root URL and confirm your game html is what loads (not the JSON info blob). Reply with the space root URL and a one-line summary of what you verified.';
    inp.dispatchEvent(new Event('input', {bubbles:true}));
    var snd = document.getElementById('chat-send');
    if (!snd) return 'NO-SEND';
    snd.click();
    return 'SENT';
  })()")
  echo "hf turn: $R"
  ;;
watch)
  TIMEOUT="${2:-3600}"
  echo "── polling the HF transcript (up to ${TIMEOUT}s)…"
  START=$(date +%s); LASTN=0; STALL=0
  while [ $(( $(date +%s) - START )) -lt "$TIMEOUT" ]; do
    R=$(ev "(function(){
      var rows = document.querySelectorAll('#chat-messages .msg-row-assistant, #chat-messages .msg-row-user, #chat-messages .msg-row-error, #chat-messages [class*=tool], #chat-messages [class*=status]');
      var last = rows.length ? (rows[rows.length-1].textContent||'').slice(0,200) : '';
      var st = window.ChatPanel && window.ChatPanel.current();
      var streaming = !!(st && st.state && st.state.isStreaming);
      return JSON.stringify({n: rows.length, streaming: streaming, last: last});
    })()" 2>/dev/null)
    N=$(echo "$R" | python3 -c "
import sys, json
try: print(json.loads(sys.stdin.read())['n'])
except Exception: print(0)" 2>/dev/null)
    NOW=$(date +%s)
    echo "[${NOW}s] rows=${N:-0} $(echo "$R" | head -c 260)"
    STREAM=$(echo "$R" | python3 -c "
import sys, json
try: print(json.loads(sys.stdin.read()).get('streaming'))
except Exception: print('None')" 2>/dev/null)
    if [ "${STREAM}" = "False" ] && [ "${N:-0}" -gt 3 ] && [ "$N" = "$LASTN" ]; then
      STALL=$((STALL+1)); [ "$STALL" -ge 10 ] && { echo "DONE (stalled 10 ticks, not streaming)"; break; }
    else STALL=0; fi
    LASTN="${N:-0}"
    sleep 30
  done
  ;;
verify)
  echo "── the space root (the real-user view):"
  curl -s -o /tmp/v0914-root.html -w "HTTP %{http_code} type=%{content_type} bytes=%{size_download}\n" "$SPACE_URL/"
  head -c 300 /tmp/v0914-root.html; echo; echo
  grep -qi "<canvas\|<html" /tmp/v0914-root.html && echo "ROOT SERVES HTML (the game)" || echo "ROOT IS NOT HTML YET"
  echo "── in the browser:"
  agent-browser open "$SPACE_URL/" >/dev/null 2>&1; sleep 5
  agent-browser get url 2>/dev/null
  V=$(ev "(function(){
    var cv = document.querySelector('canvas');
    var btns = Array.from(document.querySelectorAll('button')).map(function(b){return (b.textContent||'').trim().toLowerCase();});
    var hasSpawn = btns.some(function(t){return t.indexOf('green')>=0 || t.indexOf('blue')>=0 || t.indexOf('red')>=0;});
    var body = (document.body.textContent||'').toLowerCase();
    return JSON.stringify({
      title: document.title.slice(0,60),
      canvas: !!cv, canvasSize: cv ? (cv.width+'x'+cv.height) : '',
      spawnButtons: hasSpawn, btnCount: btns.length,
      counters: /green|blue|red/.test(body),
      isJson: body.indexOf('\"app\":\"doomalay-sandbox\"') >= 0
    });
  })()")
  echo "$V"
  python3 -c "
import json,sys
try:
    d = json.loads('''$V''')
    ok = d['canvas'] and d['spawnButtons'] and not d['isJson']
    print('GAME AT ROOT:', 'YES' if ok else 'NO', d)
except Exception as e:
    print('parse fail:', e)"
  ;;
persist)
  echo "── restarting the space (the survival proof)…"
  curl -s -X POST "$BASE/api/hf/space/restart?repo=$SPACE_REPO" | head -c 200; echo
  echo "── waiting for the rebuild…"
  for i in $(seq 1 90); do
    C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$SPACE_URL/health" 2>/dev/null)
    [ "$C" = "200" ] && { echo "healthy again after ~$((i*10))s"; break; }
    sleep 10
  done
  sleep 5
  echo "── the root after restart:"
  curl -s -o /tmp/v0914-root2.html -w "HTTP %{http_code} type=%{content_type}\n" "$SPACE_URL/"
  grep -qi "<canvas\|<html" /tmp/v0914-root2.html && echo "THE GAME SURVIVED THE RESTART ✓" || { echo "GAME LOST — the publish was not persistent"; head -c 200 /tmp/v0914-root2.html; }
  ;;
chatlog)
  SID=$(ev "(function(){ var st = window.ChatPanel && window.ChatPanel.current(); return st && st.state && st.state.sessionId || ''; })()")
  [ -z "$SID" ] && { echo "NO SESSION — run turn first"; exit 1; }
  echo "session: $SID"
  mkdir -p /home/z/my-project/download
  curl -s "$BASE/api/sessions/$SID/export.md" -o "/home/z/my-project/download/hf-chat-game-chatlog.md"
  wc -c /home/z/my-project/download/hf-chat-game-chatlog.md
  head -20 /home/z/my-project/download/hf-chat-game-chatlog.md
  ;;
down)
  [ -f $PIDFILE ] && kill $(cat $PIDFILE) 2>/dev/null && echo "engine stopped"
  rm -f $PIDFILE
  ;;
*)
  echo "usage: $0 {setup|turn|watch|verify|persist|chatlog|down}"
  ;;
esac
