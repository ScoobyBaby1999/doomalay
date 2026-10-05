#!/bin/bash
# v1041-editor-fixes.sh — THE FIVE FIXES RIG (PLAN-V104 §v1.04.1).
#
# THE CONTRACT (the user's five fixes):
#  (F1) THE WHEEL CHANNEL: a touch drag on the color wheel NEVER
#       hijacks the panel (no sheet glide, no transform write — read
#       AFTER the drag rAF settles) — the panel doesn't even record
#       the touch (ownsGesture covers the wheel family). CONTROL: the
#       same drag on the plain editor body still glides the sheet.
#  (F2) THE TYPE TILES: a DISTINCT family (outline tiles, transparent
#       chrome on the UNSELECTED tiles) with real inline SVG glyphs;
#       the locked state carries a padlock SVG (no '⌧' text anywhere).
#  (F3) THE ANGLE BANNER: an angle slider input repaints the banner
#       LIVE (the computed background-image angle follows, no
#       re-render of the view).
#  (F4) THE TEX SEPARATION: the surface editor renders NO tex row;
#       the canvas editor's tex row owns the import (the texture tile
#       with no image falls through to it); with a tex seeded the
#       tile is active + 'replace image' + 'clear' render; clear
#       drops the stored tex.
#  (F5) THE RESET ARROW: the slot row's reset clears the field's
#       override (theme default returns) WITHOUT opening the editor.
#  (F6) PERF: the whole battery produces zero longtasks.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8441
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1041
export AGENT_BROWSER_SESSION=doomalay-v1041

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
  cat > /tmp/doomalay-spawn-$PORT.sh << EOF
#!/bin/bash
setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1041.log 2>&1 < /dev/null &
EOF
  bash /tmp/doomalay-spawn-$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
# STATE ISOLATION (the browser localStorage outlives the data dir)
ev "(function(){ window.Settings.setState({ themeOverrides: {} }); return 'reset'; })()" > /dev/null
sleep 1.2
ev "location.reload()" > /dev/null 2>&1
sleep 5
ev "window.__lt41=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt41.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null
# seed a 2-stop surface gradient (F5's override + F3's banner)
ev "(function(){ var ov={}; ov.midnight={}; ov.midnight['--field-surface']={colors:['#2a1a4a','#123a5a'],dir:'auto',angle:0}; window.Settings.setState({themeOverrides:ov}); return 'seeded'; })()" > /dev/null
sleep 1
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8

# ── F5 first (on the fresh Colors tab, before the editor opens) ────
RESET=$(ev "
(function(){
  var row = document.querySelector('[data-slot-open=surface]');
  if (!row) return 'NO ROW';
  var hadOverride = !!(window.Settings.getState().themeOverrides||{}).midnight;
  var rb = row.closest('.slot-row').querySelector('[data-slot-reset=surface]');
  if (!rb) return 'NO RESET BTN';
  rb.click();
  return JSON.stringify({ clicked: true, had: hadOverride });
})()")
ck "F5a the reset button exists + the surface override was seeded" \
   "$(echo "$RESET" | grep -q '"clicked":true' && echo "$RESET" | grep -q '"had":true' && echo yes)" "$RESET"
sleep 1.2
AFTER=$(ev "
(function(){
  var st = window.Settings.getState();
  var ov = (st.themeOverrides||{})[st.theme||'midnight'] || {};
  return JSON.stringify({
    cleared: (ov['--field-surface'] === undefined),
    editorOpen: !!document.querySelector('.te-page')
  });
})()")
ck "F5b the reset clears the override + does NOT open the editor" \
   "$(echo "$AFTER" | grep -q '"cleared":true' && echo "$AFTER" | grep -q '"editorOpen":false' && echo yes)" "$AFTER"

# re-seed the 2-stop gradient (F3's banner needs an image)
ev "(function(){ var ov={}; ov.midnight={}; ov.midnight['--field-surface']={colors:['#2a1a4a','#123a5a'],dir:'auto',angle:0}; window.Settings.setState({themeOverrides:ov}); return 're-seeded'; })()" > /dev/null
sleep 1

# ── open the editor (surface) for F1/F2/F3 ─────────────────────────
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4

# ── F2: the tile family ───────────────────────────────────────────
TILES=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  if (!te) return 'NO PAGE';
  var tiles = te.querySelectorAll('.te-tile');
  var svgs = 0, locks = 0, tofu = (te.textContent.indexOf('⌧') >= 0 ? 1 : 0);
  for (var i=0;i<tiles.length;i++){
    if (tiles[i].querySelector('svg')) svgs++;
    if (tiles[i].classList.contains('lock') && tiles[i].querySelector('.te-tile-lock svg')) locks++;
  }
  // an UNSELECTED tile (radial — the linear carries the seed's mode)
  var idle = null;
  for (var j=0;j<tiles.length;j++){ if (!tiles[j].classList.contains('on') && !tiles[j].classList.contains('lock')) { idle = tiles[j]; break; } }
  var bg = idle ? getComputedStyle(idle).backgroundColor : 'na';
  return JSON.stringify({ n: tiles.length, svgs: svgs, locks: locks, tofu: tofu, bg: bg });
})()")
ck "F2a six type tiles, every one carrying a real SVG glyph, zero '⌧' text" \
   "$(echo "$TILES" | grep -q '"n":6' && echo "$TILES" | grep -q '"svgs":6' && echo "$TILES" | grep -q '"tofu":0' && echo yes)" "$TILES"
ck "F2b the surface field locks the 3 canvas-only types, each with the padlock SVG" \
   "$(echo "$TILES" | grep -q '"locks":3' && echo yes)" "$TILES"
ck "F2c the tile family is DISTINCT (an unselected tile paints transparent chrome)" \
   "$(echo "$TILES" | grep -q '"bg":"rgba(0, 0, 0, 0)"' && echo yes)" "$TILES"

# ── F3: the angle banner repaints live ─────────────────────────────
ANG=$(ev "
(function(){
  var sl = document.querySelector('[data-te-angle]');
  var b = document.querySelector('[data-te-banner]');
  if (!sl || !b) return 'NO CONTROLS';
  var before = getComputedStyle(b).backgroundImage;
  sl.value = '90';
  sl.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ before: before, after: getComputedStyle(b).backgroundImage });
})()")
ck "F3a the banner's image changes on the angle input (live, no re-render)" \
   "$(echo "$ANG" | grep -q '"after":"linear-gradient(90deg' && echo yes)" "$ANG"
CK3=$(echo "$ANG" | python3 -c "import sys,json; a=json.load(sys.stdin); print('yes' if a['before']!=a['after'] else 'no')" 2>/dev/null)
ck "F3b the before ≠ after (the angle really landed)" "$CK3"

# ── F1a: the wheel channel (dispatch, settle, then read) ──────────
ev "
(function(){
  var w = document.querySelector('.te-wheel');
  if (!w) return 'NO WHEEL';
  window.__f1 = { gestureAt: window.__doomalayGestureAt || 0, xf: document.getElementById('chat-panel').style.transform || '' };
  var mk = function(type, x, y){
    var t = new Touch({ identifier: 1, target: w, clientX: x, clientY: y });
    return new TouchEvent(type, { touches: [t], bubbles: true, cancelable: true });
  };
  var r = w.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + 20;
  w.dispatchEvent(mk('touchstart', cx, cy));
  w.dispatchEvent(mk('touchmove', cx, cy + 80));   // 80px DOWN — way past the 24px slop
  w.dispatchEvent(mk('touchend', cx, cy + 80));
  return 'dispatched';
})()" > /dev/null
sleep 0.4   # let any (wrong) drag rAF land — the assertion reads settled state
WHEEL=$(ev "
(function(){
  var p = window.__f1 || {};
  return JSON.stringify({
    gestureAt: (window.__doomalayGestureAt || 0) === (p.gestureAt || 0),
    transformSame: (document.getElementById('chat-panel').style.transform || '') === (p.xf || '')
  });
})()")
ck "F1a a wheel touch drag (80px down, past the slop) never moves the sheet (settled)" \
   "$(echo "$WHEEL" | grep -q '"gestureAt":true' && echo "$WHEEL" | grep -q '"transformSame":true' && echo yes)" "$WHEEL"

# ── F1b: the CONTROL — the same drag on the plain body glides ─────
ev "
(function(){
  var page = document.querySelector('.te-page');
  if (!page) return 'NO PAGE';
  var body = document.getElementById('chat-panel').querySelector('.panel-body');
  if (body) body.scrollTop = 0;
  window.__f1b = { xf: document.getElementById('chat-panel').style.transform || '', g0: window.__doomalayGestureAt || 0 };
  var mk = function(type, x, y){
    var t = new Touch({ identifier: 2, target: page, clientX: x, clientY: y });
    return new TouchEvent(type, { touches: [t], bubbles: true, cancelable: true });
  };
  var r = page.getBoundingClientRect();
  var cx = r.left + 10, cy = r.top + 4;
  page.dispatchEvent(mk('touchstart', cx, cy));
  page.dispatchEvent(mk('touchmove', cx, cy + 80));
  return 'mid-drag';
})()" > /dev/null
sleep 0.15   # read MID-DRAG (the release's end() spring would restore the
             # dock transform and mask the glide — the settle is the same Y)
CTRL=$(ev "
(function(){
  var p = window.__f1b || {};
  var moved = (document.getElementById('chat-panel').style.transform || '') !== (p.xf || '');
  var stamped = (window.__doomalayGestureAt || 0) !== (p.g0 || 0);
  // release (the sheet springs home)
  var page = document.querySelector('.te-page');
  if (page) {
    var t = new Touch({ identifier: 2, target: page, clientX: 0, clientY: 0 });
    page.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
  }
  return JSON.stringify({ moved: moved, stamped: stamped });
})()")
ck "F1b CONTROL: the same drag on the plain body still glides the sheet (mid-drag)" \
   "$(echo "$CTRL" | grep -q '"moved":true' && echo "$CTRL" | grep -q '"stamped":true' && echo yes)" "$CTRL"
sleep 1.5   # the sheet settles back to its dock

# ── F4: the tex separation ─────────────────────────────────────────
ev "(function(){ var p=window.Settings.panelOf&&window.Settings.panelOf(); if(p&&p.popView) p.popView(); return 'back'; })()" > /dev/null
sleep 0.8
# re-open surface quickly to prove its tex row is EMPTY (not canvas family)
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.2
SURFROW=$(ev "(document.querySelector('[data-te-texrow]') && document.querySelector('[data-te-texrow]').innerHTML.trim()) ? 'present' : 'empty'")
ck "F4a the surface editor renders NO tex row (not the canvas family)" \
   "$([ "$SURFROW" = "empty" ] && echo yes)" "$SURFROW"
ev "(function(){ var p=window.Settings.panelOf&&window.Settings.panelOf(); if(p&&p.popView) p.popView(); return 'back'; })()" > /dev/null
sleep 0.8
ev "(function(){ var t=document.querySelector('[data-slot-open=canvas]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.2
CANROW=$(ev "
(function(){
  var row = document.querySelector('[data-te-texrow]');
  var imp = document.querySelector('[data-te-tex-import]');
  return JSON.stringify({
    row: !!row,
    import: !!imp,
    label: imp ? imp.textContent.trim() : '',
    clear: !!document.querySelector('[data-te-tex-clear]')
  });
})()")
ck "F4b the canvas editor's tex row renders (import, no tex yet)" \
   "$(echo "$CANROW" | grep -q '"row":true' && echo "$CANROW" | grep -q '"import":true' && echo "$CANROW" | grep -q '"clear":false' && echo yes)" "$CANROW"
PICK=$(ev "
(function(){
  var n = 0;
  var orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function(){
    if (this.type === 'file') { n++; return; }
    return orig.apply(this, arguments);
  };
  try {
    var t = document.querySelector('[data-te-type=tex]');
    if (t) t.click();
  } finally { HTMLInputElement.prototype.click = orig; }
  return JSON.stringify({ pickers: n });
})()")
ck "F4c the texture tile with no image opens THE IMPORT (the separated browse seam)" \
   "$(echo "$PICK" | grep -q '"pickers":1' && echo yes)" "$PICK"
ev "(function(){ var p=window.Settings.panelOf&&window.Settings.panelOf(); if(p&&p.popView) p.popView(); return 'back'; })()" > /dev/null
sleep 0.8
ev "(function(){ var ov=JSON.parse(JSON.stringify(window.Settings.getState().themeOverrides||{})); ov.midnight=ov.midnight||{}; ov.midnight['--field-canvas']={colors:['#101016','#202030'],dir:'auto',tex:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}; window.Settings.setState({themeOverrides:ov}); return 'tex-seeded'; })()" > /dev/null
sleep 1
ev "(function(){ var t=document.querySelector('[data-slot-open=canvas]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.2
TEXON=$(ev "
(function(){
  var t = document.querySelector('[data-te-type=tex]');
  var imp = document.querySelector('[data-te-tex-import]');
  return JSON.stringify({
    on: t ? t.classList.contains('on') : false,
    label: imp ? imp.textContent.trim() : '',
    clear: !!document.querySelector('[data-te-tex-clear]')
  });
})()")
ck "F4d with a tex seeded the texture tile is ACTIVE + the row offers replace + clear" \
   "$(echo "$TEXON" | grep -q '"on":true' && echo "$TEXON" | grep -q '"label":"replace image"' && echo "$TEXON" | grep -q '"clear":true' && echo yes)" "$TEXON"
PICK2=$(ev "
(function(){
  var n = 0;
  var orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function(){
    if (this.type === 'file') { n++; return; }
    return orig.apply(this, arguments);
  };
  try {
    var t = document.querySelector('[data-te-type=tex]');
    if (t) t.click();
  } finally { HTMLInputElement.prototype.click = orig; }
  return JSON.stringify({ pickers: n });
})()")
ck "F4e the texture tile with an image SELECTS (no browse — the separation)" \
   "$(echo "$PICK2" | grep -q '"pickers":0' && echo yes)" "$PICK2"
ev "(function(){ var c=document.querySelector('[data-te-tex-clear]'); if(c) c.click(); return 'cleared'; })()" > /dev/null
sleep 1.2
CLR=$(ev "
(function(){
  var st = window.Settings.getState();
  var ov = (st.themeOverrides||{})[st.theme||'midnight'] || {};
  var t = document.querySelector('[data-te-type=tex]');
  return JSON.stringify({
    stored: !((ov['--field-canvas']||{}).tex),
    tileOff: t ? !t.classList.contains('on') : true,
    clearGone: !document.querySelector('[data-te-tex-clear]')
  });
})()")
ck "F4f clear drops the stored tex + the tile deactivates" \
   "$(echo "$CLR" | grep -q '"stored":true' && echo "$CLR" | grep -q '"tileOff":true' && echo "$CLR" | grep -q '"clearGone":true' && echo yes)" "$CLR"

# ── F6: perf ───────────────────────────────────────────────────────
sleep 1
LT=$(ev "(window.__lt41 && window.__lt41.length) ? window.__lt41.length : 0")
ck "F6 zero longtasks across the whole battery" "$([ "$LT" = "0" ] && echo yes)" "$LT"

echo ""
if [ "$FAIL" = "0" ]; then echo "v1041: ALL $PASS GREEN"; else echo "v1041: $PASS pass, $FAIL FAIL"; fi
exit $FAIL
