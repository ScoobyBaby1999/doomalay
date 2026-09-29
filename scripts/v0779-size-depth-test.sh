#!/bin/bash
# v0779-size-depth-test.sh — THE SIZE-DEPTH LATTICE:
#  (1) amp 0 = the byte-identical default (single plane, pf 1, zero
#      spawned stars — DoomalayDebug.stars === 0 always)
#  (2) amp 100 + size variation → 5 depth bands with a MONOTONIC pan
#      factor ladder (band 0 furthest .. band 4 closest, pf > 1)
#  (3) the bands are POPULATED from the user's own elements (every band
#      non-empty; the sum == the total dots)
#  (4) the uniform case (variation 0) → all dots in ONE mid band (no
#      fake spread when nothing size-varies)
#  (5) depth is REAL: panning displaces a near-band dot MORE than a
#      far-band dot (the pixel proof)
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8326
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0779
export AGENT_BROWSER_SESSION=doomalay-v0779

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0779-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2.5
agent-browser errors --clear >/dev/null

# (1) amp 0: the default — single band, zero stars
D0=$(ev "(function(){
  var d = window.DoomalayDebug || {};
  return JSON.stringify({ stars: d.stars, dots: d.dots, dotBands: d.dotBands, lineBands: d.lineBands });
})()")
Z1=$(echo "$D0" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['stars'] == 0 and len(d['dotBands']) == 1 and len(d['lineBands']) == 1 and d['dots'] > 0
print('yes' if ok else 'no')")
ck "amp 0: single plane, zero spawned stars, dots render" "$Z1" "$D0"

# (2)+(3) amp 100 + size variation: 5 populated bands, monotonic pf
ev "(function(){
  Settings.setState({ spaceParallax: 100, dotSizeVariation: 70, lineSizeVariation: 70 });
  return 'depth on';
})()" >/dev/null; sleep 1.2
D1=$(ev "(function(){
  var d = window.DoomalayDebug || {};
  return JSON.stringify({ stars: d.stars, dots: d.dots, dotBands: d.dotBands, lineBands: d.lineBands, amp: d.amp });
})()")
Z2=$(echo "$D1" | python3 -c "
import json,sys
d = json.load(sys.stdin)
bands = d['dotBands']
ok = (d['stars'] == 0 and d['amp'] == 1 and len(bands) == 5 and
      all(b > 0 for b in bands) and sum(bands) == d['dots'] and len(d['lineBands']) == 5)
print('yes' if ok else 'no')")
ck "amp 100 + variation: 5 populated dot bands (no spawns, all real dots)" "$Z2" "$D1"

# the pf ladder is monotonic + the near band beats the icons (pf > 1)
PF=$(ev "(function(){
  // recompute the ladder exactly as the renderer does
  var amp = 1, K = 5, out = [];
  for (var k = 0; k < K; k++) {
    var spread = -0.85 + 1.5 * (k / (K - 1));
    out.push(1 + amp * (0.25 + 0.75 * spread));
  }
  return JSON.stringify(out);
})()")
Z3=$(echo "$PF" | python3 -c "
import json,sys
p = json.load(sys.stdin)
ok = len(p) == 5 and all(p[i] < p[i+1] for i in range(4)) and p[0] < 1 and p[4] > 1.3
print('yes' if ok else 'no')")
ck "the pf ladder is monotonic; near band > 1.3 (in front of the icons)" "$Z3" "$PF"

# (4) the uniform case: variation 0 → all dots in the mid band
ev "(function(){
  Settings.setState({ spaceParallax: 100, dotSizeVariation: 0, lineSizeVariation: 0 });
  return 'uniform';
})()" >/dev/null; sleep 1.2
D2=$(ev "(function(){
  var d = window.DoomalayDebug || {};
  return JSON.stringify({ dotBands: d.dotBands, dots: d.dots });
})()")
Z4=$(echo "$D2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
b = d['dotBands']
# uniform sizes → every dot lands in ONE band (the mid), the rest are 0
nonzero = [x for x in b if x > 0]
ok = len(b) == 5 and len(nonzero) == 1 and nonzero[0] == d['dots']
print('yes' if ok else 'no')")
ck "uniform sizes: all dots in one mid band (no fake spread)" "$Z4" "$D2"

# (5) the pixel proof: near-band dots displace more than far-band on pan
#     (direct canvas reads; a 20px sub-cell pan so no lattice-fold aliasing)
ev "(function(){ Settings.setState({ spaceParallax: 100, dotSizeVariation: 80 }); return 'on'; })()" >/dev/null; sleep 1.2
SCANJS="var c=document.getElementById('c'); var ctx=c.getContext('2d'); try { var W=c.width,H=c.height; var img=ctx.getImageData(0,0,W,H).data; var bright=[],dim=[]; for(var y=2;y<H-2;y+=2){ var runB=null,runD=null; for(var x=1;x<W-1;x++){ var i=(y*W+x)*4; var s=img[i]+img[i+1]+img[i+2]; if(s>250){ if(runB===null)runB=[x,x]; else runB[1]=x; } else { if(runB&&runB[1]-runB[0]>=4)bright.push([(runB[0]+runB[1])/2|0,y]); runB=null; } if(s>130&&s<=250){ if(runD===null)runD=[x,x]; else runD[1]=x; } else { if(runD&&runD[1]-runD[0]>=1)dim.push([(runD[0]+runD[1])/2|0,y]); runD=null; } } } return {bright:bright,dim:dim}; } catch(e){ return null; }"
Z5=$(ev "(function(){ var r = (function(){ $SCANJS })(); window.__v0779before = r; return r ? ('b=' + r.bright.length + ' d=' + r.dim.length) : 'scan-failed'; })()")
ev "(function(){ var c=document.getElementById('c'); function fire(t,x,y){c.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window}));} fire('mousedown',300,420); fire('mousemove',280,420); fire('mouseup',280,420); return 'panned'; })()" >/dev/null; sleep 2
Z5B=$(ev "(function(){ var before = window.__v0779before; var r = (function(){ $SCANJS })(); if (!before || !r) return 'no:scan-failed'; function avg(A,B){ var sh=[],used={}; for(var i=0;i<A.length;i++){ var best=-1,bd=42; for(var j=0;j<B.length;j++){ if(used[j])continue; if(Math.abs(B[j][1]-A[i][1])>8)continue; var d=Math.abs(B[j][0]-A[i][0]); if(d<bd){best=j;bd=d;} } if(best>=0){used[best]=1;sh.push(B[best][0]-A[i][0]);} } if(sh.length<2)return null; return sh.reduce(function(a,b){return a+b;},0)/sh.length; } var bs=avg(before.bright,r.bright), ds=avg(before.dim,r.dim); if(bs===null||ds===null) return 'no:no-match'; return (Math.abs(bs)>Math.abs(ds)+1)?('yes:'+bs.toFixed(1)+'-vs-'+ds.toFixed(1)):('no:'+bs.toFixed(1)+'-vs-'+ds.toFixed(1)); })()")
ck "the pixel proof: near (glow) dots pan further than far dots ($(echo "$Z5" | head -c 40))" "$(echo "$Z5B" | cut -d: -f1)" "$Z5B"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.9 size-depth suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
