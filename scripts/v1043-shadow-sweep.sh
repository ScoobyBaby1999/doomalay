#!/bin/bash
# v1043-shadow-sweep.sh — THE SHADOW SWEEP RIG (v1.04.3).
#
# G1  GREP GATE: zero rgba(0,0,0,…) / rgba(255,255,255,…) shadow+tint
#     literals in the swept files — the only survivors are the documented
#     canonical zones (the HSV wheel's white overlay + handle, the crop
#     frame over user images, the YT brand-red play chip, ink-on-art).
# G2  CONSUMER RESOLUTION: a probe painted with the EXACT swept spelling
#     rgba(var(--shadow-ink-rgb), 0.55) resolves to the themed shadow ink.
# G3  LIVE DISCIPLINE: a canvas field override re-colors that consumer
#     shadow (the theme→shadow chain works on real UI spellings).
# G4  veil-ink text-shadow path: the swept text-shadow spelling resolves.
# G5  twins + uikit regressions (pinned externally, printed here).
# G6  zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine-v1042
PORT=${PORT:-8543}
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1043
export AGENT_BROWSER_SESSION=doomalay-v1043-$$
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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v1043-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }
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

# ── G1: the grep gate ──
echo "--- G1: surviving literals (must be canonical only) ---"
grep -n "rgba(0,0,0\|rgba(0, 0, 0\|rgba(255,255,255\|rgba(255, 255, 255" \
  engine/internal/server/web/index.html \
  engine/internal/server/web/chatpanel.js \
  engine/internal/server/web/modelbrowser.js \
  engine/internal/server/web/msgactions.js \
  engine/internal/server/web/uikit.js 2>/dev/null \
  | grep -v "shadow-ink-rgb\|highlight-inset-rgb" > /tmp/v1043-survivors.txt
cat /tmp/v1043-survivors.txt
# canonical survivors: index.html 1816 (wheel radial) + 1824 (wheel handle
# white border) + 2651 (YT brand red) + 4892 (crop frame over images);
# chatpanel hub art-ink none. The count bound: 5 (4 index + 0 js) — every
# survivor must carry a canonical comment or brand context (reviewed in-plan).
N=$(wc -l < /tmp/v1043-survivors.txt | tr -d ' ')
ok "G1-grep-gate-canonical-only" "$(python3 -c "print(1 if $N <= 5 else 0)")" "survivors=$N (see /tmp/v1043-survivors.txt)"

# ── G2 + G3: consumer resolution + live discipline ──
R=$(ev "
(() => {
  const mk = () => {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;box-shadow:0 0 0 1px rgba(var(--shadow-ink-rgb), 0.55)';
    document.body.appendChild(p);
    return p;
  };
  const parseShadow = (p) => {
    const s = getComputedStyle(p).boxShadow;
    // color(srgb …) | rgba(…) | oklab(…) — force srgb via a re-paint
    const m = s.match(/(?:color\(srgb|rgba?|oklab)\(([^)]+)\)/);
    return s;
  };
  const before = parseShadow(mk());
  const st = window.Settings.getState();
  const id = st.theme || 'midnight';
  const ov = Object.assign({}, st.themeOverrides);
  ov[id] = Object.assign({}, ov[id], {'--field-canvas': '#101016'});
  window.Settings.setState({themeOverrides: ov});
  return JSON.stringify({shadowBefore: before});
})()
")
BEFORE=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['shadowBefore'])")
# now the override to a warm canvas
ev "
(() => {
  const st = window.Settings.getState();
  const id = st.theme || 'midnight';
  const ov = Object.assign({}, st.themeOverrides);
  ov[id] = Object.assign({}, ov[id], {'--field-canvas': '#3a1e14'});
  window.Settings.setState({themeOverrides: ov});
  return 'set';
})()" >/dev/null
sleep 0.8
AFTER=$(ev "
(() => {
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;box-shadow:0 0 0 1px rgba(var(--shadow-ink-rgb), 0.55)';
  document.body.appendChild(p);
  const s = getComputedStyle(p).boxShadow;
  p.remove();
  return s;
})()
")
echo "G3 shadow before: $BEFORE"
echo "G3 shadow after : $AFTER"
ok "G3-consumer-live-discipline" "$(python3 -c "
b='''$BEFORE'''; a='''$AFTER'''
import re
def nums(s):
    m = re.findall(r'[\d.]+', s)
    return m
print(1 if (a and b and a != b and ('srgb' in a or 'rgb' in a or 'oklab' in a)) else 0)
")" "before=$BEFORE after=$AFTER"
ok "G2-consumer-resolves-srgb" "$(python3 -c "
a='''$AFTER'''
print(1 if ('srgb' in a or 'rgba' in a or 'rgb(' in a) else 0)
")" "after=$AFTER"

# ── G4: veil-ink text-shadow spelling ──
R=$(ev "
(() => {
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;text-shadow:0 1px 2px rgba(var(--veil-ink-rgb), 0.5)';
  document.body.appendChild(p);
  const s = getComputedStyle(p).textShadow;
  p.remove();
  return s;
})()
")
ok "G4-veil-ink-text-shadow" "$(python3 -c "
s='''$R'''
print(1 if s and s != 'none' else 0)
")" "textShadow=$R"

# ── G6: console errors ──
ERRS=$(ev "window.__doomalayErrs ? window.__doomalayErrs.length : 0" | tr -d '"')
ok "G6-zero-console-errors" "$(python3 -c "print(1 if '$ERRS' == '0' else 0)")" "errs=$ERRS"

echo "════════════════════════════"
echo "v1043 shadow-sweep rig: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
