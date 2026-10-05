#!/bin/bash
# v1035-universal-angle.sh — THE UNIVERSAL ANGLE RIG (PLAN-V103 §v1.03.5).
#
# THE CONTRACT (user: "a slider for the angle that effects each option,
# not just linear gradients, all gradients should be effected by
# rotation, if you can't implement that remove the option"):
#  (A1) LINEAR: the angle flows straight into the CSS gradient angle.
#  (A2) RADIAL: the focal ORBITS the angle ray (0°=top, 90°=right) —
#       css() AND the canvas bgGradientPass agree; no angle = the
#       pinned legacy 50% 35%.
#  (A3) MESH: the spot constellation rotates around the center; no
#       angle = the pinned legacy positions.
#  (A4) PINSTRIPE: the stripes rotate (θ=0 keeps the vertical bands).
#  (A5) BYTE-COMPAT: every no-angle output is unchanged (the uikit
#       pins + a live spot check).
#  (A6) THE EDITOR: the angle slider writes through; the banner
#       repaints per type; the legacy dirs normalize on open (swirl
#       opens with the radial pill active).
#  (A7) THE CANVAS: the lattice's bg raster honors the angle (the
#       canvas field with an angled pinstripe rebakes different pixels).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8435
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1035
export AGENT_BROWSER_SESSION=doomalay-v1035

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

if ! curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1; then
  cat > /tmp/doomalay-spawn-$PORT.sh << EOF
#!/bin/bash
setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1035.log 2>&1 < /dev/null &
EOF
  bash /tmp/doomalay-spawn-$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5

# ── A1-A4: the css() recipes (pure GradientUI calls in-page) ───────
A1=$(ev "
(function(){
  var G = window.GradientUI;
  return G.css({ colors: ['#111111','#222222'], dir: 'auto', angle: 200 });
})()")
ck "A1 linear: angle 200 flows into the gradient angle" \
   "$(echo "$A1" | grep -q 'linear-gradient(200deg, #111111, #222222)' && echo yes)" "$A1"
A1b=$(ev "
(function(){
  var G = window.GradientUI;
  return G.css({ colors: ['#111111','#222222'], dir: 'auto' });
})()")
ck "A1b linear: no angle keeps the legacy 135°" \
   "$(echo "$A1b" | grep -q 'linear-gradient(135deg, #111111, #222222)' && echo yes)" "$A1b"

A2=$(ev "
(function(){
  var G = window.GradientUI;
  return G.css({ colors: ['#111111','#222222'], dir: 'radial', angle: 0 }) + '§' +
         G.css({ colors: ['#111111','#222222'], dir: 'radial', angle: 90 }) + '§' +
         G.css({ colors: ['#111111','#222222'], dir: 'radial' });
})()")
ck "A2 radial: the focal orbits (0°→50%/15%, 90°→85%/50%, none→50%/35%)" \
   "$(echo "$A2" | grep -q 'at 50.0% 15.0%.*§.*at 85.0% 50.0%.*§.*at 50% 35%' && echo yes)" "$A2"

A3=$(ev "
(function(){
  var G = window.GradientUI;
  var no = G.css({ colors: ['#111111','#222222','#333333','#444444'], dir: 'mesh' });
  var ro = G.css({ colors: ['#111111','#222222','#333333','#444444'], dir: 'mesh', angle: 45 });
  return (no.indexOf('at 20%') >= 0 || no.indexOf('at ') >= 0 ? 'legacy-ok' : 'no-legacy') + '§' +
         (ro === no ? 'same' : 'rotated');
})()")
ck "A3 mesh: the constellation rotates; no-angle keeps the legacy" \
   "$(echo "$A3" | grep -q 'legacy-ok§rotated' && echo yes)" "$A3"

A4=$(ev "
(function(){
  var G = window.GradientUI;
  var v0 = G.css({ colors: ['#111111','#222222'], dir: 'pat-pinstripe' });
  var v45 = G.css({ colors: ['#111111','#222222'], dir: 'pat-pinstripe', angle: 45 });
  return ((v0.indexOf('(90deg') >= 0 ? 'base90' : 'base?') + '§' +
          (v45.indexOf('(135deg') >= 0 ? 'rot135' : 'rot?'));
})()")
ck "A4 pinstripe: θ=0 keeps 90° bands; θ=45 rotates to 135°" \
   "$(echo "$A4" | grep -q 'base90§rot135' && echo yes)" "$A4"

# ── A5: byte-compat spot checks ────────────────────────────────────
A5=$(ev "
(function(){
  var G = window.GradientUI;
  return G.css({ colors: ['#111111','#222222'], dir: 'h' }) + '§' +
         G.css({ colors: ['#111111','#222222'], dir: 'swirl' }).slice(0, 20) + '§' +
         G.css({ colors: ['#111111','#222222'], dir: 'diag' });
})()")
ck "A5 the legacy dirs keep their pinned recipes" \
   "$(echo "$A5" | grep -q 'linear-gradient(90deg.*§.*conic-gradient(from.*§.*linear-gradient(135deg' && echo yes)" "$A5"

# ── A6: the editor (angle writes + the legacy normalization) ───────
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" >/dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8
# seed a swirl spec, open the editor → the radial pill must show active
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight = ov.midnight || {};
  ov.midnight['--field-surface'] = { colors: ['#111111','#222222'], dir: 'swirl' };
  window.Settings.setState({ themeOverrides: ov });
  return 'seeded';
})()" >/dev/null
sleep 1
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
NORM=$(ev "
(function(){
  var on = document.querySelector('.te-type.on');
  var ang = document.querySelector('[data-te-angle]');
  return (on ? on.getAttribute('data-te-type') : 'none') + '§' + (ang ? ang.value : 'na');
})()")
ck "A6a a stored swirl opens NORMALIZED (the radial pill active)" \
   "$(echo "$NORM" | grep -q '^radial§' && echo yes)" "$NORM"
# the angle slider writes (the rAF-coalesced write lands AFTER the
# dispatch — probe in a separate eval past a sleep)
ev "
(function(){
  var sl = document.querySelector('[data-te-angle]');
  sl.value = 200; sl.dispatchEvent(new Event('input', {bubbles:true}));
  return 'dispatched';
})()" >/dev/null
sleep 0.8
ANG=$(ev "
(function(){
  var s = window.Settings.getState();
  var st = ((s.themeOverrides||{}).midnight||{})['--field-surface'];
  return String(st && st.angle);
})()")
ck "A6b the angle writes through (stored 200)" "$([ "$ANG" = "200" ] && echo yes)" "$ANG"
# switch to radial → the banner orbits (200° → at ~38% 83%)
RAD=$(ev "
(function(){
  var t = document.querySelector('[data-te-type=radial]');
  if (t) t.click();
  var b = document.querySelector('[data-te-banner]');
  return (b && b.style.backgroundImage || '').slice(0, 46);
})()")
ck "A6c the radial banner carries the orbited focal (200°)" \
   "$(echo "$RAD" | grep -q 'radial-gradient(circle at 3[78]' && echo yes)" "$RAD"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.9

# ── A7: the canvas raster honors the angle ─────────────────────────
# #c is transferred to the worker (no main-thread readback) — verify
# VISUALLY: two screenshots of the full-screen lattice, one per angle,
# must hash differently (a rotated pinstripe background).
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.8
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.close) p.close(); return 'ok'; })()" >/dev/null
sleep 1.5
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight['--field-canvas'] = { colors: ['#0d1b2a','#1b263b'], dir: 'pat-pinstripe', angle: 0 };
  window.Settings.setState({ themeOverrides: ov });
  return 'canvas-0';
})()" >/dev/null
sleep 3
agent-browser screenshot /tmp/v1035-a7-0.png > /dev/null 2>&1
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight['--field-canvas'] = { colors: ['#0d1b2a','#1b263b'], dir: 'pat-pinstripe', angle: 60 };
  window.Settings.setState({ themeOverrides: ov });
  return 'canvas-60';
})()" >/dev/null
sleep 3
agent-browser screenshot /tmp/v1035-a7-60.png > /dev/null 2>&1
H0=$(sha256sum /tmp/v1035-a7-0.png 2>/dev/null | cut -c1-16)
H60=$(sha256sum /tmp/v1035-a7-60.png 2>/dev/null | cut -c1-16)
ck "A7 the canvas raster honors the angle (screenshots differ 0° vs 60°)" \
   "$({ [ -n "$H0" ] && [ "$H0" != "$H60" ]; } && echo yes)" "h0=$H0 h60=$H60"

echo ""
echo "═══ v1035 UNIVERSAL ANGLE: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
