#!/bin/bash
# v0623-embed-browser-test.sh — RED-TEAM the v0.62.3 in-app browser (web side).
#
# The APK side (ViewerActivity + the bridge + handleUrl intercept +
# onShowCustomView fullscreen + Custom Tab handoff) compiles in CI — the
# tunnel is down, so the Kotlin surface is code-reviewed + CI-gated, and
# the WEB tiers are red-teamed here for real:
#   - InAppBrowser exists with the three tiers in order: bridge → popup → tab
#   - the bridge tier: a stubbed __doomalayKotlin receives the URL + a
#     live theme snapshot (real CSS vars, not literals) + the hostile flag
#   - the desktop tier: a popup opens; the app tab never navigates
#   - the providers panel: Get-API-key routes through InAppBrowser and the
#     hint copy matches the tier that fired
#   - webview_hostile flows from providers.json through /api/models
#   - the blocked-link card's "open ↗" rides InAppBrowser too
set -u
DATA=/tmp/doomalay-v0623
PORT=8184
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0623
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
has()  { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2' in: ${1:0:220})";; esac; }

rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0623-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# webview_hostile flows through the provider API
PM=$(curl -s $BASE/api/models)
has "$PM" '"webview_hostile":true' "API: webview_hostile flags flow through /api/models"

agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5

# 1. InAppBrowser exists with the tier order
ev "window.InAppBrowser && typeof window.InAppBrowser.open === 'function' ? 'yes' : 'no'" >/tmp/v0623-a
check "$(cat /tmp/v0623-a)" "yes" "InAppBrowser.open exists (linkviewer.js)"

# 2. the bridge tier: stub the Kotlin bridge, verify the call carries
#    the URL + hostile flag + a LIVE theme snapshot (CSS vars resolved)
#    [v0.67.3 CONTRACT REBASE: the stub is the v0.64+ bridge shape —
#    openPanel — and getkey/hostile URLs ride the PANEL now (the BIB
#    is a real top-level WebView; hostile is metadata, and the old
#    openInApp-only stub made the hostile call window.open away the
#    tab, killing every section after it)]
BRIDGE=$(ev "
(function(){
  window.__bridgeCalls = [];
  window.__doomalayKotlin = { openPanel: function(url, opts) { window.__bridgeCalls.push({url:url, opts:JSON.parse(opts)}); } };
  var t1 = window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'});
  var t2 = window.InAppBrowser.open('https://opencode.ai/auth', {purpose:'getkey', hostile:true});
  var c = window.__bridgeCalls;
  var themeOk = c[0].opts.theme && c[0].opts.theme.accent && c[0].opts.theme.accent.length > 2;
  delete window.__doomalayKotlin;
  return JSON.stringify({t1:t1, t2:t2, n:c.length, hostile0:c[0].opts.hostile, hostile1:c[1].opts.hostile, url0:c[0].url, themeOk:themeOk, accent:c[0].opts.theme.accent});
})()")
has "$BRIDGE" '"t1":"native-panel"' "bridge tier fires first when __doomalayKotlin is present (the v0.67.3 BIB mandate)"
has "$BRIDGE" '"t2":"native-panel"' "the hostile provider rides the PANEL too (hostile is metadata in the BIB era)"
has "$BRIDGE" '"hostile0":false' "the non-hostile link passes hostile:false"
has "$BRIDGE" '"hostile1":true' "the webview-hostile provider passes hostile:true"
has "$BRIDGE" '"themeOk":true' "the bridge call carries a live theme snapshot"
has "$BRIDGE" '"url0":"https://openrouter.ai/keys"' "the bridge call carries the URL"

# 4. the providers panel: Get API key routes through InAppBrowser + the
#    hint copy adapts to the tier
PANEL=$(ev "
(function(){
  window.__provCalls = [];
  window.__doomalayKotlin = {
    openPanel: function(url, opts) { window.__provCalls.push({url:url}); },
    openInApp: function(url, opts) { window.__provCalls.push({url:url}); }
  };
  // open the providers panel (the same API app.js wires to #dock-cloud)
  if (!window.ProvidersScreen) return 'no-screen';
  window.ProvidersScreen.open(function(){});
  return 'opened';
})()")
sleep 3
PROVLINK=$(ev "
(function(){
  var a = document.querySelector('[data-getkey]');
  if (!a) return 'no-getkey-link';
  a.click();
  var hint = document.getElementById('getkey-hint-' + a.dataset.getkey);
  return JSON.stringify({called: window.__provCalls.length, url: (window.__provCalls[0]||{}).url, hint: hint ? hint.style.display : 'no-hint'});
})()")
has "$PROVLINK" '"called":1' "Get API key routes through InAppBrowser (not the system browser)"
has "$PROVLINK" 'opencode.ai/auth' "the FIRST provider (opencode — hostile) opens via the bridge"
has "$PROVLINK" '"hint":"block"' "the waiting hint appears with the key flow"

# 5. the hint copy names the in-app browser on the bridge tier (APK)
HINTTXT=$(ev "
(function(){
  var a = document.querySelector('[data-getkey]');
  var hint = document.getElementById('getkey-hint-' + a.dataset.getkey);
  return hint ? hint.textContent : '';
})()")
has "$HINTTXT" "panel browser" "the bridge-tier hint copy says 'panel browser' (the v0.67.3 native-panel branch)"

# 6. the blocked-link card's open rides InAppBrowser (bridge stub still up)
# (v0.63.5: a plain tap DOCKS the panel browser now — the card painter is
#  exported surface; drive it directly, exactly like a tap did in v0.62.3.)
CARDOPEN=$(ev "
(function(){
  window.__provCalls = [];
  var holder = document.createElement('div');
  holder.id = 'v0623-cardmsg';
  document.body.appendChild(holder);
  window.Formatter.renderInto(holder, 'see [the console](https://openrouter.ai/keys)', 'full', {});
  var a = holder.querySelector('a[href*=openrouter]');
  if (!a) return 'no-link';
  window.LinkViewer.openCard(a, a.href);
  return 'card-pending';
})()")
sleep 4
CARDOPEN2=$(ev "
(function(){
  var card = document.querySelector('#v0623-cardmsg .lv-card');
  if (!card) return 'no-card';
  if (card.style.display === 'none') return 'card-hidden';
  var b = card.querySelector('.lv-open');
  if (!b) return 'no-open-btn';
  window.__provCalls = [];
  b.click();
  return JSON.stringify({called: window.__provCalls.length, url: (window.__provCalls[0]||{}).url});
})()")
has "$CARDOPEN2" '"called":1' "the blocked card's open ↗ rides InAppBrowser"
has "$CARDOPEN2" 'openrouter.ai/keys' "the card opens the same URL via the bridge"

# 7. the desktop tier LAST (the popup grabs the session's active tab —
#    close it inside the check so nothing after it strays)
POP=$(ev "
(function(){
  var before = location.href;
  var w = window.InAppBrowser.open('https://example.com/');
  var tier = w ? 'popup' : 'tab';
  try { if (w) w.close(); } catch (e) {}
  return tier + '|' + (location.href === before);
})()")
case "$POP" in popup*true) ok "desktop tier opens a popup; the app tab stays";; *) bad "desktop tier: $POP";; esac

echo ""
echo "══ v0.62.3 embed-browser (web) red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
