#!/bin/bash
# v1033-theme-editor.sh — THE EDITOR SCAFFOLD RIG (PLAN-V103 §v1.03.3).
#
# THE CONTRACT (user point 4, part 1 — the page + the tagged registry):
#  (E1) Clicking ANY field slot row opens THE THEME EDITOR as a panel
#       view (the pushView stack; ‹ back returns to the Colors tab).
#  (E2) The FIXED layout renders: the header row (the variable name
#       card + the 'Expand all tagged elements' pill), the wide colors
#       banner, the 2-row stop grid (cap 6, the + next to the last),
#       the small shuffle/random pills, the LEFT column (6 type pills
#       with LOCKED where the variable can't hold them + the angle
#       slider), the RIGHT column (the interim color editor until the
#       v1.03.4 wheel).
#  (E3) THE LOCKS: surface (DOM) locks pinstripe/checker/texture (3
#       locked); ink locks ALL SIX; canvas locks NONE (texture live).
#  (E4) THE STOPS: + adds (writes through, cap 6); the × on the
#       selected stop removes (min 2); shuffle rerolls hues; the stop
#       cap 6 holds (>6 stored specs trim on open with a toast).
#  (E5) THE TYPE PILLS switch the spec (mesh writes dir=mesh; the
#       banner repaints; the stored override follows).
#  (E6) THE TAGGED OVERLAY: the pill opens the Overlay with the
#       census-derived list (surface = 6 entries) + closes clean.
#  (E7) THE CANVAS EXTRAS: the canvas editor carries the grid children
#       (3 rows) + the MCU suggester (a file input) below the columns.
#  (E8) LIVE WRITES: the anchor row's banner + · customized marker
#       update BEHIND the view (the element reference survives the
#       root stash); back restores the Colors tab with them applied.
#  (E9) PERF: the open + interactions produce zero longtasks.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8433
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1033
export AGENT_BROWSER_SESSION=doomalay-v1033

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
setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1033.log 2>&1 < /dev/null &
EOF
  bash /tmp/doomalay-spawn-$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
# STATE ISOLATION: the browser session's localStorage outlives the
# server data dir — reset the theme overrides explicitly so every run
# starts from the never-customized contract (E2's 1-stop open).
ev "(function(){ window.Settings.setState({ themeOverrides: {} }); return 'reset'; })()" > /dev/null
sleep 1.2
ev "location.reload()" > /dev/null 2>&1
sleep 5
ev "window.__lt3=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt3.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5
ev "(function(){ var hs=document.querySelectorAll('.settings-section h3[data-section-toggle]'); for(var i=0;i<hs.length;i++){ if(/fields/i.test(hs[i].textContent)){ hs[i].click(); return 'ok'; } } })()" >/dev/null
sleep 0.8

# ── E1 + E2: open the editor ──────────────────────────────────────
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
LAYOUT=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  if (!te) return 'NO PAGE';
  return JSON.stringify({
    name: !!te.querySelector('.te-name b'),
    tagged: !!te.querySelector('[data-te-tagged]'),
    banner: !!te.querySelector('[data-te-banner]'),
    stops: te.querySelectorAll('.te-stop').length,
    add: !!te.querySelector('[data-te-add]'),
    tools: te.querySelectorAll('.te-tool').length,
    types: te.querySelectorAll('.te-type').length,
    angle: !!te.querySelector('[data-te-angle]'),
    color: !!te.querySelector('[data-te-color]'),
    hex: !!te.querySelector('[data-te-hex]')
  });
})()")
ck "E2 the fixed layout renders (all 9 zones)" \
   "$(echo "$LAYOUT" | grep -qE '\"name\":true.*\"tagged\":true.*\"banner\":true.*\"add\":true.*\"tools\":2.*\"types\":6.*\"angle\":true.*\"color\":true' && echo yes)" "$LAYOUT"
DEPTH=$(ev "(window.Settings.panelOf() && window.Settings.panelOf().viewDepth ? window.Settings.panelOf().viewDepth() : 'na')")
ck "E1 the editor rides the panel view stack (depth ≥ 1)" "$([ "$DEPTH" -ge 1 ] 2>/dev/null && echo yes)" "$DEPTH"

# ── E3: the locks ─────────────────────────────────────────────────
LOCKS=$(ev "(document.querySelectorAll('.te-page .te-type.lock').length)")
ck "E3a surface locks exactly 3 (pinstripe/checker/texture)" "$([ "$LOCKS" = "3" ] 2>/dev/null && echo yes)" "$LOCKS"

# ── E4: the stops ─────────────────────────────────────────────────
ev "(function(){ var a=document.querySelector('[data-te-add]'); if(a) a.click(); return 'ok'; })()" >/dev/null
sleep 0.4
ev "(function(){ var a=document.querySelector('[data-te-add]'); if(a) a.click(); return 'ok'; })()" >/dev/null
sleep 0.5
STOPS=$(ev "
(function(){
  var s = window.Settings.getState();
  var ov = (s.themeOverrides && s.themeOverrides.midnight && s.themeOverrides.midnight['--field-surface']) || null;
  return (document.querySelectorAll('.te-page .te-stop').length) + '/' + (ov && ov.colors ? ov.colors.length : 'none');
})()")
ck "E4a the + adds stops AND writes through (page = stored)" \
   "$(echo "$STOPS" | grep -qE '^3/3$' && echo yes)" "$STOPS"
# the remove × (on the selected stop)
ev "(function(){ var rm=document.querySelector('[data-te-rm]'); if(rm) rm.click(); return 'ok'; })()" >/dev/null
sleep 0.5
AFTER=$(ev "document.querySelectorAll('.te-page .te-stop').length")
ck "E4b the × removes the selected stop (min 2)" "$([ "$AFTER" = "2" ] 2>/dev/null && echo yes)" "$AFTER"
# the cap: fill to 6, the + disappears
for i in 1 2 3 4; do ev "(function(){ var a=document.querySelector('[data-te-add]'); if(a) a.click(); return 'ok'; })()" >/dev/null; sleep 0.25; done
CAP=$(ev "
(function(){
  var adds = document.querySelectorAll('[data-te-add]').length;
  return (document.querySelectorAll('.te-page .te-stop').length) + '/adds:' + adds;
})()")
ck "E4c the cap holds at 6 (the + retires)" "$(echo "$CAP" | grep -q '^6/adds:0$' && echo yes)" "$CAP"

# ── E5: the type pills ────────────────────────────────────────────
ev "(function(){ var t=document.querySelector('[data-te-type=mesh]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 0.6
TYPE=$(ev "
(function(){
  var on = document.querySelector('.te-type.on');
  var s = window.Settings.getState();
  var b = document.querySelector('[data-te-banner]');
  return (on ? on.getAttribute('data-te-type') : 'none') + '|' +
    ((s.themeOverrides.midnight['--field-surface'] || {}).dir) + '|' +
    (b && getComputedStyle(b).backgroundImage !== 'none' ? 'img' : 'flat');
})()")
ck "E5 mesh switches the spec + the banner repaints" "$(echo "$TYPE" | grep -q '^mesh|mesh|img$' && echo yes)" "$TYPE"

# ── E6: the tagged overlay ────────────────────────────────────────
ev "(function(){ var g=document.querySelector('[data-te-tagged]'); if(g) g.click(); return 'ok'; })()" >/dev/null
sleep 1.2
TAGGED=$(ev "
(function(){
  var co = document.getElementById('connect-overlay');
  var rows = document.querySelectorAll('.te-tag-row');
  return (co && getComputedStyle(co).display !== 'none' ? 'open' : 'shut') + '|' + rows.length + '|' +
    (rows.length ? rows[0].querySelector('.te-tag-name').textContent.slice(0,20) : '-');
})()")
ck "E6 the tagged overlay lists the census entries (surface = 6)" \
   "$(echo "$TAGGED" | grep -qE '^open\|6\|.+' && echo yes)" "$TAGGED"
ev "(function(){ var c=window.ConnectOverlay; if(c&&c.close) c.close(); return 'ok'; })()" >/dev/null
sleep 0.6

# ── E8: back first (the Colors root is view-stashed — unreachable
# while the editor covers it), THEN the restored row shows the writes
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 1
RESTORE=$(ev "(document.querySelector('.settings-nav') && document.querySelector('.settings-nav').isConnected ? 'restored' : 'lost')")
ck "E8a back restores the Colors tab" "$([ "$RESTORE" = "restored" ] && echo yes)" "$RESTORE"
BACK=$(ev "
(function(){
  var row = document.querySelector('[data-slot-open=surface]');
  if (!row) return 'no-row';
  var banner = row.querySelector('.slot-row-banner');
  var name = row.querySelector('.slot-row-name');
  return (banner && getComputedStyle(banner).backgroundImage !== 'none' ? 'img' : 'flat') + '|' +
    (name && name.textContent.indexOf('customized') >= 0 ? 'pinned' : 'bare');
})()")
ck "E8b the anchor row's banner + marker updated (mesh + pinned)" \
   "$(echo "$BACK" | grep -q '^img|pinned$' && echo yes)" "$BACK"

# ── E3b + E7: ink + canvas editors ─────────────────────────────────
ev "(function(){ var t=document.querySelector('[data-slot-open=ink]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.2
INK=$(ev "(document.querySelectorAll('.te-page .te-type.lock').length)")
ck "E3b ink locks ALL six type pills" "$([ "$INK" = "6" ] 2>/dev/null && echo yes)" "$INK"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.8
ev "(function(){ var t=document.querySelector('[data-slot-open=canvas]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
CANVAS=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  if (!te) return 'no-page';
  return (te.querySelectorAll('.te-type.lock').length) + '|' +
    (te.querySelectorAll('[data-te-extras] [data-color-row]').length) + '|' +
    (te.querySelector('[data-te-extras] input[type=file]') ? 'mcu' : 'nomcu');
})()")
ck "E3c canvas locks NOTHING (all six families live)" "$(echo "$CANVAS" | grep -qE '^0\|' && echo yes)" "$CANVAS"
ck "E7 the canvas extras ride below (3 grid children + the MCU input)" \
   "$(echo "$CANVAS" | grep -qE '\|3\|mcu$' && echo yes)" "$CANVAS"

# ── E4d: the >6 trim on open ──────────────────────────────────────
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" >/dev/null
sleep 0.8
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight['--field-surface'] = { colors: ['#111111','#222222','#333333','#444444','#555555','#666666','#777777','#888888'], dir: 'auto' };
  window.Settings.setState({ themeOverrides: ov });
  return 'seeded-8';
})()" >/dev/null
sleep 1
ev "(function(){ var t=document.querySelector('[data-slot-open=surface]'); if(t) t.click(); return 'ok'; })()" >/dev/null
sleep 1.4
TRIM=$(ev "
(function(){
  return (document.querySelectorAll('.te-page .te-stop').length) + '/toast:' + (document.querySelectorAll('#doom-toast').length > 0 || window.__toastShown === true ? 'y' : 'n');
})()")
ck "E4d an 8-stop stored spec opens TRIMMED to 6" "$(echo "$TRIM" | grep -qE '^6/' && echo yes)" "$TRIM"

# ── E9: perf ──────────────────────────────────────────────────────
LT=$(ev "window.__lt3.length")
ck "E9 zero longtasks through the whole flow" "$([ "$LT" = "0" ] 2>/dev/null && echo yes)" "$LT"

echo ""
echo "═══ v1033 THEME EDITOR: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
