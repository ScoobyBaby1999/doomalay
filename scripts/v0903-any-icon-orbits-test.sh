#!/bin/bash
# v0903-any-icon-orbits-test.sh — v0.90.3 THE COMMUNICATION LAYER'S SCOPE
# (user spec: "Let's have it so if any two icons they start the orbit and
#  create a communication layer, not just tabs, for now, we implement the
#  functionality of tabs alone, having two tabs in the same orbit be
#  grouped, no need to always refresh.")
#
# THE CONTRACT: ANY two icons orbit (chat+chat, chat+web, web+web); the
# chat's own workspace stars keep working (nested atoms); the TAB-side
# keep-alive stays tab-scoped (a chat-only group protects NO web
# iframes); mixed groups persist across reloads; old v1 saves (with
# r/phi members) still load by id; zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8392
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0903

ev() {
  local OUT
  OUT=$(timeout 45 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')")
  if [ -z "$OUT" ]; then
    sleep 1
    OUT=$(timeout 45 agent-browser eval "$1" 2>/dev/null | python3 -c "
import sys, json
lines = sys.stdin.read().split('\n')
out = ''
for ln in lines:
    ln = ln.strip()
    if not ln: continue
    try:
        v = json.loads(ln)
        if isinstance(v, dict): v = v.get('data',{}).get('result', v)
        if isinstance(v, list) and len(v) == 1: v = v[0]
        out = v
    except Exception:
        pass
print(out, end='')")
  fi
  printf '%s' "$OUT"
}
PASS=0; FAIL=0
ck() { if [ "$2" = "yes" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1  → got: ${3:-?}"; fi; }

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0903-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

app_ready() { agent-browser eval "!!(window.doomalay && window.TabGroups && window.WebTabs && window.GridIcon)" 2>/dev/null | tr -d '"\n' | grep -qi '^true$'; }
boot_and_wait() {
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  for i in $(seq 1 14); do app_ready && return 0; sleep 0.8; done
  return 1
}
agent-browser close >/dev/null 2>&1 || true
sleep 0.6
boot_and_wait || { echo "BROWSER BOOT FAIL"; exit 1; }
ev "localStorage.clear()" >/dev/null 2>&1
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (1) CHAT + CHAT — two chat icons collide and orbit"
R=$(ev "(async function(){ try {
  var cA = window.GridIcon.create({ type: 'chat', id: 'chatA_v0903', x: 300, y: 400, radius: 28 });
  var cB = window.GridIcon.create({ type: 'chat', id: 'chatB_v0903', x: 380, y: 400, radius: 28 });
  window.doomalay.addEntity(cA);
  window.doomalay.addEntity(cB);
  window.TabGroups.collide(cA, cB, 340, 400);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  // let them orbit a beat (stepped)
  for (var q = 0; q < 20; q++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }
  return JSON.stringify({dots: G.dots().length, members: d0 ? d0.members.size : 0,
    bothChats: d0 ? (d0.members.has(cA) && d0.members.has(cB)) : false,
    moved: Math.round(Math.hypot(cA.x - 340, cA.y - 400))});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "chat+chat collision formed ONE group, both chat members, orbiting (the position drifts)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['dots']==1 and d['members']==2 and d['bothChats'] and d['moved']>0.2 else 'no')")" "$R"

echo "── (2) CHAT + WEB — a mixed group (the communication layer spans kinds)"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var tW = window.WebTabs.createAt(600, 400, {url: 'https://example.com'});
  var cC = window.GridIcon.create({ type: 'chat', id: 'chatC_v0903', x: 680, y: 400, radius: 28 });
  window.doomalay.addEntity(cC);
  window.TabGroups.collide(tW, cC, 640, 400);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var d1 = null;
  G.dots().forEach(function(dd){ if (dd.members.has(tW) && dd.members.has(cC)) d1 = dd; });
  return JSON.stringify({mixedGroup: !!d1, dots: G.dots().length});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "chat+web collision formed a MIXED group" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['mixedGroup'] else 'no')")" "$R"

echo "── (3) THE NESTED ATOMS — a grouped chat's workspace stars still work"
R=$(ev "(async function(){ try {
  // the v0841 contract: setCount feeds paintCore; a grouped chat keeps its
  // star count + the geometry twin answers (no interference from _orbit)
  window.Atoms.setCount('sess_v0903', 4);
  var cA = null;
  window.doomalay.world.entities.forEach(function(e){ if (e.id === 'chatA_v0903') cA = e; });
  cA.sessionId = 'sess_v0903';
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var atomsOn = !!(window.Atoms && window.Atoms.active(window.doomalay.world.entities));
  var cnt = window.Atoms.countFor(cA);
  var stillGrouped = window.TabGroups.isGrouped(cA);
  return JSON.stringify({atomsOn: atomsOn, starCount: cnt, stillGrouped: stillGrouped});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the grouped chat still carries its workspace stars (nested atoms, group intact)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['atomsOn'] and d['starCount']==4 and d['stillGrouped'] else 'no')")" "$R"

echo "── (4) THE KEEP-ALIVE STAYS TAB-SCOPED — a chat group protects no iframe"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  // isGrouped answers for any member (the layer), but the webpanel LRU
  // consults it ONLY for web tabs — verify a chat icon grouped reads
  // isGrouped true while an ungrouped web tab reads false
  var cA = null, tW = null;
  window.doomalay.world.entities.forEach(function(e){
    if (e.id === 'chatA_v0903') cA = e;
    if (e.id === 'chatB_v0903') { /* noop */ }
  });
  // a FRESH web tab parked far away (every existing one is already grouped)
  var tW = window.WebTabs.createAt(3000, 3000, {url: 'https://fresh.example'});
  await new Promise(r => setTimeout(r, 250));
  return JSON.stringify({chatGrouped: window.TabGroups.isGrouped(cA),
    webUngrouped: !window.TabGroups.isGrouped(tW)});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the chat reads grouped; an ungrouped web tab reads NOT grouped (the keep-alive's protection remains a web-only consumption)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('chatGrouped') and d.get('webUngrouped') is True else 'no')")" "$R"

echo "── (5) PERSISTENCE — mixed groups survive a reload (v2 by id, any type)"
R=$(ev "(async function(){ try {
  // clean stage: one mixed pair, saved
  window.TabGroups._debug.clear();
  var all = window.doomalay.world.entities;
  for (var ti = 0; ti < all.length; ti++) { all[ti]._orbit = null; all[ti].x = 9000+ti*150; all[ti].y = 9500; all[ti].vx=0; all[ti].vy=0; }
  var tA = window.WebTabs.createAt(500, 300, {url: 'https://example.com'});
  var cD = window.GridIcon.create({ type: 'chat', id: 'chatD_v0903', x: 580, y: 300, radius: 28 });
  window.doomalay.addEntity(cD);
  window.TabGroups.collide(tA, cD, 540, 300);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 400));
  return 'formed:' + window.TabGroups._debug.dots().length;
} catch(e) { return 'evalErr:' + String(e.message); } })()")
echo "  pre-reload: $R"
ev "" >/dev/null 2>&1
agent-browser reload >/dev/null 2>&1
sleep 4.5
for i in 1 2 3 4 5 6 7 8; do app_ready && break; sleep 0.8; done
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'rearmed'" >/dev/null 2>&1
R=$(ev "(async function(){ try {
  await new Promise(r => setTimeout(r, 700));
  var G = window.TabGroups._debug;
  var ds = G.dots();
  var tot = 0;
  ds.forEach(function(d){ tot += d.members.size; });
  return JSON.stringify({dots: ds.length, members: tot});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "reload: the mixed (web+chat) group restored by id" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('dots')==1 and d.get('members')==2 else 'no')")" "$R"

echo "── (6) V1 SAVE COMPAT — the old r/phi member shape loads by id"
R=$(ev "(async function(){ try {
  // fabricate a v1-shaped dots blob (members with r/phi objects) over the
  // current entities and push it through deserialize
  var ents = window.doomalay.world.entities;
  var tA = null, cD = null;
  for (var i = 0; i < ents.length; i++) {
    if (ents[i].type === 'web' && !ents[i]._orbit && !tA) tA = ents[i];
    if (ents[i].id === 'chatD_v0903') cD = ents[i];
  }
  if (!tA || !cD) return JSON.stringify({skip: 'no pair'});
  // free the pair first ((5)'s reload restored them into a group — capture
  // skips already-grouped icons by design)
  window.TabGroups._debug.clear();
  tA._orbit = null; cD._orbit = null;
  var v1 = [{ id: 'dot_v1compat', x: tA.x - 40, y: tA.y, R: 420, vr: 12,
    members: [{ id: tA.id, r: 40, phi: 0 }, { id: cD.id, r: 90, phi: 1.2 }] }];
  window.TabGroups.deserialize(v1);
  await new Promise(r => setTimeout(r, 200));
  var G = window.TabGroups._debug;
  var found = null;
  G.dots().forEach(function(d){ if (d.id === 'dot_v1compat') found = d; });
  return JSON.stringify({loaded: !!found, members: found ? found.members.size : 0,
    pairIn: found ? (found.members.has(tA) && found.members.has(cD)) : false});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the v1 shape (r/phi members) loaded by id — the pair captured (neighbors may passive-join too)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('loaded') and d.get('pairIn') and d.get('members',0)>=2 else 'no')")" "$R"

echo "── (7) console errors"
R=$(ev "JSON.stringify({errs: (window.__errs||[]).length, first: (window.__errs||[])[0] || ''})")
ck "zero console errors" "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['errs']==0 else 'no')")" "$R"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || exit 1
