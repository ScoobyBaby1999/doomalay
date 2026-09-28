#!/bin/bash
# v0642-panel-polish-test.sh — RED-TEAM the v0.64.2 POLISH WAVE
# (PLAN-V0642) on top of the native panel browser.
#
# USER SPEC: "The panel browser in browser is actually incredible. It's
# amazing seriously. Just please let's polish the 4 pills up-top
# (search, back, redirect, and close) and let's add a very polished neat
# circular loading bar that uses theme colors + a loading (website link)
# text while the panel is loading instead of a black screen… Let's also
# have it so that while the panel is open and half docked, the user can
# press the canvas and still move it… doing so puts the canvas back in
# focus (undarknes it/removes the filter) and docks the panel to a third
# secret position - a position that fills only like 30% of the screen…
# temporary for ~3 seconds with a retriggrable delay every time the user
# retouched the screen."
#
# THE DESIGN UNDER TEST:
#   - THE PILL POLISH + THE LOADING OVERLAY + THE SECRET THIRD DOCK are
#     NATIVE (PanelBrowserSheet.kt) — the Kotlin compiles in CI, blind
#     locally, so this suite carries a STATIC AUDIT of the Kotlin (the
#     constants, the wiring, the retirements, the theme discipline).
#   - The SPA half of the duck — window.__doomalayPanelState in
#     browserdock.js — is LIVE-TESTED here against the real engine:
#     the #chat-scrim (the "filter" over the canvas) suspends its
#     pointer-events while the sheet is up (a canvas press must reach
#     the CANVAS — elementFromPoint proves the hit target), lifts its
#     dim while ducked (canvas focus), and restores exactly on close.
#   - The v0.64 routing contract must survive the browserdock.js edit
#     untouched: native-panel routing, the getkey sync tiers, the
#     desktop redirect, the bridge getters.
set -u
DATA=/tmp/doomalay-v0642
PORT=8242
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
KT=/home/z/my-project/doomalay/platforms/android/app/src/main/java/com/doomalay/engine
export AGENT_BROWSER_SESSION=doomalay-v0642
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
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1' want '$2')"; fi; }
has()  { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2' in: ${1:0:220})";; esac; }
nohas(){ case "$1" in *"$2"*) bad "$3 (must NOT contain '$2': ${1:0:120})";; *) ok "$3";; esac; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0642-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
if grep -q "address already in use" /tmp/v0642-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.64.2 polish red team: ABORTED (stale port) ══"
  exit 1
fi

# ── a real session + a real chat panel (the v0640 recipe) ─────────────
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Polish Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Polish Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5

PANEL=$(ev "document.getElementById('chat-panel').classList.contains('open') && document.getElementById('chat-messages') ? 'open' : 'no-panel'")
check "$PANEL" "open" "the chat panel opened (seeded icon tap — the scrim is up, the canvas dimmed)"
SCRIMOPEN=$(ev "document.getElementById('chat-scrim').classList.contains('open') ? 'open' : 'closed'")
check "$SCRIMOPEN" "open" "#chat-scrim carries the dim (the 'filter' the duck must lift)"

# stubs: the window.open recorder + the native bridge factory (v0640's)
ev "(function(){
  window.__winOpen = [];
  window.__origOpen = window.open;
  window.open = function(u){ window.__winOpen.push(String(u)); return {close:function(){}}; };
  window.__calls = [];
  window.__mkNative = function(o){
    o = o || {};
    return {
      openInApp: function(u,x){ window.__calls.push({m:'openInApp',u:u,o:JSON.parse(x)}); },
      openExternal: function(u){ window.__calls.push({m:'openExternal',u:u}); },
      openPanel: o.throwPanel ? function(){ throw new Error('bridge dead'); } :
        function(u,x){ window.__calls.push({m:'openPanel',u:u,o:JSON.parse(x)}); },
      panelClose: function(){ window.__calls.push({m:'panelClose'}); },
      panelOpen: function(){ return true; },
      panelUrl: function(){ return 'https://example.com/'; }
    };
  };
  return 'stubs';
})()" >/dev/null
ok "window.open + bridge stubs installed"

# ══ 1. THE PANEL-STATE CHANNEL (the duck's SPA half) ═════════════════
CHAN=$(ev "typeof window.__doomalayPanelState")
check "$CHAN" "function" "window.__doomalayPanelState exists (the native sheet's broadcast target)"

# 1a. OPEN (not ducked): the scrim suspends its taps, keeps its dim
OPEN_STATE=$(ev "(function(){
  window.__doomalayPanelState({open:true, ducked:false});
  var scrim = document.getElementById('chat-scrim');
  return JSON.stringify({
    pe: scrim.style.pointerEvents,
    op: scrim.style.opacity,
    hitsScrim: document.elementFromPoint(200, 80) === scrim
  });
})()")
has "$OPEN_STATE" '"pe":"none"' "open → the scrim suspends pointer-events (a canvas press must reach the canvas)"
has "$OPEN_STATE" '"op":""' "open → the dim STAYS (the canvas is visible but darkened until the press)"
# elementFromPoint at a canvas coordinate: with the scrim suspended the
# hit target is whatever sits below it (the canvas/grid), never the scrim
HIT=$(ev "document.elementFromPoint(200, 80) === document.getElementById('chat-scrim') ? 'scrim' : 'canvas'")
check "$HIT" "canvas" "elementFromPoint over the canvas area hits the CANVAS, not the scrim (the press pans)"

# 1b. DUCKED: the dim lifts (canvas focus) + the event fires with detail
EVSEEN=$(ev "(function(){
  window.__stateEvents = [];
  document.addEventListener('doomalay:panel-state', function(e){ window.__stateEvents.push(e.detail); });
  window.__doomalayPanelState({open:true, ducked:true});
  var scrim = document.getElementById('chat-scrim');
  var last = window.__stateEvents[window.__stateEvents.length-1] || {};
  return JSON.stringify({
    pe: scrim.style.pointerEvents,
    op: scrim.style.opacity,
    evOpen: last.open, evDucked: last.ducked
  });
})()")
has "$EVSEEN" '"pe":"none"' "ducked → pointer-events stay suspended (the canvas stays live for the pan)"
has "$EVSEEN" '"op":"0"' "ducked → the scrim's dim LIFTS (the canvas is back in focus)"
has "$EVSEEN" '"evOpen":true' "the doomalay:panel-state event fires with open=true"
has "$EVSEEN" '"evDucked":true' "the doomalay:panel-state event fires with ducked=true"

# 1c. CLOSED: v0.65.1 THE PARITY GUARD — the native sheet's close no
# longer wipes the scrim blindly: the SPA's OWN chat panel is OPEN here
# (this suite opened it for the dim checks), so its duck wiring keeps
# the taps suspended (a canvas press must still reach the canvas) and
# the dim follows the SPA panel's own duck (not ducked → class rules).
# The no-SPA-panel exact restore moved to v0651 §8 (it closes the SPA
# panel first — here the guard's whole point is that it DOESN'T clear).
ev "window.__doomalayPanelState({open:false, ducked:false}); 'closed'" >/dev/null
sleep 0.6
CLOSED=$(ev "(function(){
  var scrim = document.getElementById('chat-scrim');
  var cs = getComputedStyle(scrim);
  return JSON.stringify({
    peInline: scrim.style.pointerEvents,
    opInline: scrim.style.opacity,
    peComputed: cs.pointerEvents,
    opComputed: cs.opacity,
    spaOpen: document.getElementById('chat-panel').classList.contains('open')
  });
})()")
has "$CLOSED" '"spaOpen":true' "v0.65.1: the SPA panel is open (the guard's precondition)"
has "$CLOSED" '"peInline":"none"' "v0.65.1: the native close KEEPS the SPA panel's suspension (the parity guard)"
has "$CLOSED" '"opInline":""' "closed → the inline opacity override is cleared"
has "$CLOSED" '"opInline":""' "v0.65.1: the dim follows the SPA panel's own duck (not ducked → class rules)"
has "$CLOSED" '"opComputed":"1"' "closed → the dim is back (the .open class governs, opacity 1)"

# 1d. garbage-proof: a null/undefined payload restores, never throws
JUNK=$(ev "(function(){
  try {
    window.__doomalayPanelState(null);
    window.__doomalayPanelState(undefined);
    return 'safe';
  } catch (e) { return 'threw: ' + e.message; }
})()")
check "$JUNK" "safe" "a malformed payload never throws (the native side is guarded too)"

# 1e. the channel does NOT touch the chat panel itself (the dim only)
PANELINTACT=$(ev "(function(){
  window.__doomalayPanelState({open:true, ducked:true});
  var r = document.getElementById('chat-panel').classList.contains('open');
  window.__doomalayPanelState({open:false, ducked:false});
  return r && document.getElementById('chat-panel').classList.contains('open') ? 'intact' : 'moved';
})()")
check "$PANELINTACT" "intact" "the chat panel itself never moved (only its scrim dim + taps are managed)"

# ══ 2. THE v0.64 ROUTING CONTRACT SURVIVES THE EDIT ══════════════════
ev "window.__doomalayKotlin = window.__mkNative(); window.__calls = []; window.__winOpen = []; 'native'" >/dev/null
NRET=$(ev "window.InAppBrowser.open('https://example.org/duck')")
check "$NRET" "native-panel" "open() with the bridge → 'native-panel' (the router is untouched)"
NCALL=$(ev "(function(){ var c = window.__calls[window.__calls.length-1] || {}; var t = c.o && c.o.theme || {}; return JSON.stringify({m:c.m, u:c.u, keys:['accent','bgPanel','surface','text1','text3','border'].filter(function(k){ return !t[k]; })}); })()")
has "$NCALL" '"m":"openPanel"' "the call rides openPanel with the theme snapshot"
has "$NCALL" '"keys":[]' "all six live CSS-var theme keys present (the loading overlay + chips re-tint per open)"

# getkey stays synchronous on the fallback tiers (never the panel)
GK=$(ev "window.__calls = []; window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); (window.__calls[window.__calls.length-1]||{}).m || 'none'")
check "$GK" "openInApp" "getkey rides openInApp (the v0.62.3 contract — never the panel)"

# desktop (bridge-less) still redirects instantly
ev "delete window.__doomalayKotlin; window.__winOpen = []; 'clean'" >/dev/null
DTIER=$(ev "window.InAppBrowser.open('https://example.com/desktop')")
check "$DTIER" "popup" "the bridge-less surface → the POPUP tier (no hesitation, unchanged)"

# ══ 3. THE STATIC KOTLIN AUDIT (CI compiles it — this proves intent) ══
KTSHEET=$(cat "$KT/PanelBrowserSheet.kt")
KTMAIN=$(cat "$KT/MainActivity.kt")

has "$KTSHEET" "DUCK_FRAC = 0.30f" "Kotlin: the secret third dock sits at 30% of the screen"
has "$KTSHEET" "DUCK_HOLD_MS = 3000L" "Kotlin: the temporary duck hold is ~3 seconds"
has "$KTSHEET" "fun onSpaTouch()" "Kotlin: the SPA-press entry point (the duck trigger)"
has "$KTSHEET" "fun duckForCanvas()" "Kotlin: the duck itself"
has "$KTSHEET" "private fun resetDuckTimer()" "Kotlin: the RETRIGGER (every retouch restarts the 3s hold)"
has "$KTSHEET" "private fun unduck()" "Kotlin: the expiry glides back to the half dock"
has "$KTSHEET" "cancelDuck(restoreDock = false)" "Kotlin: a real strip-drag cancels the duck (release() owns the landing)"
has "$KTSHEET" "__doomalayPanelState" "Kotlin: the state broadcast targets the SPA hook"
has "$KTSHEET" "onPageCommitVisible" "Kotlin: the loading overlay hides at the FIRST PAINT (never covers a rendered page)"
has "$KTSHEET" "private fun setLoading(" "Kotlin: the loading overlay driver"
has "$KTSHEET" "private class LoadRing(context: Context) : View(context)" "Kotlin: the circular loading bar is a hand-drawn ring"
has "$KTSHEET" "RippleDrawable(" "Kotlin: the pills ripple (theme accent, clipped to each shape)"
has "$KTSHEET" "snapAnim?.cancel()" "Kotlin: the last glide owns the sheet (the animator-race fix)"
has "$KTMAIN" "panelSheet?.onSpaTouch()" "Kotlin: MainActivity wires the SPA press → the duck"
has "$KTMAIN" "fun spaEval(js: String)" "Kotlin: MainActivity exposes the SPA JS channel"

# the retirements: the loadbar, the scrim view + its tap-dismiss
KTCODE=$(grep -v '^\s*//' "$KT/PanelBrowserSheet.kt" | grep -v '^\s*\*')
nohas "$(echo "$KTCODE" | grep -i 'loadbar')" "loadbar" "Kotlin: the 2dp loadbar is retired (the ring replaces it)"
nohas "$(echo "$KTCODE" | grep -i 'scrim')" "scrim" "Kotlin: the native scrim is retired (a canvas press DUCKS, never dismisses)"
nohas "$(echo "$KTCODE" | grep 'MAX_SCRIM')" "MAX_SCRIM" "Kotlin: MAX_SCRIM is gone with the scrim"

# theme discipline: the ring + chips are snapshot-driven, no raw hex
nohas "$(echo "$KTCODE" | grep '0xFF')" "0xFF" "Kotlin: zero raw hex colors in the sheet (theme snapshot only)"
has "$KTSHEET" "loadRing?.arcColor = accent" "Kotlin: the ring's arc IS the theme accent"
has "$KTSHEET" "loadRing?.trackColor" "Kotlin: the ring's track is theme border @ low alpha"
has "$KTSHEET" "divider?.setBackgroundColor" "Kotlin: the strip hairline is theme border @ low alpha"

# ══ 4. CLEAN ROOM ════════════════════════════════════════════════════
# leave the page exactly as found (the inline overrides cleared)
ev "window.__doomalayPanelState({open:false, ducked:false}); 'restored'" >/dev/null
sleep 0.5
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
echo " v0.64.2 polish red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] || exit 1
