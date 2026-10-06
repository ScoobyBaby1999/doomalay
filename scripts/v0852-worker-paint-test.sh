#!/bin/bash
# v0852-worker-paint-test.sh — THE PERF WAVE, PHASE 2 (user spec verbatim:
#   "Please if u may implement phases 1-3. To make everything more
#    responsive and achieve a higher fps" — this rig proves Phase 2: the
#    OffscreenCanvas grid worker owns #c/#c2; the main thread only
#    composites).
#
# THE CONTRACT:
#  (1) THE TRANSFER — boot → DoomalayPerf.painter === 'worker' AND the
#      debug blobs carry worker:true (the lattice twin arrives from the
#      worker thread); getContext on the main side is gone (reading the
#      transferred canvas throws / returns null — the bitmaps are the
#      worker's).
#  (2) FRAMES FLOW — dotAnimate ON → DoomalayPerf.paints climbs (ambient
#      frames are wanted + painted); a synthetic CAMERA PAN moves the
#      debug blob's camera (the frame messages carry the live cam).
#  (3) THE ATOM-ONLY FRAME (worker-side) — atoms bound + anims OFF →
#      DoomalayDebug.atomFrames climbs while fullFrames stays FROZEN (the
#      resting grid is NOT repainted; only the star layer) — the v0.84.1
#      discipline preserved across the thread boundary.
#  (4) THE BATCHER LIVES IN THE WORKER — mesh specs + amp100 + both anims
#      → the debug blob carries batches/buckets engaged + the weight/
#      overIcons contracts (the extracted painter is the SAME file).
#  (5) RESIZE — window resize → the worker's W/H follow (the debug
#      blob's viewport twin).
#  (6) THE FALLBACK — Settings workerPaint:false + reload → painter
#      'main', toDataURL readable again (the main-thread path, the same
#      lattice.js), batches still engaged.
#  (7) zero console errors (a failed worker boot would have surfaced as
#      an error + main-mode fallback).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8352
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0852
export AGENT_BROWSER_SESSION=doomalay-v0852

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0852-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# a session + an icon carrying it (seeded before first load)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v0852sess","title":"Worker","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or d.get('Id') or '')")
[ -n "$SID" ] && echo "session: $SID" || { echo "SESSION CREATE FAIL"; exit 1; }
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2
ev "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0}, scale:1, icons:[{type:'chat', id:'chat_v0852', name:'Worker', family:'default', iconIndex:-1, x:300, y:250, sessionId:'$SID'}]})); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6

echo "── (1) the transfer"
P1=$(ev "(window.DoomalayPerf||{}).painter || 'none'")
W1=$(ev "JSON.stringify({w:(window.DoomalayDebug||{}).worker===true, cache:!!((window.DoomalayDebug||{}).cache), ready:window.__doomalayReady})")
ck "painter = worker (the transfer happened)" "$([ "$P1" = "worker" ] && echo yes || echo no)" "$P1"
ck "the debug blobs arrive from the worker (worker:true + cache twin)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$W1''')
    print('yes' if d.get('w') and d.get('cache') and d.get('ready') else 'no')
except Exception: print('no')")" "$W1"

echo "── (2) frames flow (ambient + a real pan)"
ev "Settings.setState({dotAnimate:true})" >/dev/null
PA=$(ev "(window.DoomalayPerf||{}).paints||0")
sleep 1.2
PB=$(ev "(window.DoomalayPerf||{}).paints||0")
ck "ambient frames climb (paints $PA → $PB)" "$([ "$PB" -gt "$PA" ] && echo yes || echo no)" "$PA → $PB"
CAM0=$(ev "JSON.stringify((window.DoomalayDebug||{}).camera||{})")
# a synthetic drag: the app pans via a CANVAS-SURFACE mousedown -> window
# mousemove. v1.06.4 RIG REPAIR: the mousedown must target #c (the
# real-user pan surface) — the old document-level dispatch had
# target=document, which onCanvasSurface() correctly REJECTS (proven
# pre-existing-failing on the untouched v1.06.0 tree; the app's guard is
# right, the rig's synthesis was stale).
agent-browser eval "(function(){
  var c=document.getElementById('c');
  function md(x,y){c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  function mm(x,y){window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  function mu(x,y){window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  md(400,300); mm(340,300); mm(290,302); mm(250,300); mm(242,300); mu(242,300);
  return 'dragged'})()" >/dev/null 2>&1
# the gentle last move (8px) keeps the release velocity small — momentum
# dies in ~1s of ticks instead of riding full frames through section 3
sleep 2.2
CAM1=$(ev "JSON.stringify((window.DoomalayDebug||{}).camera||{})")
ck "the camera twin MOVES with a pan (the frame carried the live cam)" "$([ "$CAM0" != "$CAM1" ] && echo yes || echo no)" "$CAM0 → $CAM1"
ev "Settings.setState({dotAnimate:false})" >/dev/null; sleep 1.2

echo "── (3) the atom-only frame (worker-side)"
for i in $(seq 1 3); do
  curl -s -X POST $BASE/api/workspaces/device -H 'Content-Type: application/json' \
    -d "{\"name\":\"dev ws $i\",\"session_id\":\"$SID\"}" >/dev/null
done
ev "window.Atoms.refresh(window.doomalay.findIconForSession('$SID'))" >/dev/null
# v0.88: gate FA on the atom loop PROVABLY running (a > 0) — the mint's
# transitional window (ambient hand-off + pan-momentum decay) can straddle
# a fixed sleep and land full frames inside the measurement window; the
# poll (≤2s) reads the TRUE rest window instead of racing the transition.
for i in $(seq 1 20); do
  A0=$(ev "(window.DoomalayDebug||{}).atomFrames||0")
  [ "$A0" -gt 0 ] 2>/dev/null && break
  sleep 0.1
done
sleep 0.3
FA=$(ev "JSON.stringify({a:(window.DoomalayDebug||{}).atomFrames||0, f:(window.DoomalayDebug||{}).fullFrames||0, st:(window.DoomalayDebug||{}).atoms||{}})")
sleep 1.2
FB=$(ev "JSON.stringify({a:(window.DoomalayDebug||{}).atomFrames||0, f:(window.DoomalayDebug||{}).fullFrames||0})")
ck "atom frames climb (the stars move on the worker's #c2)" \
   "$(python3 -c "
import json
try:
    a=json.loads('''$FA'''); b=json.loads('''$FB''')
    print('yes' if b.get('a',0)>a.get('a',0) else 'no')
except Exception: print('no')")" "$FA → $FB"
ck "full frames FROZEN (the resting grid is not repainted — the cheap frame)" \
   "$(python3 -c "
import json
try:
    a=json.loads('''$FA'''); b=json.loads('''$FB''')
    print('yes' if b.get('f',0)==a.get('f',0) else 'no')
except Exception: print('no')")" "$FA → $FB"
STARS=$(ev "(window.DoomalayDebug||{}).atoms ? (window.DoomalayDebug.atoms.stars||0) : 0")
ck "3 workspaces → 3 stars painted by the worker" "$([ "$STARS" = "3" ] && echo yes || echo no)" "$STARS"

echo "── (4) the batcher lives in the worker"
ev "Settings.setState({dotColor:{colors:['#1a1a2e','#3b3b5c','#6a5acd'],dir:'mesh'}, lineColor:{colors:['#101018','#2a2a3a','#4a4a6a'],dir:'mesh'}, spaceParallax:100, dotSizeVariation:100, lineSizeVariation:100, dotAnimate:true, lineAnimate:true})" >/dev/null
sleep 1.3
MESH=$(ev "JSON.stringify(window.DoomalayDebug)")
# RE-PINNED v0.89.9: the original b*6<tot collapse was written for the
# coarse 8-level alpha quantizer. v0.89.7 deliberately raised alpha to 100
# levels / color to 64 (the user's "revert it" — visual honesty over
# batching), so mesh scenes now legitimately produce hundreds of buckets
# (live: ~609-632 for ~1050 elements — under the 640 gate, thin batches;
# proven pre-existing on the pre-fix binary, not a stretch-fix regression).
# The HONEST current contract: the batcher engages (buckets>1) at scale
# (tot>500) AND the frame stays cheap — either it collapses OR paintMs
# holds under 8ms (live: 1.6ms — no perf regression, just precision).
ck "mesh in the worker: buckets > 1 + collapse OR fast paint" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    dots=d.get('dots') or 0; segs=d.get('segs') or 0
    b=d.get('batches') or 99999; bk=d.get('buckets') or 0
    ms=d.get('paintMs') or 999
    tot=dots+segs
    print('yes' if bk>1 and tot>500 and (b*6<tot or ms<8) else 'no')
except Exception: print('no')")" "$MESH"
ck "mesh in the worker: the rig contracts intact (weight/overIcons)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    ok='weight' in d and 'overIcons' in d and d['overIcons'].get('on') is True
    print('yes' if ok else 'no')
except Exception: print('no')")" "$MESH"
ev "Settings.setState({dotColor:'#2e2e3a', lineColor:'#131318', spaceParallax:0, dotSizeVariation:0, lineSizeVariation:0, dotAnimate:false, lineAnimate:false})" >/dev/null
sleep 0.8

echo "── (5) resize reaches the worker"
RS0=$(ev "JSON.stringify({w:(window.DoomalayDebug||{}).dots||0})")
agent-browser eval "window.dispatchEvent(new Event('resize')); 'resized'" >/dev/null 2>&1
sleep 1.0
RS1=$(ev "(function(){var d=window.DoomalayDebug||{}; return JSON.stringify({dots:d.dots||0, ok:(window.DoomalayPerf||{}).painter})})()")
ck "resize posts (painter still worker, debug flows)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$RS1''')
    print('yes' if d.get('ok')=='worker' and (d.get('dots') or 0)>0 else 'no')
except Exception: print('no')")" "$RS1"

echo "── (6) the fallback (workerPaint:false → main mode)"
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
P2=$(ev "(window.DoomalayPerf||{}).painter || 'none'")
ck "reload with workerPaint:false → painter 'main'" "$([ "$P2" = "main" ] && echo yes || echo no)" "$P2"
TDU=$(ev "(function(){try{var s=document.getElementById('c').toDataURL(); return s.length}catch(e){return 'err:'+e.name}})()")
ck "main mode: toDataURL readable again (our ctxs)" \
   "$(python3 -c "
s='''$TDU'''
print('yes' if s.isdigit() and int(s)>20000 else 'no')")" "len $TDU"
MB=$(ev "JSON.stringify(window.DoomalayDebug||{})")
ck "main mode: the batcher still engaged (same lattice.js)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MB''')
    print('yes' if (d.get('batches') is not None) and (d.get('batches') or 99)<=6 else 'no')
except Exception: print('no')")" "$MB"

echo "── (7) console errors"
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
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS"

echo ""
echo "════ v0852 PHASE 2: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
