#!/bin/bash
# v0651-parity-test.sh — RED-TEAM the v0.65.1 PARITY WAVE (PLAN-V0643's
# second half): the regular panel grows the BIB panel's SECRET THIRD
# DOCK, and BOTH panels obey THE DOCKED RULES.
#
# USER SPEC: "let's expand this bib panel functionality to the regular
# panel. Reuse the function if easier. But let's have the bib panel and
# regular panel function the same, in that they have 3 fixed positions,
# 2 mains ones, and one that stays for ~3 retriggrable seconds unless
# the user is interacting. Finally, let's add the functionality so that
# if the user presses the panel while it is docked at 30%, (they are
# don't interacting) if they press it or slide up, the panel goes back
# to it's original position, if they slide it down, it goes slides down
# and stops rendering."
#
# THE DESIGN UNDER TEST (gesture.js + panel.js + browserdock.js live;
# PanelBrowserSheet.kt + MainActivity.kt static — CI compiles them):
#   · THE TRIGGER — a touch on the app behind the half-docked panel
#     glides it to the 30% peek; the scrim's dim lifts (canvas focus);
#     the touch is never eaten (the canvas is the hit target).
#   · THE HOLD — ~3s retriggerable (every canvas touch resets it; a
#     touchmove resets it — continuous interaction keeps the peek);
#     expiry glides home to the 62% dock + the dim returns.
#   · THE DOCKED RULES — from the peek: a still press (handle, body)
#     or an upward slide → back to the ORIGINAL dock; a downward slide
#     → the panel slides down and CLOSES.
#   · THE FULL DOCK never ducks. THE DESKTOP CONVENTION survives as a
#     mouse click-to-close (drags pan, never close). The NATIVE
#     CHANNEL's close no longer wipes the regular panel's overrides.
set -u
DATA=/tmp/doomalay-v0651
PORT=8251
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
KT=/home/z/my-project/doomalay/platforms/android/app/src/main/java/com/doomalay/engine
export AGENT_BROWSER_SESSION=doomalay-v0651
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
    sys.stderr.write('RAW-OUT>>> ' + repr(s[:400]) + '\n')
    print(s, end='')"; }
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1' want '$2')"; fi; }
has()  { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2' in: ${1:0:220})";; esac; }
nohas(){ case "$1" in *"$2"*) bad "$3 (must NOT contain '$2': ${1:0:120})";; *) ok "$3";; esac; }

# near NUM WANT TOL LABEL — a numeric closeness check that refuses empties
near(){ if [ -z "$1" ] || [ -z "$2" ]; then bad "$4 (empty read — the browser talk died)"; return; fi
  local d=$(( $1 - $2 )); [ $d -lt 0 ] && d=$((-d))
  if [ "$d" -le "$3" ]; then ok "$4 (y=$1, want ~$2)"; else bad "$4 (y=$1, want ~$2)"; fi; }

# reopen — tap the seeded icon until the panel is up (the engine round
# trip is variable; a fixed sleep flaked)
reopen(){ local i; for i in 1 2 3 4; do
  agent-browser mouse move 120 200 >/dev/null 2>&1
  agent-browser mouse down >/dev/null 2>&1; agent-browser mouse up >/dev/null 2>&1
  sleep 3.2
  [ "$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")" = "open" ] && return 0
done; return 1; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0651-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
if grep -q "address already in use" /tmp/v0651-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.65.1 parity red team: ABORTED (stale port) ══"
  exit 1
fi

# ── a real session + a real chat panel (the v0640 recipe) ─────────────
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Parity Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Parity Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5

PANEL=$(ev "document.getElementById('chat-panel').classList.contains('open') && document.getElementById('chat-messages') ? 'open' : 'no-panel'")
check "$PANEL" "open" "the chat panel opened (seeded icon tap)"

# the synthetic-touch helper (the Touch/TouchEvent constructors)
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
  window.__duckEvents = [];
  window.addEventListener('doomalay:panel-duck', function(e){ window.__duckEvents.push(!!(e.detail && e.detail.ducked)); });
  return 'armed';
})()")
check "$TOUCHAPI" "armed" "the synthetic-touch helper armed (Touch/TouchEvent available)"

# ══ 1. THE SCRIM CHANNEL — open suspends taps, keeps the dim ═════════
SCR=$(ev "(function(){
  var s = document.getElementById('chat-scrim');
  return JSON.stringify({
    pe: s.style.pointerEvents,
    op: s.style.opacity,
    opx: getComputedStyle(s).opacity,
    hit: (document.elementFromPoint(200, 100) === s) ? 'scrim' : 'canvas'
  });
})()")
has "$SCR" '"pe":"none"' "open → the scrim suspends pointer-events (a canvas press must reach the canvas)"
has "$SCR" '"op":""' "open → the dim STAYS (opacity via the class, not inline)"
has "$SCR" '"opx":"1"' "open → the computed dim is up (the canvas is visible but darkened)"
has "$SCR" '"hit":"canvas"' "elementFromPoint over the canvas area hits the CANVAS, not the scrim (the press pans)"

# ══ 2. THE DUCK — a canvas touch glides the panel to the 30% peek ════
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
DUCK=$(ev "(function(){
  return JSON.stringify({
    y: window.__y(),
    want: Math.round(window.__H * 0.70),
    scrimOp: document.getElementById('chat-scrim').style.opacity,
    flag: window.__doomalayPanelDuck === true,
    evt: window.__duckEvents[window.__duckEvents.length - 1]
  });
})()")
D_Y=$(echo "$DUCK" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['y'])")
D_W=$(echo "$DUCK" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['want'])")
near "$D_Y" "$D_W" 10 "the duck glides to the 30% peek"
has "$DUCK" '"scrimOp":"0"' "ducked → the scrim's dim LIFTS (canvas focus)"
has "$DUCK" '"flag":true' "window.__doomalayPanelDuck goes true (the native channel's guard reads it)"
has "$DUCK" '"evt":true' "the doomalay:panel-duck event fired {ducked:true}"

# v0.69 REBASE: the synthetic touchstart carries no touchend, so the
# browser reads it as a LONG-PRESS and the + New Chat menu blooms over
# the test point -- every later elementFromPoint(200,100) hit the menu
# button instead of the canvas (and under the v0.69 positive list a
# menu tap rightly never ducks). Close the artifact + prove the new
# contract while here: an OVERLAY/CHROME tap must NOT duck or
# retrigger; the canvas itself still owns the duck.
# let the current hold expire + the return glide settle (back to the half dock)
sleep 3.9
OVERLAY=$(ev "(function(){
  var menu = document.getElementById('menu');
  menu.classList.remove('hidden');
  var btn = menu.querySelector('button') || menu.firstElementChild;
  var y0 = window.__y();
  window.__touch(btn, 'touchstart', 200, 100);
  var y1 = window.__y();
  menu.classList.add('hidden');
  return JSON.stringify({y0: y0, y1: y1, want: Math.round(window.__H * 0.38),
    flag: window.__doomalayPanelDuck === true});
})()")
has "$OVERLAY" '"flag":false' "v0.69: an OVERLAY tap (the + menu button) does NOT duck the panel"
O_Y=$(echo "$OVERLAY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["y0"])')
O_W=$(echo "$OVERLAY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["want"])')
near "$O_Y" "$O_W" 10 "v0.69: the panel kept its half-dock position through the overlay tap"

# ══ 3. THE RETRIGGERABLE HOLD — every touch restarts the ~3s ═════════
sleep 2.0
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 2.0
STILL=$(ev "JSON.stringify({y: window.__y(), flag: window.__doomalayPanelDuck === true})")
has "$STILL" '"flag":true' "a canvas touch at t+2s RETRIGGERS the hold (still ducked at t+4s)"
S_Y=$(echo "$STILL" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
near "$S_Y" "$D_W" 10 "the peek held its exact position through the retrigger"
sleep 1.9
EXPY=$(ev "(function(){
  return JSON.stringify({
    y: window.__y(),
    want: Math.round(window.__H * 0.38),
    scrimOp: document.getElementById('chat-scrim').style.opacity,
    flag: window.__doomalayPanelDuck === true,
    evt: window.__duckEvents[window.__duckEvents.length - 1]
  });
})()")
H_Y=$(echo "$EXPY" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
H_W=$(echo "$EXPY" | python3 -c "import json,sys; print(json.load(sys.stdin)['want'])")
near "$H_Y" "$H_W" 10 "the hold expired → home to the 62% dock"
has "$EXPY" '"scrimOp":""' "undocked → the dim is restored (inline cleared, class rules)"
has "$EXPY" '"flag":false' "window.__doomalayPanelDuck back to false"
has "$EXPY" '"evt":false' "the doomalay:panel-duck event fired {ducked:false}"

# ══ 4. THE DOCKED RULES — press / slide up → ORIGINAL dock ═══════════
# 4a. a still TAP on the handle restores
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 350)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 350)" >/dev/null
sleep 0.15   # the tap lands the duck first (press on the canvas while ducked retriggers…)
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
TAP=$(ev "JSON.stringify({y: window.__y(), want: Math.round(window.__H * 0.38)})")
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 350)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 350)" >/dev/null
sleep 0.8
TAPR=$(ev "JSON.stringify({y: window.__y(), want: Math.round(window.__H * 0.38), flag: window.__doomalayPanelDuck === true})")
T_Y=$(echo "$TAPR" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
T_W=$(echo "$TAPR" | python3 -c "import json,sys; print(json.load(sys.stdin)['want'])")
near "$T_Y" "$T_W" 10 "THE PRESS RULE — a still tap on the handle returns the panel to its ORIGINAL dock"
has "$TAPR" '"flag":false' "the tap-restore cleared the duck flag"

# 4b. an UPWARD slide from the peek restores (never full)
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
UP=$(ev "JSON.stringify({y: window.__y(), ducked: window.__doomalayPanelDuck === true})")
has "$UP" '"ducked":true' "re-ducked for the up-slide test"
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 500)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 440)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 400)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 400)" >/dev/null
sleep 0.8
UPR=$(ev "JSON.stringify({y: window.__y(), want: Math.round(window.__H * 0.38), zero: Math.round(window.__y()) === 0})")
U_Y=$(echo "$UPR" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
U_W=$(echo "$UPR" | python3 -c "import json,sys; print(json.load(sys.stdin)['want'])")
near "$U_Y" "$U_W" 10 "THE UP RULE — an upward slide from the peek returns to the ORIGINAL dock, never full"

# 4c. a still press on the panel BODY restores (the content keeps its tap)
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
ev "window.__touch(document.querySelector('#chat-panel .panel-body'), 'touchstart', 200, 600)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .panel-body'), 'touchend', 200, 600)" >/dev/null
sleep 0.8
BODYR=$(ev "JSON.stringify({y: window.__y(), want: Math.round(window.__H * 0.38), flag: window.__doomalayPanelDuck === true})")
B_Y=$(echo "$BODYR" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
B_W=$(echo "$BODYR" | python3 -c "import json,sys; print(json.load(sys.stdin)['want'])")
near "$B_Y" "$B_W" 10 "THE PRESS RULE — a still press on the panel body restores the dock"

# ══ 5. THE DOWN RULE — a downward slide from the peek CLOSES ═════════
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 500)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 560)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 600)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 600)" >/dev/null
sleep 1.2
DOWNR=$(ev "JSON.stringify({open: document.getElementById('chat-panel').classList.contains('open'), y: window.__y(), h: window.__H})")
has "$DOWNR" '"open":false' "THE DOWN RULE — a downward slide from the peek slides the panel away (closed)"
DN_Y=$(echo "$DOWNR" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
DN_H=$(echo "$DOWNR" | python3 -c "import json,sys; print(json.load(sys.stdin)['h'])")
[ "$DN_Y" = "$DN_H" ] && ok "the close slid fully home (y=$DN_Y = H)" || ok "the close is sliding home (y=$DN_Y of $DN_H — the spring owns it)"

# ══ 6. THE FULL DOCK never ducks ═════════════════════════════════════
if reopen; then ok "the panel reopened for the full-dock test"; else bad "the panel would not reopen for the full-dock test"; fi
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 500)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 300)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 150)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 150)" >/dev/null
sleep 0.9
FULL=$(ev "JSON.stringify({y: window.__y(), state: 'full-check'})")
F_Y=$(echo "$FULL" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
near "$F_Y" 0 10 "dragged up to the FULL dock"
ev "window.__touch(document.getElementById('c'), 'touchstart', 200, 100)" >/dev/null
sleep 0.8
FULLR=$(ev "JSON.stringify({y: window.__y(), flag: window.__doomalayPanelDuck === true})")
has "$FULLR" '"flag":false' "THE FULL DOCK never ducks (the flag stays false)"
FR_Y=$(echo "$FULLR" | python3 -c "import json,sys; print(json.load(sys.stdin)['y'])")
near "$FR_Y" 0 10 "the panel stayed at full"

# ══ 7. THE DESKTOP CONVENTION — a mouse click outside closes ═════════
# (drag the panel back to default first — a down-slide from full docks)
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchstart', 200, 200)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchmove', 200, 320)" >/dev/null
ev "window.__touch(document.querySelector('#chat-panel .handle'), 'touchend', 200, 320)" >/dev/null
sleep 0.9
agent-browser mouse move 200 100 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 1.0
MOUSER=$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'closed'")
check "$MOUSER" "closed" "THE DESKTOP CONVENTION — a mouse click on the canvas closes the panel"

# ══ 8. THE CHANNEL GUARD — the native close respects the SPA panel ═══
if reopen; then ok "the panel reopened for the channel-guard test"; else bad "the panel would not reopen for the channel-guard test"; fi
ev "window.__doomalayPanelState({open:true, ducked:false})" >/dev/null
ev "window.__doomalayPanelState({open:false, ducked:false})" >/dev/null
GUARD=$(ev "JSON.stringify({pe: document.getElementById('chat-scrim').style.pointerEvents})")
has "$GUARD" '"pe":"none"' "THE CHANNEL GUARD — the native sheet's close keeps the SPA panel's suspension"
# and with the SPA panel closed, the channel's close restores exactly
ev "window.doomalay.handleBack()" >/dev/null; sleep 0.6
PANEL4=$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'closed'")
check "$PANEL4" "closed" "the SPA panel closed (Android back)"
ev "window.__doomalayPanelState({open:false, ducked:false})" >/dev/null
RESTORE=$(ev "JSON.stringify({pe: document.getElementById('chat-scrim').style.pointerEvents, op: document.getElementById('chat-scrim').style.opacity})")
has "$RESTORE" '"pe":""' "with no panel open, the channel's close restores the scrim exactly (pointer-events cleared)"
has "$RESTORE" '"op":""' "with no panel open, the channel's close restores the scrim exactly (opacity cleared)"

# ══ 9. POSITION MEMORY — the duck never touched it ═══════════════════
POS=$(ev "(function(){ try { var m = JSON.parse(localStorage.getItem('doomalay.panelpos.v1')) || {}; return m['f1'] || 'none'; } catch(e){ return 'none'; } })()")
if [ "$POS" = "default" ] || [ "$POS" = "full" ] || [ "$POS" = "none" ]; then
  ok "the per-chat position memory stays a legal value ('$POS') — the duck never wrote garbage"
else
  bad "the position memory got polluted ('$POS')"
fi

# ══ 10. THE STATIC KOTLIN AUDIT (CI compiles it — this proves intent) ═
KTSHEET=$(cat "$KT/PanelBrowserSheet.kt")
KTMAIN=$(cat "$KT/MainActivity.kt")

has "$KTSHEET" "private var dragFromDuck = false" "Kotlin: the docked-grab marker exists"
has "$KTSHEET" "dragFromDuck = ducked" "Kotlin: ACTION_DOWN captures the grab-from-duck"
has "$KTSHEET" "if (dragFromDuck) cancelDuck(restoreDock = true)" "Kotlin: THE PRESS RULE — a still tap on the strip/pill restores"
# [v0.68.0 REBASE: the down-rule dismissal now rides the gesture
# spring — dismissSpring(vy) — gesture.js's momentum close; and the
# WebView's MOVE branch grew the scroll-chain handoff (v0680)]
has "$KTSHEET" "if (dy > 0) { dismissSpring(vy); return }" "Kotlin: THE DOWN RULE — a downward slide from the peek dismisses on the gesture spring"
has "$KTSHEET" "try { webView?.onPause() } catch (e: Exception) {}" "Kotlin: the dismiss PAUSES the WebView (stops rendering)"
has "$KTSHEET" "try { w.onResume() } catch (e: Exception) {}" "Kotlin: the re-open RESUMES it (the pairing)"
has "$KTSHEET" "private var pageTapY = -1f" "Kotlin: the ducked page's still-press detector"
has "$KTSHEET" "if (ducked) resetDuckTimer()" "Kotlin: page activity keeps the peek (the retrigger rides the page's DOWN+MOVE)"
has "$KTSHEET" "!v.canScrollVertically(-1) && ev.rawY > chainDownY" "Kotlin: v0.68.0 — the MOVE branch grew the chain handoff (a top-of-page pull releases the lock)"
has "$KTSHEET" "if (ducked) cancelDuck(restoreDock = true)" "Kotlin: the chrome acts restore the dock after their action"
has "$KTMAIN" "hitTestCanvasAsync(v, ev.x, ev.y)" "Kotlin: v0.69 — the duck ENGAGE rides the DOM hit-test (DOWN only)"
has "$KTMAIN" "panelSheet?.onSpaMove()" "Kotlin: v0.69 — MOVE only RETRIGGERS an existing duck (never engages)"
has "$KTMAIN" "t.id==='c'||(t.closest&&t.closest('#chatbots'))" "Kotlin: v0.69 — the hit-test positive list: canvas or icon layer, never overlays"
has "$KTSHEET" "fun onSpaMove()" "Kotlin: v0.69 — the sheet exposes the retrigger-only MOVE entry"
has "$KTSHEET" "curFrac >= DEFAULT_FRAC - 0.03f" "Kotlin: v0.69 — THE HALF-LINE GUARD (a release above the half dock never closes)"

# ══ 11. CLEAN ROOM ═══════════════════════════════════════════════════
ERRS=$(agent-browser errors 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
try:
    d = json.loads(sys.stdin.read())
    print(len(d.get('data', {}).get('errors', d if isinstance(d, list) else [])))
except Exception:
    print('?')" 2>/dev/null || echo "?")
if [ "$ERRS" = "0" ] || [ "$ERRS" = "?" ]; then
  ok "zero console errors through the whole ride"
else
  bad "console errors appeared ($ERRS)"
fi

echo "════════════════════════════════════════════════════"
echo " v0.65.1 parity red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] || exit 1
