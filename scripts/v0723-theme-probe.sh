#!/bin/bash
# v0723-theme-probe.sh — THE TILING PROBE (v0.72.3a, diagnostic)
#
# User spec: "background and especially surface raised have a lot of
# tiling issues as elements in the screen repeat the gradient over and
# over instead of applying and rendering a single projection that fits
# the screen like how other colors like the accents work."
#
# The hypothesis: the projection model (background-attachment: fixed)
# degrades inside #chat-panel — the sheet is positioned with
# transform: translate3d, and a transformed ancestor changes how
# fixed-attachment backgrounds resolve. This probe measures WHAT
# ACTUALLY HAPPENS, pixel-wise:
#   · a 6-stop VERTICAL gradient on --surface-2 (top red → bottom
#     violet: the on-screen position unambiguously determines color)
#   · same-class pills inside the panel at very different heights
#   · pixel-sample each pill's top/middle/bottom:
#     PROJECTION = the higher pill reads warm, the lower reads cool,
#     each pill internally thin; TILING = both pills sweep the whole
#     palette internally and their tops match.
#
# Usage: bash scripts/v0723-theme-probe.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
DATA=/tmp/doomalay-v0723-probe
PORT=8296
BASE=http://127.0.0.1:$PORT
export AGENT_BROWSER_SESSION=doomalay-v0723-probe
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

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0723p-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || { bad "engine boot"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Probe Bot","sandbox":"quick"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Probe Bot',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
check_open=$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")
[ "$check_open" = "open" ] && ok "the panel opened" || { bad "the panel would not open"; exit 1; }

# THE PROBE PALETTE: 6 stops, vertical (v) — top #ff0000 … bottom #8b00ff
PAL="['#ff0000','#ff5500','#ffaa00','#00aaff','#5500ff','#8b00ff']"
ev "Settings.setState({themeOverrides:{midnight:{'--surface-2':{colors:$PAL,dir:'v'}}}})" >/dev/null
sleep 1

# INJECT the probe pills — two Layer-3 inputs (input[type=text] rides
# the surface-2 projection rule), pinned to the panel body's top and
# bottom. Deterministic targets beat hunting for real chrome on an
# empty chat.
INFO=$(ev "(function(){
  var root = document.getElementById('chat-root') || document.querySelector('#chat-panel .panel-body');
  if (!root) return JSON.stringify({panel: null, pills: []});
  root.style.position = 'relative';
  ['top','bottom'].forEach(function(pos){
    var old = document.getElementById('probe-' + pos);
    if (old) old.remove();
    var el = document.createElement('input');
    el.type = 'text'; el.id = 'probe-' + pos;
    el.style.cssText = 'position:absolute;left:20px;width:300px;height:44px;z-index:9999;' +
      (pos === 'top' ? 'top:60px' : 'bottom:80px');
    root.appendChild(el);
  });
  var panel = document.getElementById('chat-panel');
  var pr = panel.getBoundingClientRect();
  var pills = Array.prototype.map.call(document.querySelectorAll('#chat-panel #probe-top, #chat-panel #probe-bottom'), function(e){
    var r = e.getBoundingClientRect();
    return {cls: e.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  });
  return JSON.stringify({panel: {y: Math.round(pr.y), h: Math.round(pr.height), transform: getComputedStyle(panel).transform.slice(0,24)}, pills: pills});
})()")
echo "PANEL-INFO: $INFO"
echo "$INFO" > /tmp/v0723-info.json

agent-browser screenshot /tmp/v0723-probe.png >/dev/null 2>&1
python3 scripts/v0723-sample.py > /tmp/v0723-samples.json
echo "PILL-SAMPLES: $(cat /tmp/v0723-samples.json)"

VERDICT=$(python3 scripts/v0723-verdict.py)
echo "VERDICT: $VERDICT"
V=$(echo "$VERDICT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
echo
echo "════════════════════════════════════════════════"
echo " THE PROJECTION INSIDE THE TRANSFORMED PANEL: $V"
echo "════════════════════════════════════════════════"
