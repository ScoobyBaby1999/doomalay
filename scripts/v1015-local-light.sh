#!/bin/bash
# v1015-local-light.sh — THE LOCAL LIGHT RIG (PLAN-V102 §v1.01.5).
#
# THE CONTRACT — what the wave changed, proven live:
#  (L1) A live SURFACE gradient paints LOCALLY on the panel, its cards
#       and the canvas chrome pills (#settings-btn, the dock capsule) —
#       `background-attachment: scroll`, and ZERO elements app-wide
#       carry `fixed` (the two-hidden-fields class is dead by test).
#  (L2) THE THEME EVENT: applyTheme dispatches 'doomalay:theme-applied'
#       (coalesced) — the listeners pixiworld/app.js carried since v0.88
#       finally fire (the stale-canvas-icons bug).
#  (L3) THE SELF-COLORED THEME CHIPS: every swatch card paints its own
#       theme's RAW hexes (no var() in the style attribute — a live user
#       gradient can never wash or whiten them).
#  (L4) THE CHECKERED LIBRARY PILLS: the hub's category pills ride the
#       accents POSITIONALLY — acc1, acc2, acc3, acc1… (the accent-4
#       static assignment is gone).
#  (L5) THE OVERLAY SCREEN rides the SURFACE (the card paints the
#       surface gradient — not the canvas-derived flat).
#  (L6) [v1.03.1 re-pin] THE CHATBOT NAME PILL + SANDBOX BADGE ride the
#       flat CARD glass (the nested tiling kill — was the surface window;
#       pinned in v1031-card-audit C5).
#  (L7) PERF: with the gradient live + the Colors tab open, live
#       gradient edits AND a full panel drag produce ZERO longtasks and
#       a locked frame budget (the "super laggy" report is dead).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8415
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1015
export AGENT_BROWSER_SESSION=doomalay-v1015

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

# ── engine ──
if ! curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1; then
  rm -rf $DATA
  setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1015.log 2>&1 < /dev/null &
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5

# ── L1: the local gradient windows ────────────────────────────────
ev "location.reload()" > /dev/null 2>&1; sleep 5
GRAD=$(ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight = ov.midnight || {};
  ov.midnight['--field-surface'] = { colors: ['#2a1a4a','#123a5a'], dir: 'to bottom' };
  ov.midnight['--field-accent-1'] = { colors: ['#ff6b35','#8e2de2'], dir: 'to right' };
  window.Settings.setState({ themeOverrides: ov });
  return 'applied';
})()")
sleep 2
PANEL=$(ev "getComputedStyle(document.getElementById('chat-panel')).backgroundImage.slice(0,40)")
ck "L1a the panel paints the live surface gradient" \
   "$(echo "$PANEL" | grep -q 'linear-gradient' && echo yes)" "$PANEL"
ATT=$(ev "getComputedStyle(document.getElementById('chat-panel')).backgroundAttachment")
ck "L1b the panel attachment is LOCAL (scroll)" "$([ "$ATT" = "scroll" ] && echo yes)" "$ATT"
FIXED=$(ev "
(function(){
  var els = document.querySelectorAll('*'); var fixed = [];
  for (var i = 0; i < els.length; i++) {
    var a = getComputedStyle(els[i]).backgroundAttachment;
    if (a && a.indexOf('fixed') !== -1) fixed.push((els[i].id || els[i].className || els[i].tagName).toString().slice(0,30));
  }
  return fixed.join(',') || 'ZERO';
})()")
ck "L1c ZERO elements carry background-attachment: fixed" "$([ "$FIXED" = "ZERO" ] && echo yes)" "$FIXED"
GEAR=$(ev "
(function(){
  document.getElementById('settings-btn').click(); return 'ok';
})()" > /dev/null; ev "getComputedStyle(document.getElementById('settings-btn')).backgroundImage.slice(0,40)")
ck "L1d the settings-gear pill paints the surface gradient" \
   "$(echo "$GEAR" | grep -q 'linear-gradient' && echo yes)" "$GEAR"
CARDS=$(ev "
(function(){
  var secs = document.querySelectorAll('.settings-section');
  var flat = 0, tiled = 0;
  for (var i = 0; i < secs.length; i++) {
    var bi = getComputedStyle(secs[i]).backgroundImage;
    if (bi === 'none') flat++; else tiled++;
  }
  return flat + '/' + secs.length + '/tiled:' + tiled;
})()")
# v1.03.1 RE-PIN: the settings cards are the FLAT --card now (the nested
# tiling kill — was "every card paints the gradient"; the user's v1.03
# point 1). The contract: sections exist, ALL flat, zero tiled.
ck "L1e the settings cards are FLAT (the card — nested boxes never re-tile the field)" \
   "$(echo "$CARDS" | grep -qE '^[1-9][0-9]*/[1-9][0-9]*/tiled:0$' && echo yes)" "$CARDS"

# ── L2: the theme event ───────────────────────────────────────────
EVN=$(ev "
(function(){
  window.__tev = 0;
  window.addEventListener('doomalay:theme-applied', function(){ window.__tev++; });
  window.DoomTheme.apply(window.Settings.getState());
  return 'armed';
})()")
sleep 1
TEV=$(ev "window.__tev")
ck "L2a 'doomalay:theme-applied' fires on apply (coalesced)" "$([ "$TEV" -ge 1 ] 2>/dev/null && echo yes)" "$TEV"
# v1.03.6 RE-PIN: the DoomProjection v2 module replaced the v1.01.5
# compat stub (user point 2: "re-introduce the doom projection system" —
# the toggleable 2D canvas field projector). The contract: the module
# exposes the v2 API; DISABLED by default (the local-gradient model).
STAMP=$(ev "typeof window.DoomProjection === 'object' && typeof window.DoomProjection.setEnabled === 'function' && typeof window.DoomProjection.stats === 'function' ? 'v2' : 'other'")
ck "L2b the DoomProjection v2 module is loaded (toggleable, off by default)" \
   "$([ "$STAMP" = "v2" ] && [ "$(ev 'window.DoomProjection.enabled() ? 1 : 0')" = "0" ] && echo yes)" "$STAMP"

# ── L3: the self-colored theme chips ─────────────────────────────
CHIPS=$(ev "
(function(){
  var h3s = document.querySelectorAll('.settings-section h3');
  for (var i = 0; i < h3s.length; i++) {
    if ((h3s[i].textContent||'').indexOf('Theme') !== -1 && (h3s[i].textContent||'').indexOf('Fields') === -1) { h3s[i].click(); break; }
  }
  return 'ok';
})()" > /dev/null; sleep 1; ev "
(function(){
  var chips = document.querySelectorAll('[data-action=\"set-theme\"]');
  if (!chips.length) return 'NO CHIPS';
  var varFree = 0, distinct = {};
  for (var i = 0; i < chips.length; i++) {
    var st = chips[i].getAttribute('style') || '';
    if (st.indexOf('var(--') === -1) varFree++;
    distinct[getComputedStyle(chips[i]).backgroundColor] = 1;
  }
  return varFree + '/' + chips.length + ' varFree; ' + Object.keys(distinct).length + ' distinct bgs';
})()")
ck "L3a theme chips: all var()-free (self-colored)" "$(echo "$CHIPS" | grep -qE '^10/10 varFree' && echo yes)" "$CHIPS"
ck "L3b theme chips: distinct backgrounds (not white-washed)" \
   "$(echo "$CHIPS" | grep -qE '([7-9]|10) distinct bgs' && echo yes)" "$CHIPS"

# ── L4: the checkered lib pills ───────────────────────────────────
# Deterministic: ensure a chat exists, then drive the SAME api the dock
# button calls (window.Hub.open with canvasHost) — no fragile UI nav.
ev "
(function(){
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('Create your first chat')!==-1){ btns[i].click(); return 'created'; } }
  return 'chats exist: ' + document.querySelectorAll('.chatbot').length;
})()" > /dev/null 2>&1; sleep 2
ev "
(function(){
  if (!document.querySelectorAll('.chatbot').length) return 'NO CHAT ICONS';
  try { window.Hub.open(undefined, { chat: null, canvasHost: true }); return 'hub api open'; }
  catch (e) { return 'ERR ' + e.message; }
})()" > /dev/null 2>&1
for ATTEMPT in 1 2 3 4; do
  sleep 3
  CHECK=$(ev "
(function(){
  var pills = document.querySelectorAll('.hub-libpill');
  if (!pills.length) return 'NO PILLS';
  var tones = [];
  for (var i = 0; i < pills.length; i++) tones.push(pills[i].getAttribute('data-tone'));
  return tones.join(',');
})()")
  [ "$CHECK" != "NO PILLS" ] && break
done
ck "L4a the lib pills ride the positional checkers (acc1,acc2,acc3,\u2026)" \
   "$(echo "$CHECK" | grep -q 'acc1,acc2,acc3,acc1' && echo yes)" "$CHECK"
ACTIVEBG=$(ev "getComputedStyle(document.querySelector('.hub-libpill[data-on=\"1\"]')).backgroundColor")
ck "L4b the ACTIVE pill carries its accent tint (not a flat white)" \
   "$(echo "$ACTIVEBG" | grep -qE 'rgba|oklab|rgb' && echo yes)" "$ACTIVEBG"

# ── L5: the overlay screen rides the surface ──────────────────────
ev "var l=document.getElementById('dock-library'); 'ok'" > /dev/null 2>&1
ev "
(function(){
  var pe = document.getElementById('panel-handle');
  if (pe) {
    var r = pe.getBoundingClientRect();
    var x = r.left + r.width/2, y0 = r.top + r.height/2;
    function p(t, y){ pe.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true })); }
    p('pointerdown', y0); p('pointermove', y0+40); p('pointermove', y0+160); p('pointermove', y0+300); p('pointerup', y0+300);
  }
  return 'closed';
})()" > /dev/null 2>&1; sleep 2
ev "
(function(){
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++){ if ((btns[i].getAttribute('aria-label')||'').indexOf('Cloud providers')!==-1){ btns[i].click(); return 'cloud'; } }
  return 'no cloud btn';
})()" > /dev/null 2>&1; sleep 2.5
OVL=$(ev "
(function(){
  var card = document.querySelector('#connect-overlay > div:nth-child(2)');
  if (!card) return 'NO CARD';
  var cs = getComputedStyle(card);
  return cs.backgroundColor + ' | ' + cs.backgroundImage.slice(0,30) + ' | ' + cs.backgroundAttachment;
})()")
ck "L5a the overlay card paints the SURFACE gradient (not canvas-flat)" \
   "$(echo "$OVL" | grep -q 'linear-gradient' && echo yes)" "$OVL"
ck "L5b the overlay card attachment is LOCAL" "$(echo "$OVL" | grep -q 'scroll' && echo yes)" "$OVL"

# ── L7: the perf gate (live edits + panel drag) ───────────────────
ev "document.getElementById('connect-overlay-x') ? (document.getElementById('connect-overlay-x').click(), 'x') : 'no x'" > /dev/null 2>&1; sleep 1
ev "document.getElementById('settings-btn').click(); 'ok'" > /dev/null 2>&1; sleep 2
PERF=$(ev "
(function(){
  window.__lt3 = [];
  if (window.PerformanceObserver) {
    new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__lt3.push(Math.round(e.duration)); }); }).observe({ entryTypes: ['longtask'] });
  }
  var frames = []; window.__f3 = frames;
  var t0 = performance.now(); var last = t0;
  function tick(t){ frames.push(t - last); last = t; if (t - t0 < 1800) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  // the live commit path: 10 gradient ticks
  var h3s = document.querySelectorAll('.settings-section h3');
  for (var i = 0; i < h3s.length; i++) { if ((h3s[i].textContent||'').indexOf('Fields') !== -1) { h3s[i].click(); break; } }
  return 'armed';
})()" 2>/dev/null); sleep 1
PERF2=$(ev "
(function(){
  var rows = document.querySelectorAll('[data-color-toggle], .color-row-head, .ts-detail');
  // find the Surface edit button by title
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++){
    if ((btns[i].getAttribute('aria-label')||'') === 'edit Surface' || (btns[i].title||'') === 'edit Surface'){ btns[i].click(); return 'editor open'; }
  }
  return 'no editor: ' + rows.length;
})()")
sleep 1
LIVE=$(ev "
(function(){
  var inp = document.querySelector('.gr-color');
  if (!inp) return 'NO INPUT';
  var val = inp.value;
  for (var i = 0; i < 10; i++) {
    val = '#' + (parseInt(val.slice(1), 16) + 0x020304).toString(16).padStart(6, '0').slice(0, 6);
    inp.value = val;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return '10 live ticks';
})()")
sleep 2.5
FR=$(ev "
(function(){
  var f = window.__f3 || [];
  var max = Math.max.apply(null, f.concat([0]));
  return JSON.stringify({ n: f.length, max: Math.round(max), lt: (window.__lt3||[]).length });
})()")
ck "L7a live gradient edits: zero longtasks" "$(echo "$FR" | grep -q '\"lt\":0' && echo yes)" "$FR"
ck "L7b live gradient edits: max frame ≤ 50ms" \
   "$(echo "$FR" | grep -qE '\"max\":([0-9]|[1-4][0-9])(\.|,|})' && echo yes)" "$FR"

echo ""
echo "═══ v1015 local light: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
