#!/bin/bash
# v0778-repro-history.sh — instrument + reproduce the S3→S4 about:blank kill
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8307
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0778
export AGENT_BROWSER_SESSION=doomalay-v0778

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

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0778-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2

# ── instrumentation: log every push/back/popstate (console survives nav) ──
ev "(function(){
  var L = function(m){ try { console.error('[HIST] '+m); } catch(e){} };
  L('init len='+history.length+' url='+location.pathname);
  var ps = history.pushState.bind(history);
  history.pushState = function(s,u,t){ L('push marker='+(s&&s.__connectOverlay)); return ps(s,u,t); };
  var bk = history.back.bind(history);
  history.back = function(){ L('back issued (at marker='+(history.state&&history.state.__connectOverlay)+', len='+history.length+')'); return bk(); };
  window.addEventListener('popstate', function(){
    L('popstate → marker='+(history.state&&history.state.__connectOverlay)+' len='+history.length+' url='+location.pathname);
  });
  return 'instrumented';
})()"

echo "── S3: model picker open ──"
ev "(function(){ window.ModelPicker.open(function(){}); return 'picker open'; })()" >/dev/null; sleep 1.2
echo "── S4: close + sandbox picker open (same tick) ──"
ev "(function(){ window.ConnectOverlay.close(); window.SandboxPicker.open(function(){}); return 'sbx'; })()" >/dev/null; sleep 1.5
echo "── S4b: close ──"
ev "(function(){ window.ConnectOverlay.close(); return 'closed'; })()" >/dev/null; sleep 1.0
echo "── URL now ──"
ev "document.URL"
echo ""
echo "── history console log ──"
agent-browser console 2>/dev/null | grep "HIST" | head -40
