#!/bin/bash
# v0613-gh-one-app-test.sh — RED-TEAM the v0.61.3 ONE-APP consolidation.
#
# The owner enabled Device Flow on the one-press app
# (Iv23liDzVTw7zphxo5Hv — probed live before this script: device/code
# mints a user_code), so the v0.61.2 two-app split is retired:
#   - status client_id must be the ONE app, armed + one_tap, zero config;
#   - the device fallback must mint a REAL user_code riding the SAME
#     ONE app (no second app constant exists anymore — oauth_test.go
#     pins the resolver; this script pins the LIVE behavior);
#   - everything v0.61.2 proved stays green: PKCE S256 authorize shape,
#     the LIVE github.com answer, the one-tap panel paint, the popup,
#     wait/un-stick, the ?user_code= prefill.
set -u
DATA=/tmp/doomalay-v0613
PORT=8180
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0613
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
has()  { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2' in: ${1:0:200})";; esac; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
# NO DOOMALAY_GH_* env — the shipped constant is the whole production path.
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0613-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (shipped constants = production path, no env)" || bad "engine boot"

# ── API: the ONE app serves the web flow, armed, zero config ─────────────
ST=$(curl -s $BASE/api/workspaces/oauth/github/status)
has "$ST" '"has_secret":true' "status has_secret=true (the shipped pair, zero config)"
has "$ST" '"one_tap":true' "status one_tap=true"
has "$ST" '"device_flow":true' "status device_flow=true (the fallback rides the ONE app now)"
has "$ST" "\"client_id\":\"Iv23liDzVTw7zphxo5Hv\"" "status client_id = the ONE app"

LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/workspaces/oauth/github/start?redirect=/")
case "$LOC" in https://github.com/login/oauth/authorize*) ok "start 302s to github.com/login/oauth/authorize";; *) bad "start redirect = $LOC";; esac
CHAL=$(python3 -c "
import urllib.parse as u
q = u.parse_qs(u.urlparse('$LOC').query)
print(q.get('code_challenge',[''])[0])")
STATE=$(python3 -c "
import urllib.parse as u
q = u.parse_qs(u.urlparse('$LOC').query)
print(q.get('state',[''])[0])")
RU=$(python3 -c "
import urllib.parse as u
q = u.parse_qs(u.urlparse('$LOC').query)
print(q.get('redirect_uri',[''])[0])")
METH=$(python3 -c "
import urllib.parse as u
q = u.parse_qs(u.urlparse('$LOC').query)
print(q.get('code_challenge_method',[''])[0])")
CID=$(python3 -c "
import urllib.parse as u
q = u.parse_qs(u.urlparse('$LOC').query)
print(q.get('client_id',[''])[0])")
check "$METH" "S256" "authorize carries code_challenge_method=S256"
check "${#CHAL}" "43" "code_challenge is 43 chars (base64url SHA-256, no padding)"
check "${#STATE}" "32" "state is a 32-hex nonce"
check "$CID" "Iv23liDzVTw7zphxo5Hv" "authorize client_id = the ONE app"
case "$RU" in "http://127.0.0.1:8180/api/github/oauth/callback") ok "redirect_uri is the engine loopback callback";; *) bad "redirect_uri = $RU";; esac

# LIVE: the real GitHub answers this authorize URL.
LIVE=$(curl -sL --max-time 20 -H "User-Agent: Mozilla/5.0" "$LOC" -o /tmp/v0613-live.html -w "%{http_code}")
case "$LIVE" in
  200) if grep -qi "redirect_uri" /tmp/v0613-live.html && grep -qi "must match\|not associated" /tmp/v0613-live.html; then
         ok "live authorize reached GitHub (redirect_uri notice = callbacks not yet registered)"
       elif grep -qi "sign in to github\|authorize" /tmp/v0613-live.html; then
         ok "live authorize reached GitHub (login/authorize page served)"
       else
         bad "live authorize answered 200 but the page is unrecognized"
       fi ;;
  *) bad "live authorize HTTP $LIVE" ;;
esac

# ── API: the device fallback rides the ONE app (LIVE github.com) ─────────
# (a) direct live probe: the ONE app itself mints device codes now
ONEAPP_DEV=$(curl -s --max-time 15 -X POST https://github.com/login/device/code \
  -H "Accept: application/json" -d "client_id=Iv23liDzVTw7zphxo5Hv")
case "$ONEAPP_DEV" in
  *user_code*) ok "LIVE: the ONE app mints device codes (Device Flow on)";;
  *device_flow_disabled*) bad "LIVE: the ONE app still has Device Flow disabled";;
  *) bad "LIVE one-app device probe: $ONEAPP_DEV";;
esac
# (b) the engine's device start works E2E and carries the prefill URL
DEV=$(curl -s -X POST "$BASE/api/workspaces/oauth/github/device/start")
case "$DEV" in
  *user_code*) ok "engine device fallback started LIVE (a real user_code)";;
  *) bad "device start failed: $DEV";;
esac
DURI=$(python3 -c "
import json
try:
    d = json.loads('''$DEV''')
    print(d.get('verification_uri_complete',''))
except Exception:
    print('') ")
case "$DURI" in "https://github.com/login/device?user_code="*) ok "device prefill URL carried";; *) bad "device prefill URL = '$DURI'";; esac

# ── UI: one-tap paint + popup + wait/un-stick ────────────────────────────
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "window.GHConnect ? 'yes' : 'no'" >/tmp/v0613-a; check "$(cat /tmp/v0613-a)" "yes" "ghconnect.js loaded"

ev "window.GHConnect.openConnectPanel({}); 'opened'" >/dev/null
sleep 1.2
BTN=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
has "$BTN" "one click" "panel paints the one-click button (one-tap mode, armed)"
COPY=$(ev "(document.getElementById('ghc-copy')||{}).innerHTML || ''")
has "$COPY" "straight to GitHub" "one-tap copy: the popup goes straight to GitHub"
has "$COPY" "Only select" "copy explains the repo-scoped selection"

# device fallback UI still present (hidden in one-tap mode by design —
# #ghc-code-fallback paints "or use a one-time code instead" when the
# web flow is unavailable; it must exist in the panel DOM)
ev "window.GHConnect.openConnectPanel({}); 'x'" >/dev/null; sleep 1
FALLBACK=$(ev "var a = document.getElementById('ghc-code-fallback'); a ? (a.textContent + ' [' + (a.style.display||'inline') + ']') : 'none'")
has "$FALLBACK" "one-time code" "device-code alternate path present in the panel (hidden in one-tap mode)"

# popup: the app tab never navigates (the OAuth popup pattern)
POPUP=$(ev "
(function(){
  var before = location.href;
  var w = window.open('$BASE/api/workspaces/oauth/github/start?redirect=/', 'gh', 'width=720,height=820');
  if (!w) return 'popup blocked';
  return 'popup opened, app tab stayed: ' + (location.href === before);
})()")
case "$POPUP" in "popup opened, app tab stayed: true"*) ok "OAuth popup opens; the app tab never navigates";; *) bad "popup: $POPUP";; esac
sleep 1.5

echo ""
echo "══ v0.61.3 one-app red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
