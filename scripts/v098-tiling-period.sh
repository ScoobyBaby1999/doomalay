#!/bin/bash
# v098-tiling-period.sh — THE TILING-PERIOD RIG (PLAN-V098).
#
# THE CONTRACT (what v0.98 claims, proven here):
#  (1) THE MESH WORST CASE — mesh dot+line specs + amp100 + both anims +
#      size 100 (the v097 leg-2 state):
#        · the parity interleave is LIVE (megaA != megaB, both even);
#        · the joint period covers the screen (pairCells·48 ≥ 2× the
#          viewport width — the lcm tile is wider than any screen);
#        · tiles bounded (≤ 60 — the (band × kind) list, not the fill count);
#        · paintMs < 5ms (read twice 0.3s apart, the second read);
#        · batches collapsed (≤ 80);
#        · the over-icons gate works (overIcons.on === true);
#        · coverage populated (dots > 500);
#        · ZERO console errors.
#  (2) THE DEFAULTS LEG — solid colors, no variation, no anims,
#      spaceParallax 0, workerPaint false:
#        · defaults still interleaved (megaA != megaB);
#        · default tiles ≤ 6 (2 dot tiles + full-lines stay immediate);
#        · ZERO console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8402
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v098tile
export AGENT_BROWSER_SESSION=doomalay-v098tile

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v098tile-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser console --clear >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
agent-browser set viewport 1280 800 >/dev/null 2>&1
sleep 0.6
# v0.97.1: a previous run's settings PERSIST in localStorage (same
# origin) — reset the canvas-relevant keys to defaults BEFORE the
# main-mode reload (the rig reads #c via DoomalayDebug, not the worker)
ev "Settings.setState({ dotColor: '#2e2e3a', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 0, lineSizeVariation: 0, dotScatter: 0, lineScatter: 0, dotSizeBias: 0, lineSizeBias: 0, dotRotation: 0, lineRotation: 0, gridSize: 1, workerPaint: false }); 'reset'" >/dev/null
sleep 0.8
ev "localStorage.removeItem('doomalay.state.v2'); 'state-cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
agent-browser set viewport 1280 800 >/dev/null 2>&1
sleep 0.5
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null
setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }
eval_console_errs() { agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    low=line.lower()
    if low.startswith('[error]') or low.startswith('[severe]'): n+=1; continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and (e.get('level','').lower() in ('error','severe') or e.get('type','').lower()=='error'): n+=1
    except Exception: pass
print(n)"; }

echo "── (1) the mesh worst case (the tiling period)"
setstate "{ dotColor: {colors:['#1b2a4a','#3b5bdb','#845ef7','#e5989a'], dir:'mesh'}, lineColor: {colors:['#101218','#2b2f45'], dir:'mesh'}, spaceParallax: 100, dotAnimate: true, lineAnimate: true, dotSizeVariation: 100, lineSizeVariation: 100 }"
sleep 1.1   # setstate's 1.1 + this = the 2.2 rebake settle
# paintMs: read twice 0.3s apart, take the second
ev "window.DoomalayDebug.paintMs" >/dev/null
sleep 0.3
J=$(ev "JSON.stringify({ oo: window.DoomalayDebug.oneObject, paintMs: window.DoomalayDebug.paintMs, batches: window.DoomalayDebug.batches, dots: window.DoomalayDebug.dots, over: !!(window.DoomalayDebug.overIcons||{}).on, iw: window.innerWidth, ih: window.innerHeight })")
python3 - "$J" <<'PYEOF' > /tmp/v098tile-mesh.txt
import json, sys
s = sys.argv[1].strip()
if s.startswith('"'): s = json.loads(s)
d = json.loads(s)
oo = d.get('oo') or {}
ma, mb, pc = oo.get('megaA'), oo.get('megaB'), oo.get('pairCells')
even = all(isinstance(x, int) and x % 2 == 0 for x in (ma, mb))
print('inter', 'yes' if (ma != mb and even) else 'no',
      f"(megaA={ma} megaB={mb} pairCells={pc})")
iw = d.get('iw', 0)
period = (pc or 0) * 48
print('period', 'yes' if (period >= 2 * iw) else 'no',
      f"(pairCells·48 = {period} vs 2×innerWidth = {2*iw}, viewport {d.get('iw')}x{d.get('ih')})")
print('tiles', 'yes' if oo.get('tiles', 99) <= 60 else 'no',
      f"(tiles={oo.get('tiles')}, bakeGen={oo.get('bakeGen')}, raster={oo.get('raster')}, tileMs={oo.get('tileMs')})")
print('paintms', 'yes' if d.get('paintMs', 99) < 5 else 'no', f"(paintMs={d.get('paintMs')}ms, second read)")
print('batches', 'yes' if d.get('batches', 99) <= 80 else 'no', f"(batches={d.get('batches')})")
print('over', 'yes' if d.get('over') else 'no', '')
print('dots', 'yes' if d.get('dots', 0) > 500 else 'no', f"(dots={d.get('dots')})")
be = oo.get('bakeError')
print('bakeerr', 'yes' if be is None else 'no', f"(bakeError={be})")
PYEOF
while IFS= read -r line; do
  K=$(echo "$line" | awk '{print $1}'); V=$(echo "$line" | awk '{print $2}'); REST=$(echo "$line" | cut -d ' ' -f3-)
  case "$K" in
    inter) ck "the interleave is live (megaA != megaB, both even)" "$V" "$REST" ;;
    period) ck "the joint period covers the screen (pairCells·48 ≥ 2× viewport width)" "$V" "$REST" ;;
    tiles) ck "tiles bounded (≤ 60)" "$V" "$REST" ;;
    paintms) ck "paintMs < 5ms" "$V" "$REST" ;;
    batches) ck "batches collapsed (≤ 80)" "$V" "$REST" ;;
    over) ck "over-icons gate works" "$V" "" ;;
    dots) ck "coverage populated (dots > 500)" "$V" "$REST" ;;
    bakeerr) ck "no bake errors (mesh worst case)" "$V" "$REST" ;;
  esac
done < /tmp/v098tile-mesh.txt
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

echo "── (2) the defaults leg (solid colors, no variation, no anims)"
setstate "{ dotColor: '#2e2e3a', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 0, lineSizeVariation: 0, dotScatter: 0, lineScatter: 0, dotSizeBias: 0, lineSizeBias: 0, dotRotation: 0, lineRotation: 0, gridSize: 1, workerPaint: false }"
sleep 1.1   # setstate's 1.1 + this = the 2.2 settle
J2=$(ev "JSON.stringify({ oo: window.DoomalayDebug.oneObject, batches: window.DoomalayDebug.batches, dots: window.DoomalayDebug.dots })")
python3 - "$J2" <<'PYEOF' > /tmp/v098tile-def.txt
import json, sys
s = sys.argv[1].strip()
if s.startswith('"'): s = json.loads(s)
d = json.loads(s)
oo = d.get('oo') or {}
ma, mb = oo.get('megaA'), oo.get('megaB')
print('inter', 'yes' if ma != mb else 'no', f"(megaA={ma} megaB={mb} pairCells={oo.get('pairCells')})")
print('tiles', 'yes' if oo.get('tiles', 99) <= 6 else 'no',
      f"(tiles={oo.get('tiles')}, batches={d.get('batches')}, dots={d.get('dots')})")
be = oo.get('bakeError')
print('bakeerr', 'yes' if be is None else 'no', f"(bakeError={be})")
PYEOF
while IFS= read -r line; do
  K=$(echo "$line" | awk '{print $1}'); V=$(echo "$line" | awk '{print $2}'); REST=$(echo "$line" | cut -d ' ' -f3-)
  case "$K" in
    inter) ck "defaults still interleaved (megaA != megaB)" "$V" "$REST" ;;
    tiles) ck "default tiles ≤ 6 (2 dot tiles + full-lines stay immediate)" "$V" "$REST" ;;
    bakeerr) ck "no bake errors (defaults)" "$V" "$REST" ;;
  esac
done < /tmp/v098tile-def.txt
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

echo
echo "═══ v098 tiling-period: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
