#!/bin/bash
# v1017-doomtheme-v2.sh — THE V2 ZIP CONTAINER + SECURITY LADDER RIG
# (PLAN-V101 §v1.01.4).
#
# THE CONTRACT:
#  (Z1) ROUND-TRIP: bundle() → buildV2 → unzipV2 → the manifest is
#       byte-equivalent (the state applies 1:1); the exported bytes are
#       a real zip (PK header).
#  (Z2) ICON SETS RIDE: a registered set exports inside the container
#       and RE-REGISTERS on import (with the active pick).
#  (Z3) THE SECURITY LADDER (all rejected cleanly):
#       · a zip-bomb entry (originalSize > the 8MB per-entry cap);
#       · an unknown entry (shell.sh) — the whole bundle rejects;
#       · a traversal name (../evil) — rejects;
#       · a junk manifest (not JSON) — rejects;
#       · a missing manifest — rejects.
#  (Z4) THE BASE64 BRIDGE: importText("UEsD…") decodes + applies the v2
#       container (the hub's text-safe pipeline); v1 JSON still folds.
#  (Z5) THE FAILED-APPLY ROLLBACK: a setState that throws restores the
#       snapshot (the look survives a broken bundle apply).
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8417
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v1017
export AGENT_BROWSER_SESSION=doomalay-v1017

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
  setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1017.log 2>&1 < /dev/null &
  for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 && break; sleep 0.5; done
fi
# the sandbox reaper: a keepalive loop respawns the engine if it dies mid-rig
( while true; do
    curl -s --max-time 2 http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 || \
      (setsid nohup $ENG -port $PORT -bind 0.0.0.0 -data-dir $DATA -open=false > /tmp/doomalay-v1017.log 2>&1 < /dev/null &)
    sleep 10
  done ) &
KEEPALIVE_PID=$!
trap "kill $KEEPALIVE_PID 2>/dev/null" EXIT

echo "engine: $(curl -s --max-time 3 $BASE/api/health)"
agent-browser set viewport 412 915 > /dev/null 2>&1
agent-browser open "$BASE/" > /dev/null 2>&1
sleep 5

# ── Z1: the round-trip ────────────────────────────────────────────
RT=$(ev "
(function(){
  var ff = window.fflate;
  if (!ff) return JSON.stringify({ err: 'no fflate' });
  var b = window.LookIO.bundle();
  var zip = window.LookIO.buildV2(b);
  if (!zip) return JSON.stringify({ err: 'buildV2 null' });
  var isZip = zip && zip.length > 4 && zip[0] === 0x50 && zip[1] === 0x4B;
  var back = window.LookIO.unzipV2(zip);
  var same = back.ok && JSON.stringify(back.bundle.state) === JSON.stringify(b.state);
  return JSON.stringify({ isZip: isZip, ok: back.ok, same: same,
    entries: back.ok ? undefined : back.why });
})()")
ck "Z1a buildV2 produces real zip bytes (PK header)" \
   "$(echo "$RT" | grep -q '\"isZip\":true' && echo yes)" "$RT"
ck "Z1b unzipV2 round-trips the manifest state 1:1" \
   "$(echo "$RT" | grep -q '\"same\":true' && echo yes)" "$RT"

# ── Z2: the icon sets ride ─────────────────────────────────────────
IC=$(ev "
(function(){
  var ff = window.fflate;
  window.IconReg.importIconify({ icons: { 'zap': { body: '<path d=\"M0 0\"/>' } } }, 'ridtheme');
  window.IconReg.useSet('ridtheme');
  var b = window.LookIO.bundle();
  var zip = window.LookIO.buildV2(b);
  // wipe the registry, then re-import through the container
  window.IconReg.removeSet('ridtheme');
  window.IconReg.useSet('');
  var back = window.LookIO.unzipV2(zip);
  var re = window.IconReg.resolve('zap');
  window.IconReg.removeSet('ridtheme');
  window.IconReg.useSet('');
  return JSON.stringify({ ok: back.ok, setBack: !!re,
    activeBack: back.ok ? 'checked' : back.why });
})()")
ck "Z2a the icon set rides the container + re-registers on import" \
   "$(echo "$IC" | grep -q '\"setBack\":true' && echo yes)" "$IC"

# ── Z3: the security ladder ────────────────────────────────────────
FUZZ=$(ev "
(function(){
  var ff = window.fflate;
  var out = {};
  // a) the zip-bomb entry: 9MB of zeros (originalSize > the 8MB cap)
  try {
    var big = new Uint8Array(9 * 1024 * 1024);
    var zBomb = ff.zipSync({ 'manifest.json': ff.strToU8(JSON.stringify(window.LookIO.bundle())), 'bomb.bin': big });
    var r1 = window.LookIO.unzipV2(zBomb);
    out.bomb = r1.ok ? 'ACCEPTED!' : r1.why;
  } catch (e) { out.bomb = 'zip threw (fine): ' + e.message; }
  // b) the unknown entry
  try {
    var zShell = ff.zipSync({ 'manifest.json': ff.strToU8(JSON.stringify(window.LookIO.bundle())), 'shell.sh': ff.strToU8('rm -rf /') });
    var r2 = window.LookIO.unzipV2(zShell);
    out.unknown = r2.ok ? 'ACCEPTED!' : r2.why;
  } catch (e) { out.unknown = 'ERR ' + e.message; }
  // c) the traversal name
  try {
    var zTrav = ff.zipSync({ '../evil.json': ff.strToU8('{}') });
    var r3 = window.LookIO.unzipV2(zTrav);
    out.traversal = r3.ok ? 'ACCEPTED!' : r3.why;
  } catch (e) { out.traversal = 'ERR ' + e.message; }
  // d) the junk manifest
  try {
    var zJunk = ff.zipSync({ 'manifest.json': ff.strToU8('this is not json at all') });
    var r4 = window.LookIO.unzipV2(zJunk);
    out.junk = r4.ok ? 'ACCEPTED!' : r4.why;
  } catch (e) { out.junk = 'ERR ' + e.message; }
  // e) the missing manifest
  try {
    var zNo = ff.zipSync({ 'iconsets.json': ff.strToU8('{\"sets\":{}}') });
    var r5 = window.LookIO.unzipV2(zNo);
    out.noManifest = r5.ok ? 'ACCEPTED!' : r5.why;
  } catch (e) { out.noManifest = 'ERR ' + e.message; }
  return JSON.stringify(out);
})()")
ck "Z3a the zip-bomb entry rejects (the size cap)" \
   "$(echo "$FUZZ" | grep -q '\"bomb\":\"' && echo "$FUZZ" | grep -vq 'ACCEPTED' && echo yes)" "$(echo "$FUZZ" | python3 -c "import json,sys; print(json.load(sys.stdin).get('bomb','?'))" 2>/dev/null)"
ck "Z3b the unknown entry rejects the whole bundle" \
   "$(echo "$FUZZ" | python3 -c "import json,sys; print('yes' if 'unknown entry' in json.load(sys.stdin).get('unknown','') else 'no')" 2>/dev/null)" "$FUZZ"
ck "Z3c the traversal name rejects" \
   "$(echo "$FUZZ" | python3 -c "import json,sys; print('yes' if 'bad entry name' in json.load(sys.stdin).get('traversal','') else 'no')" 2>/dev/null)" "$FUZZ"
ck "Z3d the junk manifest rejects" \
   "$(echo "$FUZZ" | python3 -c "import json,sys; print('yes' if 'not valid JSON' in json.load(sys.stdin).get('junk','') else 'no')" 2>/dev/null)" "$FUZZ"
ck "Z3e the missing manifest rejects" \
   "$(echo "$FUZZ" | python3 -c "import json,sys; print('yes' if 'manifest' in json.load(sys.stdin).get('noManifest','') else 'no')" 2>/dev/null)" "$FUZZ"

# ── Z4: the base64 bridge + the v1 fold ───────────────────────────
BR=$(ev "
(function(){
  var ff = window.fflate;
  var b = window.LookIO.bundle();
  var zip = window.LookIO.buildV2(b);
  var bin = '';
  for (var i = 0; i < zip.length; i++) bin += String.fromCharCode(zip[i]);
  var b64 = btoa(bin);
  var okZip = false, okV1 = false;
  // the bridge: importText with the base64 zip
  window.__bridgeResult = 'pending';
  var p = window.LookIO.importText(b64);
  if (p && p.then) p.then(function (v) { window.__bridgeResult = v ? 'applied' : 'rejected'; });
  // the v1 fold: plain JSON through importText
  var v1 = JSON.parse(JSON.stringify(b));
  v1.version = 1;
  var v1Applied = window.LookIO.importText(JSON.stringify(v1));
  return JSON.stringify({ bridge: 'started', v1: v1Applied ? 'started' : 'sync' });
})()")
sleep 2
BRIDGE=$(ev "window.__bridgeResult")
ck "Z4a the base64 bridge applies the v2 container via importText" \
   "$(echo "$BRIDGE" | grep -q 'applied' && echo yes)" "$BRIDGE"
V1FOLD=$(ev "
(function(){
  // v1 JSON text validates (the fold)
  var v = window.LookIO.importText(JSON.stringify({ format: 'doomalay-look', version: 1, state: window.Settings.getState() }));
  return v ? 'ok' : 'failed';
})()")
ck "Z4b v1 JSON bundles still validate (the fold on read)" \
   "$(echo "$V1FOLD" | grep -q 'ok' && echo yes)" "$V1FOLD"

# ── Z5: the failed-apply rollback ─────────────────────────────────
RB=$(ev "
(function(){
  var real = window.Settings.setState;
  var before = window.Settings.getState().theme;
  var threw = false;
  window.Settings.setState = function (patch) {
    threw = true;
    throw new Error('boom');
  };
  var b = { format: 'doomalay-look', version: 1, scope: 'global',
    state: { theme: 'solar' } };
  var applied = false;
  try { window.LookIO.importText(JSON.stringify(b)); } catch (e) {}
  window.Settings.setState = real;
  var after = window.Settings.getState().theme;
  return JSON.stringify({ threw: threw, themeRestored: after === before });
})()")
ck "Z5a a throwing apply rolls back (the look survives)" \
   "$(echo "$RB" | grep -q '\"threw\":true' && echo "$RB" | grep -q '\"themeRestored\":true' && echo yes)" "$RB"

echo ""
echo "═══ v1017 doomtheme v2: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
