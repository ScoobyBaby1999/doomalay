#!/bin/bash
# v0634-panel-browser-test.sh — RED-TEAM the v0.63.4 PANEL BROWSER.
#
# The user spec: "instead of the full screen thing, we have the BROWSER
# IN BROWSER itself be in the PANEL! so that the user can DOCK the
# browser itself and move it between the full and half screen position…
# the link left of the dash in a pill box (tap = copy, ↻ inside refreshes)
# … right of the dash: back / open-in-website-app (box+arrow) / X."
#
# This suite drives the REAL app (seeded chat → panel open) and asserts:
#   - the frameable lv-card gains the ⤢ open → THE DOCK docks in the
#     panel (strip chrome on, header yields, iframe fills the body)
#   - the strip geometry: pill LEFT of the dash, acts RIGHT, the dash
#     still dead-center (grid 1fr auto 1fr), the strip grew, and
#     gesture.js's --panel-vis-h REMEASURED (smaller window, no gap)
#   - the pill copies the link (clipboard + toast); ↻ rebuilds the frame
#   - the nav stack: open A → open B (a YouTube watch URL docks the
#     NOCOOKIE EMBED while the pill keeps the ORIGINAL link) → ‹ back
#   - ✕ / Escape close the dock and restore the chat root untouched
#   - v0.63.6: a frame-blocked page AUTO-ROUTES — the dock hands the
#     URL to the FULL-SCREEN browser-in-browser (bridge viewer) and
#     closes itself; the panel browser only ever opens for pages it
#     can display (the og-card era is over)
#   - the ⧉ box+arrow → bridge openExternal (ACTION_VIEW on device)
#   - the v0.62.3 contract SURVIVES: getkey/hostile ride fallback()
#     synchronously; the lv-card's open rides fallback too
#   - theme discipline: the .pb-* rules hardcode no colors
set -u
DATA=/tmp/doomalay-v0634
PORT=8197
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0634
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0634-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# ── a real session + a real panel (the v40 recipe) ─────────────────────
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Dock Bot","sandbox":"quick","model":"nvidia/mock/alive-a","provider":"nvidia"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 1.5
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,currentFamily:'nvidia',icons:[{id:'f1',type:'chat',name:'Dock Bot',family:'nvidia',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'nvidia/mock/alive-a',provider:'nvidia',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 1.5
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3.5

PANEL=$(ev "document.getElementById('chat-panel').classList.contains('open') && document.getElementById('chat-messages') ? 'open' : 'no-panel'")
check "$PANEL" "open" "the chat panel opened (seeded icon tap)"

# stubs: clipboard + the Kotlin bridge (openInApp + openExternal)
ev "(function(){
  window.__clip = [];
  if (navigator.clipboard) navigator.clipboard.writeText = function(t){ window.__clip.push(t); return Promise.resolve(); };
  window.__bridge = [];
  window.__doomalayKotlin = {
    openInApp: function(u,o){ window.__bridge.push({m:'openInApp',u:u,o:JSON.parse(o)}); },
    openExternal: function(u){ window.__bridge.push({m:'openExternal',u:u}); }
  };
  return 'stubbed';
})()" >/dev/null
ok "clipboard + bridge stubs installed"

# the v2 surface
SURF=$(ev "['open','fallback','external','back','canBack','close','isOpen','currentURL'].every(function(k){return typeof window.InAppBrowser[k]==='function'}) ? 'v2' : 'old'")
check "$SURF" "v2" "InAppBrowser v2 surface (open/fallback/external/back/canBack/close/isOpen/currentURL)"

# ── 1. THE TAP IS THE OPEN (v0.63.5+): the frameable tap docks the ─────
# panel browser directly — no inline card anymore (the card painter
# stays exported as the degenerate path; section 10 drives it directly)
ev "(function(){
  var root = document.getElementById('chat-messages');
  var holder = document.createElement('div');
  holder.id = 'v0634-msg';
  root.appendChild(holder);
  window.Formatter.renderInto(holder,
    'see [a frameable page](https://example.com/) and [the console](https://openrouter.ai/keys/)',
    'full', {});
  return 'rendered';
})()" >/dev/null
# the pre-dock window height (for the remeasure comparison)
VIS0=$(ev "parseFloat(getComputedStyle(document.getElementById('chat-panel')).getPropertyValue('--panel-vis-h'))||0" | cut -d. -f1)
ev "var a = [].filter.call(document.querySelectorAll('#v0634-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]; a && a.click(); 'tapped'" >/dev/null
sleep 4
CARD=$(ev "var c = document.querySelector('#v0634-msg .lv-card'); JSON.stringify({nocard: !c, dockopen: window.InAppBrowser.isOpen(), pill: document.getElementById('pb-url') ? document.getElementById('pb-url').textContent : 'none'})")
has "$CARD" '"nocard":true' "the frameable tap docks THE DOCK directly (v0.63.5: the tap IS the open — no inline card)"
has "$CARD" '"dockopen":true' "the dock is open from the tap"
has "$CARD" '"pill":"https://example.com/"' "the pill shows the tapped link"

# the dock button era is over — nothing to click, the dock is already up

DOCK=$(ev "(function(){
  var p = document.getElementById('chat-panel');
  var hdr = getComputedStyle(document.querySelector('#chat-panel .panel-header')).display;
  var pill = document.getElementById('pb-url');
  var fr = document.getElementById('pb-frame');
  return JSON.stringify({
    cls: p.classList.contains('panel-browser'),
    header: hdr,
    pill: pill ? pill.textContent : 'none',
    frame: fr ? fr.src : 'none',
    isopen: window.InAppBrowser.isOpen()
  });
})()")
has "$DOCK" '"cls":true' "the dock lights .panel-browser on the sheet"
has "$DOCK" '"header":"none"' "the panel header yields (the strip IS the chrome)"
has "$DOCK" '"pill":"https://example.com/"' "the pill shows the link"
has "$DOCK" 'example.com' "the iframe is loading the page"
has "$DOCK" '"isopen":true' "InAppBrowser.isOpen() reports the dock"

# ── 2. strip geometry: pill LEFT of dash, acts RIGHT, dash centered ────
GEO=$(ev "(function(){
  var bar = document.querySelector('#chat-panel .handle-bar').getBoundingClientRect();
  var pill = document.getElementById('pb-pill').getBoundingClientRect();
  var acts = document.getElementById('pb-acts').getBoundingClientRect();
  var panel = document.getElementById('chat-panel').getBoundingClientRect();
  var strip = document.getElementById('panel-handle').getBoundingClientRect();
  var barCx = bar.left + bar.width/2, panelCx = panel.left + panel.width/2;
  return JSON.stringify({
    pillLeft: pill.right <= bar.left + 1,
    actsRight: acts.left >= bar.right - 1,
    dashCenter: Math.abs(barCx - panelCx) <= 6,
    stripH: Math.round(strip.height),
    pillVisible: pill.width > 40
  });
})()")
has "$GEO" '"pillLeft":true' "the pill sits LEFT of the dash"
has "$GEO" '"actsRight":true' "the three acts sit RIGHT of the dash"
has "$GEO" '"dashCenter":true' "the dash stays dead-center (grid 1fr auto 1fr)"
has "$GEO" '"pillVisible":true' "the pill is visible (not crushed)"
STRIPH=$(ev "Math.round(document.getElementById('panel-handle').getBoundingClientRect().height)" | tr -d '"')
if [ "${STRIPH:-0}" -ge 36 ] 2>/dev/null; then ok "the strip grew for the toolbar (${STRIPH}px)"; else bad "the strip grew (got ${STRIPH}px)"; fi

# ── 3. gesture.js REMEASURED the window (taller chrome → smaller vis) ──
VIS1=$(ev "parseFloat(getComputedStyle(document.getElementById('chat-panel')).getPropertyValue('--panel-vis-h'))||0" | cut -d. -f1)
BODYH=$(ev "Math.round(document.getElementById('panel-body').getBoundingClientRect().height)" | tr -d '"')
# the header yields (~57px) more than the strip grows (~26px), so the
# visible window GROWS — the page gets the header's space. What must NOT
# happen is a stale vis (gap at the bottom) — the body-match below pins it.
if [ "${VIS1:-0}" -gt "${VIS0:-0}" ] 2>/dev/null; then
  ok "remeasure: --panel-vis-h re-derived with the toolbar (${VIS0}→${VIS1}px — the header's space went to the page)"
else
  bad "remeasure: vis ${VIS0}→${VIS1} (expected to grow while docked)"
fi
if [ "${BODYH:-0}" -ge "$((VIS1 - 2))" ] 2>/dev/null; then ok "the body window matches --panel-vis-h (${BODYH}px)"; else bad "body ${BODYH}px vs vis ${VIS1}px"; fi

# ── 4. the pill COPIES; ↻ rebuilds ─────────────────────────────────────
ev "document.getElementById('pb-pill').click(); 'copy'" >/dev/null
sleep 0.4
COPY=$(ev "(function(){
  var t = document.querySelector('.pb-toast');
  return JSON.stringify({copied: window.__clip[window.__clip.length-1], toast: t ? t.classList.contains('show') : false, msg: t ? t.textContent : ''});
})()")
has "$COPY" '"copied":"https://example.com/"' "tapping the pill copies the link"
has "$COPY" '"toast":true' "the copy toast appears"
has "$COPY" '"msg":"link copied"' "the toast says link copied"

ev "window.__frameMark = document.getElementById('pb-frame'); document.getElementById('pb-refresh').click(); 'refreshed'" >/dev/null
sleep 0.6
REFR=$(ev "(function(){
  var f = document.getElementById('pb-frame');
  return JSON.stringify({rebuilt: f !== window.__frameMark, src: f ? f.src : 'gone'});
})()")
has "$REFR" '"rebuilt":true' "↻ inside the pill rebuilds the frame (full reload)"
has "$REFR" 'example.com' "the reload points at the same page"

# ── 5. the nav stack: A → B (youtube embed) → ‹ back ────────────────────
YT=$(ev "window.InAppBrowser.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
check "$YT" "panel" "open() docks (returns 'panel', not the old tiers)"
sleep 1.6
YTD=$(ev "(function(){
  var pill = document.getElementById('pb-url').textContent;
  var fr = document.getElementById('pb-frame');
  return JSON.stringify({pill: pill, src: fr ? fr.src : 'none', canBack: window.InAppBrowser.canBack(), dis: document.getElementById('pb-back').hasAttribute('disabled')});
})()")
has "$YTD" '"pill":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"' "the pill keeps the ORIGINAL watch link"
has "$YTD" 'youtube-nocookie.com/embed/dQw4w9WgXcQ' "the frame plays the NOCOOKIE embed (the rewrite)"
has "$YTD" '"canBack":true' "canBack() true with two entries"
has "$YTD" '"dis":false' "the ‹ is enabled"

ev "document.getElementById('pb-back').click(); 'back'" >/dev/null
sleep 0.8
B1=$(ev "(function(){ return JSON.stringify({pill: document.getElementById('pb-url').textContent, cur: window.InAppBrowser.currentURL(), canBack: window.InAppBrowser.canBack()}); })()")
has "$B1" '"cur":"https://example.com/"' "‹ walks back to the first page"
has "$B1" '"canBack":false' "the stack bottom disables ‹"

# ── 6. ✕ closes + the chat root restores untouched ─────────────────────
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null
sleep 0.8
CLOSED=$(ev "(function(){
  var p = document.getElementById('chat-panel');
  var hdr = getComputedStyle(document.querySelector('#chat-panel .panel-header')).display;
  return JSON.stringify({cls: p.classList.contains('panel-browser'), header: hdr, root: !!document.getElementById('chat-messages'), open: window.InAppBrowser.isOpen(), link: !![].filter.call(document.querySelectorAll('#v0634-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]});
})()")
has "$CLOSED" '"cls":false' "✕ drops .panel-browser"
has "$CLOSED" '"header":"flex"' "the panel header returns"
has "$CLOSED" '"root":true' "the chat root is back"
has "$CLOSED" '"open":false' "isOpen() false after ✕"
has "$CLOSED" '"link":true' "the transcript (link + card) survived the round trip"

# ── 7. Escape closes too (the desktop nicety) ───────────────────────────
ev "window.InAppBrowser.open('https://example.com/'); 'reopen'" >/dev/null
sleep 0.6
ev "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'" >/dev/null
sleep 0.6
ESC=$(ev "window.InAppBrowser.isOpen() ? 'still-open' : 'escaped'")
check "$ESC" "escaped" "Escape pops the dock"

# ── 8. v0.63.6: a frame-blocked page AUTO-ROUTES to the full-screen ───
# browser (the og-card era is over — the dock only ever opens for
# pages it can display; blocked taps ride openInApp + the dock closes)
ev "window.__bridge = []; window.InAppBrowser.open('https://openrouter.ai/keys'); 'blocked-dock'" >/dev/null
sleep 4.5
BLK=$(ev "(function(){
  var c = window.__bridge[window.__bridge.length-1];
  return JSON.stringify({m: c ? c.m : 'none', u: c ? c.u : 'none',
    dockopen: window.InAppBrowser.isOpen(), card: !!document.querySelector('.pb-blocked')});
})()")
has "$BLK" '"m":"openInApp"' "the blocked page AUTO-ROUTES to the full-screen browser (no dead frame)"
has "$BLK" '"u":"https://openrouter.ai/keys"' "the viewer gets the exact URL"
has "$BLK" '"dockopen":false' "the dock closed itself (panel browser only opens for displayable pages)"
has "$BLK" '"card":false' "no blocked card — the browser-in-browser IS displayed"

# ── 9. the ⧉ box+arrow → openExternal ───────────────────────────────────
ev "window.InAppBrowser.open('https://example.com/'); 'x'" >/dev/null
sleep 0.6
ev "window.__bridge = []; document.getElementById('pb-ext').click(); 'ext'" >/dev/null
sleep 0.4
EXT=$(ev "var c = window.__bridge[0]; c ? c.m + ' ' + c.u : 'none'")
has "$EXT" 'openExternal https://example.com/' "the ⧉ box+arrow hands off to openExternal (ACTION_VIEW on device)"
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null; sleep 0.6

# ── 10. the v0.62.3 contract SURVIVES ───────────────────────────────────
K1=$(ev "window.__bridge = []; var t = window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); var c = window.__bridge[0]; JSON.stringify({tier:t, m:c.m, hostile:c.o.hostile})")
has "$K1" '"tier":"apk-viewer"' "getkey stays SYNCHRONOUS on the fallback tier"
has "$K1" '"hostile":false' "getkey passes hostile:false"
K2=$(ev "window.__bridge = []; window.InAppBrowser.open('https://opencode.ai/auth', {purpose:'getkey', hostile:true}); var c = window.__bridge[0]; c.m + ' hostile=' + c.o.hostile")
has "$K2" 'openInApp hostile=true' "the webview-hostile provider passes hostile:true"
K3=$(ev "window.__bridge = []; var a = [].filter.call(document.querySelectorAll('#v0634-msg a'), function(x){return x.href.indexOf('openrouter')>=0;})[0]; a && window.LinkViewer.openCard(a, a.href); 'carded'")
sleep 3
K3=$(ev "window.__bridge = []; var b = document.querySelector('#v0634-msg .lv-card'); var o = b && b.querySelector('.lv-open'); o && o.click(); var c = window.__bridge[0]; c ? c.m + ' ' + c.u : 'none'")
has "$K3" 'openInApp https://openrouter.ai/keys' "the degenerate lv-card's open rides fallback directly (openCard stays exported)"

# ── 11. the app tab NEVER navigated ─────────────────────────────────────
LOC=$(ev "location.href")
case "$LOC" in "$BASE"|"$BASE/"|"$BASE/#"*) ok "the app tab never navigated (still $LOC)";; *) bad "the app navigated away: $LOC";; esac

# ── 12. theme discipline: the .pb-* rules hardcode no colors ────────────
THEME=$(ev "
(function(){
  var targets = ['.pb-pill', '.pb-btn', '.pb-toast', '.pb-blocked', '.pb-open', '.pb-loadbar'];
  var bad = [];
  for (var i = 0; i < document.styleSheets.length; i++) {
    var s = document.styleSheets[i];
    try {
      for (var j = 0; j < s.cssRules.length; j++) {
        var r = s.cssRules[j];
        if (!r.selectorText) continue;
        for (var k = 0; k < targets.length; k++) {
          if (r.selectorText.indexOf(targets[k]) >= 0) {
            var hexes = (r.style && r.style.cssText || '').match(/#[0-9a-f]{3,8}\b/gi) || [];
            for (var h = 0; h < hexes.length; h++) bad.push(r.selectorText + ':' + hexes[h]);
          }
        }
      }
    } catch (e) {}
  }
  return bad.length === 0 ? 'vars-only' : 'hardcoded:' + bad.slice(0,4).join(',');
})()")
check "$THEME" "vars-only" "the .pb-* chrome hardcodes no colors (theme vars only)"

# ── 12b. THE DOCK ITSELF: drag the strip full ⇄ half (the user's ask) ──

# headless quirk: CDP sometimes swallows the terminal pointerup over the
# drag strip (a real device/firefox always delivers it) — dispatch it
# deterministically on the handle; gesture.js's end() is idempotent.
pup() { agent-browser eval "(function(){ var el = document.getElementById('panel-handle'); el.dispatchEvent(new PointerEvent('pointerup', {pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true})); 'up'; })()" >/dev/null; }
ev "window.InAppBrowser.open('https://example.com/'); 'x'" >/dev/null
sleep 0.8
DASH=$(ev "var r = document.querySelector('#chat-panel .handle-bar').getBoundingClientRect(); Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)")
DX=$(echo $DASH | cut -d' ' -f1); DY=$(echo $DASH | cut -d' ' -f2)
agent-browser mouse move $DX $DY >/dev/null
agent-browser mouse down >/dev/null
for YY in $((DY-40)) $((DY-90)) $((DY-140)) $((DY-190)); do agent-browser mouse move $DX $YY >/dev/null; sleep 0.06; done
agent-browser mouse up >/dev/null; pup
sleep 0.9
FULL=$(ev "(function(){ var p = document.getElementById('chat-panel'); return JSON.stringify({full: p.classList.contains('panel-full'), frame: !!document.getElementById('pb-frame'), pill: document.getElementById('pb-url').textContent}); })()")
has "$FULL" '"full":true' "dragging the strip UP docks the browser FULL (the sheet gestures ride the toolbar)"
has "$FULL" '"pill":"https://example.com/"' "the dock (pill + frame) survived the drag"

# drag back DOWN to the half position (default) — >10% down from full docks.
# SYNTHETIC pointer events on the handle: with the frame now FILLING the
# panel (the v0.63.6 fix), a CDP mouse drag lands every move over the
# cross-origin iframe — headless routes those to the iframe's process and
# gesture.js never sees them (the up-drag works because its pointer stays
# inside the strip). Real devices are unaffected — touch events never
# retarget and real mice capture in the browser process — so we drive the
# same begin()/move()/end() path directly.
DOWN0=$(ev "(function(){
  var el = document.getElementById('panel-handle');
  var r = document.querySelector('#chat-panel .handle-bar').getBoundingClientRect();
  var y = Math.round(r.top + r.height/2);
  el.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 7, pointerType: 'mouse', clientY: y, bubbles: true, cancelable: true}));
  return 'down-from-' + y;
})()")
YY=$(echo "$DOWN0" | grep -o '[0-9]*$')
for STEP in 1 2 3 4 5; do
  YY=$((YY+60))
  ev "var el = document.getElementById('panel-handle'); el.dispatchEvent(new PointerEvent('pointermove', {pointerId: 7, pointerType: 'mouse', clientY: $YY, bubbles: true, cancelable: true})); 'mv'" >/dev/null
  sleep 0.12
done
ev "var el = document.getElementById('panel-handle'); el.dispatchEvent(new PointerEvent('pointerup', {pointerId: 7, pointerType: 'mouse', clientY: $YY, bubbles: true, cancelable: true})); 'up'" >/dev/null
sleep 0.9
HALF=$(ev "(function(){ var p = document.getElementById('chat-panel'); return JSON.stringify({full: p.classList.contains('panel-full'), open: window.InAppBrowser.isOpen()}); })()")
has "$HALF" '"full":false' "dragging back DOWN re-docks at the half position"
has "$HALF" '"open":true' "the browser stays docked through both snaps"
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null; sleep 0.5

# ── 13. no JS errors crept in ────────────────────────────────────────────
ERRS=$(agent-browser errors 2>/dev/null | grep -v "Failed to load resource" | head -5)
if [ -z "$ERRS" ]; then ok "no console errors through the whole flow"; else bad "console errors: $ERRS"; fi

echo ""
echo "══ v0.63.4 panel-browser red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
