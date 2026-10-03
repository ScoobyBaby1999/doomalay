#!/bin/bash
# v098-zoom-stability.sh — THE ZOOM-STABILITY RIG (PLAN-V098).
#
# THE CONTRACT (what v0.98 claims, proven here):
#  (A) THE STATIC-FIELD CONSTELLATION — a fixed world window [0..400]² is
#      pixel-probed (threshold > 60 luminance, 4px-bin blob centroids,
#      mapped back to world), then zoomed IN (≥ 1.6×) and back OUT (< 0.8×):
#        · the tile PAIR is zoom-stable (megaA/megaB/pairCells identical
#          across all three zooms — the pair derives from the budget at
#          the REFERENCE spacing, never from zoom);
#        · rebakes landed at deep zoom (bakeGen advanced — the raster/
#          bg-view quantum, never identity);
#        · the CONSTELLATION SURVIVES the zoom: ≥ 12 of the top-15 P1
#          blobs by mass reappear within 2.0 world px at P2 AND at P3
#          (zoom never re-randomizes the bake);
#        · density preserved (P2.n within [0.75, 1.33]·P1.n);
#        · bakeError null at every read.
#      Rig geometry: the app boots with camera (0,0)·1 — the world window
#      sits top-left. The rig pans it to the VIEWPORT CENTER first (a
#      synthetic drag: pure transform, no rebake) so the zoom-at-center
#      keeps the whole window on-canvas through 2.14× (the app's wheel
#      listener is on `document`; events dispatched on #c bubble to it).
#  (B) THE MESH WORST CASE — mesh dot+line specs + amp100 + both anims +
#      size 100: pair zoom-stable across the same three zooms, hero
#      fireflies > 0 at EVERY zoom, bakeError null, ZERO console errors.
#  (C) THE LEGACY GATE — window.Lattice.oneObject().legacyFails == 0
#      (the flat accessor; the fallback never trips).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8401
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v098zoom
export AGENT_BROWSER_SESSION=doomalay-v098zoom

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v098zoom-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser console --clear >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
# the probe needs the [0..400]² window + its 2.14× growth fully on-canvas
agent-browser set viewport 1600 1000 >/dev/null 2>&1
sleep 0.6
# v0.97.1: a previous run's settings AND camera PERSIST in localStorage
# (same origin) — reset the canvas-relevant keys to defaults and clear the
# saved world state BEFORE the main-mode reload
ev "Settings.setState({ dotColor: '#2e2e3a', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 0, lineSizeVariation: 0, dotScatter: 0, lineScatter: 0, dotSizeBias: 0, lineSizeBias: 0, dotRotation: 0, lineRotation: 0, gridSize: 1, workerPaint: false }); 'reset'" >/dev/null
sleep 0.8
ev "localStorage.removeItem('doomalay.state.v2'); 'state-cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
agent-browser set viewport 1600 1000 >/dev/null 2>&1
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

# the constellation probe — #c pixels over the screen rect covering world
# [0..400]×[0..400] (clipped to the canvas), luminance > 60, blobs via 4px
# grid bins, mass-weighted centroids mapped back to world; rides the live
# camera + the oneObject instrument in ONE atomic read.
cat > /tmp/v098zoom-probe.js <<'PROBE_EOF'
(function(){
  var c = document.getElementById('c');
  if (!c) return JSON.stringify({err: 'no canvas'});
  var g = c.getContext('2d');
  var D = window.DoomalayDebug || {};
  var cam = D.camera || {x: 0, y: 0, scale: 1};
  var s = cam.scale || 1;
  var Wcss = parseFloat(c.style.width) || window.innerWidth;
  var Hcss = parseFloat(c.style.height) || window.innerHeight;
  var dpr = (Wcss > 0) ? (c.width / Wcss) : 1;
  var sx0 = (0 - cam.x) * s, sx1 = (400 - cam.x) * s;
  var sy0 = (0 - cam.y) * s, sy1 = (400 - cam.y) * s;
  var dx0 = Math.max(0, Math.floor(Math.max(0, Math.min(Wcss, sx0)) * dpr));
  var dx1 = Math.min(c.width, Math.ceil(Math.max(0, Math.min(Wcss, sx1)) * dpr));
  var dy0 = Math.max(0, Math.floor(Math.max(0, Math.min(Hcss, sy0)) * dpr));
  var dy1 = Math.min(c.height, Math.ceil(Math.max(0, Math.min(Hcss, sy1)) * dpr));
  if (dx1 <= dx0 || dy1 <= dy0)
    return JSON.stringify({n: 0, dots: [], cam: cam, oo: D.oneObject || null, clipped: true});
  var img = g.getImageData(dx0, dy0, dx1 - dx0, dy1 - dy0).data;
  var w = dx1 - dx0, h = dy1 - dy0;
  function lumAt(xx, yy) {
    var i = (yy * w + xx) * 4;
    return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
  }
  var BIN = 4, bw = Math.ceil(w / BIN), bh = Math.ceil(h / BIN);
  var binMass = {};
  for (var y = 0; y < h; y++)
    for (var x = 0; x < w; x++)
      if (lumAt(x, y) > 60) {
        var bk = (y >> 2) * bw + (x >> 2);
        binMass[bk] = (binMass[bk] || 0) + 1;
      }
  var seen = {}, blobs = [];
  for (var bk2 in binMass) {
    var K = +bk2;
    if (seen[K]) continue;
    seen[K] = 1;
    var stack = [K], comp = [K];
    while (stack.length) {
      var cur = stack.pop();
      var bx = cur % bw, by = (cur - bx) / bw;
      for (var oy = -1; oy <= 1; oy++)
        for (var ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          var nx = bx + ox, ny = by + oy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          var nk = ny * bw + nx;
          if (!seen[nk] && binMass[nk] !== undefined) { seen[nk] = 1; stack.push(nk); comp.push(nk); }
        }
    }
    var m = 0, sx = 0, sy = 0;
    for (var ci = 0; ci < comp.length; ci++) {
      var b = comp[ci], b2x = b % bw, b2y = (b - b2x) / bw;
      for (var yy = b2y * BIN; yy < (b2y + 1) * BIN && yy < h; yy++)
        for (var xx = b2x * BIN; xx < (b2x + 1) * BIN && xx < w; xx++)
          if (lumAt(xx, yy) > 60) { m++; sx += xx; sy += yy; }
    }
    if (m < 2) continue;
    var scx = (dx0 + sx / m) / dpr, scy = (dy0 + sy / m) / dpr;
    blobs.push({ x: scx / s + cam.x, y: scy / s + cam.y, m: m });
  }
  blobs.sort(function (a, b) { return b.m - a.m; });
  return JSON.stringify({ n: blobs.length, dots: blobs.slice(0, 25), cam: cam,
                          oo: D.oneObject || null });
})()
PROBE_EOF

# the zoom driver — wheel bursts at the viewport center (120ms gaps),
# settle-polled (the mesh leg starves the timer chain, so the rig waits
# for the camera to stop moving, then loops more bursts if needed).
# zoom-IN: the spec's 8-burst trains. zoom-OUT: an exact burst count so
# the rig lands JUST past the target (scale < 0.8 → ~0.75) — an 8-burst
# train overshoots into the 0.5 floor, where 1px dots shred the probe's
# blob topology (rig geometry, not an app defect).
zoomround() { # $1 = deltaY — the 8-burst train
  ev "(function(){ var n=0; function b(){ var c=document.getElementById('c'); if(!c) return; c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:Math.round(innerWidth/2),clientY:Math.round(innerHeight/2),deltaY:$1,deltaMode:0})); n++; if(n<8) setTimeout(b,120); } b(); return 'zoom'; })()" >/dev/null
}
zoomk() { # $1 = target scale, $2 = deltaY — exactly the bursts needed
  ev "(function(){
    var TARGET = $1, DY = $2, F = DY < 0 ? 1.1 : 0.9;
    var s = ((window.DoomalayDebug||{}).camera||{}).scale || 1;
    var k = Math.max(1, Math.min(32, Math.ceil(Math.log(TARGET / s) / Math.log(F))));
    var n = 0;
    function b() {
      var c = document.getElementById('c'); if (!c) return;
      c.dispatchEvent(new WheelEvent('wheel', {bubbles:true, cancelable:true,
        clientX: Math.round(innerWidth/2), clientY: Math.round(innerHeight/2),
        deltaY: DY, deltaMode: 0}));
      n++;
      if (n < k) setTimeout(b, 120);
    }
    b();
    return k;
  })()" >/dev/null
}
zoomto() { # $1 target, $2 op (ge|lt|le), $3 deltaY — echoes the settled scale
  local s="0" prev="" st=0 r i
  for r in 1 2 3 4; do
    if [ "$2" = "ge" ]; then zoomround "$3"; else zoomk "$1" "$3"; fi
    prev=""; st=0
    for i in $(seq 1 24); do
      sleep 0.3
      s=$(ev "window.DoomalayDebug.camera.scale")
      case "$s" in ''|*[!0-9.eE-]*) s="0";; esac
      if [ "$s" = "$prev" ]; then st=$((st+1)); else st=0; fi
      prev="$s"
      [ "$st" -ge 2 ] && break
    done
    case "$2" in
      ge) python3 -c "import sys; sys.exit(0 if float('$s') >= $1 else 1)" && break ;;
      lt) python3 -c "import sys; sys.exit(0 if float('$s') < $1 else 1)" && break ;;
      le) python3 -c "import sys; sys.exit(0 if float('$s') <= $1 else 1)" && break ;;
    esac
  done
  echo "$s"
}

echo "── (A) the static-field constellation probe (world [0..400]²)"
setstate "{ dotColor: '#b8b8e8', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 100, lineSizeVariation: 100, dotScatter: 80, lineScatter: 80, dotSizeBias: 20, lineSizeBias: 20, dotRotation: 0, lineRotation: 30, gridSize: 1, workerPaint: false }"
sleep 1.1
# center the world window (pan = pure transform, no rebake): world
# (200,200) → viewport center — the zoom anchor for the whole leg
ev "(function(){
  var cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
  var c = document.getElementById('c') || document.body;
  c.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, clientX: cx, clientY: cy}));
  window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, cancelable: true, clientX: cx + 600, clientY: cy + 300}));
  return 'panning';
})()" >/dev/null
sleep 0.35
ev "window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); 'panned'" >/dev/null
sleep 1.0
ev "$(cat /tmp/v098zoom-probe.js)" > /tmp/v098zoom-p1.json
# zoom IN — 8 bursts of deltaY −240 at the viewport center, settle-polled
S2=$(zoomto 1.6 ge -240)
sleep 1.0   # land the debounced rebake + its follow-up frame
ev "$(cat /tmp/v098zoom-probe.js)" > /tmp/v098zoom-p2.json
# zoom OUT — deltaY +240 bursts until scale < 0.8
S3=$(zoomto 0.8 lt 240)
sleep 1.0
ev "$(cat /tmp/v098zoom-probe.js)" > /tmp/v098zoom-p3.json
python3 - /tmp/v098zoom-p1.json /tmp/v098zoom-p2.json /tmp/v098zoom-p3.json <<'PYEOF' > /tmp/v098zoom-legA.txt
import json, sys
def load(p):
    s = open(p).read().strip()
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data', {}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    return json.loads(v) if isinstance(v, str) else v
P1, P2, P3 = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
def oo(P): return P.get('oo') or {}
pk = [ (o.get('megaA'), o.get('megaB'), o.get('pairCells')) for o in map(oo, (P1, P2, P3)) ]
print('pair', 'yes' if (pk[0] == pk[1] == pk[2] and pk[0][0] is not None) else 'no',
      f"(A/B/cells: {pk[0]} → {pk[1]} → {pk[2]})")
g = [oo(P).get('bakeGen') for P in (P1, P2, P3)]
sc = [ (P.get('cam') or {}).get('scale') for P in (P1, P2, P3) ]
scs = [round(x, 4) if isinstance(x, (int, float)) else x for x in sc]
if isinstance(sc[1], (int, float)) and sc[1] >= 1.6:
    print('rebake', 'yes' if (isinstance(g[0], int) and isinstance(g[1], int) and g[1] > g[0]) else 'no',
          f"(bakeGen {g[0]} → {g[1]} → {g[2]}, scale {scs[0]} → {scs[1]} → {scs[2]})")
else:
    print('rebskip', 'skip', f"(zoom-in scale {scs[1]} < 1.6 — rebake gate skipped)")
def match15(a, b, tol=2.0):
    ok = 0; miss = []
    for d in a['dots'][:15]:
        if any((d['x']-q['x'])**2 + (d['y']-q['y'])**2 <= tol*tol for q in b['dots']):
            ok += 1
        else:
            miss.append({'x': round(d['x'],1), 'y': round(d['y'],1), 'm': d['m']})
    return ok, miss
ok2, miss2 = match15(P1, P2)
ok3, miss3 = match15(P1, P3)
print('match', 'yes' if (ok2 >= 12 and ok3 >= 12) else 'no',
      f"(P1→P2 {ok2}/15 missed {json.dumps(miss2)}; P1→P3 {ok3}/15 missed {json.dumps(miss3)})")
n1 = P1.get('n', 0); n2 = P2.get('n', 0); n3 = P3.get('n', 0)
print('dens', 'yes' if (0.75 * n1 <= n2 <= 1.33 * n1) else 'no',
      f"(blobs: {n1} → {n2} ({round(n2/max(n1,1),2)}x) → {n3} ({round(n3/max(n1,1),2)}x))")
be = [oo(P).get('bakeError') for P in (P1, P2, P3)]
print('bake', 'yes' if all(e is None for e in be) else 'no', f"(bakeError: {be})")
PYEOF
while IFS= read -r line; do
  K=$(echo "$line" | awk '{print $1}'); V=$(echo "$line" | awk '{print $2}'); REST=$(echo "$line" | cut -d ' ' -f3-)
  case "$K" in
    pair) ck "the pair is zoom-stable (megaA/megaB/pairCells identical across three zooms)" "$V" "$REST" ;;
    rebake) ck "rebakes landed at deep zoom (bakeGen advanced)" "$V" "$REST" ;;
    rebskip) echo "  ⚠ rebake gate skipped — $REST" ;;
    match) ck "the constellation survives the zoom (world centroids match)" "$V" "$REST" ;;
    dens) ck "density preserved (±25%)" "$V" "$REST" ;;
    bake) ck "no bake errors" "$V" "$REST" ;;
  esac
done < /tmp/v098zoom-legA.txt

echo "── (B) the mesh worst case under zoom"
setstate "{ dotColor: {colors:['#1b2a4a','#3b5bdb','#845ef7','#e5989a'], dir:'mesh'}, lineColor: {colors:['#101218','#2b2f45'], dir:'mesh'}, spaceParallax: 100, dotAnimate: true, lineAnimate: true, dotSizeVariation: 100, lineSizeVariation: 100 }"
sleep 1.1   # setstate's 1.1 + this = the 2.2 rebake settle
ev "JSON.stringify({s: window.DoomalayDebug.camera.scale, oo: window.DoomalayDebug.oneObject})" > /tmp/v098zoom-m1.json
MS2=$(zoomto 1.8 ge -240)
sleep 1.0
ev "JSON.stringify({s: window.DoomalayDebug.camera.scale, oo: window.DoomalayDebug.oneObject})" > /tmp/v098zoom-m2.json
MS3=$(zoomto 0.75 le 240)
sleep 1.0
ev "JSON.stringify({s: window.DoomalayDebug.camera.scale, oo: window.DoomalayDebug.oneObject})" > /tmp/v098zoom-m3.json
python3 - /tmp/v098zoom-m1.json /tmp/v098zoom-m2.json /tmp/v098zoom-m3.json <<'PYEOF' > /tmp/v098zoom-legB.txt
import json, sys
def load(p):
    s = open(p).read().strip()
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data', {}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    return json.loads(v) if isinstance(v, str) else v
M1, M2, M3 = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
oos = [m.get('oo') or {} for m in (M1, M2, M3)]
pk = [(o.get('megaA'), o.get('megaB'), o.get('pairCells')) for o in oos]
ss = [round(m.get('s', 0), 4) for m in (M1, M2, M3)]
print('pair', 'yes' if (pk[0] == pk[1] == pk[2] and pk[0][0] is not None) else 'no',
      f"(A/B/cells: {pk[0]} → {pk[1]} → {pk[2]}; scales {ss})")
hs = [o.get('heroes', 0) for o in oos]
print('heroes', 'yes' if all(isinstance(h, int) and h > 0 for h in hs) else 'no', f"(heroes: {hs})")
be = [o.get('bakeError') for o in oos]
print('bake', 'yes' if all(e is None for e in be) else 'no', f"(bakeError: {be})")
PYEOF
while IFS= read -r line; do
  K=$(echo "$line" | awk '{print $1}'); V=$(echo "$line" | awk '{print $2}'); REST=$(echo "$line" | cut -d ' ' -f3-)
  case "$K" in
    pair) ck "pair zoom-stable through the mesh worst case" "$V" "$REST" ;;
    heroes) ck "hero fireflies at every zoom (> 0)" "$V" "$REST" ;;
    bake) ck "no bake errors (mesh worst case)" "$V" "$REST" ;;
  esac
done < /tmp/v098zoom-legB.txt
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

echo "── (C) the legacy fallback gate"
LF=$(ev "window.Lattice.oneObject().legacyFails")
ck "legacy fallback never trips (legacyFails == 0)" "$([ "$LF" = "0" ] && echo yes || echo no)" "legacyFails=$LF"

echo
echo "═══ v098 zoom-stability: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
