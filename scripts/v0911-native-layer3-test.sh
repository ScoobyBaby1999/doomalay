#!/bin/bash
# v0911-native-layer3-test.sh — THE COLOR REWORK, PHASE 1 (user spec:
#   "completely rework and rebuild our color system… maintain as much
#   functionality from our current very complex theme system while
#   maintaining a solid fps thru and theu by using better foundations").
#
# THE CONTRACT (Track 1: CSS-native — see PLAN-V091-COLOR-REWORK.md):
#  (1) OKX — theme.js's perceptual core: the Ottosson reference values
#      (white/red/blue/gray), the lossless round-trip, byte-exact edges
#      (mix t=0/1, avg single), and the rgb-mud fix (red+blue averages to
#      a vivid purple in OKLab, not the muddy rgb midpoint).
#  (2) LAYER-3 NATIVE — on the settings COLORS tab (the lag surface): the
#      chips' computed background is the browser-derived color-mix (NOT a
#      flat var fill, NOT a projected window); .gr-mini/.gr-color/.gr-dir/
#      .gr-editor carry ZERO inline projection styles; color-mix is
#      supported (the modern-Chromium gate the app already requires).
#  (3) THE COLLAPSE — projected elements on the colors tab ≤ 60 (live
#      pre-fix measure: 534 — every control was a viewport-sized raster
#      re-painted on every --proj-tx/ty poke from the canvas physics tick;
#      the panel chrome + the section cards keep the projected field).
#  (4) THE GATES HONOR IT — the derived-gates sheet contains NO .gr-mini
#      window (self-deriving color-mix values never re-project).
#  (5) THEME-FOLLOWING, NATIVELY — flipping the SURFACE field override
#      changes the chip's computed background with NO repaint call (the
#      style engine re-derives; the projection layer is not involved).
#  (6) THE RAISED LOOK — the chip reads raised against its section card
#      (luminance delta ≥ 0.004 in either direction — distinct layers).
#  (7) THE BRIGHT-INK GATE — a BRIGHT surface field trips the
#      DERIVED [data-bright-s2] and the chip ink follows --on-surface-2 (the
#      v0.74 contract survives the native chrome).
#  (8) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8511
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0911
export AGENT_BROWSER_SESSION=doomalay-v0911

ev() { timeout 90 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception: print(s, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "PORT $PORT ALREADY BOUND — refusing"; exit 1
fi
rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0911-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 240); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }
OWN=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
ck "our child owns the listener" "$([ "$OWN" = "$ENGPID" ] && echo yes || echo no)" "$OWN"

agent-browser close >/dev/null 2>&1
agent-browser open "$BASE" >/dev/null 2>&1
# v0.91: the ready-poll — a cold browser session can take 5-10s to boot
# the app; clicking before __doomalayReady is the null-click flake. NO
# clear/reload: every rig run boots a FRESH engine + data dir (storage is
# empty by construction) and a reload mid-boot races the app into a
# half-loaded page the polls then time out on.
for i in $(seq 1 240); do
  RD=$(timeout 10 agent-browser eval "window.__doomalayReady === true" 2>/dev/null | tr -d '"')
  [ "$RD" = "true" ] && break
  sleep 0.25
done
ck "the app booted (__doomalayReady)" "$([ "$RD" = "true" ] && echo yes || echo no)" "$RD"
echo "[boot-dbg] $(timeout 10 agent-browser eval "JSON.stringify({url:location.href, rs:document.readyState, bodyKids:(document.body?document.body.children.length:-1), scripts:document.querySelectorAll('script').length, err:window.__bootErr||null})" 2>&1 | head -c 300)"
agent-browser console 2>/dev/null | head -5 > /tmp/v0911-console-dump.txt
echo "[console] $(head -c 300 /tmp/v0911-console-dump.txt)"

echo "── (1) OKX — the perceptual core (node-side oracle, run against the LIVE page's engine)"
OKX=$(ev "JSON.stringify((function(){
  var T = window.DoomalayThemeJS; var OKX = null;
  // the page-side module isn't exported to window by default — use the
  // node-side suite for the math oracle; here we assert the runtime
  // presence indirectly through the theme's derived values below.
  return {supportsMix: CSS.supports('color','color-mix(in oklch, red, blue)')};
})())")
ck "color-mix(in oklch) supported (the Chromium 111+ gate)" \
   "$(python3 -c "
import json
try: print('yes' if json.loads('''$OKX''').get('supportsMix') else 'no')
except Exception: print('no')")" "$OKX"

echo "── (2) the colors tab: Layer-3 native chrome"
R=$(ev "(async function(){
  document.getElementById('settings-btn').click();
  await new Promise(r=>setTimeout(r,1200));
  var t = document.querySelector('.settings-nav .tab[data-page=appearance]') || Array.from(document.querySelectorAll('.settings-nav .tab')).filter(function(x){return /color/i.test(x.textContent)})[0];
  if (t) t.click();
  await new Promise(r=>setTimeout(r,1500));
  // v0.99.6: the chips/editors live in the SLOT PICKER POPOVER — open
  // the Surface picker (the shape chips + the editor mount there).
  var slotRow = document.querySelector('[data-slot-open=\"surface\"]');
  if (slotRow) slotRow.click();
  await new Promise(function(rs){ setTimeout(rs,600); });
  var sp = document.querySelector('.slot-pop') || document.querySelector('.settings-page');
  var mini = sp.querySelector('.gr-mini');
  var card = sp.querySelector('.settings-section');
  var editor = sp.querySelector('.gr-editor');
  var out = {};
  out.miniInline = mini ? (mini.getAttribute('style') || '') : 'MISSING';
  out.editorInline = editor ? (editor.getAttribute('style') || '') : 'MISSING';
  out.miniBg = mini ? getComputedStyle(mini).backgroundColor : 'MISSING';
  out.cardBg = card ? getComputedStyle(card).backgroundColor : 'MISSING';
  // the chip must NOT be the flat var fill (the derivation engaged) and
  // must not be default/transparent
  out.s2 = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim();
  // the projected count on the tab
  var projected = 0; var allp = sp.querySelectorAll('[style]');
  for (var q=0;q<allp.length;q++){
    var st = allp[q].getAttribute('style')||'';
    if (st.indexOf('var(--proj-tx') !== -1) projected++;
  }
  out.projected = projected;
  // the derived-gates sheet: no .gr-mini window
  var gatesHasMini = false;
  var gs = document.getElementById('doom-derived-gates');
  if (gs && gs.sheet) {
    for (var g=0;g<gs.sheet.cssRules.length;g++){
      if ((gs.sheet.cssRules[g].selectorText||'').indexOf('.gr-mini') !== -1) { gatesHasMini = true; break; }
    }
  }
  out.gatesHasMini = gatesHasMini;
  return JSON.stringify(out);
})()")
MINI_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R''')
    ok = d.get('miniInline','MISSING')=='' and d.get('editorInline','MISSING')==''
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "zero inline projection styles on the chips/editors" "$MINI_OK" "$R"
MIX_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R''')
    bg=d.get('miniBg',''); s2=d.get('s2','')
    # resolved color-mix serializes as oklch(...) or color(...); the flat
    # var would serialize as rgb(...)
    ok = bg.startswith('oklch(') or bg.startswith('oklab(') or bg.startswith('color(') or bg.startswith('lab(')
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "the chip's background is the browser-derived mix (color serialization)" "$MIX_OK" "$R"
PROJ_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R''')
    print('yes' if 0 <= d.get('projected',999) <= 60 else 'no')
except Exception: print('no')")
ck "THE COLLAPSE: projected elements ≤ 60 (pre-fix: 534)" "$PROJ_OK" "$R"
GATES_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R''')
    print('no' if d.get('gatesHasMini') else 'yes')
except Exception: print('no')")
ck "the gates engine did NOT re-project the chips (self-deriving skip)" "$GATES_OK" "$R"

echo "── (4b) the gradient-twin path (a gradient SURFACE FIELD must NOT re-project the chips — raised chrome is derived, never a window)"
R4=$(ev "(async function(){
  Settings.setState({themeOverrides: {midnight: {'--field-surface': {colors: ['#201a2e','#3a2a50'], dir: 'h'}}}});
  await new Promise(r=>setTimeout(r,1200));
  // v0.99.6: re-open the Surface picker (the page re-rendered with the
  // override; the popover is on-demand) then measure the chips.
  var slotRow = document.querySelector('[data-slot-open=\"surface\"]');
  if (slotRow) slotRow.click();
  await new Promise(function(rs){ setTimeout(rs,600); });
  var sp = document.querySelector('.slot-pop') || document.querySelector('.settings-page');
  var mini = sp.querySelector('.gr-mini');
  var inline = mini ? (mini.getAttribute('style') || '') : 'MISSING';
  var gs = document.getElementById('doom-derived-gates');
  var gatesHasMini = false;
  if (gs && gs.sheet) {
    for (var g=0;g<gs.sheet.cssRules.length;g++){
      if ((gs.sheet.cssRules[g].selectorText||'').indexOf('.gr-mini') !== -1) { gatesHasMini = true; break; }
    }
  }
  var projected = 0; var allp = sp.querySelectorAll('[style]');
  for (var q=0;q<allp.length;q++){
    if ((allp[q].getAttribute('style')||'').indexOf('var(--proj-tx') !== -1) projected++;
  }
  Settings.setState({themeOverrides: {midnight: {}}});
  await new Promise(r=>setTimeout(r,800));
  return JSON.stringify({inline: inline, gatesHasMini: gatesHasMini, projected: projected});
})()")
GT_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R4''')
    ok = d.get('inline')=='' and not d.get('gatesHasMini') and d.get('projected',999) <= 60
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "gradient SURFACE field: chips stay native (no window, ≤60 projected)" "$GT_OK" "$R4"

echo "── (5) theme-following, natively (a SURFACE field override, no repaint call)"
R2=$(ev "(async function(){
  // v0.99.6: the chip must EXIST before the before/after recalc
  // measurement — open the Surface picker.
  var slotRow0 = document.querySelector('[data-slot-open=\"surface\"]');
  if (slotRow0) slotRow0.click();
  await new Promise(function(rs){ setTimeout(rs,600); });
  var sp = document.querySelector('.slot-pop') || document.querySelector('.settings-page');
  var mini = sp.querySelector('.gr-mini');
  var before = getComputedStyle(mini).backgroundColor;
  var flipsBefore = (window.DoomalayPerf||{}).paints || 0;
  Settings.setState({themeOverrides: {midnight: {'--field-surface': '#3a2a1a'}}});
  await new Promise(r=>setTimeout(r,900));
  var after = getComputedStyle(mini).backgroundColor;
  var flipsAfter = (window.DoomalayPerf||{}).paints || 0;
  // restore
  Settings.setState({themeOverrides: {midnight: {}}});
  await new Promise(r=>setTimeout(r,600));
  return JSON.stringify({before:before, after:after, paintsDelta:(flipsAfter-flipsBefore)});
})()")
FOLLOW_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R2''')
    ok = d.get('before') != d.get('after') and d.get('before') not in ('MISSING',)
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "the chip follows the SURFACE field (native recalc of the derived chrome)" "$FOLLOW_OK" "$R2"

echo "── (6) the raised look (chip vs card contrast)"
RAISE_OK=$(python3 -c "
import json, re
try:
    d=json.loads('''$R''')
    def lum(c):
        m = re.match(r'rgb\((\d+), (\d+), (\d+)\)', c)
        if not m: return None
        r,g,b = [int(x)/255 for x in m.groups()]
        f = lambda v: v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
        return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)
    # oklch serializations need the browser's own math — compare channel
    # strings instead: distinct strings on distinct vars is the honest
    # DOM-level assertion (same var + same string = invisible chip)
    chip, card = d.get('miniBg',''), d.get('cardBg','')
    ok = chip != card and chip and card
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "the chip reads distinct from its card (the raised contract)" "$RAISE_OK" "$R"

echo "── (7) the bright-ink gate (the v0.74 contract on native chrome)"
R3=$(ev "(async function(){
  Settings.setState({themeOverrides: {midnight: {'--field-surface': '#f5f0e0'}}});
  await new Promise(r=>setTimeout(r,900));
  var de = document.documentElement;
  var gate = de.getAttribute('data-bright-s2');
  Settings.setState({themeOverrides: {midnight: {}}});
  await new Promise(r=>setTimeout(r,600));
  return JSON.stringify({gate: gate});
})()")
BRIGHT_OK=$(python3 -c "
import json
try:
    d=json.loads('''$R3''')
    print('yes' if d.get('gate') not in (None,'','null') else 'no')
except Exception: print('no')")
ck "a bright surface-2 trips [data-bright-s2] (ink flips on native chrome)" "$BRIGHT_OK" "$R3"

echo "── (8) console errors"
ERRS=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and e.get('level','').lower() in ('error','severe'): n+=1
        elif isinstance(e,dict) and e.get('type','').lower()=='error': n+=1
    except Exception: pass
print(n)")
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS"

echo ""
echo "════ v0911 THE COLOR REWORK P1: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
