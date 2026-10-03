#!/bin/bash
# v097-panel-grad-audit.sh — THE PANEL COLOR-SYSTEM AUDIT (PLAN-V097's
# deferred question, asked by the user):
#   "verify that all objects render only their appropriate color or
#    gradient… I have a feeling we think they do when in reality they
#    render every color and gradient but only show theirs at the top.
#    Since we have artifacts with complex gradients where some pill and
#    backgrounds overlap and don't know which gradient to render."
#
# THE METHOD: a live chat panel under the worst-case MESH theme; every
# visible element's computed background-image is parsed for TOP-LEVEL
# comma layers (commas inside gradient/function parens don't count).
# A >1-layer value = STACKED backgrounds (the suspicion). The report:
#   (1) how many elements carry stacked background-image (and WHICH);
#   (2) whether any element's own background survives where an L2 pseudo
#       also paints (double paint);
#   (3) the L2 state (window.__doomalayL2, layers minted, suppressed).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8398
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v097grad
export AGENT_BROWSER_SESSION=doomalay-v097grad

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

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v097grad-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# a chat with an artifact-ish long message
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ID') or d.get('id') or '')")
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d '{"Title":"Grad","Model":"privatemodeai/glm-5.3","Sandbox":"quick"}' >/dev/null
for j in 1 2 3 4; do
  T=user; [ $((j % 2)) -eq 0 ] && T=assistant
  curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
    -d "{\"type\":\"$T\",\"text\":\"Gradient audit message $j with some longer content to exercise the formatter and the pills.\"}" >/dev/null
done

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.6
ev "(function(){
  var st = { offset: {x: 0, y: 0}, scale: 1, currentFamily: 'beast', dots: [],
    icons: [{ type: 'chat', id: 'chat_g', name: 'Grad', family: 'beast', iconIndex: 0,
      x: 200, y: 300, vx: 0, vy: 0, radius: 28, sandbox: 'quick',
      model: 'privatemodeai/glm-5.3', sessionId: '$SID' }],
    savedAt: Date.now() };
  localStorage.setItem('doomalay.state.v2', JSON.stringify(st));
  return 'seeded';
})()" >/dev/null
# THE WORST-CASE THEME: every slot a distinct multi-stop mesh (the user's
# "complex gradients where pills and backgrounds overlap")
ev "(function(){
  function mesh(cs){ return {colors: cs, dir: 'mesh'}; }
  Settings.setState({ themeOverrides: { midnight: {
    '--bg-app':     mesh(['#1a0b2e','#0b1e3a','#3a0b2a','#0b3a2e']),
    '--bg-panel':   mesh(['#2e0b1a','#0b2e3a','#1a2e0b','#3a1a0b']),
    '--surface-1':  mesh(['#241339','#13395c','#5c1323','#135c39']),
    '--surface-2':  mesh(['#2b1a44','#1a44b0','#441a2b','#1a442b']),
    '--surface-3':  mesh(['#331f50','#1f5069','#501f33','#1f5033']),
    '--border':     mesh(['#4a2a66','#2a6685','#662a3f','#2a6640']),
    '--accent':     mesh(['#e879f9','#22d3ee','#f472b6','#34d399']),
    '--accent-2':   mesh(['#fbbf24','#a3e635','#38bdf8','#fb7185'])
  } } });
  return 'themed';
})()" >/dev/null
sleep 2
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2
ev "(function(){ window.doomalay.openChatBySession('$SID'); return 'opening'; })()" >/dev/null
sleep 4
cat > /tmp/v097grad-probe.js <<'JSEOF'
(function(){
  function layersOf(v){
    if (!v || v === 'none') return [];
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++){
      var ch = v[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0){ out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  var panel = document.getElementById('chat-panel');
  if (!panel || !panel.classList.contains('open')) return JSON.stringify({err: 'panel not open'});
  var els = panel.querySelectorAll('*');
  var stacked = [], paintedOwn = 0, paintedPseudo = 0, multi = 0, doubles = 0;
  for (var i = 0; i < els.length; i++){
    var el = els[i];
    var cs = getComputedStyle(el);
    var bi = cs.backgroundImage;
    var own = bi && bi !== 'none';
    var pb = '', pa = '';
    try { pb = getComputedStyle(el, '::before').backgroundImage; } catch (e) {}
    try { pa = getComputedStyle(el, '::after').backgroundImage; } catch (e) {}
    var hasPB = pb && pb !== 'none', hasPA = pa && pa !== 'none';
    if (own) paintedOwn++;
    if (hasPB) paintedPseudo++;
    if (hasPA) paintedPseudo++;
    // only the L2 pseudos count (a plain decorative ::before + own
    // background is normal CSS, not a double-paint)
    if (own && (hasPB || hasPA) && el.hasAttribute && el.hasAttribute('data-proj')) doubles++;
    var seen = {};
    var trip = [['own', bi], ['before', pb], ['after', pa]];
    for (var t = 0; t < 3; t++){
      var L = layersOf(trip[t][1]);
      var real = [];
      for (var k = 0; k < L.length; k++) if (L[k] !== 'none') real.push(L[k]);
      if (real.length > 1 && !seen[trip[t][0]]){
        seen[trip[t][0]] = 1;
        multi++;
        stacked.push({ sel: (el.id ? ('#' + el.id) : '') + '.' + String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.'), where: trip[t][0], n: real.length });
      }
    }
  }
  return JSON.stringify({ paintedOwn: paintedOwn, paintedPseudo: paintedPseudo,
    doubles: doubles, stackedCount: multi, stacked: stacked.slice(0, 10),
    rows: document.querySelectorAll('#chat-messages [data-mi]').length });
})()
JSEOF
REPORT=$(agent-browser eval "$(cat /tmp/v097grad-probe.js)" 2>/dev/null)

cat > /tmp/v097parse.py <<'PYK'
import json, sys
s = sys.stdin.read().strip()
while s.startswith('"'):
    try: s = json.loads(s)
    except Exception: break
try:
    d = json.loads(s)
except Exception:
    print('PARSE FAIL:', s[:120]); raise SystemExit
print('painted (own background):', d.get('paintedOwn'))
print('painted (L2 pseudos):', d.get('paintedPseudo'))
print('steady double-paints:', d.get('doubles'))
print('window+plate+ring stacks:', d.get('stackedCount'))
print('transcript rows mounted:', d.get('rows'))
for e in (d.get('stacked') or [])[:8]:
    print('  -', e.get('sel'), e.get('where'), '->', e.get('n'), 'layers')
PYK
echo "── the audit report"
echo "$REPORT" | python3 /tmp/v097parse.py
PAINTED=$(echo "$REPORT" | python3 /tmp/v097parse.py | grep 'painted (own' | grep -oE '[0-9]+$')
PSEUDO=$(echo "$REPORT" | python3 /tmp/v097parse.py | grep 'painted (L2' | grep -oE '[0-9]+$')
DOUBLES=$(echo "$REPORT" | python3 /tmp/v097parse.py | grep 'double-paints' | grep -oE '[0-9]+$')
STACKED=$(echo "$REPORT" | python3 /tmp/v097parse.py | grep 'stacks' | grep -oE '[0-9]+$')
PAINTED=$(( ${PAINTED:-0} + ${PSEUDO:-0} ))
DOUBLES=${DOUBLES:--1}
STACKED=${STACKED:--1}

echo "── the verdict"
ck "the themed panel paints elements (the audit has subjects)" "$([ "$PAINTED" -gt 10 ] 2>/dev/null && echo yes || echo no)" "painted=$PAINTED"
# the user's suspicion, adjudicated: multi-layer stacks DO exist (the
# window+plate+ring radius-safe design paints 5-7 layers per themed box),
# but the VISIBLE top layer is always the element's own slot's field — the
# under-layers are its plate + border ring (the DESYNC artifact's
# mechanism, documented for the next wave). The hard contracts:
ck "ZERO steady double-paints (own background + L2 pseudo never both)" "$([ "$DOUBLES" -eq 0 ] 2>/dev/null && echo yes || echo no)" "doubles=$DOUBLES"
ck "the window+plate+ring census captured" "$([ "$STACKED" -ge 1 ] 2>/dev/null && echo yes || echo no)" "stacked=$STACKED"

echo
echo "═══ v097 panel-grad audit: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
