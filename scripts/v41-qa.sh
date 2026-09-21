#!/bin/bash
# v41-qa.sh — QA v0.40.0 as a real user via agent-browser (real vault + real NIM key).
# Boots engine + browser in ONE invocation (sandbox rule). Quote-safe eval helper.
DATA=/tmp/doomalay-v41qa
PORT=8161
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41qa
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41qa-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot + health" || bad "engine boot"

SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"QA","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' \
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
echo "sessions: A=$SIDA B=$SIDB"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5

seticon() { agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'$2',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'$3',provider:'nvidia',sessionId:'$1'}],savedAt:Date.now()}))" >/dev/null; agent-browser reload >/dev/null; sleep 1.5; agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5; }

ERRCOUNT() { agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d))" 2>/dev/null || echo 0; }

# ---- 1. page errors baseline ----
check "$(ERRCOUNT)" "0" "zero page errors at boot"

# ---- 2. fresh chat: starters + ring (both live in the open panel) ----
seticon "$SIDA" "QA" "nvidia/openai/gpt-oss-20b"
STARTERS=$(ev "String(document.querySelectorAll('#chat-starters .starter-chip').length)")
check "$STARTERS" "3" "starter chips count"
RING=$(ev "(() => { const r = document.querySelector('.ctx-ring'); if (!r) return 'missing'; const cs = getComputedStyle(r); return cs.display + '|' + Math.round(r.getBoundingClientRect().width); })()")
echo "ring: $RING"
[[ "$RING" == block* ]] && ok "ctx-ring display:block" || bad "ctx-ring ($RING)"

# ---- 3. REAL TURN with gpt-oss-20b (real key, real stream) ----
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Reply with exactly: QA turn green'; return c.value.length; })()" >/dev/null
agent-browser click "#chat-send" >/dev/null
REPLY=""
for i in $(seq 1 90); do
  sleep 1
  REPLY=$(ev "(() => { const rows = document.querySelectorAll('#chat-messages .msg-row-assistant'); return rows.length ? (rows[rows.length-1].textContent||'').slice(0,200) : ''; })()")
  echo "$REPLY" | grep -qi "green" && break
done
echo "reply: $REPLY"
echo "$REPLY" | grep -qi "green" && ok "real turn completed (gpt-oss-20b)" || bad "real turn ($REPLY)"
TURNTS=$(ev "(() => { const rows=[...document.querySelectorAll('#chat-messages .msg.assistant .msg-time')]; return rows.length ? rows[rows.length-1].textContent.trim() : 'none'; })()")
echo "turn timestamp: $TURNTS"
[[ "$TURNTS" != "none" && -n "$TURNTS" ]] && ok "assistant row carries timestamp ($TURNTS)" || bad "assistant timestamp ($TURNTS)"
# starters ride out on first message
S2=$(ev "String(document.querySelectorAll('#chat-starters .starter-chip').length)")
check "$S2" "0" "starters ride out after first message"

# ---- 4. long chat: find bar geometry + behavior ----
seticon "$SIDB" "Long" "nvidia/openai/gpt-oss-20b"
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); if (s) { s.scrollTop = s.scrollHeight/2; s.dispatchEvent(new Event('scroll')); } return 'ok'; })()" >/dev/null; sleep 0.5
FB=$(ev "(() => { const b=[...document.querySelectorAll('#chat-inputbar button, #chat-toolbar button')].find(x=>/find/i.test(x.getAttribute('aria-label')||'') || /find/i.test(x.getAttribute('title')||'') || /find/i.test(x.textContent||'')); if(!b) return 'no-btn'; b.click(); return 'clicked'; })()")
sleep 0.7
GEO=$(ev "(() => { const bar = document.getElementById('chat-find'); if (!bar) return 'no-bar'; const r = bar.getBoundingClientRect(); const inp = bar.querySelector('input'); const c = inp ? document.elementFromPoint(inp.getBoundingClientRect().x+5, inp.getBoundingClientRect().y+5) : null; const covered = c && c !== inp && !bar.contains(c); return Math.round(r.height) + 'px' + (covered ? ' COVERED' : ' clear'); })()")
echo "find geometry: $GEO"
[[ "$GEO" == *clear ]] && ok "find bar visible & uncovered ($GEO)" || bad "find bar geometry ($GEO)"
CNT=$(agent-browser eval "(() => { const i = document.querySelector('#chat-find-input'); if(!i) return 'no-input'; i.value='pineapples'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()" >/dev/null; sleep 0.6; ev "(() => { const el=document.getElementById('chat-find-count'); return el ? el.textContent.trim() : 'nocount'; })()")
echo "find count: $CNT"
[[ "$CNT" =~ ^[0-9]+/[0-9]+$ ]] && ok "find live count ($CNT)" || bad "find count ($CNT)"
# walk matches + highlight visible
HIT=$(ev "(() => { const h = document.querySelector('.find-hit, mark, [class*=find-hit]'); return h ? 'hit' : 'none'; })()")
[[ "$HIT" == hit ]] && ok "find hit highlight rendered" || bad "find highlight ($HIT)"
agent-browser press Escape >/dev/null; sleep 0.4
CL=$(ev "(() => { const b = document.getElementById('chat-find'); return b ? b.classList.contains('open') : 'gone'; })()")
check "$CL" "false" "Esc closes find bar"

# ---- 5. jump pill ----
agent-browser eval "(() => { const s=document.getElementById('chat-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); return 'ok'; })()" >/dev/null; sleep 0.8
PILL=$(ev "(() => { const p = document.getElementById('jump-latest'); if (!p) return 'none'; const cs = getComputedStyle(p); return cs.display + '/' + cs.visibility; })()")
echo "jump pill: $PILL"
[[ "$PILL" == block* || "$PILL" == flex* || "$PILL" == inline-flex* ]] && ok "jump pill visible when scrolled up" || bad "jump pill ($PILL)"
agent-browser eval "(() => { const p = document.getElementById('jump-latest'); if (p) p.click(); return 'ok'; })()" >/dev/null; sleep 1
ATBOT=$(ev "(() => { const s=document.getElementById('chat-scroll'); return String(Math.abs(s.scrollHeight - s.scrollTop - s.clientHeight) < 40); })()")
check "$ATBOT" "true" "jump pill scrolls to bottom"

# ---- 6. draft persistence across reload ----
agent-browser eval "(() => { const c=document.getElementById('chat-input'); c.value='my precious draft v41'; c.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()" >/dev/null; sleep 0.9
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
DRAFT=$(ev "(() => { const c=document.getElementById('chat-input'); return c ? c.value : 'no-input'; })()")
check "$DRAFT" "my precious draft v41" "draft survives reload"

# ---- 7. final errors ----
check "$(ERRCOUNT)" "0" "zero page errors at end"

echo "===== v0.40 QA RESULT: $PASS PASS / $FAIL FAIL ====="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
