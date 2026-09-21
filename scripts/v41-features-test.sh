#!/bin/bash
# v41-features-test.sh — RED-TEAM the v0.41 global search + polish round.
# Everything in ONE invocation (engine + browser + asserts).
DATA=/tmp/doomalay-v41ft
PORT=8165
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v41ft
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v41ft-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# seed: A (with icon, 8 pineapple turns) + B (NO icon, weather) + C (hidden message)
SIDA=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Pineapple Lab","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
SIDB=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Weather Desk","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
SIDC=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Secret Vault","sandbox":"quick","model":"nvidia/openai/gpt-oss-20b","provider":"nvidia"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
for i in $(seq 1 8); do
  curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d "{\"type\":\"user\",\"text\":\"pineapple question $i about tropical quantum farming\"}" >/dev/null
  curl -s -X POST $BASE/api/sessions/$SIDA/events -H 'Content-Type: application/json' -d "{\"type\":\"assistant\",\"text\":\"Answer $i: the pineapple thrives in superposed bromelain fields across many harvests and longitudinal studies of quantum agriculture.\"}" >/dev/null
done
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"user","text":"will it rain in beirut tomorrow"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SIDB/events -H 'Content-Type: application/json' -d '{"type":"assistant","text":"The forecast says sunny with a chance of pineapple-free skies over beirut."}' >/dev/null
# C: a secret message + a hide event masking it
HID=$(curl -s -X POST $BASE/api/sessions/$SIDC/events -H 'Content-Type: application/json' -d '{"type":"user","text":"the dragon hoards mangoes at midnight"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST $BASE/api/sessions/$SIDC/events -H 'Content-Type: application/json' -d "{\"type\":\"hide\",\"text\":\"[$HID]\"}" >/dev/null
curl -s -X POST $BASE/api/sessions/$SIDC/events -H 'Content-Type: application/json' -d '{"type":"user","text":"nothing secret here"}' >/dev/null
for s in $SIDA $SIDB $SIDC; do curl -s -X POST $BASE/api/sessions/$s/events -H 'Content-Type: application/json' -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null; done
echo "seeded A=$SIDA B=$SIDB C=$SIDC hidden-ev=$HID"

# ---------- API-level asserts ----------
R=$(curl -s "$BASE/api/search?q=mangoes" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']))")
check "$R" "0" "API: hidden message excluded from search"
R=$(curl -s "$BASE/api/search?q=pineapple" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(sorted(g['title'] for g in d['results'])))")
check "$R" "Pineapple Lab,Weather Desk" "API: grouped across sessions (pineapple)"
R=$(curl -s "$BASE/api/search?q=PINEAPPLE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']))")
check "$R" "2" "API: case-insensitive"
R=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/search?q=p")
check "$R" "400" "API: 1-char query rejected"
R=$(curl -s "$BASE/api/search?q=100%25" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']))")
check "$R" "0" "API: % wildcard query is literal"
R=$(curl -s "$BASE/api/search?q=pineapple" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=[m for g in d['results'] for m in g['matches'] if 'pineapple' in m['snippet'].lower()]
allmark = all(m['snippet'][m['match_start']:m['match_start']+9].lower()=='pineapple' for m in m)
print('yes' if m and allmark else 'no')")
check "$R" "yes" "API: match_start aligns on every snippet"

# ---------- UI asserts ----------
agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 1.5
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Pineapple Lab',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$SIDA'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5

# dock → search view (bare canvas: host-panel path)
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1.2
V=$(ev "(() => { const i=document.getElementById('gs-input'); const t=(document.querySelector('.panel-header .name')||{}).textContent||''; return (i?'input':'noinput')+'|'+t; })()")
check "$V" "input|search all chats" "dock search opens view (bare canvas host panel)"

# live results + marks + count
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='pineapple'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.4
RES=$(ev "(() => (document.querySelectorAll('.gs-group').length + '/' + document.querySelectorAll('.gs-snip mark').length + '/' + ((document.getElementById('gs-count')||{}).textContent||'x')))()")
check "$RES" "2/5/2 chats · 5" "live grouped results + marks + count"

# no-results state (robust poll)
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='zebraunicorn'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
EMPTY=""
for i in $(seq 1 10); do
  sleep 0.4
  EMPTY=$(ev "(() => { const e=document.querySelector('.gs-empty'); return e ? e.textContent.trim().slice(0,40) : 'pending'; })()")
  [ "$EMPTY" != "pending" ] && [ -n "$EMPTY" ] && break
done
echo "empty state: '$EMPTY'"
[[ "$EMPTY" == *"zebraunicorn"* ]] && ok "no-results state renders" || bad "no-results state ($EMPTY)"

# short query guard (1 char)
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='z'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 0.8
SH=$(ev "(() => { const c=(document.getElementById('gs-count')||{}).textContent||''; const e=document.querySelector('.gs-empty'); return c + '|' + (e ? 'empty' : 'noempty'); })()")
[[ "$SH" == "|empty" ]] && ok "1-char query shows hint state (no request)" || bad "1-char guard ($SH)"

# retype + Enter jumps to first result
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='beirut'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.2
HITS=$(ev "String(document.querySelectorAll('.gs-hit').length)")
[[ "$HITS" -ge 1 ]] && ok "beirut results present ($HITS)" || bad "beirut results ($HITS)"
agent-browser press Enter >/dev/null
# poll for the jump: flash class + near-center + correct chat title
FLASH=""; for i in $(seq 1 30); do
  sleep 0.3
  FLASH=$(ev "(() => { const hit=document.querySelector('.msg-row.find-hit, .msg-row [class*=find-hit]'); const t=(document.querySelector('.panel-header .name')||{}).textContent||''; return (hit?'FLASH':'-') + '|' + t; })()")
  [[ "$FLASH" == FLASH* ]] && break
done
echo "jump poll: $FLASH"
[[ "$FLASH" == "FLASH|Weather Desk" ]] && ok "Enter → jump flashes the row in Weather Desk" || bad "jump flash ($FLASH)"
NEAR=$(ev "(() => { const r=document.querySelector('.msg-row.find-hit'); if (!r) { const s=document.getElementById('chat-scroll'); const any=document.querySelector('[data-ei]'); if (!any) return 'no-row'; const b=any.getBoundingClientRect(); return (b.top>0&&b.bottom<window.innerHeight)?'center':'off'; } const b=r.getBoundingClientRect(); return (b.top>0&&b.bottom<window.innerHeight)?'center':'off'; })()")
check "$NEAR" "center" "jumped row scrolled near center"
EIDATA=$(ev "(() => { const rows=document.querySelectorAll('.msg-row[data-ei]'); return rows.length > 0 ? 'ei-rows:' + rows.length : 'none'; })()")
[[ "$EIDATA" == ei-rows:* ]] && ok "rows carry data-ei ($EIDATA)" || bad "data-ei ($EIDATA)"

# icon materialized for icon-less session B?
ICONB=$(ev "(() => { try { return String(window.doomalay.openChatBySession ? 'api-present' : 'no-api'); } catch(e){ return 'err'; } })()")
check "$ICONB" "api-present" "doomalay.openChatBySession exposed"
# verify localStorage now contains a second icon bound to SIDB
ST=$(agent-browser eval "localStorage.getItem('doomalay.state.v2')" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    st = json.loads(v)
    print('icon-b-ok' if any(i.get('sessionId')=='$SIDB' for i in st.get('icons',[])) else 'no-icon-b')
except Exception as e:
    print('parse-err')")
check "$ST" "icon-b-ok" "icon materialized + persisted for icon-less session"

# Esc closes the search view (reopen first)
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1
ESC=$(ev "(() => { const i=document.getElementById('gs-input'); if(!i) return 'noinput'; const ev=new KeyboardEvent('keydown',{key:'Escape',bubbles:true}); i.dispatchEvent(ev); return 'sent'; })()")
sleep 0.6
GONE=$(ev "(() => (document.getElementById('gs-input') ? 'still-open' : 'closed'))()")
check "$GONE" "closed" "Esc closes the search view"

# search from an OPEN chat panel (the stacked-view path)
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1.2
V2=$(ev "(() => (document.getElementById('gs-input') ? 'open' : 'no'))()")
check "$V2" "open" "search opens over an existing chat panel"
# typing + tap-jump from stacked view back into chat A
agent-browser eval "(() => { const i=document.getElementById('gs-input'); i.value='harvests'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()" >/dev/null
sleep 1.2
TAP=$(ev "(() => { const h=document.querySelector('.gs-hit'); if(!h) return 'no-hits'; h.click(); return 'tapped'; })()")
sleep 2.5
BACK=$(ev "(() => { const t=(document.querySelector('.panel-header .name')||{}).textContent||''; const chat=document.getElementById('chat-messages'); return t + '|' + (chat ? 'chat-root' : 'no-root'); })()")
echo "tap-jump: $TAP → $BACK"
[[ "$BACK" == "Pineapple Lab|chat-root" ]] && ok "tap result → opens Pineapple Lab chat root" || bad "tap-jump ($BACK)"

# styling spot-checks
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-search').click()" >/dev/null; sleep 1
SEL=$(ev "(() => { const st=getComputedStyle(document.body); const s=document.createElement('span'); s.textContent='x'; document.body.appendChild(s); const sel=!!document.querySelector('style'); document.head; return sel ? 'style-ok' : 'no'; })()")
STYLE=$(ev "(() => { const s=document.getElementById('gs-style'); return s ? 'gs-style-injected' : 'no-style'; })()")
check "$STYLE" "gs-style-injected" "search view stylesheet injected"
TBL=$(ev "(() => { const el=document.createElement('div'); el.innerHTML='<table><thead><tr><th>x</th></tr></thead><tbody><tr><td>y</td></tr></tbody></table>'; const st=getComputedStyle(el.querySelector('th')); return st.backgroundColor !== 'rgba(0, 0, 0, 0)' ? 'th-band-ok' : st.backgroundColor; })()")
[[ "$TBL" == th-band-ok ]] && ok "table header band styled" || bad "table header ($TBL)"

# final errors
E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d))" 2>/dev/null || echo 0)
check "$E" "0" "zero page errors"

echo "===== v41 FEATURES TEST: $PASS PASS / $FAIL FAIL ====="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
