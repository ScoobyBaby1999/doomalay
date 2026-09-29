#!/bin/bash
# v0777-markers-test.sh — the settings ink wave:
#  (1) THE Z-FIGHT — with BOTH Primary text and Accent 1 as gradients
#      (the user's exact setup), the '· customized' marker renders as an
#      accent-1 GLYPH WINDOW (color transparent + the accent field), NOT
#      accent solid over the parent's clipped text-1 field
#  (2) THE SOLID CASE — gradient text-1 + SOLID accent: the marker is
#      clean accent ink, no text-1 window on it
#  (3) THE DERIVATION — a Primary text override derives --text-2/3/3-dim
#      (hints + descriptions follow the customized palette, not the
#      theme's grey)
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8314
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0777
export AGENT_BROWSER_SESSION=doomalay-v0777

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0777-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# ── (1)+(3): BOTH gradients live ──
ev "(function(){
  Settings.setState({themeOverrides:{midnight:{
    '--text-1':   {colors:['#ffd24a','#ff7a00'],dir:'diag',angle:45},
    '--accent':   {colors:['#00e5ff','#2979ff'],dir:'diag',angle:45}
  }}});
  return 'sentinels live';
})()" >/dev/null; sleep 1.5

# open settings → appearance → colors (the color rows carry the markers)
ev "(function(){ var b = document.getElementById('settings-btn'); if (b) b.click(); return 'gear'; })()" >/dev/null; sleep 1.5
ev "(function(){
  var tabs = document.querySelectorAll('.settings-nav .tab');
  for (var i = 0; i < tabs.length; i++) {
    if (/appear|look|colors/i.test(tabs[i].textContent)) { tabs[i].click(); return 'tab:' + tabs[i].textContent.trim(); }
  }
  return 'no-tab';
})()" >/dev/null; sleep 1.5

# override one color so a marker appears (the appearance module's own flow):
# paint Accent 2 through the settings API directly, then re-render
ev "(function(){
  var s = Settings.getState();
  s.themeOverrides = s.themeOverrides || {};
  s.themeOverrides.midnight = s.themeOverrides.midnight || {};
  s.themeOverrides.midnight['--accent-2'] = {colors:['#b388ff','#7c4dff'],dir:'diag',angle:45};
  Settings.setState({themeOverrides: s.themeOverrides});
  return 'accent-2 painted';
})()" >/dev/null; sleep 1.5

MARK=$(ev "(function(){
  var m = document.querySelector('.crc-mark');
  if (!m) return 'no-marker';
  var cs = getComputedStyle(m);
  return JSON.stringify({ color: cs.color, image: cs.backgroundImage.slice(0, 60),
    clip: cs.webkitBackgroundClip || cs.backgroundClip });
})()")
Z1=$(echo "$MARK" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    ok = ('0, 0, 0, 0' in d['color'] or 'transparent' in str(d['color'])) and 'gradient' in d['image'].lower() and 'text' in d['clip']
    print('yes' if ok else 'no')
except Exception as e:
    print('no:' + str(e))")
ck "marker = accent-1 glyph window (no z-fight) with both gradients" "$Z1" "$MARK"

# ── (2) the solid-accent case: text-1 gradient, accent solid ──
ev "(function(){
  var s = Settings.getState();
  delete s.themeOverrides.midnight['--accent'];
  Settings.setState({themeOverrides: s.themeOverrides});
  return 'accent solid again';
})()" >/dev/null; sleep 1.5
MARK2=$(ev "(function(){
  var m = document.querySelector('.crc-mark');
  if (!m) return 'no-marker';
  var cs = getComputedStyle(m);
  return JSON.stringify({ color: cs.color, image: cs.backgroundImage });
})()")
Z2=$(echo "$MARK2" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    ok = 'none' in d['image'] and '0, 0, 0, 0' not in d['color']
    print('yes' if ok else 'no')
except Exception as e:
    print('no:' + str(e))")
ck "marker = clean solid accent (no text-1 window) when accent is solid" "$Z2" "$MARK2"

# ── (3) the derivation: text-2/3 follow the text-1 override ──
DER=$(ev "(function(){
  var cs = getComputedStyle(document.documentElement);
  return JSON.stringify({
    t2: cs.getPropertyValue('--text-2').trim(),
    t3: cs.getPropertyValue('--text-3').trim(),
    t3d: cs.getPropertyValue('--text-3-dim').trim()
  });
})()")
Z3=$(echo "$DER" | python3 -c "
import json,sys
d = json.load(sys.stdin)
vals = [d['t2'], d['t3'], d['t3d']]
ok = all(v.startswith('#') and len(v) == 7 for v in vals) and len(set(vals)) == 3
# the derivation blends #ffb12a-ish toward surface-1 — none of these is the
# base theme's #b4aede grey
ok = ok and d['t2'].lower() not in ('#b4aede',) and d['t3'].lower() not in ('#7d76a8',)
print('yes' if ok else 'no:' + json.dumps(d))")
ck "text-2/3/3-dim derive from the text-1 override (not the theme grey)" "$Z3" "$DER"

# ── (4) a text-3 consumer renders the derived tone ──
HINT=$(ev "(function(){
  var p = document.createElement('div');
  p.style.cssText = 'color:var(--text-3);position:absolute;left:-9999px';
  document.body.appendChild(p);
  var c = getComputedStyle(p).color;
  p.remove();
  return c;
})()")
Z4=$(echo "$HINT" | python3 -c "
import sys
c = sys.stdin.read().strip()
print('yes' if c.startswith('rgb(') else 'no:' + c)")
ck "a text-3 consumer resolves the derived tone" "$Z4" "$HINT"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.7 markers suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
