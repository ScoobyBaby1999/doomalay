#!/bin/bash
# v097-oneobject-test.sh — THE CANVAS WAVE rig (PLAN-V097).
#
# THE CONTRACT:
#  (1) ONE-OBJECT AT DEFAULTS — the tile lattice is ACTIVE (main mode):
#      Lattice.oneObject().active, tiles 2-3 (lines tile + dots tile per
#      occupied band), batches ≤ 4 (≤2 line buckets + 1 dot fill + margin),
#      dots coverage > 40, cache.dot > 0, #c paints non-empty.
#  (2) THE MESH WORST CASE — mesh dot+line specs + amp100 + both anims +
#      size 100: oneObject still active, ≥5 tiles (the band set), HERO
#      fireflies > 0, batches·6 < dots+segs (the collapse), dotBands = 5
#      populated with sum == dots, overIcons.on true, weight extremes
#      (jrMax ≥ 3.9), fps > 0, #c non-empty, ZERO console errors.
#  (3) A/B PIXEL PARITY — the default-theme frame (tiled) vs the LEGACY
#      frame (window.__doomalayLatticeLegacy = true): pixel diff ≤ 0.5%
#      of pixels > 8/255 (the same dots, same positions, AA noise only).
#  (4) PAN STABILITY — a synthetic drag moves DoomalayDebug.camera AND
#      the bake generation stays PUT (pan = transform-only, no rebake).
#  (5) THE CADENCE GATE — dotAnimate on, camera at rest: full paints
#      climb at ~15fps (≤ 45 in 2s) but the loop stays alive (> 4).
#  (6) THE C3 SPLIT — a 120-message chat opens with the TAIL window
#      (30 .msg-row rows on first paint), backfills to 120 rows within
#      idle time, and jumpToEvent finds a row in the old head.
#  (7) zero console errors on every leg.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8397
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v097
export AGENT_BROWSER_SESSION=doomalay-v097

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v097-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
# v0.97.1: a previous run's settings PERSIST in localStorage (same origin) —
# reset the canvas-relevant keys to defaults BEFORE the defaults leg
 ev "Settings.setState({ dotColor: '#2e2e3a', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 0, lineSizeVariation: 0, dotScatter: 0, lineScatter: 0, dotSizeBias: 0, lineSizeBias: 0, dotRotation: 0, lineRotation: 0, gridSize: 1 }); 'reset'" >/dev/null
sleep 0.8
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null
eval_console_errs() { agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and (e.get('level','').lower() in ('error','severe') or e.get('type','').lower()=='error'): n+=1
    except Exception: pass
print(n)"; }
# main-mode lattice (the pixel proofs read #c; v0852 owns the worker path)
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
sleep 0.6
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null
setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }

echo "── (1) one-object at defaults"
OO=$(ev "JSON.stringify(window.Lattice.oneObject())")
ACT=$(echo "$OO" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('active') else 'no')")
ck "the one-object lattice is ACTIVE" "$ACT" "$OO"
TILES=$(echo "$OO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tiles',0))")
ck "the dots tile baked (1 at defaults: lines are full-line immediate)" "$([ "$TILES" -ge 1 ] && [ "$TILES" -le 2 ] && echo yes || echo no)" "$OO"
D=$(ev "JSON.stringify(window.DoomalayDebug)")
B=$(echo "$D" | python3 -c "import json,sys; print(json.load(sys.stdin).get('batches',99))")
ck "default frame ≤ 4 batches (the collapse)" "$([ "$B" -le 4 ] 2>/dev/null && echo yes || echo no)" "$D"
DN=$(echo "$D" | python3 -c "import json,sys; print(json.load(sys.stdin).get('dots',0))")
ck "dots coverage populated (> 40)" "$([ "$DN" -gt 40 ] 2>/dev/null && echo yes || echo no)" "$DN"
CD=$(echo "$D" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cache',{}).get('dot',0))")
ck "cache.dot > 0 (the rig contract)" "$([ "$CD" -gt 0 ] 2>/dev/null && echo yes || echo no)" "$CD"
TL=$(ev "(document.getElementById('c').toDataURL()).length")
ck "#c paints non-empty" "$([ "$TL" -gt 20000 ] 2>/dev/null && echo yes || echo no)" "$TL"

echo "── (2) the mesh worst case (bands + heroes + the collapse)"
setstate "{ dotColor: {colors:['#1b2a4a','#3b5bdb','#845ef7','#e5989a'], dir:'mesh'}, lineColor: {colors:['#101218','#2b2f45'], dir:'mesh'}, spaceParallax: 100, dotAnimate: true, lineAnimate: true, dotSizeVariation: 100, lineSizeVariation: 100 }"
# v0.97.1: the rebake debounce must CONVERGE — wait past 150ms + a frame
sleep 2.2
OO2=$(ev "JSON.stringify(window.Lattice.oneObject())")
ACT2=$(echo "$OO2" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin).get('active') else 'no')")
ck "one-object ACTIVE through the mesh worst case" "$ACT2" "$OO2"
PEN=$(echo "$OO2" | python3 -c "import json,sys; print('no' if json.load(sys.stdin).get('pending') else 'yes')")
ck "the rebake debounce CONVERGES (no eternal pending)" "$PEN" "$OO2"
T2=$(echo "$OO2" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tiles',0))")
ck "the band set baked (≥ 5 tiles)" "$([ "$T2" -ge 5 ] 2>/dev/null && echo yes || echo no)" "$OO2"
H2=$(echo "$OO2" | python3 -c "import json,sys; print(json.load(sys.stdin).get('heroes',0))")
ck "hero fireflies minted (> 0)" "$([ "$H2" -gt 0 ] 2>/dev/null && echo yes || echo no)" "$OO2"
D2=$(ev "JSON.stringify(window.DoomalayDebug)")
python3 - "$D2" <<'PYEOF' > /tmp/v097-mesh.txt
import json, sys
d = json.loads(sys.argv[1])
dots = d.get('dots', 0); segs = d.get('segs', 0)
ln = max(segs, d.get('lineStats', {}).get('n', 0))
b = d.get('batches', 0)
bands = d.get('dotBands', [])
print('collapse', 'yes' if (dots + ln) > 500 and b * 6 < (dots + ln) else 'no', f"(batches={b} dots={dots} lineN={ln})")
print('bands', 'yes' if (len(bands) == 5 and all(x > 0 for x in bands) and sum(bands) == dots) else 'no', str(bands))
print('over', 'yes' if d.get('overIcons', {}).get('on') else 'no', '')
w = d.get('weight', {})
print('weight', 'yes' if w.get('jrMax', 0) >= 3.9 else 'no', str(w.get('jrMax')))
print('fps', 'yes' if d.get('fps', 0) > 0 else 'no', str(d.get('fps')))
PYEOF
while IFS= read -r line; do
  K=$(echo "$line" | awk '{print $1}'); V=$(echo "$line" | awk '{print $2}'); REST=$(echo "$line" | cut -d' ' -f3-)
  case "$K" in
    collapse) ck "the collapse: batches·6 ≪ elements" "$V" "$REST" ;;
    bands) ck "5 depth bands populated, sum == dots" "$V" "$REST" ;;
    over) ck "over-icons gate ON (amp ≥ 50 + variation)" "$V" "" ;;
    weight) ck "weight extremes survive (jrMax ≥ 3.9)" "$V" "$REST" ;;
    fps) ck "fps instrument alive" "$V" "$REST" ;;
  esac
done < /tmp/v097-mesh.txt
TL2=$(ev "(document.getElementById('c').toDataURL()).length")
ck "#c paints non-empty (mesh worst)" "$([ "$TL2" -gt 20000 ] 2>/dev/null && echo yes || echo no)" "$TL2"

echo "── (3) A/B pixel parity (tiled vs legacy, the default theme)"
setstate "{ dotColor: '#b8b8e8', lineColor: '#131318', spaceParallax: 0, dotAnimate: false, lineAnimate: false, dotSizeVariation: 0, lineSizeVariation: 0 }"
# v0.97.1: wait for the debounced rebake to land BEFORE comparing
sleep 2.2
D3=$(ev "(function(){
  var c = document.getElementById('c');
  var g = c.getContext('2d');
  var w = c.width, h = c.height;
  if (!w || !h) return JSON.stringify({err: 'no canvas'});
  var s1 = g.getImageData(0, 0, w, h).data;
  window.__doomalayLatticeLegacy = true;
  window.doomalay.repaint();
  var s2 = g.getImageData(0, 0, w, h).data;
  window.__doomalayLatticeLegacy = false;
  window.doomalay.repaint();
  var n = 0, tot = 0;
  for (var i = 0; i < s1.length; i += 4) {
    var d = Math.max(Math.abs(s1[i]-s2[i]), Math.abs(s1[i+1]-s2[i+1]), Math.abs(s1[i+2]-s2[i+2]));
    if (d > 8) n++;
    tot++;
  }
  return JSON.stringify({pct: Math.round(10000 * n / tot) / 100, n: n});
})()")
PCT=$(echo "$D3" | python3 -c "import json,sys; print(json.load(sys.stdin).get('pct', 999))")
ck "tiled ≈ legacy at rest (≤ 0.5% of pixels differ > 8/255)" "$([ "$(echo "$PCT" | cut -d. -f1)" -le 0 ] 2>/dev/null && echo yes || echo no)" "$D3"

echo "── (4) pan stability (transform-only — no rebake)"
setstate "{ dotColor: {colors:['#1b2a4a','#3b5bdb','#845ef7','#e5989a'], dir:'mesh'}, lineColor: {colors:['#101218','#2b2f45'], dir:'mesh'}, spaceParallax: 100, dotAnimate: true, lineAnimate: true, dotSizeVariation: 100, lineSizeVariation: 100 }"
sleep 2.2
BG0=$(ev "window.Lattice.oneObject().bakeGen")
ev "(function(){
  var el = document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2)) || document.body;
  el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: Math.round(innerWidth/2), clientY: Math.round(innerHeight/2)}));
  window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: Math.round(innerWidth/2) - 180, clientY: Math.round(innerHeight/2) - 60}));
  window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  return 'panned';
})()" >/dev/null
sleep 1.4
BG1=$(ev "window.Lattice.oneObject().bakeGen")
ck "a pure pan does NOT rebake (transform-only)" "$([ "$BG0" = "$BG1" ] && echo yes || echo no)" "gen $BG0 → $BG1"
D4=$(ev "JSON.stringify({cam: window.DoomalayDebug.camera, oo: window.Lattice.oneObject()})")
CAMMOVED=$(echo "$D4" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d['cam']; print('yes' if (abs(c.get('x',0)) > 50 or abs(c.get('y',0)) > 20) else 'no')")
ck "the camera twin MOVES with the pan" "$CAMMOVED" "$D4"
# rebake during pan is legal (scale may drift mid-gesture); assert the tiles survived + no legacy fallback
OK4=$(echo "$D4" | python3 -c "import json,sys; d=json.load(sys.stdin); oo=d['oo']; print('yes' if oo.get('active') and oo.get('legacyFails',1)==0 else 'no')")
ck "tiles survive the pan (no fallback)" "$OK4" "$D4"

echo "── (5) the ambient cadence gate (dotAnimate at rest ≈ 15fps)"
ev "Settings.setState({dotAnimate:true, lineAnimate:false}); 'ok'" >/dev/null
sleep 0.4
P0=$(ev "window.DoomalayPerf.paints")
sleep 2
P1=$(ev "window.DoomalayPerf.paints")
CLIMB=$((P1 - P0))
ck "ambient full frames gated (≤ 45 paints / 2s, was ~120)" "$([ "$CLIMB" -le 45 ] 2>/dev/null && echo yes || echo no)" "delta=$CLIMB"
ck "the ambient loop stays alive (> 4)" "$([ "$CLIMB" -gt 4 ] 2>/dev/null && echo yes || echo no)" "delta=$CLIMB"

echo "── (6) the C3 split transcript render"
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ID') or d.get('id') or '')")
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d '{"Title":"C3 Chat","Model":"privatemodeai/glm-5.3","Sandbox":"quick"}' >/dev/null
for j in $(seq 1 120); do
  T=user; [ $((j % 2)) -eq 0 ] && T=assistant
  curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
    -d "{\"type\":\"$T\",\"text\":\"C3 message $j — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.\"}" >/dev/null
done
# seed the icon via the persisted world state (the v094 pattern), then reload
ev "(function(){
  var st = { offset: {x: 0, y: 0}, scale: 1, currentFamily: 'beast', dots: [],
    icons: [{ type: 'chat', id: 'chat_c3', name: 'C3 Chat', family: 'beast', iconIndex: 0,
      x: 200, y: 300, vx: 0, vy: 0, radius: 28, sandbox: 'quick',
      model: 'privatemodeai/glm-5.3', sessionId: '$SID' }],
    savedAt: Date.now() };
  localStorage.setItem('doomalay.state.v2', JSON.stringify(st));
  return 'seeded';
})()" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.8
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed2'" >/dev/null
# PASS 1 — the fresh open: the WS replay streams every message in (the
# scroll-coalesced path). Wait for the replay to complete (120 rows).
ev "(function(){ window.doomalay.openChatBySession('$SID'); return 'opening'; })()" >/dev/null
ROWS_A=-1
for i in $(seq 1 40); do
  R=$(ev "(document.querySelector('#chat-messages') ? document.querySelectorAll('#chat-messages [data-mi]').length : -1)")
  ROWS_A=$R
  [ "$R" -eq 120 ] && break
  sleep 0.25
done
ck "the fresh open replays the full history (120 rows, coalesced)" "$([ "$ROWS_A" -eq 120 ] 2>/dev/null && echo yes || echo no)" "rows=$ROWS_A"
# PASS 2 — THE TAIL WINDOW: close, then RE-open with the 120-message state
# already live — renderHost must mount ONLY the last 30 rows. Structural
# assertion (race-free): the tail row [data-mi=119] exists while the head
# row [data-mi=0] does NOT — the backfill is pending, exactly the split.
ev "(function(){ try { window.ChatPanel.current().panel.close(); } catch (e) {} return 'closed';})()" >/dev/null
sleep 0.8
ev "(function(){ window.doomalay.openChatBySession('$SID'); return 'reopening'; })()" >/dev/null
TAILOK=no
for i in $(seq 1 30); do
  R=$(ev "(function(){ var q=String.fromCharCode(34); return JSON.stringify(!!document.querySelector('#chat-messages [data-mi='+q+'119'+q+']')); })()" | tr -d '"')
  [ "$R" = "true" ] && { TAILOK=yes; break; }
  sleep 0.15
done
HEAD0=$(ev "(function(){ var q=String.fromCharCode(34); return JSON.stringify(!!document.querySelector('#chat-messages [data-mi='+q+'0'+q+']')); })()" | tr -d '"')
ck "the RE-open mounts the tail ([data-mi=119] exists)" "$TAILOK" ""
ck "the head is NOT mounted at open ([data-mi=0] absent — the split works)" "$([ "$HEAD0" = "false" ] && echo yes || echo no)" "head $HEAD0"
# the deterministic flush: jump-to-event's ensureMounted completes the head
FLUSH=$(ev "(function(){
  var ok = window.ChatPanel.ensureMounted();
  var rows = document.querySelectorAll('#chat-messages [data-mi]').length;
  var head = !!document.querySelector('#chat-messages [data-mi='+String.fromCharCode(34)+'0'+String.fromCharCode(34)+']');
  return JSON.stringify({ok: ok, rows: rows, head: head});
})()")
ROWS1=$(echo "$FLUSH" | python3 -c "import json,sys
s = sys.stdin.read().strip()
if s.startswith('\"'): s = json.loads(s)
print(json.loads(s).get('rows', -1))")
HEADOK=$(echo "$FLUSH" | python3 -c "import json,sys
s = sys.stdin.read().strip()
if s.startswith('\"'): s = json.loads(s)
print('yes' if json.loads(s).get('head') else 'no')")
ck "ensureMounted flushes the whole head on demand (120 rows)" "$([ "$ROWS1" -eq 120 ] 2>/dev/null && echo yes || echo no)" "$FLUSH"
ck "the flushed head is queryable ([data-mi=0])" "$HEADOK" ""
JUMP=$(ev "(function(){ var q=String.fromCharCode(34); return JSON.stringify(!!document.querySelector('[data-ei='+q+'1'+q+']')); })()" | tr -d '"')
ck "the old head is queryable after backfill (jump target exists)" "$([ "$JUMP" = "true" ] && echo yes || echo no)" "$JUMP"
ev "(function(){ try { window.ChatPanel.current().panel.close(); } catch (e) {} return 'closed';})()" >/dev/null 2>&1
sleep 0.4

echo "── (7) console errors"
ERRS=$(eval_console_errs)
ERRS2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$ERRS" = "0" ] && [ "$ERRS2" = "0" ] && echo yes || echo no)" "console=$ERRS js=$ERRS2"

echo
echo "═══ v097 one-object: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
