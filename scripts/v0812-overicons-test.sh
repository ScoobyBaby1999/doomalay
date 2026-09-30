#!/bin/bash
# v0812-overicons-test.sh — THE OVER-ICONS LAYER (user spec verbatim:
#   "with grid parallax at max AND amplify parallax ≥50%, dots/lines
#    exceeding 70% of max allowed random size must render ABOVE canvas
#    icons instead of beneath them"). The app's one parallax dial is
#    Amplify parallax, so the gate is amp ≥ 0.5:
#  (1) DEFAULT — gate off, #c2 exists (z 150, pointer-events none) and
#      is COMPLETELY transparent (byte-identical default).
#  (2) amp 40 (<50%) + full variation — still off (the ≥50% boundary).
#  (3) amp 50 + variation — gate on, dots AND lines route, thresholds
#      are exactly 70% of max allowed random size.
#  (4) THE ICON PROOF — a synthetic icon (z 100, inside #chatbots) is
#      placed over c2's lit bounding box: c2 carries lit pixels INSIDE
#      the icon's rect, sits ABOVE it in z (150 > 100) and AFTER
#      #chatbots in DOM order → composited over the icon; and
#      elementFromPoint still returns the icon (the layer never blocks
#      interaction — pointer-events:none).
#  (5) uniform sizes (variation 0, bias 0) at amp 100 — nothing routes
#      (the depth lattice's own no-spread exemption).
#  (6) bias-only spread (size 0 + bias 100) at amp 100 — routes (the
#      v0.81.1 effFrac feeds the threshold).
#  (7) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8333
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0812
export AGENT_BROWSER_SESSION=doomalay-v0812

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0812-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2.5
# v0.85.2: the pixel proofs (#c2 getImageData) read the DOM canvas — a
# worker-transferred canvas answers getContext(null) main-side, so this rig
# rides the MAIN-thread fallback. The toggle rides the LIVE settings state
# (a raw localStorage seed gets clobbered by the old page's pagehide
# flushSave); the same lattice.js — v0852 proves the worker path.
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
sleep 0.6
agent-browser open "$BASE" >/dev/null; sleep 2.5
agent-browser errors --clear >/dev/null
setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }

# (1) default: gate off, c2 transparent, correct chrome
D0=$(ev "(function(){
  var c2 = document.getElementById('c2');
  var g = c2.getContext('2d');
  var px = g.getImageData(0, 0, c2.width, c2.height).data;
  var lit = 0;
  for (var i = 3; i < px.length; i += 4) { if (px[i] > 0) { lit++; break; } }
  var cs = getComputedStyle(c2);
  var bots = document.getElementById('chatbots');
  return JSON.stringify({ over: window.DoomalayDebug.overIcons, lit: lit,
    z: cs.zIndex, pe: cs.pointerEvents,
    inBody: !!(c2.parentNode === document.body) });
})()")
Z1=$(echo "$D0" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['over']['on'] is False and d['lit'] == 0 and d['z'] == '150' and d['pe'] == 'none' and d['inBody']
print('yes' if ok else 'no')")
ck "default: gate off, #c2 transparent, z150/pointer-events:none, body-level" "$Z1" "$D0"

# (2) amp 40: boundary — off
setstate "{ spaceParallax: 40, dotSizeVariation: 100, lineSizeVariation: 100 }"
Z2=$(ev "(function(){ return window.DoomalayDebug.overIcons.on ? 'no' : 'yes'; })()")
ck "amp 40 + full variation: gate still OFF (<50% boundary)" "$Z2"

# (3) amp 50 + variation: on, both sides route, thresholds exact
setstate "{ spaceParallax: 50, dotSizeVariation: 80, lineSizeVariation: 80 }"
D1=$(ev "(function(){
  var d = window.DoomalayDebug;
  // expected thresholds, recomputed exactly as the renderer does
  // v0.83.1 THE WEIGHT supersession: the size spread doubled (±170% →
  // ±340%), so effFrac at variation 80 is 0.8·3.4 — the old 1.7 constant
  // here went stale when the weight wave landed (renderer verified right).
  var dotRBase = Math.max(0.6, 1.4 * Math.min(1, 1.3));
  var effFracD = 80 / 100 * 3.4, effFracL = 80 / 100 * 3.4;
  return JSON.stringify({ over: d.overIcons,
    tDok: Math.abs(d.overIcons.threshD - 0.7 * dotRBase * (1 + effFracD)) < 1e-9,
    tLok: Math.abs(d.overIcons.threshL - 0.7 * (1 + effFracL)) < 1e-9 });
})()")
Z3=$(echo "$D1" | python3 -c "
import json,sys
d = json.load(sys.stdin)
o = d['over']
ok = o['on'] and o['dots'] > 0 and o['lines'] > 0 and d['tDok'] and d['tLok']
print('yes' if ok else 'no')")
ck "amp 50 + variation 80: dots+lines route; thresholds = 70% of max size" "$Z3" "$D1"

# (4) THE ICON PROOF
D2=$(ev "(function(){
  var c2 = document.getElementById('c2');
  var g = c2.getContext('2d');
  var w = c2.width, h = c2.height;
  var px = g.getImageData(0, 0, w, h).data;
  var minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y += 2) {
    for (var x = 0; x < w; x += 2) {
      if (px[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return JSON.stringify({ lit: 0 });
  // a synthetic chatbot icon (the real ones' exact chrome: z 100,
  // inside #chatbots) covering c2's lit bounding box
  var bots = document.getElementById('chatbots');
  var b = document.createElement('div');
  b.id = 'v0812-icon';
  b.style.cssText = 'position:absolute;pointer-events:auto;background:#ff0000;z-index:2;' +
    'left:' + Math.max(0, minX - 10) + 'px;top:' + Math.max(0, minY - 10) + 'px;' +
    'width:' + Math.min(w, maxX - minX + 20) + 'px;height:' + Math.min(h, maxY - minY + 20) + 'px;';
  bots.appendChild(b);
  var br = b.getBoundingClientRect();
  // any lit c2 pixel INSIDE the icon rect?
  var inside = 0;
  for (var y2 = Math.max(0, br.top); y2 < Math.min(h, br.bottom); y2 += 2) {
    for (var x2 = Math.max(0, br.left); x2 < Math.min(w, br.right); x2 += 2) {
      if (px[(y2 * w + x2) * 4 + 3] > 0) { inside++; }
    }
  }
  // the hit-test: c2 is pointer-events:none — the icon stays reachable
  var hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
  var zc2 = parseInt(getComputedStyle(c2).zIndex, 10);
  var zbots = parseInt(getComputedStyle(bots).zIndex, 10);
  b.remove();
  return JSON.stringify({ lit: 1, inside: inside, hitIcon: !!(hit && (hit.id === 'v0812-icon' || hit.closest && hit.closest('#v0812-icon'))),
    zc2: zc2, zbots: zbots });
})()")
Z4=$(echo "$D2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
# both are positioned body-level siblings with z-index set → z decides
ok = (d.get('lit') == 1 and d['inside'] > 0 and d['hitIcon'] and d['zc2'] > d['zbots'])
print('yes' if ok else 'no')")
ck "ICON PROOF: c2 lit INSIDE an icon's rect, above it (z 150 > 100), icon still hittable" "$Z4" "$D2"

# (5) uniform at amp 100: the no-spread exemption
setstate "{ spaceParallax: 100, dotSizeVariation: 0, lineSizeVariation: 0, dotSizeBias: 0, lineSizeBias: 0 }"
D3=$(ev "(function(){ var o = window.DoomalayDebug.overIcons; return JSON.stringify({ on: o.on, d: o.dots, l: o.lines }); })()")
Z5=$(echo "$D3" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['on'] is False and d['d'] == 0 and d['l'] == 0
print('yes' if ok else 'no')")
ck "amp 100 + uniform sizes: nothing routes (the lattice's no-spread rule)" "$Z5" "$D3"

# (6) bias-only spread routes (v0.81.1 effFrac feeds the threshold)
setstate "{ dotSizeBias: 100, lineSizeBias: 100 }"
D4=$(ev "(function(){ var o = window.DoomalayDebug.overIcons; return JSON.stringify({ on: o.on, d: o.dots, l: o.lines }); })()")
Z6=$(echo "$D4" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['on'] and d['d'] > 0 and d['l'] > 0
print('yes' if ok else 'no')")
ck "amp 100 + bias-only spread (size 0): the biggest still pass over the icons" "$Z6" "$D4"

ERRS=$(agent-browser errors 2>/dev/null | python3 -c "
import sys
lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
print(len(lines))")
ck "zero console errors across the whole ride" "$( [ "$ERRS" = "0" ] && echo yes || echo no )" "$ERRS errors"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0812 OVER-ICONS: ALL GREEN" || exit 1
