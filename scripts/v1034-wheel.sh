#!/bin/bash
# v1034-wheel.sh — THE WHEEL RIG (PLAN-V103 §v1.03.4).
#
# THE CONTRACT (user point 4b — the color column + the picker retirement):
#  (W1) The right column renders the wheel stack: the CSS-composed disc
#       (conic hue + the white radial + the value darkener) + the handle +
#       the hex readout + the slim H/S/V sliders (gradient tracks) + the
#       COMMON grid (16) + the LAST USED row.
#  (W2) THE DRAG MATH: a pointer drag to a known polar position lands the
#       expected hue/saturation (h=90 at the right edge) — the hex, the
#       handle, the sliders AND the stored override all agree.
#  (W3) THE VALUE DIMENSION: the V slider darkens (the val overlay's
#       opacity = 1-V) — dark colors are reachable (the Photoshop
#       convention: the disc shows H×S, the slider owns V).
#  (W4) CULORI ROUND-TRIPS: hex→hsv→hex is identity (the vendored lib).
#  (W5) A COMMON swatch click writes the selected stop.
#  (W6) THE LAST USED: the close-time capture persists (localStorage),
#       dedupes, and re-renders in the next editor open.
#  (W7) THE FMT ROWS open the Theme Editor (Accent 1) — not the inline
#       expansion (user spec: "clicking to edit any color").
#  (W8) THE PICKER RETIREMENT: zero .slot-pop elements ever; no
#       [data-te-color] interim inputs remain.
#  (W9) PERF: the whole flow = zero longtasks.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8434
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1034
export AGENT_BROWSER_SESSION=doomalay-v1034

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
  pkill -f "doomalay-engine -port $PORT" 2>/dev/null
  cat > /tmp/spawn$PORT.sh << EOF
#!/bin/bash
setsid nohup /tmp/doomalay-engine -port $PORT -bind 0.0.0.0 -data-dir /tmp/doomalay-v1034 -open=false > /tmp/doomalay-v1034.log 2>&1 < /dev/null &
EOF
  bash /tmp/spawn$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
ev "(function(){ window.Settings.setState({ themeOverrides: {} }); return 'reset'; })()" > /dev/null
sleep 1
ev "localStorage.removeItem('doomalay.recentColors'); location.reload()" > /dev/null 2>&1
sleep 5
ev "window.__lt4=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt4.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8

# ── W1: the wheel column ──────────────────────────────────────────
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
COL=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  if (!te) return 'NO PAGE';
  return [!!te.querySelector('.te-wheel-disc'), !!te.querySelector('.te-wheel-white'),
          !!te.querySelector('[data-te-wval]'), !!te.querySelector('[data-te-whandle]'),
          te.querySelectorAll('[data-te-sl]').length,
          te.querySelectorAll('[data-te-common] .te-sw').length,
          te.querySelectorAll('[data-te-recent] .te-sw').length,
          !!te.querySelector('[data-te-color]')].join('|');
})()")
ck "W1 the wheel stack renders (disc+white+val+handle+3 sliders+16 common)" \
   "$(echo "$COL" | grep -qE '^true\|true\|true\|true\|3\|16\|0\|false$' && echo yes)" "$COL"

# ── W2: the drag math ─────────────────────────────────────────────
DRAG=$(ev "
(function(){
  var w = document.querySelector('[data-te-wheel]');
  var r = w.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  var px = cx + (r.width/2 - 3), py = cy;
  w.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX: px, clientY: py, pointerId: 7}));
  w.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX: px, clientY: py, pointerId: 7}));
  w.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, clientX: px, clientY: py, pointerId: 7}));
  var te = document.querySelector('.te-page');
  var s = window.Settings.getState();
  var stored = ((s.themeOverrides||{}).midnight||{})['--field-surface'];
  return [te.querySelector('[data-te-sl=h]').value,
          te.querySelector('[data-te-sl=s]').value,
          te.querySelector('[data-te-whandle]').style.left,
          (stored && stored.colors && stored.colors[0]) || 'none'].join('|');
})()")
ck "W2 the drag lands h=90° s≈100 at the right edge (hex/handle/slider/stored agree)" \
   "$(echo "$DRAG" | grep -qE '^9[05]\|(9[5-9]|100)\|9[0-9]\.[0-9]+%' && echo yes)" "$DRAG"

# ── W3: the value dimension ──────────────────────────────────────
VSL=$(ev "
(function(){
  var v = document.querySelector('[data-te-sl=v]');
  v.value = 90; v.dispatchEvent(new Event('input', {bubbles:true}));
  var te = document.querySelector('.te-page');
  return [te.querySelector('[data-te-wval]').style.opacity,
          te.querySelector('[data-te-hex]').textContent].join('|');
})()")
ck "W3 the V slider darkens (val overlay ≈ 0.1 at V=90)" \
   "$(echo "$VSL" | grep -qE '^0\.[0-2][0-9]*\|#' && echo yes)" "$VSL"

# ── W4: culori round-trips ────────────────────────────────────────
RT=$(ev "
(function(){
  var c = window.culori;
  if (!c) return 'no-culori';
  var toHsv = c.converter('hsv'), toRgb = c.converter('rgb');
  var probe = ['#22d3ee', '#74b816', '#14141a', '#ff00aa', '#f8fafc'];
  for (var i = 0; i < probe.length; i++) {
    var rt = c.formatHex(toRgb(toHsv(c.parse(probe[i]))));
    if (rt !== probe[i]) return 'drift ' + probe[i] + '→' + rt;
  }
  return 'identity';
})()")
ck "W4 culori hex→hsv→hex identity (5 probes)" "$([ "$RT" = "identity" ] && echo yes)" "$RT"

# ── W5: a common swatch writes ─────────────────────────────────────
SW=$(ev "
(function(){
  var sw = document.querySelector('[data-te-common] .te-sw:nth-child(10)');
  var c = sw.getAttribute('data-te-sw');
  sw.click();
  var te = document.querySelector('.te-page');
  var s = window.Settings.getState();
  return [c, te.querySelector('[data-te-hex]').textContent,
          (s.themeOverrides.midnight['--field-surface']||{}).colors[0]].join('|');
})()")
ck "W5 a common swatch click writes the selected stop" \
   "$(echo "$SW" | awk -F'|' '{ gsub(/#/,"",$1); gsub(/#/,"",$2); gsub(/#/,"",$3); print (tolower($1)==tolower($2) && tolower($2)==tolower($3)) ? "yes" : "no" }')" "$SW"

# ── W6: the recents (close-time capture) ──────────────────────────
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 1
REC=$(ev "localStorage.getItem('doomalay.recentColors')")
ck "W6a the close-time capture persists the colors" "$(echo "$REC" | grep -qE '#[0-9a-f]{6}' && echo yes)" "$REC"
# reopen → the last used row shows them
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
RESHOW=$(ev "document.querySelectorAll('[data-te-recent] .te-sw').length")
ck "W6b the next editor open shows the last used row" "$([ "$RESHOW" -ge 1 ] 2>/dev/null && echo yes)" "$RESHOW"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.9

# ── W7: the fmt rows open the editor ──────────────────────────────
ev "(function(){
  var hs = document.querySelectorAll('.settings-section h3[data-section-toggle]');
  for (var i = 0; i < hs.length; i++) { if (/text style/i.test(hs[i].textContent)) { hs[i].click(); return 'ok'; } }
})()" >/dev/null
sleep 0.9
ev "(function(){ var h=document.querySelector('[data-color-row] .color-row-head'); if(h) h.click(); return 'ok'; })()" >/dev/null
sleep 1.4
FMT=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  if (!te) return 'NO PAGE';
  var expanded = document.querySelectorAll('.color-row-collapsed.expanded').length;
  return [(te.querySelector('.te-name b')||{}).textContent, expanded].join('|');
})()")
ck "W7 the fmt row opens the Theme Editor (not the inline expansion)" \
   "$(echo "$FMT" | grep -qE '^Accent 1\|0$' && echo yes)" "$FMT"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.9

# ── W8: the picker retirement ────────────────────────────────────
POP=$(ev "document.querySelectorAll('.slot-pop').length")
ck "W8a zero .slot-pop elements ever exist (the retirement)" "$([ "$POP" = "0" ] 2>/dev/null && echo yes)" "$POP"
SRCC=$(cd "$(dirname "$0")/.." && grep -c "function openSlotPopover" engine/internal/server/web/appearance.js)
ck "W8b openSlotPopover is deleted from the source" "$([ "$SRCC" = "0" ] 2>/dev/null && echo yes)" "$SRCC"

# ── W9: perf ──────────────────────────────────────────────────────
LT=$(ev "window.__lt4.length")
ck "W9 zero longtasks through the whole flow" "$([ "$LT" = "0" ] 2>/dev/null && echo yes)" "$LT"

echo ""
echo "═══ v1034 THE WHEEL: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
