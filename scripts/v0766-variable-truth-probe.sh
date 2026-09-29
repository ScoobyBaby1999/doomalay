#!/bin/bash
# v0766-variable-truth-probe.sh — THE LIVE LEAK AUDIT (diagnostic, red-team)
# Sentinel gradients: border=#ff0055 · surface-1=#0044cc · surface-2=#00cc55.
# Walks every element of every named surface; scripts/v0766-auditor.js does
# the classification (see its header for the leak classes).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8301
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0766probe
export AGENT_BROWSER_SESSION=doomalay-v0766

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
report() { python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    d = json.loads(s)
    print('  leaks:', d['leakCount'])
    for l in d['leaks']: print('   •', l)
    for sc in d.get('scrollsWithFields', []): print('   ◇ scroll:', sc)
except Exception as e:
    print('   RAW:', s[:700])
"; }

rm -rf $DATA; mkdir -p $DATA
python3 scripts/v074-mock-hub-longname.py 8302 >/tmp/v0766-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:8302
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v0766-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "ENGINE BOOT FAIL"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# ── the sentinel theme ──
ev "(function(){
  Settings.setState({themeOverrides:{midnight:{
    '--border':      {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45},
    '--surface-1':   {colors:['#0044cc','#4488ff'],dir:'diag',angle:45},
    '--surface-2':   {colors:['#00cc55','#66ff99'],dir:'diag',angle:45}
  }}});
  return 'sentinels live';
})()" >/dev/null; sleep 1.2

# arm the auditor (a file read keeps the JS escaping sane)
AUD=$(cat scripts/v0766-auditor.js)
agent-browser eval "$AUD" >/dev/null

echo "══ S1: settings open (panel + collapsibles + color scroll boxes) ══"
ev "(function(){ var b = document.getElementById('settings-btn'); if (b) b.click(); return 'gear'; })()" >/dev/null; sleep 1.5
ev "window.__audit('settings')" | report

echo "══ S2: the + quick menu (send menu) ══"
ev "(function(){ var m = document.getElementById('chat-send-more'); if (m) { m.click(); return 'menu'; } return 'no-send-more'; })()" >/dev/null; sleep 0.8
ev "window.__audit('send-menu')" | report
ev "(function(){ var m = document.getElementById('chat-send-more'); if (m) m.click(); return 'closed'; })()" >/dev/null; sleep 0.4

echo "══ S3: the + model picker (ConnectOverlay cards) ══"
ev "(function(){ if (window.ModelPicker) { window.ModelPicker.open(function(){}); return 'picker'; } return 'no-picker'; })()" >/dev/null; sleep 1.2
ev "window.__audit('model-picker')" | report

echo "══ S4: the + sandbox picker ══"
ev "(function(){ if (window.ConnectOverlay) window.ConnectOverlay.close(); if (window.SandboxPicker) { window.SandboxPicker.open(function(){}); return 'sbx'; } return 'no-sbx'; })()" >/dev/null; sleep 1.2
ev "window.__audit('sandbox-picker')" | report
ev "(function(){ if (window.ConnectOverlay) window.ConnectOverlay.close(); return 'closed'; })()" >/dev/null; sleep 0.4
echo "── trace: document.URL after S4 ──"
agent-browser eval "document.URL" 2>&1 | head -1

echo "══ S5: the library hub sheet (panel open + Hub.open, the suite flow) ══"
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Probe Bot","sandbox":"quick","model":"privatemodeai/mock-pm","provider":"privatemodeai"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Probe Bot',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser eval "$AUD" >/dev/null   # re-arm the auditor after the reload
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
ev "window.Hub.open(undefined, {chat: {sessionId: '$SID', title: 'Probe Bot', name: 'Probe Bot'}}); 'opened'" >/dev/null; sleep 2.5
ev "(function(){ var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); if (p) p.click(); return 'picked'; })()" >/dev/null; sleep 2.5
ev "window.__audit('hub')" | report

echo "══ S5b: a hub bundle detail (the bunch view) ══"
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch], .hub-card'); if (b) { b.click(); return 'card'; } return 'no-card'; })()" >/dev/null; sleep 2.5
ev "window.__audit('hub-bunch')" | report

echo "══ S6: pixel proof — the sentinel shot (bunch view on screen) ══"
agent-browser screenshot /tmp/v0766-sentinel.png >/dev/null 2>&1
python3 - << 'PYEOF'
from PIL import Image
img = Image.open('/tmp/v0766-sentinel.png').convert('RGB')
w, h = img.size
sents = {'border': (255, 0, 85), 's1': (0, 68, 204), 's2': (0, 204, 85)}
def classify(p):
    best, bd = None, 1e9
    for k, s in sents.items():
        d = sum((a - b) ** 2 for a, b in zip(p, s))
        if d < bd: bd, best = d, k
    return best if bd < 6000 else None
from collections import Counter
c = Counter()
for x in range(0, w, 20):
    for y in range(0, h, 20):
        k = classify(img.getpixel((x, y)))
        if k: c[k] += 1
total = (w // 20 + 1) * (h // 20 + 1)
print('  sampled grid %d pts, sentinel-family hits:' % total, dict(c))
print('  (all three families present = the coherent projection; any')
print('   family covering a majority of the screen = a flood)')
PYEOF

echo "══ console errors ══"
agent-browser errors 2>/dev/null | head -5 || true
