#!/bin/bash
# probe-colors-structure.sh — v0.91 measure the STRUCTURAL device-side cost
# of the settings COLORS tab (the user's device lags; this host is too fast
# for longtask timing — so count the work: [style*] substring selectors,
# inline-styled elements, gate-sheet rules, PROJ paints/rebakes, scroll
# behavior). Single-call (the sandbox reaper kills detached engines).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8531
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-probe-colors
export AGENT_BROWSER_SESSION=doomalay-probe-colors
ev() { timeout 90 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception: print(s, end='')"; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/probe-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }
agent-browser close >/dev/null 2>&1; sleep 0.5
agent-browser open "$BASE" >/dev/null 2>&1
# v0.91: the ready-poll — a cold browser session can take 5-10s to boot
# the app; clicking before __doomalayReady is the null-click flake. NO
# clear/reload: every rig run boots a FRESH engine + data dir (storage is
# empty by construction) and a reload mid-boot races the app into a
# half-loaded page the polls then time out on.
for i in $(seq 1 80); do
  RD=$(timeout 10 agent-browser eval "window.__doomalayReady === true" 2>/dev/null | tr -d '"')
  [ "$RD" = "true" ] && break
  sleep 0.25
done

R=$(ev "(async function(){
  document.getElementById('settings-btn').click();
  await new Promise(r=>setTimeout(r,1500));
  // find the colors tab
  var tabs = Array.from(document.querySelectorAll('.settings-nav .tab'));
  var colorsEl = tabs.filter(function(t){ return /color/i.test(t.textContent||''); })[0];
  if (!colorsEl) colorsEl = document.querySelector('.settings-nav .tab[data-page="appearance"]');
  if (colorsEl) colorsEl.click();
  await new Promise(r=>setTimeout(r,1500));
  // ── the structural counts ──
  var out = {};
  out.sheets = document.styleSheets.length;
  var rules = 0, styleAttrSels = 0, gradientVars = 0;
  for (var i=0;i<document.styleSheets.length;i++){
    var rs=null; try{ rs=document.styleSheets[i].cssRules; }catch(e){}
    if(!rs) continue;
    for (var j=0;j<rs.length;j++){
      rules++;
      var t = rs[j].selectorText || '';
      if (t.indexOf('[style*=') !== -1) styleAttrSels++;
      if (t.indexOf('gradient') !== -1) gradientVars++;
    }
  }
  out.rules = rules; out.styleAttrSels = styleAttrSels; out.gradientSels = gradientVars;
  out.inlineStyled = document.querySelectorAll('[style]').length;
  var sp = document.querySelector('.settings-page');
  out.inlineInSettings = sp ? sp.querySelectorAll('[style]').length : -1;
  out.settingsNodes = sp ? sp.getElementsByTagName('*').length : -1;
  var grads = sp ? sp.querySelectorAll('[style]') : [];
  var gradInline = 0, varGradInline = 0;
  for (var q=0;q<grads.length;q++){
    var st = grads[q].getAttribute('style')||'';
    if (st.indexOf('gradient') !== -1) gradInline++;
    if (st.indexOf('var(--') !== -1 && st.indexOf('gradient') !== -1) varGradInline++;
  }
  out.inlineGradientInSettings = gradInline;
  out.inlineVarGradientInSettings = varGradInline;
  out.colorRows = sp ? sp.querySelectorAll('.color-row, [class*=color-row]').length : -1;
  out.domNodes = document.getElementsByTagName('*').length;
  // v0.91: the projected-set count — elements carrying the PROJ poke
  var projected = 0;
  var allp = sp.querySelectorAll('[style]');
  for (var q2=0;q2<allp.length;q2++){
    var st2 = allp[q2].getAttribute('style')||'';
    if (st2.indexOf('var(--proj-tx') !== -1) projected++;
  }
  out.projectedInSettings = projected;
  var mini2 = sp.querySelector('.gr-mini');
  out.miniStyle = mini2 ? (mini2.getAttribute('style') || '(none)') : 'NONE';
  out.miniBg = mini2 ? getComputedStyle(mini2).backgroundColor : 'NONE';
  out.supportsMix = CSS.supports('color','color-mix(in oklch, red, blue)');
  // gate sheets the engine injected
  out.gateSheets = Array.from(document.querySelectorAll('style')).map(function(s){return (s.id||'anon')+':'+(s.sheet?s.sheet.cssRules.length:0);});
  // PROJ stats if exposed
  out.proj = (window.DoomalayTheme && window.DoomalayTheme.stats) ? window.DoomalayTheme.stats() : (window.__doomProjStats || null);
  out.hasThemeAPI = !!window.DoomalayTheme;
  return JSON.stringify(out);
})()")
echo "COLORS TAB: $R"
MO=$(ev "JSON.stringify(window.__miniMut || [])" >/dev/null 2>&1; echo ok")
# read the MutationObserver records captured during the scroll test below via a global


# scroll the colors list — count PROJ rebakes + frame deltas
R2=$(ev "(async function(){
  var sc = document.querySelector('.settings-page .st-body, .settings-page [class*=scroll], .settings-page') || document.scrollingElement;
  var t0 = performance.now(); var frames = [];
  function tick(t){ frames.push(t); if (t - t0 < 1200) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  for (var k=0;k<8;k++){ sc.scrollTop += 220; await new Promise(r=>setTimeout(r,120)); }
  await new Promise(r=>setTimeout(r,300));
  var dts = []; for (var i=1;i<frames.length;i++) dts.push(frames[i]-frames[i-1]);
  dts.sort(function(a,b){return a-b;});
  var out = {
    frames: frames.length,
    median_dt: dts[Math.floor(dts.length/2)],
    p95_dt: dts[Math.floor(dts.length*0.95)] || dts[dts.length-1],
    max_dt: dts[dts.length-1],
    proj: (window.DoomalayTheme && window.DoomalayTheme.stats) ? window.DoomalayTheme.stats() : (window.__doomProjStats || null)
  };
  return JSON.stringify(out);
})()")
echo "SCROLL: $R2"
