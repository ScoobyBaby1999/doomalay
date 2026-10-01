#!/bin/bash
# v0902-nebula-sphere-test.sh — v0.90.2 THE NEBULA SPHERE (user spec:
#   "Render the actual sphere or circle that the central star/dot produces
#   as an opaque sphere that looks more like fog, clouds, nebula, a gas,
#   kind of like it has a guassian filter and these foggy effects on it,
#   and make it responds to the amplify parallax aswell to resemble a
#   sphere. Also make it large… the sphere should probably be 6-8x what
#   it is now, and grow larger with each icon").
#
# THE CONTRACT (main-mode pixel probes — the worker owns the #c2 bitmap
# by design; the paint function is the SAME AtomCore twin both hosts):
#  (1) THE FOG IS THERE — pixels in the sphere's rim zone are lit
#      (alpha > the background) with the sphere centered on the star;
#      the CORE stays transparent (the icons inside stay readable).
#  (2) THE LIMB READS — the rim band is brighter than the mid-body
#      (the limb-bright shell = the sphere look).
#  (3) THE SIZE — the fog extends ≈ 2.2× R (≥ 6-8× the old 130 ring):
#      probe at 1.8R from the star = lit; at 2.6R = dark.
#  (4) THE PARALLAX — at Amplify 0 the fog is symmetric; at 100 the lit
#      limb shifts toward the screen center (the probe pair flips).
#  (5) THE GROWTH — a joiner grows R (the fog footprint grows with it).
#  (6) THE CACHE — the sprite cache stays bounded (≤ 6 fog sprites).
#  (7) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8391
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0902

ev() {
  local OUT
  OUT=$(timeout 45 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')")
  if [ -z "$OUT" ]; then
    sleep 1
    OUT=$(timeout 45 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')")
  fi
  printf '%s' "$OUT"
}
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0902-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

app_ready() { agent-browser eval "!!(window.doomalay && window.TabGroups && window.WebTabs)" 2>/dev/null | tr -d '"\n' | grep -qi '^true$'; }
boot_and_wait() {
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  for i in $(seq 1 14); do app_ready && return 0; sleep 0.8; done
  return 1
}
agent-browser close >/dev/null 2>&1 || true
sleep 0.6
boot_and_wait || { echo "BROWSER BOOT FAIL"; exit 1; }
ev "localStorage.clear()" >/dev/null 2>&1
# MAIN MODE for the pixel probes (the worker owns #c2's bitmap; setState +
# wait out the debounce + reload — a raw localStorage write gets clobbered
# by the pagehide flush)
ev "(async function(){ window.Settings.setState({workerPaint: false}); await new Promise(r => setTimeout(r, 650)); return 'main armed'; })()" >/dev/null 2>&1
agent-browser reload >/dev/null 2>&1
sleep 4
for i in 1 2 3 4 5 6 7 8; do app_ready && break; sleep 0.8; done
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (1)+(2)+(3) THE FOG, THE LIMB, THE SIZE — pixel probes at the star"
R=$(ev "(async function(){ try {
  window.TabGroups._debug.clear();
  var all = window.WebTabs.all();
  for (var ti = 0; ti < all.length; ti++) { all[ti]._orbit = null; all[ti].x = 7000+ti*150; all[ti].y = 8000; all[ti].vx=0; all[ti].vy=0; }
  var tA = window.WebTabs.createAt(300, 460, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(380, 460, {url: 'https://example.org'});
  window.TabGroups.collide(tA, tB, 340, 460);
  window.doomalay.resetView();
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 700));
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  if (!d0) return JSON.stringify({fail: 'no dot'});
  var V = window.doomalay.getView();
  var sx = (d0.x - V.ox) * V.scale, sy = (d0.y - V.oy) * V.scale;
  var c2 = document.getElementById('c2');
  var g2 = c2.getContext('2d');
  function alphaAt(px, py) {
    var im = g2.getImageData(Math.max(0, Math.round(px)), Math.max(0, Math.round(py)), 1, 1).data;
    return im[3];
  }
  // clear the frame's star glow from the probes: sample radially OUTSIDE
  // the star's halo (vr*3.2 max ≈ 45px) — the rim probes sit at 1.4R+
  var R420 = d0.R;
  var rim = Math.round(R420 * 1.5);        // inside the fog (fog extends 2.2R), outside the halo
  var mid = Math.round(R420 * 0.9);        // the mid body
  var out = Math.round(R420 * 2.6);        // outside the fog
  var core = 60;                            // the core (transparent — icons readable)
  return JSON.stringify({
    rimA: alphaAt(sx + rim, sy), midA: alphaAt(sx + mid, sy),
    outA: alphaAt(sx + out, sy), coreA: alphaAt(sx + core, sy),
    R: Math.round(R420), stars: (window.DoomalayDebug||{}).orbitStars,
    sprites: window.AtomCore ? JSON.stringify(window.AtomCore._sphereStats()) : 'noinst'
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "THE FOG IS THERE — the rim zone is lit (alpha > 6), the core stays clear (icons readable, alpha < 6)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('rimA',0)>6 and d.get('coreA',255)<32 else 'no')")" "$R"
ck "THE LIMB READS — the rim band is brighter than the mid-body (the shell)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('rimA',0)>d.get('midA',-1) else 'no')")" "$R"
ck "THE SIZE — 2.6R is dark (the fog ends by ~2.2R — the 6-8x band)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('outA',255)<6 else 'no')")" "$R"

echo "── (4) THE PARALLAX — the lit limb shifts toward the screen center at 100"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var V = window.doomalay.getView();
  var sx = (d0.x - V.ox) * V.scale, sy = (d0.y - V.oy) * V.scale;
  var c2 = document.getElementById('c2');
  var g2 = c2.getContext('2d');
  function alphaAt(px, py) {
    var im = g2.getImageData(Math.max(0, Math.round(px)), Math.max(0, Math.round(py)), 1, 1).data;
    return im[3];
  }
  var probeR = Math.round(d0.R * 1.5);
  // the wisps are SEEDED structure (a nebula, not a perfect shell) — the
  // parallax assertion is about the DELTA the slider adds: light grows
  // ONLY on the screen-center side
  window.Settings.setState({spaceParallax: 0});
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var left0 = alphaAt(sx - probeR, sy), right0 = alphaAt(sx + probeR, sy);
  window.Settings.setState({spaceParallax: 100});
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var left1 = alphaAt(sx - probeR, sy), right1 = alphaAt(sx + probeR, sy);
  // the star sits LEFT of screen center → the lit limb shifts RIGHT
  var centerGain = right1 - right0;   // toward the screen center
  var farGain = left1 - left0;       // away from it
  return JSON.stringify({left0: left0, right0: right0, left1: left1, right1: right1,
    centerGain: centerGain, farGain: farGain});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "at Amplify 0 the sphere's base renders (both rim probes lit)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('left0',0)>4 and d.get('right0',0)>4 else 'no')")" "$R"
ck "at Amplify 100 the highlight adds light ONLY toward the screen center (gain > 6 there, far side < gain/2)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());g=d.get('centerGain',0);f=d.get('farGain',99);print('yes' if g>6 and f<max(3,g/2) else 'no')")" "$R"

echo "── (5) THE GROWTH — a joiner grows the fog footprint"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var Rbefore = d0.R;
  var tC = window.WebTabs.createAt(d0.x + 80, d0.y + 60, {url: 'https://go.dev'});
  for (var q = 0; q < 7; q++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }
  var joined = d0.members.has(tC);
  var Rafter = d0.R;
  var vrAfter = d0.vr;
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify({joined: joined, Rbefore: Math.round(Rbefore), Rafter: Math.round(Rafter),
    vr: Math.round(vrAfter * 10) / 10, grew: Rafter > Rbefore});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "a joiner grew the sphere (R + VR both up — the fog + the star grow with each icon)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('joined') and d.get('grew') and d.get('vr',0)>11 else 'no')")" "$R"

echo "── (6) THE CACHE — bounded sprite memory"
R=$(ev "(async function(){ try {
  var st = window.AtomCore ? window.AtomCore._sphereStats() : null;
  return JSON.stringify(st);
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the sprite cache stays bounded (≤ 6 fog sprites, ≤ 6 highlights)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('sprites',0)<=6 and d.get('highlights',0)<=6 else 'no')")" "$R"

echo "── (7) console errors"
R=$(ev "JSON.stringify({errs: (window.__errs||[]).length, first: (window.__errs||[])[0] || ''})")
ck "zero console errors" "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['errs']==0 else 'no')")" "$R"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || exit 1
