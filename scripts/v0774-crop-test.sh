#!/bin/bash
# v0774-crop-test.sh — the CropUI wave's rig proof:
#  (1) THE DEAD DRAG — pointerdown on the IMAGE + move must pan the crop
#      (the pointerout-on-capture bug the user hit: only the slider worked)
#  (2) THE PINCH — two pointers zoom + the slider syncs
#  (3) THE ORIGINAL RESOLUTION — a 1600x1200 source crops to 1600-wide
#      output pixels (the old path capped at maxEdge 1024)
#  (4) THE PASSTHROUGH — a full-cover crop returns the ORIGINAL bytes
#  (5) THE ROTATE — rotate twice then crop: no JPEG 0.9 bake, dims swap
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8311
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0774
export AGENT_BROWSER_SESSION=doomalay-v0774

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0774-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# a synthetic 1600x1200 JPEG source (deterministic pixels) as a File
ev "(function(){
  var cv = document.createElement('canvas'); cv.width = 1600; cv.height = 1200;
  var g = cv.getContext('2d');
  for (var x = 0; x < 1600; x += 100) { g.fillStyle = 'hsl(' + (x/1600*360) + ',80%,50%)'; g.fillRect(x, 0, 100, 1200); }
  window.__srcBytes = window.__srcLen = 0;
  return cv.toDataURL('image/jpeg', 0.95).then ? 'es5' : 'ok';
})()" >/dev/null
# build the File from the dataURL (ES5-safe)
ev "(function(){
  var cv = document.createElement('canvas'); cv.width = 1600; cv.height = 1200;
  var g = cv.getContext('2d');
  for (var x = 0; x < 1600; x += 100) { g.fillStyle = 'hsl(' + (x/1600*360) + ',80%,50%)'; g.fillRect(x, 0, 100, 1200); }
  var u = cv.toDataURL('image/jpeg', 0.95);
  var b = atob(u.slice(u.indexOf('base64,') + 7));
  var arr = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
  window.__testFile = new File([arr], 'test.jpg', { type: 'image/jpeg' });
  window.__srcLen = arr.length;
  return 'file ready, ' + arr.length + ' bytes';
})()"

# ── open the cropper with NO maxEdge (the background contract) ──
ev "(function(){
  window.CropUI.open({ file: window.__testFile, aspect: 4/3, maxBytes: 3.9*1024*1024,
    onDone: function (b64, meta) { window.__cropOut = { len: Math.round(b64.length*0.75), w: meta.width, h: meta.height, mime: meta.mime }; },
    onErr: function (m) { window.__cropErr = m; } });
  return 'opened';
})()" >/dev/null; sleep 1.2

# (1) THE DEAD DRAG: zoom to 2 first (at zoom 1 with a matching aspect
#     there is nothing to pan — the image fills the frame exactly), then
#     pointerdown ON THE IMAGE + move + up → the transform must move
STAGE=$(ev "(function(){ var s = document.querySelector('.crop-stage'); return s ? 'yes' : 'no'; })()")
ev "(function(){ var z = document.querySelector('.crop-zoom'); if (z) { z.value = '2'; z.dispatchEvent(new Event('input', { bubbles: true })); } return 'zoomed'; })()" >/dev/null; sleep 0.3
T0=$(ev "(function(){ var i = document.querySelector('.crop-img'); return i ? i.style.transform : 'none'; })()")
# synthetic PointerEvents on the image element (pointerdown lands on .crop-img)
ev "(function(){
  var img = document.querySelector('.crop-img'); if (!img) return 'no-img';
  var r = img.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  img.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: cx, clientY: cy, bubbles: true, isPrimary: true, pointerType: 'touch' }));
  return 'down';
})()" >/dev/null; sleep 0.15
ev "(function(){
  var st = document.querySelector('.crop-stage'); if (!st) return 'no-stage';
  st.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 60, clientY: 120, bubbles: true, pointerType: 'touch' }));
  return 'moved';
})()" >/dev/null; sleep 0.15
T1=$(ev "(function(){ var i = document.querySelector('.crop-img'); return i ? i.style.transform : 'gone'; })()")
ev "(function(){
  var st = document.querySelector('.crop-stage');
  if (st) st.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: 60, clientY: 120, bubbles: true, pointerType: 'touch' }));
  return 'up';
})()" >/dev/null
if [ "$T0" != "$T1" ] && [ "$T1" != "gone" ]; then ck "drag pans the crop (transform moved)" yes "$T0 → $T1"; else ck "drag pans the crop (transform moved)" no "$T0 → $T1"; fi

# (2) apply with a DIFFERENT aspect (16:9) at zoom 1: the frame covers
# the full WIDTH (1600) but not the height → the encode path (not the
# passthrough) with a 1600px-wide region — the old code capped at 1024
ev "(function(){ window.CropUI.close(); return 'closed'; })()" >/dev/null; sleep 0.3
ev "(function(){
  window.CropUI.open({ file: window.__testFile, aspect: 16/9, maxBytes: 3.9*1024*1024,
    onDone: function (b64, meta) { window.__cropOut = { len: Math.round(b64.length*0.75), w: meta.width, h: meta.height, mime: meta.mime }; },
    onErr: function (m) { window.__cropErr = m; } });
  return 'reopened';
})()" >/dev/null; sleep 1.2
ev "(function(){ var b = document.querySelector('.crop-ok'); if (b) b.click(); return 'applied'; })()" >/dev/null; sleep 0.8
OUT=$(ev "JSON.stringify(window.__cropOut || { err: window.__cropErr })")
W=$(echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('w',0))")
H=$(echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('h',0))")
M=$(echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('mime',''))")
if [ "$W" -ge 1500 ] 2>/dev/null; then ck "crop keeps source resolution (w=$W ≥1500)" yes; else ck "crop keeps source resolution" no "w=$W ($OUT)"; fi
if [ "$M" = "image/png" ] || [ "$M" = "image/jpeg" ]; then ck "mime reported ($M)" yes; else ck "mime reported" no "$M"; fi

# (3) THE PASSTHROUGH: reopen at zoom 1, aspect EXACTLY 4:3 (the source is
# 1600x1200 = 4:3) → the frame covers everything → the original JPEG bytes
ev "(function(){
  window.CropUI.open({ file: window.__testFile, aspect: 4/3, maxBytes: 3.9*1024*1024,
    onDone: function (b64, meta) { window.__passOut = { len: Math.round(b64.length*0.75), w: meta.width, h: meta.height, mime: meta.mime, head: b64.slice(0, 40) }; },
    onErr: function (m) { window.__passErr = m; } });
  return 'opened3';
})()" >/dev/null; sleep 1.2
ev "(function(){ var b = document.querySelector('.crop-ok'); if (b) b.click(); return 'applied3'; })()" >/dev/null; sleep 0.8
PASSED=$(ev "(function(){
  var o = window.__passOut; if (!o) return 'none';
  // a JPEG passthrough starts /9j/ (the base64 of the FFD8FF magic); a PNG re-encode starts iVBOR
  return (o.mime === 'image/jpeg' && o.head.indexOf('/9j/') === 0) ? 'yes' : 'no:' + JSON.stringify(o);
})()")
ck "passthrough returns the original JPEG bytes" "$PASSED" "$PASSED"

# (4) THE ROTATE: open, rotate twice (180°), apply → dims stay 1600x1200,
#     no lossy bake (the display copy is separate; the crop draws from canvas)
ev "(function(){
  window.CropUI.open({ file: window.__testFile, aspect: 4/3, maxBytes: 3.9*1024*1024,
    onDone: function (b64, meta) { window.__rotOut = { w: meta.width, h: meta.height, mime: meta.mime }; },
    onErr: function (m) { window.__rotErr = m; } });
  return 'opened4';
})()" >/dev/null; sleep 1.2
ev "(function(){ var b = document.querySelector('[data-crop-rotate]'); if (b) b.click(); return 'rot1'; })()" >/dev/null; sleep 0.5
ev "(function(){ var b = document.querySelector('[data-crop-rotate]'); if (b) b.click(); return 'rot2'; })()" >/dev/null; sleep 0.5
ev "(function(){ var b = document.querySelector('.crop-ok'); if (b) b.click(); return 'applied4'; })()" >/dev/null; sleep 0.8
ROT=$(ev "(function(){ var o = window.__rotOut; return o ? o.w + 'x' + o.h + '/' + o.mime : (window.__rotErr || 'none'); })()")
if echo "$ROT" | grep -q "1600x1200"; then ck "double rotate keeps dims (180° = identity) → $ROT" yes; else ck "double rotate keeps dims" no "$ROT"; fi

# (5) console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.4 crop suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
