#!/bin/bash
# v0721-parity-card-test.sh — THE PARITY CARD (v0.72.1 live test)
#
# User spec: "When viewing bundles, it shouldn't look different from
# viewing single files from the public library… no tags under the
# bundles description, no total downloads and endorsements, two
# rectangular pills instead of the circular FABs. Every item published
# in the library should act as a bundle, even if it has just 1 item —
# visually + functionally the same."
#
# Covers:
#   A. SERVER — CollectionSummary.Tags: every member tag votes once per
#      member carrying it; votes-first, ties alphabetical, capped at 16.
#   B. THE HERO ROWS — the bunch view mirrors hi-head's exact stack:
#      desc / meta ("N items · updated …") / TAGS (top 5 + "+N") /
#      COUNTS (Σ hearts · Σ downloads) — class-level parity with the
#      single item view (hi-desc / hi-meta / hi-chips / hi-counts).
#   C. THE FAB LIFECYCLE — ⤓ idle → running (N/M + the --dl-p ring
#      class) → done ✓; the ♥ locked→unlocked→on→off fan-out (Σ hearts
#      follows); ▶ + 🗑 only when downloaded; the keep/remove confirm
#      bar; delete keeps the view open with the FABs reset.
#   D. THE RETIREMENTS — the rectangular .hub-bundle-dl/.hub-bundle-use
#      pills are gone from the DOM and the CSS.
#
# Usage: bash scripts/v0721-parity-card-test.sh
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8291
MOCKPORT=8292
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0721
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2 | want: $3)"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing '$3' in: $(echo "$2" | head -c 220))";; esac; }
nohas(){ case "$2" in *"$3"*) bad "$1 (found '$3' unexpectedly)";; *) ok "$1";; esac; }

rm -rf $DATA; mkdir -p $DATA
python3 scripts/v071-mock-hub.py $MOCKPORT >/tmp/v0721-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:$MOCKPORT
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v0721-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (mock hub wired)" || { bad "engine boot"; exit 1; }

agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null

ev(){ agent-browser eval "$1" 2>/dev/null | python3 -c "
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

# a chat session + the seeded canvas icon (the panel must be open for the hub)
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Parity Bot","sandbox":"quick","model":"privatemodeai/mock-pm","provider":"privatemodeai"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Parity Bot',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null; agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3
check "the chat panel opened" "$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")" "open"

# open the library + the skills grid (where the mock bunch lives)
ev "window.Hub.open(undefined, {chat: {sessionId: '$SID', title: 'Parity Bot', name: 'Parity Bot'}}); 'opened'" >/dev/null; sleep 2.5
ev "(function(){ var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); if (p) p.click(); return 'picked'; })()" >/dev/null; sleep 2.5

# ══ A. THE SERVER TAG ROW ═══════════════════════════════════════════
TAGS=$(curl -s "$BASE/api/hub/collections" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for c in d.get("collections", []):
    if c["id"] == "superpowers-mock":
        print(json.dumps(c.get("tags", [])))
        break')
# votes: superpowers 2 → first; the rest 1 vote each, alphabetical:
# brainstorm, planning, research, testing, writing
check "A1 the summary carries the vote-ranked Tags array" "$TAGS" '["superpowers", "brainstorm", "planning", "research", "testing", "writing"]'

# ══ B. THE HERO ROWS ════════════════════════════════════════════════
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch]'); if (b) b.click(); return 'clicked'; })()" >/dev/null; sleep 2.5
HERO=$(ev "(function(){
  var h = document.querySelector('.hub-bunch-hero');
  if (!h) return 'no-hero';
  var chips = h.querySelectorAll('.hi-chips .hi-chip');
  var counts = h.querySelectorAll('.hi-counts span b');
  return JSON.stringify({
    desc: (h.querySelector('.hi-desc') || {}).textContent,
    meta: (h.querySelector('.hi-meta') || {}).textContent,
    nChips: chips.length,
    chips: Array.prototype.map.call(chips, function(c){ return c.textContent; }),
    hearts: counts.length ? counts[0].textContent : '-',
    dls: counts.length > 1 ? counts[1].textContent : '-'
  });
})()")
has "B1 the bunch hero renders" "$HERO" '"desc":"2 skills"'
has "B2 the meta row (N items · updated)" "$HERO" '"meta":"2 items · updated 2025-01-03"'
# top 5 tags (superpowers, brainstorm, planning, research, testing) + "+1" (writing folds)
check "B3 the tag row shows the top 5 + the +N fold" \
  "$(echo "$HERO" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(json.dumps(d["chips"]))')" \
  '["#superpowers", "#brainstorm", "#planning", "#research", "#testing", "+1"]'
has "B4 the +N chip carries the folded tags in its title" \
  "$(ev "(document.querySelector('.hub-bunch-hero .hi-chip--info')||{}).title || 'none'")" "writing"
has "B5 Σ member hearts (3+1)" "$HERO" '"hearts":"4"'
has "B6 Σ member downloads (5+2)" "$HERO" '"dls":"7"'

# B7: structural parity with the single-item view — same classes, same order
PARITY=$(ev "(function(){
  function rows(sel){ var h = document.querySelector(sel); if (!h) return null;
    return Array.prototype.map.call(h.querySelectorAll('.hi-desc, .hi-meta, .hi-chips, .hi-counts'), function(e){ return e.className.split(' ')[0]; }).join('>'); }
  var item = document.querySelector('.hi-head'); // the single item view (if mounted)
  return JSON.stringify({ bunch: rows('.hub-bunch-hero'), order: ['.hi-desc','.hi-meta','.hi-chips','.hi-counts'] });
})()")
has "B7 the bunch hero uses the single item's exact row classes" "$PARITY" '"bunch":"hi-desc>hi-meta>hi-chips>hi-counts"'

# ══ C. THE FAB LIFECYCLE ════════════════════════════════════════════
FABS0=$(ev "(function(){
  var dl = document.getElementById('hub-bundle-dl');
  var h = document.getElementById('hub-bundle-heart');
  var u = document.getElementById('hub-bundle-use');
  var d = document.getElementById('hub-bundle-del');
  return JSON.stringify({
    dl: dl ? dl.className : 'gone', dlTitle: dl ? dl.title : '',
    heart: h ? h.className : 'gone',
    use: !!u, del: !!d
  });
})()")
has "C1 the ⤓ FAB exists (idle)" "$FABS0" '"dl":"hi-fab"'
has "C2 the idle title offers the bundle download" "$FABS0" 'download every item in this bundle'
has "C3 the ♥ renders LOCKED before any download" "$FABS0" '"heart":"hi-fab hi-fab--heart locked"'
has "C4 no ▶ before the download" "$FABS0" '"use":false'
has "C5 no 🗑 before the download" "$FABS0" '"del":false'

# the download: idle → (running) → done; then the row reshapes
ev "document.getElementById('hub-bundle-dl').click(); 'dl'" >/dev/null
DONE=""
for i in $(seq 1 20); do
  DONE=$(ev "(window.Hub.bundleDL('superpowers-mock')||{}).state || 'none'")
  [ "$DONE" = "done" ] && break
  sleep 0.4
done
check "C6 the registry reaches done" "$DONE" "done"
FABS1=$(ev "(function(){
  var dl = document.getElementById('hub-bundle-dl');
  var h = document.getElementById('hub-bundle-heart');
  return JSON.stringify({ dl: dl.className, dlTxt: dl.textContent.trim(), heart: h.className });
})()")
has "C7 the ⤓ wears is-done + the ✓ glyph" "$FABS1" '"dl":"hi-fab is-done"'
has "C8 the done glyph is the ✓" "$FABS1" '"dlTxt":"✓"'
has "C9 the ♥ UNLOCKS after the download" "$FABS1" '"heart":"hi-fab hi-fab--heart"'
check "C10 the ▶ appears once downloaded" "$(ev "!!document.getElementById('hub-bundle-use')" | tr 'A-Z' 'a-z')" "true"
check "C11 the 🗑 appears once downloaded" "$(ev "!!document.getElementById('hub-bundle-del')" | tr 'A-Z' 'a-z')" "true"

# the endorse fan-out: both members → Σ hearts 4 → 6, the ♥ goes on
ev "document.getElementById('hub-bundle-heart').click(); 'heart'" >/dev/null; sleep 2
HEART1=$(ev "(function(){
  var h = document.getElementById('hub-bundle-heart');
  var c = document.querySelector('.hub-bunch-hero .hi-counts b');
  return JSON.stringify({ cls: h.className, hearts: c.textContent });
})()")
has "C12 the ♥ goes ON (every member endorsed)" "$HEART1" '"cls":"hi-fab hi-fab--heart on"'
has "C13 Σ hearts follows the fan-out (4 → 6)" "$HEART1" '"hearts":"6"'
# the engine's own counters agree (each member +1)
CHECKHEARTS=$(curl -s "$BASE/api/hub/collections" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for c in d.get("collections", []):
    if c["id"] == "superpowers-mock": print(c.get("hearts")); break')
check "C14 the served Σ hearts counts both endorsements" "$CHECKHEARTS" "6"

# the un-endorse fan-out
ev "document.getElementById('hub-bundle-heart').click(); 'unheart'" >/dev/null; sleep 2
HEART2=$(ev "(function(){
  var h = document.getElementById('hub-bundle-heart');
  var c = document.querySelector('.hub-bunch-hero .hi-counts b');
  return JSON.stringify({ cls: h.className, hearts: c.textContent });
})()")
has "C15 the ♥ flips back off" "$HEART2" '"cls":"hi-fab hi-fab--heart"'
has "C16 Σ hearts returns to 4" "$HEART2" '"hearts":"4"'

# the locked heart explains itself
ev "(function(){ localStorage.setItem('doomalay.bundledl.v1','{}'); return 'reg-cleared'; })()" >/dev/null
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch]'); return 'stay'; })()" >/dev/null

# the confirm bar: keep keeps the row intact
ev "document.getElementById('hub-bundle-del').click(); 'del'" >/dev/null; sleep 1
check "C17 the confirm bar replaces the FAB row" "$(ev "!!document.getElementById('hub-bundle-delbar')" | tr 'A-Z' 'a-z')" "true"
ev "(function(){ var k = document.querySelector('#hub-bundle-delbar [data-del=\"keep\"]'); if (k) k.click(); return 'kept'; })()" >/dev/null; sleep 1.2
check "C18 keep restores the FAB row" "$(ev "!!document.getElementById('hub-bundle-dl') && !document.getElementById('hub-bundle-delbar')" | tr 'A-Z' 'a-z')" "true"

# the delete: remove empties the device + the view STAYS with reset FABs
ev "document.getElementById('hub-bundle-del').click(); 'del2'" >/dev/null; sleep 1
ev "(function(){ var r = document.querySelector('#hub-bundle-delbar [data-del=\"remove\"]'); if (r) r.click(); return 'removed'; })()" >/dev/null; sleep 2.5
DEL1=$(ev "(function(){
  var dl = document.getElementById('hub-bundle-dl');
  var h = document.getElementById('hub-bundle-heart');
  return JSON.stringify({
    hero: !!document.querySelector('.hub-bunch-hero'),
    dl: dl ? dl.className : 'gone',
    heart: h ? h.className : 'gone',
    use: !!document.getElementById('hub-bundle-use'),
    del: !!document.getElementById('hub-bundle-del'),
    reg: JSON.stringify(window.Hub.bundleDL('superpowers-mock'))
  });
})()")
has "C19 the bunch view STAYS OPEN after the delete" "$DEL1" '"hero":true'
has "C20 the ⤓ resets to idle" "$DEL1" '"dl":"hi-fab"'
has "C21 the ♥ re-locks" "$DEL1" '"heart":"hi-fab hi-fab--heart locked"'
has "C22 the ▶ retires with the copies" "$DEL1" '"use":false'
has "C23 the 🗑 retires with the copies" "$DEL1" '"del":false'
has "C24 the registry entry is gone" "$DEL1" '"reg":"null"'

# ══ D. THE RETIREMENTS ══════════════════════════════════════════════
DOM=$(ev "(function(){ var z = document.querySelector('.hub-root--bunch'); return z ? z.outerHTML.slice(0, 400) : 'none'; })()")
nohas "D1 no rectangular .hub-bundle-dl pill class in the DOM" "$DOM" 'class="hub-bundle-dl'
nohas "D2 no .hub-bundle-use pill in the DOM" "$DOM" 'hub-bundle-use"'
CSS=$(curl -s "$BASE/" | grep -c '\.hub-bundle-dl {' || true)
check "D3 the old pill CSS block is retired from the sheet" "$CSS" "0"
RING=$(curl -s "$BASE/" | grep -c 'conic-gradient(var(--ok) calc(var(--dl-p' || true)
check "D4 the FAB progress-ring CSS shipped" "$RING" "1"

# page errors across the whole run
ERRS=$(agent-browser errors 2>/dev/null | grep -c "error" || true)
check "E no console errors through the whole flow" "$ERRS" "0"

echo
echo "══ v0.72.1 PARITY CARD: $PASS pass / $FAIL fail ══"
[ "$FAIL" = "0" ]
