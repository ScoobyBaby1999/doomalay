#!/bin/bash
# v0766-variable-truth-test.sh — THE VARIABLE TRUTH SUITE (v0.76.6)
#
# The user's report: "the surface raised still bleeds into scroll boxes
# that are regularly colored by surface, and overlaps them, same with
# border, changing it to a gradient also bleeds Into many things, like
# the entire background of panels, the entire message box and surrounding
# pills, the background of the + model and + sandbox." The plate system
# (v0.76.3) + the ink gates (v0.76.5) claim it dead; this suite LOCKS it:
# sentinel gradients per variable (border=#ff0055 · s1=#0044cc · s2=#00cc55),
# then every element of every named surface is classified (auditor in
# scripts/v0766-auditor.js) + a pixel proof (rings, not floods) + THE
# HISTORY FLOOR (the about:blank kill: +model → close → +sandbox → close,
# twice — the URL must never leave the app).
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
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1 (got: ${2:-?})"; }
report() { python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    d = json.loads(s)
    print('LEAKCOUNT:' + str(d['leakCount']))
    for l in d['leaks']: print('  LEAK:', l)
except Exception as e:
    print('LEAKCOUNT:parse-error')
" | while IFS= read -r line; do
  case "$line" in
    LEAKCOUNT:0) ok "zero leaks on this surface" ;;
    LEAKCOUNT:parse-error) bad "audit parse" ;;
    LEAKCOUNT:*) bad "leaks found" "$line" ;;
    *) echo "$line" ;;
  esac
done; }

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
echo "── settings (panel + collapsibles + color scroll boxes)" >/dev/null; L=$(ev "window.__audit('settings')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S1 settings: zero leaks" || bad "S1 settings leaks" "$L"

echo "══ S2: the + quick menu (send menu) ══"
ev "(function(){ var m = document.getElementById('chat-send-more'); if (m) { m.click(); return 'menu'; } return 'no-send-more'; })()" >/dev/null; sleep 0.8
L=$(ev "window.__audit('send-menu')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S2 send menu: zero leaks" || bad "S2 send menu leaks" "$L"
ev "(function(){ var m = document.getElementById('chat-send-more'); if (m) m.click(); return 'closed'; })()" >/dev/null; sleep 0.4

echo "══ S3: the + model picker (ConnectOverlay cards) ══"
ev "(function(){ if (window.ModelPicker) { window.ModelPicker.open(function(){}); return 'picker'; } return 'no-picker'; })()" >/dev/null; sleep 1.2
L=$(ev "window.__audit('model-picker')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S3 +model picker: zero leaks" || bad "S3 +model picker leaks" "$L"

echo "══ S4: the + sandbox picker ══"
ev "(function(){ if (window.ConnectOverlay) window.ConnectOverlay.close(); if (window.SandboxPicker) { window.SandboxPicker.open(function(){}); return 'sbx'; } return 'no-sbx'; })()" >/dev/null; sleep 1.2
L=$(ev "window.__audit('sandbox-picker')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S4 +sandbox picker: zero leaks" || bad "S4 +sandbox picker leaks" "$L"
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
L=$(ev "window.__audit('hub')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S5 hub: zero leaks" || bad "S5 hub leaks" "$L"

echo "══ S5b: a hub bundle detail (the bunch view) ══"
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch], .hub-card'); if (b) { b.click(); return 'card'; } return 'no-card'; })()" >/dev/null; sleep 2.5
L=$(ev "window.__audit('hub-bunch')" | grep -o '"leakCount":[0-9]*' | head -1); [ "$L" = '"leakCount":0' ] && ok "S5b hub bunch detail: zero leaks" || bad "S5b bunch leaks" "$L"

echo "══ S6: pixel proof — the sentinel shot (bunch view on screen) ══"
agent-browser screenshot /tmp/v0766-sentinel.png >/dev/null 2>&1 || true
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

PX=$(python3 - << 'PYEOF2'
from PIL import Image
import json
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
total = 0
for x in range(0, w, 20):
    for y in range(0, h, 20):
        total += 1
        k = classify(img.getpixel((x, y)))
        if k: c[k] += 1
print(json.dumps({'s1': c.get('s1', 0), 's2': c.get('s2', 0), 'border': c.get('border', 0), 'total': total}))
PYEOF2
)
echo "  pixel census: $PX"
PXS1=$(echo "$PX" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["s1"])')
PXS2=$(echo "$PX" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["s2"])')
PXB=$(echo "$PX"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["border"])')
PXT=$(echo "$PX"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["total"])')
[ "$PXS1" -gt 20 ] && ok "S6 the surface-1 field paints (the projection is live)" || bad "S6 s1 field missing" "$PXS1"
[ "$PXS2" -gt 5 ]  && ok "S6 the raised field paints (the pills window it)" || bad "S6 s2 field missing" "$PXS2"
[ "$PXB" -lt $((PXT / 10)) ] && ok "S6 the border field stays in RINGS (<10% of the screen)" || bad "S6 the border sweep floods" "$PXB/$PXT"
[ "$PXS1" -lt $((PXT * 6 / 10)) ] && ok "S6 no single family floods the screen (<60%)" || bad "S6 a family floods" "$PXS1/$PXT"

echo "══ S7: THE HISTORY FLOOR (the about:blank kill) ══"
for ROUND in 1 2; do
  ev "(function(){ if (window.ModelPicker) { window.ModelPicker.open(function(){}); return 'mp'; } })()" >/dev/null; sleep 0.6
  ev "(function(){ if (window.ConnectOverlay) window.ConnectOverlay.close(); if (window.SandboxPicker) { window.SandboxPicker.open(function(){}); return 'sbx'; } })()" >/dev/null; sleep 0.6
  ev "(function(){ if (window.ConnectOverlay) window.ConnectOverlay.close(); return 'closed'; })()" >/dev/null; sleep 1
  URL=$(ev "document.URL")
  case "$URL" in
    *"$BASE"*) ok "S7 round $ROUND: the app survived the +model→+sandbox close cycle" ;;
    *) bad "S7 round $ROUND: the page navigated away" "$URL" ;;
  esac
done

echo "══ console errors ══"
ERRS=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
[ "$ERRS" = "0" ] && ok "no console errors" || bad "console errors" "$ERRS"

echo ""
echo "══ v0.76.6 VARIABLE TRUTH: $PASS pass / $FAIL fail ══"
[ "$FAIL" = "0" ]
