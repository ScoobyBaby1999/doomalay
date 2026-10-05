#!/bin/bash
# v1032-textstyle-section.sh — THE TEXT STYLE PROMOTION RIG (PLAN-V103 §v1.03.2).
#
# THE CONTRACT (user point 3: "move text style in the settings colors tab
# from a nested row… to a collapsible header that expands the text
# colors, place the new header as a row under 'the fields'"):
#  (T1) The Colors tab carries THREE sections in order: Theme → The
#       Fields · <label> → Text style (the promoted header sits directly
#       under the Fields section).
#  (T2) The Fields section holds SIX slot rows (surface/ink/canvas/
#       accent-1..3) — the text-style SLOT ROW is gone (no
#       data-slot-open=text-style anywhere).
#  (T3) Expanding Text style reveals the text colors IN PLACE: the a1
#       preview strip + the scheme presets + FIVE fmt rows with PROPER
#       labels (Accent 1/Accent 2/Accent 3/Bright text/Links — the
#       v0.99.6 popover regression showed raw hexes as row titles) +
#       the reset button.
#  (T4) The fmt rows expand to lazy GradientUI editors in place.
#  (T5) A scheme preset click writes chatScheme (the global action).
#  (T6) The '· customized' marker appears on the header when pinned
#       (non-teal scheme or fmt overrides), and the reset clears it.
#  (T7) PERF: expanding the section = zero longtasks (the lazy contract).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8432
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1032
export AGENT_BROWSER_SESSION=doomalay-v1032

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

if ! curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1; then
  cat > /tmp/doomalay-spawn-$PORT.sh << EOF
#!/bin/bash
setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1032.log 2>&1 < /dev/null &
EOF
  bash /tmp/doomalay-spawn-$PORT.sh
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"

agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5
ev "window.__lt2=[]; new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt2.push(e.duration)})}).observe({entryTypes:['longtask']}); 'armed'" > /dev/null
ev "(function(){ var b=document.getElementById('settings-btn'); if(b) b.click(); return 'ok'; })()" > /dev/null
sleep 1.5

# ── T1 + T2: the structure ────────────────────────────────────────
STRUCT=$(ev "
(function(){
  var secs = document.querySelectorAll('.settings-section');
  var heads = [];
  for (var i = 0; i < secs.length; i++) {
    var h = secs[i].querySelector('h3 span');
    heads.push(h ? h.textContent.trim() : '?');
  }
  return heads.join('|');
})()")
ck "T1 three sections in order (Theme → Fields → Text style)" \
   "$(echo "$STRUCT" | grep -qE '^Theme\|The Fields · .+\|Text style$' && echo yes)" "$STRUCT"
SLOTS=$(ev "document.querySelectorAll('[data-slot-open]').length")
ck "T2a the Fields section holds SIX slot rows" "$([ "$SLOTS" = "6" ] 2>/dev/null && echo yes)" "$SLOTS"
TSROW=$(ev "document.querySelectorAll('[data-slot-open=text-style]').length")
ck "T2b the text-style SLOT ROW is gone" "$([ "$TSROW" = "0" ] 2>/dev/null && echo yes)" "$TSROW"

# ── T3: expand + inspect ──────────────────────────────────────────
ev "(function(){
  var hs = document.querySelectorAll('.settings-section h3[data-section-toggle]');
  for (var i = 0; i < hs.length; i++) {
    if (/text style/i.test(hs[i].textContent)) { hs[i].click(); return 'ok'; }
  }
  return 'none';
})()" > /dev/null
sleep 1.2
BODY=$(ev "
(function(){
  var sec = null;
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    if (/text style/i.test(secs[i].querySelector('h3').textContent)) sec = secs[i];
  }
  if (!sec) return 'no-sec';
  var rows = sec.querySelectorAll('[data-color-row]');
  var labels = [];
  for (var i = 0; i < rows.length; i++) {
    var sp = rows[i].querySelectorAll('span');
    labels.push(sp.length ? sp[0].textContent.trim() : 'none');
  }
  return JSON.stringify({
    rows: rows.length, labels: labels.join(' / '),
    swatches: sec.querySelectorAll('[data-scheme]').length,
    reset: !!sec.querySelector('[data-action=chat-colors-reset]'),
    strip: !!sec.querySelector('.section-body div[aria-hidden]')
  });
})()")
ck "T3a five fmt rows with proper labels" \
   "$(echo "$BODY" | grep -q '\"labels\":\"Accent 1 headings · keywords / Accent 2 subheads · code / Accent 3 emphasis · links / Bright text bold / Links\"' && echo yes)" "$BODY"
ck "T3b the scheme presets + reset + preview strip render" \
   "$(echo "$BODY" | grep -qE '\"swatches\":[1-9][0-9]*' && echo yes)" "$BODY"

# ── T4: the fmt row opens the THEME EDITOR (v1.03.4 — was the inline
# lazy expansion; user spec: "clicking to edit any color" opens the page)
ev "(function(){
  var sec = null;
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    if (/text style/i.test(secs[i].querySelector('h3').textContent)) sec = secs[i];
  }
  var head = sec.querySelector('[data-color-row] .color-row-head');
  if (head) { head.click(); return 'ok'; }
  return 'no-head';
})()" > /dev/null
sleep 1.2
ED=$(ev "
(function(){
  var te = document.querySelector('.te-page');
  var name = te && te.querySelector('.te-name b');
  return te ? ('page:' + (name ? name.textContent : '')) : 'none';
})()")
ck "T4 the fmt row opens the Theme Editor (Accent 1)" "$(echo "$ED" | grep -q '^page:Accent 1$' && echo yes)" "$ED"
ev "(function(){ var p=window.Settings.panelOf(); if(p&&p.back) p.back(); return 'ok'; })()" > /dev/null
sleep 0.9

# ── T5: a scheme preset click ─────────────────────────────────────
SCHEME=$(ev "
(function(){
  var sec = null;
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    if (/text style/i.test(secs[i].querySelector('h3').textContent)) sec = secs[i];
  }
  var btns = sec.querySelectorAll('[data-scheme]');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('data-scheme') !== 'teal') { btns[i].click(); return btns[i].getAttribute('data-scheme'); }
  }
  return 'none';
})()")
sleep 1.2
SC=$(ev "(window.Settings.getState().chatScheme || 'null')")
ck "T5 the scheme click writes chatScheme" "$([ "$SC" != "null" ] && [ "$SC" != "teal" ] && [ "$SC" = "$SCHEME" ] && echo yes)" "clicked=$SCHEME state=$SC"

# ── T6: the customized marker + the reset ─────────────────────────
MARK=$(ev "
(function(){
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    var h = secs[i].querySelector('h3');
    if (/text style/i.test(h.textContent)) {
      return h.textContent.indexOf('customized') >= 0 ? 'pinned' : 'bare';
    }
  }
  return 'none';
})()")
ck "T6a the · customized marker shows on the header" "$([ "$MARK" = "pinned" ] && echo yes)" "$MARK"
ev "(function(){
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    var h = secs[i].querySelector('h3');
    if (/text style/i.test(h.textContent)) { h.click(); return 'expanded-again'; }
  }
})()" > /dev/null
sleep 0.8
ev "(function(){
  var secs = document.querySelectorAll('.settings-section');
  for (var i = 0; i < secs.length; i++) {
    if (/text style/i.test(secs[i].querySelector('h3').textContent)) {
      var r = secs[i].querySelector('[data-action=chat-colors-reset]');
      if (r) { r.click(); return 'reset'; }
    }
  }
  return 'none';
})()" > /dev/null
sleep 1.2
SC2=$(ev "(window.Settings.getState().chatScheme || 'null')")
ck "T6b the reset clears the scheme (marker dies)" "$({ [ "$SC2" = "null" ] || [ "$SC2" = "teal" ]; } && echo yes)" "$SC2"

# ── T7: perf ──────────────────────────────────────────────────────
LT=$(ev "window.__lt2.length")
ck "T7 zero longtasks through the whole flow" "$([ "$LT" = "0" ] 2>/dev/null && echo yes)" "$LT"

echo ""
echo "═══ v1032 TEXT STYLE: $PASS pass, $FAIL fail ═══"
[ $FAIL -eq 0 ]
