#!/bin/bash
# v055-gh-deviceflow-test.sh — RED-TEAM the v0.55 GitHub device flow UI.
#
# Boots the freshly built engine, then:
#   API:   /api/gh/account exposes device_flow; /oauth/github/start (no
#          secret) names the device flow in its 400.
#   LIVE:  the sign-in button POSTs device/start against REAL github.com
#          with the built-in (old) app id → GitHub answers
#          device_flow_disabled (the old app never enabled it) → the panel
#          must surface the friendly "check Device Flow in the app
#          settings" error. That exercises the whole live chain: route →
#          netx egress → JSON parse → error copy. (The happy path is
#          covered by TestGHDeviceFlowRoundTrip against a mock GitHub.)
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

# click → live device/start against REAL github.com (old app id → expect the
# helpful device_flow_disabled copy)
ev "document.getElementById('ghc-oauth').click()" >/dev/null
sleep 5
ERR=$(ev "(document.getElementById('ghc-err')||{}).textContent || ''")
has "$ERR" "Device Flow" "live device/start surfaces GitHub's device_flow_disabled"
has "$ERR" "Iv23liDzVTw7zphxo5Hv" "error names the built-in client id"
BTN2=$(ev "document.getElementById('ghc-oauth') ? (document.getElementById('ghc-oauth').disabled ? 'disabled' : document.getElementById('ghc-oauth').textContent.trim()) : 'gone'")
check "$BTN2" "Sign in with GitHub" "button re-enabled after the error"

agent-browser screenshot /home/z/my-project/download/gh-deviceflow-v055.png >/dev/null 2>&1
echo "screenshot: download/gh-deviceflow-v055.png"

echo "────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN"
