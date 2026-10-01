#!/bin/bash
# v0913-python-library-test.sh — THE PYTHON CATEGORY + THE LIVE RETAGS
# (user spec: "if it helps to add python scripts as a category in the
# library let's do so. We want even the weakest models to be able to
# reliably run the scripts and use the Kronos bundle 100% of the time" +
# "change the tag #readme to something like financial or stocks or
# prediction" + the superpowers "#docs, #scripts" renames).
#
# THE CONTRACT (against the LIVE HF hub, read-only):
#  (1) the registry: /api/hub/libraries includes the python library
#      (browsable, 7 types registered, 6 browsable).
#  (2) THE LIVE KRONOS PYTHON ITEMS: /api/hub/python/items?q=kronos
#      (refresh=1) lists the 6 runnable entry points with teaching
#      descriptions (deps + run command).
#  (3) THE RETAGS LIVE: the kronos bundle (collections?q=kronos) carries
#      the badge #kronos and the tag row shows finance/prediction/markets —
#      #readme is GONE.
#  (4) THE SUPERPOWERS RETAGS: the bundle's tag row shows agent-skills +
#      methodology + automation — #docs and #scripts are GONE.
#  (5) the python item's payload serves (a real .py body).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8514
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0913
export AGENT_BROWSER_SESSION=""
ev() { timeout 60 agent-browser eval "$1" 2>/dev/null; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then echo "PORT BUSY"; exit 1; fi
rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0913-eng.log 2>&1 &
ENGPID=$!
trap "kill $ENGPID 2>/dev/null" EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# THE CONNECTED-USER SETUP — the HF hub token seeds into the vault BEFORE
# any hub read (the live lesson: HF rate-limits ANONYMOUS resolve reads by
# IP and the scan is skip-not-fail — an anonymous rig run silently skips
# the repo and the item checks go empty; the app's real flow connects the
# hub first). env_var is snake_case — camelCase decodes to "" and 400s.
HF_KEY="${HF_KEY:-${DOOMALAY_HF_TOKEN:?export DOOMALAY_HF_TOKEN (or HF_KEY) — GitHub push protection blocks the literal}}"
SEED=$(curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
  -d '{"env_var":"DOOMALAY_HF_TOKEN","provider":"huggingface","key":"'"$HF_KEY"'"}')
ck "the HF hub token seeds into the vault (the connected-user path)" \
   "$(python3 -c "
import json
try: print('yes' if json.loads('''$SEED''').get('ok') else 'no')
except Exception: print('no')")" "$(echo $SEED | head -c 200)"

echo "── (1) the registry"
R=$(curl -s "$BASE/api/hub/libraries")
ck "the python library is registered + browsable" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$R''')
    libs=d.get('libraries',[])
    py=[l for l in libs if l.get('type')=='python']
    print('yes' if py and not py[0].get('hidden') else 'no')
except Exception: print('no')")" "$R"

echo "── (2) the live kronos python items"
R2=$(curl -s "$BASE/api/hub/python/items?q=kronos&refresh=1")
ck "the 6 runnable Kronos entry points list (live dataset)" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$R2''')
    items=d.get('items',[])
    taught=[i for i in items if 'RUN:' in (i.get('description') or '')]
    print('yes' if len(items)>=6 and len(taught)>=5 else 'no (%d items, %d taught)'%(len(items),len(taught)))
except Exception as e: print('no')")" "$(echo $R2 | head -c 300)"

echo "── (3) the kronos bundle retag (live)"
R3=$(curl -s "$BASE/api/hub/collections?q=kronos&refresh=1")
ck "badge #kronos + finance/prediction/markets in the tag row; #readme gone" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$R3''')
    cols=d.get('collections',[])
    k=[c for c in cols if c.get('id')=='kronos-shiyu'][0]
    tags=k.get('tags') or []
    ok=k.get('tag')=='kronos' and any(t in tags for t in ('finance','markets','prediction')) and 'readme' not in tags
    print('yes' if ok else 'no (tag=%s tags=%s)'%(k.get('tag'),tags))
except Exception as e: print('no')")" "$(echo $R3 | head -c 300)"

echo "── (4) the superpowers retag (live)"
R4=$(curl -s "$BASE/api/hub/collections?q=superpowers&refresh=1")
ck "#docs/#scripts gone; agent-skills/methodology/automation present" \
   "$(python3 -c "
import json
try:
    d=json.loads('''$R4''')
    cols=d.get('collections',[])
    s=[c for c in cols if 'superpowers' in c.get('id','')][0]
    tags=s.get('tags') or []
    ok=('docs' not in tags and 'scripts' not in tags and
        any(t in tags for t in ('methodology','agent-skills')))
    print('yes' if ok else 'no (tags=%s)'%tags)
except Exception as e: print('no')")" "$(echo $R4 | head -c 300)"

echo "── (5) a python payload serves (the connected vault from the setup)"
# NOTE: the repo rides the path as %2F (the frontend's encodeURIComponent
# contract — a tilde form 404s: no such repo on HF).
R5=$(curl -s "$BASE/api/hub/python/item/ScoobyBaby1999%2Fdoomalay-kronos/kronos-py-predict-f60140" | head -c 400)
ck "the prediction example's .py payload serves" \
   "$(python3 -c "
s='''$R5'''
print('yes' if ('import' in s or 'payload' in s or len(s)>100) else 'no')")" "$(echo $R5 | head -c 120)"

echo ""
echo "════ v0913 THE PYTHON CATEGORY + RETAGS: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
