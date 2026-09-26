#!/bin/bash
# v0621-embed-yt-test.sh — RED-TEAM the v0.62.1 embed wave (PLAN-V063 E1).
#
# The universal link verdict + the in-place YouTube player. A real user
# flow: a chat message carries links; the user taps them; NOTHING leaves
# the app:
#   - YouTube link → the v0.28 card; tapping it plays the embed IN PLACE
#     (youtube-nocookie iframe, autoplay, start= carried), the ↗ still
#     opens outside when asked;
#   - a frame-blocked link (openrouter.ai/keys — the v062 probe) → the
#     lv-card og-card + open ↗, NEVER a navigation;
#   - a frameable link (deepseek — probed frame-friendly) → the sandboxed
#     lv-frame iframe;
#   - an image link → the inline lv-img (+ MediaZoom on tap);
#   - the engine API itself: /api/preview verdicts live (YT rewrite, the
#     blocked verdict, the image classification).
set -u
DATA=/tmp/doomalay-v0621
PORT=8182
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0621
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
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0621-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# ── API verdicts (live) ──────────────────────────────────────────────────
YT=$(curl -s "$BASE/api/preview?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ%26t%3D90s")
has "$YT" '"type":"youtube"' "API: youtube watch+ts → type youtube"
has "$YT" '"start":90' "API: the t=90s timestamp rides along"
has "$YT" 'youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90' "API: embed URL carries start=90 (autoplay-free)"
OR=$(curl -s "$BASE/api/preview?url=https%3A%2F%2Fopenrouter.ai%2Fkeys")
has "$OR" '"frameable":false' "API: openrouter/keys → frameable:false (matches the v062 probe)"
IMG=$(curl -s "$BASE/api/preview?url=https%3A%2F%2Fi.ytimg.com%2Fvi%2FdQw4w9WgXcQ%2Fmaxresdefault.jpg")
has "$IMG" '"type":"image"' "API: a direct image URL classifies as image"

# ── UI: render a message with links, click like a user ───────────────────
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "window.Formatter && window.LinkViewer ? 'ready' : 'missing'" >/tmp/v0621-a; check "$(cat /tmp/v0621-a)" "ready" "formatter + linkviewer loaded"

ev "
(function(){
  var root = document.getElementById('chat-root') || document.body;
  var holder = document.createElement('div');
  holder.id = 'v0621-msg';
  root.appendChild(holder);
  window.Formatter.renderInto(holder,
    'check these out:\\n\\n- a video: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s\\n\\n- [key console](https://openrouter.ai/keys)\\n\\n- [a frameable page](https://example.com/)\\n\\n- an image: https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg\\n\\n- plain https://platform.deepseek.com/api_keys link',
    'full', {});
  return 'rendered';
})()" >/tmp/v0621-b; check "$(cat /tmp/v0621-b)" "rendered" "message with 5 links rendered (formatter full mode)"

# 1. the YouTube card exists and plays IN PLACE on tap
YTCARD=$(ev "var c = document.querySelector('#v0621-msg .fmt-yt'); c ? 'card' : 'none'")
check "$YTCARD" "card" "YouTube link → the thumbnail card"
ev "document.querySelector('#v0621-msg .fmt-yt').click(); 'clicked'" >/dev/null
sleep 1.5
YTIFRAME=$(ev "var f = document.querySelector('#v0621-msg .fmt-yt iframe'); f ? f.src : 'none'")
has "$YTIFRAME" "youtube-nocookie.com/embed/dQw4w9WgXcQ" "tapping the card plays the embed IN PLACE (nocookie)"
has "$YTIFRAME" "start=90" "the player carries the timestamp"
# still playing after the click — the card never navigated
LOC0=$(ev "location.href")
case "$LOC0" in "$BASE"|"$BASE/"|"$BASE/#"*) ok "the app never navigated (still $LOC0)";; *) bad "the app navigated away: $LOC0";; esac

# 2. the blocked link → the og-card, in place
ev "var a = document.querySelector('#v0621-msg a[href*=openrouter]'); a ? a.click() : 'nolink'; 'x'" >/dev/null
sleep 4
ORCARD=$(ev "var c = document.querySelector('#v0621-msg .lv-card[data-lv-url*=openrouter]'); c ? (c.querySelector('.lv-note') ? c.querySelector('.lv-note').textContent : 'no-note') : 'none'")
has "$ORCARD" "blocks embedding" "blocked link → the lv-card with the honest blocks-embedding note"
ORB=$(ev "var c = document.querySelector('#v0621-msg .lv-card[data-lv-url*=openrouter] .lv-open'); c ? 'button' : 'none'")
check "$ORB" "button" "the blocked card carries the open ↗ button"

# 3. the frameable link → the sandboxed iframe, in place
ev "document.querySelector('#v0621-msg a[href*=example]').click(); 'x'" >/dev/null
sleep 4
EXFRAME=$(ev "var c = document.querySelector('#v0621-msg .lv-card[data-lv-url*=example]'); c ? (c.querySelector('.lv-frame') ? 'iframe' : 'no-iframe:' + c.querySelector('.lv-body').innerHTML.slice(0,80)) : 'none'")
check "$EXFRAME" "iframe" "frameable link → the lv-frame iframe (in-app render)"

# 4. the image link → the inline image
ev "document.querySelector('#v0621-msg a[href*=hqdefault]').click(); 'x'" >/dev/null
sleep 3
IMGCARD=$(ev "var c = document.querySelector('#v0621-msg .lv-card[data-lv-url*=hqdefault]'); c ? (c.querySelector('.lv-img') ? 'img' : 'no-img') : 'none'")
check "$IMGCARD" "img" "image link → the inline lv-img"

# 5. deepseek link → frameable iframe (probed frame-friendly)
ev "document.querySelector('#v0621-msg a[href*=deepseek]').click(); 'x'" >/dev/null
sleep 5
DSFRAME=$(ev "var c = document.querySelector('#v0621-msg .lv-card[data-lv-url*=deepseek]'); c ? (c.querySelector('.lv-frame') ? 'iframe' : 'note:' + (c.querySelector('.lv-note')||{}).textContent) : 'none'")
check "$DSFRAME" "iframe" "deepseek link → the lv-frame iframe (the lone frame-friendly console)"

# 6. the app tab NEVER navigated through all five interactions
LOC1=$(ev "location.href")
case "$LOC1" in "$BASE"|"$BASE/"|"$BASE/#"*) ok "after 5 link interactions the app tab never navigated";; *) bad "the app navigated away: $LOC1";; esac

# 7. theme discipline: the card colors resolve from CSS vars (no hardcoded hex)
THEME=$(ev "
(function(){
  var c = document.querySelector('#v0621-msg .lv-card');
  if (!c) return 'no-card';
  var cs = getComputedStyle(c);
  var bad = [];
  ['background-color','border-color','color'].forEach(function(p){
    var v = cs.getPropertyValue(p);
    if (/rgb\\(/.test(v) && v !== 'rgba(0, 0, 0, 0)') {
      // resolved rgb is fine — it COMES from a var; verify by the sheet rule instead
    }
  });
  var sheet = null;
  for (var i = 0; i < document.styleSheets.length; i++) {
    var s = document.styleSheets[i];
    try { if (s.cssRules) { for (var j = 0; j < s.cssRules.length; j++) { var r = s.cssRules[j]; if (r.selectorText === '.lv-card' || (r.selectorText||'').indexOf('.lv-card') === 0) { sheet = r.style.cssText; break; } } } } catch (e) {}
    if (sheet) break;
  }
  if (!sheet) return 'no-rule';
  var hexes = sheet.match(/#[0-9a-f]{3,8}\\b/gi) || [];
  return hexes.length === 0 ? 'vars-only' : 'hardcoded:' + hexes.join(',');
})()")
check "$THEME" "vars-only" "the .lv-card rule hardcodes no colors (theme vars only)"

echo ""
echo "══ v0.62.1 embed red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
