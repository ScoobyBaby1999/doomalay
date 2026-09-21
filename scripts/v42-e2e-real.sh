#!/bin/bash
# v42-e2e-real.sh — REAL-USER E2E for v0.42: a real gpt-oss-20b turn (real NIM
# key) → close panel → dock 💬 → the chats index lists the chat with the
# reply as preview → tap → the chat reopens showing the conversation.
DATA=/tmp/doomalay-v42e2e
PORT=8182
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v42e2e
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v42e2e-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"E2E Chats","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
echo "session $SID"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'E2E Chats',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3

echo "=== 1. REAL TURN (gpt-oss-20b, real key)"
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.value = 'Mention the word salt-cedar-grove exactly once in a one-sentence reply.'; return 1; })()" >/dev/null
agent-browser click "#chat-send" >/dev/null
REPLY=""
for i in $(seq 1 150); do
  sleep 1
  REPLY=$(ev "(() => { const rows = document.querySelectorAll('#chat-messages .msg-row-assistant'); return rows.length ? (rows[rows.length-1].textContent||'').slice(0,120) : ''; })()")
  echo "$REPLY" | grep -qi "salt-cedar" && break
done
echo "  reply: $REPLY"
echo "$REPLY" | grep -qi "salt-cedar" && echo "  PASS: real turn completed" || echo "  FAIL: real turn"

echo "=== 2. close panel → dock 💬 → chats index"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-chats').click()" >/dev/null; sleep 2.5
IDX=$(ev "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$SID\"]'); if (!r) return 'no-row'; const name = r.querySelector('.cv-name').textContent; const prev = r.querySelector('.cv-preview').textContent; const role = r.querySelector('.cv-role') ? r.querySelector('.cv-role').textContent : ''; const n = r.querySelector('.cv-nmsgs').textContent; const sec = r.closest('.cv-section').querySelector('.cv-section-title').textContent.trim().split('\\n')[0]; return name + ' | ' + role + ' ' + prev.slice(0,60) + ' | ' + n + ' | ' + sec; })()")
echo "  index row: $IDX"
[[ "$IDX" == "E2E Chats"*"salt-cedar"*"2 msgs"*"Today"* ]] && echo "  PASS: real reply is the live preview in Today" || echo "  FAIL: index row ($IDX)"

echo "=== 3. tap → chat reopens with the conversation"
agent-browser eval "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$SID\"]'); if (r) r.click(); return 1; })()" >/dev/null
REOPEN=""
for i in $(seq 1 20); do
  sleep 0.5
  REOPEN=$(ev "(() => { const t = (document.querySelector('.panel-header .name')||{textContent:''}).textContent; const rows = document.querySelectorAll('#chat-messages .msg-row').length; const last = (document.querySelectorAll('#chat-messages .msg-row-assistant')||[]); const txt = last.length ? (last[last.length-1].textContent||'').slice(0,80) : ''; return 'title=' + t + ' rows=' + rows + ' last=' + txt; })()")
  echo "$REOPEN" | grep -q "rows=2" && break
done
echo "  reopened: $REOPEN"
[[ "$REOPEN" == "title=E2E Chats rows=2"*"salt-cedar"* ]] && echo "  PASS: reopened with full conversation" || echo "  FAIL: reopen ($REOPEN)"

echo "=== 4. errors"
E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "  page errors: $E"
[ "$E" = "0" ] && echo "  PASS: zero page errors" || echo "  FAIL: errors"
