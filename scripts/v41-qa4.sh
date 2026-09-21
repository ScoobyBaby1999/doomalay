#!/bin/bash
# v41-qa4.sh — capture ALL events the client receives (patch ChatClient before panel open).
DATA=/tmp/doomalay-v41qa4
PORT=8163
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41qa4
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41qa4-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"W","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
echo "SID=$SID"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'W',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5

# PATCH ChatClient BEFORE the panel opens: wrap onEvent with a logger.
agent-browser eval "(() => {
  window.__evLog = [];
  const Orig = window.ChatClient;
  function Logged(baseUrl, sessionId, token) {
    const c = new Orig(baseUrl, sessionId, token);
    const setOn = (v) => { c.onEvent = v; };
    let cur = null;
    Object.defineProperty(c, 'onEvent', {
      get() { return cur; },
      set(v) {
        cur = v ? function(ev) {
          window.__evLog.push({t: Math.round(performance.now()), type: ev.type, i: ev.i, seq: ev.seq, text: (ev.text||ev.state||'').slice(0,30)});
          v(ev);
        } : v;
      }
    });
    return c;
  }
  window.ChatClient = Logged;
  return 'patched';
})()"

agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null
sleep 3
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Reply with exactly: QA turn green'; return 1; })()" >/dev/null
agent-browser click "#chat-send" >/dev/null

for t in 5 10 15 25 40; do
  sleep $(( t == 5 ? 5 : t - 10 > 0 ? t - 10 : 5 ))
  echo "=== events received by t≈${t}s:"
  ev "JSON.stringify(window.__evLog)"
  echo ""
  ROWS=$(ev "String(document.querySelectorAll('#chat-messages > *').length)")
  echo "DOM rows: $ROWS"
  if [ "$ROWS" -ge 4 ]; then break; fi
done
echo "=== console:"; agent-browser console 2>/dev/null | tail -8
echo "=== final DOM:"
ev "(() => { return [...document.querySelectorAll('#chat-messages > *')].map(r => r.className + '::' + (r.textContent||'').slice(0,40)).join(' || '); })()"
echo ""