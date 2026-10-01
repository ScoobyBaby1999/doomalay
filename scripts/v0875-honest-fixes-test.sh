#!/bin/bash
# v0875-honest-fixes-test.sh — v0.87.5 THE TWO HONEST FIXES:
#  (A) THE SHEET RESTORE — the BIB tweaks handoff (the sheet's circle →
#      dismiss + spaEval openWebTweaksFor) no longer renders the SPA's
#      browser twin under the tweaks view (no verdict fetch, no iframe
#      load — the old flow's ‹ back landed the user on the SPA's card
#      for frame-refusers: "the weird screen with the two pills + a
#      website description"). Pressing ‹ back now RE-OPENS the native
#      sheet (its WebView was only onPause'd — the real browsing state
#      returns untouched) and closes the master panel.
#  (B) THE WEB FLOW unchanged — the web circle opens the tweaks; ‹ back
#      returns to the live browser view (no card for a frameable site).
#  (C) THE CIRCLE keeps mirroring the favicon on the web panel.
# The NATIVE white-icon tint fix (imageTintList) is Kotlin-side — CI
# compiles it; this rig pins the web twin's behavior.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8375
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0875
export AGENT_BROWSER_SESSION=doomalay-v0875

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0875-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser close >/dev/null 2>&1
sleep 0.6
OPENED=no
for i in 1 2 3; do
  agent-browser open "$BASE" >/dev/null 2>&1 && OPENED=yes && break
  sleep 1
done
READY=no
for i in 1 2 3 4 5 6; do
  V=$(agent-browser eval "document.readyState" 2>/dev/null | tr -d '"\n')
  [ "$V" = "complete" ] && READY=yes && break
  sleep 0.8
done
if [ "$READY" != "yes" ]; then
  echo "BROWSER BOOT FAIL (open=$OPENED ready=$READY)"
  exit 1
fi
ev "localStorage.clear()" >/dev/null 2>&1
# console-error capture for the whole rig
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (A0) seed a web tab + the web panel"
R=$(ev "(async function(){
  var t = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.com'});
  window.__t = t;
  await new Promise(r => setTimeout(r, 3500));
  return JSON.stringify({
    panelOpen: document.getElementById('chat-panel').classList.contains('open'),
    omni: !!document.querySelector('.wt-omni'),
    circleShown: document.getElementById('panel-tab-icon').style.display !== 'none',
    circleImg: !!(document.getElementById('panel-tab-icon').querySelector('img')),
    imgSrc: (document.getElementById('panel-tab-icon').querySelector('img')||{}).src || ''
  });
})()")
ck "the web panel renders + THE CIRCLE mirrors the tab (an img, not blank)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['panelOpen'] and d['omni'] and d['circleShown'] and d['circleImg'] and d['imgSrc'] else 'no')")" "$R"

echo "── (B) the WEB tweaks flow: circle → tweaks → ‹ back → the LIVE browser view (no card)"
R=$(ev "(async function(){
  // open the tweaks from the web circle (NOT the sheet handoff)
  document.getElementById('panel-tab-icon').click();
  await new Promise(r => setTimeout(r, 400));
  var v = {
    tweaksOpen: !!document.querySelector('.wtw-chip, .wtw-btn') && !document.querySelector('.wt-omni'),
    depth: window.doomalay ? 0 : 0
  };
  v.viewDepth = document.getElementById('panel-body').classList.contains('pv-mode');
  // ‹ back
  document.getElementById('panel-view-back').click();
  await new Promise(r => setTimeout(r, 500));
  v.backToBrowser = !!document.querySelector('.wt-omni');
  v.noCard = !document.querySelector('.wt-card');
  v.panelStillOpen = document.getElementById('chat-panel').classList.contains('open');
  return JSON.stringify(v);
})()")
ck "web: circle → the tweaks view (over the browser), ‹ back → the browser view returns — never the two-pill card" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['tweaksOpen'] and d['viewDepth'] and d['backToBrowser'] and d['noCard'] and d['panelStillOpen'] else 'no')")" "$R"

echo "── (A1) THE BIB HANDOFF — no SPA browser twin under the tweaks, ‹ back re-opens THE SHEET"
R=$(ev "(async function(){
  // close the panel, then install the BIB mocks (the Kotlin bridge + the sheet)
  document.getElementById('chat-scrim').click();
  await new Promise(r => setTimeout(r, 700));
  window.__sheetCalls = [];
  window.__doomalayKotlin = {
    openPanel: function(url, opts){ window.__sheetCalls.push({url:url, tab:(JSON.parse(opts||'{}').tab)||null}); return 'native-panel'; },
    panelUrl: function(){ return 'https://example.com'; },
    panelOpen: function(){ return true; },
    panelClose: function(){}, panelIcon: function(){}
  };
  window.InAppBrowser = {
    open: function(u, o){ window.__sheetCalls.push({open:u, purpose:o&&o.purpose, tabId:o&&o.tab&&o.tab.id}); return 'native-panel'; },
    currentURL: function(){ return window.__t.url; },
    external: function(){}, fallback: function(){}, purpose: function(){ return 'web'; }
  };
  // zero the preview-fetch counter, then fire the sheet handoff exactly
  // as PanelBrowserSheet's spaEval does
  window.__fetches = 0;
  var of = window.fetch;
  window.fetch = function(){ var u = String(arguments[0]||''); if (u.indexOf('/api/preview') >= 0) window.__fetches++; return of.apply(this, arguments); };
  var ok = window.doomalay.openWebTweaksFor(window.__t.id);
  await new Promise(r => setTimeout(r, 600));
  var v = {
    handoff: !!ok,
    tweaksOpen: !!document.querySelector('.wtw-chip, .wtw-btn'),
    // v0.88.1 note: scoped to the panel body (session roots park in document.body — a global query would find a parked omni and lie)
    noBrowserTwin: !document.getElementById('panel-body').querySelector('.wt-omni') && !document.getElementById('panel-body').querySelector('.wt-card') && !Array.prototype.some.call(document.querySelectorAll('.panel-body .wt-iframe'), function(f){ return f.style.display !== 'none'; }),
    previewFetches: window.__fetches,
    panelOpen: document.getElementById('chat-panel').classList.contains('open')
  };
  // ‹ back — the view's onClose must re-open the sheet + close the panel
  document.getElementById('panel-view-back').click();
  await new Promise(r => setTimeout(r, 700));
  v.sheetReopened = window.__sheetCalls.some(function(c){ return c.open === 'https://example.com'; });
  v.sheetTabId = (window.__sheetCalls.filter(function(c){return c.tabId;})[0]||{}).tabId === window.__t.id;
  v.panelClosed = !document.getElementById('chat-panel').classList.contains('open');
  window.fetch = of;
  return JSON.stringify(v);
})()")
ck "BIB handoff: the tweaks view opens — NO SPA browser twin (no omni/iframe/card) + zero preview fetches" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['handoff'] and d['tweaksOpen'] and d['noBrowserTwin'] and d['previewFetches']==0 and d['panelOpen'] else 'no')")" "$R"
ck "BIB ‹ back: THE SHEET re-opens (the exact tab id rides the opts) + the master panel closes" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['sheetReopened'] and d['sheetTabId'] and d['panelClosed'] else 'no')")" "$R"

echo "── (A2) Android-back + ✕ also route through the sheet restore"
R=$(ev "(async function(){
  // fire the handoff again, then use the SPA's handleBack (the Android twin)
  window.doomalay.openWebTweaksFor(window.__t.id);
  await new Promise(r => setTimeout(r, 400));
  var ate = window.doomalay.handleBack();
  await new Promise(r => setTimeout(r, 600));
  var v = { backConsumed: !!ate, panelClosedAfterBack: !document.getElementById('chat-panel').classList.contains('open') };
  // and the ✕ path: handoff → closeViews
  window.doomalay.openWebTweaksFor(window.__t.id);
  await new Promise(r => setTimeout(r, 400));
  document.getElementById('panel-view-x').click();
  await new Promise(r => setTimeout(r, 600));
  v.sheetsTotal = window.__sheetCalls.filter(function(c){ return c.open; }).length;
  v.xPanelClosed = !document.getElementById('chat-panel').classList.contains('open');
  return JSON.stringify(v);
})()")
ck "Android-back (handleBack) consumes + closes the panel; the ✕ path re-opens the sheet too" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['backConsumed'] and d['panelClosedAfterBack'] and d['sheetsTotal']>=3 and d['xPanelClosed'] else 'no')")" "$R"

echo "── (C) zero console errors through the whole flow"
R=$(ev "JSON.stringify({errs: window.__errs || []})")
ck "zero console errors through the whole flow" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if not d['errs'] else 'no')")" "$R"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "ALL GREEN" || exit 1
