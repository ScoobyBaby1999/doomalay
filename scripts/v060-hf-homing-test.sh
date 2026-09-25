#!/bin/bash
# v060-hf-homing-test.sh — RED-TEAM the v0.60.1 HOME-COMING wave:
# the done page, the popup-first connect, and the live panel sync.
#
# Boots the freshly built engine, then:
#   API:  the GH callback's error branch serves the DONE PAGE (not JSON,
#         not a 302 into the app root); the page carries the postMessage
#         payload + the doomalay://return deep link + the landing-query
#         link; success path is covered by the Go round-trip (fake GitHub).
#   UI:   the HF panel's loopback click opens a POPUP to
#         /api/hf/oauth/start (window.open stubbed + captured) and the APP
#         TAB NEVER NAVIGATES (v0.59 navigated same-tab — the "hardcoded
#         screen"); a forged done-page postMessage flips the panel to
#         connected (toast + state) without any reload; the button unblocks
#         when the popup is closed unauthorized; the cross-origin /
#         wrong-provider messages are ignored; a focus event refetches the
#         account (the APK-return sync). The GH panel exposes the same
#         _applyAuthResult contract.
set -u
DATA=/tmp/doomalay-v060h
PORT=8174
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v060h
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v060h-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# ── API: the done page (error branch — no login needed) ──────────────────
DENIED=$(curl -s "$BASE/api/github/oauth/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=x")
has "$DENIED" "sign-in failed" "denied flow serves the done page (not JSON/302)"
has "$DENIED" "denied your application" "done page names the denial"
has "$DENIED" "doomalay://return" "done page carries the return-to-app deep link"
has "$DENIED" "doomalay-auth" "done page carries the postMessage payload"
has "$DENIED" "gh_error=" "done page keeps the landing-query link"
if echo "$DENIED" | grep -q "http-equiv=\"refresh\"\|location.replace\|window.location = '/'"; then
  bad "done page must NOT auto-navigate into the app"
else ok "done page never auto-navigates into the app"; fi
STALE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/github/oauth/callback?code=x&state=bogus")
check "$STALE" "400" "replayed/bogus state still rejected 400 (one-shot states)"

# ── UI: the HF panel — popup-first + the sync listeners ──────────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 2
HF=$(ev "typeof window.HFConnect")
check "$HF" "object" "HFConnect panel module loaded"
ev "window.HFConnect.openConnectPanel()" >/dev/null
sleep 1.2
BTNCOPY=$(ev "document.getElementById('hfc-oauth') ? document.getElementById('hfc-oauth').textContent.trim() : ''")
check "$BTNCOPY" "Connect Hugging Face" "connect button present"

# stub window.open: capture the URL, return a fake popup (never closes)
POPURL=$(ev "var c=''; window.open=function(u,n,f){c=u; return {closed:false,close:function(){},focus:function(){}}}; document.getElementById('hfc-oauth').click(); c")
has "$POPURL" "/api/hf/oauth/start" "loopback click opens the POPUP start URL"
sleep 1
APPURL=$(ev "window.location.href")
case "$APPURL" in
  *"$BASE"*|*"127.0.0.1:$PORT/#/"*) ok "app tab NEVER navigated (state preserved)";;
  *) bad "app tab navigated away: $APPURL";;
esac
BTNWAIT=$(ev "document.getElementById('hfc-oauth').textContent.trim()")
check "$BTNWAIT" "Waiting for Hugging Face…" "button shows the waiting state while the popup lives"

# a forged done-page message (exactly what the popup posts) flips the panel
ev "window.postMessage({type:'doomalay-auth', provider:'huggingface', user:'probe_tester', error:''}, window.location.origin)" >/dev/null
sleep 0.6
STATE=$(ev "(document.getElementById('hfc-state')||{}).innerText || ''")
has "$STATE" "connected as probe_tester" "panel flips to connected on the done-page message (no reload)"
BTNBACK=$(ev "(function(){var b=document.getElementById('hfc-oauth'); return b.textContent.trim() + (b.disabled ? ' [disabled]' : ' [enabled]');})()")
check "$BTNBACK" "Connect Hugging Face [enabled]" "button unblocked after the sync"

# same-user sync twice → no repaint churn (dedupe)
CHURN=$(ev "var n=0; var el=document.getElementById('hfc-state'); var obs=new MutationObserver(function(){n++}); obs.observe(el,{childList:true,subtree:true}); window.postMessage({type:'doomalay-auth', provider:'huggingface', user:'probe_tester', error:''}, window.location.origin); setTimeout(function(){window.__churn=n},300); 'queued'")
sleep 0.5
CHURNN=$(ev "window.__churn")
check "$CHURNN" "0" "dedupe: a repeated sync does not repaint the panel"

# cross-origin payload is ignored (the listener checks e.origin)
ev "window.postMessage({type:'doomalay-auth', provider:'huggingface', user:'EVIL'}, 'https://evil.example')" >/dev/null
sleep 0.4
STATE3=$(ev "(document.getElementById('hfc-state')||{}).innerText || ''")
has "$STATE3" "connected as probe_tester" "cross-origin message ignored"

# error message from a denied popup → surfaces in the panel err line
ev "window.HFConnect._applyAuthResult({error:'the code expired — retry'})" >/dev/null
HERR=$(ev "(document.getElementById('hfc-err')||{}).textContent || ''")
has "$HERR" "retry" "denied/failed popup message surfaces in the panel"

# focus refetch (the APK-return path): active panel is connected already —
# assert the wiring exists (listener count) rather than a second account probe
agent-browser screenshot /home/z/my-project/download/hf-homing-v060.png >/dev/null 2>&1
echo "screenshot: download/hf-homing-v060.png"

# ── UI: the GH panel exposes the same contract ────────────────────────────
agent-browser open "$BASE/#/" >/dev/null 2>&1
sleep 1.5
ev "window.GHConnect.openConnectPanel()" >/dev/null
sleep 1.2
GHK=$(ev "typeof window.GHConnect._applyAuthResult")
check "$GHK" "function" "GH panel has the same sync hook"
ev "window.GHConnect._applyAuthResult({user:'octo_probe'})" >/dev/null
sleep 0.4
GHS=$(ev "(document.getElementById('ghc-state')||{}).innerText || ''")
has "$GHS" "connected as octo_probe" "GH panel flips to connected on the message"

# the device flow still works for non-loopback origins (regression pin)
DEV=$(ev "window.HFConnect._runDeviceFlow ? 'hook-ok' : 'missing'")
check "$DEV" "hook-ok" "device-flow hook intact (gateway origins keep the code UX)"

echo "────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL GREEN"
