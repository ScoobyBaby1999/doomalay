#!/bin/bash
# v071-bundle-usage-test.sh — THE v0.71 LIVE RED TEAM
#
# Covers the user's four asks on the REAL app (engine + browser, a mock
# HF hub standing in for huggingface.co):
#   A. THE BADGE MIRRORS THE CARD — the "#xyz bundle" flag paints the
#      SAME art the bunch card paints (the full design gradient through
#      GradientUI — mesh included — else the deterministic hash), not
#      just the first stop.
#   B. USE THE WHOLE BUNDLE — the bunch view's ▣ use-bundle pill arms
#      the connected chat: the ▣ chip, the lib gate, state.bundle, the
#      localStorage manifest, and the PM turn opts carrying the bundle.
#   C. PM USAGE TRACKING — a stubbed PM turn reports OpenAI-shape usage
#      (prompt_tokens/completion_tokens); the status event persists the
#      ENGINE shape and /api/sessions/{id}/usage counts the tokens.
#
# The PM ReAct loop itself (25-tool chains, round-summing, the always-on
# vocabulary, the bundle manifest) is pinned separately by
# scripts/v071-pm-loop-test.mjs against the real extracted loop.
#
# Usage: bash scripts/v071-bundle-usage-test.sh
set -u
cd "$(dirname "$0")/.."
ENG=./engine/doomalay-engine
PORT=8288
MOCKPORT=8289
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v071
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2 | want: $3)"; }
has(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing '$3' in: $(echo "$2" | head -c 200))";; esac; }

rm -rf $DATA; mkdir -p $DATA
python3 scripts/v071-mock-hub.py $MOCKPORT >/tmp/v071-mock.log 2>&1 &
MOCKPID=$!
cat > $DATA/config.yaml << EOF
brain_dir: $DATA/no-brain
hub:
  hf_base: http://127.0.0.1:$MOCKPORT
EOF
$ENG -open=false -port=$PORT -data-dir=$DATA -config=$DATA/config.yaml >/tmp/v071-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID $MOCKPID 2>/dev/null; wait 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && ok "engine boot (mock hub wired)" || { bad "engine boot"; exit 1; }

# a PM-provider chat session + the seeded canvas icon
SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Bundle Bot","sandbox":"quick","model":"privatemodeai/mock-pm","provider":"privatemodeai"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ID"])')
curl -s -X POST $BASE/api/sessions/$SID/events -H 'Content-Type: application/json' \
  -d '{"type":"status","text":"{\"state\":\"idle\"}"}' >/dev/null
agent-browser set viewport 400 760 >/dev/null
agent-browser open "$BASE" >/dev/null; sleep 2
agent-browser errors --clear >/dev/null
agent-browser eval "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0},scale:1,icons:[{id:'f1',type:'chat',name:'Bundle Bot',family:'privatemodeai',iconIndex:0,x:120,y:200,vx:0,vy:0,radius:28,sandbox:'quick',model:'privatemodeai/mock-pm',provider:'privatemodeai',sessionId:'$SID'}],savedAt:Date.now()}))" >/dev/null
agent-browser reload >/dev/null; sleep 2
agent-browser mouse move 120 200 >/dev/null
agent-browser mouse down >/dev/null; agent-browser mouse up >/dev/null; sleep 3

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

check "the chat panel opened (PM bot)" "$(ev "document.getElementById('chat-panel').classList.contains('open') ? 'open' : 'no'")" "open"

# ══ A. THE BADGE MIRRORS THE CARD ══════════════════════════════════════
# open the public library with the chat connected (the + pill's path),
# then pick the SKILLS library — the bunch cards ride a TYPE's grid
# (a bunch renders in the libraries its members belong to).
ev "window.Hub.open(undefined, {chat: {sessionId: '$SID', title: 'Bundle Bot', name: 'Bundle Bot'}}); 'opened'" >/dev/null; sleep 2.5
ev "(function(){ var p = document.querySelector('.hub-libpill[data-lib=\"skill\"]'); if (p) p.click(); return p ? 'picked' : 'no-libpill'; })()" >/dev/null; sleep 2.5
BUNCH=$(ev "(function(){
  var b = document.querySelector('.hub-card--bunch[data-bunch]');
  if (!b) return 'no-bunch';
  var bg = b.querySelector('[data-bunchbg]');
  var flag = b.querySelector('.hub-bundle-flag');
  return JSON.stringify({
    id: b.getAttribute('data-bunch'),
    flagText: flag ? flag.textContent : 'no-flag',
    cardImg: bg ? getComputedStyle(bg).backgroundImage.slice(0, 60) : 'no-bg',
    flagImg: flag ? getComputedStyle(flag).backgroundImage.slice(0, 60) : 'no-flag-bg',
    flagLen: flag ? getComputedStyle(flag).backgroundImage.length : 0,
    flagInk: flag ? getComputedStyle(flag).color : ''
  });
})()")
has "the mock bunch card renders (collection derived from the mock hub)" "$BUNCH" '"id":"superpowers-mock"'
has "the #tag bundle badge renders" "$BUNCH" '#superpowers'
BADGE=$(ev "(function(){
  var b = document.querySelector('.hub-card--bunch[data-bunch]');
  var bg = b && b.querySelector('[data-bunchbg]');
  var flag = b && b.querySelector('.hub-bundle-flag');
  if (!bg || !flag) return 'missing';
  var c1 = getComputedStyle(bg).backgroundImage, c2 = getComputedStyle(flag).backgroundImage;
  return JSON.stringify({same: c1 === c2, card: c1.slice(0, 40), flag: c2.slice(0, 40)});
})()")
has "THE BADGE PAINTS THE CARD'S ART (the mesh, not the first stop)" "$BADGE" '"same":true'
BADGEINK=$(ev "(function(){
  var b = document.querySelector('.hub-card--bunch[data-bunch]');
  var flag = b && b.querySelector('.hub-bundle-flag');
  return flag ? getComputedStyle(flag).color : 'missing';
})()")
check "the badge ink is readable white (avg mesh luminance < 168)" "$BADGEINK" "rgb(255, 255, 255)"

# ══ B. USE THE WHOLE BUNDLE ════════════════════════════════════════════
# open the bunch view, wait for the member groups, download the bundle
# (v0.72 THE PARITY CARD: the ▶ use-bundle FAB only exists once the
# bundle is DOWNLOADED — the user spec "the use bundle circular play
# icon looking pill if the bundle is downloaded"), then press it.
ev "(function(){ var b = document.querySelector('.hub-card--bunch[data-bunch]'); if (b) b.click(); return 'clicked'; })()" >/dev/null; sleep 2.5
USE0=$(ev "(function(){
  var u = document.getElementById('hub-bundle-use');
  return JSON.stringify({existsBeforeDownload: !!u});
})()")
has "the ▶ use-bundle FAB is hidden before the download (v0.72 contract)" "$USE0" '"existsBeforeDownload":false'
# wait for the groups to load, then download the whole bundle
for i in $(seq 1 10); do
  N=$(ev "(window.Hub && document.querySelector('.hub-bunch-sec') ? 'ready' : 'wait')" 2>/dev/null)
  [ "$N" = "ready" ] && break; sleep 0.5
done
ev "document.getElementById('hub-bundle-dl').click(); 'dl'" >/dev/null
DLST=""
for i in $(seq 1 20); do
  DLST=$(ev "(window.Hub.bundleDL('superpowers-mock')||{}).state || 'none'" 2>/dev/null)
  [ "$DLST" = "done" ] && break; sleep 0.4
done
check "the bundle downloaded (registry done)" "$DLST" "done"
USEBTN=$(ev "(function(){
  var u = document.getElementById('hub-bundle-use');
  return JSON.stringify({exists: !!u, label: u ? u.getAttribute('aria-label') : ''});
})()")
has "the bunch view has the ▶ use-bundle FAB once downloaded" "$USEBTN" '"exists":true'
has "the use-bundle FAB is labeled" "$USEBTN" 'use the whole bundle'
# stub the PM bridge so the turn is captured without the real service
ev "window.__pmTurns = [];
window.PMBridge = { streamChat: function (opts) {
  window.__pmTurns.push(opts);
  return Promise.resolve({ text: 'used the bundle member', usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } });
}, available: function () { return true; } }; 'stubbed'" >/dev/null
ev "document.getElementById('hub-bundle-use').click(); 'used'" >/dev/null; sleep 1.5
# return to the chat ROOT (the library AND the bunch view stack TWO
# views — pop until depth 0; the chip + the input bar only live there;
# the real UX: back out of the library to the chat)
ev "(function(){
  var c = window.ChatPanel && window.ChatPanel.current();
  var n = 0;
  while (c && c.panel && c.panel.viewDepth && c.panel.viewDepth() > 0 && n < 6) { c.panel.popView(); n++; }
  return 'popped-' + n;
})()" >/dev/null; sleep 1.5
ATTACHED=$(ev "(function(){
  var c = window.ChatPanel && window.ChatPanel.current && window.ChatPanel.current();
  var s = c && c.state;
  var chip = document.querySelector('#tpl-chip .tpl-chip-text');
  return JSON.stringify({
    bundle: !!(s && s.bundle && s.bundle.id === 'superpowers-mock'),
    members: s && s.bundle ? s.bundle.members.length : 0,
    libAuto: !!(s && s.libAuto),
    chip: chip ? chip.textContent : 'no-chip',
    stored: !!(function(){ try { return (JSON.parse(localStorage.getItem('doomalay.chatbundle.v1')) || {})['$SID']; } catch (e) { return null; } })()
  });
})()")
has "state.bundle armed (the whole bundle attached)" "$ATTACHED" '"bundle":true'
check "the manifest carries both members" "$(echo "$ATTACHED" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["members"])')" "2"
has "the lib gate flipped ON with the bundle" "$ATTACHED" '"libAuto":true'
has "the ▣ bundle chip shows in the input bar" "$ATTACHED" '"chip":"▣ superpowers-mock"'
has "the bundle persists in localStorage (session-keyed)" "$ATTACHED" '"stored":true'

# send a message through the real UI → the stubbed PM turn must carry the bundle
ev "var i = document.getElementById('chat-input'); i.value = 'use the bundle for this task'; i.dispatchEvent(new Event('input', {bubbles:true})); 'typed'" >/dev/null
ev "document.getElementById('chat-send').click(); 'sent'" >/dev/null; sleep 2.5
TURNOPTS=$(ev "JSON.stringify((window.__pmTurns && window.__pmTurns[0]) ? {lib: window.__pmTurns[0].lib, bundle: window.__pmTurns[0].bundle ? {id: window.__pmTurns[0].bundle.id, n: window.__pmTurns[0].bundle.members.length} : null, model: window.__pmTurns[0].model} : 'no-turn')")
has "the PM turn carries the bundle manifest" "$TURNOPTS" '"bundle":{"id":"superpowers-mock","n":2}'
has "the PM turn carries the lib gate" "$TURNOPTS" '"lib":true'

# ══ C. PM USAGE TRACKING (the normalized, persisted, aggregated path) ══
sleep 1.5
USAGE=$(curl -s $BASE/api/sessions/$SID/usage)
TOKENSIN=$(echo "$USAGE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["totals"]["tokensIn"])')
TOKENSOUT=$(echo "$USAGE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["totals"]["tokensOut"])')
check "PM usage TRACKED: tokens-in (prompt_tokens → input_tokens)" "$TOKENSIN" "120"
check "PM usage TRACKED: tokens-out (completion_tokens → output_tokens)" "$TOKENSOUT" "80"
# the status event itself carries the engine shape
ST=$(curl -s $BASE/api/sessions/$SID/events | python3 -c "
import json,sys
raw = sys.stdin.read()
evs = json.loads(raw)
evs = evs if isinstance(evs, list) else evs.get('events', [])
for e in reversed(evs):
    if e.get('eventType') == 'status' or e.get('type') == 'status':
        c = e.get('content') or e.get('text') or '{}'
        c = json.loads(c) if isinstance(c, str) else c
        u = c.get('usage') or {}
        print('in=%s out=%s' % (u.get('input_tokens'), u.get('output_tokens')))
        break
else:
    print('no-status')")
has "the persisted status event carries the ENGINE usage shape" "$ST" "in=120 out=80"

# ══ console health ═════════════════════════════════════════════════════
ERRS_RAW=$(agent-browser errors 2>/dev/null)
if [ -z "$ERRS_RAW" ]; then ERRS=0
else
  ERRS=$(echo "$ERRS_RAW" | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  if isinstance(d, dict): d = d.get('errors', d)
  print(len(d) if isinstance(d, list) else 'parse-fail')
except Exception:
  print('parse-fail')" 2>/dev/null)
fi
check "zero console errors through the whole ride" "$ERRS" "0"

echo "════════════════════════════════════════════════"
echo " v0.71 bundle + usage red team: $PASS PASS, $FAIL FAIL"
echo "════════════════════════════════════════════════"
[ $FAIL -eq 0 ]
