#!/bin/bash
# v070-accuracy-redteam.sh — THE THEME ACCURACY WAVE's live red team
#
# USER SPEC: "Focus on chat text and pills.. make sure they follow their
# assigned variable color theming correctly and accurately." The model:
# each variable casts ONE viewport field (gradient when painted, solid
# otherwise); every object ASSIGNED to that variable renders it; nothing
# else changes. This suite pins the contract on the REAL app:
#
#   1. SOLID THEME PARITY   — with no gradient overrides, every named
#      pill family keeps its quiet tint + ACCENT-COLORED label (the
#      v0.70 accurate-ink fix: labels are no longer on-accent white on
#      solid accents) and ZERO derived-gate rules do anything (the
#      [data-aN-grad] attributes are unset).
#   2. GRADIENT FOLLOWING   — paint each accent with a gradient and the
#      assigned families must actually render that accent's FIELD:
#      background-image = the accent's gradient twin, viewport-fitted
#      (the PROJ re-anchor), label = the derived on-accent ink.
#   3. THE DERIVED GATES   — the runtime derivation (window.DoomGates)
#      must cover class-based accent pills the static lists never had
#      (e.g. .sq-row's quick-action pills, .sm-row.on) AND must have
#      skipped the exclusion families (pseudo selectors, gate rules,
#      .wsp/.hub-libpill — the explicitly-owned families).
#   4. TEXT ACCURACY       — chat text rides --text-1's field when
#      gradiented (data-text-grad), the trimmed consumers (.hi-counts b,
#      .chat-working-stalled) DON'T, and nebula now ships its own text
#      family (the "chatbot metadata follows no theme" fix).
#   5. CONSOLE HEALTH     — zero page errors through the whole ride.
#
# Usage: bash scripts/v070-accuracy-redteam.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
PORT=8270
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v070
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2 | want: $3)"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing '$3' in: $(echo "$2" | head -c 160))";; esac; }
nohas(){ case "$2" in *"$3"*) bad "$1 (found '$3' in: $(echo "$2" | head -c 160))";; *) ok "$1";; esac; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v070-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || { bad "engine boot"; exit 1; }

# a real session + a seeded chat panel (the v0651 recipe). The THEME is
# switched to nebula after boot — every paint() below targets nebula
# overrides, so the active family must BE nebula for the fields to land.
# An assistant turn is seeded BEFORE the panel opens so the .fmt chat
# text exists for the text-field checks (§4).
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Acc Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"user","text":"hello there"}' >/dev/null
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"assistant","text":"hi — the **accuracy wave** renders this through `.fmt` so the text-grad checks have a real target."}' >/dev/null
agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Acc Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
# the active theme = nebula (the family every paint() targets)
agent-browser eval "window.Settings.setState({theme:'nebula'}); 'ok'" >/dev/null; sleep 0.5
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5
ev(){ agent-browser eval "$1" 2>/dev/null | python3 -c "
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
check "the chat panel opened" "$(ev "document.getElementById('chat-panel').classList.contains('open') && document.getElementById('chat-messages') ? 'open' : 'no'")" "open"

# sameColor NAME A B — in-browser canonical comparison (computed styles
# resolve both spellings — hex or rgb() — to the same serialization).
sameColor(){
  R=$(ev "(function(){
    var a = document.createElement('span'); a.style.color = '$2';
    var b = document.createElement('span'); b.style.color = '$3';
    document.body.appendChild(a); document.body.appendChild(b);
    var same = getComputedStyle(a).color === getComputedStyle(b).color;
    document.body.removeChild(a); document.body.removeChild(b);
    return same ? 'same' : 'diff(' + getComputedStyle(a).color + ' vs ' + getComputedStyle(b).color + ')';
  })()")
  check "$1" "$R" "same"
}

# the metadata dropdown must be OPEN for the pills to lay out — the
# PROJ painter only anchors elements with a real rect (the collapsed
# dropdown is display:none, zero-sized, correctly skipped).
OPENDROP=$(ev "(function(){
  var ch = document.getElementById('header-chevron');
  if (ch && getComputedStyle(document.getElementById('chat-dropdown')).display === 'none') ch.click();
  return document.getElementById('chat-dropdown') && getComputedStyle(document.getElementById('chat-dropdown')).display !== 'none' ? 'open' : 'shut';
})()")
check "the metadata dropdown opened (the pills are laid out)" "$OPENDROP" "open"

# ══ 1. SOLID PARITY — quiet tints + accent labels, no gates ══════════
SOLID=$(ev "(function(){
  var r = {};
  var q = function(id){ var e = document.getElementById(id); return e ? {
    img: getComputedStyle(e).backgroundImage.slice(0,10),
    col: getComputedStyle(e).color } : 'missing'; };
  r.model = q('pill-model'); r.mind = q('pill-mind'); r.sandbox = q('pill-sandbox');
  r.workspace = q('pill-workspace');
  r.gates = [document.documentElement.getAttribute('data-a1-grad'),
             document.documentElement.getAttribute('data-a2-grad'),
             document.documentElement.getAttribute('data-a3-grad'),
             document.documentElement.getAttribute('data-a4-grad')].join(',');
  var dg = document.getElementById('doom-derived-gates');
  r.derived = dg ? (dg.textContent.length > 50 ? 'rules' : 'empty') : 'none';
  return JSON.stringify(r);
})()")
has "solid accents → the chat metadata pills keep quiet tints (no image layer)" "$SOLID" '"img":"none"'
nohas "solid accents → NO gradient gate is set (base themes untouched)" "$SOLID" '"gates":"1'
has "the DERIVED GATES stylesheet exists with rules (armed for gradient rounds)" "$SOLID" '"derived":"rules"'
# the accurate-ink contract: the model pill's label is accent-2 colored,
# not on-accent white (both sides resolved through computed style).
sameColor "v0.70 accurate ink: the solid model pill's label IS the accent-2 color" \
  "$(ev "getComputedStyle(document.getElementById('pill-model')).color" 2>/dev/null)" \
  "$(ev "getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim()" 2>/dev/null)"

# ══ 2. GRADIENT FOLLOWING — each accent's assigned families ══════════
paint(){ ev "window.Settings.setState({themeOverrides:{nebula:Object.assign({},(window.Settings.getState().themeOverrides||{}).nebula||{},{'$1':{colors:['#ff00ff','#00ffcc','#ffee00','$2'],dir:'diag'}})}}); 'painted'" >/dev/null; sleep 0.6; }
fieldof(){ ev "(function(){
  var e = document.getElementById('$1');
  if (!e) return 'missing';
  var cs = getComputedStyle(e);
  return JSON.stringify({img: cs.backgroundImage.slice(0,14),
    clip: cs.webkitBackgroundClip || cs.backgroundClip,
    col: cs.color, len: cs.backgroundImage.length});
})()"; }

# 2a. accent-2 → the model + workspace pills (chat metadata)
paint --accent-2 '#00aaff'
A2M=$(fieldof pill-model); A2W=$(fieldof pill-workspace)
has "a2 gradient → the MODEL pill renders the a2 field" "$A2M" '"img":"linear-grad'
has "a2 gradient → the WORKSPACE pill renders the a2 field (the v0.52 pattern is dead)" "$A2W" '"img":"linear-grad'
sameColor "a2 gradient → the model pill's label flips to the derived on-accent-2 ink" \
  "$(ev "getComputedStyle(document.getElementById('pill-model')).color" 2>/dev/null)" \
  "$(ev "getComputedStyle(document.documentElement).getPropertyValue('--on-accent-2').trim()" 2>/dev/null)"
# the window is viewport-fitted inside the transformed panel (the PROJ re-anchor)
A2POS=$(ev "document.getElementById('pill-model').style.backgroundPosition")
has "a2 gradient → the PROJ painter re-anchored the pill window (inline position set)" "$A2POS" "-"

# 2b. accent-1 → the sandbox/persona pills + the send button ON state
paint --accent '#ff00aa'
A1S=$(fieldof pill-sandbox)
has "a1 gradient → the SANDBOX pill renders the a1 field" "$A1S" '"img":"linear-grad'

# 2c. accent-3 → the mind pill
paint --accent-3 '#cc00ff'
A3M=$(fieldof pill-mind)
has "a3 gradient → the MIND pill renders the a3 field" "$A3M" '"img":"linear-grad'

# ══ 3. THE DERIVED GATES — coverage + exclusions ═════════════════════
DERIVED=$(ev "(function(){
  var dg = document.getElementById('doom-derived-gates');
  var css = dg ? dg.textContent : '';
  return JSON.stringify({
    len: css.length,
    hasHover: css.indexOf(':hover') !== -1,
    hasGateSelf: css.indexOf('[data-a1-grad] [data-a') !== -1,
    hasCatcher: css.indexOf('[style*=') !== -1,
    hasWsp: css.indexOf('.wsp') !== -1,
    hasLibpill: css.indexOf('.hub-libpill') !== -1,
    sqRow: css.indexOf('.sq-row.on') !== -1 || css.indexOf('.sq-tag') !== -1,
    smRow: css.indexOf('.sm-row.on') !== -1
  });
})()")
nohas "the derivation EXCLUDED pseudo/hover states" "$DERIVED" '"hasHover":true'
nohas "the derivation EXCLUDED the gate rules themselves" "$DERIVED" '"hasGateSelf":true'
nohas "the derivation EXCLUDED the inline catchers" "$DERIVED" '"hasCatcher":true'
nohas "the derivation EXCLUDED the .wsp indirection family (explicit rules own it)" "$DERIVED" '"hasWsp":true'
nohas "the derivation EXCLUDED the .hub-libpill family (the tone-scoped rules own it)" "$DERIVED" '"hasLibpill":true'
# the derived rules cover class-based accent pills the static lists never had
has "the derivation covers .sm-row.on (the quick-send rows, previously uncovered)" "$DERIVED" '"smRow":true'
# and an sm-row actually paints the a1 field now — the send-mode menu
# must be OPEN for its rows to exist (the #chat-send-more chevron)
SM=$(ev "(function(){
  var btn = document.getElementById('chat-send-more');
  if (btn && !document.querySelector('.sm-row')) btn.click();
  var el = document.querySelector('.sm-row.on') || document.querySelector('.sm-row');
  return el ? getComputedStyle(el).backgroundImage.slice(0,14) : 'no-rows';
})()")
has "a DERIVED-GATE pill (.sm-row.on) renders the a1 field live" "$SM" "linear-grad"

# ══ 4. TEXT ACCURACY ═════════════════════════════════════════════════
# nebula's own text family FIRST (the 'chatbot metadata follows no
# theme' fix) — BEFORE the text-1 paint, whose override replaces
# --text-1 with the twin's solid on the root.
NEB=$(ev "(function(){
  var cs = getComputedStyle(document.documentElement);
  return JSON.stringify({t1: cs.getPropertyValue('--text-1').trim(),
    t3: cs.getPropertyValue('--text-3').trim(),
    sub: (function(){ var s = document.querySelector('.panel-header .meta .sub'); return s ? getComputedStyle(s).color : 'no-sub'; })()});
})()")
has "nebula ships its OWN text-1 (violet-leaning, not midnight's gray)" "$NEB" '"t1":"#ece8f8"'
has "nebula ships its OWN text-3 (the metadata lines follow the theme now)" "$NEB" '"t3":"#7d76a8"'

# paint text-1 with a gradient → the chat text rides it
ev "window.Settings.setState({themeOverrides:{nebula:Object.assign({},(window.Settings.getState().themeOverrides||{}).nebula||{},{'--text-1':{colors:['#00ff88','#00ccff'],dir:'diag'}})}}); 'painted'" >/dev/null; sleep 0.6
TXT=$(ev "(function(){
  var fmt = document.querySelector('.fmt');
  return JSON.stringify({
    grad: !!document.documentElement.getAttribute('data-text-grad'),
    fmtImg: fmt ? getComputedStyle(fmt).backgroundImage.slice(0,14) : 'no-fmt',
    fmtClip: fmt ? (getComputedStyle(fmt).webkitBackgroundClip || getComputedStyle(fmt).backgroundClip) : 'no-fmt',
    trim1: (function(){ var s = document.styleSheets; for (var i=0;i<s.length;i++){ try { var rs=s[i].cssRules; for (var j=0;j<rs.length;j++){ var t=rs[j].selectorText||''; if (t.indexOf('.hi-counts b') !== -1 && t.indexOf('[data-text-grad]') !== -1) return 'still-listed'; } } catch(e){} } return 'trimmed'; })()
  });
})()")
has "text-1 gradient → the data-text-grad gate is set" "$TXT" '"grad":true'
has "the CHAT TEXT (.fmt) rides the text-1 field" "$TXT" '"fmtImg":"linear-grad'
has "the chat text clips the field through the letters" "$TXT" '"fmtClip":"text"'
has ".hi-counts b trimmed from the text-grad list (text-2 consumer)" "$TXT" '"trim1":"trimmed"'

# ══ 5. CONSOLE HEALTH ════════════════════════════════════════════════
# agent-browser errors prints NOTHING when the list is empty.
ERRS_RAW=$(agent-browser errors 2>/dev/null)
if [ -z "$ERRS_RAW" ]; then ERRS=0
else
  ERRS=$(echo "$ERRS_RAW" | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  if isinstance(d, dict): d = d.get('errors', d)
  print(len(d) if isinstance(d, list) else 'parse-fail')
except Exception:
  print('parse-fail')" 2>/dev/null)
fi
check "zero console errors through the whole ride" "$ERRS" "0"

echo "════════════════════════════════════════════════"
echo " v0.70 accuracy red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════"
[ $FAIL -eq 0 ]
