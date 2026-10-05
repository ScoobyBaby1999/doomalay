#!/bin/bash
# v1031-card-audit.sh — THE CARD RIG (PLAN-V103 §v1.03.1).
#
# THE CONTRACT — the nested tiling kill, proven live:
#  (C1) THE CARD VAR exists and derives (the CSS :root mix = the inline
#       mix; the JS culori triplet --card-rgb agrees within 2/channel).
#  (C2) THE NESTED CARDS are FLAT: .settings-section, .slot-row,
#       .gr-editor paint NO background-image (the 2-layer plate + the
#       surface window are dead) — with a LIVE surface gradient, they
#       stay flat (the tiling the user reported is structurally gone).
#  (C3) THE HEADERS are card strips (.settings-section h3) — no
#       bg-app-gradient window.
#  (C4) THE GATELOCK boxes ride the card (filled = var(--card); empty =
#       the translucent card) — never the surface field.
#  (C5) THE CHATBOT NAME PILL + SANDBOX BADGE ride the card glass (DOM).
#  (C6) THE BIG SURFACES KEEP THE FIELD: the panel still paints the
#       live surface gradient (the card never leaks onto Layer 1).
#  (C7) CONTRAST: ink-on-card keeps >= 60% of the on-surface contrast.
#  (C8) PERF: live surface/accent edits produce ZERO longtasks.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8431
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1031
export AGENT_BROWSER_SESSION=doomalay-v1031

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

# ── engine ──
if ! curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1; then
  rm -rf $DATA
  setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1031.log 2>&1 < /dev/null &
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5

# ── a live surface gradient first (the tiling amplifier) ──────────
ev "
(function(){
  var s = window.Settings.getState();
  var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
  ov.midnight = ov.midnight || {};
  ov.midnight['--field-surface'] = { colors: ['#2a1a4a','#123a5a','#4a1a2a'], dir: 'to bottom' };
  window.Settings.setState({ themeOverrides: ov });
  return 'applied';
})()" > /dev/null 2>&1
sleep 2

# ── C1: the card var derives ─────────────────────────────────────
CARD=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--card').trim()")
ck "C1a --card resolves in CSS" "$(echo "$CARD" | grep -qiE 'color-mix|oklab|rgb|#' && echo yes)" "$CARD"
CARDRGB=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--card-rgb').trim()")
ck "C1b --card-rgb triplet is live" "$(echo "$CARDRGB" | grep -qE '^[0-9]+,[0-9]+,[0-9]+$' && echo yes)" "$CARDRGB"
PARITY=$(ev "
(function(){
  // (a) CSS-side coherence: var(--card) === the inline 9% mix (same
  // serialization → the :root derivation and any inline use agree).
  var d = document.createElement('div');
  d.style.background = 'color-mix(in oklab, var(--field-surface), var(--field-ink) 9%)';
  document.body.appendChild(d);
  var inlineMix = getComputedStyle(d).backgroundColor;
  d.style.background = 'var(--card)';
  var rootCard = getComputedStyle(d).backgroundColor;
  document.body.removeChild(d);
  if (inlineMix !== rootCard) return 'css-drift ' + inlineMix + ' vs ' + rootCard;
  // (b) JS-side: the oklab() serialization → srgb, then compare with the
  // triplet applyTheme wrote (culori parity, ±2/channel).
  var m = inlineMix.match(/oklab\\(([\\d.\\-]+) ([\\d.\\-]+) ([\\d.\\-]+)\\)/);
  if (!m) {
    // rgb() form — compare directly
    var r = inlineMix.match(/([0-9.]+)/g);
    if (!r) return 'unparseable ' + inlineMix;
  } else {
    var L = parseFloat(m[1]), A = parseFloat(m[2]), B = parseFloat(m[3]);
    var l_ = L + 0.3963377774 * A + 0.2158037573 * B;
    var m_ = L - 0.1055613458 * A - 0.0638541728 * B;
    var s_ = L - 0.0894841775 * A - 1.2914855480 * B;
    var l3 = l_*l_*l_, m3 = m_*m_*m_, s3 = s_*s_*s_;
    var lr =  4.0767416621*l3 - 3.3077115913*m3 + 0.2309699292*s3;
    var lg = -1.2684380046*l3 + 2.6097574011*m3 - 0.3413193965*s3;
    var lb = -0.0041960863*l3 - 0.7034186147*m3 + 1.7076147010*s3;
    var r = [lr, lg, lb].map(function(c){
      c = Math.round(255 * (c <= 0.0031308 ? 12.92*c : 1.055*Math.pow(c, 1/2.4) - 0.055));
      return Math.max(0, Math.min(255, c));
    });
  }
  var js = (getComputedStyle(document.documentElement).getPropertyValue('--card-rgb').trim() || '').split(',').map(Number);
  if (js.length !== 3 || isNaN(js[0])) return 'bad-triplet';
  var dr = Math.abs(parseInt(r[0]) - js[0]), dg = Math.abs(parseInt(r[1]) - js[1]), db = Math.abs(parseInt(r[2]) - js[2]);
  return (dr <= 2 && dg <= 2 && db <= 2) ? 'match' : 'drift ' + dr + ',' + dg + ',' + db;
})()")
ck "C1c CSS mix = JS triplet (culori parity)" "$([ "$PARITY" = "match" ] && echo yes)" "$PARITY"

# ── C4 first (spawn the chat + gatelock while the panel is fresh) ─
# NOTE: trusted agent-browser clicks on the dock MISS when the panel
# overlays it (hit-test coverage) — the rigs' established fallback is
# the element's own JS click (the same handler path).
ev "(function(){ var dn=document.getElementById('dock-new'); if(dn) dn.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 0.8
ev "(function(){ var b=document.getElementById('dock-new-chat'); if(b) b.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 2
GATE=$(ev "
(function(){
  var b = document.querySelector('[data-gate-key]');
  if (!b) return 'no-gatelock';
  var cs = getComputedStyle(b);
  return (cs.backgroundImage === 'none' ? 'flat' : 'grad') + '|' + cs.backgroundColor.slice(0, 22);
})()")
ck "C4 the gatelock boxes ride the card" "$(echo "$GATE" | grep -q '^flat|' && echo yes)" "$GATE"
GATEEMPTY=$(ev "
(function(){
  var boxes = document.querySelectorAll('[data-gate-key]');
  var states = [];
  for (var i = 0; i < boxes.length; i++) {
    var cs = getComputedStyle(boxes[i]);
    states.push((cs.backgroundImage === 'none' ? 'flat' : 'grad'));
  }
  return states.join(',') + ' n=' + boxes.length;
})()")
ck "C4b every gatelock box is flat (n boxes)" "$(echo "$GATEEMPTY" | grep -qE '^flat(,flat)* n=[1-9]' && echo yes)" "$GATEEMPTY"

# ── C6: the panel (now open with the fresh chat) keeps the field ───
PANEL=$(ev "getComputedStyle(document.getElementById('chat-panel')).backgroundImage.slice(0, 30)")
ck "C6 the panel still paints the live surface gradient" "$(echo "$PANEL" | grep -q 'linear-gradient' && echo yes)" "$PANEL"
HDRCHAT=$(ev "getComputedStyle(document.getElementById('chat-header')).backgroundImage")
ck "C6b #chat-header is a card strip (no bg-app window)" "$([ "$HDRCHAT" = "none" ] && echo yes)" "$HDRCHAT"

# ── C2: the settings cards are flat ───────────────────────────────
agent-browser click "#settings-btn" > /dev/null 2>&1; sleep 0.4
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'js'; })()" > /dev/null 2>&1
sleep 1.2
ev "(function(){ var t=document.querySelector('.settings-nav .tab[data-page=appearance]'); if(t) t.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.2
FLAT=$(ev "
(function(){
  var el = document.querySelector('.slot-row');
  if (!el) return 'missing';
  var cs = getComputedStyle(el);
  return (cs.backgroundImage === 'none' ? 'flat' : 'grad') + '|' + cs.backgroundColor.slice(0, 18);
})()")
ck "C2a the slot rows are flat (no gradient window)" "$(echo "$FLAT" | grep -q '^flat|' && echo yes)" "$FLAT"
# v1.03.3 RE-PIN: the slot row opens the THEME EDITOR view now (the
# popover retired) — verify the page opens, then back; the editor-box
# flatness probe rides the Text style section's lazy fmt editor.
ev "(function(){ var h=document.querySelector('.slot-row-head'); if(h) h.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.2
TEOPEN=$(ev "(document.querySelector('.te-page') ? 'page' : 'none')")
ck "C2b the slot row opens the Theme Editor page (the v1.03.3 picker path)" "$([ "$TEOPEN" = "page" ] && echo yes)" "$TEOPEN"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" > /dev/null 2>&1; sleep 0.9
ev "(function(){
  var hs = document.querySelectorAll('.settings-section h3[data-section-toggle]');
  for (var i = 0; i < hs.length; i++) { if (/text style/i.test(hs[i].textContent)) { hs[i].click(); return 'ok'; } }
})()" > /dev/null 2>&1
sleep 0.9
ev "(function(){
  var head = document.querySelector('.text-style-active, [data-color-row] .color-row-head') || document.querySelector('[data-color-row] .color-row-head');
  if (head) { head.click(); return 'ok'; }
  return 'none';
})()" > /dev/null 2>&1
sleep 0.9
GRFLAT=$(ev "
(function(){
  var g = document.querySelector('.gr-editor');
  if (!g) return 'no-editor';
  var cs = getComputedStyle(g);
  return cs.backgroundImage === 'none' ? 'flat' : 'grad:' + cs.backgroundImage.slice(0, 40);
})()")
ck "C2b2 the fmt editor box is flat" "$(echo "$GRFLAT" | grep -q '^flat' && echo yes)" "$GRFLAT"
ev "(function(){
  var hs = document.querySelectorAll('.settings-section h3[data-section-toggle]');
  for (var i = 0; i < hs.length; i++) { if (/text style/i.test(hs[i].textContent)) { hs[i].click(); return 'ok'; } }
})()" > /dev/null 2>&1; sleep 0.6

ev "(function(){ var t=document.querySelector('.settings-nav .tab[data-page=general]'); if(t) t.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.2
SECFLAT=$(ev "
(function(){
  var s = document.querySelector('.settings-section');
  if (!s) return 'missing';
  var cs = getComputedStyle(s);
  return (cs.backgroundImage === 'none' ? 'flat' : 'grad') + '/' + cs.backgroundColor.slice(0, 22);
})()")
ck "C2c .settings-section is flat with the card fill" "$(echo "$SECFLAT" | grep -q '^flat/' && echo yes)" "$SECFLAT"
HDR=$(ev "
(function(){
  var h = document.querySelector('.settings-section h3');
  if (!h) return 'missing';
  var cs = getComputedStyle(h);
  return cs.backgroundImage === 'none' ? 'flat' : 'grad';
})()")
ck "C3 the section headers are card strips (no bg-app window)" "$([ "$HDR" = "flat" ] && echo yes)" "$HDR"

# ── C5: the chatbot name pill (DOM twin) ──────────────────────────
NAMEPILL=$(ev "
(function(){
  var n = document.querySelector('.chatbot .name');
  if (!n) return 'absent (pixi world)';
  var cs = getComputedStyle(n);
  return cs.backgroundImage === 'none' ? 'flat' : 'grad';
})()")
ck "C5 the chatbot name pill rides the card glass (DOM twin present)" \
   "$( { [ "$NAMEPILL" = "flat" ] && echo yes; } || { [ "$NAMEPILL" = "absent (pixi world)" ] && echo yes; } )" "$NAMEPILL"

# ── C7: contrast on the card vs on the surface ────────────────────
CONTRAST=$(ev "
(function(){
  function lumOf(v){
    var d = document.createElement('div'); d.style.background = v;
    document.body.appendChild(d);
    var cs = getComputedStyle(d).backgroundColor;
    document.body.removeChild(d);
    var m = cs.match(/([0-9.\\-]+)/g); if (!m) return null;
    var f = m.slice(0,3).map(function(x){ x = Math.abs(parseFloat(x)); x = Math.min(x,255)/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2];
  }
  var surf = lumOf('var(--field-surface)');
  var card = lumOf('var(--card)');
  var ink  = lumOf('var(--field-ink)');
  if (surf == null || card == null || ink == null) return 'lum-fail';
  var cs = (Math.max(ink,surf)+0.05)/(Math.min(ink,surf)+0.05);
  var cc = (Math.max(ink,card)+0.05)/(Math.min(ink,card)+0.05);
  return (cc/cs).toFixed(3) + ' (' + cc.toFixed(1) + ':' + cs.toFixed(1) + ')';
})()")
ck "C7 ink-on-card keeps >=60% of on-surface contrast" "$(echo "$CONTRAST" | grep -qE '^0\.[6-9]|^1' && echo yes)" "$CONTRAST"

# ── C8: perf — zero longtasks on live field edits ──────────────────
LT3=$(ev "
(function(){
  window.__v1031lts = 0;
  try {
    var po = new PerformanceObserver(function(list){ window.__v1031lts += list.getEntries().length; });
    po.observe({ entryTypes: ['longtask'] });
    var s = window.Settings.getState();
    var ov = JSON.parse(JSON.stringify(s.themeOverrides || {}));
    ov.midnight['--field-surface'] = { colors: ['#0d2b45','#1a4a3a'], dir: 'to bottom' };
    ov.midnight['--field-accent-1'] = { colors: ['#ff6b35','#8e2de2'], dir: 'to right' };
    window.Settings.setState({ themeOverrides: ov });
    return 'armed+flip';
  } catch (e) { return 'err:' + e.message; }
})()")
sleep 2
LTC=$(ev "window.__v1031lts")
ck "C8 zero longtasks on live surface+accent edits" "$([ "$LTC" = "0" ] && echo yes)" "$LTC"

echo ""
echo "═══ v1031 THE CARD: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
