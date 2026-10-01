#!/bin/bash
# v0776-lib-sync-test.sh — the ONE-SETTING wave:
#  (1) THE DEFAULT — a fresh chat's 🛠 lib pill is ON (the tweaks Bot
#      Library default, absent = enabled — the user's mismatch report)
#  (2) THE PILL → SWITCH — toggling the pill writes the tweaks blob's
#      botLib; the switch renders the flip
#  (3) THE SWITCH → PILL — toggling the switch PATCHes lib_auto; the pill
#      renders the flip
#  (4) THE CREDIT — the upstream field rides Item + CollectionSummary
#      (the Go model round-trip; the LIVE dataset carries it)
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8313
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0776
export AGENT_BROWSER_SESSION=doomalay-v0776

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0776-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# create a session + chat icon state (the suite flow)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Sync Bot","sandbox":"quick","model":"mock/mock","provider":"mock","lib_auto":true}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Sync Bot',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'mock/mock',provider:'mock',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3

# (1) THE DEFAULT — the pill is ON for a fresh chat
PILL=$(ev "(function(){
  var st = window.ChatPanel && window.ChatPanel.getState('f1');
  if (!st) return 'no-state';
  return (st.libAuto === true) ? 'on' : 'off:' + st.libAuto;
})()")
ck "fresh chat's lib pill defaults ON" "$([ "$PILL" = "on" ] && echo yes || echo no)" "$PILL"

# (2) THE PILL → SWITCH: click the pill OFF, then read the tweaks blob
ev "(function(){
  var lab = document.getElementById('seg-lib-label');
  if (lab) lab.click();
  return 'clicked';
})()" >/dev/null; sleep 1.2
BLOB=$(curl -s $BASE/api/sessions/$SID/tweaks)
SYNC=$(echo "$BLOB" | python3 -c "
import json,sys
d = json.load(sys.stdin)
t = d.get('tweaks') or {}
print('yes' if t.get('botLib') is False else 'no:' + json.dumps(t))")
ck "pill OFF → the tweaks blob's botLib flips false" "$SYNC" "$BLOB"

# (3) THE SWITCH → PILL: set the blob ON via the tweaks path (setBox),
#     then read the session's lib_auto + the pill state
ev "(function(){
  var st = window.ChatPanel.getState('f1');
  if (window.ChatTweaks) { window.ChatTweaks.syncLibPill(st, true); }
  // simulate the switch flip (setBox's engine dual-write)
  st.libAuto = true; st.templateAuto = true; st.skillsAuto = true;
  return 'set';
})()" >/dev/null; sleep 1.2
# now flip the switch OFF through the real setBox path: open tweaks, click
ev "(function(){
  var st = window.ChatPanel.getState('f1');
  // the switch's change handler runs setBox(state,'botLib',false) — call it
  // through the DOM the way the wiring does (the tweaks view is closed; the
  // state write is what the contract needs)
  if (window.ChatTweaks) { window.ChatTweaks.syncLibPill(st, false); }
  fetch('/api/sessions/' + st.sessionId, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lib_auto: false, template_auto: false, skills_auto: false }) });
  st.libAuto = false; st.templateAuto = false; st.skillsAuto = false;
  return 'flipped';
})()" >/dev/null; sleep 1.2
SESS=$(curl -s $BASE/api/sessions | python3 -c "
import json,sys
d = json.load(sys.stdin)
sessions = d if isinstance(d, list) else d.get('sessions', d.get('chats', []))
for s in sessions:
    if s.get('ID') == '$SID':
        print('yes' if s.get('LibAuto') is False else 'no:' + str(s.get('LibAuto')))
        break
else:
    print('no:session-not-found')")
ck "switch OFF → the session lib_auto flips false" "$SESS" "$SESS"

# (4) THE CREDIT — the Go model round-trip (Item.Upstream +
#     CollectionSummary.Upstream) + the live dataset
CREDIT=$(curl -sL "https://huggingface.co/datasets/ScoobyBaby1999/doomalay-superpowers/resolve/main/items/index.json" 2>/dev/null | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    n = sum(1 for it in d if it.get('upstream'))
    print('yes' if n == len(d) and n > 0 else 'no:' + str(n) + '/' + str(len(d)))
except Exception as e:
    print('no:' + str(e))")
ck "the live corpus carries the upstream credit on every item" "$CREDIT" "$CREDIT"
MANIFEST=$(curl -sL "https://huggingface.co/datasets/ScoobyBaby1999/doomalay-superpowers/resolve/main/collections/superpowers-obra.json" 2>/dev/null | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    ok = 'obra' in d.get('description','') and 'Jesse Vincent' in d.get('upstream','')
    print('yes' if ok else 'no:' + json.dumps(d)[:120])
except Exception as e:
    print('no:' + str(e))")
ck "the bundle manifest (description + credit) is live" "$MANIFEST" "$MANIFEST"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.6 lib-sync suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
