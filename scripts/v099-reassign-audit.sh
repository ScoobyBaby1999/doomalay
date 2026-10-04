#!/bin/bash
# v099-reassign-audit.sh — THE CENSUS REASSIGNMENT AUDIT (v0.99.5 gate).
#
# THE CONTRACT — the census's overlap findings are each verified dead or
# reassigned on the LIVE sheet:
#  (R1) no border/outline declaration paints a SURFACE var anymore
#       (the 74+ surface-painted hairlines → the ONE hairline owner).
#  (R2) the border-gradient twin is GONE everywhere (no consumer, no
#       gate, no GATES minting) — plate stacks are 2-layer.
#  (R3) the accent-text ban: no `color: var(--accent…)` on prose
#       (the whitelisted survivors: icons on actionable/state elements
#       + the GATES-derived window families + hub-tone indirections).
#  (R4) the fmt-a1 title family: an a1 gradient clips the titles;
#       body text/labels stay SOLID ink forever (the dual track).
#  (R5) --border-rgb composes (the rgba() hairline users).
#  (R6) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8409
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v099re
export AGENT_BROWSER_SESSION=doomalay-v099re

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[1] if len(v)>1 else v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v099r-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.0
ev "Settings.setState({themeOverrides:{}, fmtOverrides:{}}); 'reset'" >/dev/null
sleep 0.6

echo "── R1 — no border paints a surface var (the live sheet census)"
R1=$(ev "(function(){
  var bad = [];
  for (var si = 0; si < document.styleSheets.length; si++) {
    var rules; try { rules = document.styleSheets[si].cssRules; } catch (e) { continue; }
    (function walk(rs){
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (!r.style || !r.selectorText) continue;
        ['border','border-top','border-bottom','border-left','border-right',
         'border-color','border-top-color','border-bottom-color',
         'border-left-color','border-right-color'].forEach(function(p){
          var v = r.style.getPropertyValue(p) || '';
          if (/var\(--surface-[23]\)/.test(v)) bad.push(r.selectorText.slice(0,40) + ' → ' + p);
        });
      }
    })(rules);
  }
  return bad.length ? bad.slice(0,5).join(' ; ') : 'clean';
})()")
ck "zero border-on-surface declarations on the live sheet" "$([ "$R1" = "clean" ] && echo yes || echo no)" "$R1"

echo "── R2 — the border-gradient twin is gone everywhere"
R2=$(ev "(function(){
  var refs = 0;
  for (var si = 0; si < document.styleSheets.length; si++) {
    var rules; try { rules = document.styleSheets[si].cssRules; } catch (e) { continue; }
    (function walk(rs){
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (!r.cssText) continue;
        if (r.cssText.indexOf('--border-gradient') !== -1) refs++;
      }
    })(rules);
  }
  var gate = document.documentElement.getAttribute('data-border-grad');
  return 'refs:' + refs + ' gate:' + (gate || 'absent');
})()")
ck "zero --border-gradient consumers + the gate never fires" "$(echo "$R2" | grep -q 'refs:0 gate:absent' && echo yes || echo no)" "$R2"

echo "── R3 — the accent-text ban (live census with the state-marker whitelist)"
R3=$(ev "(function(){
  // the survivors are icons on actionable/state elements — everything
  // else must be ink/fmt.
  var WL = /\.(eb-ico|tpl-chip-ico|ts-on-ico|wt-guard-ico|hp-star|hp-icocell\[data-on)/;
  var bad = [];
  for (var si = 0; si < document.styleSheets.length; si++) {
    var rules; try { rules = document.styleSheets[si].cssRules; } catch (e) { continue; }
    (function walk(rs){
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
        if (!r.style || !r.selectorText) continue;
        var col = (r.style.getPropertyValue('color') || '').trim();
        if (!/^var\(--accent(-[234])?\)$/.test(col)) continue;
        if (r.selectorText.indexOf('[data-a') !== -1) continue;  // the gate families (on-accent inks)
        if (WL.test(r.selectorText)) continue;
        bad.push(r.selectorText.slice(0, 44) + ':' + col);
      }
    })(rules);
  }
  return bad.length ? bad.slice(0, 6).join(' ; ') : 'clean';
})()")
ck "zero accent-colored prose on the live sheet (icons whitelisted)" "$([ "$R3" = "clean" ] && echo yes || echo no)" "$R3"

echo "── R4 — the fmt-a1 title family (the text-gradient track, one way)"
R4=$(ev "(async function(){
  // a gradient on a1 clips the titles; the body text stays solid ink
  Settings.setState({fmtOverrides:{ a1: { colors: ['#22d3ee', '#a78bfa'], dir: 'h' } }});
  await new Promise(function(r){ setTimeout(r, 700); });
  var attr = document.documentElement.getAttribute('data-fmt-grad');
  var cs = getComputedStyle(document.documentElement);
  var a1Grad = cs.getPropertyValue('--fmt-a1-gradient').trim();
  // a SYNTHETIC title probe (the family's rule fires on class, anywhere)
  var probe = document.createElement('div');
  probe.className = 'hi-title';
  probe.textContent = 'probe';
  document.body.appendChild(probe);
  var bodyProbe = document.createElement('div');
  bodyProbe.className = 'placeholder';
  bodyProbe.textContent = 'placeholder-probe';
  document.body.appendChild(bodyProbe);
  var titleBg = getComputedStyle(probe).backgroundImage;
  var titleColor = getComputedStyle(probe).color;
  var bodyColor = getComputedStyle(bodyProbe).color;
  var bodyBg = getComputedStyle(bodyProbe).backgroundImage;
  Settings.setState({fmtOverrides:{}});
  await new Promise(function(r){ setTimeout(r, 500); });
  var attrAfter = document.documentElement.getAttribute('data-fmt-grad');
  var after = getComputedStyle(probe).backgroundImage;
  var bodyAfter = getComputedStyle(bodyProbe).color;
  probe.remove(); bodyProbe.remove();
  return JSON.stringify({attr: attr, a1: a1Grad.slice(0,30), titleBg: titleBg.slice(0,30),
    titleColor: titleColor.slice(0,26), bodyColor: bodyColor.slice(0,20), bodyBg: bodyBg.slice(0,12),
    attrAfter: attrAfter, after: after.slice(0,20), bodyAfter: bodyAfter.slice(0,20)});
})()")
A4=$(echo "$R4" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    ok = d.get('attr') == 'a1' and 'linear-gradient' in d.get('a1','') and \
         'linear-gradient' in d.get('titleBg','') and d.get('attrAfter') is None and \
         d.get('after','none') in ('none','') and \
         d.get('bodyBg','none') in ('none','') and d.get('bodyAfter','') != ''
    print('yes' if ok else 'no')
except Exception: print('no')")
ck "a1 gradient clips the titles; clearing restores solid ink" "$A4" "$R4"

echo "── R5 — --border-rgb composes"
R5=$(ev "(function(){
  var v = getComputedStyle(document.documentElement).getPropertyValue('--border-rgb').trim();
  return /^[\d]+,\s*[\d]+,\s*[\d]+$/.test(v) ? 'ok(' + v + ')' : 'BAD(' + v + ')';
})()")
ck "the border triplet is a composed 'r,g,b' string" "$(echo "$R5" | grep -q '^ok(' && echo yes || echo no)" "$R5"

echo "── R6 — zero console errors"
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
echo "═══ v099 reassign audit: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]