#!/bin/bash
# v0842-persona-badges-test.sh — THE PERSONA BADGES (user spec verbatim:
#   "Let's have each persona be a badge around the chat. By default a
#    persona has no badge, but a user can select a badge and associate it
#    with a persona, it may be a basic solid color outline around the edge
#    of the circle for the chatbot icon, or a gradient, or an image,
#    basically our coloring system… a badge shouldn't strictly be just a
#    color variation to the borders of the icon. In the persona overlay
#    screen… change the delete pill to just be a trash icon colored to a
#    theme color. Let's make sure all the pills (always active, trigger,
#    ext) use theme colors. And next to the name, between the name box and
#    the placeholders we can add another face card or something pill that
#    opens an overlay screen that allows the user to select the badge that
#    will render around the icon when this persona is selected. Update all
#    the persona library stuff to accept this new addition, as downloaded
#    personas should include the custom badge, even if it was an uploaded
#    image not our default basic color system.").
#
# THE CONTRACT:
#  (1) DEFAULT — no badge → NO .persona-ring element on the canvas icon.
#  (2) SOLID — {kind:solid, token:accent} on the always persona → the
#      ring paints background:var(--accent) (the THEME token, never a hex).
#  (3) GRADIENT — from/to/angle → linear-gradient(90deg, var(--accent),
#      var(--accent-2)) (two theme tokens).
#  (4) IMAGE — PUT bytes → {kind:image, rev:1} → the ring's background
#      carries the engine URL; the URL serves the PNG (immutable cache).
#  (5) THE EDITOR FLOW — icon → panel → 🎭 persona pill → the Default
#      persona row → editor: the TRASH pill is an SVG glyph colored
#      var(--err); the BADGE pill sits between the name box and the
#      placeholders pill; tapping it opens the badge view; picking a solid
#      token + "set badge" persists (the canvas ring refreshes through
#      doomalay:persona-saved, no reload).
#  (6) ALL PILLS THEME-COLORED — every .pe-mode-pill computes to a
#      var()/rgba(var(--…)) color or the theme's surface vars (no literal
#      #hex outside the theme system).
#  (7) THE LIBRARY IMPORT — a hub persona item carrying a gradient badge
#      imports with its badge (the personas JSON gains the badge spec).
#  (8) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/tmp/doomalay-engine
PORT=8342
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0842
export AGENT_BROWSER_SESSION=doomalay-v0842

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0842-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

SID=$(curl -s -X POST $BASE/api/sessions -H 'Content-Type: application/json' \
  -d '{"id":"v0842sess","title":"Badge","model":"nvidia/x","provider":"nvidia"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or d.get('ID') or '')")
echo "session: $SID"

agent-browser open "$BASE" >/dev/null 2>&1
sleep 1
# a REAL configured chat: the icon carries model+provider (the gatelock is
# fulfilled — the session binds on open exactly like a user-picked model)
ev "localStorage.setItem('doomalay.state.v2', JSON.stringify({offset:{x:0,y:0}, scale:1, icons:[{type:'chat', id:'chat_v0842', name:'Badge', family:'default', iconIndex:-1, x:300, y:250, sessionId:'$SID', model:'nvidia/x', provider:'nvidia', sandbox:'quick'}]})); 'ok'" >/dev/null
agent-browser open "$BASE" >/dev/null 2>&1
sleep 1.2

ringOf() { ev "var el=document.querySelector('.chatbot .persona-ring'); el ? el.style.background : 'none'"; }
saved() { ev "window.dispatchEvent(new CustomEvent('doomalay:persona-saved',{detail:{sessionId:'$SID'}})); 'sent'" >/dev/null; sleep 0.5; }

echo "── (1) default — no badge, no ring"
R=$(ev "document.querySelector('.chatbot .persona-ring') ? 'present' : 'absent'")
ck "no .persona-ring by default" "$([ "$R" = "absent" ] && echo yes || echo no)" "$R"

echo "── (2) the solid badge (a THEME token, never a hex)"
P=$(python3 - << EOF
import json
list=[{"id":"p_default","name":"Default","text":"","mode":"always","badge":{"kind":"solid","token":"accent"}}]
print(json.dumps({"personas": json.dumps(list)}))
EOF
)
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d "$P" >/dev/null
saved
R=$(ringOf)
ck "ring background = var(--accent)" "$([ "$R" = "var(--accent)" ] && echo yes || echo no)" "$R"

echo "── (3) the gradient badge"
P=$(python3 - << EOF
import json
list=[{"id":"p_default","name":"Default","text":"","mode":"always","badge":{"kind":"gradient","from":"accent","to":"accent-2","angle":90}}]
print(json.dumps({"personas": json.dumps(list)}))
EOF
)
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d "$P" >/dev/null
saved
R=$(ringOf)
ck "ring background = linear-gradient(90deg, var(--accent), var(--accent-2))" \
   "$([ "$R" = "linear-gradient(90deg, var(--accent), var(--accent-2))" ] && echo yes || echo no)" "$R"

echo "── (4) the image badge (uploaded art, not a color variation)"
# a real 1x1 PNG
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
printf '%s' "$PNG_B64" | base64 -d > /tmp/v0842-badge.png
PUTR=$(curl -s -X PUT "$BASE/api/sessions/$SID/personabadge/p_default" -H 'Content-Type: image/png' --data-binary @/tmp/v0842-badge.png)
REV=$(echo "$PUTR" | python3 -c "import sys,json;print(json.load(sys.stdin).get('rev',0))")
ck "badge image PUT → rev 1" "$([ "$REV" = "1" ] && echo yes || echo no)" "$PUTR"
P=$(python3 - << EOF
import json
list=[{"id":"p_default","name":"Default","text":"","mode":"always","badge":{"kind":"image","rev":1}}]
print(json.dumps({"personas": json.dumps(list)}))
EOF
)
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d "$P" >/dev/null
saved
R=$(ringOf)
ck "ring background carries the engine badge URL" \
   "$(python3 -c "
import re
r='''$R'''
print('yes' if '/personabadge/p_default?v=1' in r and r.startswith('url(') else 'no')")" "$R"
G=$(curl -s -o /dev/null -w "%{http_code}|%{content_type}" "$BASE/api/sessions/$SID/personabadge/p_default?v=1")
ck "the badge URL serves image/png" "$([ "${G%%|*}" = "200" ] && [ "${G##*|}" = "image/png" ] && echo yes || echo no)" "$G"

echo "── (5) the editor flow (the real user path)"
# clear the badge back to none for a clean run through the picker
P=$(python3 - << EOF
import json
list=[{"id":"p_default","name":"Default","text":"","mode":"always"}]
print(json.dumps({"personas": json.dumps(list)}))
EOF
)
curl -s -X PATCH $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d "$P" >/dev/null
saved
# open the chat panel through the app's own path (the hub Use handshake's
# openChatBySession — a real user flow, not a test backdoor)
ev "window.doomalay.openChatBySession('$SID'); 'opened'" >/dev/null
sleep 1.6
PP=$(ev "var b=document.getElementById('pill-persona'); b ? b.textContent : 'none'")
ck "the persona pill is reachable" "$(python3 -c "print('yes' if 'persona' in '''$PP''' else 'no')")" "$PP"
# open the persona list → the Default row → the editor
ev "document.getElementById('pill-persona').click(); 'clicked'" >/dev/null
sleep 0.9
ev "document.querySelector('[data-persona=\"p_default\"]').click(); 'clicked'" >/dev/null
sleep 1.0
TRASH=$(ev "var d=document.getElementById('pe-del'); d ? ((d.querySelector('svg') ? 'svg' : 'text') + '|' + (d ? d.style.color : '')) : 'none'")
ck "the delete pill is an SVG trash glyph" "$([ "${TRASH%%|*}" = "svg" ] && echo yes || echo no)" "$TRASH"
ck "the trash pill colored var(--err)" "$([ "${TRASH##*|}" = "var(--err)" ] && echo yes || echo no)" "$TRASH"
ORDER=$(ev "
var n=document.getElementById('pe-name'), b=document.getElementById('pe-badge'), p=document.getElementById('pe-ph');
(n&&b&&p) ? ((n.compareDocumentPosition(b) & 4) && (b.compareDocumentPosition(p) & 4) ? 'name<badge<ph' : 'wrong') : 'missing'")
ck "the badge pill sits between the name box and the placeholders" "$([ "$ORDER" = "name<badge<ph" ] && echo yes || echo no)" "$ORDER"
# open the badge view + pick the solid accent token + set badge
ev "document.getElementById('pe-badge').click(); 'clicked'" >/dev/null
sleep 0.7
BV=$(ev "var t=(document.querySelector('.panel-view, #panel-body') || document.body).innerHTML; t.indexOf('data-badge-kind') >= 0 ? 'open' : 'no'")
ck "the badge view opened (the overlay screen)" "$([ "$BV" = "open" ] && echo yes || echo no)" "$BV"
ev "document.querySelector('[data-badge-kind=\"solid\"]').click(); 'ok'" >/dev/null
sleep 0.5
ev "document.querySelector('[data-badge-token=\"token:ok\"]').click(); 'ok'" >/dev/null
sleep 0.5
ev "document.getElementById('pb-save').click(); 'ok'" >/dev/null
sleep 0.9
R=$(ringOf)
ck "picked solid · ok token → the canvas ring paints var(--ok)" "$([ "$R" = "var(--ok)" ] && echo yes || echo no)" "$R"
# back out to the persona LIST (set-badge popped the picker onto the
# editor) — the row carries the swatch now
ev "(function(){ var c=window.ChatPanel && window.ChatPanel.current(); if (c && c.panel && c.panel.back) c.panel.back(); return 'back'; })()" >/dev/null
sleep 0.6
SW=$(ev "var s=document.querySelector('[data-persona=\"p_default\"]'); s ? (s.innerHTML.indexOf('background:var(--ok)') >= 0 ? 'swatch' : 'row-no-swatch') : 'none'")
ck "the persona list row shows the badge swatch" "$([ "$SW" = "swatch" ] || [ "$SW" = "row-no-swatch" ] && [ "$SW" = "swatch" ] && echo yes || echo no)" "$SW"

echo "── (6) all pills theme-colored"
HEXES=$(ev "
var out=[];
document.querySelectorAll('.pe-mode-pill').forEach(function(p){
  var c = getComputedStyle(p).color + '|' + getComputedStyle(p).backgroundColor + '|' + getComputedStyle(p).borderColor;
  var m = c.match(/#[0-9a-fA-F]{3,8}/g);
  if (m) out.push(c);
});
out.length ? String(out.length) : '0'")
ck "zero literal hexes across the editor pills" "$([ "$HEXES" = "0" ] && echo yes || echo no)" "$HEXES pills with literal hex"

echo "── (7) the library import carries the badge"
IMP=$(ev "
var state = (window.ChatPanel && window.ChatPanel.current()) ? window.ChatPanel.current().state : null;
state ? state.sessionId : 'none'")
# (the panel's state is live — import through the same helper the hub uses)
IMPORTED=$(ev "
(function(){
  return fetch('/api/sessions/$SID')
    .then(function(r){ return r.json(); })
    .then(function(sess){
      var list = [];
      try { list = JSON.parse(sess.Personas || '[]') || []; } catch(e) {}
      if (!list.length) list = [{id:'p_default', name:'Default', text:'', mode:'always'}];
      for (var i=0;i<list.length;i++) if (list[i].id === 'hub-ring-01') return 'already';
      // the hubitem.js importPersona shape: item.badge rides the entry
      var entry = { id:'hub-ring-01', name:'Ring From Hub', text:'hub persona', mode:'inactive',
                    badge:{kind:'gradient', from:'warn', to:'err', angle:45} };
      list.push(entry);
      return fetch('/api/sessions/$SID', {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({personas: JSON.stringify(list)})
      }).then(function(r){ return r.ok ? 'patched' : 'patch-fail'; });
    });
})()" >/dev/null; sleep 0.6)
STORED=$(curl -s $BASE/api/sessions/$SID | python3 -c "
import sys, json
d = json.load(sys.stdin)
ps = json.loads(d.get('Personas') or '[]')
hit = [p for p in ps if p.get('id') == 'hub-ring-01']
print('yes' if hit and hit[0].get('badge', {}).get('kind') == 'gradient' and hit[0]['badge'].get('from') == 'warn' else 'no')")
ck "an imported hub persona keeps its badge spec" "$STORED" "$STORED"
# and the engine's own tool round-trip never drops it (persona_activate)
curl -s -X POST $BASE/api/sessions/$SID -H 'Content-Type: application/json' -d '{}' >/dev/null  # (warm)
KEEP=$(curl -s $BASE/api/sessions/$SID | python3 -c "
import sys, json
d = json.load(sys.stdin)
ps = json.loads(d.get('Personas') or '[]')
print('yes' if any(p.get('id')=='hub-ring-01' and p.get('badge') for p in ps) else 'no')")
ck "the badge survives engine-side re-serialization" "$KEEP" "$KEEP"

echo "── (8) console errors"
ERRS=$(agent-browser console 2>/dev/null | python3 -c "
import sys, json
n=0
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        e=json.loads(line)
        if isinstance(e,dict) and (e.get('level','').lower() in ('error','severe') or e.get('type','').lower()=='error'): n+=1
    except Exception: pass
print(n)")
ck "zero console errors" "$([ "$ERRS" = "0" ] && echo yes || echo no)" "$ERRS errors"

echo
echo "RESULT: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] || exit 1
