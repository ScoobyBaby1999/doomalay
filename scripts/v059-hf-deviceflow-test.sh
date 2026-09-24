#!/bin/bash
# v059-hf-deviceflow-test.sh — RED-TEAM the v0.59 HF device flow + the
# GitHub repo-only copy wave.
#
# Boots the freshly built engine, then:
#   API:  /api/hf/account exposes oauth:true; POST /api/hf/oauth/device/
#         start hits REAL huggingface.co → a live user_code + hf.co
#         verification_uri; the status endpoint reports pending.
#   UI:   the HF panel's copy names both paths; the device UI (via the
#         _runDeviceFlow hook — the browser here IS loopback, so the
#         button itself would take the redirect path) renders the REAL
#         code, copy + open buttons (window.open stubbed), the waiting
#         line; the loopback button click navigates the live app to
#         huggingface.co (the redirect path preserved for on-device
#         installs). The GH panel copy says "not a password" +
#         "repository access only".
set -u
DATA=/tmp/doomalay-v059hf
PORT=8173
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v059hf
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v059hf-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# ── API contract ──────────────────────────────────────────────────────────
ACCT=$(curl -s $BASE/api/hf/account)
has "$ACCT" '"oauth":true' "account exposes oauth:true"
START=$(curl -s -X POST $BASE/api/hf/oauth/device/start)
has "$START" '"user_code"' "live device/start returns a user_code"
URI=$(echo "$START" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verification_uri',''))" 2>/dev/null)
check "$URI" "https://hf.co/oauth/device" "verification_uri is hf.co/oauth/device"
sleep 1
STAT=$(curl -s $BASE/api/hf/oauth/device/status)
has "$STAT" '"status":"pending"' "status endpoint reports pending (real HF poll)"

# ── UI: the HF panel + the LIVE device code ───────────────────────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 2
HF=$(ev "typeof window.HFConnect")
check "$HF" "object" "HFConnect panel module loaded"
ev "window.HFConnect.openConnectPanel()" >/dev/null
sleep 1.2
COPY=$(ev "document.body.innerText.match(/gateway or preview URL[^\\n]*/)||['']")
has "$COPY" "hf.co/oauth/device" "panel copy names the device-flow path"
BTNCOPY=$(ev "document.getElementById('hfc-oauth') ? document.getElementById('hfc-oauth').textContent.trim() : ''")
check "$BTNCOPY" "Connect Hugging Face" "connect button present"

# the browser here IS loopback → drive the device flow through the test
# hook (the button itself would take the redirect path — asserted last)
ev "window.HFConnect._runDeviceFlow(document.getElementById('hfc-err'), document.getElementById('hfc-state'), document.getElementById('hfc-oauth'), null)" >/dev/null
sleep 6
HERR=$(ev "(document.getElementById('hfc-err')||{}).textContent || ''")
check "$HERR" "" "no error on live device/start"
HCODE=$(ev "(document.getElementById('hfc-devcode')||{}).textContent || ''")
check "$(ev "/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test('$HCODE') ? 'ok' : 'bad'")" "ok" "live HF device code shown (got '$HCODE')"
HSTEP=$(ev "document.body.innerText.match(/enter this one-time code[^\\n]*/)||['']")
has "$HSTEP" "not a password" "device UI says one-time code (not a password)"
HOPEN=$(ev "var c=''; window.open=function(u){c=u;return null}; (document.getElementById('hfc-open')||{click:function(){}}).click(); c")
check "$HOPEN" "https://hf.co/oauth/device" "open button opens hf.co/oauth/device"
HWAIT=$(ev "(document.getElementById('hfc-wait')||{}).textContent || ''")
has "$HWAIT" "waiting" "waiting line shown while the poller runs"
agent-browser screenshot /home/z/my-project/download/hf-deviceflow-v059.png >/dev/null 2>&1
echo "screenshot: download/hf-deviceflow-v059.png"
ev "window.ConnectOverlay ? (window.ConnectOverlay.close ? 'has-close' : 'no-close') : 'no-overlay'" >/dev/null
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 1.5

# ── UI: the GitHub panel's repo-only copy ─────────────────────────────────
ev "window.GHConnect.openConnectPanel()" >/dev/null
sleep 1.2
GHP=$(ev "document.body.innerText.match(/One login:[^]*?password\\./)||['']")
has "$GHP" "not a password" "GH copy: one-time code, not a password"
has "$GHP" "phishing guard" "GH copy: explains GitHub's anti-phishing note"
has "$GHP" "repository access" "GH copy: repository access only"
has "$GHP" "No account settings" "GH copy: no account settings/profile/emails"

# ── UI: loopback click → the one-tap redirect path (live) ─────────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 1.5
ev "window.HFConnect.openConnectPanel()" >/dev/null
sleep 1.2
ev "document.getElementById('hfc-oauth').click()" >/dev/null
sleep 6
URL=$(ev "window.location.href")
has "$URL" "huggingface.co" "loopback click still takes the one-tap redirect (live HF login page)"

echo "────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN"
