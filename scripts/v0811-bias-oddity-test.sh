#!/bin/bash
# v0811-bias-oddity-test.sh — THE BIAS ODDITY WAVE (user spec verbatim:
#   "with size at 0 or max and bias opposite, big/small outliers should
#    still appear; bias should make opposite-size dots/lines a common
#    occurrence, not rare"):
#  (1) BYTE-IDENTICAL DEFAULT — size 0 + bias 0: zero spread (no small,
#      no big outliers) — the no-bias path never shifts.
#  (2) SIZE 0 + BIAS ±100 → OUTLIERS APPEAR (dotStats small+big > 0);
#      before v0.81.1 bias was a dead slider at size 0 (spread 0).
#  (3) THE OPPOSITE TAIL IS COMMON — at full bias the non-favored side
#      holds ≥ 12% of dots (the user's "common occurrence, not rare";
#      the old exponent left ~6-16% with the pile-up just-off-mid).
#  (4) THE TILT STILL TILTS — the favored side outnumbers the opposite.
#  (5) SIZE MAX + BIAS OPPOSITE → outliers on BOTH sides, opposite ≥ 12%.
#  (6) LINES RIDE THE SAME CONTRACT (lineStats via segment widths).
#  (7) BIAS 0 + SIZE 100 (regression): the classic ±170% spread intact.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8327
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0811
export AGENT_BROWSER_SESSION=doomalay-v0811

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0811-eng.log 2>&1 &
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
  return JSON.stringify({ dots: d.dots, segs: d.segs,
    ds: d.dotStats || {}, ls: d.lineStats || {} });
})()"; }
# dots: {small, big, n} — percentages below are of n (dots painted)
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
print('%d %.1f %.1f %.1f %.1f' % (n, small, big, lsmall, lbig))"; }
setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }

# (1) default: size 0 bias 0 → NO spread anywhere
setstate "{ spaceParallax: 0, dotSizeVariation: 0, lineSizeVariation: 0, dotSizeBias: 0, lineSizeBias: 0 }"
S0=$(pd "$(snap)")
read -r N0 SM0 BG0 LSM0 LBG0 <<< "$S0"
Z1=$(python3 -c "print('yes' if $N0 > 0 and $SM0 == 0 and $BG0 == 0 else 'no')")
ck "size 0 + bias 0: byte-identical default (zero outliers, $N0 dots)" "$Z1" "$S0"

# (2)+(3)+(4) size 0 + bias +100 (favors larger → small is the OPPOSITE tail)
setstate "{ dotSizeBias: 100, lineSizeBias: 100 }"
S1=$(pd "$(snap)")
read -r N1 SM1 BG1 LSM1 LBG1 <<< "$S1"
Z2=$(python3 -c "print('yes' if $N1 > 0 and ($SM1 + $BG1) > 0 else 'no')")
ck "size 0 + bias 100: outliers APPEAR at all (dot small+big > 0%)" "$Z2" "$S1"
Z3=$(python3 -c "print('yes' if $SM1 >= 12 and $BG1 >= 12 else 'no')")
ck "size 0 + bias 100: BOTH tails common (≥12% small AND ≥12% big)" "$Z3" "small ${SM1}% big ${BG1}%"
Z4=$(python3 -c "print('yes' if $BG1 > $SM1 else 'no')")
ck "size 0 + bias +100: the tilt still tilts (big > small)" "$Z4" "small ${SM1}% big ${BG1}%"

# (5) size max + bias opposite (bias −100 while size 100 → big is opposite)
setstate "{ dotSizeVariation: 100, lineSizeVariation: 100, dotSizeBias: -100, lineSizeBias: -100 }"
S2=$(pd "$(snap)")
read -r N2 SM2 BG2 LSM2 LBG2 <<< "$S2"
Z5=$(python3 -c "print('yes' if $SM2 >= 12 and $BG2 >= 12 else 'no')")
ck "size 100 + bias −100: opposite tail (big) common too (≥12% both)" "$Z5" "small ${SM2}% big ${BG2}%"
Z6=$(python3 -c "print('yes' if $SM2 > $BG2 else 'no')")
ck "size 100 + bias −100: tilt points small (small > big)" "$Z6" "small ${SM2}% big ${BG2}%"

# (6) lines ride the same contract (segment widths, size 0 + bias)
setstate "{ dotSizeBias: 100, lineSizeBias: 100, dotSizeVariation: 0, lineSizeVariation: 0 }"
S3=$(pd "$(snap)")
read -r N3 SM3 BG3 LSM3 LBG3 <<< "$S3"
Z7=$(python3 -c "print('yes' if ($LSM3 + $LBG3) > 0 and $LSM3 >= 10 and $LBG3 >= 10 else 'no')")
ck "lines: size 0 + bias 100 spreads widths too (both tails ≥10%)" "$Z7" "line small ${LSM3}% big ${LBG3}%"

# (7) regression: bias 0 + size 100 keeps the classic spread
setstate "{ dotSizeBias: 0, lineSizeBias: 0, dotSizeVariation: 100, lineSizeVariation: 100 }"
S4=$(pd "$(snap)")
read -r N4 SM4 BG4 LSM4 LBG4 <<< "$S4"
Z8=$(python3 -c "print('yes' if $SM4 >= 25 and $BG4 >= 25 else 'no')")
ck "regression: bias 0 + size 100 → classic ±170% spread (both ≥25%)" "$Z8" "small ${SM4}% big ${BG4}%"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0811 BIAS-ODDITY: ALL GREEN" || exit 1
