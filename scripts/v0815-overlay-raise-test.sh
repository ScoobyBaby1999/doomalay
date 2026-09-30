#!/bin/bash
# v0815-overlay-raise-test.sh — THE OVERLAY RAISE-ON-OPEN (user report:
#   "when viewing cloud connected workspaces in the artifacts drawer,
#    when a user presses to view a file, the overlay screen to edit and
#    commit the file renders below the workspaces overlay screen instead
#    of above it, meaning the user must back out the workspaces screen
#    to access the other screen").
# ROOT CAUSE: #connect-overlay + #artifacts-overlay are BOTH z-index:3000
# body-level singletons appended once at first use — at equal z the
# LATER DOM node paints on top, and connecting a workspace always uses
# the picker first, so the file editor (a ConnectOverlay page) sat
# under the drawer for the whole session.
# THE FIX: raise-on-open — each open() re-appends its singleton to the
# end of <body> (a MOVE: state + listeners preserved), so the
# most-recently-opened overlay always wins.
#  (1) THE REPRO SHAPE: picker first → close → drawer → the file
#      editor's entry (ConnectOverlay.open) → connect-overlay is AFTER
#      artifacts-overlay in DOM (paints above at equal z).
#  (2) THE HIT-TEST: the editor's content is reachable at the screen's
#      center WITHOUT backing out the drawer.
#  (3) THE DRAWER SURVIVES: closing the editor leaves the drawer open
#      with its tree (the raise is a move, not a destroy).
#  (4) THE REVERSE INTERLEAVE: drawer → picker → the picker raises
#      above the drawer too (order-independent).
#  (5) the 3400+ chrome still outranks both (z untouched).
#  (6) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
PORT=8351
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0815
export AGENT_BROWSER_SESSION=doomalay-v0815

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0815-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Overlay Chat","sandbox":"quick","model":"privatemodeai/mock-pm","provider":"privatemodeai"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2.5
agent-browser errors --clear >/dev/null

# (1) THE REPRO SHAPE: the picker is created FIRST (the connect flow's
# order), closed, then the drawer, then the file editor's entry.
ev "(function(){ window.Workspace.openPicker(); return 'picker'; })()" >/dev/null; sleep 1.5
ev "(function(){ window.ConnectOverlay.close(); return 'closed'; })()" >/dev/null; sleep 1
ev "(function(){ window.Artifacts.openDrawer('$SID', null, { sessionId: '$SID' }); return 'drawer'; })()" >/dev/null; sleep 2
# the cloud file editor's exact entry: a ConnectOverlay page
ev "(function(){ window.ConnectOverlay.open('<div id=\"probe-file-editor\" style=\"height:100%;display:flex;align-items:center;justify-content:center;font-size:18px\">EDIT + COMMIT FILE</div>'); return 'editor'; })()" >/dev/null; sleep 1.2

D1=$(ev "(function(){
  var co = document.getElementById('connect-overlay');
  var ao = document.getElementById('artifacts-overlay');
  if (!co || !ao) return JSON.stringify({ missing: true });
  // DOCUMENT_POSITION_FOLLOWING set on ao means ao FOLLOWS co (co is
  // earlier in DOM) → at equal z-index co paints UNDER ao (the bug).
  // We want co AFTER ao: ao.compareDocumentPosition(co) FOLLOWING.
  var coAfter = !!(ao.compareDocumentPosition(co) & Node.DOCUMENT_POSITION_FOLLOWING);
  return JSON.stringify({
    coAfter: coAfter,
    zc: getComputedStyle(co).zIndex, za: getComputedStyle(ao).zIndex,
    coVis: co.style.visibility, aoDisp: ao.style.display
  });
})()")
Z1=$(echo "$D1" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if d.get('missing'): print('no'); exit()
ok = d['coAfter'] and d['zc'] == '3000' and d['za'] == '3000' and d['coVis'] == 'visible' and d['aoDisp'] == 'block'
print('yes' if ok else 'no')")
ck "REPRO SHAPE FIXED: picker created first, yet the file editor (connect-overlay) paints ABOVE the drawer (DOM order + equal z)" "$Z1" "$D1"

# (2) THE HIT-TEST: the editor is reachable without backing out
D2=$(ev "(function(){
  var hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  var editor = document.getElementById('probe-file-editor');
  return JSON.stringify({
    hitEditor: !!(hit && editor && (hit === editor || (hit.closest && hit.closest('#probe-file-editor')))),
    hitText: hit ? (hit.textContent || '').slice(0, 20) : 'none'
  });
})()")
Z2=$(echo "$D2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('yes' if d['hitEditor'] else 'no')")
ck "the editor's content is hit-reachable at screen center (no back-out needed)" "$Z2" "$D2"

# (3) THE DRAWER SURVIVES the editor close (the raise is a move)
ev "(function(){ window.ConnectOverlay.close(); return 'editor-closed'; })()" >/dev/null; sleep 1
D3=$(ev "(function(){
  var ao = document.getElementById('artifacts-overlay');
  var co = document.getElementById('connect-overlay');
  return JSON.stringify({
    drawerOpen: !!(ao && ao.style.display === 'block'),
    drawerHasTree: !!(ao && ao.querySelector('.art-panel')),
    editorHidden: !!(co && co.style.visibility === 'hidden')
  });
})()")
Z3=$(echo "$D3" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['drawerOpen'] and d['drawerHasTree'] and d['editorHidden']
print('yes' if ok else 'no')")
ck "closing the editor leaves the drawer open with its tree (state preserved through the move)" "$Z3" "$D3"

# (4) THE REVERSE INTERLEAVE: drawer open → picker raises above it
ev "(function(){ window.Workspace.openPicker(); return 'picker-again'; })()" >/dev/null; sleep 1.5
D4=$(ev "(function(){
  var co = document.getElementById('connect-overlay');
  var ao = document.getElementById('artifacts-overlay');
  var coAfter = !!(ao.compareDocumentPosition(co) & Node.DOCUMENT_POSITION_FOLLOWING);
  var hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return JSON.stringify({ coAfter: coAfter, coVis: co.style.visibility,
    hitConnect: !!(hit && hit.closest && hit.closest('#connect-overlay')) });
})()")
Z4=$(echo "$D4" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['coAfter'] and d['coVis'] == 'visible' and d['hitConnect']
print('yes' if ok else 'no')")
ck "REVERSE INTERLEAVE: the picker re-opens ABOVE the open drawer too (order-independent)" "$Z4" "$D4"

# (5) the chrome tiers stay above both overlays (z untouched): the
# art-toast class is the 4000 tier (toasts must always outrank overlays)
D5=$(ev "(function(){
  var co = document.getElementById('connect-overlay');
  var ao = document.getElementById('artifacts-overlay');
  var probe = document.createElement('div');
  probe.className = 'art-toast';
  document.body.appendChild(probe);
  var tz = parseInt(getComputedStyle(probe).zIndex, 10);
  probe.remove();
  return JSON.stringify({
    toastTier: tz,
    both3k: parseInt(getComputedStyle(co).zIndex, 10) === 3000 && parseInt(getComputedStyle(ao).zIndex, 10) === 3000
  });
})()")
Z5=$(echo "$D5" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('yes' if d['toastTier'] > 3000 and d['both3k'] else 'no')")
ck "the chrome tiers (toast z4000) still outrank the overlays; both stay z3000" "$Z5" "$D5"

ERRS=$(agent-browser errors 2>/dev/null | python3 -c "
import sys
lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
print(len(lines))")
ck "zero console errors across the whole ride" "$( [ "$ERRS" = "0" ] && echo yes || echo no )" "$ERRS errors"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0815 OVERLAY-RAISE: ALL GREEN" || exit 1
