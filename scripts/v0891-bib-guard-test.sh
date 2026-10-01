#!/bin/bash
# v0891-bib-guard-test.sh — v0.89.1 THE ALIEN + THE GUARD'S LIST (user spec):
#   (1) "Instead if +model when creating a chat have a robot icon let's
#       have it have a weird 👾 purple alien face or ant face icon."
#   (2) "Exclude hugging face, GitHub, and other sites we use from the
#       redirect flow where the popup asks if we want to be redirected."
#
# THE CONTRACT:
#  (1) THE ALIEN — the +model row in the new-chat setup gate carries the
#      👾 glyph (not 🤖); once a provider is live the pill-model header
#      label reads "👾 <Provider>"; the empty state stays "◈ + Model".
#  (2) THE GUARD'S LIST — the OUR-SITES exemption set (9 registrable
#      hosts) skips the guard banner on the real decision path
#      (onFrameNavigated): a landing on huggingface.co / github.com /
#      docs.nvidia.com follows SILENTLY (no banner, the tab follows); an
#      unknown cross-domain move still asks + a tap elsewhere stays;
#      same-registrable moves remain silent; the exemption table rides
#      subdomains (portal.privatemode.ai ≡ privatemode.ai).
#      The native twin (PanelBrowserSheet.kt trustedHosts) mirrors the
#      same set + TARGET-based test — compile-risk reviewed (CI builds
#      the APK; the edit mirrors the searchHosts idiom exactly).
#  (3) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=8391
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0891
export AGENT_BROWSER_SESSION=doomalay-v0891

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0891-eng.log 2>&1 &
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

# v0891 red-team find: on a COLD engine with the brain healthy, the
# first /api/models (brain proxy + the merge) takes seconds — the
# provider labels land late and the one-shot _labelsDone re-render
# follows them. A real user waits for the app to load; the rig warms
# the catalog before the contract begins (and the pill check polls to
# 15s).
ev "fetch('/api/models').then(function(r){return r.json();}).then(function(d){return Object.keys((d&&d.providers)||{}).length;})" >/dev/null 2>&1
sleep 2

echo "── (1) THE ALIEN — 👾 rides the +model surfaces"
R=$(ev "(async function(){
  // the real-user path: the dock's + sub-pill creates a chat panel; the
  // setup gate's +Model row must carry the alien, not the robot.
  var plus = document.querySelector('#dock-toggle');
  if (plus) plus.click();
  await new Promise(r => setTimeout(r, 500));
  var sub = document.getElementById('dock-sub');
  var newChat = sub ? sub.querySelector('[data-dock-newchat], button, [role=button]') : null;
  if (newChat) newChat.click();
  await new Promise(r => setTimeout(r, 900));
  // find the +Model row in the live panel (the setup gate)
  var rows = Array.prototype.slice.call(document.querySelectorAll('#panel-body *'))
    .filter(function(el){ return el.children.length===0; });
  var modelRow = rows.find(function(el){ return /Model/.test(el.textContent||'') && /tap to connect|tap to change/.test(el.textContent||''); });
  var bodyTxt = document.getElementById('panel-body').textContent || '';
  return JSON.stringify({
    alien: bodyTxt.indexOf('\u{1F47E}') >= 0,   // 👾 present
    robot: bodyTxt.indexOf('\u{1F916}') >= 0,   // 🤖 must be GONE
    emptyState: bodyTxt.indexOf('+ Model') >= 0
  });
})()")
ck "the new-chat gate shows the 👾 alien (+Model) and NO 🤖 robot" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['alien'] and not d['robot'] and d['emptyState'] else 'no')")" "$R"

R=$(ev "(async function(){
  // the picker's own apply path (what the provider GUI calls): a live
  // provider turns the header pill into '👾 <Provider>' — the empty
  // state stays '◈ + Model'. current() is the HOST; the api hangs at
  // .ctx (chatframework's own convention: c.ctx || c).
  var c = window.ChatPanel && window.ChatPanel.current();
  var cx = c && (c.ctx || c);
  if (!cx || !cx.applyModel) return JSON.stringify({fail:'no ctx'});
  cx.applyModel('nvidia', 'nvidia/nemotron-120b');
  // POLL up to ~15s: the provider pill lands with the labels re-render
  // (ensureCatalog → the one-shot _labelsDone re-render) — a cold
  // engine's first /api/models (brain proxy + merge) can take seconds;
  // the real UI shows '👾 nvidia' as soon as the labels land.
  // RIG GOTCHA (live find): agent-browser eval MANGLES \u{...} inside
  // REGEX literals (string escapes survive) — build the pattern from
  // String.fromCodePoint or the check false-negatives a working render.
  var ALIEN = String.fromCodePoint(0x1F47E);
  var ROBOT = String.fromCodePoint(0x1F916);
  var pat = new RegExp(ALIEN + '\\s*nvidia', 'i');
  var all = '', hit = false;
  for (var i = 0; i < 30 && !hit; i++) {
    await new Promise(r => setTimeout(r, 300));
    all = document.getElementById('panel-body').textContent || '';
    hit = pat.test(all);
  }
  return JSON.stringify({
    // case-insensitive: the brain-healthy build serves the providers
    // section from the brain's catalog (label 'nvidia' lowercase); the
    // brain-down build serves the engine's ('NVIDIA'). The ALIEN is the
    // contract; the casing is catalog drift, not this wave's.
    pill: hit,
    noRobot: all.indexOf(ROBOT) < 0
  });
})()")
ck "a live provider renders the pill as '👾 <Provider>' (still no robot)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('pill') and d.get('noRobot') else 'no')")" "$R"

echo "── (2) THE GUARD'S LIST — our sites follow silently; unknowns still ask"
R=$(ev "JSON.stringify((function(){
  var D = window.WebPanel._debug;
  var T = D.trustedHosts();
  var r = D.registrableDomain;
  return {
    count: Object.keys(T).length,
    hf: !!T['huggingface.co'], gh: !!T['github.com'], pm: !!T['privatemode.ai'],
    subRides: r('portal.privatemode.ai') === 'privatemode.ai' && r('docs.nvidia.com') === 'nvidia.com',
    hfco: r('sub.hf.co') === 'hf.co'
  };
})())")
ck "the exemption table: 9 our-site registrables; subdomains ride (portal.privatemode.ai ≡ privatemode.ai)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['count']==9 and d['hf'] and d['gh'] and d['pm'] and d['subRides'] and d['hfco'] else 'no')")" "$R"

R=$(ev "(async function(){
  // a live web tab, then the REAL decision path (onFrameNavigated) —
  // first to huggingface.co (trusted): follows silently
  var t = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.com/'});
  window.__t = t;
  await new Promise(r => setTimeout(r, 2000));
  var D = window.WebPanel._debug;
  var before = t.url;
  D.onFrameNavigated(window.WebPanel._ctx(), 'https://huggingface.co/spaces/ScoobyBaby1999/Loom');
  await new Promise(r => setTimeout(r, 500));
  var hfFollowed = t.url.indexOf('huggingface.co') >= 0;
  var hfNoBanner = !document.querySelector('.wt-guard');
  // then to github.com (trusted): follows silently
  D.onFrameNavigated(window.WebPanel._ctx(), 'https://github.com/ScoobyBaby1999/doomalay');
  await new Promise(r => setTimeout(r, 500));
  var ghFollowed = t.url.indexOf('github.com') >= 0;
  var ghNoBanner = !document.querySelector('.wt-guard');
  // then an unknown cross-domain move: the banner asks
  D.onFrameNavigated(window.WebPanel._ctx(), 'https://ads.example.net/landing');
  await new Promise(r => setTimeout(r, 400));
  var banner = document.querySelector('.wt-guard');
  var asks = banner ? banner.textContent.indexOf('wants to redirect you to') >= 0 : false;
  // tap anywhere else = STAY (the move completely ignored)
  if (banner) document.querySelector('.wt-omni').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
  await new Promise(r => setTimeout(r, 400));
  return JSON.stringify({
    hfFollowed: hfFollowed, hfNoBanner: hfNoBanner,
    ghFollowed: ghFollowed, ghNoBanner: ghNoBanner,
    asks: asks,
    stayed: t.url.indexOf('ads.example.net') < 0,
    dismissed: !document.querySelector('.wt-guard')
  });
})()")
ck "huggingface.co + github.com follow SILENTLY (no banner); unknown.net asks; tap-elsewhere stays" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['hfFollowed'] and d['hfNoBanner'] and d['ghFollowed'] and d['ghNoBanner'] and d['asks'] and d['stayed'] and d['dismissed'] else 'no')")" "$R"

R=$(ev "(async function(){
  // a FRESH tab for this check — the previous sequence's stay-restore
  // (navigate(saved)) lands async and would clobber t.url mid-wait
  // (the live-debug find: the restore's onLoad overwrites the url after
  // the trusted follow already took).
  var t = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.com/'});
  window.__t2 = t;
  await new Promise(r => setTimeout(r, 2200));
  var D = window.WebPanel._debug;
  D.onFrameNavigated(window.WebPanel._ctx(), 'https://docs.nvidia.com/nim');
  await new Promise(r => setTimeout(r, 500));
  var nvFollowed = t.url.indexOf('docs.nvidia.com') >= 0;
  var nvNoBanner = !document.querySelector('.wt-guard');
  // same-registrable move (subdomain) — silent follow, no banner
  D.onFrameNavigated(window.WebPanel._ctx(), 'https://www.nvidia.com/en-us/');
  await new Promise(r => setTimeout(r, 500));
  var sameOk = t.url.indexOf('www.nvidia.com') >= 0 && !document.querySelector('.wt-guard');
  return JSON.stringify({ nvFollowed: nvFollowed, nvNoBanner: nvNoBanner, sameOk: sameOk });
})()")
ck "docs.nvidia.com follows silently; same-registrable moves stay banner-free" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['nvFollowed'] and d['nvNoBanner'] and d['sameOk'] else 'no')")" "$R"

echo "── (3) zero console errors"
ERRS=$(agent-browser errors --json 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  items = d.get('data',{}).get('errors', [])
  print(len(items))
except Exception:
  print('?')" )
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "errors=$ERRS"

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || exit 1
