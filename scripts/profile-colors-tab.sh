#!/bin/bash
# profile-colors-tab.sh — v0.89.7 measure the settings COLORS tab open cost
# vs the SIZING tab (user report: colors extremely laggy, sizing smooth,
# empty panel smooth). Uses PerformanceObserver longtask + the render time.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=$((8300 + $$ % 300))
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-prof-colors
export AGENT_BROWSER_SESSION=doomalay-prof-colors

ev() { timeout 90 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')"; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/prof-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ "$OWNER" = "$ENGPID" ] || { echo "BOOT FAIL (zombie?)"; exit 1; }
echo "engine up :$PORT"
agent-browser close >/dev/null 2>&1; sleep 0.5
agent-browser open "$BASE" >/dev/null 2>&1
for i in 1 2 3 4 5 6 8; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
ev "localStorage.clear()" >/dev/null 2>&1
sleep 2

# the settings gear (index.html #settings-btn)
R=$(ev "(async function(){
  var btn = document.getElementById('settings-btn');
  if (!btn) return 'NO-SETTINGS-BTN';
  btn.click();
  await new Promise(r=>setTimeout(r,1200));
  return 'opened:' + !!document.querySelector('.settings-page, [class*=settings]');
})()")
echo "settings: $R"

# now measure: switch to each page, capture longtasks + timing
R=$(ev "(async function(){
  window.__lt = [];
  try {
    new PerformanceObserver(function(l){ window.__lt = window.__lt.concat(l.getEntries().map(function(e){return Math.round(e.duration);})); })
      .observe({entryTypes:['longtask']});
  } catch(e) {}
  var findTab = function(name){
    return Array.prototype.find.call(document.querySelectorAll('[data-page], .settings-nav button, .settings-tab, [class*=nav] button, [role=tab]'), function(b){
      return (b.textContent||'').toLowerCase().indexOf(name) >= 0 || (b.dataset && b.dataset.page === name);
    });
  };
  var measure = function(name){
    return new Promise(function(res){
      var t0 = performance.now();
      var done = function(){
        var t1 = performance.now();
        res({page: name, ms: Math.round(t1 - t0), longtasks: window.__lt.slice(), ltTotal: window.__lt.reduce(function(a,b){return a+b;},0)});
        window.__lt = [];
      };
      // click + wait for the page content to render (2s settle)
      setTimeout(done, 2000);
    });
  };
  var out = [];
  // the page order: appearance (colors) first, then sizing, then back
  var tabColors = findTab('color') || findTab('appearance') || findTab('🎨');
  var tabSizing = findTab('sizing') || findTab('size');
  if (!tabColors || !tabSizing) {
    return JSON.stringify({fail: 'no tabs', tabs: Array.prototype.map.call(document.querySelectorAll('button, [data-page]'), function(b){return (b.textContent||'').slice(0,14);}).slice(0,20)});
  }
  tabSizing.click();  await measure('sizing-warmup');
  tabColors.click(); var r1 = await measure('colors');
  tabSizing.click(); var r2 = await measure('sizing');
  tabColors.click(); var r3 = await measure('colors-2nd');
  out.push(r1); out.push(r2); out.push(r3);
  // count the colors DOM
  var domCount = document.querySelectorAll('*').length;
  return JSON.stringify({results: out, domNodes: domCount});
})()")
echo "$R" | python3 -m json.tool 2>/dev/null || echo "$R"
