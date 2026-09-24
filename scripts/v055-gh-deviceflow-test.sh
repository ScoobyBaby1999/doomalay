#!/bin/bash
# v055-gh-deviceflow-test.sh — RED-TEAM the GitHub device flow UI
#          (updated for v0.58: the NEW app Iv23li3qm665pDrDO1Nh).
#
# Boots the freshly built engine, then:
#   API:   /api/gh/account exposes device_flow; /oauth/github/start (no
#          secret) names the device flow in its 400.
#   LIVE:  the sign-in button POSTs device/start against REAL github.com
#          with the built-in NEW app id (Device Flow verified enabled) →
#          GitHub returns a REAL user_code → the panel must show the big
#          code (XXXX-XXXX), the copy button, the open-github link and
#          the waiting line. That exercises the whole live chain: route →
#          netx egress → JSON parse → device UI render. (The full
#          authorize→token round-trip is covered by
#          TestGHDeviceFlowRoundTrip against a mock GitHub.)
#   UI:    the v0.52 yellow "one-time OAuth setup" box is GONE.
set -u
DATA=/tmp/doomalay-v055gh
PORT=8172
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v055gh
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v055gh-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# ── API contract ──────────────────────────────────────────────────────────
ACCT=$(curl -s $BASE/api/gh/account)
has "$ACCT" '"device_flow":true' "account exposes device_flow:true"
has "$ACCT" '"has_secret":false' "fresh install: has_secret:false"
START=$(curl -s "$BASE/api/workspaces/oauth/github/start?redirect=/")
has "$START" 'device-code flow' "start (no secret) names the device flow"
has "$START" 'github.com/login/device' "start error mentions github.com/login/device"

# ── UI: the panel + the device flow, live against github.com ──────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 2
GH=$(ev "typeof window.GHConnect")
check "$GH" "object" "GHConnect panel module loaded"
ev "window.GHConnect.openConnectPanel()" >/dev/null
sleep 1.2

BOX=$(ev "(document.body.innerText.match(/one-time OAuth setup/i)||[''])[0]")
check "$BOX" "" "the yellow one-time setup box is GONE"
SECRET_INPUT=$(ev "document.getElementById('ghc-secret') ? 'present' : 'absent'")
check "$SECRET_INPUT" "absent" "no secret input rendered"
BTN=$(ev "document.getElementById('ghc-oauth') ? document.getElementById('ghc-oauth').textContent.trim() : ''")
check "$BTN" "Sign in with GitHub" "sign-in button present"

# click → live device/start against REAL github.com (NEW app id, Device
# Flow ON → expect the REAL device-code UI)
ev "document.getElementById('ghc-oauth').click()" >/dev/null
sleep 6
ERR=$(ev "(document.getElementById('ghc-err')||{}).textContent || ''")
check "$ERR" "" "no error on live device/start (new app)"
CODE=$(ev "(document.getElementById('ghc-devcode')||{}).textContent || ''")
check "$(ev "/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test('$CODE') ? 'ok' : 'bad'")" "ok" "live device code shown (got '$CODE')"
OPEN=$(ev "var captured=''; window.open=function(u){captured=u;return null}; (document.getElementById('ghc-open')||{click:function(){}}).click(); captured")
has "$OPEN" "github.com/login/device" "open-github button opens github.com/login/device (got '$OPEN')"
STEP1=$(ev "document.body.innerText.match(/enter this code at[^\\n]*/)||['']")
has "$STEP1" "github.com/login/device" "step-1 line names the entry URL"
COPY=$(ev "document.getElementById('ghc-copy') ? 'present' : 'absent'")
check "$COPY" "present" "copy-code button present"
WAIT=$(ev "(document.getElementById('ghc-wait')||{}).textContent || ''")
has "$WAIT" "waiting" "waiting line shown while the poller runs"

agent-browser screenshot /home/z/my-project/download/gh-deviceflow-v058.png >/dev/null 2>&1
echo "screenshot: download/gh-deviceflow-v058.png"

echo "────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN"
