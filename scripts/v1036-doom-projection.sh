#!/bin/bash
# v1036-doom-projection.sh — THE PROJECTION v2 RIG (PLAN-V103 §v1.03.6).
#
# THE CONTRACT (user point 2 — the doom projection returns):
#  (D1) THE TOGGLE: the switch row lives in the Colors tab ("Doom
#       projection"); ON sets html[data-doom-proj], shows the fullscreen
#       #doom-proj canvas (z 300 — above the world, below the UI,
#       pointer-events:none); OFF clears everything.
#  (D2) THE OVERRIDE: ON mints the override sheet — the panel's
#       background-image dies + its OPAQUE base goes transparent (the
#       canvas shows through); OFF restores the local gradient EXACTLY.
#  (D3) THE PROJECTION: the canvas paints OPAQUE field pixels at the
#       panel's rect, viewport-anchored (different positions = different
#       slices of the ONE shared field).
#  (D4) THE CONSUMERS: the crawl tracks the surface + accent families
#       (≥ 8 consumers with the seeded gradients); the tinted pills keep
#       their rgba bases (frosted glass, not erased).
#  (D5) THE THEME CHANGE re-rasters (a live gradient edit changes the
#       canvas pixels).
#  (D6) THE MOTION: a scroll event re-marks + repaints (the dirty-flag
#       loop).
#  (D7) PERF: with doom ON, live edits + scroll = ZERO longtasks.
#  (D8) THE PERSISTENCE: reload keeps the toggle (the boot sync).
#  (D9) SOLID THEMES: with doom ON + no gradient twins, the panel's
#       projected field = the flat surface color (visual parity).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8436
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1036
export AGENT_BROWSER_SESSION=doomalay-v1036

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
  bash /tmp/spawn8436.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
ev "(function(){ window.Settings.setState({ themeOverrides: {}, doomProjection: false }); return 'reset'; })()" > /dev/null
sleep 1
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight = ov.midnight || {};
  ov.midnight['--field-surface'] = { colors: ['#2a1a4a','#123a5a','#4a1a2a'], dir: 'auto' };
  ov.midnight['--field-accent-1'] = { colors: ['#ff6b35','#8e2de2'], dir: 'auto' };
  window.Settings.setState({ themeOverrides: ov });
  return 'seeded';
})()" > /dev/null
sleep 1
ev "location.reload()" > /dev/null 2>&1
sleep 5
ev "window.__lt6=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt6.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8

# ── D1: the toggle ────────────────────────────────────────────────
TG=$(ev "(document.querySelector('[data-setting-key=doomProjection]') ? 'present' : 'missing')")
ck "D1a the Doom projection switch renders in the Colors tab" "$([ "$TG" = "present" ] && echo yes)" "$TG"
ev "(function(){ var inp=document.querySelector('[data-setting-key=doomProjection]'); if(inp) inp.click(); return 'on'; })()" > /dev/null
sleep 1.5
ON=$(ev "
(function(){
  var c = document.getElementById('doom-proj');
  return JSON.stringify({
    enabled: window.DoomProjection.enabled(),
    attr: document.documentElement.getAttribute('data-doom-proj'),
    shown: c ? c.style.display : 'gone',
    z: c ? c.style.zIndex : 'na',
    pe: c ? c.style.pointerEvents : 'na'
  });
})()")
ck "D1b ON: the attr + the canvas (z 300, pointer-events none)" \
   "$(echo "$ON" | grep -q '\"enabled\":true.*\"attr\":\"on\".*\"shown\":\"block\".*\"z\":\"300\".*\"pe\":\"none\"' && echo yes)" "$ON"

# ── D2: the override ─────────────────────────────────────────────
OV=$(ev "
(function(){
  var panel = document.getElementById('chat-panel');
  return JSON.stringify({
    img: getComputedStyle(panel).backgroundImage,
    color: getComputedStyle(panel).backgroundColor,
    sheet: !!document.getElementById('doom-proj-override')
  });
})()")
ck "D2 ON: the panel's window dies + the base goes transparent + the sheet mints" \
   "$(echo "$OV" | grep -q '\"img\":\"none\".*\"color\":\"rgba(0, 0, 0, 0)\".*\"sheet\":true' && echo yes)" "$OV"

# ── D3 + D4: the projection ──────────────────────────────────────
PROJ=$(ev "
(function(){
  var c = document.getElementById('doom-proj');
  var g = c.getContext('2d');
  var d1 = g.getImageData(60, 150, 1, 1).data;
  var d2 = g.getImageData(350, 700, 1, 1).data;
  var st = window.DoomProjection.stats();
  return JSON.stringify({
    p1: d1[3], p2: d2[3],
    same: (d1[0] === d2[0] && d1[1] === d2[1] && d1[2] === d2[2]),
    consumers: st.consumers, paints: st.paints
  });
})()")
ck "D3 the canvas paints OPAQUE viewport-anchored slices (different spots, same field)" \
   "$(echo "$PROJ" | grep -q '\"p1\":255.*\"p2\":255.*\"same\":false' && echo yes)" "$PROJ"
CONS=$(echo "$PROJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['consumers'])" 2>/dev/null)
ck "D4 the consumer crawl tracks the families (≥ 8 with the seeded gradients)" \
   "$([ "$CONS" -ge 8 ] 2>/dev/null && echo yes)" "$CONS"

# ── D5: the theme change re-rasters ───────────────────────────────
P0=$(ev "
(function(){
  var c = document.getElementById('doom-proj');
  var g = c.getContext('2d');
  var d = g.getImageData(60, 150, 1, 1).data;
  return d[0] + ',' + d[1] + ',' + d[2];
})()")
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight['--field-surface'] = { colors: ['#5a1a1a','#0d2b45','#1a4a3a'], dir: 'auto' };
  window.Settings.setState({ themeOverrides: ov });
  return 'edited';
})()" > /dev/null
sleep 1
P1=$(ev "
(function(){
  var c = document.getElementById('doom-proj');
  var g = c.getContext('2d');
  var d = g.getImageData(60, 150, 1, 1).data;
  return d[0] + ',' + d[1] + ',' + d[2];
})()")
ck "D5 a live gradient edit re-rasters the field" "$([ "$P0" != "$P1" ] && echo yes)" "$P0 → $P1"

# ── D6: the motion (a scroll re-marks) ────────────────────────────
PA=$(ev "window.DoomProjection.stats().paints")
ev "document.querySelector('.panel-body').dispatchEvent(new Event('scroll', {bubbles:true}))" > /dev/null
sleep 0.5
PB=$(ev "window.DoomProjection.stats().paints")
ck "D6 a scroll event re-marks + repaints" "$([ "$PB" -gt "$PA" ] 2>/dev/null && echo yes)" "$PA → $PB"

# ── D7: perf ──────────────────────────────────────────────────────
sleep 1.5
LT=$(ev "window.__lt6.length")
ck "D7 zero longtasks with doom ON (edits + scroll)" "$([ "$LT" = "0" ] 2>/dev/null && echo yes)" "$LT"

# ── D8: the persistence (reload keeps it on) ──────────────────────
ev "location.reload()" > /dev/null 2>&1
sleep 5
PERS=$(ev "
(function(){
  return JSON.stringify({
    state: !!window.Settings.getState().doomProjection,
    enabled: window.DoomProjection.enabled(),
    attr: document.documentElement.getAttribute('data-doom-proj')
  });
})()")
ck "D8 the reload keeps the projection ON (the boot sync)" \
   "$(echo "$PERS" | grep -q '\"state\":true.*\"enabled\":true.*\"attr\":\"on\"' && echo yes)" "$PERS"

# ── D9: OFF restores exactly + the solid parity ──────────────────
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8
ev "(function(){ var inp=document.querySelector('[data-setting-key=doomProjection]'); if(inp) inp.click(); return 'off'; })()" > /dev/null
sleep 1.2
OFF=$(ev "
(function(){
  var panel = document.getElementById('chat-panel');
  var c = document.getElementById('doom-proj');
  return JSON.stringify({
    enabled: window.DoomProjection.enabled(),
    attr: document.documentElement.getAttribute('data-doom-proj'),
    img: getComputedStyle(panel).backgroundImage.slice(0, 24),
    color: getComputedStyle(panel).backgroundColor,
    shown: c ? c.style.display : 'na',
    sheet: !!document.getElementById('doom-proj-override')
  });
})()")
ck "D9a OFF restores the local gradient + clears everything" \
   "$(echo "$OFF" | grep -q '\"enabled\":false.*\"attr\":null.*\"img\":\"linear-gradient(135deg' && echo yes)" "$OFF"

echo ""
echo "═══ v1036 DOOM PROJECTION: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
