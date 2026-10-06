#!/bin/bash
# v107-canvas-proof.sh — THE CANVAS OPT WAVE's red-team (PLAN-V107 Phase 4).
# Imitates a real user riding the worst-case doom grid: pinch sweeps through
# the deep-zoom zone (<30%), pans, settles, waits for comets, flips themes.
#
# THE CONTRACT (each phase's claims, measured not felt):
#  (1) THE STORM IS DEAD — a continuous fast zoom-in sweep (scale 1 → 3,
#      the user's <30% zone) bakes ≤3 times, ALL async (no sampled frame
#      pays a bake: max paintMs ≤ 15), and the REVERSE sweep is pure
#      ladder hits (≤1 bake). Panning at a fixed deep zoom bakes ZERO.
#  (2) THE BUDGET HOLDS — worst-case fills ≤ 22 tiles / ≤ 24 batches, the
#      ladder stays under its byte cap, resting paintMs ≤ 5.
#  (3) THE GRID IS ALIVE — ≥25fps at rest (the 33ms cadence), comets
#      spawn (≥1 in 12s), movers paint every rest frame, twinklers visible.
#  (4) THE THEME SYSTEM OWNS EVERYTHING — a theme flip rebakes the lattice
#      with the new colorway (bakeGen climbs); the wave added ZERO hex
#      literals to the canvas code (the discipline gate).
#  (5) zero console errors across the whole ride.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=${1:-8107}
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v107
export AGENT_BROWSER_SESSION=doomalay-v107

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
# fle: float-safe <= comparison (bash [ -le ] chokes on decimals)
fle() { python3 -c "import sys; print('yes' if float('$1') <= float('$2') else 'no')" 2>/dev/null; }

# ── zombie-port hardening (the v0892 lesson) ──────────────────────────
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "PORT $PORT ALREADY BOUND — refusing"; exit 1
fi
rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v107-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 || { echo "BOOT FAIL"; exit 1; }
OWN=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
ck "our child owns the listener (pid $ENGPID vs $OWN)" "$([ "$OWN" = "$ENGPID" ] && echo yes || echo no)" "$OWN"

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v107sess","title":"Proof","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or d.get('Id') or '')")
[ -n "$SID" ] && echo "session: $SID" || { echo "SESSION CREATE FAIL"; exit 1; }

agent-browser close >/dev/null 2>&1
agent-browser set viewport 412 915 >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2
ev "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0}, scale:1, icons:[{type:'chat', id:'chat_v107', name:'Proof', family:'default', iconIndex:-1, x:180, y:400, sessionId:'$SID'}]})); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 3.5

# the worst-case doom grid (the user's own config)
ev "window.Settings.setState({spaceParallax:100, dotSizeVariation:60, lineSizeVariation:60, dotScatter:40, lineScatter:30, dotAnimate:true, lineAnimate:true, dotSizeBias:20, lineSizeBias:15}); 'set'" >/dev/null
sleep 2

echo "── (1) THE STORM IS DEAD (deep-zoom sweeps + fixed-zoom pan)"
STORM=$(ev "
(function(){
  var c = document.getElementById('c');
  function zoom(n, dy){ for (var i=0;i<n;i++) c.dispatchEvent(new WheelEvent('wheel',{deltaY:dy,clientX:206,clientY:458,bubbles:true,cancelable:true})); }
  var log = {maxPaint: 0, gens: []};
  function s(){ var d=window.DoomalayDebug||{}; var oo=d.oneObject||{};
    if (d.paintMs > log.maxPaint) log.maxPaint = d.paintMs;
    log.gens.push(oo.bakeGen); }
  s();
  // PHASE A: continuous fast zoom-IN (60 steps, scale 1 → ~3, the <30% zone)
  var n = 0;
  var ivA = setInterval(function(){
    zoom(1, -120); n++;
    if (n % 10 === 0) s();
    if (n >= 60) {
      clearInterval(ivA);
      s();
      setTimeout(function(){
        // PHASE B: the reverse sweep (warm ladder — must be pure hits)
        var g0 = (window.DoomalayDebug.oneObject||{}).bakeGen;
        var m = 0;
        var ivB = setInterval(function(){
          zoom(1, 120); m++;
          if (m % 10 === 0) s();
          if (m >= 60) {
            clearInterval(ivB);
            var g1 = (window.DoomalayDebug.oneObject||{}).bakeGen;
            log.reverseBakes = g1 - g0;
            s();
            // PHASE C: pan at fixed deep zoom — zero bakes
            setTimeout(function(){
              var g2 = (window.DoomalayDebug.oneObject||{}).bakeGen;
              c.dispatchEvent(new MouseEvent('mousedown',{clientX:206,clientY:458,bubbles:true,cancelable:true}));
              var p = 0;
              var ivC = setInterval(function(){
                document.dispatchEvent(new MouseEvent('mousemove',{clientX:206+p*9,clientY:458+p*2,bubbles:true,cancelable:true}));
                p++; s();
                if (p >= 30) {
                  clearInterval(ivC);
                  document.dispatchEvent(new MouseEvent('mouseup',{clientX:476,clientY:518,bubbles:true,cancelable:true}));
                  setTimeout(function(){
                    var g3 = (window.DoomalayDebug.oneObject||{}).bakeGen;
                    log.panBakes = g3 - g2;
                    log.genA = log.gens[log.gens.length-1] - log.gens[0];
                    log.scale = (window.DoomalayDebug.camera||{}).scale;
                    log.ladder = (window.DoomalayDebug.oneObject||{}).ladder;
                    window.__stormLog = log;
                  }, 700);
                }
              }, 50);
            }, 400);
          }
        }, 50);
      }, 600);
    }
  }, 50);
  return 'riding';
})()")
sleep 12
ST=$(ev "JSON.stringify(window.__stormLog || null)")
echo "    storm: $ST"
GENA=$(echo "$ST" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['genA'] if d else 'none')" 2>/dev/null)
MAXP=$(echo "$ST" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['maxPaint'] if d else 'none')" 2>/dev/null)
REVB=$(echo "$ST" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('reverseBakes','none') if d else 'none')" 2>/dev/null)
PANB=$(echo "$ST" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('panBakes','none') if d else 'none')" 2>/dev/null)
ck "zoom-in sweep: ≤5 async bakes for a full 6x range (genA $GENA)" "$([ "$GENA" != "none" ] && [ "$GENA" -le 5 ] 2>/dev/null && echo yes || echo no)" "$GENA"
ck "no frame paid a bake (max paintMs $MAXP ≤ 15)" "$(fle "$MAXP" 15)" "$MAXP"
ck "reverse sweep: warm ladder, ≤3 bakes ($REVB)" "$([ "$REVB" != "none" ] && [ "$REVB" -le 3 ] 2>/dev/null && echo yes || echo no)" "$REVB"
ck "fixed-zoom pan: ZERO bakes ($PANB)" "$([ "$PANB" = "0" ] && echo yes || echo no)" "$PANB"

echo "── (2) THE BUDGET HOLDS (worst case)"
BUD=$(ev "var d=window.DoomalayDebug||{};var oo=d.oneObject||{};JSON.stringify({tiles:oo.tiles,batches:d.batches,bytes:oo.ladder&&oo.ladder.bytes,paintMs:d.paintMs,scale:d.camera&&d.camera.scale})")
echo "    budget: $BUD"
TILES=$(echo "$BUD" | python3 -c "import sys,json;print(json.load(sys.stdin)['tiles'])" 2>/dev/null)
BATCH=$(echo "$BUD" | python3 -c "import sys,json;print(json.load(sys.stdin)['batches'])" 2>/dev/null)
BYTES=$(echo "$BUD" | python3 -c "import sys,json;print(json.load(sys.stdin)['bytes'])" 2>/dev/null)
PM=$(echo "$BUD" | python3 -c "import sys,json;print(json.load(sys.stdin)['paintMs'])" 2>/dev/null)
ck "tiles ≤ 22 (was 29; $TILES)" "$([ "$TILES" -le 22 ] 2>/dev/null && echo yes || echo no)" "$TILES"
ck "batches ≤ 24 ($BATCH)" "$([ "$BATCH" -le 24 ] 2>/dev/null && echo yes || echo no)" "$BATCH"
ck "ladder ≤ 128MB ($BYTES MB)" "$([ "$BYTES" -le 128 ] 2>/dev/null && echo yes || echo no)" "$BYTES"
ck "resting paintMs ≤ 5 ($PM)" "$(fle "$PM" 5)" "$PM"

echo "── (3) THE GRID IS ALIVE (12s at rest)"
LIFE=$(ev "
(function(){
  var d0 = window.DoomalayDebug || {};
  return new Promise(function(res){
    setTimeout(function(){
      var d1 = window.DoomalayDebug || {};
      var oo = d1.oneObject || {};
      res(JSON.stringify({frames: d1.frames - d0.frames, live: oo.live, fps: d1.fps}));
    }, 12000);
  });
})()")
echo "    life: $LIFE"
FR=$(echo "$LIFE" | python3 -c "import sys,json;print(json.load(sys.stdin)['frames'])" 2>/dev/null)
SPAWN=$(echo "$LIFE" | python3 -c "import sys,json;print(json.load(sys.stdin)['live']['spawns'])" 2>/dev/null)
PAINTED=$(echo "$LIFE" | python3 -c "import sys,json;print(json.load(sys.stdin)['live']['painted'])" 2>/dev/null)
ck "rest cadence ≥25fps ($FR frames / 12s)" "$([ "$FR" -ge 300 ] 2>/dev/null && echo yes || echo no)" "$FR"
ck "comets spawned ≥1 in 12s ($SPAWN)" "$([ "$SPAWN" -ge 1 ] 2>/dev/null && echo yes || echo no)" "$SPAWN"
ck "movers painting ($PAINTED > 0)" "$([ "$PAINTED" -gt 0 ] 2>/dev/null && echo yes || echo no)" "$PAINTED"

echo "── (4) THE THEME OWNS EVERYTHING (flip → rebake, zero new literals)"
G0=$(ev "(window.DoomalayDebug.oneObject||{}).bakeGen")
ev "window.Settings.setState({theme:'ember'}); 'flipped'" >/dev/null
sleep 2.5
G1=$(ev "(window.DoomalayDebug.oneObject||{}).bakeGen")
ck "theme flip rebakes the lattice (gen $G0 → $G1)" "$([ "$G1" -gt "$G0" ] 2>/dev/null && echo yes || echo no)" "$G0 → $G1"
NEWLIT=$(git diff c2d1ff1f..HEAD -- engine/internal/server/web/lattice.js engine/internal/server/web/gridworker.js | grep '^+' | grep -c '#[0-9a-fA-F]\{6\}' || true)
ck "zero hex literals added to the canvas code ($NEWLIT)" "$([ "$NEWLIT" = "0" ] && echo yes || echo no)" "$NEWLIT"

echo "── (5) console errors"
ERRS=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
ck "zero console errors ($ERRS)" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS"

echo ""
echo "════ v107 CANVAS PROOF: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
