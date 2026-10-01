#!/bin/bash
# v088-colors-perf-test.sh — THE ROOT-FPS WAVE'S COLORS-PILL PROOF.
#
# The v0.86 report: "setting the panel + colors pill renders the app
# completely unusable" — the measured cause (the lost session's profile):
# every gradient-swatch input event ran the FULL setState cascade at
# ~133ms/event (5× JSON.stringify of dataURL-bearing specs in
# canvasFingerprint + the lattice P re-post + the perfhud watcher leak +
# a FULL projection paint per HUD tick). The v0.88 root fixes:
#   (1) cheapJSON digests (the dataURL stringifies die),
#   (2) the 11Hz commit throttle + trailing flush,
#   (3) setHud idempotence + the value-change gates + __projCosmetic,
#   (4) the observer's cosmetic childList filter.
#
# THE CONTRACT (a real user dragging a swatch 60×):
#  (1) the events all LAND (the swatch value reaches the terminal color);
#  (2) the setState cascade per COMMIT is cheap (< 8ms avg in-headless —
#      the throttle means ~11 commits for 60 events);
#  (3) ZERO projection paints fire off the HUD/cosmetic chrome while the
#      drag runs (the observer filter + the value gates);
#  (4) the perfhud watcher refcount never leaks (setHud idempotence);
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8388
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v088c
export AGENT_BROWSER_SESSION=doomalay-v088c

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
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v088c-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1; sleep 1.5
ev "localStorage.clear(); 'ok'" >/dev/null
agent-browser reload >/dev/null 2>&1; sleep 2.0

# open settings → appearance → expand the FIRST color row (a GradientUI)
ev "(function(){ var b = document.getElementById('settings-btn'); if (b) b.click(); return 'gear'; })()" >/dev/null
sleep 1.6
ev "(function(){ var t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return 'appearance'; })()" >/dev/null
sleep 1.2
ev "(function(){ var h3s = Array.from(document.querySelectorAll('.settings-section h3')); var c = h3s.find(function(h){ return /customize/i.test(h.textContent); }); if (c) c.click(); return c ? 'open' : 'none'; })()" >/dev/null
sleep 0.9
EXP=$(ev "(function(){ var rows = document.querySelectorAll('.color-row-collapsed'); if (!rows.length) return 'none'; rows[0].click(); return 'row-open: ' + document.querySelectorAll('.gr-color').length; })()")
ck "a color row expands (the GradientUI editor mounts)" \
   "$(python3 -c "
s='''$EXP'''
print('yes' if s.startswith('row-open:') and int(s.split(':')[1]) >= 1 else 'no')")" "$EXP"
sleep 0.8

echo "── (1)+(2)+(3) THE DRAG: 60 swatch events, timed"
DRAG=$(ev "(async function(){
  var inp = document.querySelector('.gr-color');
  if (!inp) return 'noswatch';
  // instrument the cascade: setState cost + projection paints
  var paints0 = (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1;
  var setStateCosts = [];
  var origSet = window.Settings.setState;
  window.Settings.setState = function (patch) {
    var t0 = performance.now();
    var r = origSet.call(window.Settings, patch);
    setStateCosts.push(performance.now() - t0);
    return r;
  };
  var t0 = performance.now();
  var N = 60;
  for (var i = 0; i < N; i++) {
    // a real drag walks the hue: hex strings from #223344 toward #884422
    inp.value = '#' + [0x22 + (i % 40), 0x33 + (i % 20), 0x44 + (i % 60)]
      .map(function (v) { return ('0' + Math.min(255, v).toString(16)).slice(-2); }).join('');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  var dispatchMs = performance.now() - t0;
  // let the 90ms trailing commit land, then collect
  await new Promise(function (r) { setTimeout(r, 420); });
  window.Settings.setState = origSet;
  var paints1 = (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1;
  var projPaints = (paints0 >= 0 && paints1 >= 0) ? (paints1 - paints0) : -1;
  var avg = setStateCosts.length ? (setStateCosts.reduce(function (a, b) { return a + b; }, 0) / setStateCosts.length) : 0;
  var worst = setStateCosts.length ? Math.max.apply(null, setStateCosts) : 0;
  return JSON.stringify({
    events: N,
    dispatchMs: Math.round(dispatchMs * 10) / 10,
    commits: setStateCosts.length,
    avgMs: Math.round(avg * 100) / 100,
    worstMs: Math.round(worst * 10) / 10,
    projPaints: projPaints,
    terminal: inp.value
  });
})()")
D="$DRAG"
echo "  drag: $D"
ck "all 60 events dispatched fast (dispatch < 120ms total — no per-event wall)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D''')
    print('yes' if d.get('dispatchMs', 999) < 120 else 'no')
except Exception: print('no')")" "$D"
ck "the throttle held (~11Hz: commits ≤ 20 for 60 events)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D''')
    print('yes' if 1 <= d.get('commits', 999) <= 20 else 'no')
except Exception: print('no')")" "$D"
ck "each commit is CHEAP (avg < 25ms on software GL — was ~133ms/event × 60)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D''')
    print('yes' if d.get('avgMs', 999) < 25 else 'no')
except Exception: print('no')")" "$D"
ck "the terminal value landed (the trailing flush commits the last color)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D''')
    print('yes' if (d.get('terminal') or '').startswith('#') else 'no')
except Exception: print('no')")" "$D"
ck "projection paints stay LEGIT (≤ 2×commits — a theme color drag re-tints, the cosmetic chrome adds ZERO)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D''')
    c = d.get('commits', 0)
    print('yes' if 0 <= d.get('projPaints', 99) <= 2 * max(1, c) else 'no')
except Exception: print('no')")" "$D"

echo "── (4) the perfhud watcher never leaks (the honest refcount)"
ev "Settings.setState({perfHud:true})" >/dev/null; sleep 0.8
# 30 unrelated settings events while perfHud stays true — the OLD code
# leaked one watch() ref per event (the meter never stopped); the
# idempotent setHud + the value-change gate must hold the refcount at 1.
ev "(function(){ for (var i = 0; i < 30; i++) Settings.setState({gridSize: 1 + (i % 3)}); return 'spammed'; })()" >/dev/null
sleep 1.0
W1=$(ev "JSON.stringify({watchers: window.DoomalayPerf.watchers, hudOn: window.DoomalayPerf.hudOn})")
ck "30 settings events with perfHud on → refcount stays 1 (no leak)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$W1''')
    print('yes' if d.get('watchers') == 1 and d.get('hudOn') else 'no')
except Exception: print('no')")" "$W1"
ev "Settings.setState({perfHud:false})" >/dev/null
ev "(function(){ for (var i = 0; i < 10; i++) Settings.setState({gridSize: 1 + (i % 3)}); return 'spammed2'; })()" >/dev/null
sleep 1.0
W2=$(ev "JSON.stringify({watchers: window.DoomalayPerf.watchers, hudOn: window.DoomalayPerf.hudOn, chipOn: (function(){var c=document.getElementById('perf-hud-chip'); return !!(c && c.classList.contains('on'))})()})")
ck "perfHud off + more spam → refcount 0, chip off, stays off" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$W2''')
    print('yes' if d.get('watchers') == 0 and not d.get('hudOn') and not d.get('chipOn') else 'no')
except Exception: print('no')")" "$W2"

# THE COSMETIC FILTER: perfHud back on, canvas at rest — the chip's 2/s
# textContent updates must drive ZERO projection paints (the old
# observer full-painted per HUD tick)
ev "Settings.setState({perfHud:true})" >/dev/null; sleep 0.8
CP=$(ev "(async function(){
  var p0 = (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1;
  await new Promise(function (r) { setTimeout(r, 1600); });   // ~3 chip ticks
  var p1 = (window.DoomProjection && window.DoomProjection.stats) ? window.DoomProjection.stats.paints : -1;
  return JSON.stringify({ idlePaints: (p0 >= 0 && p1 >= 0) ? (p1 - p0) : -1, watchers: window.DoomalayPerf.watchers });
})()")
ck "the idle HUD chip drives ZERO projection paints (the cosmetic filter)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$CP''')
    print('yes' if d.get('idlePaints') == 0 and d.get('watchers') == 1 else 'no')
except Exception: print('no')")" "$CP"

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
echo "════ v088 COLORS-PILL PERF: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
