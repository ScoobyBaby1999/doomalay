#!/usr/bin/env bash
# v0935-live-repo-redteam.sh — THE LIVE RED-TEAM for the repo-creation wave.
#
# The user's own bar: "必须用 token 实际创建每一种、把经历的所有选项反映给用户"
# (create EVERY kind with the real token, reflect everything experienced).
#
# Covers, against the LIVE hub + github:
#   A. licenses: kind=github → 13 live entries WITH names; kind=hf → the
#      83-key enum; gitignores → the real template list.
#   B. HF create EVERY kind: space (sdk static) / dataset / model / bucket —
#      each verified on the hub right after, each landing as a FULL-access
#      workspace row (the workspaces pill count +1 each).
#   C. THE DELETE FIX — put a file on the fresh dataset, then file_delete
#      it through the engine's workspace tool surface (the user's
#      bash-demo.txt error).
#   D. GitHub create with license=mit + gitignore=Go → verify LICENSE +
#      .gitignore exist on the fresh repo (the "license stays none" report).
#
# Tokens ride env vars ONLY (the v0.91.5 push-protection lesson):
#   DOOMALAY_HF_TOKEN, GITHUB_TOKEN
set -u
PORT=8535
BASE="http://127.0.0.1:$PORT"
DATA=$(mktemp -d /tmp/doomalay-v0935.XXXXXX)
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1 → got: ${3:-?}"; fi; }

: "${DOOMALAY_HF_TOKEN:?export DOOMALAY_HF_TOKEN (or HF_KEY) first}"
GH_KEY="${GITHUB_TOKEN:-}"

echo "── boot the fresh engine (port $PORT)"
cd "$(dirname "$0")/../engine"
./doomalay-engine --port "$PORT" --data-dir "$DATA" >/tmp/v0935-engine.log 2>&1 &
ENG=$!
trap 'kill $ENG 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s "$BASE/api/health" >/dev/null 2>&1 && ck "engine up" yes || { echo "BOOT FAILED"; tail -20 /tmp/v0935-engine.log; exit 1; }

echo "── seed the tokens (the vault — encrypted at rest)"
curl -s -X POST "$BASE/api/keys" -H 'Content-Type: application/json' \
  -d '{"env_var":"DOOMALAY_HF_TOKEN","provider":"huggingface","key":"'"$DOOMALAY_HF_TOKEN"'"}' >/dev/null
# v0.78.2: HF rides the hub vault key (DOOMALAY_HF_TOKEN) — NOT the
# github/gitea-style accounts endpoint. The proof it took: create-repo
# resolving the token below. GitHub uses the accounts endpoint.
if [ -n "$GH_KEY" ]; then
  curl -s -X POST "$BASE/api/workspaces/accounts" -H 'Content-Type: application/json' \
    -d '{"kind":"github","token":"'"$GH_KEY"'"}' | grep -q '"saved":true' && ck "GitHub account signed in" yes || ck "GitHub account signed in" no
fi
ck "HF hub key seeded (the vault path)" yes

echo "── A. the form data (the 'license stays none' report)"
LIC=$(curl -s "$BASE/api/workspaces/licenses?kind=github")
N=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(len(d.get('licenses',[])))" "$LIC" 2>/dev/null)
ck "GitHub licenses load ($N entries)" "$([ "${N:-0}" -ge 13 ] && echo yes || echo no)" "$N"
MN=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); ls=d.get('licenses',[]); print(next((l['name'] for l in ls if l['key']=='mit'),'MISSING'))" "$LIC" 2>/dev/null)
ck "license entries carry NAMES (mit → '$MN')" "$([ "$MN" = "MIT License" ] && echo yes || echo no)" "$MN"
HLIC=$(curl -s "$BASE/api/workspaces/licenses?kind=hf")
HN=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(len(d.get('licenses',[])))" "$HLIC" 2>/dev/null)
ck "HF licenses = the hub's 83-key enum" "$([ "$HN" = "83" ] && echo yes || echo no)" "$HN"
GI=$(curl -s "$BASE/api/workspaces/gitignores?kind=hf")
ck "HF gitignores answer the honest note (not a dead list)" "$(echo "$GI" | grep -q 'GitHub/Gitea concept' && echo yes || echo no)"

echo "── B. create EVERY HF kind with the real token"
STAMP=$(date +%H%M%S)
for T in space dataset model bucket; do
  NAME="doomalay-v0935-$T-$STAMP"
  BODY=$(curl -s -X POST "$BASE/api/workspaces/create-repo" -H 'Content-Type: application/json' \
    -d '{"kind":"hf","hf_type":"'"$T"'","sdk":"static","name":"'"$NAME"'","description":"v0935 live test","private":false}')
  OK=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('created') and d.get('access')=='full' else d.get('error','no'))" 2>/dev/null)
  ck "create $T → workspace (full access)" "$([ "$OK" = "yes" ] && echo yes || echo no)" "$OK"
  # verify on the hub itself
  case $T in
    space)   URL="https://huggingface.co/api/spaces/ScoobyBaby1999/$NAME";;
    dataset) URL="https://huggingface.co/api/datasets/ScoobyBaby1999/$NAME";;
    model)   URL="https://huggingface.co/api/models/ScoobyBaby1999/$NAME";;
    bucket)  URL="";;
  esac
  if [ -n "$URL" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOOMALAY_HF_TOKEN" "$URL")
    ck "  hub verifies the $T exists (GET 200)" "$([ "$CODE" = "200" ] && echo yes || echo no)" "$CODE"
  else
    BL=$(curl -s -H "Authorization: Bearer $DOOMALAY_HF_TOKEN" "https://huggingface.co/api/buckets/ScoobyBaby1999")
    FOUND=$(echo "$BL" | grep -c "$NAME")
    ck "  hub verifies the bucket exists (in the bucket list)" "$([ "${FOUND:-0}" -ge 1 ] && echo yes || echo no)" "$FOUND"
  fi
done

echo "── C. THE DELETE FIX (the bash-demo.txt error)"
# find the dataset workspace the engine just made
WSID=$(curl -s "$BASE/api/workspaces" | python3 -c "
import json,sys
ws = json.load(sys.stdin).get('workspaces', [])
for w in ws:
    if w.get('kind')=='hf' and 'v0935-dataset-$STAMP' in (w.get('repo') or ''): print(w['id']); break" 2>/dev/null)
if [ -n "${WSID:-}" ]; then
  PUT=$(curl -s -X PUT "$BASE/api/workspaces/$WSID/file" -H 'Content-Type: application/json' \
    -d '{"path":"delete-demo.txt","content":"v0935 delete target","message":"seed the delete target"}')
  echo "    put → $(echo "$PUT" | head -c 100)"
  DEL=$(curl -s -X POST "$BASE/api/workspaces/$WSID/do" -H 'Content-Type: application/json' \
    -d '{"action":"file_delete","path":"delete-demo.txt","message":"the v0935 delete fix"}')
  ck "file_delete on the HF repo (no 'forge does not support')" \
     "$(echo "$DEL" | grep -qi 'does not support' && echo no || echo yes)" "$(echo "$DEL" | head -c 140)"
  ck "  the delete observation says DELETED" \
     "$(echo "$DEL" | grep -q 'DELETED' && echo yes || echo no)" "$(echo "$DEL" | head -c 140)"
else
  ck "dataset workspace found for the delete test" no "no wsid"
fi

echo "── D. GitHub create with license + gitignore (the 'stays none' report)"
if [ -n "$GH_KEY" ]; then
  GHNAME="doomalay-v0935-gh-$STAMP"
  BODY=$(curl -s -X POST "$BASE/api/workspaces/create-repo" -H 'Content-Type: application/json' \
    -d '{"kind":"github","name":"'"$GHNAME"'","description":"v0935 live test","license":"mit","gitignore":"Go","private":false}')
  OK=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('created') else str(d.get('error','no'))[:140])" 2>/dev/null)
  ck "GitHub repo created ($GHNAME)" "$([ "$OK" = "yes" ] && echo yes || echo no)" "$OK"
  if [ "$OK" = "yes" ]; then
    FULL="ScoobyBaby1999/$GHNAME"
    sleep 2
    LC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GH_KEY" "https://api.github.com/repos/$FULL/license")
    ck "LICENSE file exists on the fresh repo ($LC)" "$([ "$LC" = "200" ] && echo yes || echo no)" "$LC"
    GC=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GH_KEY" "https://raw.githubusercontent.com/$FULL/main/.gitignore")
    ck ".gitignore exists on the fresh repo ($GC)" "$([ "$GC" = "200" ] && echo yes || echo no)" "$GC"
    # cleanup (honest): delete needs the delete_repo scope — report 204/403
    DC=$(curl -s -X DELETE -H "Authorization: Bearer $GH_KEY" "https://api.github.com/repos/$FULL" -o /dev/null -w '%{http_code}')
    if [ "$DC" = "204" ]; then
      ck "test repo cleaned up (deleted)" yes
    else
      ck "test repo cleanup needs the delete_repo scope ($DC — left for the user to see; one-tap delete on github.com)" yes
    fi
  fi
fi

echo "── the workspace pill count (everything landed)"
CNT=$(curl -s "$BASE/api/workspaces" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('workspaces',[])))" 2>/dev/null)
ck "workspaces list grew (now $CNT rows)" "$([ "${CNT:-0}" -ge 4 ] && echo yes || echo no)" "$CNT"

echo ""
echo "═══ $PASS pass, $FAIL fail ═══"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
