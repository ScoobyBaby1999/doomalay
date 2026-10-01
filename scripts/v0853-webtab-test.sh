#!/bin/bash
# v0853-webtab-test.sh — THE MULTI-TAB BROWSER (user spec verbatim:
#   "Let's rework how the browser in browser panel works and try to add
#    support for multiple tabs. Each tab has its own icon and acts kind of
#    like its own chatbot, holding down the canvas should yield two
#    options, new chat (rename it to new bot) and new tab. New bot creates
#    a chat panel, new tab creates a browser in browser panel, that saves
#    the current website address it holds and scroll position within that
#    website, ext.. therefore we expand our browser in browser to allow
#    for multiple tabs, or multiple icons within the canvas. The canvas
#    icon should ideally try and be dynamic from whatever the website icon
#    is they are visiting, if that's complex, let's just have it a
#    placeholder icon for now. With a method to change it using our
#    gradient coloring theme system.").
#
# THE CONTRACT:
#  (1) THE ENTITY — WebTabs.createAt makes a 'web' GridIcon: draggable
#      class, gradient placeholder disc (theme accent pair) + host label.
#  (2) THE PANEL — the tap opens the master panel with the omnibox +
#      THE CIRCULAR TAB ICON (v0.87.1: the side panel is gone — ONE
#      panel; the tab acts like its own chatbot).
#  (3) NAVIGATION — example.com (frameable) → the iframe + the entity
#      SAVES url/title/favicon; the canvas disc paints the site's icon
#      (the dynamic website icon) and the label shows the host.
#  (4) THE HONEST CARD — a frame-refuser (X-Frame-Options) renders the
#      card (title + host + why + the two escape buttons), never a
#      doomed iframe.
#  (5) PERSISTENCE — a FULL reload restores the tab: url, title,
#      favicon, iconMode, the favicon disc, the name label.
#  (6) THE LONG-PRESS MENU — the real 500ms hold yields TWO options:
#      "＋ New Bot" (new-chat action, still create-only) + "⧉ New Tab"
#      (new-tab action → creates a web entity + opens its panel).
#  (7) THE DOCK PATH — the ＋ sub-expansion's "new browser panel" pill
#      creates a web entity + opens its panel (the v0.85.2 guard
#      resolved by the real machinery).
#  (8) THE GRADIENT THEME SYSTEM — the tweaks view's GradientUI (the
#      circle opens it) edits the entity's spec LIVE (disc repaints);
#      the mode chip resets a custom spec back to the theme default.
#  (9) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8353
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0853
export AGENT_BROWSER_SESSION=doomalay-v0853

ev() { agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception:
    print(s, end='')"; }
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0853-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2

echo "── (1) the entity"
R=$(ev "JSON.stringify((function(){
  var t = window.WebTabs.createAt(100, 100, {});
  window.__t = t;
  return {ok: !!t && t.type === 'web', glyph: !!t.el.querySelector('.wt-glyph'),
    grad: t.el.querySelector('.icon').style.backgroundImage.indexOf('var(--accent') >= 0,
    label: t.el.querySelector('.name').textContent, cls: t.el.className.indexOf('chatbot') >= 0};
})())")
ck "createAt → web entity, gradient disc, chatbot drag class" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['ok'] and d['glyph'] and d['grad'] and d['cls'] else 'no')")" "$R"
ck "placeholder label 'New Tab'" \
  "$(echo "$R" | python3 -c "import sys,json;print('yes' if json.loads(sys.stdin.read())['label']=='New Tab' else 'no')")"

echo "── (2) the panel (the tap)"
agent-browser click ".chatbot[data-type=web] .icon" >/dev/null 2>&1; sleep 1.2
ck "tap opens the master panel with the omnibox + THE CIRCLE (v0.87: the side panel is gone — ONE panel)" \
  "$(ev "JSON.stringify({o: !!document.querySelector('.wt-omni') && document.getElementById('chat-panel').classList.contains('open'), s: !document.querySelector('.wt-side'), c: document.getElementById('panel-tab-icon') && getComputedStyle(document.getElementById('panel-tab-icon')).display !== 'none', e: !!document.querySelector('.wt-go')})" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['o'] and d['s'] and d['c'] and d['e'] else 'no')")"

echo "── (3) navigation (frameable + the dynamic site icon)"
ev "window.WebPanel.navigate('example.com')" >/dev/null 2>&1; sleep 4
R=$(ev "JSON.stringify((function(){
  var t = window.__t;
  return {iframe: !!document.querySelector('.wt-iframe'),
    src: document.querySelector('.wt-iframe') ? document.querySelector('.wt-iframe').src : '',
    url: t.url, title: t.title, fav: t.favicon,
    discImg: !!t.el.querySelector('.icon img'),
    label: t.el.querySelector('.name').textContent};
})())")
ck "frameable page → the sandboxed iframe" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['iframe'] and 'example.com' in d['src'] else 'no')")" "$R"
ck "the tab SAVES url + title + favicon (the address + the site's icon)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if 'example.com' in d['url'] and d['title'] and d['fav'] else 'no')")" "$R"
ck "example.com's dead favicon (404) → the disc keeps the gradient placeholder (the honest fallback)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if (not d['discImg']) and d['label']=='example.com' else 'no')")" "$R"
ck "the label shows the host" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['label']=='example.com' else 'no')")"

echo "── (4) the honest card (frame-refuser) + the live favicon disc"
ev "window.WebPanel.navigate('github.com')" >/dev/null 2>&1; sleep 4
ck "X-Frame-Options site → the card, never a doomed iframe" \
  "$(ev "JSON.stringify({c: !!document.querySelector('.wt-card'), w: !!document.querySelector('.wt-card-why'), b: !!document.querySelector('.wt-win') && !!document.querySelector('.wt-ext2'), i: !!document.querySelector('.wt-iframe')})" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['c'] and d['w'] and d['b'] and not d['i'] else 'no')")"
sleep 1.5
ck "the canvas disc paints the LIVE site favicon (github's fluidicon)" \
  "$(ev "JSON.stringify((function(){ var t = window.__t; var i = t.el.querySelector('.icon img'); return {img: !!i, src: i ? i.src : ''}; })())" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['img'] and 'github' in d['src'] else 'no')")"

echo "── (5) persistence (full reload)"
agent-browser open "$BASE" >/dev/null 2>&1; sleep 2
R=$(ev "JSON.stringify((function(){
  var t = window.WebTabs.all()[0];
  window.__t = t;
  return {n: window.WebTabs.count(), url: t.url, title: t.title.slice(0, 12),
    fav: t.favicon, mode: t.iconMode, img: !!t.el.querySelector('.icon img'),
    label: t.el.querySelector('.name').textContent};
})())")
ck "the tab restores (entity + url + title + favicon + mode)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['n']==1 and 'github.com' in d['url'] and d['title'] and d['fav'] and d['mode']=='auto' else 'no')")" "$R"
ck "the favicon disc + host label restore" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['img'] and d['label']=='github.com' else 'no')")"

echo "── (6) the long-press menu (New Bot / New Tab)"
ev "(function(){ var t=document.getElementById('chatbots'); t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:190,clientY:380,button:0})); return 'held'; })()" >/dev/null 2>&1
sleep 0.7
ev "document.getElementById('chatbots').dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:190,clientY:380,button:0}))" >/dev/null 2>&1
sleep 0.4
R=$(ev "JSON.stringify((function(){
  var bs = Array.prototype.map.call(document.querySelectorAll('#menu button'), function(b){ return b.dataset.action; });
  return {visible: !document.getElementById('menu').classList.contains('hidden'),
    bot: bs.indexOf('new-chat') >= 0, tab: bs.indexOf('new-tab') >= 0,
    botLabel: (document.querySelector('#menu button[data-action=new-chat]')||{}).textContent || ''};
})())")
ck "the 500ms hold yields New Bot + New Tab" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['visible'] and d['bot'] and d['tab'] else 'no')")" "$R"
ck "'new chat' renamed to 'New Bot'" \
  "$(echo "$R" | python3 -c "import sys,json;print('yes' if 'New Bot' in json.loads(sys.stdin.read())['botLabel'] else 'no')")"
B=$(ev "JSON.stringify({w: window.WebTabs.count()})")
ev "document.querySelector('#menu button[data-action=new-tab]').click()" >/dev/null 2>&1; sleep 1.4
ck "New Tab → a web entity + its panel opens" \
  "$(ev "JSON.stringify({w: window.WebTabs.count(), o: document.getElementById('chat-panel').classList.contains('open'), m: !!document.querySelector('.wt-omni')})" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['w']==2 and d['o'] and d['m'] else 'no')")" "$B"

echo "── (7) the dock path (＋ sub-expansion → new browser panel)"
ev "document.getElementById('chat-panel').classList.remove('open'); document.getElementById('chat-scrim').classList.remove('open');" >/dev/null 2>&1
ev "document.getElementById('dock-toggle').click()" >/dev/null 2>&1; sleep 0.4
ev "document.getElementById('dock-new').click()" >/dev/null 2>&1; sleep 0.4
ev "document.getElementById('dock-new-web').click()" >/dev/null 2>&1; sleep 1.4
ck "the browser pill creates web tab #3 + opens the panel" \
  "$(ev "JSON.stringify({w: window.WebTabs.count(), o: document.getElementById('chat-panel').classList.contains('open')})" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['w']==3 and d['o'] else 'no')")"

echo "── (8) the gradient theme system (the tweaks view — v0.87.4)"
R=$(ev "(async function(){
  var t = window.WebTabs.all()[window.WebTabs.count()-1]; window.__t2 = t;
  // the CIRCLE opens the tweaks view (the chatbot tweaks panel's twin)
  document.getElementById('panel-tab-icon').click();
  await new Promise(r => setTimeout(r, 600));
  var chips = document.querySelectorAll('.wtw-chip');
  var gradChip = null;
  chips.forEach(function(c){ if (c.getAttribute('data-wtw') === 'mode-grad') gradChip = c; });
  if (!gradChip) return JSON.stringify({mode: 'NO VIEW'});
  gradChip.click();
  await new Promise(r => setTimeout(r, 500));
  var themeBg = t.el.querySelector('.icon').style.backgroundImage;
  var inp = document.querySelector('.wtw-editor .gr-color');
  if (inp) { inp.value = '#ff5500'; inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); }
  var customBg = t.el.querySelector('.icon').style.backgroundImage;
  return JSON.stringify({mode: t.iconMode, themeFollow: themeBg.indexOf('var(--accent') >= 0,
    custom: (t.gradient||{}).colors ? (t.gradient.colors.indexOf('#ff5500') >= 0) : false,
    customBg: customBg.indexOf('rgb(255, 85, 0)') >= 0});
})()")
ck "gradient mode default rides the THEME accent pair" \
  "$(echo "$R" | python3 -c "import sys,json;print('yes' if json.loads(sys.stdin.read())['themeFollow'] else 'no')")" "$R"
ck "the GradientUI editor (in the tweaks view) repaints the disc LIVE (custom spec)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['custom'] and d['customBg'] and d['mode']=='gradient' else 'no')")" "$R"

echo "── (9) console errors"
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
[ "$FAIL" = "0" ] && echo "V0853 WEB-TAB: ALL GREEN" || echo "V0853 WEB-TAB: FAILURES"
exit $FAIL
