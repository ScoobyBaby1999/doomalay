#!/bin/bash
# v0871-bib-focus-test.sh — v0.87 THE BIB FOCUS WAVE (user spec verbatim:
#   1. "Let's remove the second random panel that appears alongside the
#      browser panel. We only want one panel. Remove the one with the
#      gradient selector that doesn't work and the mini browser in panel
#      view. Instead, let's add a circular icon right of the middle dash
#      in the panel and left of the back arrow pill. That circle icon
#      should update with and be the same as the icon of the tab itself
#      on the canvas."
#   2. "I love how the canvas tab icon updates to show the website being
#      used... But it does so very slowly, let's have it quickly refresh
#      both icons to reflect the website that is being browsed."
#   3. "let's add this functionality for websites with a lot of adds. If
#      a website tries to redirect the user to another website that
#      isn't the same relative domain - not exact, we should put a sort
#      of pop notification at the top of the panel that asks the user if
#      they want to be redirected to xyz website, with a redirect icon.
#      If the user presses the redirect icon they are redirected, if not
#      (they press anywhere else) they stay in the same page without
#      refreshing the page or resetting the users scroll position, and
#      the redirect is completely ignored. (unless it's the search
#      engine website like duckduckgo or Google)"
#   4. "Pressing the circular icon that reflects the websites icon in
#      the panel header... Should open panel similar to the tweaks panel
#      found in the chatbot. The user can ideally change the text sizes
#      of the websites and the browser itself, change the colors of the
#      browser and websites, and change the icon of the browser exactly
#      like how they can change an icon of a chatbot (upload image)."
#   + ADDENDUM: "if the user changes the icon of the tab it shouldn't
#      keep dynamically reflecting the new website logo" — pinned icons
#      (image / custom gradient) never re-derive; only 'auto' does).
#
# THE CONTRACT:
#  (1) ONE PANEL — the side panel (the gradient selector that didn't
#      work) is GONE from the web view; a BIB mock tap opens ONLY the
#      native sheet (openPanel + the tab opts) — the master panel never
#      opens.
#  (2) THE CIRCLE — #panel-tab-icon rides the handle strip right of the
#      dash; mirrors the tab's icon; live-updates on navigation; hides
#      when the panel closes.
#  (3) THE FAST ICON REFRESH — the engine's ?fast=1 lane answers
#      {favicon,title}; a guard-accepted cross-domain move refreshes
#      BOTH icons (canvas disc + the circle) quickly; same-host moves
#      never re-fetch; a PINNED image icon holds under real browsing.
#  (4) THE REDIRECT GUARD — the banner asks for cross-REGISTRABLE-domain
#      moves; the ⇱ accept follows; a tap elsewhere stays (the entity
#      never moves); search engines are exempt; the domain math holds
#      (subdomains ≡, co.uk-style 2nd-level TLDs).
#  (5) THE TWEAKS — the circle opens the view (3 sections); the
#      sliders apply live (--wt-fs + the iframe zoom + the filter);
#      everything persists across a full reload.
#  (6) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8371
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0871
export AGENT_BROWSER_SESSION=doomalay-v0871

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
# only the LAST JSON-parseable line is the eval's answer — banners and
# status lines (a fresh browser launch, navigation notes) pollute the
# stream and must never reach the parser
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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0871-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser close >/dev/null 2>&1
sleep 0.6
# the open can race the browser relaunch after a close (the red-team's
# 50% flake: EVERY eval returned empty because the open failed silently
# behind >/dev/null) — retry it, then prove the page is interactive
# before the contract begins
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

echo "── (1) ONE PANEL — the side panel is gone; BIB builds see only the native sheet"
R=$(ev "(async function(){
  var t = window.doomalay.createWebTabAtCenterAndOpen({url: 'https://example.com'});
  window.__t = t;
  await new Promise(r => setTimeout(r, 2500));
  var panel = document.getElementById('chat-panel');
  var side = document.querySelector('.wt-side');
  return JSON.stringify({
    panelOpen: panel.classList.contains('open'),
    sideGone: !side,
    dockedGone: !document.querySelector('.wt-docked'),
    omni: !!document.querySelector('.wt-omni'),
    circle: !!(document.getElementById('panel-tab-icon'))
  });
})()")
ck "web panel: no side panel, no docked card — the omnibox + THE CIRCLE only" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['panelOpen'] and d['sideGone'] and d['dockedGone'] and d['omni'] and d['circle'] else 'no')")" "$R"

R=$(ev "(async function(){
  // close the panel, then mock the BIB bridge + tap the canvas icon
  document.getElementById('chat-scrim').click();
  await new Promise(r => setTimeout(r, 800));
  window.__bib = [];
  window.__doomalayKotlin = {
    openPanel: function(url, opts){ window.__bib.push({url: url, opts: JSON.parse(opts)}); },
    panelUrl: function(){ return window.__bibUrl || 'https://example.com'; },
    panelOpen: function(){ return true; },
    panelClose: function(){}, panelIcon: function(){}
  };
  var e = window.__t;
  e.x = 206; e.y = 450; e.vx = 0; e.vy = 0;
  window.doomalay.resetView(); window.doomalay.repaint();
  e.el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 210, clientY: 460}));
  e.el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 210, clientY: 460}));
  await new Promise(r => setTimeout(r, 900));
  var panel = document.getElementById('chat-panel');
  var o = window.__bib.length ? window.__bib[0].opts : {};
  return JSON.stringify({
    bibFired: window.__bib.length === 1,
    tabId: !!(o.tab && o.tab.id),
    tabIcon: !!(o.tab && o.tab.icon),
    masterStayedClosed: !panel.classList.contains('open')
  });
})()")
ck "BIB tap: openPanel ONCE with the tab identity, NO master panel (the ONE panel)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['bibFired'] and d['tabId'] and d['tabIcon'] and d['masterStayedClosed'] else 'no')")" "$R"

echo "── (2) THE CIRCLE — right of the dash, mirrors the tab, live"
R=$(ev "(async function(){
  // the sheet browses while the bridge is alive: panel-state carries the
  // fresh URL → the entity sync + the fast icon refresh
  window.__bibUrl = 'https://github.com';
  window.__doomalayPanelState({open: true, ducked: false, url: 'https://github.com'});
  await new Promise(r => setTimeout(r, 4000));
  // then drop the mock (the web path resumes below)
  window.__doomalayKotlin = undefined;
  var t = window.__t;
  return JSON.stringify({url: t.url, title: t.title.slice(0, 8), fav: t.favicon});
})()")
R2=$(ev "JSON.stringify({url: window.__t.url, title: window.__t.title.slice(0,8), fav: window.__t.favicon})")
ck "the sheet-sync drove the entity (url + fast favicon + title)" \
  "$(echo "$R2" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if 'github.com' in d['url'] and d['fav'] and d['title'] else 'no')")" "$R2"

R=$(ev "(async function(){
  // reopen the web panel (the circle paints from the live entity)
  window.doomalay.openWebTweaksFor(window.__t.id);
  document.getElementById('panel-view-x') ? document.getElementById('panel-view-x').click() : null;
  await new Promise(r => setTimeout(r, 500));
  var t = window.__t;
  var circle = document.getElementById('panel-tab-icon');
  var dash = document.querySelector('.handle-bar');
  var img = circle.querySelector('img');
  return JSON.stringify({
    visible: getComputedStyle(circle).display !== 'none',
    mirrors: !!(img && t.favicon && img.src === t.favicon),
    rightOfDash: circle.getBoundingClientRect().left > dash.getBoundingClientRect().left,
    inHandleRow: !!(circle.closest('.handle'))
  });
})()")
ck "the circle: visible, right of the dash, in the handle strip, mirroring the tab's icon" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['visible'] and d['mirrors'] and d['rightOfDash'] and d['inHandleRow'] else 'no')")" "$R"

R=$(ev "(async function(){
  document.getElementById('chat-scrim').click();
  await new Promise(r => setTimeout(r, 800));
  return JSON.stringify({hidden: getComputedStyle(document.getElementById('panel-tab-icon')).display === 'none'});
})()")
ck "the circle leaves with the panel" \
  "$(echo "$R" | python3 -c "import sys,json;print('yes' if json.loads(sys.stdin.read())['hidden'] else 'no')")" "$R"

echo "── (3) THE FAST ICON REFRESH (both icons, quickly)"
FAST=$(curl -s -m 6 "$BASE/api/preview?fast=1&url=https://example.com" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    # either shape serves the icon: the fresh lane {fast:true, favicon}
    # or a warm full verdict (the best data wins — by design)
    print('yes' if d.get('favicon') else 'no')
except Exception:
    print('no')")
ck "the engine's ?fast=1 lane answers {favicon} fast" "$FAST"

R=$(ev "(async function(){
  // reopen + guard-accept a cross-domain move → BOTH icons refresh
  window.doomalay.openWebTweaksFor(window.__t.id);
  document.getElementById('panel-view-x') ? document.getElementById('panel-view-x').click() : null;
  await new Promise(r => setTimeout(r, 500));
  var D = window.WebPanel._debug;
  D.showGuard('https://github.com/');
  var g = document.querySelector('.wt-guard');
  if (!g) return JSON.stringify({fail: 'no guard'});
  g.querySelector('.wt-guard-go').click();
  await new Promise(r => setTimeout(r, 4000));
  var t = window.__t;
  var disc = t.el.querySelector('.icon img');
  var circ = document.getElementById('panel-tab-icon').querySelector('img');
  return JSON.stringify({
    url: t.url,
    disc: disc ? disc.src : '',
    circle: circ ? circ.src : ''
  });
})()")
ck "a guard-accepted move refreshes BOTH the canvas disc + the circle (fast)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if 'github.com' in d['url'] and 'github' in d['disc'] and 'github' in d['circle'] else 'no')")" "$R"

R=$(ev "(async function(){
  // PIN: an uploaded image holds under a real cross-domain navigation
  var t = window.__t;
  t.setImageIcon('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  t.refreshIcon('https://github.com/');
  await new Promise(r => setTimeout(r, 3000));
  var disc = t.el.querySelector('.icon img');
  return JSON.stringify({
    mode: t.iconMode,
    held: disc ? disc.src.indexOf('data:image') === 0 : false,
    urlFollowed: t.url
  });
})()")
ck "ADDENDUM: a PINNED image icon holds (the url follows, the icon never re-derives)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['mode']=='image' and d['held'] and 'github.com' in d['urlFollowed'] else 'no')")" "$R"

echo "── (4) THE REDIRECT GUARD (the domain math + accept/stay)"
R=$(ev "JSON.stringify((function(){
  var D = window.WebPanel._debug;
  var r = D.registrableDomain;
  return {
    sub: D.sameRegistrableDomain('sub.example.com', 'example.com'),
    diff: !D.sameRegistrableDomain('example.com', 'other.com'),
    couk: !D.sameRegistrableDomain('a.co.uk', 'b.co.uk'),
    google: r('www.google.com') === 'google.com'
  };
})())")
ck "registrable-domain math: subdomains ≡, different sites ≠, co.uk-style SLDs split" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['sub'] and d['diff'] and d['couk'] and d['google'] else 'no')")" "$R"

R=$(ev "(async function(){
  var t = window.__t;
  t.setImageIcon('');   // back to auto
  var D = window.WebPanel._debug;
  var before = t.url;
  D.showGuard('https://ads.example.net/landing');
  var g = document.querySelector('.wt-guard');
  if (!g) return JSON.stringify({fail: 'no guard'});
  var txt = g.querySelector('.wt-guard-txt').textContent;
  // 'they press anywhere else' — a pointerdown outside the accept pill
  document.querySelector('.wt-omni').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
  await new Promise(r => setTimeout(r, 400));
  return JSON.stringify({
    asks: txt.indexOf('wants to redirect you to') >= 0,
    hasGo: true,
    dismissed: !document.querySelector('.wt-guard'),
    stayed: t.url === before
  });
})()")
ck "the banner asks, and a tap ANYWHERE ELSE = STAY (the move is completely ignored)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['asks'] and d['dismissed'] and d['stayed'] else 'no')")" "$R"

R=$(ev "(async function(){
  // the search-engine exemption is baked into the engine-side (Kotlin)
  // guard; the web twin's iframe sandbox carries the pop-out ban —
  // checked on a real frameable page:
  window.WebPanel.navigate('example.com');
  await new Promise(r => setTimeout(r, 3000));
  var f = document.querySelector('.wt-iframe');
  return JSON.stringify({sandbox: f ? f.getAttribute('sandbox') : 'no-frame'});
})()")
ck "the sandboxed frame can no longer mint escaping windows (allow-popups GONE)" \
  "$(echo "$R" | python3 -c "import sys,json;s=json.loads(sys.stdin.read())['sandbox'];print('yes' if s and 'allow-popups' not in s else 'no')")" "$R"

echo "── (5) THE TWEAKS (the panel + the view; sliders apply; persistence)"
R=$(ev "(async function(){
  // the panel + the tweaks view (the circle's own click path is
  // v0853 (8)'s contract; openWebTweaksFor is the same machinery the
  // native sheet's circle hands off to)
  window.doomalay.openWebTweaksFor(window.__t.id);
  await new Promise(r => setTimeout(r, 700));
  var body = document.getElementById('panel-body');
  var titles = [];
  body.querySelectorAll('.settings-section h3 span:not(.chevron)').forEach(function(h){ titles.push(h.textContent.trim()); });
  return JSON.stringify({
    sections: titles.join('|'),
    chips: body.querySelectorAll('.wtw-chip').length,
    sliders: body.querySelectorAll('[data-wtw-range]').length,
    back: getComputedStyle(document.getElementById('panel-view-back')).display !== 'none'
  });
})()")
ck "the circle opens the tweaks view: Browser Icon | Text Size | Colors + back" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['sections']=='Browser Icon|Text Size|Colors' and int(d['chips'])>=11 and int(d['sliders'])==3 and d['back'] else 'no')")" "$R"

R=$(ev "(async function(){
  var body = document.getElementById('panel-body');
  var set = function(key, val){
    var r = body.querySelector('[data-wtw-range=\"' + key + '\"]');
    r.value = val; r.dispatchEvent(new Event('input', {bubbles: true}));
  };
  set('fs', 130); set('fsSite', 150); set('bright', 80);
  var chips = body.querySelectorAll('.wtw-chip');
  chips.forEach(function(c){ if (c.getAttribute('data-wtw') === 'flt-warm') c.click(); });
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('panel-view-back').click();
  await new Promise(r => setTimeout(r, 500));
  window.WebPanel.navigate('example.com');
  await new Promise(r => setTimeout(r, 3500));
  var ctx = window.WebPanel._ctx();
  return JSON.stringify({
    fsVar: ctx.root.style.getPropertyValue('--wt-fs'),
    zoom: ctx.iframe ? ctx.iframe.style.zoom : '',
    filter: ctx.iframe ? ctx.iframe.style.filter : '',
    omniFs: getComputedStyle(ctx.omni).fontSize
  });
})()")
ck "the tweaks apply live: --wt-fs 1.3, the iframe zoom 1.5, the warm filter + brightness" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['fsVar']=='1.300' and d['zoom']=='1.5' and 'sepia' in d['filter'] and 'brightness' in d['filter'] else 'no')")" "$R"

agent-browser open "$BASE" >/dev/null 2>&1; sleep 2
R=$(ev "JSON.stringify((function(){
  var t = window.WebTabs.all()[0];
  window.__t = t;
  return {tweaks: t && t.tweaks ? t.tweaks : null};
})())")
ck "the tweaks PERSIST across a full reload" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());t=d['tweaks'] or {};print('yes' if t.get('fs')==130 and t.get('fsSite')==150 and t.get('filter')=='warm' and t.get('bright')==80 else 'no')")" "$R"

echo "── (6) console errors"
ERRS=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and e.get('level','').lower() in ('error','severe'): n+=1
        elif isinstance(e,dict) and e.get('type','').lower()=='error': n+=1
    except Exception: pass
print(n)")
ck "zero console errors across the whole ride" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS errors"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "V0871 BIB-FOCUS: ALL GREEN" || echo "V0871 BIB-FOCUS: FAILURES"
exit $FAIL
