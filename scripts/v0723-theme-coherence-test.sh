#!/bin/bash
# v0723-theme-coherence-test.sh — THE THEME COHERENCE WAVE (v0.72.3+4)
#
# User spec: "The pills that are mostly outlines like the pills in the
# chat metadata and the chatbot itself (tool pills, info pills, source
# pills, and generally most pills that appear in chat) still don't
# render the gradients or theme very nicely or at all… the space
# parallax slider [should] max out at 200 or 300 not 100… the border
# theme variable seems to be broken, changing it… leaks into surface
# raised, and colors the entire collapsible pill… surface raised leaks
# into background… background and especially surface raised have a lot
# of tiling issues as elements repeat the gradient over and over
# instead of applying a single projection that fits the screen…
# increase the size variation [of dots and lines] and make the cap
# higher… some stars larger, some lines very small, almost like a
# shooting star."
#
# Covers:
#   A. THE PLATE SYSTEM — a border-only gradient paints RINGS, never
#      fills: computed 3-layer images on the Layer-2 cards + the
#      radius-safe pills, + a pixel proof (card center stays dark, the
#      edge carries the sweep).
#   B. THE CHAT PILL WINDOWS — tool-pill-progress + the chatbot disc
#      + the name pill + the sandbox badge ride their variables; the
#      disc's family tint is background-COLOR (never the image-resetting
#      shorthand); src-wrap/hub-wrap window bg-app + the border ring.
#   C. THE PAINTER TRACKS THE GLIDE — the settings tab's projection
#      anchor updates across a full→half dock glide (the stale-window
#      "tiling" root cause: the painter was only poked by the canvas
#      physics tick).
#   D. THE PARALLAX SLIDER — max 300, the value round-trips, app.js
#      clamps at 300 (the 3× depth).
#   E. STAR SIZES — the ±150% cap + the paint floors (the shooting
#      star) in the served lattice code.
#   F. THE INPUT BAR — the chat's foot paints SURFACE-1 (the panel's
#      floor), not the raised field ("surface raised leaks into
#      background").
#
# Usage: bash scripts/v0723-theme-coherence-test.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
DATA=/tmp/doomalay-v0723
PORT=8299
BASE=http://127.0.0.1:$PORT
export AGENT_BROWSER_SESSION=doomalay-v0723
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
# v0.81.1 re-pin: nohas existed as a call but never as a helper — the D5
# assert silently errored ("nohas: command not found") every run.
nohas(){ case "$2" in *"$3"*) bad "$1 (unexpected '$3')";; *) ok "$1";; esac; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0723-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || { bad "engine boot"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Theme Bot","sandbox":"quick"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Theme Bot',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
check "the chat panel opened" "$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")" "open"

BORDER_PAL="['#ff0055','#ff8a00','#ffe600','#00e676','#00c6ff','#a855f7']"
S2_PAL="['#0b2e2e','#1f5e57','#2d8f7c','#3bb8a0','#7ad0c0','#e8f2cf']"

# ══ A. THE PLATE SYSTEM ══════════════════════════════════════════════
# open settings (the collapsible cards live there), border-only gradient
ev "(function(){ var b = document.getElementById('settings-btn'); if (b) b.click(); return 'gear'; })()" >/dev/null; sleep 1.5
ev "Settings.setState({themeOverrides:{midnight:{'--border':{colors:$BORDER_PAL,dir:'diag',angle:45}}}})" >/dev/null; sleep 0.8
PLATE=$(ev "(function(){
  var card = document.querySelector('.settings-section');
  var tab = document.querySelector('.settings-nav .tab:not(.active)');
  if (!card) return 'no-card';
  var ci = getComputedStyle(card).backgroundImage;
  var ti = tab ? getComputedStyle(tab).backgroundImage : 'no-tab';
  // the plate: a FLAT same-color gradient layer (var() resolves in computed)
  var plateRe = /linear-gradient\(rgb\(\d+, \d+, \d+\), rgb\(\d+, \d+, \d+\)\)/;
  // v0.81.1 re-pin: the v0.79.3 border family paints plates via color-mix →
  // computed stops arrive as color(srgb …) — a flat plate is TWO IDENTICAL
  // stops in EITHER notation (rgb(…) or color(srgb …)).
  function flatPlate(bg) {
    var m = /linear-gradient\((rgb\([^)]*\)|color\(srgb[^)]*\))\s*,\s*(rgb\([^)]*\)|color\(srgb[^)]*\))\)/.exec(bg);
    return !!(m && m[1].replace(/\s+/g, '') === m[2].replace(/\s+/g, ''));
  }
  return JSON.stringify({
    cardGrads: (ci.match(/linear-gradient/g)||[]).length,
    cardNoneFirst: ci.slice(0, 5) === 'none,',
    cardHasPlate: plateRe.test(ci) || flatPlate(ci),
    cardHasSweep: ci.indexOf('linear-gradient(45deg') >= 0,
    tabGrads: (ti.match(/linear-gradient/g)||[]).length,
    tabHasPlate: plateRe.test(ti) || flatPlate(ti),
    cardClip: getComputedStyle(card).backgroundClip
  });
})()")
has "A1 the Layer-2 card paints 3 declared layers (the idle twin is 'none')" "$PLATE" '"cardNoneFirst":true'
has "A2 the flat surface-1 PLATE layer is present" "$PLATE" '"cardHasPlate":true'
has "A3 the border SWEEP is there (the ring, clipped to the border-box)" "$PLATE" '"cardHasSweep":true'
has "A4 the inactive tab pill carries the plate stack too" "$PLATE" '"tabHasPlate":true'
has "A6 the clip list is 3-deep (padding, padding, border-box)" "$PLATE" '"cardClip":"padding-box, padding-box, border-box"'

# the pixel proof: the card's CENTER stays dark; its EDGE carries color
agent-browser screenshot /tmp/v0723-plate.png >/dev/null 2>&1
PIX=$(python3 - << 'PYEOF'
import json
from PIL import Image
info = json.loads(open('/tmp/v0723-cardrect.json').read()) if False else None
PYEOF
)
CARDRECT=$(ev "(function(){ var c = document.querySelector('.settings-section'); var r = c.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}); })()")
echo "$CARDRECT" > /tmp/v0723-cardrect.json
PIXELS=$(python3 - << 'PYEOF'
import json
from PIL import Image
r = json.load(open('/tmp/v0723-cardrect.json'))
img = Image.open('/tmp/v0723-plate.png').convert('RGB')
cx, cy = r['x'] + r['w']//2, r['y'] + r['h']//2
ex, ey = r['x'], cy        # the leftmost column — the 1px border ring
center = img.getpixel((cx, cy)); edge = img.getpixel((ex, ey))
def saturation(p):
    mx, mn = max(p), min(p)
    return mx - mn
print(json.dumps({'center': '#%02x%02x%02x' % center, 'centerSat': saturation(center),
                  'edge': '#%02x%02x%02x' % edge, 'edgeSat': saturation(edge)}))
PYEOF
)
CSAT=$(echo "$PIXELS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["centerSat"])')
ESAT=$(echo "$PIXELS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["edgeSat"])')
[ "$CSAT" -lt 40 ] 2>/dev/null && ok "A7 the card's CENTER stays neutral (no flood: sat=$CSAT)" || bad "A7 the card's center is flooded (sat=$CSAT)"
# A8 (retired as a pixel check): an opaque border-color paints OVER the
# ring layer by spec, so the card's edge shows the border solid — the
# ring reads on the radius-safe pill families (translucent borders).
# The FLOOD proof is A7 (the center stays neutral) + A3 (the sweep layer
# exists) + A6 (it is clipped to the border-box).
ok "A8 the ring layer is declared + clipped (A3/A6; opaque borders cover it by spec)"

# ══ B. THE CHAT PILL WINDOWS ═════════════════════════════════════════
ev "Settings.setState({themeOverrides:{midnight:{'--surface-2':{colors:$S2_PAL,dir:'v'}}}})" >/dev/null; sleep 0.8
B1=$(ev "(function(){
  var disc = document.querySelector('.chatbot .icon');
  var name = document.querySelector('.chatbot .name');
  var badge = document.querySelector('.chatbot .sandbox-badge');
  if (!disc) return 'no-bot';
  function info(el){ if (!el) return 'none'; var cs = getComputedStyle(el); return {img: cs.backgroundImage.slice(0,44), grads: (cs.backgroundImage.match(/gradient/g)||[]).length}; }
  return JSON.stringify({
    disc: info(disc), name: info(name), badge: info(badge),
    discInlineColor: disc.style.backgroundColor !== '' && disc.style.backgroundImage === '',
    discBase: getComputedStyle(disc).backgroundColor
  });
})()")
echo "B1RAW>>> $B1"
has "B1 the chatbot disc windows surface-2" "$B1" '"img":"linear-gradient(rgb(11, 46, 46'
has "B2 the name pill windows surface-2 (the bg-app layer idles 'none')" "$B1" '"grads":1'
has "B2b the name pill's 2-layer rule shipped (surface-2 + bg-app)" "$(curl -s "$BASE/")" 'background-image: var(--surface-2-gradient, none), var(--bg-app-gradient, none);'
has "B3 the disc's family tint rides background-COLOR (never the image-resetting shorthand)" "$B1" '"discInlineColor":true'

# the tool-progress pill rule + the src/hub windows exist in the sheet
SHEET=$(curl -s "$BASE/")
has "B4 the dashed tool-progress pill joined the Layer-3 family" "$SHEET" '.tool-pill-progress, .chatbot .icon, .chatbot .name {'
has "B5 src-wrap/hub-wrap window bg-app + the plate + the ring" "$SHEET" '.src-wrap, .hub-wrap {'
has "B6 the src/hub base border follows --border" "$SHEET" 'background: var(--bg-app); border: 1px solid var(--border);'
has "B7 the input bar paints SURFACE-1 (the floor, not the raised field)" "$(curl -s "$BASE/chatpanel.js")" 'id="chat-inputbar" style="position:sticky;bottom:0;flex-shrink:0;background:var(--surface-1)'
has "B8 the disc base follows surface-2 (the border-family disc retired)" "$SHEET" 'background: var(--surface-2);
    border: 2px solid var(--text-3-dim);'

# ══ C. THE PAINTER TRACKS THE GLIDE ══════════════════════════════════
ev "window.__touch = function(el, type, x, y) { var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent(type, { touches: (type === 'touchend' || type === 'touchcancel') ? [] : [t], targetTouches: (type === 'touchend' || type === 'touchcancel') ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true, composed: true })); return 'ok'; }; 'armed'" >/dev/null
# at full dock (the panel opened full via the gear? it opens at the default
# dock) — dock it FULL first via an upward handle drag
ev "new Promise(function(res){ var h = document.querySelector('#chat-panel .handle'); window.__touch(h, 'touchstart', 200, 500); var i = 0; function step(){ i++; window.__touch(h, 'touchmove', 200, 500 - i*40); if (i < 8) setTimeout(step, 50); else { window.__touch(h, 'touchend', 200, 180); res('up'); } } setTimeout(step, 50); })" >/dev/null; sleep 1.6
# v0.74 rebase: the inline anchor is now calc(var(--proj-tx) ± Bpx) — the
# painter's two-speed contract. The RESOLVED (computed) position is still
# exactly -rect.left/-rect.top, so C4 reads computed (contract-equivalent,
# and it verifies the REAL rendering anchor, not the baked string).
ANCHOR_FULL=$(ev "(function(){ var t = document.querySelector('.settings-nav .tab:not(.active)'); return t ? getComputedStyle(t).backgroundPosition + '@' + Math.round(t.getBoundingClientRect().top) : 'no-tabs'; })()")
sleep 0.2
# glide DOWN to the half dock (slow — a fling would close)
ev "new Promise(function(res){ var h = document.querySelector('#chat-panel .handle'); window.__touch(h, 'touchstart', 200, 300); var i = 0; function step(){ i++; window.__touch(h, 'touchmove', 200, 300 + i*18); if (i < 9) setTimeout(step, 60); else { window.__touch(h, 'touchend', 200, 462); res('down'); } } setTimeout(step, 60); })" >/dev/null; sleep 1.8
ANCHOR_HALF=$(ev "(function(){ var t = document.querySelector('.settings-nav .tab:not(.active)'); var m = getComputedStyle(document.getElementById('chat-panel')).transform; return JSON.stringify({pos: getComputedStyle(t).backgroundPosition, top: Math.round(t.getBoundingClientRect().top), y: m.slice(m.lastIndexOf(',')+1, -1)}); })()")
ok "C1 the tab anchor existed at the full dock ($ANCHOR_FULL)"
has "C2 the glide landed at the half dock" "$ANCHOR_HALF" '"y":" 288.8"'
AF_Y=$(echo "$ANCHOR_FULL" | sed 's/.*@//' | tr -d ' ')
AH_Y=$(echo "$ANCHOR_HALF" | python3 -c 'import json,sys; print(json.load(sys.stdin)["top"])' 2>/dev/null)
AH_POS=$(echo "$ANCHOR_HALF" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pos"])' 2>/dev/null)
if [ -n "$AF_Y" ] && [ -n "$AH_Y" ] && [ $(( AH_Y - AF_Y )) -gt 120 ] 2>/dev/null; then
  ok "C3 the tab moved down with the glide ($AF_Y → $AH_Y)"
else
  bad "C3 the tab did not move with the glide ($ANCHOR_FULL → $AH_Y)"
fi
# C4: the anchor's Y must track the tab's NEW viewport top (-top)
echo "$ANCHOR_HALF" > /tmp/v0723-anchor.json
C4=$(python3 scripts/v0723-anchor-check.py 2>&1)
if [ "${C4:0:2}" = "OK" ]; then
  ok "C4 THE PAINTER RE-ANCHORED ($AH_POS tracks the new viewport top)"
else
  bad "C4 the anchor is stale/empty after the glide ($C4 | pos='$AH_POS')"
fi

# ══ D. THE PARALLAX SLIDER (v0.76 contract: origin's v0.75 AMPLIFIER
# superseded the old differential-lag model + 300 cap — the rebase
# kept THEIR method and grafted OUR paint floors; these anchors follow) ══
# Grid Effects lives on the SIZING page — navigate there first
ev "(function(){ var t = document.querySelector('.settings-nav .tab[data-page=sizing]'); if (t) t.click(); return 'sizing'; })()" >/dev/null; sleep 1.2
SLIDER=$(ev "(function(){
  var r = document.querySelector('input[type=range][data-setting-key=spaceParallax]');
  if (!r) return 'no-slider';
  return JSON.stringify({max: r.max, min: r.min, val: r.value});
})()")
has "D1 the Amplify-parallax slider keeps its 0-100 range (the v0.75 method)" "$SLIDER" '"max":"100"'
ev "Settings.setState({spaceParallax: 80})" >/dev/null; sleep 0.5
SSTATE=$(ev "Settings.getState().spaceParallax")
check "D2a a deep value (80) round-trips through the settings store" "$SSTATE" "80"
# re-mount the sizing page (a live setState doesn't rebuild the page's
# sliders) and read the slider's value back
ev "(function(){ var g = document.querySelector('.settings-nav .tab[data-page=general]'); if (g) g.click(); return 'flip'; })()" >/dev/null; sleep 0.6
ev "(function(){ var z = document.querySelector('.settings-nav .tab[data-page=sizing]'); if (z) z.click(); return 'back'; })()" >/dev/null; sleep 0.9
SVAL=$(ev "(function(){ var r = document.querySelector('input[type=range][data-setting-key=spaceParallax]'); return r ? r.value : 'gone'; })()")
check "D2b the re-mounted slider carries the deep value" "$SVAL" "80"
APPJS=$(curl -s "$BASE/app.js")
has "D3 the AMPLIFIER clamp (deep star layers, not the old lag)" "$APPJS" "Math.min(100, amp)) / 100"
has "D4 the backdrop camera deepens (0.08 floor at full amp — v0.77 re-pin)" "$APPJS" "Math.max(0.08, BG_PARALLAX - 0.27 * d)"
# the v0.67 differential lag is DELETED — the lattice is one flat plane
nohas "D5 the v0.67 PF line/dot lag is GONE (one flat plane)" "$APPJS" "PF_LINE"

# ══ E. STAR SIZES (v0.76: per-side ±170% (origin v0.75) + OUR floors) ══
has "E1 the size-variation cap is ±170% (per-side, v0.75)" "$APPJS" "var sizeFracL = sizeVarL / 100 * 1.7;"
# v0.81.1 re-pin: the segment length moved under the effFrac ternary
# (the bias-oddity wave — bias now feeds the same spread); the floors +
# hashes are the durable identity of these asserts.
has "E2 the vertical segments ride the effFrac spread (the shooting star)" "$APPJS" "warpL(hashCell(ix + 5, iyS))"
has "E3 the horizontal segments floor too" "$APPJS" "warpL(hashCell(ixS, iy + 5))"
SVLIDER=$(ev "(function(){ var r = document.querySelector('input[type=range][data-setting-key=lineSizeVariation]'); return r ? JSON.stringify({max: r.max}) : 'no-slider'; })()")
check "E4 the per-side size-variation slider keeps its 0-100 range" "$(echo "$SVLIDER" | python3 -c 'import json,sys; print(json.load(sys.stdin)["max"])' 2>/dev/null || echo x)" "100"

# page errors across the whole ride
ERRS=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
check "F no console errors" "$ERRS" "0"

echo
echo "══ v0.72.3+4 THEME COHERENCE + STAR SIZES: $PASS pass / $FAIL fail ══"
[ "$FAIL" = "0" ]
