#!/bin/bash
# v088-kronos-live-test.sh — THE KRONOS BUNDLE, LIVE (v0.88.4).
#
# The port (PLAN-KRONOS-BUNDLE.md, the tools/kronos-corpus.py generator)
# put shiyu-coder/Kronos into the public library as the bundle
# `kronos-shiyu` on the REAL Hugging Face (dataset
# ScoobyBaby1999/doomalay-kronos: the full upstream tree + 6 skills +
# 4 docs + the manifest). THIS rig proves it end-to-end against the LIVE
# hub — the same engine a real user runs, no mocks.
#
# (NOTE: every JSON check reads a FILE — responses with escaped quotes
# (\" in payloads) get corrupted through bash double-quoted python -c
# embeddings; the file path is byte-exact.)
#
#  (1) DISCOVERY — the hub's collections list KRONOS-SHIYU (the
#      doomalay-* name search finds the dataset; anonymous — exactly how
#      a fresh user sees the public library);
#  (2) THE BUNDLE — the members list 10 items (6 skills + 4 docs), every
#      one crediting shiyu-coder/Kronos (a port NEVER reads as original)
#      + carrying its repo (the v0.88.4 scan-stamp fix), the manifest
#      description riding the hero;
#  (3) THE DOWNLOAD — the SSE bundle download lands ALL 10 items locally
#      (done=10 failed=0; SQLite rows; skills + the hidden-but-
#      registered docs);
#  (4) THE PAYLOADS — the umbrella skill's SKILL.md reads (the Kronos
#      methodology + the NeoQuasar weights table) and the repo-file
#      route serves the REAL upstream code (model/kronos.py) incl. the
#      LFS-hosted binaries (figures/logo.png);
#  (5) THE BOT PATH — hublib search lists the kronos skills + hublib get
#      returns the payload + the port credit;
#  (6) THE DELETE — bundle delete removes every local row (the ONE
#      LAW's restore semantics);
#  (7) THE ONE LAW — zero "kronos" strings in the DEFAULT APP.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8399
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v088k
REPO=ScoobyBaby1999/doomalay-kronos
ENCREPO=ScoobyBaby1999%2Fdoomalay-kronos
W=/tmp/v088k-work
mkdir -p $W

PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v088k-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up (LIVE hub — no mocks)" || { echo "BOOT FAIL"; exit 1; }

echo "── (1) discovery: the collections list names kronos-shiyu"
# the first call pays the whole discovery fan-out (search + tag + ~10
# repos × live scans — the request blocks until it lands)
FOUND=no
for i in $(seq 1 12); do
  curl -s --max-time 120 "$BASE/api/hub/collections" -o $W/coll.json
  FOUND=$(python3 -c "
import json
try:
    d = json.load(open('$W/coll.json'))
    ids = [str(c.get('id') or '') for c in (d.get('collections') or [])]
    print('yes' if 'kronos-shiyu' in ids else 'no')
except Exception:
    print('no')")
  [ "$FOUND" = "yes" ] && break
  sleep 4
done
ck "the LIVE hub lists the kronos-shiyu bundle" "$FOUND" "$(head -c 160 $W/coll.json)"

echo "── (2) the bundle: members + credit"
curl -s --max-time 60 "$BASE/api/hub/collections/kronos-shiyu/items" -o $W/mem.json
ck "10 members (6 skills + 4 docs)" \
   "$(python3 -c "
import json
try:
    d = json.load(open('$W/mem.json'))
    items = []
    for g in (d.get('groups') or []):
        items.extend(g.get('items') or [])
    skills = [i for i in items if i.get('type') == 'skill']
    docs = [i for i in items if i.get('type') == 'doc']
    print('yes' if len(items) == 10 and len(skills) == 6 and len(docs) == 4 else 'no')
except Exception: print('no')")" "$(head -c 160 $W/mem.json)"
ck "every member carries the upstream credit (a port never reads as original)" \
   "$(python3 -c "
import json
try:
    d = json.load(open('$W/mem.json'))
    items = []
    for g in (d.get('groups') or []):
        items.extend(g.get('items') or [])
    ok = all('Kronos' in str(i.get('upstream') or '') for i in items)
    print('yes' if ok and len(items) == 10 else 'no')
except Exception: print('no')")" "$(head -c 160 $W/mem.json)"
ck "every member carries its repo (the v0.88.4 scan-stamp fix)" \
   "$(python3 -c "
import json
try:
    d = json.load(open('$W/mem.json'))
    items = []
    for g in (d.get('groups') or []):
        items.extend(g.get('items') or [])
    ok = all(str(i.get('repo') or '') == '$REPO' for i in items)
    print('yes' if ok and len(items) == 10 else 'no')
except Exception: print('no')")" "$(head -c 160 $W/mem.json)"
ck "the bundle hero rides the manifest description (the editorial truth)" \
   "$(python3 -c "
import json
try:
    d = json.load(open('$W/coll.json'))
    k = [c for c in (d.get('collections') or []) if c.get('id') == 'kronos-shiyu']
    desc = str((k[0] or {}).get('description') or '') if k else ''
    print('yes' if 'foundation model' in desc and 'ScoobyBaby1999' in desc else 'no')
except Exception: print('no')")" "$(head -c 160 $W/coll.json)"

echo "── (3) the download: the SSE bundle flow lands all 10"
curl -sN --max-time 240 -X POST "$BASE/api/hub/collections/kronos-shiyu/download" >$W/sse.txt 2>/dev/null
ck "the SSE download completes (done=10 failed=0)" \
   "$(python3 -c "
import re
s = open('$W/sse.txt').read()
m = re.findall(r'\"phase\":\"complete\",\"done\":(\d+),\"total\":(\d+),\"failed\":(\d+)', s)
print('yes' if m and m[-1][0] == '10' and m[-1][2] == '0' else 'no')")" "$(tail -2 $W/sse.txt | tr '\n' ' ' | head -c 160)"
curl -s --max-time 30 "$BASE/api/hub/skill/downloads" -o $W/sk.json
curl -s --max-time 30 "$BASE/api/hub/doc/downloads" -o $W/do.json
echo "  rows: $(python3 -c "
import json
try:
    print('skills=' + str(len(json.load(open('$W/sk.json')).get('items') or [])) + ' docs=' + str(len(json.load(open('$W/do.json')).get('items') or [])))
except Exception as e: print('?' + str(e))")"
ck "6 skill rows + 4 doc rows landed locally (SQLite)" \
   "$(python3 -c "
import json
try:
    s = json.load(open('$W/sk.json')); d = json.load(open('$W/do.json'))
    si = s.get('items') or []
    di = d.get('items') or []
    print('yes' if len(si) == 6 and len(di) == 4 else 'no')
except Exception: print('no')")" "skills:$(head -c 60 $W/sk.json)"

echo "── (4) the payloads: the methodology + the real code"
UMB=$(python3 -c "
import json
try:
    s = json.load(open('$W/sk.json'))
    for row in (s.get('items') or []):
        it = row.get('item') or {}
        if it.get('name') == 'Kronos' or str(it.get('id') or '').startswith('kronos-1573'):
            print(it.get('id') or ''); break
except Exception: pass")
[ -n "$UMB" ] || UMB=kronos-1573b0
curl -s --max-time 60 "$BASE/api/hub/skill/item/$ENCREPO/$UMB" -o $W/item.json
ck "the umbrella skill's payload is the Kronos methodology (weights table + quickstart)" \
   "$(python3 -c "
import json
try:
    d = json.load(open('$W/item.json'))
    p = str(d.get('payload') or '')
    print('yes' if 'KronosPredictor' in p and 'NeoQuasar/Kronos-small' in p else 'no')
except Exception: print('no')")" "$(head -c 130 $W/item.json)"
curl -s --max-time 90 "$BASE/api/hub/repo/$ENCREPO/file?path=model/kronos.py" -o $W/kronos.py
ck "the repo-file route serves the REAL model/kronos.py" \
   "$(python3 -c "
s = open('$W/kronos.py', errors='replace').read()
print('yes' if 'Kronos' in s[:600] and 'class' in s[:3000] and len(s) > 5000 else 'no')")" "$(head -c 100 $W/kronos.py)"
LOGO=$(curl -s --max-time 120 -o $W/logo.png -w '%{http_code} %{size_download}' "$BASE/api/hub/repo/$ENCREPO/file?path=figures/logo.png")
ck "the LFS binary resolves through the engine (figures/logo.png)" \
   "$(python3 -c "
s = '''$LOGO'''
parts = s.split()
print('yes' if len(parts) == 2 and parts[0] == '200' and int(parts[1]) > 500000 else 'no')")" "$LOGO"

echo "── (5) the bot path: hublib"
HB=$(curl -s --max-time 60 "$BASE/api/tools/hublib?action=search&type=skill&q=kronos")
ck "hublib search lists the kronos skills (the bot's library view)" \
   "$(python3 -c "
s = '''$HB'''
print('yes' if 'kronos' in s.lower() and 'repo:' in s else 'no')")" "$(echo "$HB" | head -c 160)"
curl -s --max-time 60 "$BASE/api/tools/hublib?action=get&type=skill&repo=$REPO&id=$UMB" -o $W/hg.json
ck "hublib get returns the payload + the port credit (the bot reads the methodology)" \
   "$(python3 -c "
import json
try:
    s = str(json.load(open('$W/hg.json')).get('result') or '')
    print('yes' if 'KronosPredictor' in s and 'ported from' in s else 'no')
except Exception:
    s = open('$W/hg.json', errors='replace').read()
    print('yes' if 'KronosPredictor' in s and 'ported from' in s else 'no')")" "$(head -c 130 $W/hg.json)"

echo "── (6) the delete: everything restores"
curl -s --max-time 90 -X POST "$BASE/api/hub/collections/kronos-shiyu/delete" >/dev/null
curl -s --max-time 30 "$BASE/api/hub/skill/downloads" -o $W/sk2.json
curl -s --max-time 30 "$BASE/api/hub/doc/downloads" -o $W/do2.json
ck "bundle delete removes every local row (skills + docs)" \
   "$(python3 -c "
import json
try:
    s = json.load(open('$W/sk2.json')); d = json.load(open('$W/do2.json'))
    si = s.get('items') or []
    di = d.get('items') or []
    print('yes' if len(si) == 0 and len(di) == 0 else 'no')
except Exception: print('no')")" "skills:$(head -c 50 $W/sk2.json)"

echo "── (7) THE ONE LAW: zero kronos strings in the default app"
LAW=$(cd /home/z/doomalay && { grep -ri "kronos" engine/internal/server/web/ engine/internal/hub/ engine/internal/llm/ engine/internal/brain/ engine/cmd/ 2>/dev/null | grep -v "_test.go" | head -3; } | wc -l)
ck "the app ships ZERO Kronos strings (tools/tests/docs excluded by design)" \
   "$([ "$LAW" = "0" ] && echo yes || echo no)" "$LAW matches"

echo ""
echo "════ v088 KRONOS LIVE: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
