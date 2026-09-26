#!/bin/bash
# v0612-gh-armed-test.sh — RED-TEAM the v0.61.2 ARMED one-press.
#
# v0.61.1 shipped the mechanism with the secret EMPTY (the off switch);
# v0.61.2 arms it for real: the owner generated a FRESH secret on the
# RECOVERED first app (Iv23liDzVTw7zphxo5Hv) and it ships as the
# ghOAuthDefaultClientSecret constant. The engine boots here with NO env
# and NO vault config — the shipped constant IS the production path.
#
# New in v0.61.2 (this script pins the split):
#   - status client_id must be the ONE-PRESS app (Iv23liDzVTw7zphxo5Hv),
#     armed + one_tap with zero configuration;
#   - the device fallback must ride the DEVICE app
#     (Iv23li3qm665pDrDO1Nh — the one-press app has Device Flow
#     disabled, probed live) and still mint a REAL user_code from
#     github.com/login/device/code;
#   - everything v0.61.1 proved stays green: PKCE S256 authorize shape,
#     the LIVE github.com answer, the one-tap panel paint, the popup
#     (app tab never navigates), wait/un-stick, the ?user_code= prefill.
set -u
DATA=/tmp/doomalay-v0612
PORT=8179
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0612
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0612-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (shipped constant = production path, no env)" || bad "engine boot"

# ── API: the armed one-press on the RECOVERED app ────────────────────────
ST=$(curl -s $BASE/api/workspaces/oauth/github/status)
has "$ST" '"has_secret":true' "status has_secret=true (the shipped pair, zero config)"
has "$ST" '"one_tap":true' "status one_tap=true"
has "$ST" '"device_flow":true' "status device_flow=true (the fallback rides the device app)"
has "$ST" "\"client_id\":\"Iv23liDzVTw7zphxo5Hv\"" "status client_id = the ONE-PRESS app (recovered)"
case "$ST" in *Iv23li3qm665pDrDO1Nh*) bad "status must not leak the device app as the web app";; *) ok "web flow is not riding the device app";; esac

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
check "$CID" "Iv23liDzVTw7zphxo5Hv" "authorize client_id = the one-press app"
case "$RU" in "http://127.0.0.1:8179/api/github/oauth/callback") ok "redirect_uri is the engine loopback callback";; *) bad "redirect_uri = $RU";; esac

# LIVE: the real GitHub answers this authorize URL (the login/authorize
# page — or the redirect_uri notice until the callbacks are registered;
# either way the request shape reached GitHub's validation).
LIVE=$(curl -sL --max-time 20 -H "User-Agent: Mozilla/5.0" "$LOC" -o /tmp/v0612-live.html -w "%{http_code}")
case "$LIVE" in
  200) if grep -qi "redirect_uri" /tmp/v0612-live.html && grep -qi "must match\|not associated" /tmp/v0612-live.html; then
         ok "live authorize reached GitHub (redirect_uri notice = callbacks not yet registered on the one-press app)"
       elif grep -qi "sign in to github\|authorize" /tmp/v0612-live.html; then
         ok "live authorize reached GitHub (login/authorize page served)"
       else
         bad "live authorize answered 200 but the page is unrecognized"
       fi ;;
  *) bad "live authorize HTTP $LIVE" ;;
esac

# ── API: the device fallback rides the DEVICE app (LIVE github.com) ──────
DEV=$(curl -s -X POST "$BASE/api/workspaces/oauth/github/device/start")
case "$DEV" in
  *user_code*) ok "device fallback started LIVE (a real github.com user_code)";;
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

# ── UI: one-tap paint + popup + wait/un-stick + fallbacks ────────────────
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "window.GHConnect ? 'yes' : 'no'" >/tmp/v0612-a; check "$(cat /tmp/v0612-a)" "yes" "ghconnect.js loaded"

ev "window.GHConnect.openConnectPanel({}); 'opened'" >/dev/null
sleep 1.2
BTN=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
has "$BTN" "one click" "panel paints the one-click button (one-tap mode, armed)"
COPY=$(ev "(document.getElementById('ghc-copy')||{}).innerHTML || ''")
has "$COPY" "straight to GitHub" "one-tap copy: the popup goes straight to GitHub"
has "$COPY" "Only select" "copy explains the repo-scoped selection"
case "$COPY" in *broker*|*space*) bad "one-tap copy must not mention the broker/space";; *) ok "one-tap copy has no broker/space wording";; esac
FALL=$(ev "(document.getElementById('ghc-code-fallback')||{}).style.display || ''")
check "$FALL" "block" "the one-time-code fallback link is visible"

# capture window.open; click → the POPUP (never a same-tab navigation)
ev "window.__pops=[]; window.__fakep={closed:false}; window.open=function(u,n,f){window.__pops.push(String(u)); return window.__fakep;};" >/dev/null
URL0=$(ev "window.location.href")
ev "(document.getElementById('ghc-oauth')||{}).click()" >/dev/null
sleep 0.6
POP=$(ev "window.__pops[0] || ''")
case "$POP" in "/api/workspaces/oauth/github/start?redirect=/") ok "click opens the POPUP to the engine start URL";; *) bad "popup url = '$POP'";; esac
URL1=$(ev "window.location.href")
check "$URL1" "$URL0" "the app tab NEVER navigated (SPA state + back gesture safe)"
STUCK=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
has "$STUCK" "Waiting for GitHub" "button waits while the popup lives"
ev "window.__fakep.closed = true" >/dev/null
sleep 1.4
UNSTUCK=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
has "$UNSTUCK" "one click" "button un-sticks after the popup closes without finishing"

# the device fallback (from the UI): live user_code + the prefill URL
ev "var l=document.getElementById('ghc-code-fallback'); if(l){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); l.dispatchEvent(e);} 'clicked'" >/dev/null
sleep 4
DEVC=$(ev "(document.getElementById('ghc-devcode')||{}).textContent || ''")
if [ -n "$DEVC" ] && [ "$DEVC" != "…" ]; then ok "device fallback started (live user_code $DEVC on the device app)"; else bad "device fallback did not paint a code"; fi
ev "window.__pops=[]; var b=document.getElementById('ghc-open'); if(b){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); b.dispatchEvent(e);} 'ok'" >/dev/null
sleep 0.5
OPENURI=$(ev "window.__pops[0] || ''")
case "$OPENURI" in "https://github.com/login/device?user_code="*|"github.com/login/device?user_code="*) ok "device open button uses the ?user_code= prefill URL";; *) bad "device open url = '$OPENURI'";; esac

echo "────────────────────────────────"
echo "v0.61.2 GH-ARMED RED TEAM: $PASS pass, $FAIL fail"
[ $FAIL -eq 0 ]
