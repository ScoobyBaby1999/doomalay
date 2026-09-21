#!/bin/bash
# v40-features-test.sh — v0.40 red-team: model-gone recovery chips, find-bar
# geometry fix, draft persistence, starter chips, jump-to-latest pill.
# Engine + mock provider + agent-browser in ONE invocation (sandbox rule).
DATA=/tmp/doomalay-v40feat
PORT=8153
MOCK_PORT=8154
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v40feat
PASS=0; FAIL=0
ok() { if [ "$1" = "0" ]; then PASS=$((PASS+1)); echo "  PASS $2"; else FAIL=$((FAIL+1)); echo "  FAIL $2"; fi; }
clean() { tr -d '"\\'; }

# ── mock provider: 3 models in catalog; dead-one → 410 EOL; others stream ──
cat > /home/z/v40mock.py << 'PYEOF'
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._json(200, {"data": [
            {"id": "mock/dead-one"},
            {"id": "mock/alive-a"},
            {"id": "mock/alive-b"}
        ]})
    def do_POST(self):
        n = int(self.headers.get("Content-Length",0))
        body = json.loads(self.rfile.read(n) or b"{}")
        model = body.get("model","")
        if "dead-one" in model:
            self._json(410, {"type":"about:blank","title":"Gone","status":410,
                "detail":"The model 'mock/dead-one' has reached its end of life"})
            return
        self.send_response(200)
        self.send_header("Content-Type","text/event-stream"); self.end_headers()
        for i in range(4):
            c = {"choices":[{"delta":{"content":f"recovered-{i} "}}]}
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode()); self.wfile.flush()
            time.sleep(0.35)
        e = {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":5}}
        self.wfile.write(f"data: {json.dumps(e)}\n\ndata: [DONE]\n\n".encode()); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.1", 8154), H).serve_forever()
PYEOF
python3 /home/z/v40mock.py >/tmp/v40mock.log 2>&1 &
MOCKPID=$!

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
DOOMALAY_BASE_URL_NVIDIA="http://127.0.0.1:$MOCK_PORT/v1" \
DOOMALAY_CONFIG="$DATA/nobrain.yaml" \
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v40feat-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
[ "${i:-0}" = "80" ] && { echo "FATAL: engine did not start"; exit 1; }

curl -s -X POST $BASE/api/keys -H 'Content-Type: application/json' \
  -d '{"provider":"nvidia","env_var":"NVIDIA_API_KEY","key":"nvapi-mock"}' >/dev/null
curl -s "$BASE/api/models?refresh=1" -o /tmp/v40feat-models.json
NM=$(python3 -c '
import json
d=json.load(open("/tmp/v40feat-models.json"))
names=[]
def walk(x):
    if isinstance(x,dict):
        for k,v in x.items():
            if k=="models" and isinstance(v,list):
                for m in v:
                    if isinstance(m,dict) and m.get("id"): names.append(m["id"])
            else: walk(v)
    elif isinstance(x,list):
        for v in x: walk(v)
walk(d)
print(len(names))')
echo "  catalog: $NM mock models"
ok "$([ "$NM" -ge 3 ] 2>/dev/null; echo $?)" "mock catalog synced (3 models)"

# session A: the dead model (model-gone chips flow)
SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Dead Bot","sandbox":"quick","model":"nvidia/mock/dead-one","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
# session B: long transcript (find geometry + jump pill)
SIDB=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Long Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
for i in $(seq 1 14); do
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"user\",\"text\":\"question number $i about pineapples and quantum entanglement\"}" >/dev/null
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"assistant\",\"text\":\"Answer $i: pineapples grow quantum crowns in tropical superposition. The entanglement of bromelain and spacetime is well documented across many universes and longitudinal studies of fruit.\"}" >/dev/null
done
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
# session C: empty (starter chips)
SIDC=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Fresh Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SIDC/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
echo "  sessions: $SIDA $SIDB $SIDC"

seticon() { agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'$2',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'$3',provider:'nvidia',sessionId:'$1'}],savedAt:Date.now()}))" >/dev/null; agent-browser reload >/dev/null; sleep 1.5; agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null

echo "== 1. MODEL-GONE CHIPS (dead model → 410 → chips → switch + resend) =="
seticon "$SIDA" "Dead Bot" "nvidia/mock/dead-one"
agent-browser click "#chat-input" >/dev/null; sleep 0.2
agent-browser keyboard type "please answer me" >/dev/null
agent-browser click "#chat-send" >/dev/null
CHIPS=0
for i in $(seq 1 40); do
  N=$(agent-browser eval "document.querySelectorAll('.err-switch').length" | tr -d '"')
  [ "$N" -ge 1 ] 2>/dev/null && { CHIPS=1; break; }
  sleep 1
done
ok "$([ "$CHIPS" = "1" ]; echo $?)" "error bubble carries replacement chips"
ERRTXT=$(agent-browser eval "(() => { const b=document.querySelector('.msg-error'); return b ? b.innerText.slice(0,140) : 'NONE'; })()" | clean)
echo "  error text: $ERRTXT"
ok "$(echo "$ERRTXT" | grep -qiE 'retired|no longer|end of life' && echo 0 || echo 1)" "error reads as the model-gone class"
SUG=$(agent-browser eval "(() => [...document.querySelectorAll('.err-switch')].map(b=>b.getAttribute('data-model')).join(','))()" | clean)
echo "  suggestions: $SUG"
ok "$([ -n "$SUG" ] && [ "$SUG" != "" ]; echo $?)" "replacement chips carry full user-facing model ids"
ok "$(echo "$SUG" | grep -vq 'dead-one' && echo 0 || echo 1)" "the dead model is NOT suggested"
# tap the first chip → switch + auto-resend → recovery
agent-browser eval "document.querySelector('.err-switch').click()" >/dev/null
RECOVERED=0
for i in $(seq 1 50); do
  R=$(agent-browser eval "(() => { const t=document.querySelector('#chat-messages'); const b=document.querySelector('#chat-send'); return (b && b.textContent==='Send' && /recovered-3/.test(t.innerText)) ? 'DONE':'WAIT'; })()" | clean)
  [ "$R" = "DONE" ] && { RECOVERED=1; break; }
  sleep 1
done
ok "$([ "$RECOVERED" = "1" ]; echo $?)" "one tap: model switched + prompt re-sent + reply landed"
NEWSUG=$(agent-browser eval "document.querySelectorAll('.err-switch').length" | tr -d '"')
ok "$([ "$NEWSUG" = "0" ] 2>/dev/null; echo $?)" "resolved error bubble dropped (chips gone)"
MB=$(agent-browser eval "(() => document.getElementById('panel-model-btn').innerText)()" | clean)
echo "  header model: $MB"
ok "$(echo "$MB" | grep -vq 'dead-one' && echo 0 || echo 1)" "chat header switched off the dead model"
# server-side: session model was PATCHed
SESS=$(curl -s "$BASE/api/sessions/$SIDA" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("Model",""))')
echo "  server session model: $SESS"
ok "$(echo "$SESS" | grep -vq 'dead-one' && echo 0 || echo 1)" "engine session model persisted (≠ dead model)"

echo "== 2. FIND BAR GEOMETRY (the overlap fix) =="
seticon "$SIDB" "Long Bot" "nvidia/mock/alive-a"
agent-browser eval "(() => { const b=[...document.querySelectorAll('#chat-toolbar button')].find(x=>/find/i.test(x.textContent||'')); if(b){b.click(); return 'OPEN';} return 'NOBTN'; })()" | clean
sleep 1
GEO=$(agent-browser eval "(() => { const i=document.getElementById('chat-find-input'); if(!i) return 'NOINPUT'; const r=i.getBoundingClientRect(); const cx=r.x+r.width/2, cy=r.y+r.height/2; const hit=document.elementFromPoint(cx,cy); const bar=document.getElementById('chat-find'); return JSON.stringify({hit:(hit?(hit.id||hit.tagName):'none'), inBar: !!(bar && bar.contains(i)), w:Math.round(r.width), h:Math.round(r.height)}); })()" | clean)
echo "  geometry: $GEO"
ok "$(echo "$GEO" | grep -q 'hit:chat-find-input' && echo 0 || echo 1)" "find input's click point hits ITSELF (was: covered by composer)"
ok "$(echo "$GEO" | grep -qE 'h:(2[5-9]|[3-9][0-9])' && echo 0 || echo 1)" "find bar has real height (open, not clipped)"
agent-browser press Escape >/dev/null; sleep 0.5

echo "== 3. JUMP-TO-LATEST PILL =="
# scroll up hard (many screens of content)
PILL=$(agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); return 'SCROLLED'; })()" | clean)
sleep 0.6
PJ=$(agent-browser eval "(() => { const j=document.getElementById('chat-jump'); if(!j) return 'NOBTN'; return JSON.stringify({show:j.classList.contains('show'), disp:getComputedStyle(j).display, z:getComputedStyle(j).zIndex, bottom:j.style.bottom||'css'}); })()" | clean)
echo "  pill: $PJ"
ok "$(echo "$PJ" | grep -q 'show:true' && echo 0 || echo 1)" "pill appears when scrolled up"
agent-browser eval "document.getElementById('chat-jump').click()" >/dev/null; sleep 1.2
ATBOT=$(agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); const j=document.getElementById('chat-jump'); const d=s.scrollHeight-s.scrollTop-s.clientHeight; return 'd'+Math.round(d)+' show'+j.classList.contains('show'); })()" | clean)
echo "  after click: $ATBOT"
ok "$(echo "$ATBOT" | grep -qE 'd([0-9]|[0-9][0-9]) ' && echo 0 || echo 1)" "click scrolls back to the bottom (≤99px away)"
ok "$(echo "$ATBOT" | grep -q 'showfalse' && echo 0 || echo 1)" "pill hides at the bottom"

echo "== 4. STARTER CHIPS + DRAFT PERSISTENCE =="
seticon "$SIDC" "Fresh Bot" "nvidia/mock/alive-a"
ST=$(agent-browser eval "(() => { const w=document.getElementById('chat-starters'); if(!w) return 'NOWRAP'; return JSON.stringify({chips:w.querySelectorAll('.starter-chip').length, vis: !!w.offsetParent}); })()" | clean)
echo "  starters: $ST"
ok "$(echo "$ST" | grep -q 'chips:3' && echo 0 || echo 1)" "3 starter chips on the empty chat"
CHIPC=$(agent-browser eval "(() => { const c=document.querySelector('.starter-chip'); if(!c) return 'NOCHIP'; const cs=getComputedStyle(c); return 'r'+cs.borderRadius+' tr'+(cs.transition?'yes':'no'); })()" | clean)
ok "$(echo "$CHIPC" | grep -q 'r999' && echo 0 || echo 1)" "starter chips pill-shaped ($CHIPC)"
agent-browser eval "document.querySelector('.starter-chip').click()" >/dev/null; sleep 0.5
PRE=$(agent-browser eval "(() => { const t=document.getElementById('chat-input'); return t ? t.value.slice(0,40) : 'NOTA'; })()" | clean)
echo "  prefilled: $PRE"
ok "$([ -n "$PRE" ] && [ "$PRE" != "NOTA" ]; echo $?)" "chip tap prefills the composer"
# draft survives a full reload
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
DRAFT=$(agent-browser eval "(() => { const t=document.getElementById('chat-input'); return t ? t.value.slice(0,40) : 'NOTA'; })()" | clean)
echo "  draft after reload: $DRAFT"
ok "$([ -n "$DRAFT" ] && [ "$DRAFT" != "NOTA" ]; echo $?)" "draft persisted across reload"
# send clears it
agent-browser click "#chat-send" >/dev/null; sleep 3
CLEARED=$(agent-browser eval "(() => { const t=document.getElementById('chat-input'); return t ? t.value : 'NOTA'; })()" | clean)
ok "$([ "$CLEARED" = "" ]; echo $?)" "send clears the composer + draft store"
LS=$(agent-browser eval "(() => { const m=JSON.parse(localStorage.getItem('doomalay.chatdraft.v1')||'{}'); return JSON.stringify(Object.keys(m)); })()" | clean)
echo "  draft store: $LS"
ok "$(echo "$LS" | grep -vq 'f1' && echo 0 || echo 1)" "sent chat removed from the draft store (icon-keyed)"

echo "== 5. styling spot-checks =="
JUMPC=$(agent-browser eval "(() => { const j=document.getElementById('chat-jump'); const cs=getComputedStyle(j); return 'tr'+(cs.transition.indexOf('opacity')>=0?'yes':'no')+' z'+cs.zIndex; })()" | clean)
ok "$(echo "$JUMPC" | grep -qE 'tryes z[0-9]' && echo 0 || echo 1)" "jump pill themed + transitioned ($JUMPC)"

echo "== 6. page errors =="
ERRS=$(agent-browser errors | grep -cv "^[[:space:]]*$")
ok "$([ "$ERRS" = "0" ]; echo $?)" "zero page errors (got $ERRS)"
agent-browser errors | head -5
agent-browser console 2>/dev/null | grep -viE "favicon|manifest|service worker|sw\.js|preload|Autofocus" | grep -iE "error|warn" | head -6

echo "=============================="
echo "RESULT: $PASS PASS / $FAIL FAIL"
[ "$FAIL" = "0" ]
