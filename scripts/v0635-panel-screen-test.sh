#!/bin/bash
# v0635-panel-screen-test.sh — RED-TEAM the v0.63.5 PANEL SCREEN.
#
# The user's clarified spec: "instead of having the browser in browser be
# it's own new screen, we have the browser in browser render as the panel
# screen… Opening a link would display it on the panel, so the user may
# have a link open with the panel sitting at half position, see the app
# canvas in the background." + "the refresh button left of the link, the
# link text in an opaque pill that follows themes" + "the self host
# category… doesn't glow in the theme color when selected."
#
# This suite drives the REAL app (seeded chat → panel open) and asserts:
#   - THE TAP IS THE OPEN: a link tap docks THE PANEL BROWSER directly —
#     NO inline lv-card in the transcript, no new screen; the strip is
#     the chrome (pill ↻ left of the link, dash center, ‹ ⧉ ✕ right)
#   - the strip geometry + the gesture remeasure (no gap under the page)
#   - the pill copies (toast); ↻ rebuilds; ‹ walks the nav stack; ✕ and
#     Escape restore the chat root untouched
#   - the frame carries the NO-TOP-NAVIGATION sandbox (html/youtube) and
#     the pdf frame keeps the plain viewer
#   - the frame-buster guard: a rapid same-URL reopen → the blocked card
#     (never a reload spiral)
#   - a blocked page docks to the og-card IN THE PANEL + ⤢ → the
#     fallback tiers (bridge stub); ⧉ → openExternal
#   - the v0.62.3 contract SURVIVES: getkey/hostile ride fallback()
#     synchronously
#   - the YouTube card still plays IN PLACE (the ↗ caption rides
#     external, not window.open)
#   - the SELF-HOST pill glows in the theme color when selected
#   - theme discipline + the drag full ⇄ half with the dock alive
set -u
DATA=/tmp/doomalay-v0635
PORT=8235
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0635
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0635-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"
# v0.63.5 lesson: a leftover engine from an older session can OWN the port
# (bind fails silently, the health check answers from the STALE binary and
# every assertion tests yesterday's code). Guard: our engine MUST own it.
if grep -q "address already in use" /tmp/v0635-eng.log 2>/dev/null; then
  bad "PORT SQUATTER on $PORT — kill the stale engine and rerun"
  echo "══ v0.63.5 panel-screen red team: ABORTED (stale port) ══"
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

# ── 1. THE TAP IS THE OPEN: the link tap docks the panel browser ──────
ev "(function(){
  var root = document.getElementById('chat-messages');
  var holder = document.createElement('div');
  holder.id = 'v0635-msg';
  root.appendChild(holder);
  window.Formatter.renderInto(holder,
    'see [a frameable page](https://example.com/), [the console](https://openrouter.ai/keys) and a video https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'full', {});
  return 'rendered';
})()" >/dev/null
# the pre-dock window height (for the remeasure comparison)
VIS0=$(ev "parseFloat(getComputedStyle(document.getElementById('chat-panel')).getPropertyValue('--panel-vis-h'))||0" | cut -d. -f1)
# THE TAP
ev "var a = [].filter.call(document.querySelectorAll('#v0635-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]; a && a.click(); 'tapped'" >/dev/null
sleep 2.5

DOCK=$(ev "(function(){
  var p = document.getElementById('chat-panel');
  var hdr = getComputedStyle(document.querySelector('#chat-panel .panel-header')).display;
  var pill = document.getElementById('pb-url');
  var fr = document.getElementById('pb-frame');
  var card = document.querySelector('#v0635-msg .lv-card');
  return JSON.stringify({
    cls: p.classList.contains('panel-browser'),
    header: hdr,
    pill: pill ? pill.textContent : 'none',
    frame: fr ? fr.src : 'none',
    isopen: window.InAppBrowser.isOpen(),
    nocard: !card
  });
})()")
has "$DOCK" '"cls":true' "THE TAP DOCKS: .panel-browser lights on the sheet (no new screen)"
has "$DOCK" '"header":"none"' "the panel header yields (the strip IS the chrome)"
has "$DOCK" '"pill":"https://example.com/"' "the pill shows the link (the ↻ sits inside, left of it)"
has "$DOCK" 'example.com' "the iframe is loading the page IN THE PANEL"
has "$DOCK" '"isopen":true' "InAppBrowser.isOpen() reports the dock"
has "$DOCK" '"nocard":true' "NO inline lv-card in the transcript — the tap was the open"

# ── 2. the strip: refresh INSIDE the pill, left of the link ────────────
PILL=$(ev "(function(){
  var pill = document.getElementById('pb-pill');
  var re = document.getElementById('pb-refresh').getBoundingClientRect();
  var url = document.getElementById('pb-url').getBoundingClientRect();
  var cs = getComputedStyle(pill);
  return JSON.stringify({
    order: re.right <= url.left + 1,
    radius: cs.borderRadius,
    opaque: parseFloat(cs.opacity) < 1,
    border: cs.borderColor !== ''
  });
})()")
has "$PILL" '"order":true' "the ↻ refresh sits INSIDE the pill, LEFT of the link text"
has "$PILL" '"radius":"999px"' "the pill is fully rounded"
has "$PILL" '"opaque":true' "the pill is slightly opaque"
has "$PILL" '"border":true' "the pill carries a theme border"

# strip geometry: pill LEFT of dash, acts RIGHT, dash centered
GEO=$(ev "(function(){
  var bar = document.querySelector('#chat-panel .handle-bar').getBoundingClientRect();
  var pill = document.getElementById('pb-pill').getBoundingClientRect();
  var acts = document.getElementById('pb-acts').getBoundingClientRect();
  var panel = document.getElementById('chat-panel').getBoundingClientRect();
  var barCx = bar.left + bar.width/2, panelCx = panel.left + panel.width/2;
  return JSON.stringify({
    pillLeft: pill.right <= bar.left + 1,
    actsRight: acts.left >= bar.right - 1,
    dashCenter: Math.abs(barCx - panelCx) <= 6
  });
})()")
has "$GEO" '"pillLeft":true' "the pill sits LEFT of the dash"
has "$GEO" '"actsRight":true' "the three acts (‹ ⧉ ✕) sit RIGHT of the dash"
has "$GEO" '"dashCenter":true' "the dash stays dead-center (grid 1fr auto 1fr)"

# ── 3. gesture.js REMEASURED the window (taller chrome → no gap) ──────
VIS1=$(ev "parseFloat(getComputedStyle(document.getElementById('chat-panel')).getPropertyValue('--panel-vis-h'))||0" | cut -d. -f1)
BODYH=$(ev "Math.round(document.getElementById('panel-body').getBoundingClientRect().height)" | tr -d '"')
if [ "${VIS1:-0}" -gt "${VIS0:-0}" ] 2>/dev/null; then
  ok "remeasure: --panel-vis-h re-derived with the toolbar (${VIS0}→${VIS1}px — the header's space went to the page)"
else
  bad "remeasure: vis ${VIS0}→${VIS1} (expected to grow while docked)"
fi
if [ "${BODYH:-0}" -ge "$((VIS1 - 2))" ] 2>/dev/null; then ok "the body window matches --panel-vis-h (${BODYH}px)"; else bad "body ${BODYH}px vs vis ${VIS1}px"; fi

# ── 4. the frame's NO-TOP-NAVIGATION sandbox (html) ────────────────────
SBX=$(ev "(function(){
  var f = document.getElementById('pb-frame');
  var sb = f ? (f.getAttribute('sandbox') || '') : 'none';
  var need = ['allow-scripts','allow-forms','allow-popups','allow-same-origin','allow-presentation'];
  var miss = need.filter(function(t){ return sb.indexOf(t) < 0; });
  return JSON.stringify({sb: sb, topnav: sb.indexOf('allow-top-navigation') >= 0, missing: miss});
})()")
has "$SBX" '"missing":[]' "the html frame keeps scripts/forms/popups/same-origin/presentation"
has "$SBX" '"topnav":false' "the frame can NEVER navigate the top window (no allow-top-navigation)"

# a pdf URL keeps the plain frame (the browser's PDF viewer)
ev "window.InAppBrowser.open('https://example.com/sample.pdf'); 'pdf'" >/dev/null
sleep 0.8
PDFSB=$(ev "var f = document.getElementById('pb-frame'); f ? (f.getAttribute('sandbox') || 'none') : 'gone'")
check "$PDFSB" "none" "the pdf frame keeps the plain viewer (no sandbox)"
# back to the page
ev "document.getElementById('pb-back').click(); 'back'" >/dev/null; sleep 0.6

# ── 5. the pill COPIES; ↻ rebuilds ─────────────────────────────────────
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

# ── 6. the nav stack: A → B (youtube embed) → ‹ back ────────────────────
YT=$(ev "window.InAppBrowser.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
check "$YT" "panel" "open() docks (returns 'panel', not the old tiers)"
sleep 1.6
YTD=$(ev "(function(){
  var fr = document.getElementById('pb-frame');
  return JSON.stringify({pill: document.getElementById('pb-url').textContent, src: fr ? fr.src : 'none',
    canBack: window.InAppBrowser.canBack(), sb: fr ? (fr.getAttribute('sandbox')||'none') : 'gone'});
})()")
has "$YTD" '"pill":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"' "the pill keeps the ORIGINAL watch link"
has "$YTD" 'youtube-nocookie.com/embed/dQw4w9WgXcQ' "the frame plays the NOCOOKIE embed (the rewrite)"
has "$YTD" '"canBack":true' "canBack() true with two entries"
has "$YTD" 'allow-scripts' "the youtube embed keeps the no-top-nav sandbox too"

ev "document.getElementById('pb-back').click(); 'back'" >/dev/null
sleep 0.8
B1=$(ev "JSON.stringify({cur: window.InAppBrowser.currentURL(), canBack: window.InAppBrowser.canBack()})")
has "$B1" '"cur":"https://example.com/"' "‹ walks back to the first page"
has "$B1" '"canBack":false' "the stack bottom disables ‹"

# ── 7. the frame-buster guard: rapid same-URL reopen → the og-card ────
BUST=$(ev "(function(){
  var r1 = window.InAppBrowser.open('https://example.com/');
  var r2 = window.InAppBrowser.open('https://example.com/');   // < 1.5s later
  var b = document.querySelector('.pb-blocked');
  return JSON.stringify({r1: r1, r2: r2, blocked: !!b, title: b ? (b.querySelector('.pb-btitle')||{}).textContent : ''});
})()")
has "$BUST" '"r2":"panel"' "the guard returns panel (no crash)"
has "$BUST" '"blocked":true' "the rapid reopen shows the blocked card (a bust loop never reloads)"
has "$BUST" '"title":"example.com"' "the guard card carries the host"

# ── 8. ✕ closes + the chat root restores untouched ─────────────────────
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null
sleep 0.8
CLOSED=$(ev "(function(){
  var p = document.getElementById('chat-panel');
  var hdr = getComputedStyle(document.querySelector('#chat-panel .panel-header')).display;
  return JSON.stringify({cls: p.classList.contains('panel-browser'), header: hdr, root: !!document.getElementById('chat-messages'), open: window.InAppBrowser.isOpen(),
    link: !![].filter.call(document.querySelectorAll('#v0635-msg a'), function(x){return x.href.indexOf('example.com')>=0;})[0]});
})()")
has "$CLOSED" '"cls":false' "✕ drops .panel-browser"
has "$CLOSED" '"header":"flex"' "the panel header returns"
has "$CLOSED" '"root":true' "the chat root is back"
has "$CLOSED" '"open":false' "isOpen() false after ✕"
has "$CLOSED" '"link":true' "the transcript survived the round trip"

# ── 9. Escape closes too (the desktop nicety) ───────────────────────────
ev "window.InAppBrowser.open('https://example.com/'); 'reopen'" >/dev/null
sleep 0.6
ev "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'" >/dev/null
sleep 0.6
ESC=$(ev "window.InAppBrowser.isOpen() ? 'still-open' : 'escaped'")
check "$ESC" "escaped" "Escape pops the dock"

# ── 10. a blocked link TAP docks the og-card IN THE PANEL + ⤢ fallback ─
ev "var a = [].filter.call(document.querySelectorAll('#v0635-msg a'), function(x){return x.href.indexOf('openrouter')>=0;})[0]; a && a.click(); 'tapped'" >/dev/null
sleep 4.5
BLK=$(ev "(function(){
  var b = document.querySelector('.pb-blocked');
  return JSON.stringify({blocked: !!b, note: b ? (b.querySelector('.pb-note')||{}).textContent : '', open: !!(b && b.querySelector('.pb-open')), dockopen: window.InAppBrowser.isOpen()});
})()")
has "$BLK" '"blocked":true' "the blocked link TAP docks the og-card (in the panel, not a new screen)"
has "$BLK" 'blocks embedding' "the honest note"
has "$BLK" '"open":true' "the ⤢ open button is there"
has "$BLK" '"dockopen":true' "the dock stayed a panel screen"
ev "document.querySelector('.pb-blocked .pb-open').click(); 'open-fallback'" >/dev/null
sleep 0.5
FB=$(ev "var c = window.__bridge[window.__bridge.length-1]; c ? c.m + ' ' + c.u : 'none'")
has "$FB" 'openInApp https://openrouter.ai/keys' "the ⤢ rides the FALLBACK tiers (the full-screen viewer)"
ev "document.getElementById('pb-close').click(); 'cleanup'" >/dev/null; sleep 0.4

# ── 11. the ⧉ box+arrow → openExternal ──────────────────────────────────
ev "window.InAppBrowser.open('https://example.com/'); 'x'" >/dev/null
sleep 0.6
ev "window.__bridge = []; document.getElementById('pb-ext').click(); 'ext'" >/dev/null
sleep 0.4
EXT=$(ev "var c = window.__bridge[0]; c ? c.m + ' ' + c.u : 'none'")
has "$EXT" 'openExternal https://example.com/' "the ⧉ box+arrow hands off to openExternal (ACTION_VIEW on device)"
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null; sleep 0.6

# ── 12. the v0.62.3 contract SURVIVES (getkey/hostile stay sync) ──────
K1=$(ev "window.__bridge = []; var t = window.InAppBrowser.open('https://openrouter.ai/keys', {purpose:'getkey'}); var c = window.__bridge[0]; JSON.stringify({tier:t, m:c.m, hostile:c.o.hostile})")
has "$K1" '"tier":"apk-viewer"' "getkey stays SYNCHRONOUS on the fallback tier"
has "$K1" '"hostile":false' "getkey passes hostile:false"
K2=$(ev "window.__bridge = []; window.InAppBrowser.open('https://opencode.ai/auth', {purpose:'getkey', hostile:true}); var c = window.__bridge[0]; c.m + ' hostile=' + c.o.hostile")
has "$K2" 'openInApp hostile=true' "the webview-hostile provider passes hostile:true"

# ── 13. the YouTube card still plays IN PLACE; ↗ = external ───────────
ev "window.__yt = document.querySelector('#v0635-msg .fmt-yt'); window.__yt ? window.__yt.click() : 'no-card'; 'clicked'" >/dev/null
sleep 1.5
YTIP=$(ev "(function(){
  var f = document.querySelector('#v0635-msg .fmt-yt iframe');
  var cap = document.querySelector('#v0635-msg .fmt-yt-open');
  return JSON.stringify({frame: f ? f.src : 'none', cap: !!cap, dock: window.InAppBrowser.isOpen()});
})()")
has "$YTIP" 'youtube-nocookie.com/embed/dQw4w9WgXcQ' "the YT card still plays IN PLACE (never docks)"
has "$YTIP" '"cap":true' "the ↗ caption affordance exists"
has "$YTIP" '"dock":false' "no dock opened from the YT card"
ev "window.__bridge = []; var e = document.querySelector('#v0635-msg .fmt-yt-open'); e && e.click(); 'ext'" >/dev/null
sleep 0.4
YTEXT=$(ev "var c = window.__bridge[0]; c ? c.m + ' ' + c.u : 'none'")
has "$YTEXT" 'openExternal https://www.youtube.com/watch?v=dQw4w9WgXcQ' "the YT ↗ caption rides external (the box+arrow tiers)"

# ── 14. THE SELF-HOST PILL GLOWS in the theme color ────────────────────
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
  // the theme's accent → rgb triple, hex or rgb() input
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

# ── 15. the app tab NEVER navigated ─────────────────────────────────────
LOC=$(ev "location.href")
case "$LOC" in "$BASE"|"$BASE/"|"$BASE/#"*) ok "the app tab never navigated (still $LOC)";; *) bad "the app navigated away: $LOC";; esac

# ── 16. theme discipline: the .pb-* + .wsp-pill rules hardcode nothing ─
THEME=$(ev "
(function(){
  var targets = ['.pb-pill', '.pb-btn', '.pb-toast', '.pb-blocked', '.pb-open', '.pb-loadbar', '.wsp-pill'];
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
check "$THEME" "vars-only" "the .pb-* + .wsp-pill chrome hardcodes no colors (theme vars only)"

# ── 17. THE DOCK ITSELF: drag the strip full ⇄ half (the user's ask) ──
# headless quirk: CDP sometimes swallows the terminal pointerup over the
# drag strip — dispatch it deterministically (gesture.js's end() is idempotent).
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
has "$FULL" '"full":true' "dragging the strip UP docks the browser FULL"
has "$FULL" '"pill":"https://example.com/"' "the dock (pill + frame) survived the drag"

# drag back DOWN to the half position — gentle steps (a dock intent, not a fling)
DASH2=$(ev "var r = document.querySelector('#chat-panel .handle-bar').getBoundingClientRect(); Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)")
DX=$(echo $DASH2 | cut -d' ' -f1); DY=$(echo $DASH2 | cut -d' ' -f2)
agent-browser mouse move $DX $DY >/dev/null
agent-browser mouse down >/dev/null
YY=$DY
for STEP in 1 2 3 4 5; do YY=$((YY+60)); agent-browser mouse move $DX $YY >/dev/null; sleep 0.15; done
agent-browser mouse up >/dev/null; pup
sleep 0.9
HALF=$(ev "(function(){ var p = document.getElementById('chat-panel'); return JSON.stringify({full: p.classList.contains('panel-full'), open: window.InAppBrowser.isOpen()}); })()")
has "$HALF" '"full":false' "dragging back DOWN re-docks at the half position (canvas visible behind)"
has "$HALF" '"open":true' "the browser stays docked through both snaps"
ev "document.getElementById('pb-close').click(); 'closed'" >/dev/null; sleep 0.5

# ── 18. no JS errors crept in ────────────────────────────────────────────
ERRS=$(agent-browser errors 2>/dev/null | grep -v "Failed to load resource" | head -5)
if [ -z "$ERRS" ]; then ok "no console errors through the whole flow"; else bad "console errors: $ERRS"; fi

echo ""
echo "══ v0.63.5 panel-screen red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
