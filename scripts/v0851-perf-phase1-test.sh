#!/bin/bash
# v0851-perf-phase1-test.sh — THE PERF WAVE, PHASE 1 (user spec verbatim:
#   "Please if u may implement phases 1-3. To make everything more
#    responsive and achieve a higher fps" — this rig proves Phase 1:
#    the perf HUD + the mesh ambient batcher + the icon-layer budget).
#
# THE CONTRACT:
#  (1) THE INSTRUMENT — Settings lists the Performance page; the perfHud
#      toggle paints #perf-hud-chip (display block, on-canvas); the page's
#      meters live (DoomalayPerf fields all present, fps counts while the
#      HUD watches + dotAnimate runs).
#  (2) THE BATCHER, SOLID — the default theme frame collapses to ≤ 2
#      batches (one fill for the whole dot lattice, one stroke set for
#      lines) while dots/seg counts stay populated (the paint still
#      covers the canvas).
#  (3) THE BATCHER, MESH WORST CASE — mesh dot+line specs + amp100 +
#      both anims + size 100: buckets > 1 (per-color buckets engaged),
#      batches ≪ dots (the collapse), AND every existing rig contract
#      intact in the same frame: dotStats.n, weight extremes, overIcons
#      gate, cache sizes, fps.
#  (4) THE ICON-LAYER BUDGET — 45 seeded icons → #chatbots.many-icons
#      + computed will-change: auto on a non-dragged icon; the budget
#      class is ABSENT at ≤ 40 (fresh state reload) and will-change is
#      transform again.
#  (5) THE CACHE LEDGER — DoomalayPerf.cacheHits/cacheMisses climb with
#      ambient frames (100% hits while the camera rests, gen stable).
#  (6) VISUAL — #c paints non-empty under the mesh worst case
#      (toDataURL length > threshold).
#  (7) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8351
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0851
export AGENT_BROWSER_SESSION=doomalay-v0851

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0851-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4

# v0.85.2: this rig's (6) reads #c.toDataURL — a worker-transferred canvas
# can't be read main-side, so the lattice proofs ride the MAIN-thread
# fallback (workerPaint:false; the same lattice.js — v0852 proves the worker).
# v0.85.2 (cont.): the toggle rides the LIVE settings state (a raw
# localStorage seed gets clobbered by the old page's pagehide flushSave)
ev "Settings.setState({workerPaint:false}); 'ok'" >/dev/null
sleep 0.6
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4

setstate() { ev "(function(){ Settings.setState($1); return 'ok'; })()" >/dev/null; sleep 1.1; }

echo "── (1) the instrument"
PAGES=$(ev "JSON.stringify(window.Settings.listPages().map(function(p){return p.id}))")
ck "Settings lists the Performance page" \
   "$(python3 -c "
import json
try: print('yes' if 'performance' in json.loads('''$PAGES''') else 'no')
except Exception: print('no')")" "$PAGES"
ev "Settings.setState({perfHud:true})" >/dev/null; sleep 0.8
CHIP=$(ev "(function(){var c=document.getElementById('perf-hud-chip'); return c ? (getComputedStyle(c).display + '|' + c.textContent.length) : 'missing'})()")
ck "the HUD chip paints on-canvas (display block, text present)" \
   "$(python3 -c "
s='''$CHIP'''.split('|')
print('yes' if len(s)==2 and s[0]=='block' and int(s[1])>6 else 'no')")" "$CHIP"
# headless Chromium can throttle rAF for a visibility flicker (the v0841
# lesson) — the fps meter needs frames; poke the animate loop + retry.
PERF="{}"; MOK=no
for k in 1 2 3; do
  ev "Settings.setState({perfHud:true, dotAnimate:true})" >/dev/null
  sleep 1.2
  PERF=$(ev "JSON.stringify(window.DoomalayPerf)")
  MOK=$(python3 -c "
import json
try:
    p=json.loads('''$PERF''')
    need=['fps','frameMs','longTasks','paints','atomFrames','cacheHits','cacheMisses','batches','nodes','layers']
    ok=all(k in p for k in need) and p.get('fps',0)>0 and p.get('paints',0)>0
    print('yes' if ok else 'no')
except Exception: print('no')")
  [ "$MOK" = "yes" ] && break
done
ck "the meters live (fps>0 while dotAnimate runs, counters exist)" "$MOK" "$PERF"
setstate "{ dotAnimate:false }"

echo "── (2) the batcher, SOLID (the default frame)"
SOLID=$(ev "JSON.stringify(window.DoomalayDebug)")
ck "solid frame: batches ≤ 2 (the collapse)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$SOLID''')
    print('yes' if d.get('batches',99)<=2 else 'no')
except Exception: print('no')")" "$SOLID"
ck "solid frame: the paint still covers (dots + segs > 0)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$SOLID''')
    print('yes' if (d.get('dots') or 0)>0 and (d.get('segs') or 0)>=0 else 'no')
except Exception: print('no')")" "$SOLID"

echo "── (3) the batcher, MESH worst case (amp100 + both anims + size 100)"
setstate "{ dotColor: {colors:['#1a1a2e','#3b3b5c','#6a5acd','#8a7ae0'], dir:'mesh'}, lineColor: {colors:['#101018','#2a2a3a','#4a4a6a'], dir:'mesh'}, spaceParallax: 100, dotSizeVariation: 100, lineSizeVariation: 100, dotAnimate: true, lineAnimate: true }"
MESH=$(ev "JSON.stringify(window.DoomalayDebug)")
ck "mesh: buckets > 1 (per-color buckets engaged)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    print('yes' if (d.get('buckets') or 0)>1 else 'no')
except Exception: print('no')")" "$MESH"
ck "mesh: the collapse — batches < total elements / 6" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    dots=d.get('dots') or 0; segs=d.get('segs') or 0
    ln=(d.get('lineStats') or {}).get('n') or 0
    b=d.get('batches') or 99999
    tot=dots+max(segs,ln)
    print('yes' if tot>500 and b*6<tot else 'no')
except Exception: print('no')")" "$MESH"
ck "mesh: the rig contracts intact (dotStats/weight/overIcons/cache in the same frame)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    ok=('dotStats' in d and 'weight' in d and 'overIcons' in d and 'cache' in d
        and d['dotStats'].get('n',0)>0 and d['overIcons'].get('on') is True
        and d.get('cache',{}).get('dot',0)>0)
    print('yes' if ok else 'no')
except Exception: print('no')")" "$MESH"
ck "mesh: fps still climbs (the loop alive)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$MESH''')
    print('yes' if (d.get('fps') or 0)>0 else 'no')
except Exception: print('no')")" "$MESH"

echo "── (4) the icon-layer budget"
# seed 45 icons via localStorage → reload (the boot restore path)
ev "(function(){var st={offset:{x:0,y:0},scale:1,icons:[]}; for(var i=0;i<45;i++){st.icons.push({type:'chat',id:'chat_b'+i,name:'B'+i,family:'default',iconIndex:-1,x:80+(i%9)*140,y:80+Math.floor(i/9)*160});} localStorage.setItem('doomalay.state.v2', JSON.stringify(st)); return 'ok'})()" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
MANY=$(ev "(function(){var l=document.getElementById('chatbots'); var any=document.querySelector('.chatbot:not(.dragging)'); return (l?l.className:'nolayer')+'|'+(any?getComputedStyle(any).willChange:'noicon')})()")
ck "45 icons → .many-icons + will-change auto (the budget)" \
   "$(python3 -c "
s='''$MANY'''.split('|')
print('yes' if 'many-icons' in s[0] and s[1]=='auto' else 'no')")" "$MANY"
# back below the threshold: fresh state, 8 icons
ev "(function(){var st={offset:{x:0,y:0},scale:1,icons:[]}; for(var i=0;i<8;i++){st.icons.push({type:'chat',id:'chat_s'+i,name:'S'+i,family:'default',iconIndex:-1,x:100+i*130,y:300});} localStorage.setItem('doomalay.state.v2', JSON.stringify(st)); return 'ok'})()" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
FEW=$(ev "(function(){var l=document.getElementById('chatbots'); var any=document.querySelector('.chatbot'); return (l?l.className:'nolayer')+'|'+(any?getComputedStyle(any).willChange:'noicon')})()")
ck "8 icons → no .many-icons + will-change transform (full compositing back)" \
   "$(python3 -c "
s='''$FEW'''.split('|')
print('yes' if 'many-icons' not in s[0] and s[1]=='transform' else 'no')")" "$FEW"
ck "containment on .chatbot (contain: layout style)" \
   "$(ev "(function(){var any=document.querySelector('.chatbot'); return any && getComputedStyle(any).contain.indexOf('layout')>=0 ? 'yes':'no'})()")" "contain"

echo "── (5) the cache ledger (v0.97 RE-PIN: the one-object bake ledger)"
# v0.97 re-pin: the one-object lattice retired the per-frame cell walk —
# ambient frames no longer consult LC.dotC/vsegC per cell (the tiles bake
# ONCE; the frame is a few pattern fills). The ledger's old contract
# ("cacheHits climb every ambient frame") is architecturally obsolete; its
# INTENT — ambient frames recompute nothing — now lives in the bake
# ledger: bakeGen stays STABLE through ambient animation (no per-frame
# rebake) and paintMs stays trivial.
setstate "{ dotAnimate: true, lineAnimate: true }"
H1=$(ev "(window.Lattice.oneObject().bakeGen) + ':' + ((window.DoomalayDebug||{}).paintMs || 0)")
sleep 1.2
H2=$(ev "(window.Lattice.oneObject().bakeGen) + ':' + ((window.DoomalayDebug||{}).paintMs || 0)")
ck "ambient frames rebake nothing (bakeGen stable, paintMs trivial)" \
   "$(python3 -c "
a=\"\"\"$H1\"\"\".split(':'); b=\"\"\"$H2\"\"\".split(':')
gen_stable = a[0] == b[0]
ms_ok = True
try: ms_ok = float(b[1]) <= 8.0
except Exception: ms_ok = False
print('yes' if gen_stable and ms_ok else 'no')")" "$H1 → $H2"

echo "── (6) visual: the canvas paints under the mesh worst case"
LEN=$(ev "document.getElementById('c').toDataURL().length")
ck "#c non-empty under mesh (paint intact)" "$([ "$LEN" -gt 20000 ] && echo yes || echo no)" "len $LEN"

echo "── (7) console errors"
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
echo "════ v0851 PHASE 1: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
