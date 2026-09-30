#!/bin/bash
# v0813-use-handshake-test.sh — THE USE HANDSHAKE (user spec, verbatim:
#   "pressing Use on a bundle closes the library completely; from flow
#    canvas → library → select user chat (from no-chat) → bundle → Use:
#    close lib, open that chat, update lib pill to reflect the bundle;
#    if lib toggle is off for that chat (pill or tweaks toggle), enable
#    both and update the box above the lib pill showing the bundle used
#    for that turn").
# Drives the REAL UI end to end (engine + browser + mock HF hub):
#  (1) CANVAS → LIBRARY (the dock path): the hub opens canvas-hosted,
#      NO chat connected (the none-pill).
#  (2) SELECT USER CHAT (from no-chat): the chat pill → the picker →
#      Bravo — cur.chat now Bravo (the synthetic host is Alpha).
#  (3) BUNDLE → USE: skill library → the bunch card → the bunch view →
#      download → the ▶ FAB.
#  (4) THE HANDSHAKE: the library closed completely (viewDepth 0, hub
#      gone), the TARGET chat opened (currentCtx switched Alpha →
#      Bravo), state.bundle armed on Bravo (NOT on Alpha — the old bug
#      armed the synthetic host), libAuto ON AND the tweaks blob's
#      botLib ON (both toggles — the pill's aria-pressed true), and the
#      ▣ box above the lib pill shows the bundle.
#  (5) the pill OFF pre-state: Bravo's lib is turned OFF first (the
#      pill click), so Use must re-enable BOTH (libAuto + botLib).
#  (6) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
PORT=8341
MOCKPORT=8342
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0813
export AGENT_BROWSER_SESSION=doomalay-v0813

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
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
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
python3 scripts/v071-mock-hub.py $MOCKPORT >/tmp/v0813-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:$MOCKPORT
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v0813-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

mkchat() { curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d "{\"title\":\"$1\",\"sandbox\":\"quick\",\"model\":\"privatemodeai/mock-pm\",\"provider\":\"privatemodeai\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])'; }
SID_A=$(mkchat "Alpha Host")
SID_B=$(mkchat "Bravo Target")
for S in $SID_A $SID_B; do
  curl -s -X POST $BASE/api/sessions/$S/events -H 'Content-Type: application/json' \
    -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
done

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[
  {id:'a1',type:'chat',name:'Alpha Host',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID_A'},
  {id:'b1',type:'chat',name:'Bravo Target',family:'privatemodeai',iconIndex:1,x:280,y:420,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID_B'}
],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2

# (5) pre-state: Bravo's lib is OFF (the pill path) — Use must re-enable BOTH
agent-browser mouse move 280 420 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
LIBOFF=$(ev "(function(){
  var lab = document.getElementById('seg-lib-label');
  if (lab) lab.click();
  return 'off';
})()")
# the tweaks persist is debounced — poll the engine until the blob lands
BLOBB=""
for i in $(seq 1 16); do
  BLOBB=$(curl -s $BASE/api/sessions/$SID_B/tweaks | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin); t = d.get('tweaks') or {}
    print('yes' if t.get('botLib') is False else 'no')
except Exception:
    print('pending')" 2>/dev/null)
  [ "$BLOBB" = "yes" ] && break
  sleep 0.4
done
ck "pre-state: Bravo's lib turned OFF (pill click → botLib false)" "$BLOBB"
# close the panel — the canvas flow starts BARE
ev "(function(){ var c = window.ChatPanel.current(); if (c && c.panel) c.panel.close(); return 'closed'; })()" >/dev/null; sleep 1.2

# (1) CANVAS → LIBRARY: the dock path (toggle → library)
ev "(function(){ document.getElementById('dock-toggle').click(); return 'dock'; })()" >/dev/null; sleep 0.6
ev "(function(){ document.getElementById('dock-library').click(); return 'lib'; })()" >/dev/null; sleep 2.5
HUB0=$(ev "(function(){
  var pill = document.getElementById('hub-chatpill');
  var c = window.ChatPanel && window.ChatPanel.current();
  return JSON.stringify({
    hubOpen: !!(window.Hub && window.Hub.chat && window.Hub.chat() === null && pill),
    nonePill: pill ? pill.className.indexOf('hub-chatpill--none') >= 0 : false,
    hostIsAlpha: !!(c && c.state && c.state.sessionId === '$SID_A'),
    depth: c && c.panel && c.panel.viewDepth ? c.panel.viewDepth() : -1
  });
})()")
Z1=$(echo "$HUB0" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['nonePill'] and d['hostIsAlpha'] and d['depth'] >= 1
print('yes' if ok else 'no')")
ck "canvas → library: hub open, NO chat connected, Alpha is the synthetic host" "$Z1" "$HUB0"

# (2) SELECT USER CHAT: the pill → picker → Bravo
ev "(function(){ document.getElementById('hub-chatpill').click(); return 'pill'; })()" >/dev/null; sleep 2
ev "(function(){
  var row = document.querySelector('.cv-row[data-cv-sid=\"$SID_B\"]');
  if (row) row.click();
  return row ? 'picked' : 'no-row';
})()" >/dev/null; sleep 1.5
PICK=$(ev "(function(){
  var chat = window.Hub.chat();
  return JSON.stringify({ sid: chat && chat.sessionId, title: chat && chat.title });
})()")
Z2=$(echo "$PICK" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('yes' if d['sid'] == '$SID_B' else 'no')")
ck "pill → picker → Bravo: the library is connected to the TARGET chat" "$Z2" "$PICK"

# (3) BUNDLE: skill library → bunch card → bunch view → download → Use
ev "(function(){ var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); if (p) p.click(); return 'skill'; })()" >/dev/null; sleep 2.5
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch]'); if (b) b.click(); return 'bunch'; })()" >/dev/null; sleep 2.5
for i in $(seq 1 12); do
  N=$(ev "(document.querySelector('.hub-bunch-sec') ? 'ready' : 'wait')" 2>/dev/null)
  [ "$N" = "ready" ] && break; sleep 0.5
done
ev "document.getElementById('hub-bundle-dl').click(); 'dl'" >/dev/null
DLST=""
for i in $(seq 1 25); do
  DLST=$(ev "(window.Hub.bundleDL('superpowers-mock')||{}).state || 'none'" 2>/dev/null)
  [ "$DLST" = "done" ] && break; sleep 0.4
done
ck "the bundle downloaded (registry done)" "$( [ "$DLST" = "done" ] && echo yes || echo no)" "$DLST"

# THE USE PRESS
ev "document.getElementById('hub-bundle-use').click(); 'used'" >/dev/null; sleep 2

# (4) THE HANDSHAKE — every clause of the user's spec
HS=$(ev "(function(){
  var c = window.ChatPanel && window.ChatPanel.current();
  var s = c && c.state;
  var chip = document.querySelector('#tpl-chip .tpl-chip-text');
  var lab = document.getElementById('seg-lib-label');
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem('doomalay.chatbundle.v1')) || {}; } catch (e) {}
  return JSON.stringify({
    onBravo: !!(s && s.sessionId === '$SID_B'),
    libGone: !!(c && c.panel && c.panel.viewDepth && c.panel.viewDepth() === 0 && !document.getElementById('hub-chatpill')),
    panelOpen: !!(c && c.panel && document.getElementById('chat-panel').classList.contains('open')),
    bundle: !!(s && s.bundle && s.bundle.id === 'superpowers-mock'),
    libAuto: !!(s && s.libAuto),
    botLib: !!(s && s._tweaks && s._tweaks.botLib),
    pillPressed: lab ? lab.getAttribute('aria-pressed') : 'gone',
    chip: chip ? chip.textContent : 'no-chip',
    bravoStored: !!stored['$SID_B'],
    alphaStored: !!stored['$SID_A'],
    segShown: (function () {
      var seg = document.getElementById('seg-lib-bundle');
      return !!(seg && seg.style.display !== 'none' && seg.textContent.indexOf('superpowers') >= 0);
    })()
  });
})()")
Z3=$(echo "$HS" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = (d['onBravo'] and d['libGone'] and d['panelOpen'] and d['bundle'] and
      d['libAuto'] and d['botLib'] and d['pillPressed'] == 'true' and
      'superpowers-mock' in d['chip'] and d['bravoStored'] and not d['alphaStored'] and
      d['segShown'])
print('yes' if ok else 'no')")
ck "HANDSHAKE: lib closed completely, Bravo opened + bundle armed, BOTH toggles ON, pill reflects it, ▣ box shows the bundle, Alpha untouched" "$Z3" "$HS"

# the tweaks blob persisted botLib=true for Bravo (the "enable both" twin)
BLOB2=$(curl -s $BASE/api/sessions/$SID_B/tweaks | python3 -c "
import json,sys
d = json.load(sys.stdin); t = d.get('tweaks') or {}
print('yes' if t.get('botLib') is True else 'no')")
ck "the tweaks blob's botLib persisted TRUE for Bravo" "$BLOB2"

ERRS=$(agent-browser errors 2>/dev/null | python3 -c "
import sys
lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
print(len(lines))")
ck "zero console errors across the whole ride" "$( [ "$ERRS" = "0" ] && echo yes || echo no )" "$ERRS errors"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0813 USE-HANDSHAKE: ALL GREEN" || exit 1
