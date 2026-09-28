#!/bin/bash
# v0680-browser-bar-test.sh — RED-TEAM the v0.68.0 BROWSER BAR WAVE
# (PLAN-V0680): the BIB wears the panel's own dash, the BIB's scrolling
# IS the panel's scrolling, the capsule shrinks 15%, and the bar
# searches like any browser.
#
# USER SPEC: "Let's make the BIB (browser in browser) and panel have the
# same dash length, let's change the BIB to use the panels dash and
# length. (Dash does not use theme colors I believe) Let's also make the
# BIB's scrolling (how it detects weather to open close, ext, resemble
# the panels functionality and mimic it if not use it outright) let's
# also make the BIB search bar (the one with the address of the site)
# 15% less wide and high or 15% smaller in size. And if possible and
# does not require a lot of rework, let's add search functionality
# (browser either Google or something free like brave or duckduckgo).
# So it works like any browser lol."
#
# THE DESIGN UNDER TEST (ALL NATIVE — PanelBrowserSheet.kt; the web is
# the UNTOUCHED reference, CI compiles the Kotlin):
#   1. THE DASH — index.html's .handle-bar verbatim: 36×4dp in the
#      theme BORDER (var(--border) parity), radius 2. Was 40dp @
#      text1@30%.
#   2. THE SCROLLING — gesture.js mimicked outright: the shared drag
#      machine (slop-cross rebase, EMA 0.7/0.3 over 4ms-floored
#      samples, the 0.8/frame render chase, the 0.4px snap, rubber-band
#      ×0.25), THE BODY CHAIN (DragBodyLayout hijacks a top-of-page
#      pull after 24dp, −6dp rebase, the WebView's lock release + clean
#      CANCEL, overscroll glow never), THE SPRINGS (settle 170/×1.02
#      critically damped, quarter-velocity seed, |x|<1.5 && |v|<40 →
#      rest; dismiss 440 at max(vy·1000·0.5, 900)), and THE CURVE
#      (170ms cubic-bezier(0.32,0.72,0,1) rise/close).
#   3. THE CAPSULE — 15% smaller: 30→25.5dp tall (dipF), the text cap
#      153→130dp, the paddings tightened, ripple circle 12.75dp (Float
#      radii now); the 18dp ↻ glyph and its hitbox survive.
#   4. THE SEARCH — the capsule grows an EditText omnibox (textUri, GO,
#      no fullscreen): tap → edit at FULL with the URL pre-selected,
#      GO → resolveEntry (explicit scheme passes · a spaceless dotted/
#      coloned entry → https:// · anything else → DuckDuckGo), back /
#      focus loss → cancel back to the dock the user came from,
#      long-press → copyLink reborn Android-style.
set -u
DATA=/tmp/doomalay-v0680
PORT=8260
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
KT=/home/z/my-project/doomalay/platforms/android/app/src/main/java/com/doomalay/engine
WEB=/home/z/my-project/doomalay/engine/internal/server/web
export AGENT_BROWSER_SESSION=doomalay-v0680
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

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0680-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
if grep -q "address already in use" /tmp/v0680-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.68.0 browser bar red team: ABORTED (stale port) ══"
  exit 1
fi

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null

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

# ══ 1. THE ROUTING CONTRACT SURVIVED THE WAVE (spot checks) ═════════
ev "window.__doomalayKotlin = window.__mkNative(); 'native bridge set'" >/dev/null
NCALL=$(ev "window.__calls = []; window.InAppBrowser.open('https://example.com/page'); JSON.stringify(window.__calls[0] || {})")
has "$NCALL" '"m":"openPanel"' "a plain link still rides openPanel (the native dock)"

GK=$(ev "window.__calls = []; window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); (window.__calls[window.__calls.length-1]||{}).m || 'none'")
check "$GK" "openPanel" "getkey rides the panel (the v0.67.3 BIB mandate — a real top-level WebView)"

HOSTILE=$(ev "window.__calls = []; window.InAppBrowser.open('https://example.com/x', {hostile:true}); (window.__calls[window.__calls.length-1]||{}).m || 'none'")
check "$HOSTILE" "openPanel" "hostile rides the panel too (the v0.67.3 mandate — hostile is metadata now)"

ev "delete window.__doomalayKotlin; 'bridgeless'" >/dev/null
HXT=$(ev "window.__winOpen = []; window.InAppBrowser.open('https://example.com/hx', {hostile:true})")
check "$HXT" "tab" "bridge-less hostile hands off EXTERNALLY (the tab — hostile can't ride a WebView on non-BIB builds)"
DTIER=$(ev "window.InAppBrowser.open('https://example.com/desktop')")
check "$DTIER" "popup" "the bridge-less surface still redirects to the POPUP tier instantly"
ev "window.__doomalayKotlin = window.__mkNative(); 'bridge back'" >/dev/null

# ══ 2. THE STATIC KOTLIN AUDIT (CI compiles it — this proves intent) ══
KTSHEET=$(cat "$KT/PanelBrowserSheet.kt")

# ── ask 1 — THE DASH: the panel's own, verbatim ──────────────────────
has "$KTSHEET" "LinearLayout.LayoutParams(dip(36), dip(4))" "Kotlin: the dash is 36×4dp — index.html's .handle-bar length"
has "$KTSHEET" "setColor(border)" "Kotlin: the dash wears the theme BORDER (var(--border) parity — the neutral grab hint)"
has "$KTSHEET" "cornerRadius = dip(2).toFloat()" "Kotlin: the dash's 2dp radius (the .handle-bar rounding)"
nohas "$KTSHEET" "0x4D000000" "Kotlin: the old text1@30% dash alpha is RETIRED"

# ── ask 2a — THE BODY CHAIN: gesture.js's scroll chain, native ───────
has "$KTSHEET" "BODY_SLOP_DP = 24" "Kotlin: the chain slop is 24dp (gesture.js BODY_SLOP)"
has "$KTSHEET" "CHAIN_REBASE_DP = 6" "Kotlin: the hijack rebase is 6dp (gesture.js y0 = y − 6)"
has "$KTSHEET" "private inner class DragBodyLayout(context: Context) : FrameLayout(context)" "Kotlin: the body IS a DragBodyLayout now"
has "$KTSHEET" "override fun onInterceptTouchEvent(ev: MotionEvent): Boolean" "Kotlin: the body intercepts the stream (the WebView gets a clean CANCEL)"
has "$KTSHEET" "dragActivate(ev.rawY - dip(CHAIN_REBASE_DP))" "Kotlin: the hijack hands the finger to the SHARED drag machine, −6dp rebased"
has "$KTSHEET" "requestDisallowInterceptTouchEvent(false)" "Kotlin: the WebView releases the parent lock on a qualifying pull"
has "$KTSHEET" "!v.canScrollVertically(-1) && ev.rawY > chainDownY" "Kotlin: the release fires only at the page's very top, pulling DOWN"
has "$KTSHEET" "ev.pointerCount != 1 || chainMulti || dragging" "Kotlin: the single-driver rule (no chain mid-drag, no second finger)"
has "$KTSHEET" "overScrollMode = View.OVER_SCROLL_NEVER" "Kotlin: the overscroll glow never fights the chain"
has "$KTSHEET" "MotionEvent.ACTION_MOVE -> if (dragging) dragFollow(ev.rawY)" "Kotlin: the body drives the same dragFollow the strip uses"
has "$KTSHEET" "MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragging) dragEnd()" "Kotlin: the body releases through the same dragEnd (decide())"

# ── ask 2b — THE DRAG MACHINE: gesture.js's physics, constant for constant ──
has "$KTSHEET" "dragStartY = y" "Kotlin: the activation rebase — the CURRENT finger (begin() semantics, no mid-glide jump)"
has "$KTSHEET" "dragStartOffset = curOffset" "Kotlin: the activation freezes the sheet's offset (the grab takes over exactly on-screen)"
has "$KTSHEET" "velY = velY * 0.7f + inst * 0.3f" "Kotlin: the EMA velocity (0.7/0.3)"
has "$KTSHEET" "now - lastMoveT > 4" "Kotlin: the 4ms sub-frame velocity floor (the rebase-fling killer)"
has "$KTSHEET" "dragNowY += (dragTargetY - dragNowY) * 0.8f" "Kotlin: the 0.8/frame render chase (gesture.js dragRender jitter smoothing)"
has "$KTSHEET" "Math.abs(dragTargetY - dragNowY) < 0.4f" "Kotlin: the 0.4px snap-to-finger"
has "$KTSHEET" "raw < 0f -> raw * 0.25f" "Kotlin: the rubber-band above full (×0.25)"
has "$KTSHEET" "raw > fullH -> fullH.toFloat()" "Kotlin: never past closed"

# ── ask 2c — THE SPRINGS + THE CURVE ─────────────────────────────────
has "$KTSHEET" "SETTLE_STIFF = 170f" "Kotlin: the settle spring's stiffness 170 (gesture.js)"
has "$KTSHEET" "SETTLE_DAMP = 1.02f" "Kotlin: the settle spring's damping ×1.02 (a hair over critical)"
has "$KTSHEET" "DISMISS_STIFF = 440f" "Kotlin: the dismiss spring's stiffness 440 (the snappier close)"
has "$KTSHEET" "Math.abs(x) < 1.5f && Math.abs(v) < 40f" "Kotlin: the settle rests at |x|<1.5 && |v|<40 → the exact landing"
has "$KTSHEET" "vy * 1000f * 0.25f" "Kotlin: the release settle is quarter-velocity seeded"
has "$KTSHEET" "if (vy * 1000f * 0.5f > 900f) vy * 1000f * 0.5f else 900f" "Kotlin: the dismiss never falls below 900px/s (the momentum floor)"
has "$KTSHEET" "RISE_MS = 170L" "Kotlin: the 170ms rise (gesture.js RISE_MS)"
has "$KTSHEET" "CLOSE_MS = 170L" "Kotlin: the 170ms close (the same curve)"
has "$KTSHEET" "PathInterpolator(0.32f, 0.72f, 0f, 1f)" "Kotlin: cubic-bezier(0.32,0.72,0,1) — gesture.js's exact rise"
has "$KTSHEET" "a.interpolator = easeCurve" "Kotlin: the glide wears the curve"
nohas "$KTSHEET" "DecelerateInterpolator" "Kotlin: the old Decelerate(1.2) glide is RETIRED (the spring/curve own every motion)"
has "$KTSHEET" "private interface Glide { fun cancel() }" "Kotlin: one glide-owner slot (timed curves and springs, one cancel rule)"

# ── ask 3 — THE CAPSULE: 15% smaller, the glyph survives ─────────────
has "$KTSHEET" "addView(refreshIcon, LinearLayout.LayoutParams(dipF(25.5f), dipF(25.5f)))" "Kotlin: the capsule stands 25.5dp tall (30 × 0.85)"
has "$KTSHEET" "setPadding(dipF(3.75f), dipF(3.75f), dipF(3.75f), dipF(3.75f))" "Kotlin: the ↻ glyph STAYS 18dp (3.75dp padding — the hitbox survives)"
has "$KTSHEET" "maxWidth = dip(130)" "Kotlin: the text cap 153→130dp (× 0.85)"
has "$KTSHEET" "setPadding(dip(4), 0, dip(8), 0)" "Kotlin: the capsule's paddings tightened with the cut"
has "$KTSHEET" "private fun dipF(v: Float): Int" "Kotlin: the float-dp twin (fractional dimensions, exact pixels)"

# ── ask 4 — THE SEARCH: it works like any browser lol ────────────────
has "$KTSHEET" "SEARCH_URL = \"https://duckduckgo.com/?q=\"" "Kotlin: the engine is DuckDuckGo (free, keyless, no tracking)"
has "$KTSHEET" "private fun resolveEntry(entry: String): String" "Kotlin: GO's brain exists"
has "$KTSHEET" "entry.startsWith(\"http://\") || entry.startsWith(\"https://\")" "Kotlin: an explicit scheme passes untouched"
has "$KTSHEET" "return \"https://\" + entry" "Kotlin: a spaceless dotted/coloned entry is an address (https:// prepended)"
has "$KTSHEET" "return SEARCH_URL + android.net.Uri.encode(entry)" "Kotlin: everything else is a question for DuckDuckGo (URL-encoded)"
has "$KTSHEET" "EditorInfo.TYPE_TEXT_VARIATION_URI" "Kotlin: the editor is textUri (the / and .com keys)"
has "$KTSHEET" "EditorInfo.IME_ACTION_GO" "Kotlin: the IME's GO key"
has "$KTSHEET" "EditorInfo.IME_FLAG_NO_FULLSCREEN" "Kotlin: no fullscreen extract — the bar stays in place"
has "$KTSHEET" "private fun enterEdit()" "Kotlin: the bar opens"
has "$KTSHEET" "ed.post { if (editMode) ed.selectAll() }" "Kotlin: the URL arrives pre-selected (Chrome's omnibox)"
has "$KTSHEET" "imm.showSoftInput(ed, 0)" "Kotlin: the IME comes up with the bar"
has "$KTSHEET" "hideSoftInputFromWindow(editor?.windowToken, 0)" "Kotlin: the IME folds with the bar"
has "$KTSHEET" "private fun commitEdit()" "Kotlin: GO commits"
has "$KTSHEET" "private fun exitEdit(restoreDock: Boolean)" "Kotlin: the bar folds (back / focus loss / acts)"
has "$KTSHEET" "editPriorFull" "Kotlin: the cancel returns to the dock the user came from"
has "$KTSHEET" "springTo(offsetFor(editPriorFull), 0f) {}" "Kotlin: the cancel glide is the settle spring"
has "$KTSHEET" "makeDraggable(pillLocal, tap = { enterEdit() }, longPress = { copyLink() })" "Kotlin: tap OPENS the bar, long-press COPIES (reborn Android-style)"
has "$KTSHEET" "ViewConfiguration.getLongPressTimeout()" "Kotlin: the manual long-press rides the system timeout"
has "$KTSHEET" "if (editMode) { exitEdit(restoreDock = true); return true }" "Kotlin: Android back eats the edit first (the keyboard goes, browser behavior)"
has "$KTSHEET" "if (editMode) exitEdit(restoreDock = false)" "Kotlin: the dismiss/acts/fresh-link exit the edit silently"

# ── theme discipline: zero raw hex in the code, the editor tinted ────
KTCODE=$(grep -v '^\s*//' "$KT/PanelBrowserSheet.kt" | grep -v '^\s*\*')
nohas "$(echo "$KTCODE" | grep '0xFF')" "0xFF" "Kotlin: zero raw hex colors (the snapshot drives every tint)"
has "$KTSHEET" "editor?.setTextColor(text3)" "Kotlin: the editor wears the capsule's own text3 (theme-tinted per open)"

# ══ 3. THE WEB REGRESSIONS — the SPA NEVER MOVED (the reference) ═════
INDEX=$(cat "$WEB/index.html")
GEST=$(cat "$WEB/gesture.js")

has "$INDEX" "width: 36px;" "web: index.html's .handle-bar keeps its 36px (the reference the BIB now wears)"
has "$INDEX" "height: 4px;" "web: the .handle-bar keeps its 4px"
has "$INDEX" "background: var(--border);" "web: the .handle-bar keeps var(--border) (the BIB's BORDER parity target)"
has "$INDEX" "border-radius: 2px;" "web: the .handle-bar keeps its 2px radius"

has "$GEST" "var BODY_SLOP = 24;" "web: gesture.js keeps BODY_SLOP 24 (the chain's slop, unchanged)"
has "$GEST" "track.y0 = y - 6;" "web: gesture.js keeps the y − 6 rebase (the BIB's CHAIN_REBASE parity target)"
has "$GEST" "var RISE_MS = 170;" "web: gesture.js keeps RISE_MS 170 (the BIB's curve parity target)"
has "$GEST" "var stiffness = 170, damping = 2 * Math.sqrt(stiffness) * 1.02;" "web: the settle spring keeps 170/×1.02 (the BIB's SETTLE parity target)"
has "$GEST" "var stiffness = 440, damping = 2 * Math.sqrt(stiffness);" "web: the dismiss spring keeps 440 (the BIB's DISMISS parity target)"
has "$GEST" "cubic-bezier(0.32,0.72,0,1)" "web: the rise curve stays cubic-bezier(0.32,0.72,0,1)"

# the panel's dash really is the var(--border) token — computed live
# (the probe trick: an element painted with the token's raw value
# normalizes hex/named/rgb formats; the dash must match it exactly)
DASHC=$(ev "(function(){
  var el = document.querySelector('#chat-panel .handle-bar');
  if (!el) return 'no-handle';
  var panel = getComputedStyle(document.getElementById('chat-panel'));
  var root = getComputedStyle(document.documentElement);
  var token = (panel.getPropertyValue('--border') || root.getPropertyValue('--border') || '').trim();
  if (!token) return 'no-token';
  var probe = document.createElement('div');
  probe.style.background = token;
  document.body.appendChild(probe);
  var want = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);
  var got = getComputedStyle(el).backgroundColor;
  return got === want ? 'match' : ('mismatch: ' + got + ' vs ' + want);
})()")
check "$DASHC" "match" "live: the panel's dash paints exactly var(--border) (the token the BIB's dash now mirrors)"

# ══ 4. CLEAN ROOM ═══════════════════════════════════════════════════
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
echo " v0.68.0 browser bar red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] || exit 1
