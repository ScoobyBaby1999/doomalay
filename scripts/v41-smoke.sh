#!/bin/bash
# v41-smoke.sh — quick smoke: search endpoint + view + jump (one invocation).
DATA=/tmp/doomalay-v41smoke
PORT=8164
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41smoke
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41smoke-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

# seed two chats with distinct content
SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Pineapple Lab","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
SIDB=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Weather Desk","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
for i in $(seq 1 8); do
  curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d "{\"type\":\"user\",\"text\":\"pineapple question $i about tropical quantum farming\"}" >/dev/null
  curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d "{\"type\":\"assistant\",\"text\":\"Answer $i: the pineapple thrives in superposed bromelain fields across many harvests and longitudinal studies.\"}" >/dev/null
done
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"user","text":"will it rain in beirut tomorrow"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"assistant","text":"The forecast says sunny with a chance of pineapple-free skies."}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
echo "seeded A=$SIDA B=$SIDB"

echo "=== 1. API search:"
curl -s "$BASE/api/search?q=pineapple" | python3 -m json.tool | head -30
echo "=== 2. API search (weather, no hits in A):"
curl -s "$BASE/api/search?q=beirut" | python3 -c "import json,sys; d=json.load(sys.stdin); print('groups:', len(d['results']), [g['title'] for g in d['results']])"

agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
# icon for chat A only
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Pineapple Lab',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SIDA'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5

echo "=== 3. open dock + search view (bare canvas path):"
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.5
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1.2
VIEW=$(ev "(() => { const i = document.getElementById('gs-input'); const t = document.querySelector('.panel-header .name, #panel-title'); return (i ? 'input-present' : 'no-input') + '|' + (t ? t.textContent : 'no-title'); })()")
echo "view: $VIEW"

echo "=== 4. type + live results:"
agent-browser eval "(() => { const i = document.getElementById('gs-input'); i.value='pineapple'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()" >/dev/null
sleep 1.5
RES=$(ev "(() => { const groups = document.querySelectorAll('.gs-group').length; const hits = document.querySelectorAll('.gs-hit').length; const marks = document.querySelectorAll('.gs-snip mark').length; const count = (document.getElementById('gs-count')||{}).textContent || ''; return groups + ' groups / ' + hits + ' hits / ' + marks + ' marks / count=' + count; })()")
echo "results: $RES"

echo "=== 5. no-results state:"
agent-browser eval "(() => { const i = document.getElementById('gs-input'); i.value='zebraunicorn'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.2
EMPTY=$(ev "(() => (document.querySelector('.gs-empty') ? document.querySelector('.gs-empty').textContent.trim() : 'none'))()")
echo "empty: $EMPTY"

echo "=== 6. jump: search weather chat (has NO icon → materializes one) + row flash:"
agent-browser eval "(() => { const i = document.getElementById('gs-input'); i.value='beirut'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.2
HIT=$(ev "(() => { const h = document.querySelector('.gs-hit'); if (!h) return 'no-hits'; h.click(); return 'clicked'; })()")
echo "hit click: $HIT"
sleep 3.5
JUMP=$(ev "(() => { const row = document.querySelector('[data-ei] .msg-bubble, .msg-row[data-ei]'); const hit = document.querySelector('.msg-row.find-hit, [data-ei].find-hit'); const title = (document.querySelector('.panel-header .name')||{}).textContent || ''; const icons = (window.doomalay && window.doomalay.getFamily) ? 'api-ok' : 'no-api'; return 'row=' + (row ? 'yes' : 'no') + ' flash=' + (hit ? 'YES' : 'no') + ' title=' + title + ' ' + icons; })()")
echo "jump state: $JUMP"
sleep 2.5
FLASH=$(ev "(() => { const hit = document.querySelector('.msg-row.find-hit, [data-ei].find-hit'); const near = (() => { const s = document.getElementById('chat-scroll'); const r = document.querySelector('[data-ei]'); if (!s || !r) return false; const rb = r.getBoundingClientRect(); return rb.top > 0 && rb.bottom < window.innerHeight; })(); return 'flash-now=' + (hit ? 'yes' : 'cleared') + ' near-center=' + near; })()")
echo "flash decay: $FLASH"

echo "=== 7. errors:"
E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d))" 2>/dev/null || echo 0)
echo "page errors: $E"
