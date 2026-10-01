#!/bin/bash
# v0911-group-tabs-test.sh — v0.91.1 THE NATIVE TAB POOL (user spec:
# "tabs orbiting the same center should act as a group… switching
# between 2 or more different tab icons in the canvas should not just
# reload one tab to whichever that tab icon's url was — instead, it
# should spawn two separate instances or tabs… as if the user had the
# page loaded the whole time").
#
# THE CONTRACT:
#  (1) THE GROUP PAYLOAD — openNative rides opts.tab {id, icon,
#      gradient, group[], alive[]} on EVERY open: group = the orbit's
#      WEB-tab ids (a stray tab's group is empty); alive = every web
#      tab id on the canvas. The tier is 'native-panel' (the bridge
#      path).
#  (2) THE SWITCH SEMANTICS — the sheet-side contract (the mock bridge
#      implements resolveTab's rules EXACTLY: a fresh tab id loads ONCE;
#      an existing tab NEVER reloads — a switch is a visibility swap;
#      the ephemeral _ext slot loads whenever the plain link's URL
#      differs; a plain link never reloads a live tab).
#  (3) THE SYNC GATE — the entity sync lands ONLY on the sheet's
#      CURRENT tab: a panel-state with tabId === the tab's id syncs its
#      URL; a tabId of another tab (or '_ext' — a plain link open)
#      writes NOTHING (the stale-tab clobber is dead); an ABSENT tabId
#      (a pre-v0.91 bridge) keeps the legacy sync.
#  (4) THE POOL MIRROR — the Kotlin algorithm (resolveTab + evictTabs +
#      sweepTabs + readGroupOpts, 1:1) as a pure-JS mirror: fresh = 1
#      load, switch = 0, back = 0; the budget (MAX_LIVE 5 non-protected,
#      hard cap 9, the active never, LRU order); the orbit group's
#      protection; the alive sweep.
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8795
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0911
export AGENT_BROWSER_SESSION=doomalay-v0911

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0911-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

app_ready() { agent-browser eval "!!(window.doomalay && window.TabGroups && window.WebTabs && window.GridIcon && window.InAppBrowser)" 2>/dev/null | tr -d '"\n' | grep -qi '^true$'; }
boot_and_wait() {
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  for i in $(seq 1 14); do app_ready && return 0; sleep 0.8; done
  return 1
}
agent-browser close >/dev/null 2>&1 || true
sleep 0.6
boot_and_wait || { echo "BROWSER BOOT FAIL"; exit 1; }
ev "localStorage.clear()" >/dev/null 2>&1
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

# ── the shared mock: THE SHEET-SIDE CONTRACT, resolveTab's rules verbatim
ev "(function(){
  // resolveTab's rules, executable: fresh tab id -> ONE load; existing
  // tab -> NEVER a load (a visibility swap); the _ext slot -> a load
  // whenever the plain link url differs. Loads count per id.
  window.__sheetLoads = {};
  window.__sheetUrls = {};
  window.__lastOpen = null;
  window.__panelUrlNow = '';
  window.__doomalayKotlin = {
    openPanel: function (url, optsJson) {
      var o = {};
      try { o = JSON.parse(optsJson); } catch (e) {}
      var id = (o.tab && o.tab.id) || '_ext';
      var known = Object.prototype.hasOwnProperty.call(window.__sheetUrls, id);
      if (!known) {
        window.__sheetUrls[id] = url;
        window.__sheetLoads[id] = 1;
      } else if (id === '_ext') {
        if (window.__sheetUrls[id] !== url) {
          window.__sheetUrls[id] = url;
          window.__sheetLoads[id] = (window.__sheetLoads[id] || 0) + 1;
        }
      }
      window.__lastOpen = o;
    },
    openExternal: function () {},
    panelClose: function () {},
    panelOpen: function () { return true; },
    panelUrl: function () { return window.__panelUrlNow; }
  };
  return 'mocked';
})()" >/dev/null 2>&1

echo "── (1) THE GROUP PAYLOAD — the orbit's web ids ride every openNative"
R=$(ev "(async function(){
  var tA = window.WebTabs.createAt(200, 300, { url: 'https://a.example/one' });
  var tB = window.WebTabs.createAt(280, 340, { url: 'https://b.example/two' });
  var tC = window.WebTabs.createAt(1500, 900, { url: 'https://c.example/stray' });
  window.__tA = tA; window.__tB = tB; window.__tC = tC;
  // the orbit: A + B collide (ANY two icons — v0.90.3); C stays a stray
  window.TabGroups.collide(tA, tB, 240, 320);
  await new Promise(function (r) { setTimeout(r, 250); });
  var tier = window.WebTabs.openNative(tA);
  return JSON.stringify({ tier: tier });
})()")
ck "openNative fires the bridge (returns true — the native-panel tier)" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read()); print('yes' if d.get('tier') is True else 'no')" 2>/dev/null || echo no)" "$R"
ev "window.__idA = window.__tA.id; window.__idB = window.__tB.id; window.__idC = window.__tC.id; 'ids'" >/dev/null 2>&1
R=$(ev "(function(){
  var o = window.__lastOpen;
  var g = o.tab.group || [];
  return JSON.stringify({
    tier: 'native-panel',
    id: o.tab.id === window.__idA,
    group: g.length === 2 && g.indexOf(window.__idA) >= 0 && g.indexOf(window.__idB) >= 0,
    alive: (o.tab.alive || []).length === 3,
    aGrouped: !!window.TabGroups.isGrouped(window.__tA),
    bGrouped: !!window.TabGroups.isGrouped(window.__tB),
    cFree: !window.TabGroups.isGrouped(window.__tC)
  });
})()")
ck "the payload: the tab id + both orbit members + 3 alive + A,B grouped, C free" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
ok = all(d.get(k) for k in ('id','group','alive','aGrouped','bGrouped','cFree'))
print('yes' if ok else 'no')" 2>/dev/null || echo no)" "$R"

R=$(ev "(function(){
  // the stray's payload: its group is EMPTY (no orbit) but alive still carries all
  window.WebTabs.openNative(window.__tC);
  var o = window.__lastOpen;
  return JSON.stringify({
    id: o.tab.id === window.__idC,
    groupEmpty: (o.tab.group || []).length === 0,
    alive3: (o.tab.alive || []).length === 3
  });
})()")
ck "the stray tab: group EMPTY, alive still every web tab" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read()); print('yes' if d.get('id') and d.get('groupEmpty') and d.get('alive3') else 'no')" 2>/dev/null || echo no)" "$R"

echo "── (2) THE SWITCH SEMANTICS — a switch is a visibility swap, never a reload"
R=$(ev "(async function(){
  var L = window.__sheetLoads;
  var before = { A: L[window.__idA] || 0, B: L[window.__idB] || 0, C: L[window.__idC] || 0 };
  // the jump: A -> B -> A -> B -> A (the user hopping the orbit's tabs)
  window.WebTabs.openNative(window.__tB);
  window.WebTabs.openNative(window.__tA);
  window.WebTabs.openNative(window.__tB);
  window.WebTabs.openNative(window.__tA);
  await new Promise(function (r) { setTimeout(r, 150); });
  L = window.__sheetLoads;
  var after = { A: L[window.__idA] || 0, B: L[window.__idB] || 0, C: L[window.__idC] || 0 };
  return JSON.stringify({
    freshEachLoadedOnce: after.A === 1 && after.B === 1,
    fourJumpsZeroReloads: after.A === before.A + 0 && after.B === before.B + 1,
    strayUntouched: after.C === before.C
  });
})()")
ck "A→B→A→B→A: every tab loaded ONCE, zero reloads across the jumps" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read()); print('yes' if d.get('freshEachLoadedOnce') and d.get('fourJumpsZeroReloads') and d.get('strayUntouched') else 'no')" 2>/dev/null || echo no)" "$R"

R=$(ev "(async function(){
  // a PLAIN LINK open (getkey, provider links): the ephemeral slot — it
  // replaces ITS content, never a live tab's page
  var L = window.__sheetLoads;
  var before = { A: L[window.__idA] || 0, ext: L['_ext'] || 0 };
  window.InAppBrowser.open('https://plain.example/link', { purpose: 'link' });
  window.InAppBrowser.open('https://plain.example/other', { purpose: 'link' });
  await new Promise(function (r) { setTimeout(r, 150); });
  L = window.__sheetLoads;
  return JSON.stringify({
    tabANeverReloaded: (L[window.__idA] || 0) === before.A,
    extFollowsLinks: (L['_ext'] || 0) === before.ext + 2,
    lastIsPlain: window.__lastOpen.tab === null || !window.__lastOpen.tab
  });
})()")
ck "plain links ride the _ext slot — the live tab's page is never clobbered" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read()); print('yes' if d.get('tabANeverReloaded') and d.get('extFollowsLinks') and d.get('lastIsPlain') else 'no')" 2>/dev/null || echo no)" "$R"

echo "── (3) THE SYNC GATE — the URL lands on the sheet's CURRENT tab only"
R=$(ev "(async function(){
  var tA = window.__tA;
  // make A the sheet's tab again
  window.WebTabs.openNative(tA);
  window.__panelUrlNow = 'https://moved.example/page';
  // (a) the RIGHT tab id — the sync lands
  window.__doomalayPanelState({ open: true, ducked: false, url: 'ignored', tabId: tA.id });
  var synced = tA.url;
  // (b) ANOTHER tab's id — nothing lands (the stale clobber is dead)
  window.__doomalayPanelState({ open: true, ducked: false, url: 'x', tabId: window.__idB });
  var heldB = tA.url;
  // (c) the _ext identity (a plain link open) — nothing lands
  window.__doomalayPanelState({ open: true, ducked: false, url: 'x', tabId: '_ext' });
  var heldExt = tA.url;
  // (d) legacy (no tabId — a pre-v0.91 bridge) — the sync lands
  window.__panelUrlNow = 'https://legacy.example/old';
  window.__doomalayPanelState({ open: true, ducked: false, url: 'x' });
  var legacy = tA.url;
  return JSON.stringify({
    synced: synced === 'https://moved.example/page',
    heldB: heldB === 'https://moved.example/page',
    heldExt: heldExt === 'https://moved.example/page',
    legacy: legacy === 'https://legacy.example/old'
  });
})()")
ck "tabId match syncs, mismatch/_ext hold, absent tabId keeps the legacy sync" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read()); print('yes' if d.get('synced') and d.get('heldB') and d.get('heldExt') and d.get('legacy') else 'no')" 2>/dev/null || echo no)" "$R"

echo "── (4) THE POOL MIRROR — the Kotlin algorithm, 1:1 (budget + protection + sweep)"
R=$(ev "(function(){
  // THE MIRROR — resolveTab + evictTabs + sweepTabs + readGroupOpts,
  // the exact rules PanelBrowserSheet.kt carries (MAX_LIVE 5, HARD 9).
  var EXT = '_ext', MAX_LIVE = 5, HARD_CAP = 9, clock = 0;
  var tabs = {}, loads = {}, activeId = null, protectedIds = {};
  function drop(id) { delete tabs[id]; }
  function resolveTab(id, url) {
    var h = tabs[id];
    if (!h) {
      tabs[id] = h = { id: id, url: url, lastActive: 0 };
      loads[id] = (loads[id] || 0) + 1;
    } else {
      // EXISTING — the switch dance; only _ext follows a differing url
      // (a plain link is ALWAYS fresh intent, whether _ext already shows
      // or is being switched back to mid-tab-browse); a TAB never reloads
      if (id === EXT && h.url !== url) { h.url = url; loads[id] = (loads[id] || 0) + 1; }
    }
    activeId = id; h.lastActive = ++clock;
  }
  function evict() {
    var over = Object.keys(tabs).length - MAX_LIVE;
    if (over > 0) {
      Object.keys(tabs).filter(function (k) { return !protectedIds[k] && k !== activeId; })
        .sort(function (a, b) { return tabs[a].lastActive - tabs[b].lastActive; })
        .forEach(function (k) { if (over > 0) { drop(k); over--; } });
    }
    over = Object.keys(tabs).length - HARD_CAP;
    if (over > 0) {
      Object.keys(tabs).filter(function (k) { return k !== activeId; })
        .sort(function (a, b) { return tabs[a].lastActive - tabs[b].lastActive; })
        .forEach(function (k) { if (over > 0) { drop(k); over--; } });
    }
  }
  function sweep(alive) {
    if (!alive) return;
    Object.keys(tabs).forEach(function (k) {
      if (k !== EXT && k !== activeId && alive.indexOf(k) < 0) drop(k);
    });
  }
  function open(id, url, tab) {
    if (tab && tab.group) { protectedIds = {}; tab.group.forEach(function (g) { protectedIds[g] = 1; }); }
    resolveTab(id, url);
    sweep(tab && tab.alive ? tab.alive : null);
    evict();
  }
  var out = {};
  // fresh + switch + back
  open('A', 'u1', { group: ['A','B'] });
  open('B', 'u2', { group: ['A','B'], alive: ['A','B'] });
  open('A', 'u1', { group: ['A','B'], alive: ['A','B'] });
  out.switchZeroReloads = loads.A === 1 && loads.B === 1;
  // eight unprotected + the group: A,B survive, LRU caps the rest at 5
  for (var i = 1; i <= 7; i++) open('t' + i, 'u', { alive: ['A','B','t1','t2','t3','t4','t5','t6','t7'] });
  var live = Object.keys(tabs);
  out.protectedSurvive = !!tabs.A && !!tabs.B;
  out.maxLiveHeld = live.length <= 6; // 5 budget + the active t7 (fresh)
  out.activeSurvives = !!tabs.t7;
  out.lruEvicted = !tabs.t1 && !tabs.t2; // the oldest go first
  // the hard cap: protect everything, push past 9
  var all = [];
  for (var j = 1; j <= 12; j++) { var id2 = 'h' + j; all.push(id2); open(id2, 'u', { group: all, alive: all }); }
  out.hardCap = Object.keys(tabs).length <= 9;
  // the sweep: a deleted canvas tab dies; the active + _ext stay
  open('_ext', 'plain', null);
  var aliveNow = Object.keys(tabs).filter(function (k) { return k !== '_ext'; });
  open('h1', 'u', { alive: ['h1'] });   // only h1 alive — everything else sweeps
  out.sweepWorks = !!tabs.h1 && Object.keys(tabs).length <= 3 && !!tabs._ext;
  // _ext loads on plain-link change
  open('_ext', 'plain2', null);
  out.extFollows = (loads._ext || 0) === 2;
  return JSON.stringify(out);
})()")
ck "the mirror: switches 0-load, protection, LRU, hard cap 9, sweep, _ext contract" \
  "$(echo "$R" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
need = ('switchZeroReloads','protectedSurvive','maxLiveHeld','activeSurvives','lruEvicted','hardCap','sweepWorks','extFollows')
ok = all(d.get(k) for k in need)
print('yes' if ok else 'no')" 2>/dev/null || echo no)" "$R"

echo "── (5) zero console errors"
E=$(ev "window.__errs.length")
ck "zero console errors" "$( [ "$E" = "0" ] && echo yes || echo no )" "$E"

echo ""
echo "══ v0.91.1 GROUP TABS: $PASS passed, $FAIL failed ══"
[ "$FAIL" = "0" ] || exit 1
