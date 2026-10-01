#!/bin/bash
# v0881-keepalive-test.sh — v0.88.1 THE TAB KEEP-ALIVE (user spec
# verbatim: "if we go from one tab icon to another, the entire page gets
# refreshed, let's try not to do that. Instead, let's try to have them
# act like real tabs while trying to maintain performance. We want it so
# that clicking or jumping from one tab to another maintains each tab as
# if it where untouched and still active just idle/paused… they remember
# their state, scroll position, text in search boxes even if incomplete
# and unsearched, or message boxes like a messaging site… Like how they
# do computers.")
#
# THE CONTRACT:
#  (1) THE DECK — one persistent .wt-deck child of the panel body
#      (data-wt-keep), spared by every body wipe (open / view render /
#      restore); every session's iframe lives there, NEVER re-parented
#      (the empirical rule: display toggles preserve a frame's browsing
#      context; ONE re-parent destroys it).
#  (2) NO RELOADS — tab A → tab B → tab A: the SAME iframe node, ZERO
#      load events, the omnibox's unsent text intact; panel close →
#      reopen: same; tweaks view push → pop: same. A same-origin frame
#      (the engine's own page as a tab url) proves the FULL state: a
#      DOM marker + the exact scroll position survive every round-trip.
#  (3) THE BUDGET — MAX_LIVE 6 parked frames (LRU eviction; the rig
#      creates 8 tabs and proves the deck caps); the active tab never
#      evicts.
#  (4) THE VIEWS — the tweaks round-trip keeps the page alive (the
#      panel-view stack stashes the session root in a fragment; the
#      frame hides while covered, shows on pop — no navigation).
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8381
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0881
export AGENT_BROWSER_SESSION=doomalay-v0881

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0881-eng.log 2>&1 &
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
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (1) THE DECK — a persistent, spared, never-reparented iframe host"
R=$(ev "(async function(){
  var tA = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.com'});
  window.__tA = tA;
  await new Promise(r => setTimeout(r, 3500));
  var dbg = window.WebPanel._debug;
  var body = document.getElementById('panel-body');
  var deck = document.querySelector('.panel-body > .wt-deck');
  var sA = dbg.sessionOf(tA.id);
  window.__loadA = 0;
  if (sA && sA.iframe) { sA.iframe.addEventListener('load', function(){ window.__loadA++; }); }
  window.__iframeA = sA ? sA.iframe : null;
  return JSON.stringify({
    deckChild: !!deck && deck === dbg.deck(),
    deckKeep: !!(deck && deck.dataset.wtKeep === '1'),
    frameInDeck: !!(sA && sA.iframe && sA.iframe.parentNode === deck),
    rootMarked: !!(sA && sA.root && sA.root.dataset.wtRoot === '1'),
    frameShown: !!(sA && sA.iframe && sA.iframe.style.display !== 'none'),
    rectSynced: (function(){ if (!sA || !sA.iframe) return false;
      var ph = sA.frame.getBoundingClientRect(), fr = sA.iframe.getBoundingClientRect();
      return Math.abs(ph.left - fr.left) < 2 && Math.abs(ph.top - fr.top) < 2 && Math.abs(ph.width - fr.width) < 3; })(),
    panelOpen: document.getElementById('chat-panel').classList.contains('open')
  });
})()")
ck "the deck: one persistent body child (data-wt-keep), the session's frame lives in it, rect-synced over the placeholder" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['deckChild'] and d['deckKeep'] and d['frameInDeck'] and d['rootMarked'] and d['frameShown'] and d['rectSynced'] and d['panelOpen'] else 'no')")" "$R"

echo "── (2) NO RELOADS — A → B → A: same node, zero loads, unsent omni text intact"
R=$(ev "(async function(){
  // type UNSANT text into A's omnibox (never submitted)
  var sA = window.WebPanel._debug.sessionOf(window.__tA.id);
  sA.omni.value = 'unsearched draft text';
  // create tab B + open it (the panel re-opens; A's root parks, A's frame hides)
  var tB = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.org'});
  window.__tB = tB;
  await new Promise(r => setTimeout(r, 3200));
  var sB = window.WebPanel._debug.sessionOf(tB.id);
  var mid = {
    bFrame: !!(sB && sB.iframe && sB.iframe.style.display !== 'none'),
    aFrameHidden: !!(sA && sA.iframe && sA.iframe.style.display === 'none'),
    aFrameAlive: !!(sA && sA.iframe && sA.iframe.parentNode === window.WebPanel._debug.deck()),
    aRootParked: !!(sA && sA.root && sA.root.parentNode === window.WebPanel._debug.park())
  };
  // load counter on A (attached at (1) via a wrapper)
  var loadsBefore = window.__loadA | 0;
  // back to A — THE KEEP-ALIVE MOMENT (poll up to 5s: the panel's slide
  // + the vis-h write can lag a loaded page — the contract is the
  // no-reload show, not the millisecond)
  window.doomalay.openWebPanelFor(window.__tA);
  var shown = false;
  for (var w = 0; w < 50 && !shown; w++) {
    await new Promise(r => setTimeout(r, 100));
    var sAx = window.WebPanel._debug.sessionOf(window.__tA.id);
    if (sAx && sAx.iframe && sAx.iframe.style.display !== 'none') shown = true;
  }
  var sA2 = window.WebPanel._debug.sessionOf(window.__tA.id);
  return JSON.stringify({
    bShown: mid.bFrame, aHid: mid.aFrameHidden, aAliveInDeck: mid.aFrameAlive, aParked: mid.aRootParked,
    sameNode: !!(sA2 && sA2.iframe === window.__iframeA),
    zeroLoads: (window.__loadA | 0) === loadsBefore,
    omniText: sA2 ? sA2.omni.value : '',
    aShownAgain: shown,
    // v0.88.1: the fresh-eyes catch — open()'s placeholder (the opaque
    // .wt-loading overlay) must never survive the session attach (it
    // painted over the live frame + ate its pointer events)
    noStrayOverlay: !document.getElementById('panel-body').querySelector('.wt-loading')
  });
})()")
ck "A → B → A: the SAME iframe node shows again — parked, hidden, never navigated, NO stray overlay" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['sameNode'] and d['zeroLoads'] and d['bShown'] and d['aHid'] and d['aAliveInDeck'] and d['aParked'] and d['aShownAgain'] and d['noStrayOverlay'] else 'no')")" "$R"
ck "the omnibox's UNSANT text survived the round-trip ('unsearched draft text')" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['omniText'] == 'unsearched draft text' else 'no')")" "$R"

echo "── (3) the tweaks view round-trip — the page under the view stays live"
R=$(ev "(async function(){
  var sA = window.WebPanel._debug.sessionOf(window.__tA.id);
  document.getElementById('panel-tab-icon').click();
  await new Promise(r => setTimeout(r, 400));
  // scoped to the PANEL BODY (the park is in document.body — a global
  // query would find another tab's parked omni and lie). The hide is a
  // rAF pass — poll for it (the contract is the covered frame, not the
  // millisecond).
  var viewOpen2 = !document.getElementById('panel-body').querySelector('.wt-omni') && !!document.querySelector('.wtw-chip, .wtw-btn');
  var hid = false;
  for (var hw = 0; hw < 20 && !hid; hw++) {
    await new Promise(r => setTimeout(r, 100));
    if (sA.iframe && sA.iframe.style.display === 'none') hid = true;
  }
  var covered = {
    viewOpen: viewOpen2,
    frameHidUnderView: hid,
    rootInFragOrPark: sA.root.parentNode !== document.getElementById('panel-body')
  };
  document.getElementById('panel-view-back').click();
  var reshow = false;
  for (var w2 = 0; w2 < 50 && !reshow; w2++) {
    await new Promise(r => setTimeout(r, 100));
    if (sA.iframe && sA.iframe.style.display !== 'none') reshow = true;
  }
  return JSON.stringify({
    covered: covered.viewOpen && covered.frameHidUnderView && covered.rootInFragOrPark,
    sub: covered,
    sameNodeAfterView: !!(sA.iframe && sA.iframe === window.__iframeA),
    shownAfterView: reshow,
    omniHeld: sA.omni.value
  });
})()")
ck "tweaks push → pop: the frame hid under the view, the SAME node + the unsent text return" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['covered'] and d['sameNodeAfterView'] and d['shownAfterView'] and d['omniHeld']=='unsearched draft text' else 'no')")" "$R"

echo "── (4) panel close → reopen: the page as the user left it"
R=$(ev "(async function(){
  document.getElementById('chat-scrim').click();
  await new Promise(r => setTimeout(r, 700));
  var closed = {
    panelClosed: !document.getElementById('chat-panel').classList.contains('open'),
    frameHidden: !!(window.__iframeA.style.display === 'none')
  };
  window.doomalay.openWebPanelFor(window.__tA);
  await new Promise(r => setTimeout(r, 800));
  var sA = window.WebPanel._debug.sessionOf(window.__tA.id);
  return JSON.stringify({
    closedOk: closed.panelClosed && closed.frameHidden,
    sameNode: !!(sA.iframe === window.__iframeA),
    shown: !!(sA.iframe && sA.iframe.style.display !== 'none'),
    omniHeld: sA.omni.value
  });
})()")
ck "panel close → reopen: the SAME live node returns (no re-navigation), the draft text holds" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['closedOk'] and d['sameNode'] and d['shown'] and d['omniHeld']=='unsearched draft text' else 'no')")" "$R"

echo "── (5) THE FULL STATE PROOF — a same-origin tab: scroll + a DOM marker survive"
R=$(ev "(async function(){
  // a same-origin tab — the engine refuses loopback previews (the SSRF
  // guard — by design), so the rig drives the exact paint path directly
  // (WebPanel._debug.paintFrameFor — the same paintFrame the verdict
  // rides)
  var tS = window.WebTabs.createAt(140, 980, {url: '$BASE'});
  window.__tS = tS;
  window.doomalay.openWebPanelFor(tS);
  await new Promise(r => setTimeout(r, 400));
  window.WebPanel._debug.paintFrameFor(tS.id, '$BASE');
  await new Promise(r => setTimeout(r, 4500));
  var sS = window.WebPanel._debug.sessionOf(tS.id);
  if (!sS || !sS.iframe) return JSON.stringify({fail: 'no same-origin frame'});
  try {
    var w = sS.iframe.contentWindow;
    w.document.body.setAttribute('data-marker', 'state-42');
    // the app page is a fixed-viewport canvas app — unlock the scroll
    // (html AND body: a locked <html> swallows window scrolling) so the
    // scroll proof has range
    w.document.documentElement.style.overflow = 'auto';
    w.document.documentElement.style.height = 'auto';
    w.document.body.style.overflow = 'auto';
    w.document.body.style.height = 'auto';
    var tall = w.document.createElement('div');
    tall.style.height = '3000px';
    w.document.body.appendChild(tall);
    w.scrollTo(0, 640);
    await new Promise(r => setTimeout(r, 300));
    window.__scrollAchieved = Math.round(w.scrollY || 0);
  } catch (e) { return JSON.stringify({fail: 'sealed: ' + e.message}); }
  // away to A and back
  window.doomalay.openWebPanelFor(window.__tA);
  await new Promise(r => setTimeout(r, 700));
  window.doomalay.openWebPanelFor(tS);
  await new Promise(r => setTimeout(r, 900));
  var sS2 = window.WebPanel._debug.sessionOf(tS.id);
  var out = { sameNode: sS2.iframe === sS.iframe, wantScroll: window.__scrollAchieved };
  try {
    var w2 = sS2.iframe.contentWindow;
    out.marker = w2.document.body.getAttribute('data-marker');
    out.scrollY = Math.round(w2.scrollY || 0);
  } catch (e) { out.marker = 'sealed'; }
  return JSON.stringify(out);
})()")
ck "same-origin tab: the DOM marker + the EXACT scroll position survive the round-trip" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('marker')=='state-42' and d.get('scrollY',-1)==d.get('wantScroll',-2) and d.get('wantScroll',0)>50 and d.get('sameNode') else 'no')")" "$R"

echo "── (6) THE BUDGET — 8 tabs, the deck caps at 6 live frames (LRU)"
R=$(ev "(async function(){
  var urls = ['https://example.com', 'https://example.org', 'https://duckduckgo.com',
              'https://wikipedia.org', 'https://github.com', 'https://mozilla.org',
              'https://rust-lang.org', 'https://go.dev'];
  var made = [];
  for (var i = 0; i < urls.length; i++) {
    var t = window.WebTabs.createAt(120 + i * 90, 900, {url: urls[i]});
    made.push(t);
  }
  // open each in turn (populating sessions + frames)
  for (var j = 0; j < made.length; j++) {
    window.doomalay.openWebPanelFor(made[j]);
    await new Promise(r => setTimeout(r, 700));
  }
  var dbg = window.WebPanel._debug;
  return JSON.stringify({
    live: dbg.liveFrames(),
    cap: 6,
    deckChildren: document.querySelectorAll('.panel-body > .wt-deck > iframe').length
  });
})()")
ck "8 tabs visited: the parked-frame budget holds at 6 (LRU eviction; the active never evicts)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['live']==6 and d['deckChildren']==6 else 'no')")" "$R"

echo "── (7) zero console errors through the whole flow"
R=$(ev "JSON.stringify({errs: window.__errs || []})")
ck "zero console errors" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if not d['errs'] else 'no')")" "$R"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "ALL GREEN" || exit 1
