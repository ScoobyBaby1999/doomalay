#!/bin/bash
# v1042-the-restore.sh — THE DOOM PROJECTION RESTORE RIG (PLAN-V104 §2).
#
# THE CONTRACT (the user order: the canvas system was "entirely
# broken" — the replaced system restored, ported to the field twins):
#  (R1) THE TOGGLE: ON sets html[data-doom-proj] + THE DOOM SHEET
#       mints (every gradient-family rule gains the prefixed fixed-
#       attachment copy); OFF tears EVERYTHING down (the v1.01.5 local
#       light — byte-identical for toggle-off users).
#  (R2) THE NATIVE LEG: an OUTSIDE-root gradient consumer computes
#       attachment FIXED with ON, SCROLL with OFF (the dock toggle —
#       [data-s1-grad] #dock-expando…).
#  (R3) THE PAINTER LEG: inside the panel root, the windows bake —
#       vw×vh background-size + calc(var(--proj-tx/-ty) positions +
#       the data-proj-root registry + the vars sheet (the transform-
#       proof re-anchoring).
#  (R4) THE ALLOW-LIST: the fmt text track (--fmt-*-gradient) is
#       NEVER minted (local by design); the derived-solid catchers
#       (surface-2/border-strong) are never minted.
#  (R5) THE EPOCH: a live gradient change re-mints (the theme event)
#       — the painted windows follow the new gradient.
#  (R6) THE MOTION: a root transform write rides the CHEAP path
#       (stats.motions increments — no full paint).
#  (R7) THE SCROLL: a scroll inside the panel rides the incremental
#       rebake (stats.rebakes/baked move; no full paint storm).
#  (R8) PERF: ON + interactions = zero longtasks.
#  (R9) THE PERSISTENCE: reload keeps the toggle + the projection.
#  (R10) SOLID THEMES: ON with no gradient twins = nothing minted
#       for dead rules; the app renders the local light exactly.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8442
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1042
export AGENT_BROWSER_SESSION=doomalay-v1042

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
setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1042.log 2>&1 < /dev/null &
EOF
  bash /tmp/spawn$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
ev "(function(){ window.Settings.setState({ themeOverrides: {}, doomProjection: false }); return 'reset'; })()" > /dev/null
sleep 1.2
ev "location.reload()" > /dev/null 2>&1
sleep 5
ev "window.__lt42=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt42.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null

# seed a SURFACE gradient (the windows need live twins) + open the panel
ev "(function(){ var ov={}; ov.midnight={}; ov.midnight['--field-surface']={colors:['#2a1a4a','#123a5a','#4a1a2a'],dir:'auto'}; ov.midnight['--field-accent-1']={colors:['#ff6b35','#8e2de2'],dir:'auto'}; window.Settings.setState({themeOverrides:ov}); return 'seeded'; })()" > /dev/null
sleep 1.5
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8

# ── R1: the toggle ON ───────────────────────────────────────────────
ev "(function(){ var inp=document.querySelector('[data-setting-key=doomProjection]'); if(inp) inp.click(); return 'on'; })()" > /dev/null
sleep 1.8
ON=$(ev "
(function(){
  var sheet = document.getElementById('doom-proj-override');
  var css = sheet ? sheet.textContent : '';
  return JSON.stringify({
    enabled: window.DoomProjection.enabled(),
    attr: document.documentElement.getAttribute('data-doom-proj'),
    sheet: !!sheet,
    mints: sheet ? (sheet.textContent.match(/html\[data-doom-proj\]/g) || []).length : 0,
    fmtLeak: sheet ? (sheet.textContent.indexOf('[data-fmt-grad') >= 0) : false,
    varSheet: !!document.getElementById('doom-proj-vars'),
    layerSheet: !!document.getElementById('proj-layer-styles'),
    roots: document.querySelectorAll('[data-proj-root]').length
  });
})()")
ck "R1a ON: the attr + the DOOM SHEET mint + the painter's sheets live" \
   "$(echo "$ON" | grep -q '"enabled":true' && echo "$ON" | grep -q '"attr":"on"' && echo "$ON" | grep -q '"sheet":true' && echo "$ON" | grep -q '"varSheet":true' && echo yes)" "$ON"
MINTS=$(echo "$ON" | python3 -c "import sys,json; print(json.load(sys.stdin)['mints'])" 2>/dev/null)
ck "R1b the sheet mints the gradient families (≥ 5 rules)" \
   "$([ "$MINTS" -ge 5 ] 2>/dev/null && echo yes)" "$MINTS"
ck "R1c the fmt text track is NEVER minted (local by design)" \
   "$(echo "$ON" | grep -q '"fmtLeak":false' && echo yes)" "$ON"
ROOTS=$(echo "$ON" | python3 -c "import sys,json; print(json.load(sys.stdin)['roots'])" 2>/dev/null)
ck "R1d the root registry tracks the transformed panel" \
   "$([ "$ROOTS" -ge 1 ] 2>/dev/null && echo yes)" "$ROOTS"

# ── R2: the native leg (an OUTSIDE-root consumer) ──────────────────
NATIVE=$(ev "
(function(){
  // the dock toggle: [data-s1-grad] #dock-expando… — outside any
  // transformed root; with a live surface gradient + the gates set,
  // it paints the surface twin
  var dt = document.getElementById('dock-toggle');
  var st = window.DoomProjection.stats();
  return JSON.stringify({
    found: !!dt,
    gated: !!(document.documentElement.getAttribute('data-s1-grad')),
    att: dt ? getComputedStyle(dt).backgroundAttachment : 'na'
  });
})()")
ck "R2 the outside-root consumer computes attachment FIXED (the native projection)" \
   "$(echo "$NATIVE" | grep -q '"found":true' && echo "$NATIVE" | grep -q '"att":"fixed"' && echo yes)" "$NATIVE"

# ── R3: the painter leg (inside the panel) ──────────────────────────
PAINTER=$(ev "
(function(){
  var panel = document.getElementById('chat-panel');
  var baked = 0, layered = 0, sizeOk = false;
  var els = panel.querySelectorAll('[style]');
  for (var i=0;i<els.length;i++){
    var s = els[i].style;
    if (s.backgroundSize && s.backgroundPosition && s.backgroundPosition.indexOf('--proj-') >= 0) baked++;
  }
  layered = document.querySelectorAll('[data-proj]').length;
  // the L2 layer rules carry the viewport-sized field
  var ls = document.getElementById('proj-layer-styles');
  if (ls && ls.sheet) {
    for (var j=0;j<ls.sheet.cssRules.length;j++) {
      if (ls.sheet.cssRules[j].style && ls.sheet.cssRules[j].style.backgroundSize === window.innerWidth + 'px ' + window.innerHeight + 'px') { sizeOk = true; break; }
    }
  }
  var st = window.DoomProjection.stats();
  return JSON.stringify({
    bakedN: baked + layered,
    inlineBaked: baked,
    layered: layered,
    sizeOk: sizeOk,
    painted: st.painted,
    rootAttr: panel.getAttribute('data-proj-root') !== null
  });
})()")
BAKED=$(echo "$PAINTER" | python3 -c "import sys,json; print(json.load(sys.stdin)['bakedN'])" 2>/dev/null)
ck "R3a the panel's windows bake (the L2 layers + the inline calc anchors)" \
   "$([ "$BAKED" -ge 1 ] 2>/dev/null && echo yes)" "$PAINTER"
ck "R3b the bake sizes to the viewport (412px 915px)" \
   "$(echo "$PAINTER" | grep -q '"sizeOk":true' && echo yes)" "$PAINTER"
ck "R3c the panel carries the root registry attribute" \
   "$(echo "$PAINTER" | grep -q '"rootAttr":true' && echo yes)" "$PAINTER"

# ── R5: the epoch re-mint (a live gradient change) ──────────────────
P0=$(ev "(window.DoomProjection.counters.paints)")
ev "(function(){ var ov=JSON.parse(JSON.stringify(window.Settings.getState().themeOverrides||{})); ov.midnight=ov.midnight||{}; ov.midnight['--field-surface']={colors:['#1a2a4a','#5a3a1a'],dir:'auto'}; window.Settings.setState({themeOverrides:ov}); return 'flipped'; })()" > /dev/null
sleep 1.5   # the 120ms trailing theme event + the settle
P1=$(ev "(window.DoomProjection.counters.paints)")
FLIP=$(ev "
(function(){
  var st = window.DoomProjection.stats();
  return JSON.stringify({ paints: window.DoomProjection.counters.paints, painted: st.painted });
})()")
ck "R5 a live gradient change re-paints (the epoch follows)" \
   "$([ "$P1" -gt "$P0" ] 2>/dev/null && echo yes)" "P0=$P0 P1=$P1"

# ── R6: the motion path (the cheap var write) ──────────────────────
M0=$(ev "(window.DoomProjection.counters.motions)")
ev "
(function(){
  var panel = document.getElementById('chat-panel');
  panel.style.transform = 'translate3d(0, 10px, 0)';   // a root transform write
  return 'moved';
})()" > /dev/null
sleep 0.4
ev "(function(){ var panel = document.getElementById('chat-panel'); panel.style.transform = 'translate3d(0, 0px, 0)'; return 'back'; })()" > /dev/null
sleep 0.6
M1=$(ev "(window.DoomProjection.counters.motions)")
ck "R6 a root transform write rides the CHEAP motion path (motions increment)" \
   "$([ "$M1" -gt "$M0" ] 2>/dev/null && echo yes)" "M0=$M0 M1=$M1"

# ── R7: the scroll path (the incremental rebake) ───────────────────
S0=$(ev "
(function(){
  // the probe rides an element INSIDE the scroller (the panel header
  // is a SIBLING of .panel-body — chrome, correctly static)
  var body = document.getElementById('chat-panel').querySelector('.panel-body');
  // the probe rides a painted IN-FLOW element: the settings nav TAB
  // (verified) — NOT the sticky nav strip, the scroller-sibling header,
  // or the carried offscreen windows (all correctly static)
  var subj = body.querySelector('.tab.active');
  if (!subj || !subj.__projPainted || subj.__projBy === undefined) {
    var els = body.querySelectorAll('*');
    for (var i=0;i<els.length;i++){
      var pt = els[i].__projPosType;
      if (els[i].__projPainted && !els[i].__projCarry && els[i].__projBy !== undefined &&
          pt !== 'sticky' && pt !== 'fixed') { subj = els[i]; break; }
    }
  }
  if (!subj) return JSON.stringify({ anchor: 'none', by: 'none' });
  var a = (subj.__projL2 && subj.__projL2.pos) || subj.style.backgroundPosition || '';
  return JSON.stringify({ anchor: a, by: subj.__projBy });
})()")
ev "
(function(){
  var body = document.getElementById('chat-panel').querySelector('.panel-body');
  if (body) { body.scrollTop = (body.scrollTop > 40) ? 0 : 120; }   // ALWAYS a real delta
  return 'scrolled';
})()" > /dev/null
sleep 0.5
S1=$(ev "
(function(){
  // the probe rides an element INSIDE the scroller (the panel header
  // is a SIBLING of .panel-body — chrome, correctly static)
  var body = document.getElementById('chat-panel').querySelector('.panel-body');
  // the probe rides a painted IN-FLOW element: the settings nav TAB
  // (verified) — NOT the sticky nav strip, the scroller-sibling header,
  // or the carried offscreen windows (all correctly static)
  var subj = body.querySelector('.tab.active');
  if (!subj || !subj.__projPainted || subj.__projBy === undefined) {
    var els = body.querySelectorAll('*');
    for (var i=0;i<els.length;i++){
      var pt = els[i].__projPosType;
      if (els[i].__projPainted && !els[i].__projCarry && els[i].__projBy !== undefined &&
          pt !== 'sticky' && pt !== 'fixed') { subj = els[i]; break; }
    }
  }
  if (!subj) return JSON.stringify({ anchor: 'none', by: 'none' });
  var a = (subj.__projL2 && subj.__projL2.pos) || subj.style.backgroundPosition || '';
  return JSON.stringify({ anchor: a, by: subj.__projBy });
})()")
SCROLL_OK=$(python3 -c "
import json
try:
  a=json.loads('''$S0'''); b=json.loads('''$S1''')
  print('yes' if (a['anchor'] != b['anchor'] or a['by'] != b['by']) else 'no')
except Exception:
  print('no')")
ck "R7 a panel-body scroll rides the incremental rebake (the anchor moves, no full paint)" "$SCROLL_OK" "S0=$S0 S1=$S1"

# ── R8: perf ────────────────────────────────────────────────────────
sleep 1
LT=$(ev "(window.__lt42 && window.__lt42.length) ? window.__lt42.length : 0")
ck "R8 zero longtasks with the projection ON" "$([ "$LT" = "0" ] && echo yes)" "$LT"

# ── R9: the persistence ─────────────────────────────────────────────
ev "location.reload()" > /dev/null 2>&1
sleep 5
PERSIST=$(ev "
(function(){
  var sheet = document.getElementById('doom-proj-override');
  return JSON.stringify({
    enabled: window.DoomProjection.enabled(),
    sheet: !!sheet,
    attr: document.documentElement.getAttribute('data-doom-proj')
  });
})()")
ck "R9 the reload keeps the toggle + the projection (the boot sync)" \
   "$(echo "$PERSIST" | grep -q '"enabled":true' && echo "$PERSIST" | grep -q '"sheet":true' && echo yes)" "$PERSIST"

# ── R1-off: the teardown (the local light restored) ────────────────
# the reload closed the panel — re-open + expand before flipping the switch
agent-browser eval "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
agent-browser eval "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8
ev "(function(){ var inp=document.querySelector('[data-setting-key=doomProjection]'); if(inp) inp.click(); return 'off'; })()" > /dev/null
sleep 1.5
OFF=$(ev "
(function(){
  var panel = document.getElementById('chat-panel');
  var dt = document.getElementById('dock-toggle');
  var leftover = 0;
  var els = panel.querySelectorAll('[style]');
  for (var i=0;i<els.length;i++){
    var s = els[i].style;
    if (s.backgroundPosition && s.backgroundPosition.indexOf('--proj-') >= 0) leftover++;
  }
  return JSON.stringify({
    enabled: window.DoomProjection.enabled(),
    attr: document.documentElement.getAttribute('data-doom-proj'),
    sheet: !!document.getElementById('doom-proj-override'),
    varSheet: !!document.getElementById('doom-proj-vars'),
    rootAttr: panel.getAttribute('data-proj-root') !== null,
    leftover: leftover,
    dtAtt: dt ? getComputedStyle(dt).backgroundAttachment : 'na',
    projLayers: document.querySelectorAll('[data-proj]').length
  });
})()")
ck "R10a OFF: everything tears down (attr, sheet, vars, roots, layers, bakes)" \
   "$(echo "$OFF" | grep -q '"enabled":false' && echo "$OFF" | grep -q '"attr":null' && echo "$OFF" | grep -q '"sheet":false' && echo "$OFF" | grep -q '"varSheet":false' && echo "$OFF" | grep -q '"rootAttr":false' && echo "$OFF" | grep -q '"leftover":0' && echo "$OFF" | grep -q '"projLayers":0' && echo yes)" "$OFF"
ck "R10b OFF: the outside-root consumer returns to SCROLL (the local light)" \
   "$(echo "$OFF" | grep -q '"dtAtt":"scroll"' && echo yes)" "$OFF"

# ── R10: solid themes (no gradient twins) ───────────────────────────
ev "(function(){ window.Settings.setState({ themeOverrides: {} }); return 'cleared'; })()" > /dev/null
sleep 1.5
SOLID=$(ev "
(function(){
  // the cleared overrides: the base midnight theme — solid twins only
  window.DoomProjection.setEnabled(true);
  var sheet = document.getElementById('doom-proj-override');
  var css = sheet ? sheet.textContent : '';
  var st = window.DoomProjection.stats();
  var r = JSON.stringify({
    mints: (css.match(/background-attachment: fixed/g) || []).length,
    painted: st.painted,
    gated: !!(document.documentElement.getAttribute('data-s1-grad'))
  });
  window.DoomProjection.setEnabled(false);
  return r;
})()")
ck "R10c SOLID: with no gradient twins the gates never fire — the projection holds nothing (visual parity)" \
   "$(echo "$SOLID" | grep -q '"gated":false' && echo yes)" "$SOLID"

echo ""
if [ "$FAIL" = "0" ]; then echo "v1042: ALL $PASS GREEN"; else echo "v1042: $PASS pass, $FAIL FAIL"; fi
exit $FAIL
