#!/bin/bash
# v0640-native-panel-test.sh — RED-TEAM the v0.64.0 NATIVE PANEL BROWSER
# (PLAN-V0640).
#
# USER SPEC: "If we can somehow render the native WebView into a
# scrollable snapable panel, a feature or push that is solely reserved
# for the APK versions and other versions that support it.. let's do so
# it's worth it… The panel browser feature is meant for apk and phones
# only. For desktops, we should not hesitate to redirect users… only if
# we are able to get it to load as much pages as our browser in browser,
# cause currently with iframes many websites are blocked."
#
# THE DESIGN UNDER TEST: the iframe dock is RETIRED (X-Frame-Options /
# CSP frame-ancestors are engine-enforced on iframes — no JS can lift a
# third party's frame guards; that's why it could never load what the
# browser-in-browser loads). In its place:
#   - the APK (any shell with __doomalayKotlin.openPanel) docks a
#     NATIVE WebView bottom sheet over the untouched SPA — same
#     top-level engine as the full-screen browser-in-browser, so it
#     loads EVERY page by construction (PanelBrowserSheet.kt);
#   - every other surface (desktop, HF Space, self-host, phone
#     browsers, pre-v0.64 APKs) redirects IMMEDIATELY to the
#     browser-in-browser (popup → tab / the full-screen viewer) —
#     "no hesitation", no iframe, no embeddability detection.
#
# This suite drives the REAL app (engine + headless browser) and asserts:
#   - THE DESKTOP CONTRACT: a link tap fires the popup tier, renders NO
#     dock (no .panel-browser, no pb-frame, panel header intact, no
#     lv-card in the transcript) and makes ZERO /api/preview verdict
#     round-trips (the redirect is instant)
#   - THE NATIVE CONTRACT: with a bridge carrying openPanel, the tap
#     calls openPanel(url, {theme snapshot}) — six live CSS-var keys,
#     the accent matching the running theme — renders NOTHING in the
#     DOM, never touches window.open, and open() returns 'native-panel'
#   - the state getters: isOpen/currentURL/close consult the bridge
#     (panelOpen/panelUrl/panelClose) — the native sheet owns the state
#   - the v0.62.3 contract SURVIVES: getkey/hostile ride the fallback
#     tiers SYNCHRONOUSLY (openInApp + hostile flag), never openPanel
#     [v0.67.3 REBASE: getkey/hostile now ride openPanel — the BIB era;
#     the fallback tiers are the bridge-less and pre-v0.64 surfaces]
#   - the PRE-v0.64 APK degrades: a bridge with openInApp only → the
#     full-screen viewer (fallback), still no iframe dock anywhere
#   - the bridge hiccup: an openPanel that throws falls to the fallback
#   - external() = the ⧉ box+arrow tiers (openExternal), verbatim
#   - the DEAD DOM is gone: no #pb-* elements, no buttons in the handle
#     strip, no .pb-* CSS rules, __pbIcons retired
#   - panel sanity: the view stack still pushes/pops; handleBack closes
#     the open panel (the browser back is the NATIVE sheet's business)
#   - carried from v0636: the self-host pill GLOWS in the theme color;
#     the YouTube card plays IN PLACE and ↗ rides external; the app tab
#     NEVER navigates; theme discipline; zero console errors
set -u
DATA=/tmp/doomalay-v0640
PORT=8240
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0640
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0640-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
# the v0.63.5 lesson: a stale engine from an older session can OWN the
# port and every assertion would test yesterday's binary.
if grep -q "address already in use" /tmp/v0640-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.64.0 native panel red team: ABORTED (stale port) ══"
  exit 1
fi

# ── a real session + a real panel (the v40 recipe) ─────────────────────
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Panel Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Panel Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5

PANEL=$(ev "document.getElementById('chat-panel').classList.contains('open') && document.getElementById('chat-messages') ? 'open' : 'no-panel'")
check "$PANEL" "open" "the chat panel opened (seeded icon tap)"

# stubs: a window.open recorder (returns a fake window = popup allowed),
# a /api/preview fetch recorder, and the native bridge factory.
ev "(function(){
  window.__winOpen = [];
  window.__origOpen = window.open;
  window.open = function(u){ window.__winOpen.push(String(u)); return {close:function(){}}; };
  window.__previews = [];
  window.__origFetch = window.fetch;
  window.fetch = function(u){
    if (String(u).indexOf('/api/preview') >= 0) window.__previews.push(String(u));
    return window.__origFetch.apply(this, arguments);
  };
  window.__calls = [];
  window.__mkNative = function(o){
    o = o || {};
    return {
      openInApp: function(u,x){ window.__calls.push({m:'openInApp',u:u,o:JSON.parse(x)}); },
      openExternal: function(u){ window.__calls.push({m:'openExternal',u:u}); },
      openPanel: o.throwPanel ? function(){ throw new Error('bridge dead'); } :
        function(u,x){ window.__calls.push({m:'openPanel',u:u,o:JSON.parse(x)}); },
      panelClose: function(){ window.__calls.push({m:'panelClose'}); },
      panelOpen: function(){ return true; },
      panelUrl: function(){ return 'https://example.com/'; }
    };
  };
  return 'stubs';
})()" >/dev/null
ok "window.open + fetch + bridge stubs installed"

# the transcript message with the three link kinds
ev "(function(){
  var root = document.getElementById('chat-messages');
  var holder = document.createElement('div');
  holder.id = 'v0640-msg';
  root.appendChild(holder);
  window.Formatter.renderInto(holder,
    'see [a page](https://example.com/), [the console](https://openrouter.ai/keys) and a video https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'full', {});
  return 'rendered';
})()" >/dev/null

# ── 1. THE DESKTOP CONTRACT: no bridge → the instant redirect ─────────
# (NO __doomalayKotlin installed — the desktop / HF Space / self-host /
# phone-browser / pre-v0.64 reality)
ev "delete window.__doomalayKotlin; window.__winOpen = []; window.__previews = []; 'clean'" >/dev/null
TIER=$(ev "window.InAppBrowser.open('https://example.com/')")
check "$TIER" "popup" "open() on a bridge-less surface → the POPUP tier (no hesitation)"
ev "var a = [].filter.call(document.querySelectorAll('#v0640-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]; a && a.click(); 'tapped'" >/dev/null
sleep 1.2
DESK=$(ev "(function(){
  var p = document.getElementById('chat-panel');
  var hdr = getComputedStyle(document.querySelector('#chat-panel .panel-header')).display;
  return JSON.stringify({
    popup: window.__winOpen[window.__winOpen.length-1] || 'none',
    previews: window.__previews.length,
    browserCls: p.classList.contains('panel-browser'),
    frame: !!document.getElementById('pb-frame'),
    headerOk: hdr !== 'none',
    card: !!document.querySelector('#v0640-msg .lv-card'),
    stillOpen: p.classList.contains('open')
  });
})()")
has "$DESK" '"popup":"https://example.com/"' "the tap fires the popup tier with the URL (a real browser window loads it)"
has "$DESK" '"previews":0' "ZERO /api/preview verdict round-trips (no embeddability detection anymore)"
has "$DESK" '"browserCls":false' "no .panel-browser dock class (the iframe dock is retired)"
has "$DESK" '"frame":false' "no iframe rendered anywhere"
has "$DESK" '"headerOk":true' "the panel header stays the chat chrome (the strip never becomes a toolbar)"
has "$DESK" '"card":false' "no lv-card in the transcript — the tap IS the open"
has "$DESK" '"stillOpen":true' "the chat panel itself never moved"

# the popup-blocked degradation: window.open → null keeps its 'tab' tier
PB=$(ev "(function(){ var o = window.open; window.open = function(){ return null; }; var t = window.InAppBrowser.open('https://example.com/x'); window.open = o; return t; })()")
check "$PB" "tab" "a popup-blocked desktop degrades to the 'tab' tier (never crashes, never docks)"

# ── 2. THE NATIVE CONTRACT: openPanel on the bridge → the sheet ──────
ev "window.__doomalayKotlin = window.__mkNative(); window.__calls = []; window.__winOpen = []; 'native-bridge'" >/dev/null
NRET=$(ev "window.InAppBrowser.open('https://example.org/native')")
check "$NRET" "native-panel" "open() with a v0.64 bridge → 'native-panel'"
ev "var a = [].filter.call(document.querySelectorAll('#v0640-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]; a && a.click(); 'tapped'" >/dev/null
sleep 0.8
NATIVE=$(ev "(function(){
  var c = window.__calls[window.__calls.length-1] || {};   // the TAP's entry (the direct probe above was calls[0])
  var t = c.o && c.o.theme || {};
  var live = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return JSON.stringify({
    method: c.m || 'none', url: c.u || 'none',
    keys: ['accent','bgPanel','surface','text1','text3','border'].filter(function(k){ return !t[k]; }),
    accentLive: t.accent === live,
    winOpen: window.__winOpen.length,
    browserCls: document.getElementById('chat-panel').classList.contains('panel-browser'),
    frame: !!document.getElementById('pb-frame')
  });
})()")
has "$NATIVE" '"method":"openPanel"' "the tap calls __doomalayKotlin.openPanel (the native sheet docks)"
has "$NATIVE" '"url":"https://example.com/"' "openPanel carries the tapped URL"
has "$NATIVE" '"keys":[]' "the theme payload carries all six live CSS-var keys (nothing hardcoded in Kotlin)"
has "$NATIVE" '"accentLive":true' "the payload accent MATCHES the running theme's accent"
has "$NATIVE" '"winOpen":0' "the native path NEVER touches window.open (no redirect on the APK)"
has "$NATIVE" '"browserCls":false' "the SPA renders NOTHING for the page (no dock class)"
has "$NATIVE" '"frame":false' "no iframe — the page lives in the native WebView"

# the state getters consult the bridge (the native sheet owns the state)
STATE=$(ev "(function(){
  window.__calls = [];
  var open = window.InAppBrowser.isOpen();
  var url = window.InAppBrowser.currentURL();
  var closed = window.InAppBrowser.close();
  var pc = window.__calls[0] || {};
  return JSON.stringify({open: open, url: url, closed: closed, call: pc.m || 'none'});
})()")
has "$STATE" '"open":true' "isOpen() reads the bridge's panelOpen (native state)"
has "$STATE" '"url":"https://example.com/"' "currentURL() reads the bridge's panelUrl"
has "$STATE" '"closed":true' "close() rides the bridge's panelClose"
has "$STATE" '"call":"panelClose"' "close() actually reached the native layer"

# ── 3. the v0.67.3 CONTRACT (getkey/hostile ride the BIB panel) ─────
# [v0.67.3 REBASE: the BIB is a real top-level native WebView — it loads
# every page a regular browser can, so getkey and hostile URLs ride
# openPanel when the bridge exists (the user's "all redirects use the
# BIB panel" mandate); hostile rides on as metadata for the sheet]
K1=$(ev "window.__calls = []; var t = window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); var c = window.__calls[0]; JSON.stringify({tier:t, m:c.m, hostile:c.o.hostile, purpose:c.o.purpose})")
has "$K1" '"tier":"native-panel"' "getkey rides the NATIVE PANEL synchronously (the v0.67.3 BIB mandate)"
has "$K1" '"m":"openPanel"' "getkey rides openPanel — the BIB era (never the fallback viewer)"
has "$K1" '"hostile":false' "getkey passes hostile:false"
K2=$(ev "window.__calls = []; window.InAppBrowser.open('https://opencode.ai/auth', {purpose:'getkey', hostile:true}); var c = window.__calls[0]; c.m + ' hostile=' + c.o.hostile")
has "$K2" 'openPanel hostile=true' "the webview-hostile provider rides the panel with hostile:true (metadata)"

# ── 4. the PRE-v0.64 APK: openInApp only → the full-screen viewer ────
OLD=$(ev "(function(){
  var b = window.__mkNative();
  delete b.openPanel; delete b.panelClose; delete b.panelOpen; delete b.panelUrl;
  window.__doomalayKotlin = b;
  window.__calls = []; window.__winOpen = [];
  var t = window.InAppBrowser.open('https://example.net/');
  var c = window.__calls[0] || {};
  return JSON.stringify({tier:t, m:c.m, u:c.u, winOpen: window.__winOpen.length, frame: !!document.getElementById('pb-frame')});
})()")
has "$OLD" '"tier":"apk-viewer"' "an old-APK bridge (no openPanel) degrades to the full-screen viewer"
has "$OLD" '"u":"https://example.net/"' "the old-APK fallback carries the URL"
has "$OLD" '"winOpen":0' "no popup on an APK surface (the bridge tier always wins first)"
has "$OLD" '"frame":false' "still no iframe dock — the old surfaces never dock either"

# ── 5. the bridge hiccup: openPanel throws → the fallback catches ────
HIC=$(ev "(function(){
  window.__doomalayKotlin = window.__mkNative({throwPanel:true});
  window.__calls = [];
  var t = window.InAppBrowser.open('https://example.com/rescue');
  var c = window.__calls[0] || {};
  return JSON.stringify({tier:t, m:c.m, u:c.u});
})()")
has "$HIC" '"m":"openInApp"' "a dead openPanel falls to openInApp (the link still opens)"
has "$HIC" '"u":"https://example.com/rescue"' "the rescue carries the same URL"
ev "window.__doomalayKotlin = window.__mkNative(); window.__calls = []; 'native-restored'" >/dev/null

# ── 6. external(): the ⧉ box+arrow tiers, verbatim ────────────────────
EXT=$(ev "var t = window.InAppBrowser.external('https://example.com/leave'); var c = window.__calls[0]; t + ' ' + (c ? c.m + ' ' + c.u : 'none')")
check "$EXT" "apk-external openExternal https://example.com/leave" "external() rides openExternal (the box+arrow semantics)"

# ── 7. THE DEAD DOM IS GONE ───────────────────────────────────────────
DEAD=$(ev "(function(){
  var h = document.getElementById('panel-handle');
  return JSON.stringify({
    pill: !!document.getElementById('pb-pill'),
    frame: !!document.getElementById('pb-frame'),
    buttons: h ? h.querySelectorAll('button').length : -1,
    bar: !!document.querySelector('#panel-handle .handle-bar'),
    icons: typeof window.__pbIcons
  });
})()")
has "$DEAD" '"pill":false' "no #pb-pill element (the pill lives in the native sheet now)"
has "$DEAD" '"frame":false' "no #pb-frame element"
has "$DEAD" '"buttons":0' "the handle strip carries ZERO buttons (just the dash)"
has "$DEAD" '"bar":true' "the dash handle-bar survives (the panel's own drag handle)"
check "$(echo "$DEAD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["icons"])' 2>/dev/null)" "undefined" "the __pbIcons export is retired (linkviewer's inline glyph covers it)"

# ── 8. panel sanity: the view stack + handleBack ─────────────────────
VIEWS=$(ev "(function(){
  var p = window.ChatPanel.current().panel;
  p.pushView({title:'v0640', render:function(){return '<div id=\"v0640-view\">VIEW</div>';}});
  var pushed = !!document.getElementById('v0640-view');
  p.popView();
  return JSON.stringify({pushed: pushed, popped: !document.getElementById('v0640-view'),
    headerVisible: getComputedStyle(document.querySelector('#chat-panel .panel-header')).display !== 'none'});
})()")
has "$VIEWS" '"pushed":true' "ordinary panel views still stack (pv-mode intact)"
has "$VIEWS" '"popped":true' "popView restores the chat root"
has "$VIEWS" '"headerVisible":true' "the header chrome survived the round-trip"
HB=$(ev "(function(){ var r = window.doomalay.handleBack(); return JSON.stringify({back: r, closed: !document.getElementById('chat-panel').classList.contains('open')}); })()")
has "$HB" '"back":true' "handleBack closes the open panel (no InAppBrowser middleman — back is native)"
has "$HB" '"closed":true' "the panel actually closed"
ev "window.ChatPanel.current().open(); 'reopened'" >/dev/null; sleep 0.5

# ── 9. THE SELF-HOST PILL GLOWS in the theme color (carried v0636) ──
ev "window.Workspace.openPicker('$SID'); 'picker'" >/dev/null
sleep 2.5
ev "var b = document.getElementById('wsx-connect'); b ? (b.click(), 'connect-page') : 'no-connect'" >/dev/null
sleep 1.2
ev "var p = [].filter.call(document.querySelectorAll('.wsp-pill'), function(x){return x.getAttribute('data-k')==='selfhost';})[0]; p && p.click(); 'selfhost'" >/dev/null
sleep 0.8
GLOW=$(ev "(function(){
  var p = [].filter.call(document.querySelectorAll('.wsp-pill'), function(x){return x.getAttribute('data-k')==='selfhost';})[0];
  if (!p) return 'no-pill';
  var cs = getComputedStyle(p);
  var sh = cs.boxShadow;
  var acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  var m = acc.match(/^#([0-9a-f]{6})$/i), rgb = null;
  if (m) rgb = [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
  else { var n = acc.match(/(\d+)\D+(\d+)\D+(\d+)/); if (n) rgb = [+n[1], +n[2], +n[3]]; }
  var g = sh && sh !== 'none' ? sh.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/) : null;
  var match = !!(rgb && g && +g[1] === rgb[0] && +g[2] === rgb[1] && +g[3] === rgb[2]);
  return JSON.stringify({selected: p.getAttribute('data-on'), glow: sh !== 'none' && !!sh, matches: match, acc: acc});
})()")
has "$GLOW" '"selected":"1"' "the self-host pill is the selected one"
has "$GLOW" '"glow":true' "the selected self-host pill GLOWS (box-shadow on)"
has "$GLOW" '"matches":true' "the glow is the THEME accent color (not neutral, not none)"
ev "window.ConnectOverlay.close(); 'closed'" >/dev/null; sleep 0.6

# ── 10. the YouTube card still plays IN PLACE; ↗ = external ──────────
ev "window.__yt = document.querySelector('#v0640-msg .fmt-yt'); window.__yt ? window.__yt.click() : 'no-card'; 'clicked'" >/dev/null
sleep 1.5
YTIP=$(ev "(function(){
  var f = document.querySelector('#v0640-msg .fmt-yt iframe');
  var cap = document.querySelector('#v0640-msg .fmt-yt-open');
  return JSON.stringify({frame: f ? f.src : 'none', cap: !!cap, dock: window.InAppBrowser.isOpen()});
})()")
has "$YTIP" 'youtube-nocookie.com/embed/dQw4w9WgXcQ' "the YT card still plays IN PLACE (never docks)"
has "$YTIP" '"cap":true' "the ↗ caption affordance exists"
has "$YTIP" '"dock":true' "isOpen() mirrors the native sheet (the bridge getter — the YT card itself docked nothing)"
ev "window.__calls = []; var e = document.querySelector('#v0640-msg .fmt-yt-open'); e && e.click(); 'ext'" >/dev/null
sleep 0.4
YTEXT=$(ev "var c = window.__calls[0]; c ? c.m + ' ' + c.u : 'none'")
has "$YTEXT" 'openExternal https://www.youtube.com/watch?v=dQw4w9WgXcQ' "the YT ↗ caption rides external (the box+arrow tiers)"

# ── 11. the app tab NEVER navigated ───────────────────────────────────
LOC=$(ev "location.href")
case "$LOC" in "$BASE"|"$BASE/"|"$BASE/#"*) ok "the app tab never navigated (still $LOC)";; *) bad "the app navigated away: $LOC";; esac

# ── 12. theme discipline: no .pb-* rules exist; wsp-pill vars-only ──
THEME=$(ev "
(function(){
  var bad = [];
  var sawPb = 0;
  for (var i = 0; i < document.styleSheets.length; i++) {
    var s = document.styleSheets[i];
    try {
      for (var j = 0; j < s.cssRules.length; j++) {
        var r = s.cssRules[j];
        if (!r.selectorText) continue;
        if (r.selectorText.indexOf('.pb-') >= 0 || r.selectorText.indexOf('panel-browser') >= 0) sawPb++;
        if (r.selectorText.indexOf('.wsp-pill') >= 0) {
          var hexes = (r.style && r.style.cssText || '').match(/#[0-9a-f]{3,8}\b/gi) || [];
          for (var h = 0; h < hexes.length; h++) bad.push(r.selectorText + ':' + hexes[h]);
        }
      }
    } catch (e) {}
  }
  return JSON.stringify({pbRules: sawPb, hard: bad.length === 0 ? 'none' : bad.slice(0,3).join(',')});
})()")
has "$THEME" '"pbRules":0' "the retired .pb-* / .panel-browser CSS rules are GONE from the stylesheet"
has "$THEME" '"hard":"none"' "the .wsp-pill chrome still hardcodes no colors (theme vars only)"

# ── 13. no JS errors crept in ─────────────────────────────────────────
ERRS=$(agent-browser errors 2>/dev/null | grep -v "Failed to load resource" | head -5)
if [ -z "$ERRS" ]; then ok "no console errors through the whole flow"; else bad "console errors: $ERRS"; fi

echo ""
echo "══ v0.64.0 native panel red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
