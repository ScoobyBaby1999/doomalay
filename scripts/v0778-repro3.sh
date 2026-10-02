#!/bin/bash
# v0778-repro3.sh — stack-trace the rogue go(-1)
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8309
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0778c
export AGENT_BROWSER_SESSION=doomalay-v0778c

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0778c-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2

ev "(function(){
  window.__hlog = [];
  var L = function(m){ window.__hlog.push(m); try { console.error('[HIST] '+m); } catch(e){} };
  var ps = History.prototype.pushState;
  History.prototype.pushState = function(s,u,t){ L('push marker='+(s&&s.__connectOverlay)); return ps.call(this,s,u,t); };
  var bk = History.prototype.back;
  History.prototype.back = function(){ L('BACK at marker='+(history.state&&history.state.__connectOverlay)+'\\n'+(new Error()).stack.split('\\n').slice(1,5).join(' | ')); return bk.call(this); };
  var goOrig = History.prototype.go;
  History.prototype.go = function(n){ L('GO('+n+') at marker='+(history.state&&history.state.__connectOverlay)+'\\n'+(new Error()).stack.split('\\n').slice(1,5).join(' | ')); return goOrig.call(this,n); };
  window.addEventListener('popstate', function(){
    L('popstate → marker='+(history.state&&history.state.__connectOverlay)+' len='+history.length);
  });
  return 'wrapped';
})()"

ev "(function(){ window.ModelPicker.open(function(){}); return 'S3'; })()" >/dev/null; sleep 1.2
ev "(function(){ window.ConnectOverlay.close(); window.SandboxPicker.open(function(){}); return 'S4'; })()" >/dev/null; sleep 1.5
echo "── log after S4 ──"; ev "window.__hlog.join('\\n')"; echo ""
ev "(function(){ window.ConnectOverlay.close(); return 'S4b'; })()" >/dev/null; sleep 1.2
echo "── URL ──"; ev "document.URL"; echo ""
echo "── full console ──"
agent-browser console 2>/dev/null | grep -A0 "HIST" | head -30
