#!/bin/bash
# v1003-pseudo-only-test.sh — THE LEGACY BAKE RETIREMENT RIG (v1.00.3 gate).
#
# THE CONTRACT:
#  (P1) gradients on: EVERY painted element is either L2-minted or
#       fallback-FLAGGED (__projL2ok === 0) — "never-eval" riders are
#       zero (every visible element gets its mint decision).
#  (P2) THE PHANTOM PURGE — an element that painted in a transient and
#       resolves image 'none' at a stable snapshot LEAVES the painted
#       set (the set-theme swatch class: the v0.98 flat-gradient plate
#       catcher computes non-none in a mid-flip transient, none at
#       rest — pre-v1.00.3 they rode the set forever).
#  (P3) settings + both sections expanded: every VISIBLE painted
#       element rides L2 — the legacy inline bake has ZERO visible
#       riders at rest (the retirement proof).
#  (P4) the scroll-in: rows scrolled into view mint on the settle
#       paint (the ≤150ms window) — post-settle, zero undecided.
#  (P5) zero console errors through the sweep.
#
# NOTE: the offscreen mint (minting L2 for carried elements while
# hidden) was prototyped and REVERTED — it exposed a pre-existing race
# between the settings-page render lifecycle and the root registry
# (documented in the worklog; a future wave takes it with its own
# investigation). The carried chrome stays inert (its inline bakes
# cost nothing while offscreen; the visible elements self-heal to L2
# on every settle paint).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8416
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1003mint
export AGENT_BROWSER_SESSION=doomalay-v1003mint

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

echo "building engine (forced -a; embed cache gap)…"
(cd engine && PATH="$PATH:$HOME/.local/go/bin:/usr/local/go/bin" go build -a -o "$ENG" ./cmd/doomalay) || { echo "BUILD FAIL"; exit 1; }

rm -rf $DATA; mkdir -p $DATA
agent-browser close >/dev/null 2>&1
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v1003m-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 120); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.4
ev "localStorage.clear(); 'cleared'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.2
ev "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null

echo "── P1 — gradients on: every painted element is minted or flagged"
ev "(function(){
  var s = Settings.getState(); var cur = s.theme || 'midnight';
  var all = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  all[cur] = all[cur] || {};
  all[cur]['--field-surface'] = { colors: ['#1a1a24','#2d2440'], dir: 'auto' };
  all[cur]['--field-accent-1'] = { colors: ['#22d3ee','#f472b6'], dir: 'auto' };
  all[cur]['--field-accent-2'] = { colors: ['#f59e0b','#ef4444'], dir: 'auto' };
  Settings.setState({ themeOverrides: all });
  return 'set';
})()" >/dev/null
sleep 1.4
P1=$(ev "(function(){
  var never = 0, minted = 0, flagged = 0, carried = 0, total = 0;
  document.querySelectorAll('*').forEach(function(el){
    if (!el.__projPainted) return;
    total++;
    if (el.__projCarry) { carried++; return; }   // inert offscreen chrome
    if (el.__projL2) minted++;
    else if (el.__projL2ok === 0) flagged++;
    else never++;
  });
  return total + ' painted / ' + minted + ' minted / ' + flagged + ' flagged / ' + carried + ' carried / ' + never + ' never-eval';
})()")
ck "P1a zero never-eval riders among LIVE elements (carried chrome exempt)" \
   "$(echo "$P1" | grep -qE ' 0 never-eval$' && echo yes || echo no)" "$P1"

echo "── P2 — THE PHANTOM PURGE (image-none riders leave the set)"
ev "document.getElementById('settings-btn').click(); 'opened'" >/dev/null
sleep 1.3
ev "document.querySelectorAll('[data-section-toggle]').forEach(function(h){h.click();}); 'expanded'" >/dev/null
sleep 1.4
P2=$(ev "(function(){
  var stale = [];
  document.querySelectorAll('*').forEach(function(el){
    if (!el.__projPainted || el.__projL2 || el.__projL2ok === 0) return;
    var cs = getComputedStyle(el);
    if (!cs.backgroundImage || cs.backgroundImage === 'none') stale.push(1);
  });
  return stale.length + ' painted-but-image-none riders';
})()")
ck "P2a zero painted-but-image-none riders (the purge holds)" \
   "$(echo "$P2" | grep -q '^0 ' && echo yes || echo no)" "$P2"

echo "── P3 — every VISIBLE painted element rides L2 (the retirement)"
P3=$(ev "(function(){
  var visLegacy = [], visL2 = 0;
  document.querySelectorAll('*').forEach(function(el){
    if (!el.__projPainted) return;
    var r = el.getBoundingClientRect();
    var visible = r.width >= 1 && r.height >= 1 && r.bottom > -60 && r.top <= window.innerHeight + 60;
    if (!visible) return;
    if (el.__projL2) visL2++;
    else visLegacy.push((el.id || String(el.className).slice(0,20)));
  });
  return visL2 + ' visible L2 / ' + JSON.stringify(visLegacy.slice(0,5));
})()")
ck "P3a every VISIBLE painted element rides L2" \
   "$(echo "$P3" | grep -qE ' visible L2 / \[\]$' && echo yes || echo no)" "$P3"

echo "── P4 — the scroll-in mints on the settle paint"
ev "(function(){
  var sc = document.querySelector('.panel-body') || document.scrollingElement;
  sc.scrollTop = 340;
  return 'scrolled';
})()" >/dev/null
sleep 1.0
P4=$(ev "(function(){
  var never = 0, l2 = 0;
  document.querySelectorAll('*').forEach(function(el){
    if (!el.__projPainted || el.__projL2ok === 0) return;
    if (el.__projCarry) return;   // inert offscreen chrome
    if (!el.__projL2) never++;
    else l2++;
  });
  return l2 + ' L2 / ' + never + ' undecided-after-settle';
})()")
ck "P4a post-scroll + settle: zero undecided LIVE riders" \
   "$(echo "$P4" | grep -qE ' 0 undecided' && echo yes || echo no)" "$P4"

echo "── P5 — zero console errors through the sweep"
P5=$(ev "window.__errs.length")
ck "P5a no page errors" "$([ "$P5" = "0" ] && echo yes || echo no)" "$P5"

echo ""
echo "v1003 legacy-bake retirement: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
exit 0
