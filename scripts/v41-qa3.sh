#!/bin/bash
# v41-qa3.sh — instrumented repro of the missing-render bug: send → watch DOM state every 2s.
DATA=/tmp/doomalay-v41qa3
PORT=8162
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41qa3
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41qa3-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"R","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
echo "SID=$SID"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'R',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null
echo "panel state at t+2s: $(ev "(() => { const b=document.getElementById('chat-inputbar'); return b ? 'panel-open' : 'no-panel'; })()")"

# dump state at intervals before AND after send
dump() {
  ev "(() => {
    const rows = [...document.querySelectorAll('#chat-messages > *')].map(r => r.className.split(' ')[0] + (r.className.split(' ')[1]||''));
    const act = document.querySelector('[class*=activity], .turn-ind, #chat-activity');
    const btn = document.getElementById('chat-send');
    const think = document.querySelectorAll('[class*=think]').length;
    const pills = document.querySelectorAll('.tool-pill, [class*=pill]').length;
    return JSON.stringify({rows: rows.join(','), n: rows.length, act: act ? act.textContent.slice(0,40) : 'none', btn: btn ? btn.textContent : 'none', think: think, pills: pills});
  })()"
  echo ""
}
echo "t=0 (panel just opened):"; dump
sleep 2
echo "t=2:"; dump
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Reply with exactly: QA turn green'; return 1; })()" >/dev/null
agent-browser click "#chat-send" >/dev/null
for t in 2 4 6 8 10 14 20; do
  sleep 2
  echo "t=send+$t:"; dump
done
echo "=== console:"
agent-browser console 2>/dev/null | tail -15
echo "=== errors:"
agent-browser errors 2>/dev/null | tail -5
echo "=== WS frames seen by network:"
agent-browser network requests --filter "chat" 2>/dev/null | tail -8