#!/bin/bash
# v0722-easy-slide-test.sh — THE EASY SLIDE-DOWN (v0.72.2 live test)
#
# User spec: "When the BIB panel and regular panel are docked at 30%, the
# bottom position where they are not in focus, we have to make it easier
# for them to be slide down and go out of render… if the user slides down
# when the panel is 30% dock the panel should go away."
#
# The web regular panel, live synthetic touches (the v0651 harness):
#   1. THE EASY DOWN (handle) — a 20px downward slide from the peek
#      closes (the v0.65.1 baseline, still true).
#   2. THE EASY DOWN (body, SCROLLED content) — the regression this wave
#      fixes: the transcript scrolled + a ~30px downward slide on the
#      body now CLOSES (the ducked grab skips the inner-scroller gate
#      and grabs at 10px; the old code scrolled the content instead and
#      never closed).
#   3. THE VELOCITY CLAUSE — a short fast down-flick on the handle
#      (dy ≤ 10, vy > 0.25) closes (in-eval setTimeout sequencing —
#      separate evals are too slow to build velocity).
#   4. THE STILL PRESS restores (v0.65.1 rule, unchanged).
#   5. THE UPWARD SLIDE restores (unchanged).
#   6. THE HELD-PRESS EXPIRY GUARD — a press held past the 3s hold keeps
#      the peek (the hold retriggers; the old code rose the panel
#      mid-press and the follow-up drag hit the hard decide() ladder).
#   7. THE REAL DOCKS KEEP THEIR LADDER — a non-ducked body pull with
#      scrolled content does not close (the gate only drops while
#      ducked) — a 20px pull scrolls, exactly as before.
#
# Plus the Kotlin static audit (the BIB's twin rules — CI compiles it).
#
# Usage: bash scripts/v0722-easy-slide-test.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
KT=platforms/android/app/src/main/java/com/doomalay/engine/PanelBrowserSheet.kt
GJ=engine/internal/server/web/gesture.js
DATA=/tmp/doomalay-v0722
PORT=8293
BASE=http://127.0.0.1:$PORT
export AGENT_BROWSER_SESSION=doomalay-v0722
PASS=0; FAIL=0
ev()  { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2 | want: $3)"; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing '$3')";; esac; }
near() { [ -n "$2" ] && [ -n "$3" ] && [ "$2" != "none" ] && [ "$3" != "none" ] && \
         [ $(( $2 < $3 ? $3 - $2 : $2 - $3 )) -le $4 ] && ok "$1 (y=$2, want~$3)" || bad "$1 (y=$2, want~$3 ±$4)"; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0722-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || { bad "engine boot"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# seed one chat icon + open its panel (the REAL mouse tap, retried —
# the engine round trip is variable; v0651's lesson)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Slide Bot","sandbox":"quick"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Slide Bot',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2

# the synthetic-touch helper (the v0651 pattern)
TOUCHAPI=$(ev "(function(){
  if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return 'no-touch-api';
  window.__touch = function(el, type, x, y) {
    var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent(type, {
      touches: (type === 'touchend' || type === 'touchcancel') ? [] : [t],
      targetTouches: (type === 'touchend' || type === 'touchcancel') ? [] : [t],
      changedTouches: [t],
      bubbles: true, cancelable: true, composed: true
    }));
    return 'ok';
  };
  window.__y = function() {
    var m = getComputedStyle(document.getElementById('chat-panel')).transform;
    if (!m || m === 'none') return 'none';
    var p = m.slice(m.indexOf('(') + 1, m.length - 1).split(',');
    var v = parseFloat(p.length === 16 ? p[13] : p[5]);
    return isNaN(v) ? 'nan' : Math.round(v);
  };
  window.__H = window.innerHeight;
  window.__isOpen = function(){ return document.getElementById('chat-panel').classList.contains('open'); };
  return 'armed';
})()")
check "the synthetic-touch helper armed" "$TOUCHAPI" "armed"

# reopen — the REAL mouse tap on the icon, retried (v0651's lesson)
reopenPanel() {
  local i
  for i in 1 2 3 4; do
    agent-browser mouse move 120 200 >/dev/null 2>&1
    agent-browser mouse down >/dev/null 2>&1; agent-browser mouse up >/dev/null 2>&1
    sleep 3.2
    [ "$(ev "window.__isOpen() ? 'open' : 'no'")" = "open" ] && return 0
  done
  return 1
}

# duckAndWait — a canvas touch, retried until the peek settles (the
# first touch sometimes blooms the long-press menu mid-glide)
duckAndWait() {
  local i y want
  want=$(ev "Math.round(window.__H * 0.70)")
  for i in 1 2 3; do
    ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
    sleep 1.0
    y=$(ev "window.__y()")
    [ -n "$y" ] && [ "$y" != "none" ] && [ $(( y < want ? want - y : y - want )) -le 14 ] && return 0
  done
  return 1
}

if reopenPanel; then ok "the chat panel opened"; else bad "the chat panel would not open"; fi

# ══ 1. THE EASY DOWN (handle) — the v0.65.1 baseline still closes ═══
if duckAndWait; then ok "1-pre the peek sits at the 30% dock"; else bad "1-pre the panel would not duck"; fi
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 500)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 510)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 520)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 520)" >/dev/null
sleep 1.3
check "1a the 20px handle slide CLOSES" "$(ev "window.__isOpen() ? 'open' : 'closed'")" "closed"

# ══ 2. THE EASY DOWN (body, scrolled content) — the fix ═════════════
if reopenPanel; then ok "2-pre the panel reopened"; else bad "2-pre the panel would not reopen"; fi
if duckAndWait; then ok "2-pre-b the panel ducked"; else bad "2-pre-b the panel would not duck"; fi
# scroll the transcript WHILE ducked: filler rows straight into the
# scroller (an empty chat has no #chat-messages — the scroller is it)
SEED=$(ev "(function(){
  var sc = document.getElementById('chat-scroll');
  if (!sc) return 'no-scroller';
  for (var i = 0; i < 60; i++) { var d = document.createElement('div'); d.textContent = 'filler row ' + i; d.style.padding = '14px'; sc.appendChild(d); }
  sc.scrollTop = 400;
  return sc.scrollTop > 0 ? 'scrolled:' + sc.scrollTop : 'wouldnt-stick';
})()")
has "2a the transcript is scrolled while ducked (the old gate's prey)" "$SEED" "scrolled:"
# a ~30px downward slide on the BODY (the old code: the scroller gate
# ate it — no hijack, no close; the new code: ducked grab at 10px)
ev "window.__touch(document.getElementById('chat-scroll'), 'touchstart', 200, 300)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchmove', 200, 310)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchmove', 200, 320)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchmove', 200, 330)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchend', 200, 330)" >/dev/null
sleep 1.3
check "2b THE FIX — the body slide on scrolled content CLOSES" "$(ev "window.__isOpen() ? 'open' : 'closed'")" "closed"

# ══ 3. THE VELOCITY CLAUSE — a short fast flick closes ══════════════
if reopenPanel; then ok "3-pre the panel reopened"; else bad "3-pre the panel would not reopen"; fi
if duckAndWait; then ok "3-pre-b the panel ducked"; else bad "3-pre-b the panel would not duck"; fi
# dy = 10 (NOT > the 10px threshold) but fast: 3 moves of ~3.3px every
# 8ms → inst ≈ 0.42 px/ms, the EMA crosses 0.25 by the 3rd sample. The
# sequence runs INSIDE one eval (setTimeout chain) — separate evals are
# 50-200ms apart and can never build velocity.
ev "new Promise(function(res){
  var h = document.querySelector('#chat-panel .handle');
  window.__touch(h, 'touchstart', 200, 500);
  setTimeout(function(){ window.__touch(h, 'touchmove', 200, 503.5); }, 8);
  setTimeout(function(){ window.__touch(h, 'touchmove', 200, 507); }, 16);
  setTimeout(function(){ window.__touch(h, 'touchmove', 200, 510); }, 24);
  setTimeout(function(){ window.__touch(h, 'touchend', 200, 510); res('flicked'); }, 32);
})" >/dev/null
sleep 1.5
check "3a the 10px FLICK closes (vy > 0.25 outranks the short dy)" "$(ev "window.__isOpen() ? 'open' : 'closed'")" "closed"

# ══ 4. THE STILL PRESS restores (the v0.65.1 rule, unchanged) ═══════
if reopenPanel; then ok "4-pre the panel reopened"; else bad "4-pre the panel would not reopen"; fi
if duckAndWait; then ok "4-pre-b the panel ducked"; else bad "4-pre-b the panel would not duck"; fi
ev "window.__touch(document.getElementById('chat-scroll'), 'touchstart', 200, 300)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchend', 200, 300)" >/dev/null
sleep 1.2
R4=$(ev "JSON.stringify({open: window.__isOpen(), y: window.__y(), want: Math.round(window.__H * 0.38)})")
has "4a the still press KEEPS the panel open" "$R4" '"open":true'
near "4b the still press restores the half dock" \
     "$(echo "$R4" | python3 -c 'import json,sys; print(json.load(sys.stdin)["y"])')" \
     "$(echo "$R4" | python3 -c 'import json,sys; print(json.load(sys.stdin)["want"])')" 14

# ══ 5. THE UPWARD SLIDE restores (unchanged) ═════════════════════════
if duckAndWait; then ok "5-pre the panel ducked"; else bad "5-pre the panel would not duck"; fi
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 500)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 480)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 460)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 460)" >/dev/null
sleep 1.2
R5=$(ev "JSON.stringify({open: window.__isOpen(), y: window.__y(), want: Math.round(window.__H * 0.38)})")
has "5a the upward slide keeps the panel open" "$R5" '"open":true'
near "5b the upward slide restores the half dock (never full)" \
     "$(echo "$R5" | python3 -c 'import json,sys; print(json.load(sys.stdin)["y"])')" \
     "$(echo "$R5" | python3 -c 'import json,sys; print(json.load(sys.stdin)["want"])')" 14

# ══ 6. THE HELD-PRESS EXPIRY GUARD ═══════════════════════════════════
if duckAndWait; then ok "6-pre the panel ducked"; else bad "6-pre the panel would not duck"; fi
ev "window.__touch(document.getElementById('chat-scroll'), 'touchstart', 200, 300)" >/dev/null
sleep 3.7   # past the 3s hold — the finger is still down
R6a=$(ev "JSON.stringify({y: window.__y(), want: Math.round(window.__H * 0.70), ducked: window.__doomalayPanelDuck})")
near "6a the held press KEEPS the peek past the 3s hold (the guard retriggers)" \
     "$(echo "$R6a" | python3 -c 'import json,sys; print(json.load(sys.stdin)["y"])')" \
     "$(echo "$R6a" | python3 -c 'import json,sys; print(json.load(sys.stdin)["want"])')" 14
has "6b still flagged ducked (no mid-press rise)" "$R6a" '"ducked":true'
ev "window.__touch(document.getElementById('chat-scroll'), 'touchend', 200, 300)" >/dev/null
sleep 1.2
R6c=$(ev "JSON.stringify({open: window.__isOpen(), y: window.__y(), want: Math.round(window.__H * 0.38)})")
near "6c the release after the long hold still restores the half dock" \
     "$(echo "$R6c" | python3 -c 'import json,sys; print(json.load(sys.stdin)["y"])')" \
     "$(echo "$R6c" | python3 -c 'import json,sys; print(json.load(sys.stdin)["want"])')" 14

# ══ 7. THE REAL DOCKS KEEP THEIR LADDER (regression) ════════════════
# not ducked, scrolled content: a 20px body pull must NOT close (the
# inner scroller owns it — exactly the pre-v0.72 behavior at the docks)
ev "(function(){ var sc = document.getElementById('chat-scroll'); if (sc) sc.scrollTop = 400; return 'set'; })()" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchstart', 200, 300)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchmove', 200, 312)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchmove', 200, 320)" >/dev/null
ev "window.__touch(document.getElementById('chat-scroll'), 'touchend', 200, 320)" >/dev/null
sleep 1.2
check "7a a 20px body pull at the HALF dock (scrolled) does NOT close" "$(ev "window.__isOpen() ? 'open' : 'closed'")" "open"

# ══ 8. THE KOTLIN TWIN (static audit — CI compiles it) ═══════════════
KT_SRC=$(cat "$KT")
has "K8a the ducked chain slop is 10dp (the easy grab)" "$KT_SRC" "private const val DUCK_CHAIN_SLOP_DP = 10"
has "K8b the chain rule's DUCKED branch (no atTop gate)" "$KT_SRC" "if (ducked) pull > dip(DUCK_CHAIN_SLOP_DP)"
has "K8c the WebView handoff drops the at-top gate while ducked" "$KT_SRC" "val atTopForChain = !ducked && !v.canScrollVertically(-1)"
has "K8d the fingerOnSheet expiry guard exists" "$KT_SRC" "fingerOnSheet"
has "K8e the unduck runnable retriggers while a finger is on the sheet" "$KT_SRC" "if (fingerOnSheet.get()) { resetDuckTimer(); return@Runnable }"
has "K8f the page DOWN arms the guard" "$KT_SRC" "the expiry guard — the finger is on the page"
has "K8g dragEnd stands the guard down" "$KT_SRC" "the drag (any driver) ended"
has "K8h beginClose stands the guard down" "$KT_SRC" "a closed sheet owes no expiry guard"
has "K8i release()'s dragFromDuck close-on-any-down stays" "$KT_SRC" "if (dy > 0) { dismissSpring(vy); return }"
GJ_SRC=$(cat "$GJ")
has "K8j the web ducked body slop is 10px" "$GJ_SRC" "var DUCK_BODY_SLOP = 10"
has "K8k the web ducked grab skips the scroller gate (mid-drag too)" "$GJ_SRC" "var duckGrab = ducked;"
has "K8l the web release's dy-or-flick clause" "$GJ_SRC" "dy > DUCK_TAP_SLOP || track.vy > DUCK_FLING_VY"
has "K8m the web expiry guard" "$GJ_SRC" "if (track.active || track.bodyStart) { resetDuckTimer(); return; }"
has "K8n the flick threshold sits between a nudge and a flick" "$GJ_SRC" "var DUCK_FLING_VY = 0.25"

# page errors across the whole ride
ERRS=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
check "E no console errors" "$ERRS" "0"

echo
echo "══ v0.72.2 EASY SLIDE-DOWN: $PASS pass / $FAIL fail ══"
[ "$FAIL" = "0" ]
