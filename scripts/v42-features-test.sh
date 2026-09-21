#!/bin/bash
# v42-features-test.sh — RED-TEAM the v0.42 surface (mock-free, real DOM):
#  A) /api/chats API: order, previews, roles, counts, hide-masking, empty, cap
#  B) dock 💬 → chats view: sections, rows, badges, tap → open, back nav
#  C) self-sufficient host: empty canvas + sessions in DB → view opens hosted
#  D) keyboard layer: ? overlay (synthetic + Shift+Slash), Esc, Ctrl+F, Ctrl+K
#  E) styling spot-checks + zero page errors
DATA=/tmp/doomalay-v42ft
PORT=8181
BASE=http://127.0.0.1:$PORT
ENG=/home/z/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v42ft
PASS=0; FAIL=0
ok() { if [ "$1" = "0" ]; then PASS=$((PASS+1)); echo "  PASS $2"; else FAIL=$((FAIL+1)); echo "  FAIL $2"; fi; }
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v42ft-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done

echo "── A. /api/chats API ─────────────────────────────────"
mk() { curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d "{\"title\":\"$1\",\"sandbox\":\"$2\",\"model\":\"$3\",\"provider\":\"$4\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])'; }
ev_add() { curl -s -X POST $BASE/api/sessions/$1/events -H 'Content-Type: application/json' -d "$2" >/dev/null; }
TODAY=$(date +%s)
S1=$(mk "Harbor Log" quick "nvidia/openai/gpt-oss-20b" nvidia)
ev_add $S1 '{"type":"user","text":"tell me about the lighthouse at dusk"}'
ev_add $S1 '{"type":"assistant","text":"The lighthouse blinks twice every nine seconds across the fog."}'
S2=$(mk "Garden Notes" quick "nvidia/z-ai/glm-5.3" nvidia)
ev_add $S2 '{"type":"user","text":"best soil for ferns?"}'
S3=$(mk "Old Ledger" quick "nvidia/openai/gpt-oss-20b" nvidia)
ev_add $S3 '{"type":"user","text":"an old question about tides"}'
ev_add $S3 '{"type":"assistant","text":"the tide table from last winter"}'
# push Old Ledger 10 days back (bucket "Older") — PATCH has no updated_at
# field; touch the DB directly (python sqlite3, busy-timeout for the live engine)
python3 -c "
import sqlite3, sys
db = sqlite3.connect('$DATA/doomalay.db', timeout=5)
db.execute('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', ($TODAY - 864000, '$S3'))
db.commit(); db.close()
"
S4=$(mk "Research Desk" research "nvidia/openai/gpt-oss-120b" nvidia)
ev_add $S4 '{"type":"user","text":"study the migration of arctic terns"}'

echo "A1. order: most recently active first (relative — the vault carries older sessions)"
ORDER=$(curl -s $BASE/api/chats | python3 -c "
import json,sys
d=json.load(sys.stdin)
ids=[c['session_id'] for c in d['chats']]
p={sid:ids.index(sid) for sid in ['$S4','$S2','$S1','$S3'] if sid in ids}
rel = 'ok' if p.get('$S4',99) < p.get('$S2',99) < p.get('$S1',99) < p.get('$S3',99) else 'bad'
print(rel + ' pos=' + str(p))")
echo "  order: $ORDER"
[[ "$ORDER" == ok* ]]; ok $? "relative order S4 < S2 < S1 < S3 ($ORDER)"

echo "A2. preview = latest visible line + role"
P=$(curl -s $BASE/api/chats | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=[x for x in d['chats'] if x['session_id']=='$S1'][0]
print(c['preview'] + '|' + c['preview_role'] + '|' + str(c['msg_count']))")
echo "  S1: $P"
[[ "$P" == "The lighthouse blinks twice every nine seconds across the fog.|assistant|2" ]]; ok $? "preview + role + count"

echo "A3. hide-masking: delete the last message → preview walks down"
LASTEID=$(sqlite3 $DATA/doomalay.db "SELECT id FROM chat_events WHERE session_id='$S1' ORDER BY id DESC LIMIT 1" 2>/dev/null)
if [ -z "$LASTEID" ]; then
  # no sqlite3 CLI — fetch via events API
  LASTEID=$(curl -s "$BASE/api/sessions/$S1/events" | python3 -c "
import json,sys
d=json.load(sys.stdin)
evs=d.get('events',d) if isinstance(d,dict) else d
print(evs[-1]['i'] if evs else '')")
fi
ev_add $S1 "{\"type\":\"hide\",\"text\":\"[$LASTEID]\"}"
P2=$(curl -s $BASE/api/chats | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=[x for x in d['chats'] if x['session_id']=='$S1'][0]
print(c['preview'] + '|' + str(c['msg_count']))")
echo "  after hide: $P2 (eid=$LASTEID)"
[[ "$P2" == "tell me about the lighthouse at dusk|1" ]]; ok $? "hidden last message never previews"

echo "A4. bare session (no events): empty preview, zero count, still listed"
SB=$(mk "Bare Chat" quick "nvidia/openai/gpt-oss-20b" nvidia)
PB=$(curl -s $BASE/api/chats | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=[x for x in d['chats'] if x['session_id']=='$SB'][0]
print(c['preview'] + '|' + str(c['msg_count']))")
echo "  bare: $PB"
[[ "$PB" == "|0" ]]; ok $? "bare session shape"

echo "A5. long preview trimmed server-side"
SL=$(mk "Long Chat" quick "nvidia/openai/gpt-oss-20b" nvidia)
LONGTXT=$(python3 -c "print('the harbor lights ' * 40)")
ev_add $SL "{\"type\":\"user\",\"text\":\"$LONGTXT\"}"
PL=$(curl -s $BASE/api/chats | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=[x for x in d['chats'] if x['session_id']=='$SL'][0]
print(len(c['preview']), c['preview'][-1])")
echo "  long preview: len/endchar = $PL"
[[ "$PL" == "141 …" ]]; ok $? "preview clamped to 140 runes + ellipsis"

echo "── B. dock 💬 → chats view ───────────────────────────"
agent-browser set viewport 400 760 >/dev/null
agent-browser open $BASE/ >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
# world WITH an icon for S1 (the normal path)
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Harbor Log',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/openai/gpt-oss-20b',provider:'nvidia',sessionId:'$S1'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2

echo "B1. dock button → view with sections + rows"
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-chats').click()" >/dev/null; sleep 2
V=$(ev "(() => { const c = document.getElementById('cv-count'); const secs = document.querySelectorAll('.cv-section'); const rows = document.querySelectorAll('.cv-row'); const titles = [...secs].map(s => s.querySelector('.cv-section-title').textContent.trim().split('\\n')[0]); return (c?c.textContent:'none') + ' | sections=' + titles.join('/') + ' | rows=' + rows.length; })()")
echo "  view: $V"
[[ "$V" == *"chats"* && "$V" == *"Today"* && "$V" == *"Older"* ]]; ok $? "count chip + Today/Older sections ($V)"

echo "B2. row anatomy: name + role-marked preview + short-model badge + count"
R=$(ev "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$S1\"]'); if (!r) return 'no-row'; const name = r.querySelector('.cv-name').textContent; const role = r.querySelector('.cv-role') ? r.querySelector('.cv-role').textContent : 'none'; const badge = r.querySelector('.cv-badge').textContent; const dot = r.querySelector('.cv-dot') ? getComputedStyle(r.querySelector('.cv-dot')).backgroundColor : 'none'; const n = r.querySelector('.cv-nmsgs').textContent; return name + '/' + role + '/' + badge + '/' + n + '/dot=' + dot; })()")
echo "  row: $R"
[[ "$R" == "Harbor Log/you/gpt-oss-20b/1 msg/dot=rgb(118, 185, 0)" ]]; ok $? "row renders name/role/badge/count + nvidia-colored dot"

echo "B3. research tag on non-quick sandbox"
RT=$(ev "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$S4\"]'); return r && r.querySelector('.cv-tag') ? r.querySelector('.cv-tag').textContent : 'no-tag'; })()")
echo "  research tag: $RT"
[ "$RT" = "research" ]; ok $? "research sandbox gets the accent tag"

echo "B4. tap row → that chat opens (icon-less session materializes)"
agent-browser eval "(() => { const r = document.querySelector('.cv-row[data-cv-sid=\"$S2\"]'); if (r) r.click(); return 1; })()" >/dev/null; sleep 3.5
O=$(ev "(() => { const t = (document.querySelector('.panel-header .name')||{textContent:''}).textContent; const msgs = document.querySelectorAll('#chat-messages .msg-row').length; const icons = document.querySelectorAll('.chatbot').length; return 'title=' + t + ' msgs=' + msgs + ' icons=' + icons; })()")
echo "  opened: $O"
[[ "$O" == "title=Garden Notes msgs=1 icons=3" ]]; ok $? "tap → chat opens, icon materialized ($O; +Long Chat host +Garden Notes)"

echo "B5. ‹ back from a re-opened chats view returns to the chat root"
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-chats').click()" >/dev/null; sleep 2
agent-browser eval "(() => { const b = document.getElementById('panel-view-back'); if (b) { b.click(); return 'back'; } return 'no-back-btn'; })()" >/dev/null; sleep 1
RTN=$(ev "(() => { const c = document.getElementById('chat-input'); const cv = document.getElementById('cv-list'); return (c ? 'chat-root' : 'no-root') + '/' + (cv ? 'view-still' : 'view-gone'); })()")
echo "  after back: $RTN"
[[ "$RTN" == "chat-root/view-gone" ]]; ok $? "back pops the view, chat root restored"

echo "── C. self-sufficient host (empty canvas, sessions in DB) ──"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser eval "document.getElementById('dock-toggle').click()" >/dev/null; sleep 0.4
agent-browser eval "document.getElementById('dock-chats').click()" >/dev/null; sleep 2.5
CV=$(ev "(() => { const c = document.getElementById('cv-count'); const rows = document.querySelectorAll('.cv-row').length; const icons = document.querySelectorAll('.chatbot').length; return (c?c.textContent:'none') + ' rows=' + rows + ' icons=' + icons; })()")
echo "  empty-canvas view: $CV"
[[ "$CV" == *"chats"* && "$CV" == *"rows="* && "$CV" != "rows=0" && "$CV" == *"icons=1"* ]]; ok $? "no icons + sessions in DB → view hosted on most recent (icon materialized)"

echo "── D. keyboard layer ─────────────────────────────────"
echo "D1. ? opens the overlay (synthetic real-key event)"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser eval "(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true})); return 1; })()" >/dev/null; sleep 0.5
OV=$(ev "(() => { const o = document.getElementById('kb-overlay'); return o ? o.querySelectorAll('.kb-sec').length + 's/' + o.querySelectorAll('.kb-row').length + 'r/' + o.querySelectorAll('.kbd').length + 'k' : 'no'; })()")
echo "  overlay: $OV"
[ "$OV" = "4s/13r/20k" ]; ok $? "4 sections / 13 rows / 20 keycaps (merged alt-key rows)"

echo "D2. Shift+Slash path (physical key) opens it too"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser press Shift+Slash >/dev/null; sleep 0.5
OV2=$(ev "(() => document.getElementById('kb-overlay') ? 'OPEN' : 'no')()")
echo "  overlay2: $OV2"
[ "$OV2" = "OPEN" ]; ok $? "code=Slash+shift fallback works"

echo "D3. Esc closes the overlay"
agent-browser press Escape >/dev/null; sleep 0.4
OV3=$(ev "(() => document.getElementById('kb-overlay') ? 'still' : 'closed')()")
echo "  after Esc: $OV3"
[ "$OV3" = "closed" ]; ok $? "Esc closes the overlay"

echo "D4. ? while typing in an input does nothing"
agent-browser eval "(() => { window.doomalay.openChatBySession('$S1'); return 1; })()" >/dev/null; sleep 3
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.focus(); return 1; })()" >/dev/null; sleep 0.3
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.dispatchEvent(new KeyboardEvent('keydown', {key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true})); return 1; })()" >/dev/null; sleep 0.4
OV4=$(ev "(() => document.getElementById('kb-overlay') ? 'OPEN-BUG' : 'correctly-ignored')()")
echo "  typing guard: $OV4"
[ "$OV4" = "correctly-ignored" ]; ok $? "? ignored while typing in the composer"

echo "D5. Ctrl+F opens the live chat's find bar"
agent-browser eval "(() => { const c = document.getElementById('chat-input'); c.blur(); document.body.focus(); return 1; })()" >/dev/null; sleep 0.2
agent-browser press Control+f >/dev/null; sleep 0.7
F=$(ev "(() => { const b = document.getElementById('chat-find'); if (!b) return 'no'; const r = b.getBoundingClientRect(); const cov = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return 'h=' + Math.round(r.height) + ' covered=' + (cov && cov.closest('#chat-find') ? 'no' : 'CHECK'); })()")
echo "  find: $F"
[[ "$F" == "h=45 covered=no" ]]; ok $? "Ctrl+F opens find bar, visible"

echo "D6. Ctrl+F while a view is stacked → browser find (no crash, view intact)"
agent-browser press Escape >/dev/null; sleep 0.3
agent-browser press Control+k >/dev/null; sleep 1.2
agent-browser press Control+f >/dev/null; sleep 0.5
VF=$(ev "(() => { const gs = document.getElementById('gs-input'); const fb = document.getElementById('chat-find'); return 'gs=' + (gs ? 'up' : 'gone') + ' find=' + (fb ? 'OPEN-BUG' : 'not-opened-correct'); })()")
echo "  stacked: $VF"
[[ "$VF" == "gs=up find=not-opened-correct" ]]; ok $? "Ctrl+F suppressed while search view stacked"

echo "D7. Ctrl+K closes overlay / opens search from canvas"
agent-browser press Escape >/dev/null; sleep 0.4
agent-browser eval "(() => { const s=document.getElementById('chat-scrim'); if(s) s.click(); return 1; })()" >/dev/null; sleep 1
agent-browser press Control+k >/dev/null; sleep 1.5
K=$(ev "(() => { const i = document.getElementById('gs-input'); const p = document.querySelector('#chat-panel'); return 'gs=' + (i ? 'open' : 'no') + ' panel=' + (p && p.classList.contains('open') ? 'up' : 'down'); })()")
echo "  ctrl+k from canvas: $K"
[ "$K" = "gs=open panel=up" ]; ok $? "Ctrl+K opens search riding a host panel"

echo "── E. styling + errors ───────────────────────────────"
S=$(ev "(() => { const st = document.getElementById('cv-style'); const ks = document.getElementById('keys-style'); const scrim = document.querySelector('.kb-scrim'); return 'cv-style=' + (st ? 'yes' : 'no') + ' keys-style=' + (ks ? 'yes' : 'no'); })()")
echo "  styles: $S"
[[ "$S" == "cv-style=yes keys-style=yes" ]]; ok $? "both stylesheets injected"

E=$(agent-browser errors 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('errors',d) if isinstance(d,dict) else d; print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "  page errors: $E"
[ "$E" = "0" ]; ok $? "zero page errors across the whole session"

echo ""
echo "===== v42 FEATURES: $PASS PASS / $FAIL FAIL ====="
[ "$FAIL" = "0" ]
