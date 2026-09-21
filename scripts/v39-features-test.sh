#!/bin/bash
# v39-features-test.sh — find-in-chat + mid-turn offline→resume + styling QA
# via agent-browser against the engine + the deterministic mock provider.
# Convention: every check emits 0 = success; ok() counts 0 as PASS.
DATA=/tmp/doomalay-v39feat
PORT=8149
MOCK_PORT=8150
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v39feat

PASS=0; FAIL=0
ok() { if [ "$1" = "0" ]; then PASS=$((PASS+1)); echo "  PASS $2"; else FAIL=$((FAIL+1)); echo "  FAIL $2"; fi; }
# strip agent-browser's JSON-string quoting (outer quotes + escaped inner quotes)
clean() { tr -d '"\\'; }

# ── the mock provider (slow deterministic stream: 8 chunks, 700ms apart) ──
cat > /home/z/v39mock.py << 'PYEOF'
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"data": [{"id": "mock/feat-mini"}]}).encode()
        self.send_response(200); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length",0)))
        self.send_response(200)
        self.send_header("Content-Type","text/event-stream"); self.end_headers()
        for i in range(8):
            c = {"choices":[{"delta":{"content":f"feat-{i} "}}]}
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode()); self.wfile.flush()
            time.sleep(0.7)
        e = {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":5}}
        self.wfile.write(f"data: {json.dumps(e)}\n\ndata: [DONE]\n\n".encode()); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.1", 8150), H).serve_forever()
PYEOF
python3 /home/z/v39mock.py >/tmp/v39mock.log 2>&1 &
MOCKPID=$!

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
DOOMALAY_BASE_URL_NVIDIA="http://127.0.0.1:$MOCK_PORT/v1" \
DOOMALAY_CONFIG="$DATA/nobrain.yaml" \
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v39feat-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
[ "${i:-0}" -eq 80 ] && { echo "FATAL: engine did not start"; exit 1; }

curl -s -X POST $BASE/api/keys -H 'Content-Type: application/json' \
  -d '{"provider":"nvidia","env_var":"NVIDIA_API_KEY","key":"nvapi-mock"}' >/dev/null
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Feat Bot","sandbox":"quick","model":"nvidia/mock/feat-mini","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
echo "session: $SID"

# seed a transcript with searchable text
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"user","text":"tell me about pineapples"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"assistant","text":"Pineapples are tropical fruits rich in bromelain. The pineapple crown can regrow."}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"user","text":"and mangos?"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"assistant","text":"Mangos are stone fruits; unlike the pineapple they grow on trees."}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

# ── browser ──
agent-browser close --all 2>/dev/null
agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null
sleep 1
agent-browser errors --clear >/dev/null; agent-browser console --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Feat Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/feat-mini',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null
sleep 4

echo "== 1. find bar =="
FB=$(agent-browser eval "(() => { const b=[...document.querySelectorAll('#chat-toolbar button')].find(x=>/find/i.test(x.textContent||'')); return b ? 'YES' : 'NO'; })()" | clean)
echo "  find button: $FB"
ok "$([ "$FB" = "YES" ]; echo $?)" "toolbar shows the find button"
agent-browser eval "(() => { const b=[...document.querySelectorAll('#chat-toolbar button')].find(x=>/find/i.test(x.textContent||'')); if(b) b.click(); return 'ok'; })()" >/dev/null
sleep 0.8
BAR=$(agent-browser eval "(() => { const b=document.querySelector('#chat-find'); const i=document.querySelector('#chat-find-input'); return JSON.stringify({bar: !!b, open: !!(b&&b.classList.contains('open')), input: !!i, focus: document.activeElement===i}); })()" | clean)
echo "  bar: $BAR"
ok "$(echo "$BAR" | grep -q 'bar:true' && echo 0 || echo 1)" "find bar mounts (slides open)"
ok "$(echo "$BAR" | grep -q 'focus:true' && echo 0 || echo 1)" "input auto-focuses"
agent-browser fill "#chat-find-input" "pineapple" >/dev/null
sleep 0.5
CNT=$(agent-browser eval "document.querySelector('#chat-find-count').textContent" | clean)
# 4 real matches: "pineapples"(user) + "Pineapples" + "pineapple"(reply 1) + "pineapple"(reply 2)
ok "$([ "$CNT" = "1/4" ]; echo $?)" "match count 1/4 for 'pineapple' (got $CNT)"
HIT=$(agent-browser eval "(() => document.querySelectorAll('.find-hit').length)()")
ok "$([ "$HIT" -ge 1 ] 2>/dev/null; echo $?)" "current match highlighted (.find-hit) (got $HIT)"
agent-browser press Enter >/dev/null; sleep 0.5
CNT2=$(agent-browser eval "document.querySelector('#chat-find-count').textContent" | clean)
ok "$([ "$CNT2" = "2/4" ]; echo $?)" "Enter walks to the next match (2/4) (got $CNT2)"
agent-browser eval "(() => { const i=document.querySelector('#chat-find-input'); i.value='zzz-not-there'; i.dispatchEvent(new Event('input')); })()" >/dev/null
sleep 0.5
CNT3=$(agent-browser eval "document.querySelector('#chat-find-count').textContent" | clean)
ok "$([ "$CNT3" = "0/0" ]; echo $?)" "no-match shows 0/0 (got $CNT3)"
agent-browser eval "(() => { const i=document.querySelector('#chat-find-input'); i.value='mangos'; i.dispatchEvent(new Event('input')); })()" >/dev/null
sleep 0.5
CNT4=$(agent-browser eval "document.querySelector('#chat-find-count').textContent" | clean)
ok "$([ "$CNT4" = "1/2" ]; echo $?)" "re-search works (mangos → 1/2) (got $CNT4)"
agent-browser press Escape >/dev/null; sleep 0.6
GONE=$(agent-browser eval "(() => { const b=document.querySelector('#chat-find'); return b ? 'STILL' : 'GONE'; })()" | clean)
ok "$([ "$GONE" = "GONE" ]; echo $?)" "Esc closes the find bar (got $GONE)"

echo "== 2. mid-turn ENGINE CRASH -> reconnecting -> resume+heal =="
# A REAL disconnect: kill the engine process mid-stream (the crash/force-stop
# scenario). The browser WS drops -> the ladder announces -> the engine restarts
# -> the next attempt resumes with &since= -> the boot-healed terminal replays.
agent-browser fill "#chat-input" "stream while I kill the engine" >/dev/null
agent-browser click "#chat-send" >/dev/null
sleep 2.5   # the mock stream is live (~5.6s of chunks)
STREAMING=$(agent-browser eval "(() => document.querySelector('#chat-messages').innerText.includes('feat-'))()" | clean)
echo "  streaming before crash: $STREAMING"
ok "$([ "$STREAMING" = "true" ]; echo $?)" "the turn was streaming when the engine died"
kill -9 $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null
sleep 2.5  # the WS drop fires; the ladder starts announcing
IND=$(agent-browser eval "(() => { const a=document.querySelector('.chat-working'); return a ? a.innerText : ''; })()" | clean)
echo "  activity while down: '$IND'"
ok "$(echo "$IND" | grep -qi reconnect && echo 0 || echo 1)" "reconnecting indicator shows while the engine is down"
# bring the engine back (same data dir = the turn's events survive)
DOOMALAY_BASE_URL_NVIDIA="http://127.0.0.1:$MOCK_PORT/v1" \
DOOMALAY_CONFIG="$DATA/nobrain.yaml" \
$ENG -open=false -port=$PORT -data-dir=$DATA >>/tmp/v39feat-eng.log 2>&1 &
ENGPID=$!
for i in $(seq 1 60); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
# the ladder's next attempt reconnects -> replay lands -> the UI completes
DONE=0
for i in $(seq 1 40); do
  R=$(agent-browser eval "(() => { const btn=document.querySelector('#chat-send'); return btn ? btn.textContent : ''; })()" | clean)
  [ "$R" = "Send" ] && { DONE=1; break; }
  sleep 1
done
ok "$([ "$DONE" = "1" ]; echo $?)" "send button restored after resume+heal (turn closed honestly)"
sleep 1
PART=$(agent-browser eval "(() => { const t=document.querySelector('#chat-messages').innerText; return t.includes('feat-1'); })()" | clean)
ok "$([ "$PART" = "true" ]; echo $?)" "the partial reply SURVIVED the crash (persisted deltas replayed)"
DUP=$(agent-browser eval "(() => { const t=document.querySelector('#chat-messages').innerText; return (t.match(/feat-0 /g)||[]).length; })()")
ok "$([ "$DUP" = "1" ]; echo $?)" "no duplicated transcript content after resume (feat-0 count: $DUP)"

echo "== 3. styling spot-checks =="
RING=$(agent-browser eval "(() => { const r=document.querySelector('#header-ctx-ring .ctx-ring'); return JSON.stringify({ringT: r?getComputedStyle(r).transition:'', sendT: document.getElementById('chat-send')?getComputedStyle(document.getElementById('chat-send')).transition:''}); })()" | clean)
echo "  transitions: $RING"
ok "$(echo "$RING" | grep -q 'transform' && echo 0 || echo 1)" "ring carries the hover-grow transition"
ok "$(echo "$RING" | grep -qE 'transform|background' && echo 0 || echo 1)" "send button carries the active-press transition"
SCROLL=$(agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); return s ? getComputedStyle(s).scrollbarWidth : 'none'; })()" | clean)
ok "$([ "$SCROLL" = "thin" ]; echo $?)" "transcript scrollbar is thin + themed (got $SCROLL)"
FOCUS=$(agent-browser eval "(() => { const i=document.getElementById('chat-input'); if(!i) return 'NOINPUT'; i.focus(); const cs=getComputedStyle(i); return cs.boxShadow && cs.boxShadow!=='none' ? 'GLOW':'NONE'; })()" | clean)
ok "$([ "$FOCUS" = "GLOW" ]; echo $?)" "composer focus glow (themed ring) applies (got $FOCUS)"

echo "== 4. errors =="
ERRS=$(agent-browser errors | grep -cv "^[[:space:]]*$")
ok "$([ "$ERRS" = "0" ]; echo $?)" "zero page errors (got $ERRS)"
agent-browser console 2>/dev/null | grep -viE "favicon|manifest|service worker|sw\.js|preload|Autofocus" | grep -iE "error|warn" | head -5

echo "=============================="
echo "RESULT: $PASS PASS / $FAIL FAIL"
[ "$FAIL" = "0" ]
