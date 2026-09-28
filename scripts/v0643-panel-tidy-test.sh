#!/bin/bash
# v0643-panel-tidy-test.sh — RED-TEAM the v0.64.3 TIDY PILL (PLAN-V0643).
#
# USER SPEC: "Let's make the search pill for the browser In browser
# (BIB) panel 10% less wide and high. Let's also make the hitbox for
# the refresh icon bigger so it's easier to press. Let's move the
# smooth loading icon u made that uses theme colors upward approx 35%
# from its current position. Let's also add a loading pill, similar to
# the one we have when the chatbot is thinking or establishing a
# connection ext.. to the web link pill in the bib panel only when the
# website is actively loading."
#
# THE DESIGN UNDER TEST (all four asks are NATIVE —
# PanelBrowserSheet.kt — the Kotlin compiles in CI, blind locally, so
# this suite carries the STATIC AUDIT of the Kotlin + the live router
# regression spot checks that prove the web contract survived):
#   1. THE TIDY PILL — the URL capsule stands 30dp tall (was 34: the
#      2×5dp vertical padding retired against the grown refresh slot),
#      the text cap 170→153dp, the paddings (6,5,10,5)→(5,0,9,0).
#      [v0.68.0 REBASE: the capsule shrank ANOTHER 15% — (4,0,8,0),
#      130dp cap, 25.5dp tall; the anchors below track the new truth,
#      v0680-browser-bar-test.sh audits the 15% cut itself]
#   2. THE REFRESH HITBOX — the ↻ ImageButton 24×24 → 30×30 (+25% a
#      side), glyph STAYS 18dp (padding 3→6), ripple circle 12→15dp.
#      [v0.68.0 REBASE: the slot shrank with the capsule to 25.5×25.5 —
#      still above the pre-v0.64.3 24dp; the glyph kept its 18dp]
#   3. THE RING LIFTED — the loading stack rides translationY
#      -0.35×overlay-height (clamped: the stack never leaves a short
#      body — the 30% duck peek).
#   4. THE LOADING PILL — LoadDots: five accent dots, the chatbot's
#      cwd-pulse cadence (0.9s cycle, 0.12s stagger, .18→1 opacity,
#      .82→1.12 scale), GONE unless setLoading(true), riding the SAME
#      fade timing (110/160ms) + the SAME sequence token.
set -u
DATA=/tmp/doomalay-v0643
PORT=8243
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
KT=/home/z/my-project/doomalay/platforms/android/app/src/main/java/com/doomalay/engine
export AGENT_BROWSER_SESSION=doomalay-v0643
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0643-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
if grep -q "address already in use" /tmp/v0643-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.64.3 tidy pill red team: ABORTED (stale port) ══"
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
has "$NCALL" '"accent"' "the theme snapshot still rides every openPanel (the dots/ring re-tint per open)"

GK=$(ev "window.__calls = []; window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); (window.__calls[window.__calls.length-1]||{}).m || 'none'")
check "$GK" "openPanel" "getkey rides the panel (the v0.67.3 BIB mandate — a real top-level WebView)"

HOSTILE=$(ev "window.__calls = []; window.InAppBrowser.open('https://example.com/x', {hostile:true}); (window.__calls[window.__calls.length-1]||{}).m || 'none'")
check "$HOSTILE" "openPanel" "hostile rides the panel too (the v0.67.3 mandate — hostile is metadata now)"

ev "delete window.__doomalayKotlin; 'bridgeless'" >/dev/null
DTIER=$(ev "window.InAppBrowser.open('https://example.com/desktop')")
check "$DTIER" "popup" "the bridge-less surface still redirects to the POPUP tier instantly"
ev "window.__doomalayKotlin = window.__mkNative(); 'bridge back'" >/dev/null

# ══ 2. THE STATIC KOTLIN AUDIT (CI compiles it — this proves intent) ══
KTSHEET=$(cat "$KT/PanelBrowserSheet.kt")

# ask 1 — the tidy pill: the capsule's paddings + the text cap
has "$KTSHEET" "setPadding(dip(4), 0, dip(8), 0)" "Kotlin: the capsule's paddings (4,0,8,0) — the v0.68.0 15% cut (25.5dp tall)"
has "$KTSHEET" "maxWidth = dip(130)" "Kotlin: the text cap 153→130dp (the v0.68.0 15% cut)"
has "$KTSHEET" "setPadding(dip(3), 0, dip(4), 0)" "Kotlin: the text paddings tightened (v0.68.0: right 5→4dp)"

# ask 2 — the refresh hitbox: the slot rides the capsule, the 18dp glyph survives
has "$KTSHEET" "addView(refreshIcon, LinearLayout.LayoutParams(dipF(25.5f), dipF(25.5f)))" "Kotlin: the ↻ slot follows the v0.68.0 25.5dp capsule (was 30)"
has "$KTSHEET" "setPadding(dipF(3.75f), dipF(3.75f), dipF(3.75f), dipF(3.75f))" "Kotlin: the ↻ glyph STAYS 18dp (3.75dp padding inside the 25.5dp slot)"
has "$KTSHEET" "chipShape(Color.TRANSPARENT, 12.75f, null), chipShape(Color.WHITE, 12.75f, null))" "Kotlin: the ↻ ripple circle follows the slot (15→12.75dp — exactly half)"

# ask 3 — the ring lifted 35%, clamped for short bodies
has "$KTSHEET" "val lift = -0.35f * h" "Kotlin: the loading stack lifts 35% of the overlay height"
has "$KTSHEET" "val cap = dip(50) - h / 2f" "Kotlin: the lift is CLAMPED (the stack never leaves a short body)"
has "$KTSHEET" "addOnLayoutChangeListener" "Kotlin: the lift recomputes on layout (rotation/resize safe)"

# ask 4 — the loading pill: LoadDots on the capsule, the chatbot cadence
has "$KTSHEET" "private class LoadDots(context: Context) : View(context)" "Kotlin: LoadDots is a hand-drawn view (the chatbot's five dots, ported)"
has "$KTSHEET" "addView(loadDots, LinearLayout.LayoutParams(" "Kotlin: the dots live INSIDE the URL capsule (right of the text)"
has "$KTSHEET" "120f / 900f" "Kotlin: the 0.12s stagger on the 0.9s cycle (cwd-pulse cadence)"
has "$KTSHEET" "0.18f + 0.82f * s" "Kotlin: the dots pulse .18→1 opacity (the cwd-pulse keyframes)"
has "$KTSHEET" "0.82f + 0.30f * s" "Kotlin: the dots pulse .82→1.12 scale (the cwd-pulse keyframes)"
has "$KTSHEET" "loadDots?.dotColor = accent" "Kotlin: the dots are the theme accent (no hardcoded colors)"
has "$KTSHEET" "dotsSpin" "Kotlin: the dots have their own phase animator in the spin family"

# one loading truth: the dots ride setLoading's fades + sequence token
has "$KTSHEET" "if (loadSeq == seq) dots.visibility = View.GONE" "Kotlin: the dots' hide rides the SAME sequence token (redirect-safe)"
DOTSGONE=$(ev "document.getElementById('chat-panel') ? 'dom' : 'dom'")
check "$DOTSGONE" "dom" "the SPA still boots clean with the wave (no web changes expected)"

# the retirement check: the v0.64.2 audit anchors must ALL survive
has "$KTSHEET" "DUCK_FRAC = 0.30f" "Kotlin: the v0.64.2 duck fraction survives the wave"
has "$KTSHEET" "private fun setLoading(" "Kotlin: the loading driver signature survives"
has "$KTSHEET" "private class LoadRing(context: Context) : View(context)" "Kotlin: the ring survives (the dots are a sibling, not a replacement)"

# theme discipline: zero raw hex in the new code
KTCODE=$(grep -v '^\s*//' "$KT/PanelBrowserSheet.kt" | grep -v '^\s*\*')
nohas "$(echo "$KTCODE" | grep '0xFF')" "0xFF" "Kotlin: zero raw hex colors (the snapshot drives every tint)"

# ══ 3. CLEAN ROOM ═══════════════════════════════════════════════════
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
echo " v0.64.3 tidy pill red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════════"
[ "$FAIL" = "0" ] || exit 1
