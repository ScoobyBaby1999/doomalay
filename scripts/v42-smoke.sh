#!/bin/bash
# v42-smoke.sh — quick smoke of the v0.42 surface: /api/chats endpoint,
# dock 💬 → chats view → sections → tap → open; ? overlay; Ctrl+F; Ctrl+K.
DATA=/tmp/doomalay-v42smoke
PORT=8176
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v42smoke
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v42smoke-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

# seed: two chats with events + one bare session
SID1=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Harbor Log","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID1/events -H 'Content-Type: application/json' -d '{"type":"user","text":"tell me about the lighthouse"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID1/events -H 'Content-Type: application/json' -d '{"type":"assistant","text":"The lighthouse blinks twice every nine seconds across the fog."}' >/dev/null
SID2=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Garden Notes","sandbox":"quick","model":"nvidia/z-ai/glm-5.3","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID2/events -H 'Content-Type: application/json' -d '{"type":"user","text":"best soil for ferns?"}' >/dev/null
echo "seeded $SID1 $SID2"

echo "=== 1. /api/chats API"
curl -s "$BASE/api/chats" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d['chats']:
    print(' -', c['title'], '| model:', c['model'], '| msgs:', c['msg_count'], '| preview:', (c['preview'] or '')[:50], '| role:', c['preview_role'])
print('total:', len(d['chats']))"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

echo "=== 2. dock 💬 → chats view"
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
CHATSBTN=$(ev "(() => { const b = document.getElementById('dock-chats'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()")
sleep 2
VIEW=$(ev "(() => { const c = document.getElementById('cv-count'); const secs = document.querySelectorAll('.cv-section').length; const rows = document.querySelectorAll('.cv-row').length; return 'count=' + (c?c.textContent:'none') + ' sections=' + secs + ' rows=' + rows; })()")
echo "  btn: $CHATSBTN | view: $VIEW"

echo "=== 3. row content"
ROW=$(ev "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$SID1\"]'); if (!r) return 'no-row'; const name = r.querySelector('.cv-name').textContent; const prev = r.querySelector('.cv-preview').textContent; const badge = r.querySelector('.cv-badge').textContent; const n = r.querySelector('.cv-nmsgs').textContent; return name + ' | ' + prev.slice(0,40) + ' | badge=' + badge + ' | ' + n; })()")
echo "  row: $ROW"

echo "=== 4. tap row → chat opens"
agent-browser eval "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$SID2\"]'); if (r) r.click(); return 'tapped'; })()" >/dev/null
sleep 3.5
OPENED=$(ev "(() => { const t = (document.querySelector('.panel-header .name')||{textContent:''}).textContent; const msgs = document.querySelectorAll('#chat-messages .msg-row').length; return 'title=' + t + ' msgs=' + msgs; })()")
echo "  opened: $OPENED"

echo "=== 5. ? overlay"
agent-browser press Escape >/dev/null; sleep 0.5
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser keyboard type "?" >/dev/null; sleep 0.6
OV=$(ev "(() => { const o = document.getElementById('kb-overlay'); if (!o) return 'no-overlay'; const secs = o.querySelectorAll('.kb-sec').length; const rows = o.querySelectorAll('.kb-row').length; const kbds = o.querySelectorAll('.kbd').length; return 'overlay secs=' + secs + ' rows=' + rows + ' kbds=' + kbds; })()")
echo "  $OV"
agent-browser press Escape >/dev/null; sleep 0.4
OVC=$(ev "(() => document.getElementById('kb-overlay') ? 'still-open' : 'closed')()")
echo "  after Esc: $OVC"

echo "=== 6. Ctrl+F → find bar (with chat open)"
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
agent-browser press Control+f >/dev/null; sleep 0.6
FIND=$(ev "(() => { const b = document.getElementById('chat-find'); return b ? 'find-open h=' + Math.round(b.getBoundingClientRect().height) : 'no-find'; })()")
echo "  $FIND"

echo "=== 7. Ctrl+K → global search view"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser press Control+k >/dev/null; sleep 1.2
GSR=$(ev "(() => { const i = document.getElementById('gs-input'); return i ? 'search-view-open' : 'no-search-view'; })()")
echo "  $GSR"

echo "=== 8. errors"
E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "  errors: $E"
