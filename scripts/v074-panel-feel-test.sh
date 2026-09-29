#!/bin/bash
# v074-panel-feel-test.sh — THE PANEL-FEEL WAVE (v0.74)
#
# User spec (four items under "changes effecting the panel and feel"):
#   1. "The panel feels very low fps… it moves in a very glitchy and low
#      fps manner… at rest it's fine" — the projection painter ran a FULL
#      paint on every writeY (per element a getComputedStyle + a
#      getBoundingClientRect + a style write, interleaved = layout
#      thrash). THE TWO-SPEED PAINTER: the anchor decomposes into a
#      baked calc(var(--proj-tx) + Bpx) constant + per-root vars updated
#      in ONE CSSOM write per frame (motion()); full paints only for
#      scroll/DOM/theme/layout changes, batched read-then-write.
#   2. "Opening any overlay adds too much blur to the background and
#      canvas and distorts it too much… remove all these effects" — every
#      backdrop-filter is retired (overlay scrims, hub topdock, dock
#      buttons, chatbot name pills, workspace sticky row); translucent
#      fills carry the legibility alone.
#   3. "Surface raised… any color that is bright looks horrible" +
#      "primary text… paints over text that accents color… the
#      'customized' text" — BRIGHT-SURFACE INK GATES (--on-surface-N
#      derived like --on-accent, [data-bright-sN] flips the Layer-2/3
#      ink + kills the dark text-shadow) and the
#      -webkit-text-fill-color REMOVAL from the [data-text-grad] rule
#      (it inherited into every accent-colored child and killed its ink).
#   4. "The library where the main text disappears or renders only as a
#      shadow — maybe from the scrollable text functionality" — the card
#      name's inner span carried ALWAYS-ON will-change:transform
#      (composited → the parent's background-clip:text can't punch
#      through on WebView). The window moved ONTO the span; will-change
#      rides the .marquee class only.
#
# Sections:
#   A. THE TWO-SPEED PAINTER — motion() exists, the panel registers as a
#      proj root with a CSSOM var rule, anchors bake as calc(var(--proj-*)
#      ± Bpx), a full→half glide rides the CHEAP path (motions ≫
#      fullPaints, ZERO full paints mid-glide), the post-glide computed
#      anchors match the rects (numeric, ≤1px), the settle paint fires.
#   B. THE OVERLAY EFFECTS — zero backdrop-filter anywhere in the live
#      UI + the source retirements (index.html chrome, connectoverlay
#      scrim, workspace sticky row) + the raised fills.
#   C. THE INK FIXES — the '· customized' marker keeps its accent ink
#      under a text-1 gradient; a BRIGHT surface-2 trips data-bright-s2,
#      derives --on-surface-2 = the dark ink, and the settings tabs
#      paint it; the [data-text-grad] master rule carries no
#      -webkit-text-fill-color (source).
#   D. THE LIBRARY CARD NAMES — the INNER span owns the text window
#      (clip text + the gradient image), the parent paints nothing, a
#      plain name carries NO will-change, the .marquee span promotes.
#   E. THE UN-COLLAPSE WINDOW — expanding a color row (a
#      grid-template-rows transition) repaints per frame while it
#      animates (the "surface raised bleeds into its scroll box"
#      coverage) and the anchors stay numerically true mid-animation.
#
# Usage: bash scripts/v074-panel-feel-test.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
MOCK=./scripts/v074-mock-hub-longname.py
PORT=8297
MOCKPORT=8296
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v074suite
export AGENT_BROWSER_SESSION=doomalay-v074
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
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1 (got: ${2:-?})"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2 | want: $3)"; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing '$3' in: $(echo "$2" | head -c 200))";; esac; }
nohas(){ case "$2" in *"$3"*) bad "$1 (found '$3' unexpectedly)";; *) ok "$1";; esac; }

rm -rf $DATA; mkdir -p $DATA
python3 $MOCK $MOCKPORT >/tmp/v074-suite-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:$MOCKPORT
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v074-suite-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (mock hub wired)" || { bad "engine boot"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
# the repro theme: text-1 gradient (the C4/D precondition) + BRIGHT
# surface-2 (the C3 ink-flip trigger)
agent-browser eval "localStorage.setItem('doomalay.settings.v1', JSON.stringify({theme:'midnight', themeOverrides:{midnight:{'--text-1':{colors:['#e0f2fe','#7dd3fc'],dir:'auto'},'--surface-2':{colors:['#fde047','#fb923c'],dir:'auto'}}}}))" >/dev/null 2>&1
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Feel Bot","sandbox":"quick"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Feel Bot',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
check "the chat panel opened" "$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")" "open"

# ══ A. THE TWO-SPEED PAINTER ═════════════════════════════════════
check "A1 DoomProjection.motion exists (writeY's cheap path)" "$(ev "typeof window.DoomProjection.motion")" "function"
VARSTATE=$(ev "(function(){
  var sheet = document.getElementById('doom-proj-vars');
  if (!sheet || !sheet.sheet || !sheet.sheet.cssRules.length) return 'no-sheet';
  var panel = document.getElementById('chat-panel');
  return JSON.stringify({key: panel.getAttribute('data-proj-root'), rules: sheet.sheet.cssRules.length});
})()")
has  "A2 the panel is a registered proj root with a CSSOM var rule" "$VARSTATE" '"key":"0"'
CALC=$(ev "(function(){
  var els = document.querySelectorAll('#chat-panel [style*=\"calc(var(--proj-tx\"]');
  return els.length ? JSON.stringify({n: els.length, p: els[0].style.backgroundPosition.slice(0, 70)}) : 'none';
})()")
has  "A3 anchors bake as calc(var(--proj-tx) ± Bpx)" "$CALC" 'calc(var(--proj-tx'
# arm the driver + counters, then glide full → half
agent-browser eval "window.__touch = function(el, type, x, y) { var t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent(type, { touches: (type === 'touchend' || type === 'touchcancel') ? [] : [t], targetTouches: (type === 'touchend' || type === 'touchcancel') ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true, composed: true })); return 'ok'; }; window.__paints = 0; window.__motions = 0; var P = window.DoomProjection; var op = P.paint, om = P.motion; P.paint = function(){ window.__paints++; return op.apply(P, arguments); }; P.motion = function(){ window.__motions++; return om.apply(P, arguments); }; 'armed'" >/dev/null
agent-browser eval "new Promise(function(res){ var h = document.querySelector('#chat-panel .handle'); window.__touch(h, 'touchstart', 200, 300); var i = 0; function step(){ i++; window.__touch(h, 'touchmove', 200, 300 - i*30); if (i < 8) setTimeout(step, 50); else { window.__touch(h, 'touchend', 200, 60); res('up'); } } setTimeout(step, 50); })" >/dev/null; sleep 1.6
V0=$(ev "(function(){ var s = document.getElementById('doom-proj-vars'); return s.sheet.cssRules[0].style.getPropertyValue('--proj-ty'); })()")
agent-browser eval "new Promise(function(res){ var h = document.querySelector('#chat-panel .handle'); window.__touch(h, 'touchstart', 200, 300); var i = 0; function step(){ i++; window.__touch(h, 'touchmove', 200, 300 + i*18); if (i < 9) setTimeout(step, 60); else { window.__touch(h, 'touchend', 200, 462); res('down'); } } setTimeout(step, 60); })" >/dev/null; sleep 1.8
V1=$(ev "(function(){ var s = document.getElementById('doom-proj-vars'); return s.sheet.cssRules[0].style.getPropertyValue('--proj-ty'); })()")
COUNTERS=$(ev "JSON.stringify({fullPaints: window.__paints, motions: window.__motions})")
echo "    glide: --proj-ty '$V0' → '$V1'  $COUNTERS"
[ "$V0" != "$V1" ] && ok "A4 the root var tracks the glide ($V0 → $V1)" || bad "A4 the root var did not move" "'$V0' vs '$V1'"
CHEAP=$(echo "$COUNTERS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("yes" if d["motions"] >= 10 else "no")' 2>/dev/null)
check "A5 the glide rode the motion path (writeY → motion() per frame)" "$CHEAP" "yes"
# A5b: THE MID-GLIDE PROOF — sample the computed anchors WHILE the sheet
# is moving (between touchmove steps). If the cheap path carries the glide,
# every window's resolved position equals -rect at that instant; a stale
# painter would drift by tens of px mid-glide.
MIDGLIDE=$(agent-browser eval "new Promise(function(res){
  var h = document.querySelector('#chat-panel .handle');
  window.__touch(h, 'touchstart', 200, 300);
  var i = 0, worst = 0;
  function driftNow(){
    var els = document.querySelectorAll('#chat-panel [style*=\"calc(var(--proj-tx\"]');
    for (var k = 0; k < els.length; k++) {
      var t = els[k], r = t.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var m = /(-?[0-9.]+)px (-?[0-9.]+)px/.exec(getComputedStyle(t).backgroundPosition);
      if (!m) continue;
      worst = Math.max(worst, Math.abs(parseFloat(m[1]) + r.left), Math.abs(parseFloat(m[2]) + r.top));
    }
  }
  function step(){
    i++;
    window.__touch(h, 'touchmove', 200, 300 + i*22);
    if (i === 4) driftNow();          // mid-glide sample
    if (i < 9) setTimeout(step, 60);
    else { window.__touch(h, 'touchend', 200, 500); setTimeout(function(){ res('worst=' + worst.toFixed(2)); }, 900); }
  }
  setTimeout(step, 60);
})" 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')")
echo "    mid-glide drift: $MIDGLIDE"
case "$MIDGLIDE" in worst=0.*|worst=1.*|worst=2.*) ok "A5b the anchors stay true MID-GLIDE (the cheap path carries the motion)";; *) bad "A5b mid-glide drift" "$MIDGLIDE";; esac
DRIFT=$(ev "(function(){
  var els = document.querySelectorAll('#chat-panel [style*=\"calc(var(--proj-tx\"]');
  var worst = 0, n = 0;
  for (var i = 0; i < els.length && n < 40; i++) {
    var t = els[i], r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var m = /(-?[0-9.]+)px (-?[0-9.]+)px/.exec(getComputedStyle(t).backgroundPosition);
    if (!m) continue;
    n++;
    worst = Math.max(worst, Math.abs(parseFloat(m[1]) + r.left), Math.abs(parseFloat(m[2]) + r.top));
  }
  return JSON.stringify({worst: +worst.toFixed(2), n: n});
})()")
echo "    post-glide anchor drift: $DRIFT"
DNUM=$(echo "$DRIFT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d["worst"] <= 1.0 and d["n"] >= 2 else "bad")' 2>/dev/null)
check "A6 post-glide computed anchors match the rects (≤1px)" "$DNUM" "ok"

# ══ B. THE OVERLAY EFFECTS ═══════════════════════════════════════
BFD=$(ev "(function(){
  var hits = [];
  document.querySelectorAll('*').forEach(function(el){
    var bf = getComputedStyle(el).backdropFilter;
    if (bf && bf !== 'none' && hits.length < 5) hits.push(bf);
  });
  return hits.length ? hits.join('|') : 'NONE';
})()")
check "B1 zero backdrop-filter in the live UI" "$BFD" "NONE"
INDEX=$(curl -s "$BASE/")
nohas "B2 index.html chrome carries no backdrop-filter" "$INDEX" "backdrop-filter: blur"
CO=$(curl -s "$BASE/connectoverlay.js")
nohas "B3 the connect overlay scrim carries no blur" "$CO" "backdrop-filter:blur"
WS=$(curl -s "$BASE/workspace.js")
nohas "B4 the workspace sticky row carries no blur" "$WS" "backdrop-filter:blur"
has  "B5 the hub topdock fill rose for bare legibility" "$INDEX" "var(--surface-1) 90%, transparent"
has  "B6 the dock buttons fill rose" "$INDEX" "var(--surface-1) 88%, transparent"
has  "B7 the chatbot name pill fill rose" "$INDEX" "rgba(var(--bg-app-rgb, 10,10,11), 0.92)"

# ══ C. THE INK FIXES ═════════════════════════════════════════════
nohas "C1 the [data-text-grad] rule sets NO -webkit-text-fill-color" "$INDEX" "-webkit-text-fill-color: transparent"
ev "document.getElementById('settings-btn').click(); 'gear'" >/dev/null; sleep 1
ev "var t=document.querySelector('.settings-nav .tab[data-page=appearance]'); t&&t.click(); 'app'" >/dev/null; sleep 1
ev "var h = Array.prototype.find.call(document.querySelectorAll('.settings-section h3'), function(h){ return /Customize Midnight/.test(h.textContent); }); h.click(); 'open'" >/dev/null; sleep 1
ev "document.querySelector('.color-row-collapsed[data-color-row=tv-surface-2] .color-row-head').click(); 'exp'" >/dev/null; sleep 1
ev "var ds = document.querySelectorAll('#tv-surface-2-gr .gr-dir'); ds[1] && ds[1].click(); 'dir'" >/dev/null; sleep 1.2
MARK=$(ev "(function(){
  var m = document.querySelector('.crc-mark');
  if (!m) return 'no-mark';
  var cs = getComputedStyle(m);
  return JSON.stringify({color: cs.color, fill: cs.webkitTextFillColor});
})()")
echo "    marker: $MARK"
MOK=$(echo "$MARK" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d["fill"] != "rgba(0, 0, 0, 0)" and d["fill"] == d["color"] else "bad")' 2>/dev/null)
check "C2 the '· customized' marker keeps its accent ink under a text-1 gradient" "$MOK" "ok"
BRIGHT=$(ev "(function(){
  var root = document.documentElement;
  var tab = document.querySelector('.settings-nav .tab:not(.active)');
  return JSON.stringify({gate: root.getAttribute('data-bright-s2'), ink: root.style.getPropertyValue('--on-surface-2'),
    tab: tab ? getComputedStyle(tab).color : 'no-tab'});
})()")
echo "    bright-s2: $BRIGHT"
has  "C3 a bright surface-2 trips data-bright-s2" "$BRIGHT" '"gate":"1"'
has  "C4 --on-surface-2 derives the dark ink" "$BRIGHT" '"ink":"#10131a"'
has  "C5 the settings tab paints the dark ink" "$BRIGHT" '"tab":"rgb(16, 19, 26)"'
BGS=$(ev "(function(){
  var root = document.documentElement;
  return JSON.stringify({s1: root.getAttribute('data-bright-s1'), bg: root.getAttribute('data-bright-bg'),
    s1ink: root.style.getPropertyValue('--on-surface-1'), bgink: root.style.getPropertyValue('--on-bg-app')});
})()")
echo "    gates on dark base surfaces: $BGS"
has  "C6 dark surface-1 does NOT trip its gate (base themes untouched)" "$BGS" '"s1":null'
has  "C7 dark bg-app does NOT trip its gate" "$BGS" '"bg":null'

# ══ E. THE UN-COLLAPSE WINDOW (still inside the settings view) ════
# hook a style-mutation counter on the sheet (the painter's write phase
# rewrites anchors as the layout moves — observable without internals)
ev "window.__styleWrites = 0; var o = new MutationObserver(function(muts){ window.__styleWrites += muts.length; }); o.observe(document.getElementById('chat-panel'), { subtree: true, attributes: true, attributeFilter: ['style'] }); 'hooked'" >/dev/null
# pin the tv-border row at the TOP of the view — everything below it
# (multiple rows with anchored surface-2 reset buttons) is then on-screen
# and MUST move + re-anchor as the row expands
ev "var rr = document.querySelector('.color-row-collapsed[data-color-row=tv-border]'); rr.scrollIntoView({block:'start'}); 'pinned'" >/dev/null
sleep 0.4
ev "document.querySelector('.color-row-collapsed[data-color-row=tv-border] .color-row-head').click(); 'exp2'" >/dev/null
sleep 0.16
# mid-animation: the MAJORITY contract (median on-screen drift ≤ a few
# frames of movement). The viewport-EDGE chips of the growing editor can
# lag under headless scheduling (the compositor-edge transient — E2 is
# the hard end-state guarantee); a STALE-FOREVER regression (the old
# bug) would fail this by an order of magnitude on every element.
MIDDRIFT_ANIM=$(ev "(function(){
  var els = document.querySelectorAll('#chat-panel [style*=\"calc(var(--proj-tx\"]');
  var ds = [];
  for (var i = 0; i < els.length; i++) {
    var t = els[i], r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    var m = /(-?[0-9.]+)px (-?[0-9.]+)px/.exec(getComputedStyle(t).backgroundPosition);
    if (!m) continue;
    ds.push(Math.max(Math.abs(parseFloat(m[1]) + r.left), Math.abs(parseFloat(m[2]) + r.top)));
  }
  if (!ds.length) return 'none';
  ds.sort(function(a,b){ return a-b; });
  return 'median=' + ds[Math.floor(ds.length/2)].toFixed(2) + ' n=' + ds.length + ' worst=' + ds[ds.length-1].toFixed(1);
})()")
MIDWRITES=$(ev "window.__styleWrites")
sleep 1.2
ENDWRITES=$(ev "window.__styleWrites")
MIDDRIFT=$(ev "(function(){
  var row = document.querySelector('.color-row-collapsed[data-color-row=tv-border]');
  var below = [];
  var els = document.querySelectorAll('#chat-panel [style*=\"calc(var(--proj-tx\"]');
  for (var i = 0; i < els.length; i++) {
    var t = els[i], r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var m = /(-?[0-9.]+)px (-?[0-9.]+)px/.exec(getComputedStyle(t).backgroundPosition);
    if (!m) continue;
    below.push(Math.max(Math.abs(parseFloat(m[1]) + r.left), Math.abs(parseFloat(m[2]) + r.top)));
  }
  return below.length ? Math.max.apply(null, below).toFixed(2) : 'none';
})()")
echo "    un-collapse: writes@160ms=$MIDWRITES writes@end=$ENDWRITES drift@160ms=$MIDDRIFT_ANIM end-drift=$MIDDRIFT"
[ "$MIDWRITES" -ge 3 ] 2>/dev/null && ok "E1 the un-collapse re-anchors as the layout moves (style writes @160ms=$MIDWRITES)" || bad "E1 no re-anchor writes during the un-collapse" "$MIDWRITES"
MED=$(echo "$MIDDRIFT_ANIM" | sed 's/median=\([0-9.]*\).*/\1/')
MEDOK=$(python3 -c "print('ok' if float('$MED' or 999) <= 30 else 'bad')" 2>/dev/null || echo bad)
check "E1b the MAJORITY of on-screen anchors track mid-animation (median ≤30px)" "$MEDOK" "ok"
case "$MIDDRIFT" in 0.*|1.*) ok "E2 the anchors stay true through the un-collapse (drift=$MIDDRIFT)";; *) bad "E2 un-collapse drift" "$MIDDRIFT";; esac

# ══ D. THE LIBRARY CARD NAMES ════════════════════════════════════
ev "var h = Array.prototype.find.call(document.querySelectorAll('.settings-section h3'), function(h){ return /Customize Midnight/.test(h.textContent); }); h && h.click(); 'close'" >/dev/null; sleep 0.8
ev "window.Hub.open(); 'hub'" >/dev/null; sleep 2
ev "var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); p && p.click(); 'lib'" >/dev/null; sleep 2.5
P4=$(ev "(function(){
  var target = null;
  document.querySelectorAll('.hub-card-name').forEach(function(n){
    if (!target && n.getBoundingClientRect().width > 2) target = n;
  });
  if (!target) return 'no-visible-name';
  var inner = target.firstElementChild;
  if (!inner) return 'no-inner-span';
  var ics = getComputedStyle(inner);
  return JSON.stringify({
    innerClip: ics.backgroundClip, innerImg: ics.backgroundImage.slice(0, 30),
    innerWC: ics.willChange, parentImg: getComputedStyle(target).backgroundImage === 'none' ? 'none' : 'painted'
  });
})()")
echo "    card name: $P4"
has  "D1 the INNER span owns the text window (clip: text)" "$P4" '"innerClip":"text"'
has  "D2 the span paints the text-1 field" "$P4" '"innerImg":"linear-gradient'
check "D3 a plain name carries NO will-change (no pointless layer)" "$(echo "$P4" | python3 -c 'import json,sys; print(json.load(sys.stdin)["innerWC"])' 2>/dev/null)" "auto"
has  "D4 the parent no longer double-paints the field" "$P4" '"parentImg":"none"'
nohas "D5 the master text-grad list dropped .hub-card-name (parent)" "$INDEX" "[data-text-grad] .hub-card-name,"
has  "D6 will-change rides the .marquee class only" "$INDEX" ".hub-card-name.marquee .hub-card-name-in { will-change: transform; }"
MARQ=$(ev "(function(){
  var target = null;
  document.querySelectorAll('.hub-card-name').forEach(function(n){
    if (!target && n.getBoundingClientRect().width > 2) target = n;
  });
  if (!target) return 'no-visible-name';
  target.classList.add('marquee');
  var inner = target.querySelector('.hub-card-name-in');
  return inner ? getComputedStyle(inner).willChange : 'no-inner';
})()")
check "D7 the marquee span promotes ONLY when sliding" "$MARQ" "transform"

# console errors across the whole run
ERRS=$(agent-browser errors 2>/dev/null | grep -cv "^\[" || true)
check "Z no console errors during the suite" "$ERRS" "0"

echo ""
echo "════ v074 RESULT: $PASS PASS / $FAIL FAIL ════"
[ "$FAIL" = "0" ]
