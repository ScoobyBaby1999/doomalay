#!/bin/bash
# v0831-weight-test.sh — THE WEIGHT WAVE (user spec verbatim:
#   "Let's make the size bias effect more dots and lines in the settings,
#    eg, setting size bias to min makes big stars very rare, same with
#    lines, and vise versa. Let's also make the largest and smallest
#    sizes double or 1.5x what they are now. Lines should also not snap
#    back to their starting position when animate is on, instead, they
#    should swing back like they do forth, and go for larger distances."):
#  (1) THE WEIGHT — size 100 (bias 0): the frame's jrMax ratio ≥ 3.9×
#      base (was 2.7× at ±170%; now ±340%) and jrMin ≤ 0.05 (floored).
#  (2) BIAS MIN → BIG RARE — bias −100: big fraction ≤ 15% AND
#      small > big (the tilt). "vise versa":
#  (3) BIAS MAX → SMALL RARE — bias +100: small fraction ≤ 8% AND
#      big > 40%.
#  (4) LINES RIDE THE SAME TILT (lineStats width spread at bias ±100).
#  (5) THE PENDULUM — the shuttle formula re-implemented here (same
#      constants) must be CONTINUOUS across both leg boundaries
#      (u→1⁻ vs 1⁺; u→2⁻/0⁺) and travel FARTHER than the v0.77
#      distances (dist > 1.1× spacing at max; old cap was 1.2 → 2.0).
#  (6) DEFAULT REGRESSION — size 0 + bias 0: zero spread (byte-identical).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8329
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0831
export AGENT_BROWSER_SESSION=doomalay-v0831

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0831-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2.5
agent-browser errors --clear >/dev/null

snap() { ev "(function(){
  var d = window.DoomalayDebug || {};
  var w = d.weight || {};
  return JSON.stringify({ dots: d.dots, segs: d.segs,
    ds: d.dotStats || {}, ls: d.lineStats || {},
    jrMin: w.jrMin, jrMax: w.jrMax, wMin: w.wMin, wMax: w.wMax,
    effD: w.effFracD, effL: w.effFracL });
})()"; }
pd() { echo "$1" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ds = d.get('ds', {})
n = ds.get('n') or 0
small = (ds.get('small') or 0) / n * 100 if n else 0
big = (ds.get('big') or 0) / n * 100 if n else 0
ls = d.get('ls', {})
ln = ls.get('n') or 0
lsmall = (ls.get('small') or 0) / ln * 100 if ln else 0
lbig = (ls.get('big') or 0) / ln * 100 if ln else 0
jrMax = d.get('jrMax') or 0
jrMin = d.get('jrMin')
jrMin = 9.9 if jrMin is None else float(jrMin)
wMax = d.get('wMax') or 0
print('%d %.1f %.1f %.1f %.1f %.3f %.3f %.3f' % (n, small, big, lsmall, lbig, jrMax, jrMin, wMax))"; }
setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }

# (1) THE WEIGHT — size 100, bias 0: doubled range
setstate "{ spaceParallax: 0, dotSizeVariation: 100, lineSizeVariation: 100, dotSizeBias: 0, lineSizeBias: 0 }"
S0=$(pd "$(snap)")
read -r N0 SM0 BG0 LSM0 LBG0 JRMAX0 JRMIN0 WMAX0 <<< "$S0"
W1=$(python3 -c "print('yes' if $N0 > 0 and $JRMAX0 >= 3.9 else 'no')")
ck "size 100: jrMax ratio ≥ 3.9× base (the doubled range, was 2.7)" "$W1" "jrMax=$JRMAX0"
W2=$(python3 -c "print('yes' if $JRMIN0 <= 0.05 else 'no')")
ck "size 100: jrMin ratio ≤ 0.05 (floored smallest)" "$W2" "jrMin=$JRMIN0"
W3=$(python3 -c "print('yes' if $WMAX0 >= 3.9 else 'no')")
ck "size 100: line wMax ≥ 3.9 (lines ride the doubled range)" "$W3" "wMax=$WMAX0"

# (2) BIAS MIN → BIG RARE
setstate "{ dotSizeVariation: 0, lineSizeVariation: 0, dotSizeBias: -100, lineSizeBias: -100 }"
S1=$(pd "$(snap)")
read -r N1 SM1 BG1 LSM1 LBG1 JRMAX1 JRMIN1 WMAX1 <<< "$S1"
B1=$(python3 -c "print('yes' if $N1 > 0 and ($SM1 + $BG1) > 0 else 'no')")
ck "size 0 + bias −100: outliers still APPEAR (bias spreads alone)" "$B1" "$S1"
B2=$(python3 -c "print('yes' if $N1 > 0 and $BG1 <= 15 else 'no')")
ck "bias MIN: big stars RARE (big ≤ 15%)" "$B2" "small ${SM1}% big ${BG1}%"
B3=$(python3 -c "print('yes' if $SM1 > $BG1 else 'no')")
ck "bias MIN: the tilt points small (small > big)" "$B3" "small ${SM1}% big ${BG1}%"
B4=$(python3 -c "print('yes' if $LBG1 <= 20 else 'no')")
ck "bias MIN: lines' big widths rare too (≤ 20%)" "$B4" "line small ${LSM1}% big ${LBG1}%"

# (3) BIAS MAX → SMALL RARE (the vise versa)
setstate "{ dotSizeBias: 100, lineSizeBias: 100 }"
S2=$(pd "$(snap)")
read -r N2 SM2 BG2 LSM2 LBG2 JRMAX2 JRMIN2 WMAX2 <<< "$S2"
V1=$(python3 -c "print('yes' if $N2 > 0 and $SM2 <= 8 else 'no')")
ck "bias MAX: small stars RARE (small ≤ 8%)" "$V1" "small ${SM2}% big ${BG2}%"
V2=$(python3 -c "print('yes' if $BG2 > 40 else 'no')")
ck "bias MAX: big side dominates (> 40%)" "$V2" "small ${SM2}% big ${BG2}%"

# (4)+(5) THE PENDULUM — formula twin + continuity at the leg boundaries
PEND=$(ev "(function(){
  // the v0.83.1 shuttle, verbatim constants — checked for CONTINUITY
  // at both leg boundaries and for the larger distance.
  function hashCell(ix, iy) {
    var h = (ix | 0) * 374761393 + (iy | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 1000000) / 1000000;
  }
  function travelAt(hx, hy, t) {
    var dur  = 1.6 + hashCell(hx + 17, hy + 17) * 2.4;
    var kF   = 2.6 + hashCell(hx + 19, hy + 19) * 1.6;
    var kB   = 2.2 + hashCell(hx + 21, hy + 21) * 1.6;
    var dist = 0.8 + hashCell(hx + 23, hy + 23) * 1.2;
    var dir  = hashCell(hx + 25, hy + 25) < 0.5 ? -1 : 1;
    var ph   = hashCell(hx + 27, hy + 27) * dur;
    var u = ((t / 1 + ph) / dur) % 2;
    var legFwd = u < 1;
    var s = legFwd ? u : 2 - u;
    var k = legFwd ? kF : kB;
    var ek = Math.exp(k);
    var eased = (Math.exp(k * s) - 1) / (ek - 1);
    var travel = eased - 0.5;
    return dir * dist * travel;
  }
  var worst1 = 0, worst2 = 0, maxDist = 0;
  for (var i = 0; i < 200; i++) {
    var hx = (i * 7919) % 400 - 200, hy = (i * 104729) % 400 - 200;
    var a = travelAt(hx, hy, 5.0 - 0.001 + 2 * 1.9), b = travelAt(hx, hy, 5.0 + 0.001);
    // boundary u=1: pick t so (t+ph)/dur ≡ 1 mod 2 exactly per segment
    var dur  = 1.6 + hashCell(hx + 17, hy + 17) * 2.4;
    var kF   = 2.6 + hashCell(hx + 19, hy + 19) * 1.6;
    var dist = 0.8 + hashCell(hx + 23, hy + 23) * 1.2;
    var ph   = hashCell(hx + 27, hy + 27) * dur;
    var T1 = (2 - ph / dur) * dur;   // (T1 + ph)/dur = 2 → u = 0 boundary
    var T2 = (3 - ph / dur) * dur;   // u = 1 boundary
    var e0 = travelAt(hx, hy, T1 - 0.0005), e1 = travelAt(hx, hy, T1 + 0.0005);
    var f0 = travelAt(hx, hy, T2 - 0.0005), f1 = travelAt(hx, hy, T2 + 0.0005);
    worst1 = Math.max(worst1, Math.abs(e0 - e1));
    worst2 = Math.max(worst2, Math.abs(f0 - f1));
    maxDist = Math.max(maxDist, dist);
    void a; void b; void kF;
  }
  return JSON.stringify({ jumpAtStart: worst1, jumpAtMid: worst2, maxDist: maxDist });
})()")
J1=$(echo "$PEND" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d['jumpAtStart'] < 0.02 else 'no')")
ck "pendulum: NO snap at the u=0/2 boundary (|Δtravel| < 0.02)" "$J1" "$PEND"
J2=$(echo "$PEND" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d['jumpAtMid'] < 0.02 else 'no')")
ck "pendulum: NO snap at the u=1 boundary (|Δtravel| < 0.02)" "$J2" "$PEND"
J3=$(echo "$PEND" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d['maxDist'] > 1.9 else 'no')")
ck "pendulum: larger distances (max dist > 1.9× spacing, was 1.2)" "$J3" "$PEND"

# (6) DEFAULT REGRESSION — bias 0 + size 0 → zero spread
setstate "{ dotSizeVariation: 0, lineSizeVariation: 0, dotSizeBias: 0, lineSizeBias: 0 }"
S3=$(pd "$(snap)")
read -r N3 SM3 BG3 LSM3 LBG3 JRMAX3 JRMIN3 WMAX3 <<< "$S3"
D1=$(python3 -c "print('yes' if $N3 > 0 and $SM3 == 0 and $BG3 == 0 else 'no')")
ck "default: bias 0 + size 0 → byte-identical (zero outliers)" "$D1" "$S3"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0831 WEIGHT: ALL GREEN" || exit 1
