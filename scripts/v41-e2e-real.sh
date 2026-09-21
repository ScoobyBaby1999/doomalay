#!/bin/bash
# v41-e2e-real.sh — REAL-USER E2E: real turn (gpt-oss-20b, real NIM key) →
# then global-search for the reply's content → jump back to the message.
DATA=/tmp/doomalay-v41e2e
PORT=8167
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41e2e
ev()  { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }

rm -rf $DATA; mkdir -p $DATA
cp -r /tmp/doomalay-v38nt/* $DATA/
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41e2e-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"E2E","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'E2E',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5

# REAL TURN — ask for a reply with a searchable unique phrase
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Mention the word sunflower-cyclone exactly once in a one-sentence reply.'; return 1; })()" >/dev/null
agent-browser click "#chat-send" >/dev/null
REPLY=""
for i in $(seq 1 120); do
  sleep 1
  REPLY=$(ev "(() => { const rows = document.querySelectorAll('#chat-messages .msg-row-assistant'); return rows.length ? (rows[rows.length-1].textContent||'').slice(0,120) : ''; })()")
  echo "$REPLY" | grep -qi "cyclone" && break
done
echo "real reply: $REPLY"
echo "$REPLY" | grep -qi "cyclone" && echo "PASS: real turn (gpt-oss-20b) completed" || echo "FAIL: real turn"

# close the panel, then global-search for the unique word
agent-browser press Escape >/dev/null; sleep 0.5
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1.2
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='sunflower-cyclone'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.4
RES=$(ev "(() => { const g=document.querySelectorAll('.gs-group').length; const h=document.querySelectorAll('.gs-hit').length; const m=document.querySelectorAll('.gs-snip mark').length; return g + 'g/' + h + 'h/' + m + 'm'; })()")
echo "search results: $RES"
[[ "$RES" == "1g/1h/1m" ]] && echo "PASS: real reply searchable + marked" || echo "FAIL: search ($RES)"

# jump to it
agent-browser press Enter >/dev/null
FLASH=""
for i in $(seq 1 30); do
  sleep 0.3
  FLASH=$(ev "(() => { const hit=document.querySelector('.msg-row.find-hit'); return hit ? 'FLASH' : '-'; })()")
  [ "$FLASH" = "FLASH" ] && break
done
echo "jump flash: $FLASH"
NEAR=$(ev "(() => { const r=document.querySelector('.msg-row.find-hit'); if(!r) return 'no-row'; const b=r.getBoundingClientRect(); return (b.top>0 && b.bottom<window.innerHeight) ? 'center' : 'off'; })()")
echo "near: $NEAR"
E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d))" 2>/dev/null || echo 0)
echo "page errors: $E"
[ "$FLASH" = "FLASH" ] && [ "$NEAR" = "center" ] && [ "$E" = "0" ] && echo "===== E2E REAL: ALL PASS =====" || echo "===== E2E REAL: CHECK ABOVE ====="
