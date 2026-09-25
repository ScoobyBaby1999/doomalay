#!/bin/bash
# v061-gh-direct-test.sh — RED-TEAM the v0.61 DIRECT GitHub one-press
# (PLAN-AUTH-V061: GitHub stands alone — no HF, no space, no broker on
# loopback).
#
# The engine boots on :8176 with DOOMALAY_GH_CLIENT_SECRET set (the env
# override rides the IDENTICAL code path as the shipped gh-CLI-style
# constant). Then:
#   API:  status reports has_secret + one_tap; start 302s to the REAL
#         github.com/login/oauth/authorize with client_id, the loopback
#         redirect_uri, a 32-hex state, a 43-char code_challenge and
#         method=S256 (PKCE per the docs); the LIVE authorize URL is
#         fetched — GitHub answers (login/authorize page or the
#         not-yet-armed redirect_uri notice — both prove the request
#         shape reached validation).
#   UI:   the GH panel paints ONE-TAP mode on loopback (button "one
#         click", copy "straight to GitHub" — NOT the broker copy); the
#         click opens the POPUP to the engine start URL (window.open
#         captured — the app tab NEVER navigates); the wait state sticks
#         while the popup lives and un-sticks when it closes; the device
#         fallback link still works and its open button carries the
#         ?user_code= prefill; the workspace picker's GitHub row opens
#         the PANEL instead of navigating.
set -u
DATA=/tmp/doomalay-v061
PORT=8176
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v061
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
DOOMALAY_GH_CLIENT_SECRET=redteam-shipped-secret $ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v061-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (secret via env = the shipped-constant path)" || bad "engine boot"

# ── API: the one-tap arming + the authorize redirect shape ───────────────
ST=$(curl -s $BASE/api/workspaces/oauth/github/status)
has "$ST" '"has_secret":true' "status has_secret=true (no vault config — the shipped/env pair armed it)"
has "$ST" '"one_tap":true' "status one_tap=true"
has "$ST" "\"client_id\":\"Iv23li3qm665pDrDO1Nh\"" "status carries the built-in GitHub App client id"

LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/workspaces/oauth/github/start?redirect=/")
case "$LOC" in https://github.com/login/oauth/authorize*) ok "start 302s to github.com/login/oauth/authorize";; *) bad "start redirect = $LOC";; esac
CHAL=$(python3 -c "
import sys, urllib.parse as u
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
check "$METH" "S256" "authorize carries code_challenge_method=S256"
check "${#CHAL}" "43" "code_challenge is 43 chars (base64url SHA-256, no padding)"
check "${#STATE}" "32" "state is a 32-hex nonce"
case "$RU" in "http://127.0.0.1:8176/api/github/oauth/callback") ok "redirect_uri is the engine loopback callback";; *) bad "redirect_uri = $RU";; esac

# LIVE: the real GitHub answers this authorize URL (the login/authorize
# page — or the redirect_uri notice until the callbacks are registered;
# either way the request shape reached GitHub's validation).
LIVE=$(curl -sL --max-time 20 -H "User-Agent: Mozilla/5.0" "$LOC" -o /tmp/v061-live.html -w "%{http_code}")
case "$LIVE" in
  200) if grep -qi "redirect_uri" /tmp/v061-live.html && grep -qi "must match\|not associated" /tmp/v061-live.html; then
         ok "live authorize reached GitHub (redirect_uri notice = expected until the callbacks are registered)"
       elif grep -qi "sign in to github\|authorize" /tmp/v061-live.html; then
         ok "live authorize reached GitHub (login/authorize page served)"
       else
         bad "live authorize answered 200 but the page is unrecognized"
       fi ;;
  *) bad "live authorize HTTP $LIVE" ;;
esac

# ── UI: one-tap paint + popup + wait/un-stick + fallbacks ────────────────
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "window.GHConnect ? 'yes' : 'no'" >/tmp/v061-a; check "$(cat /tmp/v061-a)" "yes" "ghconnect.js loaded"

ev "window.GHConnect.openConnectPanel({}); 'opened'" >/dev/null
sleep 1.2
BTN=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
has "$BTN" "one click" "panel paints the one-click button (one-tap mode)"
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

# the device fallback: open button carries the ?user_code= prefill URL
ev "var l=document.getElementById('ghc-code-fallback'); if(l){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); l.dispatchEvent(e);} 'clicked'" >/dev/null
sleep 4
DEV=$(ev "(document.getElementById('ghc-devcode')||{}).textContent || ''")
if [ -n "$DEV" ] && [ "$DEV" != "…" ]; then ok "device fallback started (live user_code $DEV)"; else bad "device fallback did not paint a code"; fi
ev "window.__pops=[]; var b=document.getElementById('ghc-open'); if(b){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); b.dispatchEvent(e);} 'ok'" >/dev/null
sleep 0.5
OPENURI=$(ev "window.__pops[0] || ''")
case "$OPENURI" in "https://github.com/login/device?user_code="*|"github.com/login/device?user_code="*) ok "device open button uses the ?user_code= prefill URL";; *) bad "device open url = '$OPENURI'";; esac

# the workspace picker's GitHub row opens the PANEL (never navigates)
ev "window.__pops=[]; window.__fakep={closed:true}; window.open=function(u,n,f){window.__pops.push(String(u)); return window.__fakep;};" >/dev/null
PICK=$(ev "window.Workspace && window.Workspace.openPicker ? 'yes' : 'no'")
check "$PICK" "yes" "workspace picker API present"
if [ "$PICK" = "yes" ]; then
  ev "window.Workspace.openPicker('test-sid'); 'ok'" >/dev/null
  sleep 1.5
  # picker list → the pinned connect row → the Cloud Workspace step → the GitHub sign-in row
  ev "var c=document.getElementById('wsx-connect'); if(c){c.click();} 'ok'" >/dev/null
  sleep 1
  ev "var c=document.getElementById('wso-cloud'); if(c){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); c.dispatchEvent(e);} 'ok'" >/dev/null
  sleep 1.2
  ROW=$(ev "(document.getElementById('wsf-signin')||{}).textContent || ''")
  has "$ROW" "Sign in with GitHub" "cloud form shows the GitHub sign-in row"
  ev "var el=document.getElementById('wsf-signin'); if(el){var e=document.createEvent('HTMLEvents'); e.initEvent('click',true,true); el.dispatchEvent(e);} 'ok'" >/dev/null
  sleep 1.2
  PANEL=$(ev "(document.getElementById('ghc-oauth')||{}).textContent || ''")
  has "$PANEL" "one click" "picker GitHub row opened the GH panel (one-click mode)"
  URL2=$(ev "window.location.href")
  check "$URL2" "$URL0" "picker row did NOT navigate the app tab"
fi

echo "────────────────────────────────"
echo "v0.61 GH-DIRECT RED TEAM: $PASS pass, $FAIL fail"
[ $FAIL -eq 0 ]
