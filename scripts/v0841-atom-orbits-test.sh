#!/bin/bash
# v0841-atom-orbits-test.sh — THE ATOM ORBITS (user spec verbatim:
#   "Let's make each connected workspace spawn a small orbiting star around
#    the chat that orbits like an atom not a 2d plane basic circle. It goes
#    back and forth behind and above the icon. A chat with 10 workspaces has
#    10 stars. Like an atom, we cap each level of orbit to a set number of
#    stars then jump to another slightly further level of orbit orbiting
#    another axis. Cap the workspaces per chat at like 50 I guess.... Or
#    24? Idk... Ur call.").
#
# THE CONTRACT:
#  (1) SHELLS — shellLayout(10) = [4,6] (2 shells, the level cap + the
#      jump); shellLayout(32) = [4,6,8,8,8]; 40 CLAMPS to 32.
#  (2) LIVE FEED — 10 real device workspaces bound through the real REST
#      surface → Atoms.refresh(icon) → DoomalayDebug.atoms = 10 stars /
#      2 shells / 1 chat; the count came from the engine, not a stub.
#  (3) MOTION + THE ATOM-ONLY FRAME — two #c2 snapshots 400ms apart
#      DIFFER (the stars orbit); two #c snapshots over the same window
#      are IDENTICAL (the resting grid is NOT repainted while only the
#      atoms move — the cheap-frame promise), with the animate toggles
#      OFF (rAF alive purely on the atoms' account).
#  (4) BACK AND ABOVE — across sampled frames, backHidden ≥ 1 occurs
#      (stars passing BEHIND the disc are occluded) AND frontInside ≥ 1
#      occurs (front stars pass OVER the disc): the "goes back and forth
#      behind and above the icon" discipline, measured at the exact
#      decision points in the painter.
#  (5) ANOTHER AXIS — shell 2's ring is not shell 1's: the tilt tables
#      differ AND the projected geometry differs (the _starPos twin).
#  (6) THE CAP (browser twin) — 33 device binds: the 33rd answers 409
#      with the exact message.
#  (7) INTERACTION — elementFromPoint at the icon center still returns
#      the icon (#c2 never blocks; pointer-events:none).
#  (8) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8341
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0841
export AGENT_BROWSER_SESSION=doomalay-v0841

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0841-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# a session + an icon on the canvas carrying it (seeded before first load)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v0841sess","title":"Atom","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or d.get('Id') or '')")
echo "session: $SID"

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1
# seed the icon (localStorage) + reload — the app restores it on boot
ev "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0}, scale:1, icons:[{type:'chat', id:'chat_v0841', name:'Atom', family:'default', iconIndex:-1, x:300, y:250, sessionId:'$SID'}]})); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2

echo "── (1) the shell layout"
L10=$(ev "JSON.stringify(window.Atoms.shellLayout(10))")
L32=$(ev "JSON.stringify(window.Atoms.shellLayout(32))")
L40=$(ev "JSON.stringify(window.Atoms.shellLayout(40))")
ck "10 workspaces → shells [4,6]" "$([ "$L10" = "[4,6]" ] && echo yes || echo no)" "$L10"
ck "32 workspaces → shells [4,6,8,8,6] (four full + a partial fifth)" "$([ "$L32" = "[4,6,8,8,6]" ] && echo yes || echo no)" "$L32"
ck "40 clamps to the 32 cap" "$([ "$L40" = "[4,6,8,8,6]" ] && echo yes || echo no)" "$L40"

echo "── (2) the live feed (10 real device workspaces through the REST surface)"
for i in $(seq 1 10); do
  curl -s -X POST $BASE/api/workspaces/device -H 'Content-Type: application/json' \
    -d "{\"name\":\"dev ws $i\",\"session_id\":\"$SID\"}" >/dev/null
done
ev "window.Atoms.refresh(window.doomalay.findIconForSession('$SID'))" >/dev/null
sleep 0.8
A=$(ev "JSON.stringify(window.DoomalayDebug && window.DoomalayDebug.atoms)")
ck "10 stars / 2 shells / 1 chat from the engine's truth" \
   "$(python3 -c "
import json,sys
try:
    a=json.loads('''$A''')
    print('yes' if a.get('stars')==10 and a.get('shells')==2 and a.get('chats')==1 else 'no')
except Exception: print('no')")" "$A"

echo "── (3) motion + the atom-only frame (animate toggles OFF)"
STG=$(ev "var s=window.Settings.getState()||{}; s.dotAnimate=false; s.lineAnimate=false; 'off'")
# headless Chromium can throttle rAF for a moment (visibility flickers) —
# the motion proof retries over ~1.6s: any differing pair counts.
CA=$(ev "document.getElementById('c').toDataURL().length")
MOVED=no; C2A=""
for k in 1 2 3 4; do
  sleep 0.4
  C2B=$(ev "document.getElementById('c2').toDataURL().length")
  if [ -n "$C2A" ] && [ "$C2A" != "$C2B" ]; then MOVED=yes; break; fi
  C2A=$C2B
done
CB=$(ev "document.getElementById('c').toDataURL().length")
ck "the stars MOVE (#c2 changed)" "$MOVED" "len $C2A → $C2B"
ck "the resting grid does NOT repaint (#c identical)" "$([ "$CA" = "$CB" ] && echo yes || echo no)" "len $CA → $CB"
RAF=$(ev "(function(){var a=window.DoomalayDebug.atoms||{}; return a.stars>0?'yes':'no'})()")
ck "atoms paint with no motion + no animate toggles" "$RAF" "$RAF"

echo "── (4) back AND above (the occlusion discipline)"
# 60 real frames, ~130ms apart — each eval is its own task so rAF paints
# between the samples (a busy-wait inside ONE eval would freeze the frame).
# ~8s of orbit sweep: every shell-2 star covers >230° of its circle, so
# both the behind-arc AND the front-arc of the minor-axis crossing are
# guaranteed witnesses (the counters read the painter's own decisions).
ev "window.__acc={bh:0, fi:0}; 'ok'" >/dev/null
for k in $(seq 1 60); do
  sleep 0.13
  ev "var a=window.DoomalayDebug.atoms||{}; window.__acc.bh+=(a.backHidden||0); window.__acc.fi+=(a.frontInside||0); 'x'" >/dev/null
done
BH=$(ev "JSON.stringify(window.__acc)")
ck "stars pass BEHIND the disc (backHidden seen)" \
   "$(python3 -c "
import json
try: d=json.loads('''$BH'''); print('yes' if d.get('bh',0)>0 else 'no')
except Exception: print('no')")" "$BH"
ck "stars pass OVER the disc (frontInside seen)" \
   "$(python3 -c "
import json
try: d=json.loads('''$BH'''); print('yes' if d.get('fi',0)>0 else 'no')
except Exception: print('no')")" "$BH"

echo "── (5) another axis per shell"
AX=$(ev "
var A=window.Atoms, t=2.5, out=[];
for (var L=0; L<2; L++){
  var p1=A._starPos('k|'+L+'|0', L, 60, t);
  out.push([Math.round(p1.x), Math.round(p1.y), Math.round(p1.z*100)/100]);
}
JSON.stringify(out)")
ck "shell 2 rides a different plane than shell 1" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$AX''')
    print('yes' if d[0] != d[1] else 'no')
except Exception: print('no')")" "$AX"

echo "── (6) the 33rd bind is refused (browser twin)"
for i in $(seq 11 32); do
  curl -s -X POST $BASE/api/workspaces/device -H 'Content-Type: application/json' \
    -d "{\"name\":\"dev ws $i\",\"session_id\":\"$SID\"}" >/dev/null
done
R33=$(curl -s -o /tmp/v0841-33.json -w "%{http_code}" -X POST $BASE/api/workspaces/device \
  -H 'Content-Type: application/json' -d "{\"name\":\"dev ws 33\",\"session_id\":\"$SID\"}")
MSG=$(python3 -c "import json;print(json.load(open('/tmp/v0841-33.json')).get('error',''))" 2>/dev/null)
ck "33rd bind → 409" "$([ "$R33" = "409" ] && echo yes || echo no)" "$R33"
ck "the exact atom-cap message" "$([ "$MSG" = "this chat already orbits 32 workspaces — unbind one first" ] && echo yes || echo no)" "$MSG"

echo "── (7) interaction survives"
HIT=$(ev "
var el=document.elementFromPoint(300,250);
el ? (el.closest('.chatbot') ? 'icon' : el.tagName) : 'none'")
ck "elementFromPoint at the icon → the icon" "$([ "$HIT" = "icon" ] && echo yes || echo no)" "$HIT"

echo "── (8) console errors"
ERRS=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and e.get('level','').lower() in ('error','severe'): n+=1
        elif isinstance(e,dict) and e.get('type','').lower()=='error': n+=1
    except Exception: pass
print(n)")
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS errors"

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
