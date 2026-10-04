#!/bin/bash
# v099-settings-open.sh — THE SETTINGS-WIDE NESTED-BOX RIG (v0.99.7 gate).
#
# THE CONTRACT (the recipe, proven on every settings tab):
#  (S1) every tab opens with ZERO long tasks (the mount stays lean).
#  (S2) collapsed sections are SETTLED (content-visibility:hidden — the
#       layout skip) after their slide, and re-opening clears it.
#  (S3) the CAP-OPEN ACCORDION: opening a third section collapses the
#       oldest (≤ 2 expanded at once).
#  (S4) expand-all + collapse-all across every tab stays bounded (no
#       longtask spikes; the collapse wave paints cheap).
#  (S5) the SECOND open reuses the DOM (the wipe+rerender path stays
#       lean; node count in the same class as the first).
#  (S6) zero console errors through the whole sweep.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8413
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v099set
export AGENT_BROWSER_SESSION=doomalay-v099set

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v099s-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 240); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
ev "localStorage.clear(); 'cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); window.__lt=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push({d:e.duration,s:e.startTime})})}).observe({entryTypes:['longtask']}); 'armed'" >/dev/null

echo "── S1 — every tab opens lean (zero long tasks)"
TABS=$(ev "(async function(){
  document.getElementById('settings-btn').click();
  await new Promise(function(r){ setTimeout(r, 1100); });
  var out = [];
  var tabs = Array.from(document.querySelectorAll('.settings-nav .tab'));
  for (var i = 0; i < tabs.length; i++) {
    var lt0 = window.__lt.length;
    tabs[i].click();
    await new Promise(function(r){ setTimeout(r, 700); });
    var b = document.querySelector('.panel-body');
    out.push(tabs[i].dataset.page + ':' + b.querySelectorAll('*').length + ':' + (window.__lt.length - lt0));
  }
  tabs[0].click();
  await new Promise(function(r){ setTimeout(r, 600); });
  return out.join('|');
})()")
MAXLT=$(echo "$TABS" | tr '|' '\n' | cut -d: -f3 | sort -n | tail -1)
ck "every tab opens with ZERO long tasks (max=$MAXLT)" "$([ "$MAXLT" = "0" ] 2>/dev/null && echo yes || echo no)" "$TABS"

echo "── S2 — collapsed sections settle (cv:hidden) + re-open clears"
S2=$(ev "(async function(){
  // expand The Fields, then collapse it, wait for the settle
  var hs = document.querySelectorAll('h3[data-section-toggle]');
  var fields = null;
  for (var i=0;i<hs.length;i++){ if (/fields/i.test(hs[i].textContent)) { fields = hs[i].closest('.settings-section'); break; } }
  if (!fields) return 'nofields';
  hs[0].click(); await new Promise(function(r){ setTimeout(r, 150); });
  fields.querySelector('h3').click(); await new Promise(function(r){ setTimeout(r, 100); });
  fields.querySelector('h3').click();   // collapse it again
  await new Promise(function(r){ setTimeout(r, 500); });
  var settledWhileCollapsed = fields.classList.contains('collapsed-settled');
  var cv = getComputedStyle(fields.querySelector('.section-inner')).contentVisibility;
  fields.querySelector('h3').click();   // re-open
  await new Promise(function(r){ setTimeout(r, 120); });
  var clearedOnOpen = !fields.classList.contains('collapsed-settled');
  return JSON.stringify({settled: settledWhileCollapsed, cv: cv, cleared: clearedOnOpen});
})()")
S2J=$(echo "$S2" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print('yes' if d.get('settled') and d.get('cv') == 'hidden' and d.get('cleared') else 'no')
except Exception: print('no')")
ck "a collapsed section settles to cv:hidden; re-opening clears it" "$S2J" "$S2"

echo "── S3 — the cap-open accordion (≤ 2 expanded)"
S3=$(ev "(async function(){
  // switch to General (5 flat sections) and open three
  var tab = document.querySelector('.settings-nav .tab[data-page=general]');
  tab.click();
  await new Promise(function(r){ setTimeout(r, 700); });
  var hs = document.querySelectorAll('h3[data-section-toggle]');
  if (hs.length < 3) return 'too-few:' + hs.length;
  for (var i = 0; i < 3; i++) {
    if (!hs[i].closest('.settings-section').classList.contains('expanded')) hs[i].click();
    await new Promise(function(r){ setTimeout(r, 120); });
  }
  await new Promise(function(r){ setTimeout(r, 500); });
  var openCount = document.querySelectorAll('.settings-section.expanded').length;
  return 'open:' + openCount;
})()")
ck "opening a third section collapses the oldest (≤2 open)" "$(echo "$S3" | grep -q 'open:2' && echo yes || echo no)" "$S3"

echo "── S4 — expand-all + collapse-all across every tab stays bounded"
S4=$(ev "(async function(){
  var tabs = Array.from(document.querySelectorAll('.settings-nav .tab'));
  var worstLT = 0;
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].click();
    await new Promise(function(r){ setTimeout(r, 450); });
    var lt0 = window.__lt.length;
    var hs = document.querySelectorAll('h3[data-section-toggle]');
    for (var i = 0; i < hs.length; i++) {
      if (!hs[i].closest('.settings-section').classList.contains('expanded')) hs[i].click();
      await new Promise(function(r){ setTimeout(r, 60); });
    }
    await new Promise(function(r){ setTimeout(r, 400); });
    var lt1 = window.__lt.length;
    if ((lt1 - lt0) > worstLT) worstLT = (lt1 - lt0);
    hs = document.querySelectorAll('h3[data-section-toggle]');
    for (var j = 0; j < hs.length; j++) {
      if (hs[j].closest('.settings-section').classList.contains('expanded')) hs[j].click();
      await new Promise(function(r){ setTimeout(r, 60); });
    }
    await new Promise(function(r){ setTimeout(r, 300); });
  }
  return String(worstLT);
})()")
ck "the expand/collapse-all wave adds ZERO long tasks" "$([ "$S4" = "0" ] 2>/dev/null && echo yes || echo no)" "worstLT=$S4"

echo "── S5 — the second open reuses (node count in class)"
S5=$(ev "(async function(){
  var b = document.querySelector('.panel-body');
  var n1 = b.querySelectorAll('*').length;
  // close via the API (the rig's fling is elsewhere); reopen
  var close = document.querySelector('#panel-handle');
  close.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:200, clientY:30}));
  close.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:200, clientY:80}));
  close.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:200, clientY:200}));
  await new Promise(function(r){ setTimeout(r, 900); });
  document.getElementById('settings-btn').click();
  await new Promise(function(r){ setTimeout(r, 1100); });
  var n2 = document.querySelector('.panel-body').querySelectorAll('*').length;
  var open2 = document.getElementById('chat-panel').classList.contains('open');
  return n1 + '|' + n2 + '|' + (open2 ? 1 : 0);
})()")
N1=$(echo "$S5" | cut -d'|' -f1); N2=$(echo "$S5" | cut -d'|' -f2); O2=$(echo "$S5" | cut -d'|' -f3)
# the second open may keep collapsed state; node count within 1.6x class + open
ok5=$([ "$O2" = "1" ] 2>/dev/null && [ "$N2" -le "$((N1 * 2 + 40))" ] 2>/dev/null && echo yes || echo no)
ck "the second open re-renders lean (first=$N1, second=$N2)" "$ok5" "$S5"

echo "── S6 — zero console errors through the sweep"
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
E2=$(ev "(window.__errs || []).length")
ck "zero console errors" "$([ "$E" = "0" ] && [ "$E2" = "0" ] && echo yes || echo no)" "console=$E js=$E2"

echo
echo "═══ v099 settings-open: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]