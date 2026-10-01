#!/bin/bash
# v0899-stretch-fix-test.sh — THE STRETCH FIX (user report: "The canvas from
#   the previous 0.86 fixes that caused the canvas to stretch immensely and
#   makes it very disorienting has not been fixed despite ur previous 0.89
#   attempt. The canvas is still very nauseating, it's stretched ridiculously,
#   and the movement therefore is very weird.")
#
# THE ROOT CAUSE (proven live against the pre-fix binary): the v0.85.2 worker
# painter transferred #c/#c2 via transferControlToOffscreen but NOBODY ever
# sized the bitmaps afterwards — the main thread skips it in worker mode and
# the worker only applied the DPR *transform* (setTransform), never the
# *dimensions*. The offscreen canvases therefore inherited the elements'
# 300×150 boot default FOREVER while the CSS stretched them to the window
# (a tall phone: ~×4 horizontal, ~×18 vertical — the stretch, the nausea, the
# weird movement; the lattice's own math was always correct). The v0.89.7
# quantization fix could not see this: its verification read the lattice
# SPEC blobs, never the bitmap. Fix: the worker owns sizing (sizeBitmaps at
# init + every resize) and bootPainter pre-sizes the elements before the
# one-way transfer so the first composited frame is already true-geometry.
#
# THE CONTRACT:
#  (1) THE BITMAP IS THE VIEWPORT — boot in worker mode (workerPaint default
#      ON) → #c/#c2 element bitmaps === innerWidth×innerHeight (pre-fix:
#      300×150, live-proven) AND the worker's own debug report (bw/bh, the
#      v0.89.9 honest instrument) matches the viewport.
#  (2) THE PIXEL ASPECT PROOF — at a deliberately TALL viewport (400×850),
#      a screenshot of the lattice must show a SQUARE dot pitch: median
#      nearest-neighbor dy/dx ∈ [0.6, 1.55] (pre-fix at this geometry: ≈4.3
#      — dots as tall streaks). scripts/v0899-dot-spacing.py does the pixel
#      math; dots bright, lines dark, scatter+anims off for a clean lattice.
#  (3) LIVE RESIZE REACHES THE BITMAP — viewport change (the phone
#      address-bar / rotation case) → the worker re-sizes within 1s; the
#      element bitmap + the worker's report follow the NEW viewport.
#  (4) THE FALLBACK UNCHANGED — workerPaint:false → main mode: bitmaps
#      sized by the main thread, toDataURL readable, batcher engaged
#      (the v0852 contract).
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8399
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0899
SHOTS=/tmp/v0899-shots
export AGENT_BROWSER_SESSION=doomalay-v0899

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

# ── zombie-port hardening (the v0892 lesson): prove OUR child owns 8399 ──
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "PORT $PORT ALREADY BOUND — refusing (stale engine would answer the rig)"; exit 1
fi
rm -rf $DATA $SHOTS; mkdir -p $DATA $SHOTS
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0899-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }
OWN=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
ck "our child owns the listener (pid $ENGPID vs $OWN)" "$([ "$OWN" = "$ENGPID" ] && echo yes || echo no)" "$OWN"

# a session + an icon carrying it (seeded before first load)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v0899sess","title":"Stretch","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or d.get('Id') or '')")
[ -n "$SID" ] && echo "session: $SID" || { echo "SESSION CREATE FAIL"; exit 1; }

# TALL viewport from the very first load (the stretch discriminates far
# from 2:1: pre-fix ratio at 400×850 ≈ 4.3, post-fix ≈ 1.0)
agent-browser close >/dev/null 2>&1
agent-browser set viewport 400 850 >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2
ev "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0}, scale:1, icons:[{type:'chat', id:'chat_v0899', name:'Stretch', family:'default', iconIndex:-1, x:300, y:250, sessionId:'$SID'}]})); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
VW=$(ev "window.innerWidth"); VH=$(ev "window.innerHeight")
if [ "$VW" -gt 500 ] 2>/dev/null; then
  # the daemon ignored the pre-open viewport — set it live and reload
  agent-browser set viewport 400 850 >/dev/null 2>&1
  agent-browser open "$BASE" >/dev/null 2>&1
  sleep 2.0
  VW=$(ev "window.innerWidth"); VH=$(ev "window.innerHeight")
fi
echo "viewport: ${VW}×${VH}"

echo "── (1) the bitmap IS the viewport (was 300×150 for four versions)"
P1=$(ev "(window.DoomalayPerf||{}).painter || 'none'")
ck "painter = worker (workerPaint default on)" "$([ "$P1" = "worker" ] && echo yes || echo no)" "$P1"
B1=$(ev "JSON.stringify({cw:document.getElementById('c').width, ch:document.getElementById('c').height, c2w:document.getElementById('c2').width, c2h:document.getElementById('c2').height, iw:window.innerWidth, ih:window.innerHeight})")
ck "#c AND #c2 element bitmaps === viewport" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$B1''')
    ok = d['cw']==d['iw'] and d['ch']==d['ih'] and d['c2w']==d['iw'] and d['c2h']==d['ih'] and d['iw']>0
    print('yes' if ok else 'no')
except Exception: print('no')")" "$B1"
B2=$(ev "JSON.stringify({bw:(window.DoomalayDebug||{}).bw, bh:(window.DoomalayDebug||{}).bh, vw:(window.DoomalayDebug||{}).vw, vh:(window.DoomalayDebug||{}).vh, iw:window.innerWidth, ih:window.innerHeight})")
ck "the worker's own report (bw/bh) === viewport" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$B2''')
    ok = d['bw']==d['iw'] and d['bh']==d['ih'] and d['vw']==d['iw'] and d['vh']==d['ih']
    print('yes' if ok else 'no')
except Exception: print('no')")" "$B2"

echo "── (2) the pixel aspect proof (square dot pitch at a tall viewport)"
# clean lattice for the pixel math: bright dots, dark lines, no scatter, no
# anims (stable frame), no parallax, uniform sizes
ev "Settings.setState({dotColor:'#b8b8e8', lineColor:'#0d0d14', dotScatter:0, lineScatter:0, gridScatter:0, dotAnimate:false, lineAnimate:false, spaceParallax:0, dotSizeVariation:0, lineSizeVariation:0}); 'ok'" >/dev/null
sleep 1.6
DOTS=$(ev "(window.DoomalayDebug||{}).dots||0")
ck "lattice painted (dots in view > 40)" "$([ "${DOTS:-0}" -gt 40 ] && echo yes || echo no)" "$DOTS"
agent-browser screenshot $SHOTS/aspect-tall.png >/dev/null 2>&1
SP=$(python3 scripts/v0899-dot-spacing.py $SHOTS/aspect-tall.png 2>&1 | tail -1)
echo "    spacing: $SP"
ck "square pitch (median dy/dx ∈ [0.6, 1.55]; pre-fix ≈ 4.3)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$SP'''); print('yes' if d.get('ok') else 'no')
except Exception: print('no')")" "$SP"

echo "── (3) live resize reaches the bitmap (the rotation/address-bar case)"
agent-browser set viewport 700 500 >/dev/null 2>&1
sleep 1.2
VW2=$(ev "window.innerWidth")
B3=$(ev "JSON.stringify({cw:document.getElementById('c').width, ch:document.getElementById('c').height, bw:(window.DoomalayDebug||{}).bw, bh:(window.DoomalayDebug||{}).bh, iw:window.innerWidth, ih:window.innerHeight})")
ck "viewport moved to 700×500 (live resize works)" "$([ "$VW2" = "700" ] && echo yes || echo no)" "$VW2"
ck "bitmaps follow the live resize (element + worker report)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$B3''')
    ok = d['cw']==700 and d['ch']==500 and d['bw']==700 and d['bh']==500
    print('yes' if ok else 'no')
except Exception: print('no')")" "$B3"

echo "── (4) the fallback unchanged (workerPaint:false → main mode)"
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
P2=$(ev "(window.DoomalayPerf||{}).painter || 'none'")
ck "reload with workerPaint:false → painter 'main'" "$([ "$P2" = "main" ] && echo yes || echo no)" "$P2"
B4=$(ev "JSON.stringify({cw:document.getElementById('c').width, ch:document.getElementById('c').height, iw:window.innerWidth, ih:window.innerHeight})")
ck "main mode: bitmaps sized by the main thread" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$B4''')
    ok = d['cw']==d['iw'] and d['ch']==d['ih']
    print('yes' if ok else 'no')
except Exception: print('no')")" "$B4"
TDU=$(ev "(function(){try{var s=document.getElementById('c').toDataURL(); return s.length}catch(e){return 'err:'+e.name}})()")
ck "main mode: toDataURL readable (our ctxs)" \
   "$(python3 -c "
s='''$TDU'''
print('yes' if s.isdigit() and int(s)>5000 else 'no')")" "len $TDU"

echo "── (5) console errors"
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
echo "════ v0899 THE STRETCH FIX: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
