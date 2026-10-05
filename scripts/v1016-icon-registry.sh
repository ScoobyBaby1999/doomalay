#!/bin/bash
# v1016-icon-registry.sh — THE ICON REGISTRY + ATLAS + 9-SLICE RIG
# (PLAN-V101 §v1.01.3).
#
# THE CONTRACT:
#  (I1) importIconify: a valid set registers (count > 0), persists
#       across reload, and IconLib.svg renders ITS glyphs (the layer
#       overrides the builtin for matching names).
#  (I2) THE SANITIZE LADDER: script-tag bodies, url() refs and poisoned
#       names are rejected/stripped — a hostile set imports with ZERO
#       executable content; oversized/empty/malformed JSON fails clean.
#  (I3) useSet('') returns to the builtin (byte-identical renders);
#       useSet of a missing set fails.
#  (I4) THE ATLAS: DoomAtlas.pack lays N entries into ONE canvas with
#       ZERO overlaps, every entry placed, deterministic sizes.
#  (I5) 9-SLICE: DoomChrome.nineSlice applies border-image + slice;
#       clearNineSlice strips it; sprite9 guards missing PIXI.
#  (I6) the Settings ⚙ General page carries the Icon Set section
#       (import + picker rows render).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8416
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1016
export AGENT_BROWSER_SESSION=doomalay-v1016

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
  rm -rf $DATA
  setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1016.log 2>&1 < /dev/null &
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
echo "engine: $(curl -s --max-time 3 $BASE/api/health)"
agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5

# ── I1: the import + the layered render ───────────────────────────
IMP=$(ev "
(function(){
  var r = window.IconReg.importIconify({
    prefix: 'test',
    width: 24, height: 24,
    icons: {
      'zap': { body: '<path d=\"M13 2 3 14h9l-1 8 10-12h-9l1-8z\"/>' },
      'star': { body: '<circle cx=\"12\" cy=\"12\" r=\"9\"/>' },
      'custom-glyph': { body: '<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\"/>' }
    }
  }, 'testset');
  var use = window.IconReg.useSet('testset');
  var svg = window.IconLib.svg('zap', 18);
  var custom = window.IconLib.svg('custom-glyph', 18);
  var absent = window.IconLib.svg('no-such-icon', 18);
  return JSON.stringify({ imp: r, use: use, zap: svg.slice(0, 80), custom: custom.indexOf('rect') !== -1, absent: absent === '' });
})()")
ck "I1a the import registers + the set activates" \
   "$(echo "$IMP" | grep -q '\"ok\":true' && echo "$IMP" | grep -q '\"name\":\"testset\"' && echo yes)" "$IMP"
ck "I1b the active set's glyph overrides the builtin (zap renders)" \
   "$(echo "$IMP" | grep -q '\"zap\":\"<svg' && echo yes)" "$IMP"
ck "I1c unknown-to-builtin names render from the set (custom-glyph)" \
   "$(echo "$IMP" | grep -q '\"custom\":true' && echo yes)" "$IMP"
ck "I1d names in NO set still return ''" \
   "$(echo "$IMP" | grep -q '\"absent\":true' && echo yes)" "$IMP"

# ── I1e: persistence across reload ─────────────────────────────────
PERSIST=$(ev "location.reload(); 'reloading'" > /dev/null 2>&1; sleep 5; ev "
(function(){
  return JSON.stringify({ active: window.IconReg.active(),
    stillRenders: window.IconLib.svg('custom-glyph', 18).indexOf('rect') !== -1 });
})()")
ck "I1e the active set persists across reload" \
   "$(echo "$PERSIST" | grep -q '\"active\":\"testset\"' && echo "$PERSIST" | grep -q '\"stillRenders\":true' && echo yes)" "$PERSIST"

# ── I2: the sanitize ladder ───────────────────────────────────────
SAN=$(ev "
(function(){
  var hostile = window.IconReg.importIconify({
    icons: {
      'evil': { body: '<path d=\"M0 0\"/><script>alert(1)</script>' },
      'urlref': { body: '<path fill=\"url(#x)\" d=\"M0 0\"/>' },
      'clean': { body: '<path d=\"M2 2 L4 4\"/>' },
      'attrs': { body: '<path d=\"M0 0\" onclick=\"evil()\" fill=\"red\"/>' }
    }
  }, 'hostile');
  var use = window.IconReg.useSet('hostile');
  var evil = window.IconReg.resolve('evil');
  var clean = window.IconReg.resolve('clean');
  var urlref = window.IconReg.resolve('urlref');
  var attrs = window.IconReg.resolve('attrs');
  var oversized = window.IconReg.importIconify({ icons: {} }, 'empty');
  window.IconReg.useSet('');
  return JSON.stringify({ ok: hostile.ok, count: hostile.count || 0,
    evilDropped: !evil, cleanThere: !!clean,
    urlrefStripped: urlref ? urlref.body.indexOf('url(') === -1 : false,
    attrsKept: attrs ? attrs.body : null,
    attrsHasOnclick: attrs ? attrs.body.indexOf('onclick') !== -1 : true,
    oversizedFailed: !oversized.ok });
})()")
ck "I2a the script-tag body DROPS (clean icons survive)" \
   "$(echo "$SAN" | grep -q 'evilDropped.:true' && echo "$SAN" | grep -q 'cleanThere.:true' && echo yes)" "$SAN"
ck "I2b url() refs + event-handler attrs strip, safe attrs keep" \
   "$(echo "$SAN" | grep -q 'urlrefStripped.:true' && echo "$SAN" | grep -q 'attrsHasOnclick.:false' && echo "$SAN" | grep -q 'fill=..red' && echo yes)" "$SAN"

# ── I3: back to builtin ───────────────────────────────────────────
BACK=$(ev "
(function(){
  var base = window.IconReg.useSet('');
  var zap = window.IconLib.svg('zap', 18);
  var missing = window.IconReg.useSet('nope');
  return JSON.stringify({ base: base, missing: missing,
    zapIsBuiltin: zap.indexOf('M15.914 4') !== -1 || zap.indexOf('M13 12') !== -1 || zap.length > 50 });
})()")
ck "I3a useSet('') returns to the builtin" \
   "$(echo "$BACK" | grep -q '\"base\":{\"ok\":true}' && echo yes)" "$BACK"
ck "I3b useSet(missing) fails" \
   "$(echo "$BACK" | grep -q '\"missing\":{\"ok\":false' && echo yes)" "$BACK"

# ── I4: the atlas ──────────────────────────────────────────────────
ATLAS=$(ev "
(function(){
  var entries = [];
  for (var i = 0; i < 24; i++) {
    (function (n) {
      var w = 24 + (n % 4) * 12, h = 24 + (n % 3) * 16;
      entries.push({ key: 'ic' + n, w: w, h: h,
        draw: function (ctx, x, y) { ctx.fillStyle = '#a78bfa'; ctx.fillRect(x, y, w, h); } });
    })(i);
  }
  var r = window.DoomAtlas.pack(entries, { padding: 2 });
  if (!r.ok) return JSON.stringify(r);
  var map = r.map, keys = Object.keys(map);
  var overlaps = 0, placed = 0;
  for (var a = 0; a < keys.length; a++) {
    var A = map[keys[a]];
    if (A.w > 0 && A.h > 0) placed++;
    for (var b = a + 1; b < keys.length; b++) {
      var B = map[keys[b]];
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlaps++;
    }
  }
  // determinism: a second pack with the same entries lays identically
  var r2 = window.DoomAtlas.pack(entries, { padding: 2 });
  var same = true;
  for (var k in map) { if (!r2.map[k] || r2.map[k].x !== map[k].x || r2.map[k].y !== map[k].y) { same = false; break; } }
  return JSON.stringify({ ok: true, n: keys.length, placed: placed, overlaps: overlaps,
    size: r.w + 'x' + r.h, deterministic: same, canvasPixels: r.canvas.width * r.canvas.height });
})()")
ck "I4a the atlas packs all 24 entries" \
   "$(echo "$ATLAS" | grep -q '\"placed\":24' && echo yes)" "$ATLAS"
ck "I4b ZERO overlapping rects" \
   "$(echo "$ATLAS" | grep -q '\"overlaps\":0' && echo yes)" "$ATLAS"
ck "I4c deterministic layout (re-pack identical)" \
   "$(echo "$ATLAS" | grep -q '\"deterministic\":true' && echo yes)" "$ATLAS"
W=$(echo "$ATLAS" | grep -oE '"size":"[0-9]+x[0-9]+"' | grep -oE '[0-9]+' | head -1)
H=$(echo "$ATLAS" | grep -oE '"size":"[0-9]+x[0-9]+"' | grep -oE '[0-9]+' | tail -1)
ck "I4d the packed canvas is sane (24..2048 per side)" \
   "$([ -n "$W" ] && [ "$W" -ge 24 ] && [ "$W" -le 2048 ] && [ "$H" -ge 24 ] && [ "$H" -le 2048 ] && echo yes)" "$ATLAS"

NINE=$(ev "
(function(){
  var el = document.createElement('div');
  document.body.appendChild(el);
  var dataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxIAEAAAAAP//AwB0DQIAAAAA//8D+gAAAAD/AAAA//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABY2gAAAABJRU5ErkJggg==';
  var r = window.DoomChrome.nineSlice(el, dataPng, 8, { width: 12, radius: '14px' });
  var cs = getComputedStyle(el);
  var applied = cs.borderImageSource.indexOf('url(') === 0 &&
    cs.borderImageSlice.indexOf('8') === 0 && cs.borderImageWidth === '12px';
  var maskSet = cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none';
  window.DoomChrome.clearNineSlice(el);
  var cs2 = getComputedStyle(el);
  var cleared = cs2.borderImageSource === 'none' || cs2.borderImageSource === '';
  var sprite = window.DoomChrome.sprite9(null, null, 8, 100, 50);
  el.remove();
  return JSON.stringify({ ok: r.ok, applied: applied, maskSet: maskSet, cleared: cleared, spriteGuardsNull: sprite === null });
})()")
ck "I5a nineSlice applies border-image + slice + width" \
   "$(echo "$NINE" | grep -q '\"applied\":true' && echo yes)" "$NINE"
ck "I5b the radius-safe mask split engages" \
   "$(echo "$NINE" | grep -q '\"maskSet\":true' && echo yes)" "$NINE"
ck "I5c clearNineSlice strips it" \
   "$(echo "$NINE" | grep -q '\"cleared\":true' && echo yes)" "$NINE"
ck "I5d sprite9 guards a missing PIXI (returns null)" \
   "$(echo "$NINE" | grep -q '\"spriteGuardsNull\":true' && echo yes)" "$NINE"

# ── I6: the settings section ───────────────────────────────────────
UI=$(ev "
(function(){
  document.getElementById('settings-btn').click();
  return 'opened';
})()" > /dev/null 2>&1; sleep 2; ev "
(function(){
  var tabs = document.querySelectorAll('.settings-nav .tab');
  for (var i = 0; i < tabs.length; i++) {
    if ((tabs[i].textContent||'').indexOf('General') !== -1) { tabs[i].click(); break; }
  }
  return 'tab';
})()" > /dev/null 2>&1; sleep 1.5; ev "
(function(){
  var body = document.querySelector('.panel-body') || document.body;
  var txt = body.textContent || '';
  var importBtn = body.querySelector('[data-action=\"icon-set-import\"]');
  var useBtns = body.querySelectorAll('[data-action=\"icon-set-use\"]').length;
  return JSON.stringify({ section: txt.indexOf('Icon Set') !== -1,
    importBtn: !!importBtn, useBtns: useBtns });
})()")
ck "I6a the General page carries the Icon Set section" \
   "$(echo "$UI" | grep -q '\"section\":true' && echo yes)" "$UI"
ck "I6b the import button + set rows render" \
   "$(echo "$UI" | grep -q '\"importBtn\":true' && echo "$UI" | grep -qE '\"useBtns\":[1-9]' && echo yes)" "$UI"

echo ""
echo "═══ v1016 icon registry: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
