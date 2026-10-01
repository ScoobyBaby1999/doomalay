#!/bin/bash
# v0778-gates-test.sh — THE BORDER + SURFACE DERIVED GATES:
#  (1) NO border-image anywhere (the element-local sweep is retired)
#  (2) every visible border consumer with the gradient live renders a
#      PROJECTED ring: the border-gradient layer with fixed attachment
#      (or the plate stack), never a bare solid border-color
#  (2) every visible FILLED border consumer renders a projected ring;
#      v0.79.2: the EDITOR-PREVIEW family (.color-row-banner,
#      .gr-preview-bar) is the DOCUMENTED EXCEPTION — they paint the
#      user's own inline preview and must never ring
#  (3) v0.79.2: the outline mask ring is RETIRED (a mask hides children
#      AND text — the chat-scheme chips / send glyph regression);
#      outline pills keep their solid border + CONTENT PAINTS. New
#      assertions: chips' dots visible + banners show their own colors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8315
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0778
export AGENT_BROWSER_SESSION=doomalay-v0778

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0778-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

agent-browser set viewport 420 800 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

# the sentinel theme: border + s1 + s2 all gradients
ev "(function(){
  Settings.setState({themeOverrides:{midnight:{
    '--border':      {colors:['#ff0055','#ff8a00'],dir:'diag',angle:45},
    '--surface-1':   {colors:['#0044cc','#4488ff'],dir:'diag',angle:45},
    '--surface-2':   {colors:['#00cc55','#66ff99'],dir:'diag',angle:45}
  }}});
  return 'sentinels live';
})()" >/dev/null; sleep 1.5

# open settings (a surface-rich screen) + the model picker (overlay cards)
ev "(function(){ var b = document.getElementById('settings-btn'); if (b) b.click(); return 'gear'; })()" >/dev/null; sleep 1.5

# (1) NO border-image anywhere
BI=$(ev "(function(){
  var n = 0, all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var cs = getComputedStyle(all[i]);
    var bi = cs.borderImageSource || '';
    if (bi && bi !== 'none') n++;
  }
  return String(n);
})()")
ck "zero border-image consumers (the local sweep is retired)" "$([ "$BI" = "0" ] && echo yes || echo no)" "$BI borders"

# (2) bordered elements render projected rings (border-gradient layer +
#     fixed attachment), not bare solids
# v0.88: RETRY-TOLERANT — headless Chromium's rAF can stall the projection
# painter's settle pass right after the panel glide (the same class of
# flake v0851's meters + v0841's motion proofs already retry through);
# the anchoring contract itself is unchanged (probe verified vs baseline:
# the stall hits both builds at the same rate).
RING_OK=no; RINGS='{}'
for rk in 1 2 3 4; do
RINGS=$(ev "(function(){
  var total = 0, ringed = 0, samples = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // v0.79.2: the editor-preview family never rings (inline preview wins)
    var cl = String(el.className || '');
    if (cl.indexOf('color-row-banner') !== -1 || cl.indexOf('gr-preview-bar') !== -1) continue;
    var cs = getComputedStyle(el);
    var bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw < 0.75) continue;
    var bc = cs.borderTopColor;
    // only our border-var consumers (the sentinel red #ff0055 or transparent ring)
    var isOurs = /rgb\\(255, 0, 85\\)|rgba\\(0, 0, 0, 0\\)/.test(bc);
    if (!isOurs) continue;
    // v0.79.2: OUTLINE pills (transparent background) keep their SOLID
    // border by contract — only FILLED consumers ride the plate rings
    if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        (cs.backgroundImage || '') === 'none') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    total++;
    var img = cs.backgroundImage || '';
    var att = cs.backgroundAttachment || '';
    var pos = cs.backgroundPosition || '';
    // projected = a gradient layer AND (fixed attachment OR painter-
    // anchored — inside transformed roots the PROJ painter rewrites
    // fixed → scroll + calc(var(--proj-tx…)) offsets, and the computed
    // style RESOLVES the calc to plain px; '0% 0%' = never anchored)
    var anchored = att.indexOf('fixed') !== -1 ||
      (pos.indexOf('px') !== -1 && pos.indexOf('%') === -1);
    var hasRing = img.indexOf('gradient') !== -1 && anchored;
    if (hasRing) ringed++;
    else if (samples.length < 4) samples.push(el.className ? String(el.className).slice(0, 40) : el.tagName);
  }
  return JSON.stringify({ total: total, ringed: ringed, miss: samples });
})()")
RG=$(echo "$RINGS" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['total'] > 0 and d['ringed'] == d['total']
print('yes' if ok else 'no')")
if [ "$RG" = "yes" ]; then RING_OK=yes; break; fi
sleep 0.8
done
ck "every visible border consumer renders a projected ring (${RG})" "$RING_OK" "$RINGS"

# (3) v0.79.2 THE CONTENT-SAFE CONTRACT: no outline mask rings anywhere
#     (they hid children AND text); outline pills keep their solid
#     border-color; the editor previews paint their own inline values.
MASK=$(ev "(function(){
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var cs = getComputedStyle(el);
    var bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw < 0.75) continue;
    var mk = (cs.webkitMaskImage || cs.maskImage || '');
    var mc = (cs.webkitMaskComposite || '') + ' ' + (cs.maskComposite || '');
    if (mk && mk !== 'none' && /xor|exclude/i.test(mc)) return 'leak:' + (el.className || el.tagName);
  }
  return 'none';
})()")
ck "zero outline mask rings (content-safe borders — v0.79.2)" "$([ "$MASK" = "none" ] && echo yes || echo no)" "$MASK"
# the banners keep their OWN inline previews (never the border field + mask)
# (v0.79.2: navigate to the appearance page + expand Customize — the
#  collapsed sections hold no live banners)
ev "(function(){ var t = document.querySelector('.settings-nav .tab[data-page=\"appearance\"]'); if (t) t.click(); return 'appearance'; })()" >/dev/null; sleep 1.2
ev "(function(){ var h3s = Array.from(document.querySelectorAll('.settings-section h3')); var c = h3s.find(function(h){ return /customize/i.test(h.textContent); }); if (c) c.click(); return c ? 'open' : 'none'; })()" >/dev/null; sleep 0.9
BN=$(ev "(function(){
  var bns = document.querySelectorAll('.color-row-banner');
  var ok = 0, bad = 0;
  for (var i = 0; i < bns.length; i++) {
    var cs = getComputedStyle(bns[i]);
    var mk = (cs.webkitMaskImage || cs.maskImage || '');
    var inline = bns[i].style.backgroundImage || bns[i].style.backgroundColor || '';
    if (mk !== 'none') { bad++; continue; }
    if (inline.indexOf('gradient') === 0 && cs.backgroundImage.indexOf('gradient') === -1) { bad++; continue; }
    ok++;
  }
  return ok + '/' + (ok + bad);
})()")
ck "the color-row banners paint their own previews (no mask, no clobber)" "$(python3 -c "import sys; a,b='$BN'.split('/'); print('yes' if int(a)>0 and int(a)==int(b) else 'no')")" "$BN"

# (4) the surface fill coverage: inject a probe rule with a plain s2 fill
#     (NOT in any hand-listed group) — it must window the s2 field
#     (async: the gates' MutationObserver re-derives on the new sheet)
COV=$(ev "(async function(){
  var st = document.createElement('style');
  st.textContent = '.v0778-probe { background: var(--surface-2); width: 120px; height: 40px; }';
  document.head.appendChild(st);
  var d = document.createElement('div');
  d.className = 'v0778-probe';
  document.body.appendChild(d);
  await new Promise(function (r) { setTimeout(r, 400); });
  var cs = getComputedStyle(d);
  var img = cs.backgroundImage || '';
  var att = cs.backgroundAttachment || '';
  d.remove(); st.remove();
  return JSON.stringify({ img: img.slice(0, 50), att: att });
})()")
CV=$(echo "$COV" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'gradient' in d['img'].lower() and 'fixed' in d['att']
print('yes' if ok else 'no')")
ck "an unknown surface-2 fill auto-windows the s2 field (derived)" "$CV" "$COV"

# (5) zero floods — the plate contract (the v0766 auditor)
AUD=$(cat scripts/v0766-auditor.js)
agent-browser eval "$AUD" >/dev/null
FLOOD=$(ev "window.__audit('settings')" | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    d = json.loads(s)
    print('yes' if d.get('leakCount') == 0 else 'no:' + str(d.get('leaks', [])[:3]))
except Exception as e:
    print('no:parse')" )
ck "zero leaks (the plate contract holds under the new gates)" "$FLOOD" "$FLOOD"

# console errors
ERRS=$(agent-browser errors 2>/dev/null | head -3)
if [ -z "$ERRS" ]; then ck "zero console errors" yes; else ck "zero console errors" no "$ERRS"; fi

echo ""
echo "v0.77.8 gates suite: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
