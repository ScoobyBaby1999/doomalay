#!/bin/bash
# v060-gh-broker-test.sh — RED-TEAM the v0.60.2 GitHub space broker (the
# one-click, repo-scoped sign-in ported from the legacy space).
#
# A LOCAL mock of the Space's /gh/oauth/* surface runs on :8188; the engine
# boots with DOOMALAY_GH_BROKER pointing at it. Then:
#   API:  /api/gh/account advertises broker_url; broker/start 302s to the
#         space with the browser origin (javascript: origins refused);
#         the FULL relay chain lands the token in the vault + the DONE PAGE
#         (login shown, deep link, postMessage); a claimed grant and a
#         space-side ?error= both render the error done page.
#   UI:   the GH panel probes the (mock) broker → the button upgrades to
#         "one click", the copy explains "Only select repositories", the
#         one-time-code fallback link appears; the click opens the BROKER
#         popup (window.open captured — app tab never navigates); the
#         fallback link still starts the real device flow.
set -u
DATA=/tmp/doomalay-v060b
PORT=8175
BASE=http://127.0.0.1:$PORT
MOCK=http://127.0.0.1:8188
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v060b
PASS=0; FAIL=0
ev()  { agent-browser eval "$1" 2>/dev/null | python3 -c "
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
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1' want '$2')"; fi; }
has()  { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2' in: ${1:0:160})";; esac; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
python3 /home/z/my-project/doomalay/scripts/v060-mock-broker-space.py 127.0.0.1 $BASE >/tmp/v060b-mock.log 2>&1 &
MOCKPID=$!
DOOMALAY_GH_BROKER=$MOCK $ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v060b-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
sleep 0.5
curl -s $MOCK/gh/oauth/config >/dev/null 2>&1 && ok "mock broker space up" || bad "mock broker space up"

# ── API: the broker chain ─────────────────────────────────────────────────
ACCT=$(curl -s $BASE/api/gh/account)
has "$ACCT" "\"broker_url\":\"$MOCK\"" "account advertises the broker_url"
CFG=$(curl -s $MOCK/gh/oauth/config)
has "$CFG" '"configured":true' "space config probe says configured (CORS-open)"

LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/gh/oauth/broker/start?origin=$BASE")
has "$LOC" "$MOCK/gh/oauth/start" "broker/start 302s to the space"
has "$LOC" "redirect=http%3A%2F%2F127.0.0.1%3A$PORT" "…carrying the browser-facing origin"
GHLINK=$(curl -s -o /dev/null -w "%{redirect_url}" "$MOCK/gh/oauth/start?redirect=$BASE")
has "$GHLINK" "github.com/login/oauth/authorize" "space start 302s to GitHub authorize (the one click)"
BADORIGIN=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/gh/oauth/broker/start?origin=javascript:alert(1)")
check "$BADORIGIN" "400" "javascript: origin refused before leaving the engine"
EVIL=$(curl -s -o /dev/null -w "%{http_code}" "$MOCK/gh/oauth/start?redirect=https://evil.example")
check "$EVIL" "400" "space refuses a public redirect origin (policy mirror)"

# the relay: one-time claim → vault → DONE PAGE (runs AFTER the UI
# checks — claiming connects the account, and the panel only probes the
# broker while signed out)
UI_DONE_MARKER=1

# ── UI: the panel upgrade + the popup ─────────────────────────────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 2
ev "window.GHConnect.openConnectPanel()" >/dev/null
sleep 1.6   # the probe needs a beat
BTN=$(ev "document.getElementById('ghc-oauth') ? document.getElementById('ghc-oauth').textContent.trim() : ''")
check "$BTN" "Sign in with GitHub — one click" "button upgraded to the one-click broker mode"
COPY=$(ev "document.body.innerText.match(/One click, no codes[^]*/)
  ? document.getElementById('ghc-copy').innerText : ''")
has "$COPY" "Only select repositories" "copy explains the repo-only selection screen"
has "$COPY" "never your whole account" "copy promises account-wide is never granted"
ALT=$(ev "var a=document.getElementById('ghc-code-fallback'); a && a.style.display !== 'none' ? 'shown' : 'hidden'")
check "$ALT" "shown" "one-time-code fallback link shown"

# the click opens the BROKER popup (captured) — app tab never navigates
POPURL=$(ev "var c=''; window.open=function(u,n,f){c=u; return {closed:false,close:function(){},focus:function(){}}}; document.getElementById('ghc-oauth').click(); c")
has "$POPURL" "/api/gh/oauth/broker/start" "click opens the broker start URL"
has "$POPURL" "origin=http%3A%2F%2F127.0.0.1%3A$PORT" "popup carries the app origin (frontend-known)"
sleep 0.8
APPURL=$(ev "window.location.href")
case "$APPURL" in
  *"$BASE"*|*"127.0.0.1:$PORT/#/"*) ok "app tab never navigated (broker popup)";;
  *) bad "app tab navigated away: $APPURL";;
esac
agent-browser screenshot /home/z/my-project/download/gh-broker-v060.png >/dev/null 2>&1
echo "screenshot: download/gh-broker-v060.png"

# the fallback link still starts the real device flow (live GitHub)
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 1.5
ev "window.GHConnect.openConnectPanel()" >/dev/null
sleep 1.6
ev "document.getElementById('ghc-code-fallback').click()" >/dev/null
sleep 6
DCODE=$(ev "(document.getElementById('ghc-devcode')||{}).textContent || ''")
check "$(ev "/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test('$DCODE') ? 'ok' : 'bad'")" "ok" "fallback link starts the REAL device flow (live code shown)"

# the done-page message repaints the panel (phase-1 machinery, provider github)
ev "window.GHConnect._applyAuthResult({user:'broker_probe'})" >/dev/null
sleep 0.4
GHS=$(ev "(document.getElementById('ghc-state')||{}).innerText || ''")
has "$GHS" "connected as broker_probe" "done-page message repaints the GH panel"

# ── NOW the relay chain (connects the account — after the UI probe) ──────
RELAY=$(curl -s "$BASE/api/gh/oauth/relay?grant=redteam-grant")
has "$RELAY" "connected" "relay serves the done page (connected)"
has "$RELAY" "redteam_cat" "done page names the brokered login"
has "$RELAY" "doomalay://return" "done page carries the deep link"
has "$RELAY" "doomalay-auth" "done page carries the postMessage payload"
has "$RELAY" "gh_connected=1" "done page keeps the landing query"
ACCT2=$(curl -s $BASE/api/gh/account)
has "$ACCT2" '"connected":true' "account flips to connected after the relay"
has "$ACCT2" 'redteam_cat' "account names the brokered login"

# one-time semantics + error paths
CLAIMED=$(curl -s "$BASE/api/gh/oauth/relay?grant=redteam-grant")
has "$CLAIMED" "sign-in failed" "already-claimed grant → the error done page"
ERRRELAY=$(curl -s "$BASE/api/gh/oauth/relay?error=access+denied")
has "$ERRRELAY" "access denied" "space-side ?error= renders the error done page"

# ── LIVE space state (informational — not gated) ──────────────────────────
LIVE=$(curl -s -m 8 https://scoobybaby1999-doomalaysocreate.hf.space/gh/oauth/config 2>/dev/null || echo '{"note":"unreachable from this sandbox"}')
echo "LIVE space /gh/oauth/config → $LIVE (add GITHUB_CLIENT_SECRET to the Space secrets to arm the real one-click)"

echo "────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN"
