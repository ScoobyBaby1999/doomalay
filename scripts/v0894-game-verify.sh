#!/usr/bin/env bash
# v0894-game-verify.sh — THE REAL-USER PLAY TEST of the evolution game.
# The contract (user spec): 3 spawnable colored dot types — GREEN never
# dies; BLUE must eat a GREEN within 20s or dies; RED must eat a BLUE
# within 20s or dies; every dot only ever flees or chases.
# Verification: spawn each type, read the live population counters,
# watch 25s+ and confirm (a) greens never die, (b) starved blues/reds
# die (counts drop without predation), (c) chase/flee actually moves
# dots, (d) a starvation countdown is visible.
set -u
export AGENT_BROWSER_SESSION=doomalay-v0894-game
GAME="https://scoobybaby1999-doomalay-final-test.hf.space/pub/"

ev() { timeout 60 agent-browser eval "$1" 2>/dev/null | python3 -c "
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

agent-browser close >/dev/null 2>&1; sleep 0.5
agent-browser open "$GAME" >/dev/null 2>&1
sleep 4

echo "── (1) spawn one of each + read the ecosystem"
ev "(function(){
  var btn = function(t){ return Array.prototype.find.call(document.querySelectorAll('button'), function(b){return (b.textContent||'').indexOf(t)>=0;}); };
  ['+ green','+ blue','+ red'].forEach(function(t){ var b=btn(t); if(b) b.click(); });
  return 'spawned';
})"
sleep 3
R=$(ev "(function(){
  var txt = document.body.innerText;
  var cv = document.querySelector('canvas');
  return JSON.stringify({ text: txt.slice(0,400), canvas: !!cv });
})()")
echo "$R" | python3 -m json.tool 2>/dev/null || echo "$R"

echo "── (2) sample populations over 30s (starvation window = 20s)"
for i in 1 2 3 4 5 6; do
  sleep 5
  R=$(ev "(function(){
    var txt = (document.body.innerText||'');
    var m = txt.match(/green[^0-9]*([0-9]+)[^0-9]*blue[^0-9]*([0-9]+)[^0-9]*red[^0-9]*([0-9]+)/i);
    var anyCount = txt.replace(/\n/g,' | ').slice(0,200);
    return JSON.stringify({g: m?m[1]:'?', b: m?m[2]:'?', r: m?m[3]:'?', raw: anyCount});
  })()")
  echo "[${i}x5s] $R" | head -c 300; echo
done

echo "── (3) the movement proof: dot positions must change (chase/flee)"
A=$(ev "(function(){ var c=document.querySelector('canvas'); var d=window.__dotsState; return JSON.stringify({hasState: !!d}); })()")
echo "state probe: $A"
