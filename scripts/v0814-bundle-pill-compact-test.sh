#!/bin/bash
# v0814-bundle-pill-compact-test.sh — THE COMPACT BUNDLE PILL (user
# spec: "the current-turn bundle pill should be much smaller, fitting
# in the same row as the lib pill, positioned immediately to its
# right"): the #seg-lib-bundle segment shrinks (font 9.5px, padding
# 3/7, max-width 88px), stays the THIRD child of the #seg-lib row
# (immediately right of the +, which is right of the 🛠 lib label),
# and caps its label via shortCap (full name rides the tooltip).
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
PORT=8344
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0814
export AGENT_BROWSER_SESSION=doomalay-v0814

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0814-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Pill Chat","sandbox":"quick","model":"privatemodeai/mock-pm","provider":"privatemodeai"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'p1',type:'chat',name:'Pill Chat',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3

# arm a bundle with a LONG name — the pill must cap it
ev "(function(){
  window.ChatPanel.applyBundle({ id: 'superpowers-mega-bundle-name', name: 'superpowers-mega-bundle-name',
    tag: '', members: [{ type: 'skill', name: 'member-one', repo: 'r/x', id: 'i1' }] });
  return 'armed';
})()" >/dev/null; sleep 1.2

P=$(ev "(function(){
  var seg = document.getElementById('seg-lib-bundle');
  var wrap = document.getElementById('seg-lib');
  var plus = document.getElementById('seg-lib-plus');
  var lab = document.getElementById('seg-lib-label');
  if (!seg || !wrap || !plus || !lab) return JSON.stringify({ missing: true });
  var cs = getComputedStyle(seg);
  var sr = seg.getBoundingClientRect(), pr = plus.getBoundingClientRect();
  var wr = wrap.getBoundingClientRect();
  // same row: vertically inside the wrap; immediately right of the +
  var kids = Array.prototype.slice.call(wrap.children).map(function (k) { return k.id; });
  return JSON.stringify({
    visible: seg.style.display !== 'none' && cs.display !== 'none',
    inWrap: seg.parentElement === wrap,
    order: kids.join('|'),
    rightOfPlus: Math.abs(sr.left - pr.right) < 2.5,
    sameRow: sr.top >= wr.top - 1 && sr.bottom <= wr.bottom + 1,
    fs: cs.fontSize, mw: cs.maxWidth,
    pad: cs.paddingTop + '/' + cs.paddingRight + '/' + cs.paddingBottom + '/' + cs.paddingLeft,
    width: Math.round(sr.width),
    label: seg.textContent,
    labelLen: seg.textContent.length,
    titleCarriesFullName: seg.title.indexOf('superpowers-mega-bundle-name') >= 0
  });
})()")
Z=$(echo "$P" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if d.get('missing'): print('no'); exit()
ok = (d['visible'] and d['inWrap'] and d['order'] == 'seg-lib-label|seg-lib-plus|seg-lib-bundle' and
      d['rightOfPlus'] and d['sameRow'] and d['fs'] == '9.5px' and d['mw'] == '88px' and
      d['pad'] == '3px/7px/3px/6px' and d['width'] <= 90 and
      d['labelLen'] <= 14 and d['label'].endswith('…') and d['titleCarriesFullName'])
print('yes' if ok else 'no')")
ck "compact pill: 3rd child of the lib row, immediately right of +, same row, 9.5px/88px/3-7 pad, capped label, full name in tooltip" "$Z" "$P"

# the row stays one control group: the wrap's width is modest (label + + + seg)
ROW=$(ev "(function(){
  var wrap = document.getElementById('seg-lib');
  var r = wrap.getBoundingClientRect();
  var bar = document.getElementById('chat-toolbar');
  var br = bar ? bar.getBoundingClientRect() : null;
  return JSON.stringify({ wrapW: Math.round(r.width), barW: br ? Math.round(br.width) : 0 });
})()")
Z2=$(echo "$ROW" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['wrapW'] < 200
print('yes' if ok else 'no')")
ck "the whole lib row (label + + + bundle segment) stays compact (<200px)" "$Z2" "$ROW"

ERRS=$(agent-browser errors 2>/dev/null | python3 -c "
import sys
lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
print(len(lines))")
ck "zero console errors" "$( [ "$ERRS" = "0" ] && echo yes || echo no )" "$ERRS errors"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "V0814 BUNDLE-PILL-COMPACT: ALL GREEN" || exit 1
