#!/bin/bash
# v41-qa2.sh — focused re-test: real turn (180s window, stream state visible), jump pill (#chat-jump), Esc behavior.
DATA=/tmp/doomalay-v41qa
PORT=8161
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41qa2
PASS=0; FAIL=0
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
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1' want '$2')"; fi; }

rm -rf $DATA; mkdir -p $DATA
cp -r /tmp/doomalay-v38nt/* $DATA/
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41qa2-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"QA2","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
SIDB=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Long","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
for i in $(seq 1 14); do
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"user\",\"text\":\"question $i about pineapples and quantum entanglement theories\"}" >/dev/null
  curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d "{\"type\":\"assistant\",\"text\":\"Answer $i: pineapples grow quantum crowns in tropical superposition. The entanglement of bromelain and spacetime is well documented across many universes and longitudinal studies of fruit-bearing physics.\"}" >/dev/null
done
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
seticon() { agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'$2',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'$3',provider:'nvidia',sessionId:'$1'}],savedAt:Date.now()}))" >/dev/null; agent-browser reload >/dev/null; sleep 1.5; agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5; }

# ---- REAL TURN, 180s window, watch state transitions ----
seticon "$SIDA" "QA2" "nvidia/openai/gpt-oss-20b"
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Reply with exactly: QA turn green'; return 1; })()" >/dev/null
T0=$(date +%s)
agent-browser click "#chat-send" >/dev/null
REPLY=""; DONE=0
for i in $(seq 1 180); do
  sleep 1
  REPLY=$(ev "(() => { const rows = document.querySelectorAll('#chat-messages .msg-row-assistant'); return rows.length ? (rows[rows.length-1].textContent||'').slice(0,150) : ''; })()")
  if echo "$REPLY" | grep -qi "green"; then DONE=$i; break; fi
done
T1=$(date +%s)
echo "reply after ${DONE}s: $REPLY"
if [ "$DONE" -gt 0 ]; then ok "real turn completed in ${DONE}s"; else
  STATE=$(ev "(() => { const r=document.querySelector('#chat-messages .status, .turn-status, [class*=status]'); const notices=[...document.querySelectorAll('.notice,[class*=notice]')].map(n=>n.textContent.slice(0,60)); return (r?r.textContent.trim():'nostatus') + ' ||| notices: ' + notices.join(' ; '); })()")
  echo "stuck state: $STATE"
  bad "real turn did not complete in 180s"
fi
TURNTS=$(ev "(() => { const rows=[...document.querySelectorAll('#chat-messages .msg.assistant .msg-time')]; return rows.length ? rows[rows.length-1].textContent.trim() : 'none'; })()")
[[ -n "$TURNTS" && "$TURNTS" != "none" ]] && ok "assistant timestamp ($TURNTS)" || bad "assistant timestamp ($TURNTS)"
ERRS=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d))" 2>/dev/null || echo 0)
check "$ERRS" "0" "zero page errors after turn"

# ---- jump pill (correct id #chat-jump) ----
seticon "$SIDB" "Long" "nvidia/openai/gpt-oss-20b"
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); return 'ok'; })()" >/dev/null; sleep 0.8
PILL=$(ev "(() => { const p = document.getElementById('chat-jump'); if (!p) return 'none'; const cs = getComputedStyle(p); const r = p.getBoundingClientRect(); return cs.display + '/' + cs.visibility + '/' + (r.width>0?'w'+Math.round(r.width):'w0') + '/' + p.className; })()")
echo "jump pill: $PILL"
[[ "$PILL" == flex/* || "$PILL" == block/* || "$PILL" == inline-flex/* ]] && ok "jump pill present when scrolled up" || bad "jump pill ($PILL)"
VIS=$(ev "(() => { const p = document.getElementById('chat-jump'); const r = p.getBoundingClientRect(); const c = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2); return c === p || p.contains(c) ? 'visible' : 'occluded'; })()")
check "$VIS" "visible" "jump pill hit-test visible"
agent-browser eval "(() => { document.getElementById('chat-jump').click(); return 'ok'; })()" >/dev/null; sleep 1.2
ATBOT=$(ev "(() => { const s=document.getElementById('chat-scroll'); return String(Math.abs(s.scrollHeight - s.scrollTop - s.clientHeight) < 40); })()")
check "$ATBOT" "true" "jump click scrolls to bottom"
HIDE=$(ev "(() => { const p=document.getElementById('chat-jump'); return p ? String(p.classList.contains('show')) : 'gone'; })()")
check "$HIDE" "false" "pill hides at bottom"

# ---- Esc: find bar closes (either removed or .open removed) ----
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = s.scrollHeight/2; s.dispatchEvent(new Event('scroll')); return 'ok'; })()" >/dev/null; sleep 0.4
agent-browser eval "(() => { const b=[...document.querySelectorAll('#chat-inputbar button, #chat-toolbar button')].find(x=>/find/i.test(x.getAttribute('aria-label')||'')||/find/i.test(x.getAttribute('title')||'')||/find/i.test(x.textContent||'')); if(b) b.click(); return 'ok'; })()" >/dev/null; sleep 0.6
OPEN=$(ev "(() => { const b=document.getElementById('chat-find'); return b ? String(b.classList.contains('open')) : 'absent'; })()")
check "$OPEN" "true" "find bar opens"
agent-browser press Escape >/dev/null; sleep 0.5
ESCAPED=$(ev "(() => { const b=document.getElementById('chat-find'); return !b || !b.classList.contains('open') ? 'closed' : 'still-open'; })()")
check "$ESCAPED" "closed" "Esc closes find bar"

echo "===== FOCUSED QA RESULT: $PASS PASS / $FAIL FAIL ====="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
