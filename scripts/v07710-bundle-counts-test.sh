#!/bin/bash
# v07710-bundle-counts-test.sh — THE BUNDLE COUNTING + DESCRIPTION WAVE:
#  (1) THE HERO SPLIT — the bundle detail shows the REAL description (the
#      manifest) with the deterministic census line BENEATH it
#  (2) THE PER-USER DOWNLOAD — one bundle download = +1 on the collection
#      (never +6 on the members); a re-download stays +1
#  (3) THE MEMBER DISPLAY — a member shows its OWN counts + the bundle's
#      totals (own 3 + other-user direct 1 + bundle 2 = 6 downloads)
#  (4) THE PER-USER ENDORSE — the bundle ♥ = ONE heart on the collection
#      (the member fan-out is retired); locked before download
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8341
BASE=http://127.0.0.1:$PORT
MOCK=8340
DATA=/tmp/doomalay-v07710
export AGENT_BROWSER_SESSION=doomalay-v07710

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
python3 scripts/v07710-mock-hub.py $MOCK >/tmp/v07710-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:$MOCK
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v07710-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# warm the hub cache (the first Collections() discovers the repos)
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c1.json
sleep 1
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c2.json

# (1) the description + the census ride the summary
DESC=$(python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/v07710-c2.json'))
b = next((c for c in d.get('collections', []) if c.get('id') == 'superpowers-count'), None)
if not b:
    print('no:no-bunch')
else:
    ok = ('counting bundle' in (b.get('description') or '').lower() and
          b.get('members') == 6 and b.get('upstream'))
    print('yes' if ok else 'no:' + json.dumps({k: b.get(k) for k in ('description','members','upstream')}))
PYEOF
)
ck "the summary carries the manifest description + upstream + members" "$DESC" "$DESC"

# (2) THE PER-USER DOWNLOAD: download the bundle → collection downloads +1
#     (others=1 + local=1 = 2), members NEVER +1 each
# the download endpoint streams SSE — the verification rides the collections fetch
curl -s -X POST "$BASE/api/hub/collections/superpowers-count/download" > /tmp/v07710-dl.sse 2>/dev/null
DL1="sse-$(grep -c 'phase' /tmp/v07710-dl.sse 2>/dev/null || echo 0) events"
sleep 1
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c3.json
CNT1=$(python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/v07710-c3.json'))
b = next((c for c in d.get('collections', []) if c.get('id') == 'superpowers-count'), None)
if not b:
    print('no:no-bunch')
else:
    # others' bundle downloads (1) + the local +1 (1) = 2 — NOT 1+6
    ok = b.get('downloads') == 2 and b.get('downloaded') is True
    print('yes' if ok else 'no:' + json.dumps({k: b.get(k) for k in ('downloads','hearts','downloaded')}))
PYEOF
)
ck "one bundle download counts ONCE (2 = 1 other + 1 local, not +6)" "$CNT1" "$CNT1"

# a RE-DOWNLOAD stays +1 (per-user idempotent)
curl -s -X POST "$BASE/api/hub/collections/superpowers-count/download" > /dev/null
sleep 1
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c4.json
CNT2=$(python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/v07710-c4.json'))
b = next((c for c in d.get('collections', []) if c.get('id') == 'superpowers-count'), None)
print('yes' if b and b.get('downloads') == 2 else 'no:' + str(b and b.get('downloads')))
PYEOF
)
ck "a re-download stays +1 (per-user idempotent)" "$CNT2" "$CNT2"

# (3) THE MEMBER DISPLAY: member 0's own downloads (3 base + 1 other-user
#     direct + 0 local-direct... the bundle download does NOT add) + the
#     bundle totals (2) → the served member counts
MEM=$(curl -s "$BASE/api/hub/skill/items?q=count%20skill%200" | python3 -c "
import json,sys
d = json.load(sys.stdin)
items = d.get('items', [])
it = next((x for x in items if x.get('id') == 'skill-count-000000'), None)
print(json.dumps({'downloads': it and it.get('downloads'), 'hearts': it and it.get('hearts')}))")
MEMCK=$(echo "$MEM" | python3 -c "
import json,sys
d = json.load(sys.stdin)
# own: 3 base + 1 other-user direct + 0 (local via-collection suppressed)
# + bundle: 2 (1 other + 1 local) = 6 downloads; hearts: 2 base + 1 bundle heart = 3
ok = d['downloads'] == 6 and d['hearts'] == 3
print('yes' if ok else 'no')")
ck "member display = own counts + bundle totals (downloads 6, hearts 3)" "$MEMCK" "$MEM"

# a member downloaded DIRECTLY keeps its own +1 (via=0 semantics)
curl -s -X POST "$BASE/api/hub/skill/download" -H 'Content-Type: application/json' -d '{"repo":"mocklib/superpowers-count","id":"skill-count-000001"}' > /dev/null 2>&1
sleep 0.5
DIR=$(curl -s "$BASE/api/hub/skill/items?q=count%20skill%201" | python3 -c "
import json,sys
d = json.load(sys.stdin)
it = next((x for x in d.get('items', []) if x.get('id') == 'skill-count-000001'), None)
print(it and it.get('downloads'))")
ck "a directly-downloaded member keeps its own +1 (4 + bundle 2 = 6)" "$([ "$DIR" = "6" ] && echo yes || echo no)" "$DIR"

# (4) THE PER-USER ENDORSE: locked before... (already downloaded here) —
#     the ♥ lands ONCE on the collection
E1=$(curl -s -X POST "$BASE/api/hub/collections/superpowers-count/endorse" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(json.dumps(d))")
sleep 0.8
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c5.json
END=$(python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/v07710-c5.json'))
b = next((c for c in d.get('collections', []) if c.get('id') == 'superpowers-count'), None)
# hearts: 1 other-user bundle heart + 1 own = 2 — never +6 members
print('yes' if b and b.get('hearts') == 2 and b.get('hearted') is True
      else 'no:' + json.dumps({k: b.get(k) for k in ('hearts','hearted')}) if b else 'no:no-bunch')
PYEOF
)
ck "the bundle ♥ counts ONCE (2 = 1 other + 1 own, never +6)" "$END" "$END / $E1"

# un-endorse → back to 1
curl -s -X POST "$BASE/api/hub/collections/superpowers-count/unendorse" > /dev/null
sleep 0.8
curl -s "$BASE/api/hub/collections" > /tmp/v07710-c6.json
UN=$(python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/v07710-c6.json'))
b = next((c for c in d.get('collections', []) if c.get('id') == 'superpowers-count'), None)
print('yes' if b and b.get('hearts') == 1 else 'no:' + str(b and b.get('hearts')))
PYEOF
)
ck "un-endorse returns to 1 (toggle-idempotent)" "$UN" "$UN"

# (5) the UI: the hero renders the description ABOVE the census info line
agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' -d '{"title":"Count Bot","sandbox":"quick","model":"m/m","provider":"m"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Count Bot',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'m/m',provider:'m',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
ev "window.Hub.open(undefined, {chat: {sessionId: '$SID', title: 'Count Bot', name: 'Count Bot'}}); 'opened'" >/dev/null; sleep 3
# the hub home shows the libraries — the bunch cards live inside a library view
ev "(function(){ var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); if (p) p.click(); return 'picked'; })()" >/dev/null; sleep 3
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch=\"superpowers-count\"]'); if (b) { b.click(); return 'card'; } return 'no-card'; })()" >/dev/null; sleep 3
HERO=$(ev "(function(){
  var hero = document.getElementById('hub-bunch-hero');
  if (!hero) return 'no-hero';
  var desc = hero.querySelector('.hub-bunch-hero-desc');
  var info = hero.querySelector('.hub-bunch-hero-info');
  return JSON.stringify({
    desc: desc ? desc.textContent.slice(0, 60) : null,
    info: info ? info.textContent.slice(0, 40) : null,
    order: (desc && info) ? (desc.compareDocumentPosition(info) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false
  });
})()")
HCK=$(echo "$HERO" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    ok = d.get('desc') and 'counting bundle' in d['desc'].lower() and d.get('info') and 'bundled items' in d['info'] and d.get('order')
    print('yes' if ok else 'no')
except Exception:
    print('no')")
ck "the hero renders the description ABOVE the census info line" "$HCK" "$HERO"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.10 bundle-counts suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
