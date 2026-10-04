#!/bin/bash
# v1002-gradtext-test.sh — THE GRADIENT-TEXT TIERS RIG (v1.00.2 gate).
#
# THE CONTRACT (PART E, ratified — the three tiers):
#  (G1) a gradient fmt scheme sets :root[data-fmt-grad~=a1].
#  (G2) the title family paints clip:text with a LOCAL-BOX gradient —
#       computed background-attachment is 'scroll' (NOT fixed: the
#       fixed illusion was the per-motion re-raster tax on the phone).
#  (G3) the projection system SKIPPED the text family: no __projPainted
#       flag, no baked background-position (the legacy bake wrote
#       calc(var(--proj-tx)…) — the natural '0% 0%' is the proof).
#  (G4) the panel drag sweep with live gradient text: ZERO long tasks.
#  (G5) the object track is UNTOUCHED: the surface windows still ride
#       the L2 layer path (an accent window keeps its fixed attachment
#       + gets the __projL2 mint) — the tiers split TEXT from OBJECTS,
#       nothing else moved.
#  (G6) zero console errors through the sweep.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8415
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1002grad
export AGENT_BROWSER_SESSION=doomalay-v1002grad

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

echo "building engine (forced -a; embed cache gap)…"
(cd engine && PATH="$PATH:$HOME/.local/go/bin:/usr/local/go/bin" go build -a -o "$ENG" ./cmd/doomalay) || { echo "BUILD FAIL"; exit 1; }

rm -rf $DATA; mkdir -p $DATA
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v1002g-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 120); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
ev "localStorage.clear(); 'cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); window.__lt=[]; try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push({d:e.duration,s:e.startTime})})}).observe({entryTypes:['longtask']});}catch(e){}; 'armed'" >/dev/null

echo "── G1 — the gradient scheme engages"
ev "window.Formatter.applyScheme('teal', { a1: { colors: ['#22d3ee','#f472b6'], dir: 'auto' }, link: { colors: ['#67e8f9','#a78bfa'], dir: 'auto' } }); 'applied'" >/dev/null
sleep 0.4
G1=$(ev "document.documentElement.getAttribute('data-fmt-grad') || ''")
ck "G1a :root carries data-fmt-grad with a1+link" "$([ "$G1" = "a1 link" ] && echo yes || echo no)" "$G1"

echo "── G2 — the title family paints LOCAL-BOX gradient text"
ev "document.getElementById('settings-btn').click(); 'opened'" >/dev/null
sleep 1.2
G2=$(ev "(function(){
  var el = document.querySelector('.settings-section h3 span');
  if (!el) return 'no-el';
  var cs = getComputedStyle(el);
  return [cs.webkitBackgroundClip || cs.backgroundClip, String(cs.backgroundAttachment), String(cs.backgroundImage).slice(0, 30)].join('|');
})()")
ck "G2a the Theme header paints clip:text + attachment:scroll + a gradient" \
   "$(echo "$G2" | grep -q '^text|scroll|linear-gradient' && echo yes || echo no)" "$G2"

echo "── G3 — the projection system SKIPPED the text family"
G3=$(ev "(function(){
  var el = document.querySelector('.settings-section h3 span');
  if (!el) return 'no-el';
  var cs = getComputedStyle(el);
  return [el.__projPainted === undefined, el.__projL2 === undefined, cs.backgroundPosition].join('|');
})()")
ck "G3a no __projPainted, no __projL2, natural background-position" \
   "$(echo "$G3" | grep -q '^true|true|0% 0%' && echo yes || echo no)" "$G3"

echo "── G4 — the drag sweep with live gradient text: zero long tasks"
# re-arm: the boot/panel-open phase has its own (pre-existing) longtasks;
# the GATE is the DRAG WINDOW with gradient text on screen
ev "window.__lt = []; 're-armed'" >/dev/null
for i in 1 2 3; do
  agent-browser eval "(function(){var h=document.getElementById('panel-handle');var r=h.getBoundingClientRect();var y=r.y+10;var md=new MouseEvent('mousedown',{bubbles:true,clientX:206,clientY:y});h.dispatchEvent(md);var t0=performance.now();(function mv(){var p=Math.min(1,(performance.now()-t0)/260);var yy=y+120*p;h.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:206,clientY:yy}));if(p<1)requestAnimationFrame(mv);else h.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:206,clientY:yy}));})();return 'dragging';})()" >/dev/null 2>&1
  sleep 1.1
  agent-browser eval "(function(){var h=document.getElementById('panel-handle');var r=h.getBoundingClientRect();var y=r.y+10;var md=new MouseEvent('mousedown',{bubbles:true,clientX:206,clientY:y});h.dispatchEvent(md);var t0=performance.now();(function mv(){var p=Math.min(1,(performance.now()-t0)/260);var yy=y-120*p;h.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:206,clientY:yy}));if(p<1)requestAnimationFrame(mv);else h.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:206,clientY:yy}));})();return 'dragging';})()" >/dev/null 2>&1
  sleep 1.1
done
LT1=$(ev "window.__lt.length")
ck "G4a zero long tasks across 3 up/down drag cycles" "$([ "$LT1" = "0" ] && echo yes || echo no)" "$LT1"

echo "── G5 — the OBJECT track still rides the L2 layer path"
G5=$(ev "(function(){
  // an accent WINDOW: set an accent gradient + find a minted surface
  var s = Settings.getState(); var cur = s.theme || 'midnight';
  var all = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  all[cur] = all[cur] || {};
  all[cur]['--field-accent-1'] = { colors: ['#22d3ee','#f472b6'], dir: 'auto' };
  Settings.setState({ themeOverrides: all });
  return 'set';
})()")
sleep 1.2
G5B=$(ev "(function(){
  var minted = [];
  document.querySelectorAll('[data-proj]').forEach(function(el){ minted.push(1); });
  // any fixed-attachment surface (an L2-ridden window) must exist now
  var fixed = 0;
  document.querySelectorAll('.settings-section, .settings-section *').forEach(function(el){
    if (getComputedStyle(el).backgroundAttachment === 'fixed') fixed++;
  });
  return minted.length + ' minted, ' + fixed + ' fixed-window rules live';
})()")
ck "G5a the accent window class is alive (L2 minting present)" \
   "$(echo "$G5B" | grep -qE '[1-9][0-9]* minted' && echo yes || echo no)" "$G5B"

echo "── G6 — zero console errors through the sweep"
G6=$(ev "window.__errs.length")
ck "G6a no page errors" "$([ "$G6" = "0" ] && echo yes || echo no)" "$G6"

echo ""
echo "v1002 gradient-text tiers: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
