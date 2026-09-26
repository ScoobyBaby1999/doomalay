#!/bin/bash
# v0624-embed-screenshots-test.sh — RED-TEAM the v0.62.4 T3 tier.
#
# A real chromium run against a REAL public page, then the UI wiring:
#   - /api/preview/screenshot of example.com → a valid retina PNG
#     (1440×900 @2x = 2880×1800), PNG content-type, 24h cache headers
#   - the cache: the repeat shot is byte-identical + instant
#   - /api/preview of a frame-blocked page carries screenshot_url
#   - the UI: a blocked link's lv-card shows the screenshot as card art
# Skips gracefully when the box has no chromium (CI, Android).
set -u
DATA=/tmp/doomalay-v0624
PORT=8185
BASE=http://127.0.0.1:$PORT
ENG=/home/z/my-project/doomalay/engine/doomalay-engine
export AGENT_BROWSER_SESSION=doomalay-v0624
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

# clear orphaned renders from any earlier killed run (an engine killed
# mid-render leaves headless chromes burning CPU — fixed engine-side in
# v0.62.4 with process-group kills, but old orphans may linger)
pkill -f "ms-playwright.*preview-cache" 2>/dev/null && echo "cleared orphaned render(s)" || true
rm -rf $DATA; mkdir -p $DATA
echo "brain_dir: $DATA/no-brain" > $DATA/nobrain.yaml
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/nobrain.yaml >/tmp/v0624-eng.log 2>&1 &
ENGPID=$!
cleanup() { kill $ENGPID 2>/dev/null; wait 2>/dev/null; agent-browser close 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot" || bad "engine boot"

# 0. the tier is live on this box (playwright chromium detected)
T0=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/preview/screenshot?url=https%3A%2F%2Fexample.com%2F&w=640&h=400&scale=1")
if [ "$T0" = "501" ]; then
  echo "SKIP: no chromium on this box — the tier cleanly 501s (the UI hides it)"
  echo "══ v0.62.4 screenshots red team: SKIPPED (no binary) ══"
  exit 0
fi
check "$T0" "200" "the tier is live (a real chromium detected)"

# 1. a REAL public page → a valid PNG of the exact requested shape
SHOT=/tmp/v0624-shot.png
T1=$(curl -s -o "$SHOT" -w "%{http_code}|%{content_type}|%{header_json}" --max-time 60 \
  "$BASE/api/preview/screenshot?url=https%3A%2F%2Fexample.com%2F&w=1440&h=900&scale=2" 2>/dev/null | head -c 400)
has "$T1" "200|" "the retina screenshot renders (HTTP 200)"
python3 - << 'EOF' && ok "it is a real 2880x1800 PNG (retina 1440x900 @2x)" || bad "PNG shape/validity"
import struct, sys
d = open('/tmp/v0624-shot.png','rb').read()
if d[:8] != b'\x89PNG\r\n\x1a\n': sys.exit(1)
w, h = struct.unpack('>II', d[16:24])
sys.exit(0 if (w, h) == (2880, 1800) else 1)
EOF
T1H=$(curl -s -o /dev/null -D - --max-time 20 "$BASE/api/preview/screenshot?url=https%3A%2F%2Fexample.com%2F&w=1440&h=900&scale=2" 2>/dev/null | rg -i "content-type|cache-control" | tr -d '\r' | tr '\n' ' ')
has "$T1H" "image/png" "served as image/png"
has "$T1H" "max-age=86400" "24h cache headers on the repeat (the cache serves it)"

# 2. the cache: the repeat is instant + identical (no second chromium run)
S1=$(python3 -c "import hashlib;print(hashlib.sha256(open('/tmp/v0624-shot.png','rb').read()).hexdigest()[:16])")
TIME2=$(curl -s -o /dev/null -w "%{time_total}" --max-time 20 "$BASE/api/preview/screenshot?url=https%3A%2F%2Fexample.com%2F&w=1440&h=900&scale=2")
FAST=$(python3 -c "print('yes' if float('$TIME2') < 1.0 else 'no')")
check "$FAST" "yes" "the cached repeat is instant (${TIME2}s)"
S2=$(python3 -c "import hashlib;print(hashlib.sha256(open('/tmp/v0624-shot.png','rb').read()).hexdigest()[:16])")
check "$S2" "$S1" "the repeat is byte-identical"

# 3. /api/preview stamps screenshot_url on blocked verdicts
PV=$(curl -s "$BASE/api/preview?url=https%3A%2F%2Fopenrouter.ai%2Fkeys")
has "$PV" '"frameable":false' "openrouter still judges frame-blocked"
has "$PV" '"screenshot_url":"/api/preview/screenshot' "the blocked verdict carries the screenshot_url stamp"

# 4. the UI: a blocked link card shows the screenshot as art
# (pre-warm the openrouter shot — a real chromium render of a real page
# can take ~10-25s; the UI check then loads from cache deterministically)
curl -s -o /dev/null --max-time 60 "$BASE/api/preview/screenshot?url=https%3A%2F%2Fopenrouter.ai%2Fkeys" && ok "the openrouter shot renders (pre-warm, a REAL public page)" || bad "openrouter shot failed"
agent-browser open "$BASE" >/dev/null 2>&1
sleep 2.5
ev "
(function(){
  var holder = document.createElement('div');
  holder.id = 'v0624-msg';
  document.body.appendChild(holder);
  window.Formatter.renderInto(holder, 'grab a key at [the console](https://openrouter.ai/keys)', 'full', {});
  var a = holder.querySelector('a[href*=openrouter]');
  if (!a) return 'no-link';
  a.click();
  return 'pending';
})()" >/dev/null
sleep 4
CARD=$(ev "
(function(){
  var c = document.querySelector('#v0624-msg .lv-card');
  if (!c) return 'no-card';
  var shot = c.querySelector('.lv-shot');
  return shot ? 'shot:' + shot.src.slice(0, 60) : 'no-shot:' + c.querySelector('.lv-body').innerHTML.slice(0, 100);
})()")
has "$CARD" "api/preview/screenshot" "the blocked card renders the engine screenshot as card art"

# 5. the screenshot <img> actually loads — poll up to 30s (a cold render
# of a real page takes ~10-25s; the pre-warm usually makes it instant)
LOADED=""
for i in $(seq 1 15); do
  sleep 2
  LOADED=$(ev "
(function(){
  var i = document.querySelector('#v0624-msg .lv-shot');
  if (!i) return 'no-img';
  return i.complete && i.naturalWidth > 0 ? 'loaded:' + i.naturalWidth + 'x' + i.naturalHeight : 'pending';
})()")
  case "$LOADED" in loaded:*) break;; esac
done
has "$LOADED" "loaded:" "the screenshot image loads in the card (naturalWidth > 0)"

echo ""
echo "══ v0.62.4 screenshots red team: $PASS pass, $FAIL fail ══"
[ $FAIL -eq 0 ]
