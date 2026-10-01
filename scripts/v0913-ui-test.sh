#!/bin/bash
# v0913-ui-test.sh — THE PYTHON LIBRARY IN THE APP (the real-user UI pass
# for v0.91.3). The hub page: the Python Library tab pill, the kronos
# python item cards with teaching descriptions, the kronos bunch's topical
# tag row (#readme gone), the superpowers bunch's retagged row (#docs/
# #scripts gone).
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=8517
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0913ui
export AGENT_BROWSER_SESSION=doomalay-v0913ui
HF_KEY="${HF_KEY:-${DOOMALAY_HF_TOKEN:?export DOOMALAY_HF_TOKEN (or HF_KEY) — GitHub push protection blocks the literal}}"
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

ev() { timeout 90 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then echo "PORT BUSY"; exit 1; fi
rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0913ui-eng.log 2>&1 &
ENGPID=$!
trap "kill $ENGPID 2>/dev/null" EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }
OWNER=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ "$OWNER" = "$ENGPID" ] || { echo "ZOMBIE PORT (owner=$OWNER ours=$ENGPID)"; exit 1; }
# the connected-user path (HF rate-limits anonymous resolve reads by IP)
curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
  -d "{\"env_var\":\"DOOMALAY_HF_TOKEN\",\"provider\":\"huggingface\",\"key\":\"$HF_KEY\"}" >/dev/null

echo "── opening the app + the public library"
agent-browser close >/dev/null 2>&1; sleep 1.2
agent-browser open "$BASE" >/dev/null 2>&1
# THE LOAD PROOF: about:blank also reports readyState "complete" — the
# rig must verify the URL actually landed (the CDP auto-launch can flake
# after repeated session churn; one retry fixes it).
for i in 1 2 3 4 5; do
  U=$(ev "location.href" 2>/dev/null)
  case "$U" in *127.0.0.1*|*localhost*) break;; esac
  sleep 1; agent-browser open "$BASE" >/dev/null 2>&1; sleep 1.5
done
case "$U" in *127.0.0.1*|*localhost*) echo "  app loaded ($U)";; *) echo "  APP LOAD FAILED ($U)"; exit 1;; esac
for i in 1 2 3 4 5 6 8; do V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n'); [ "$V" = "complete" ] && break; sleep 0.8; done
ev "localStorage.clear()" >/dev/null 2>&1; sleep 0.5
# THE HOST PANEL: Hub.open() needs an open chat to host the library view
# (no panel → the 'open a chat first' toast and nothing opens — the v071
# rig's pattern: seed a chat first, then open the hub).
ev "(function(){
  for (var i=0;i<30 && !document.getElementById('dock-sub');i++) setTimeout(function(){},0);
  var b = document.getElementById('canvas-empty-btn');
  if (b) b.click();
  return b ? 'seeded' : 'no-btn';
})()" >/dev/null; sleep 2
ev "window.Hub.open(undefined, {chat: {sessionId: 'v0913-ui', title: 'Library Check', name: 'Library Check'}}); 'opened'" >/dev/null
for i in $(seq 1 20); do ev "document.querySelector('.hub-libpill[data-lib=\"python\"]') ? 'y' : ''" | grep -q y && break; sleep 0.5; done

echo "── (1) the Python Library tab"
R=$(ev "(function(){
  var p = document.querySelector('.hub-libpill[data-lib=\"python\"]');
  return p ? (p.textContent || '').trim() : 'MISSING';
})()")
ck "the Python Library tab pill renders" \
   "$(python3 -c "
s='''$R'''
print('yes' if 'Python' in s else 'no')")" "$R"

echo "── (2) the kronos python items in the Python tab"
ev "document.querySelector('.hub-libpill[data-lib=\"python\"]').click()" >/dev/null; sleep 4
R2=$(ev "(function(){
  var cards = document.querySelectorAll('.hub-card');
  var run = 0, names = [];
  cards.forEach(function (c) {
    var t = (c.textContent || '');
    if (t.indexOf('RUN:') >= 0) run++;
    if (t.indexOf('Kronos') >= 0 && names.length < 3) names.push('k');
  });
  return JSON.stringify({n: cards.length, run: run, kronos: names.length});
})()")
ck "python cards render with teaching RUN: descriptions" \
   "$(python3 -c "
import json
try:
    d = json.loads('''$R2''')
    print('yes' if d['n'] >= 6 and d['run'] >= 5 else 'no')
except Exception: print('no')")" "$R2"

echo "── (3) the kronos bunch tag row (#readme → finance/prediction/markets)"
ev "window.Hub.open(); 'opened2'" >/dev/null; sleep 2
ev "document.querySelector('.hub-libpill[data-lib=\"skill\"]').click()" >/dev/null; sleep 4
R3=$(ev "(function(){
  var b = document.querySelector('.hub-card--bunch[data-bunch*=\"kronos\"]') ||
          document.querySelector('.hub-card--bunch[data-bunch]');
  if (!b) return 'NO-BUNCH';
  b.click(); return b.getAttribute('data-bunch');
})()")
sleep 3.5
R3b=$(ev "(function(){
  var chips = document.querySelectorAll('.hi-chip');
  var out = [];
  chips.forEach(function (c) { out.push((c.textContent || '').replace('#','').trim()); });
  return JSON.stringify(out);
})()")
ck "kronos bunch opens; tag row shows the topical tags, #readme gone" \
   "$(python3 -c "
import json
try:
    tags = json.loads('''$R3b''')
    ok = any(t in tags for t in ('finance','prediction','markets','forecasting','stocks'))
    print('yes' if ok and 'readme' not in tags else 'no tags=%s' % tags)
except Exception as e: print('no')")" "$R3 → $R3b"

echo "── (4) the superpowers bunch tag row (#docs/#scripts → agent-skills/methodology/automation)"
ev "window.Hub.open(); 'opened3'" >/dev/null; sleep 2
ev "document.querySelector('.hub-libpill[data-lib=\"skill\"]').click()" >/dev/null; sleep 4
R4=$(ev "(function(){
  var b = document.querySelector('.hub-card--bunch[data-bunch*=\"superpowers\"]');
  if (!b) return 'NO-BUNCH';
  b.click(); return 'clicked';
})()")
sleep 3.5
R4b=$(ev "(function(){
  var chips = document.querySelectorAll('.hi-chip');
  var out = [];
  chips.forEach(function (c) { out.push((c.textContent || '').replace('#','').trim()); });
  return JSON.stringify(out);
})()")
ck "superpowers bunch tag row: agent-skills/methodology, #docs/#scripts gone" \
   "$(python3 -c "
import json
try:
    tags = json.loads('''$R4b''')
    ok = any(t in tags for t in ('agent-skills','methodology','automation'))
    print('yes' if ok and 'docs' not in tags and 'scripts' not in tags else 'no tags=%s' % tags)
except Exception: print('no')")" "$R4 → $R4b"

echo ""
echo "════ v0913 UI: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
