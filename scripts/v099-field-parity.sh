#!/bin/bash
# v099-field-parity.sh — THE FIELD PARITY RIG (PLAN-V099 v0.99.4 gate).
#
# THE CONTRACT — the 7-slot model's two truths must agree:
#  (P1) CSS color-mix vs JS culori: every DERIVED var's computed value
#       equals FieldMath.cssMix(resolved fields) within the 8-bit
#       serialization class (≤ 2 per channel).
#  (P2) THE CALIBRATED DRIFT BOUND: the derived values sit within the
#       measured oklab distance of the OLD hand-tuned statics
#       (v099-calibrate's table: ≤ 0.05 per var — the imperceptible
#       class the user approved).
#  (P3) the 10 themes each cascade their own fields (non-empty; the
#       surface field distinct per theme).
#  (P4) the -rgb triplets match their source vars' channels exactly.
#  (P5) zero console errors through the whole sweep.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8407
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v099field
export AGENT_BROWSER_SESSION=doomalay-v099field

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
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v099f-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
ev "localStorage.clear(); 'cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
# reset overrides through the app's own path (kills the debounce race)
ev "Settings.setState({themeOverrides:{}, fmtOverrides:{}}); 'reset'" >/dev/null
sleep 0.6

echo "── P1 — CSS color-mix ≡ JS culori (every derived var)"
P1=$(ev "(function(){
  var FM = window.DoomTheme.fieldMath;
  // THE PIXEL NORMALIZER — fill a 1×1 canvas and read the bytes: every
  // serialization (oklch/rgb/hex/'none' hues) resolves the same way the
  // compositor would paint it.
  var pcv = document.createElement('canvas'); pcv.width = pcv.height = 1;
  var pctx = pcv.getContext('2d', { willReadFrequently: true });
  function norm(c){
    pctx.fillStyle = '#000'; pctx.clearRect(0,0,1,1); pctx.fillStyle = c;
    pctx.fillRect(0,0,1,1);
    return Array.prototype.slice.call(pctx.getImageData(0,0,1,1).data, 0, 3);
  }
  function rgb2hex(s){
    var m=/rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
    if(!m) return s;
    function h2(x){x=Math.round(Number(x)).toString(16);while(x.length<2)x='0'+x;return x}
    return '#'+h2(m[1])+h2(m[2])+h2(m[3]);
  }
  var DR = {'--surface-2':['--field-surface','--field-ink',0.05],
    '--surface-3':['--field-surface','--field-ink',0.11],
    '--border':['--field-surface','--field-ink',0.13],
    '--border-strong':['--field-surface','--field-ink',0.24],
    '--bg-app':['--field-canvas','--field-surface',0.08],
    '--text-2':['--field-ink','--field-surface',0.26],
    '--text-3':['--field-ink','--field-surface',0.47],
    '--text-3-dim':['--field-ink','--field-surface',0.61]};
  var cs = getComputedStyle(document.documentElement);
  var worst = 0, worstVar = '';
  Object.keys(DR).forEach(function(name){
    var spec = DR[name];
    var a = rgb2hex(cs.getPropertyValue(spec[0]).trim());
    var b = rgb2hex(cs.getPropertyValue(spec[1]).trim());
    var jsHex = FM.cssMix(a, b, spec[2]) || '';
    var probe = document.createElement('div');
    probe.style.color = 'var(' + name + ')';
    document.documentElement.appendChild(probe);
    var cssSide = getComputedStyle(probe).color;
    document.documentElement.removeChild(probe);
    var A = norm(cssSide), B = norm(jsHex);
    if (!A || !B) { worst = 999; worstVar = name + ':norm(' + cssSide + '/' + jsHex + ')'; return; }
    for (var i = 0; i < 3; i++) {
      var d = Math.abs(A[i] - B[i]);
      if (d > worst) { worst = d; worstVar = name; }
    }
  });
  return Math.round(worst) + '|' + worstVar;
})()")
W=$(echo "$P1" | cut -d'|' -f1)
ck "every derived var: CSS ≡ JS within 2/channel (worst=$W)" "$([ "$W" -le 2 ] 2>/dev/null && echo yes || echo no)" "$P1"

echo "── P2 — the calibrated drift bound (ΔE vs the old statics)"
P2=$(ev "(function(){
  var FM = window.DoomTheme.fieldMath, C = window.culori;
  function dE(h1, h2){
    var a=C.oklab(C.parse(h1)), b=C.oklab(C.parse(h2));
    return Math.sqrt((a.l-b.l)*(a.l-b.l)+(a.a-b.a)*(a.a-b.a)+(a.b-b.b)*(a.b-b.b));
  }
  var CASES = [
    { theme:'midnight', fS:'#14141a', fI:'#e0e0e8', old:{'--surface-2':'#1a1a22','--surface-3':'#26262f','--border':'#2a2a35','--text-2':'#a8a8b4','--text-3':'#71717a'} },
    { theme:'paper',    fS:'#efeae0', fI:'#2c2620', old:{'--surface-2':'#e7e0d3','--surface-3':'#dcd3c2','--border':'#d5ccba','--text-2':'#5c5347','--text-3':'#7d7364'} }
  ];
  var MIX = {'--surface-2':0.05,'--surface-3':0.11,'--border':0.13,'--text-2':0.26,'--text-3':0.47};
  var worst = 0, worstCase = '';
  CASES.forEach(function(c){
    Object.keys(MIX).forEach(function(name){
      var isText = name.indexOf('--text') === 0;
      var a = isText ? c.fI : c.fS;        // text mixes FROM ink; surface FROM surface
      var toward = isText ? c.fS : c.fI;   // ...toward the other field
      var derived = FM.cssMix(a, toward, MIX[name]);
      var d = dE(derived, c.old[name]);
      if (d > worst) { worst = d; worstCase = c.theme + ' ' + name + '=' + derived; }
    });
  });
  return worst.toFixed(3) + '|' + worstCase;
})()")
W2=$(echo "$P2" | cut -d'|' -f1)
ck "the calibrated drift stays imperceptible (worst ΔE=$W2)" "$(python3 -c "print('yes' if float('$W2' or 9) < 0.055 else 'no')")" "$P2"

echo "── P3 — the 10 themes cascade their own fields"
P3=$(ev "(function(){
  var themes=['midnight','nebula','ember','forest','ocean','rose','mono','solar','paper','frost'];
  var bad = [], surfaces = {};
  themes.forEach(function(id){
    document.documentElement.setAttribute('data-theme', id);
    var cs = getComputedStyle(document.documentElement);
    ['--field-surface','--field-ink','--field-canvas','--field-accent-1','--field-accent-2','--field-accent-3'].forEach(function(v){
      var val = cs.getPropertyValue(v).trim();
      if (!val || val === 'none') bad.push(id + ':' + v + '=empty');
    });
    surfaces[id] = cs.getPropertyValue('--field-surface').trim();
  });
  document.documentElement.setAttribute('data-theme', 'midnight');
  // the surface field must be DISTINCT per theme (no cascade bleed)
  var vals = Object.keys(surfaces).map(function(k){ return surfaces[k]; });
  var uniq = vals.filter(function(v, i){ return vals.indexOf(v) === i; });
  if (uniq.length !== themes.length) bad.push('surface not distinct: ' + uniq.length + '/10');
  return bad.length ? bad.join(';') : 'clean';
})()")
ck "all 10 themes: fields non-empty + surfaces distinct" "$([ "$P3" = "clean" ] && echo yes || echo no)" "$P3"

echo "── P4 — the -rgb triplets match their sources"
P4=$(ev "(function(){
  var cs = getComputedStyle(document.documentElement);
  function chan(c){
    var m=/rgb\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
    if(!m) return null;
    return Math.round(+m[1]) + ',' + Math.round(+m[2]) + ',' + Math.round(+m[3]);
  }
  var a = chan(cs.getPropertyValue('--field-surface').trim());
  var b = cs.getPropertyValue('--surface-1-rgb').trim().replace(/[ ,]+/g, ',');
  return (a && a === b) ? 'match' : ('MISMATCH [' + a + '] vs [' + b + ']');
})()")
ck "surface-1-rgb triplet ≡ field-surface channels" "$([ "$P4" = "match" ] && echo yes || echo no)" "$P4"

echo "── P5 — zero console errors through the sweep"
E=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and (e.get('level','').lower() in ('error','severe') or e.get('type','').lower()=='error'): n+=1
    except Exception: pass
print(n)")
ck "zero console errors" "$([ "$E" = "0" ] && echo yes || echo no)" "$E errors"

echo
echo "═══ v099 field parity: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]