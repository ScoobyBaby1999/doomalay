#!/bin/bash
# v0854-pixi-world-test.sh — THE PERF WAVE, PHASE 3 (user spec verbatim:
#   "Please if u may implement phases 1-3. To make everything more
#    responsive and achieve a higher fps" — this rig proves Phase 3:
#    the PixiJS world layer: icons as GPU sprites + atom stars with
#    zIndex depth, the DOM kept as the input layer).
#
# v0.88 THE EVOLUTION (the root-fps wave): the rig's headless Chromium
# runs SwiftShader — exactly the software-GL world the GL-SPEED GATE
# exists for — so the contract grows and reorders:
#  (0) THE GL-SPEED GATE — auto + 65 entities on a SOFTWARE GL → the
#      layer NEVER activates (dom icons, the verdict published on
#      DoomalayPerf.world, the sticky verdict in localStorage).
#  (1) FORCED 'on' — the layer contract under force (the gate must not
#      block the user's explicit choice): webgl renderer, sprites === 65,
#      textures ≥ 1, the #c3 canvas at z-index 100 pointer-events none,
#      #chatbots.pixi3d hit-targets opacity 0.
#  (2) INPUT — elementFromPoint at an icon center returns the .chatbot
#      hit-target; a synthetic DRAG moves the entity AND the mirror
#      follows (the driver reads live x/y — update()'s poke lights it).
#  (3) THE ATOMS IN PIXI + THE ON-DEMAND DRIVER — a bound workspace →
#      star sprites > 0 and the driver REPORTS 'running' (stars orbit);
#      unbinding (setCount 0) → the driver falls to 'resting' (zero
#      frames at rest — THE measured 18fps-at-rest fix).
#  (4) THE THRESHOLD GATE (fake-hardware sticky) — with a hardware
#      verdict planted, auto + 65 → active; 10 icons + reload →
#      deactivate + the DOM icons return (opacity 1, no .pixi3d, #c3
#      gone) + one repaint restores the #c2 stars.
#  (5) THE FORCED OFF — worldLayer 'off' → inactive + DOM path.
#  (6) THE THEME — a theme switch while active re-rasters (sprites stay
#      === entities).
#  (7) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8354
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0854
export AGENT_BROWSER_SESSION=doomalay-v0854

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
# a FRESH browser for the run: the session profile persists TABS across
# runs — stale tabs (old page instances mid-navigation) answer evals with
# SyntaxError/empty and make every seed land on the wrong document.
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0854-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v0854sess","title":"World","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or d.get('Id') or '')")
[ -n "$SID" ] && echo "session: $SID" || { echo "SESSION CREATE FAIL"; exit 1; }

seed_icons() { # $1 = count, $2 = with-session?
  python3 - "$1" "$2" "$SID" <<'PYEOF'
import sys, json
n = int(sys.argv[1]); with_sid = sys.argv[2] == 'yes'; sid = sys.argv[3]
icons = []
for i in range(n):
    icons.append({
        'type': 'chat', 'id': 'chat_p%d' % i, 'name': 'P%d' % i,
        'family': 'default', 'iconIndex': -1,
        'x': 90 + (i % 10) * 150, 'y': 90 + (i // 10) * 170,
        'sessionId': (sid if (with_sid and i == 0) else '')
    })
print(json.dumps({'offset': {'x': 0, 'y': 0}, 'scale': 1, 'icons': icons}))
PYEOF
}

echo "── (0) THE GL-SPEED GATE: auto + 65 + software GL → dom icons"
agent-browser open "$BASE" >/dev/null 2>&1; sleep 1.2
# wipe the profile's localStorage so every run boots from deterministic
# ground (this also clears any stale glgate sticky from earlier runs)
ev "localStorage.clear(); 'cleared'" >/dev/null
ev "$(seed_icons 65 yes | python3 -c "
import sys, json
print(\"localStorage.setItem('doomalay.state.v2', JSON.stringify(%s)); 'ok'\" % json.dumps(json.load(sys.stdin)))")" >/dev/null
agent-browser reload >/dev/null 2>&1
sleep 2.6   # boot + the GL probe (SwiftShader on the headless rig) + evaluate
# FLAT values (no nested JSON strings — the sticky's escaped quotes break
# the naive shell embedding)
G1=$(ev "(function(){var w=window.World3D?window.World3D.debug():{}; var st=null; try{st=JSON.parse(localStorage.getItem('doomalay.glgate.v1')||'null')}catch(e){} return JSON.stringify({active: !!w.active, perf: String((window.DoomalayPerf||{}).world||''), stickySoftware: st? !!st.software : false, stickyRenderer: st? String(st.renderer||'') : ''})})()")
ck "auto + software GL → the layer NEVER activates" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$G1''')
    print('yes' if not d.get('active') else 'no')
except Exception: print('no')")" "$G1"
ck "the verdict publishes on DoomalayPerf.world (software gl named)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$G1''')
    print('yes' if 'software gl' in str(d.get('perf','')) else 'no')
except Exception: print('no')")" "$G1"
ck "the sticky verdict lives in localStorage (doomalay.glgate.v1)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$G1''')
    print('yes' if d.get('stickySoftware') and d.get('stickyRenderer') else 'no')
except Exception: print('no')")" "$G1"
DOMPATH=$(ev "(function(){var l=document.getElementById('chatbots'); var any=document.querySelector('.chatbot'); return JSON.stringify({cls: l?l.className:'nolayer', op: any?getComputedStyle(any).opacity:'noicon', c3: !!document.getElementById('c3')})})()")
ck "the DOM icon path stays (opacity 1, no .pixi3d, no #c3)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$DOMPATH''')
    ok = 'pixi3d' not in d.get('cls','') and abs(float(d.get('op',0))-1)<0.01 and not d.get('c3')
    print('yes' if ok else 'no')
except Exception: print('no')")" "$DOMPATH"

echo "── (1) forced 'on' — the layer contract under force"
ev "Settings.setState({worldLayer:'on'}); 'ok'" >/dev/null
sleep 2.4   # the lazy pixi.min.js injection + Application.init + sync
D1=$(ev "JSON.stringify(window.World3D ? window.World3D.debug() : {active:false, missing:true})")
ck "World3D active + webgl renderer (forced through the gate)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D1''')
    print('yes' if d.get('active') and 'webgl' in str(d.get('renderer','')) else 'no')
except Exception: print('no')")" "$D1"
ck "sprites === 65 entities (the mirror)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D1''')
    print('yes' if d.get('sprites')==65 and d.get('entities')==65 else 'no')
except Exception: print('no')")" "$D1"
ck "textures rasterized (≥ 1, one per icon)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D1''')
    print('yes' if (d.get('textures') or 0)>=1 else 'no')
except Exception: print('no')")" "$D1"
CHROME=$(ev "(function(){var c3=document.getElementById('c3'); var l=document.getElementById('chatbots'); var any=document.querySelector('.chatbot'); return JSON.stringify({c3: c3 ? (getComputedStyle(c3).zIndex + '/' + getComputedStyle(c3).pointerEvents) : 'missing', cls: l ? l.className : 'nolayer', op: any ? getComputedStyle(any).opacity : 'noicon'})})()")
ck "#c3 at z100/pointer-events:none + #chatbots.pixi3d + hit-targets opacity 0" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$CHROME''')
    ok = d.get('c3','').startswith('100/') and d.get('c3','').endswith('/none') and 'pixi3d' in d.get('cls','') and abs(float(d.get('op',1))) < 0.01
    print('yes' if ok else 'no')
except Exception: print('no')")" "$CHROME"
PERFW=$(ev "JSON.stringify((window.DoomalayPerf||{}).world || '')")
ck "DoomalayPerf.world says pixi + names the forced software GL honestly" \
   "$(python3 -c "
import json
try:
    s=json.loads('''$PERFW''')
    print('yes' if 'pixi' in str(s) and 'software gl' in str(s) else 'no')
except Exception: print('no')")" "$PERFW"

echo "── (2) input stays DOM + the sprite follows"
HIT=$(ev "(function(){var el=document.elementFromPoint(240,90); return el ? (el.closest('.chatbot') ? 'icon' : el.tagName) : 'none'})()")
ck "elementFromPoint at an icon → the .chatbot hit-target" "$([ "$HIT" = "icon" ] && echo yes || echo no)" "$HIT"
# find the icon at that spot + drag it; sample the sprite position across frames
DRAG=$(ev "(function(){
  var icon = window.doomalay.findIconForSession('$SID');
  if (!icon) return 'noicon';
  window.__sx0 = icon.x; window.__sid = icon.id;
  var el = icon.el;
  function md(x,y){document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  function mm(x,y){window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  function mu(x,y){document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
  var sx = icon.x, sy = icon.y;   // camera rests at origin, scale 1
  md(sx,sy); mm(sx-45,sy+30); mm(sx-85,sy+70); mm(sx-92,sy+76); mu(sx-92,sy+76);
  icon.vx = 0; icon.vy = 0;   // no fling — the collision cascade pegs the thread
  return 'dragged'})()")
ck "the drag found + moved the entity" "$([ "$DRAG" = "dragged" ] && echo yes || echo no)" "$DRAG"
sleep 1.0
FOLLOW=$(ev "(function(){
  var d = window.World3D.debug();
  var icon = window.doomalay.findIconForSession('$SID');
  return JSON.stringify({moved: icon && Math.abs(icon.x - window.__sx0) > 30, sprites: d.sprites})
})()")
ck "the entity moved AND the mirror stayed live (sprites intact)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$FOLLOW''')
    print('yes' if d.get('moved') and d.get('sprites')==65 else 'no')
except Exception: print('no')")" "$FOLLOW"

echo "── (3) the atoms in pixi + THE ON-DEMAND DRIVER"
curl -s -X POST $BASE/api/workspaces/device -H 'Content-Type: application/json' \
  -d "{\"name\":\"dev ws 1\",\"session_id\":\"$SID\"}" >/dev/null
curl -s -X POST $BASE/api/workspaces/device -H 'Content-Type: application/json' \
  -d "{\"name\":\"dev ws 2\",\"session_id\":\"$SID\"}" >/dev/null
ev "window.Atoms.refresh(window.doomalay.findIconForSession('$SID'))" >/dev/null
sleep 1.2
A1=$(ev "JSON.stringify(window.World3D.debug())")
ck "star sprites minted (a bound workspace → stars > 0)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$A1''')
    print('yes' if (d.get('stars') or 0)>0 else 'no')
except Exception: print('no')")" "$A1"
ck "the DRIVER runs while stars orbit (driver: running)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$A1''')
    print('yes' if d.get('driver')=='running' else 'no')
except Exception: print('no')")" "$A1"
OWNED=$(ev "JSON.stringify({owned: window.World3D.atomsOwned(), world: (window.DoomalayPerf||{}).world})")
ck "the world layer owns the atoms (worker #c2 pass off)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$OWNED''')
    print('yes' if d.get('owned') and 'pixi' in str(d.get('world','')) else 'no')
except Exception: print('no')")" "$OWNED"
# THE REST PROOF: quiet any residual physics, then unbind the workspaces →
# the stars die → nothing moves → the driver must fall asleep (the
# measured 18fps-at-rest regression). v0.88 also fixes the v0.87.2 latent
# (the star-destroy path threw on st.destroy → stale stars forever).
ev "window.doomalay.world.entities.forEach(function(e){e.vx=0;e.vy=0;}); 'quiet'" >/dev/null
sleep 0.6
ev "window.Atoms.setCount('$SID', 0); 'unbind'" >/dev/null
sleep 1.4
REST=$(ev "JSON.stringify(window.World3D.debug())")
ck "atoms unbound → the stars die + the driver RESTS (zero frames at rest)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$REST''')
    print('yes' if d.get('driver')=='resting' and (d.get('stars') or 0)==0 else 'no')
except Exception: print('no')")" "$REST"

echo "── (4) the threshold gate (a planted hardware verdict)"
ev "window.doomalay.world.entities.forEach(function(e){e.vx=0;e.vy=0;}); 'quiet'" >/dev/null
sleep 1.0
JS65=$(seed_icons 65 yes | python3 -c "
import sys, json
print(\"localStorage.setItem('doomalay.state.v2', JSON.stringify(%s)); 'ok'\" % json.dumps(json.load(sys.stdin)))")
# the reload's pagehide flushSave re-writes the settings AFTER any clear
# (worldLayer 'on' from the forced tests would stick) — so the seed plants
# BOTH keys explicitly: the state AND the settings (worldLayer auto).
FAKEHW="localStorage.setItem('doomalay.glgate.v1', JSON.stringify({software:false, renderer:'rig-fake-gpu'})); localStorage.setItem('doomalay.settings.v1', JSON.stringify({worldLayer:'auto'})); 'hw'"
ev "localStorage.clear(); 'cleared'" >/dev/null
ev "$JS65" >/dev/null
ev "$FAKEHW" >/dev/null
agent-browser reload >/dev/null 2>&1
sleep 2.6
D2=$(ev "JSON.stringify(window.World3D ? window.World3D.debug() : {active:false})")
ck "hardware verdict + auto + 65 → the layer ACTIVATES (threshold gate)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D2''')
    print('yes' if d.get('active') and d.get('sprites')==65 else 'no')
except Exception: print('no')")" "$D2"
# below the threshold: quiet the world, let the last save land, re-seed 10
ev "window.doomalay.world.entities.forEach(function(e){e.vx=0;e.vy=0;}); 'quiet'" >/dev/null
sleep 1.0
JS10=$(seed_icons 10 yes | python3 -c "
import sys, json
print(\"localStorage.setItem('doomalay.state.v2', JSON.stringify(%s)); 'ok'\" % json.dumps(json.load(sys.stdin)))")
agent-browser eval "$JS10" >/dev/null 2>&1
agent-browser reload >/dev/null 2>&1
sleep 2.2
# a pending 200ms layout save from the pre-reload page can race the seed —
# verify the restore took, re-seed once if it lost
N10=$(ev "(window.doomalay && window.doomalay.world) ? window.doomalay.world.entities.length : -1")
if [ "$N10" != "10" ]; then
  sleep 0.8
  agent-browser eval "window.doomalay.world.entities.forEach(function(e){e.vx=0;e.vy=0;}); 'quiet'" >/dev/null 2>&1
  sleep 0.9
  agent-browser eval "$JS10" 2>&1 | tr -d '\n' | head -c 60; echo ""
  agent-browser reload >/dev/null 2>&1
  sleep 2.2
fi
# the pre-reload page's pagehide flushSave may have re-written the 'on'
# setting — plant 'auto' on the LIVE page (its own flush now saves auto)
# and reload once more so the boot truly evaluates the auto gate at 10
ev "Settings.setState({worldLayer:'auto'}); 'auto'" >/dev/null
agent-browser reload >/dev/null 2>&1
sleep 2.2
D3=$(ev "JSON.stringify(window.World3D ? window.World3D.debug() : {active:false})")
CHROME2=$(ev "(function(){var l=document.getElementById('chatbots'); var any=document.querySelector('.chatbot'); return JSON.stringify({cls: l?l.className:'nolayer', op: any?getComputedStyle(any).opacity:'noicon', c3: !!document.getElementById('c3')})})()")
ck "10 icons → the layer deactivates (auto gate)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D3''')
    print('yes' if not d.get('active') else 'no')
except Exception: print('no')")" "$D3"
ck "the DOM icons return (opacity 1, no .pixi3d, #c3 gone)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$CHROME2''')
    ok = 'pixi3d' not in d.get('cls','') and abs(float(d.get('op',0))-1)<0.01 and not d.get('c3')
    print('yes' if ok else 'no')
except Exception: print('no')")" "$CHROME2"

echo "── (5) the forced off"
ev "Settings.setState({worldLayer:'on'}); 'ok'" >/dev/null
sleep 1.8
D4=$(ev "JSON.stringify(window.World3D.debug())")
ck "worldLayer 'on' with 10 icons → active" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D4''')
    print('yes' if d.get('active') and d.get('sprites')==10 else 'no')
except Exception: print('no')")" "$D4"
ev "Settings.setState({worldLayer:'off'}); 'ok'" >/dev/null
sleep 1.2
D5=$(ev "JSON.stringify(window.World3D.debug())")
ck "worldLayer 'off' → inactive immediately" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$D5''')
    print('yes' if not d.get('active') else 'no')
except Exception: print('no')")" "$D5"

echo "── (6) the theme re-raster"
ev "Settings.setState({worldLayer:'on'}); 'ok'" >/dev/null
sleep 1.6
T0=$(ev "JSON.stringify(window.World3D.debug())")
ev "Settings.setState({theme:'nebula'}); 'ok'" >/dev/null
sleep 1.6
T1=$(ev "JSON.stringify(window.World3D.debug())")
ck "theme switch while active: sprites stay === entities (re-raster, no loss)" \
   "$(python3 -c "
import json
try:
    a=json.loads('''$T0'''); b=json.loads('''$T1''')
    print('yes' if b.get('active') and b.get('sprites')==a.get('sprites')==10 and (b.get('textures') or 0)>=1 else 'no')
except Exception: print('no')")" "$T0 → $T1"
ev "Settings.setState({theme:'midnight', worldLayer:'auto'}); 'ok'" >/dev/null

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
echo "════ v0854 PHASE 3 (v0.88 evolved): $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
