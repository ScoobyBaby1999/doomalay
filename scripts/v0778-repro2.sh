#!/bin/bash
# v0778-repro2.sh — forced instrumentation of history ops
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8308
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0778b
export AGENT_BROWSER_SESSION=doomalay-v0778b

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0778b-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2

# force-wrap pushState/back/go with defineProperty
ev "(function(){
  window.__hlog = [];
  var L = function(m){ window.__hlog.push(m); try { console.error('[HIST] '+m); } catch(e){} };
  L('init len='+history.length+' idx? url='+location.pathname);
  var ps = History.prototype.pushState;
  History.prototype.pushState = function(s,u,t){ L('push marker='+(s&&s.__connectOverlay)+' (len='+history.length+')'); return ps.call(this,s,u,t); };
  var bk = History.prototype.back;
  History.prototype.back = function(){ L('BACK issued at marker='+(history.state&&history.state.__connectOverlay)+' len='+history.length); return bk.call(this); };
  var goOrig = History.prototype.go;
  History.prototype.go = function(n){ L('GO('+n+') issued at marker='+(history.state&&history.state.__connectOverlay)+' len='+history.length); return goOrig.call(this,n); };
  window.addEventListener('popstate', function(){
    L('popstate → marker='+(history.state&&history.state.__connectOverlay)+' len='+history.length+' url='+location.pathname);
  });
  return 'wrapped: back-writable='+('back' in History.prototype);
})()"

echo "── S3: model picker open ──"
ev "(function(){ window.ModelPicker.open(function(){}); return 'S3 done'; })()" >/dev/null; sleep 1.2
echo "── log after S3 ──"; ev "window.__hlog.join(' ;; ')"; echo ""

echo "── S4: close + sandbox picker open (same tick) ──"
ev "(function(){ window.ConnectOverlay.close(); window.SandboxPicker.open(function(){}); return 'S4 done'; })()" >/dev/null; sleep 1.5
echo "── log after S4 ──"; ev "window.__hlog.join(' ;; ')"; echo ""

echo "── S4b: close ──"
ev "(function(){ window.ConnectOverlay.close(); return 'S4b done'; })()" >/dev/null; sleep 1.2
echo "── URL now ──"; ev "document.URL"; echo ""
echo "── log after S4b (if alive) ──"; ev "window.__hlog.join(' ;; ')"; echo ""
echo "── console HIST lines ──"
agent-browser console 2>/dev/null | grep "HIST" | head -40
