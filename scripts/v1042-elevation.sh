#!/bin/bash
# v1042-elevation.sh — THE ELEVATION TOKEN RIG (v1.04.2).
#
# Proves the shadow-ink token system end-to-end:
#   T1  --shadow-ink is declared (the CSS derivation is live).
#   T2  CSS≡JS PARITY: a probe painted with var(--shadow-ink) resolves
#       (computed box-shadow) to the SAME rgb the JS triplet carries
#       (the v0.99.4 culori-parity contract, extended to elevation).
#   T3  THEME-TINTED: the triplet CHANGES per theme (midnight vs paper
#       resolve different canvases → different shadow ink) — via the
#       REAL pipeline (Settings.setState → Settings.onChange→applyTheme).
#   T4  THE DISCIPLINE PROOF: a LIVE canvas field override re-derives
#       the triplet (shadows follow user theming, like every triplet).
#   T5  CONSUMER DRIFT BOUND: on midnight the themed shadow stays
#       near-black (≤ 9/255 per channel vs the literal rgba(0,0,0) era).
#   T6  zero console errors through all of it.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine-v1042
PORT=${PORT:-8542}
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1042
# v1042b: a UNIQUE browser session per run — the agent-browser profile
# outlives the engine (localStorage + HTTP cache), and a stale page made
# T1/T2 lie (the repo landmine: 'the browser session outlives the server').
export AGENT_BROWSER_SESSION=doomalay-v1042-$$
ev() { timeout 90 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, dict): v = v.get('data',{}).get('result', v)
    if isinstance(v, list) and len(v) == 1: v = v[0]
    print(v, end='')
except Exception: print(s, end='')"; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v1042-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; tail -20 /tmp/v1042-eng.log; exit 1; }
agent-browser close >/dev/null 2>&1; sleep 0.5
agent-browser open "$BASE" >/dev/null 2>&1
RD=""
for i in $(seq 1 80); do
  RD=$(timeout 10 agent-browser eval "window.__doomalayReady === true" 2>/dev/null | tr -d '"')
  [ "$RD" = "true" ] && break
  sleep 0.25
done
[ "$RD" = "true" ] && echo "app ready" || { echo "APP BOOT TIMEOUT"; exit 1; }

PASS=0; FAIL=0
ok(){ if [ "$2" = "1" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 :: $3"; FAIL=$((FAIL+1)); fi; }

# ── T1: --shadow-ink declared ──
R=$(ev "!!getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink').trim()")
R=$(echo "$R" | tr 'TF' 'tf')   # python json prints True/False
[ "$R" = "true" ] && R=1 || R=0
ok "T1-shadow-ink-declared" "$R" "missing --shadow-ink"

# ── T2: CSS ≡ JS parity (painted probe) ──
R=$(ev "
(() => {
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;background:color-mix(in srgb, var(--shadow-ink) 100%, transparent)';
  document.body.appendChild(p);
  const cssRaw = getComputedStyle(p).backgroundColor;
  p.style.background = 'color-mix(in srgb, ' + (function(){ const t = getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim().split(',').map(s=>parseInt(s.trim())); return '#'+t.map(n=>n.toString(16).padStart(2,'0')).join(''); })() + ' 100%, transparent)';
  const triRaw = getComputedStyle(p).backgroundColor;
  p.remove();
  // normalize color(srgb f f f) | rgb(r,g,b) → [r,g,b] 0-255
  const parse = (s) => {
    let m = s.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
    if (m) return m.slice(1).map(Number).map(x => Math.round(x*255));
    m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return m.slice(1).map(Number);
    return null;
  };
  const fm = window.DoomTheme && window.DoomTheme.fieldMath;
  const canvasHex = window.DoomTheme.resolvedThemeVar('--field-canvas');
  const jsMix = (fm && canvasHex) ? fm.cssMix(canvasHex, '#000000', 0.55) : null;
  return JSON.stringify({css: parse(cssRaw), triRaw: parse(triRaw), jsMix, canvasHex});
})()
")
echo "T2 detail: $R"
ok "T2-css-js-parity" "$(python3 -c "
import json
try:
    d = json.loads('''$R''')
    css = d.get('css'); tri = d.get('triRaw')
    jshex = (d.get('jsMix') or '').lstrip('#')
    js = [int(jshex[i:i+2],16) for i in (0,2,4)] if len(jshex)==6 else None
    okv = css and tri and js and all(abs(a-b)<=1 for a,b in zip(css,tri)) and all(abs(a-b)<=1 for a,b in zip(css,js))
    print(1 if okv else 0)
except Exception:
    print(0)
")" "R=$R"

# ── T3: theme-tinted triplet (the REAL switch path) ──
MID=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim()")
ev "window.Settings.setState({theme:'paper'}); 'ok'" >/dev/null
sleep 0.8
PAP=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim()")
ok "T3-theme-tinted-triplet" "$(python3 -c "print(1 if '$MID' != '$PAP' and '$PAP' != '' else 0)")" "midnight=$MID paper=$PAP"

# ── T5 (before T4's override pollutes state): midnight drift bound ──
ev "window.Settings.setState({theme:'midnight'}); 'ok'" >/dev/null
sleep 0.8
R=$(ev "
(() => {
  const [r,g,b] = getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim().split(',').map(s => parseInt(s.trim()));
  return JSON.stringify({r,g,b, drift: Math.max(r||0,g||0,b||0)});
})()
")
ok "T5-consumer-drift-bound" "$(python3 -c "
import json
try:
    d = json.loads('''$R''')
    print(1 if d.get('drift', 99) <= 9 else 0)
except Exception:
    print(0)
")" "R=$R (midnight must stay near-black)"

# ── T4: LIVE canvas override → triplet follows (the discipline proof) ──
BEFORE=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim()")
R=$(ev "
(() => {
  const st = window.Settings.getState();
  const id = st.theme || 'midnight';
  const ov = Object.assign({}, st.themeOverrides);
  ov[id] = Object.assign({}, ov[id], {'--field-canvas': '#3a1e14'});
  window.Settings.setState({themeOverrides: ov});
  return 'set';
})()
")
sleep 0.8
AFTER=$(ev "getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink-rgb').trim()")
ok "T4-live-edit-follows" "$(python3 -c "print(1 if '$BEFORE' != '$AFTER' and '$AFTER' != '' else 0)")" "before=$BEFORE after=$AFTER"
echo "T4 detail: before=$BEFORE after=$AFTER (canvas override #3a1e14 = warm dark red)"

# ── T6: console errors ──
ERRS=$(ev "window.__doomalayErrs ? window.__doomalayErrs.length : 0" | tr -d '"')
ok "T6-zero-console-errors" "$(python3 -c "print(1 if '$ERRS' == '0' else 0)")" "errs=$ERRS"

echo "════════════════════════════"
echo "v1042 elevation rig: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
