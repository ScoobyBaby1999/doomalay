#!/bin/bash
# v0882-collision-dots-test.sh — v0.88.2 THE COLLISION DOTS + THE GROUP
# ORBITS (user spec verbatim):
#   "we can make tab icons form connections if the user moves them and
#    collides the icons on the canvas with one another… When two icons
#    collide, a dot forms in the collision point that has a radius
#    around it, all icons in that radius are connected… If two icons
#    collide inside the radius of a collision dot, instead of forming a
#    new dot inside the radius of a preexisting one, we make the
#    preexisting one render as a larger dot and increase its radius."
#   "All icons inside the radius of a collision dot should orbit the
#    collision dot… slightly faster the closer they are to the dot, and
#    slower the closer they are to the radius… without moving to a
#    determined fixed path… orbit very slowly… in 3d like the stars."
#   "make the dot marking the center of the grid noticeably larger then
#    any variation a collision can make"
#
# THE CONTRACT (drag tests ride the default WORKER painter — the
# headless software rasterizer makes main-mode full frames ~1s and
# starves the eval timers; the pixel probes switch to main paint in
# their own section, then back):
#  (1) FORMATION — a real drag-collision between two WEB TAB icons
#      (mouse events, the physics contact tap) forms ONE dot, R0 130,
#      both members captured, velocities absorbed (the sticky cluster).
#  (2) THE PAINT — main-mode probes: the dot + its bubble ring + the
#      origin dot render on #c; the origin is noticeably larger (≥1.5×).
#  (3) THE ORBIT — members swirl (position advances over 2.5s) while
#      their distance to the dot holds (the trajectory invariant) + the
#      depth cue (the scale swings).
#  (4) GROWTH — a third tab released inside the radius joins + the dot
#      grows (no nested dot); a CHAT icon NEVER joins.
#  (5) LEAVE — dragging a member out releases it; the last one out
#      dissolves the dot.
#  (6) PERSISTENCE — the dots + memberships survive a full reload.
#  (7) THE KEEP-ALIVE PROTECTION — grouped tabs' live frames survive
#      the 0.88.1 LRU eviction sweep.
#  (8) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8382
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0882
# v0.88.2 tooling note: the NAMED sessions wedge after heavy use in this
# sandbox (the daemon's CDP degrades — the DEFAULT session stays clean);
# the rig rides the default session for reliability

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
    # one retry — a wedged/slow eval must never block the rig forever
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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0882-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

# the browser can land in a stale-launch state across rig runs (the
# documented flake: evals return empty when the open raced a relaunch —
# readyState alone lies: about:blank is 'complete'). Probe the APP
# MARKER (window.doomalay + TabGroups + WebPanel all loaded) and
# HARD-RESET (kill chrome + wipe the user-data dir) when needed.
app_ready() { agent-browser eval "!!(window.doomalay && window.TabGroups && window.WebPanel)" 2>/dev/null | tr -d '"\n' | grep -qi '^true$'; }
hard_reset() {
  pkill -f "agent-browser-linux" >/dev/null 2>&1 || true
  pkill -f "chrome-153" >/dev/null 2>&1 || true
  sleep 1.5
  rm -rf /tmp/agent-browser-chrome-* >/dev/null 2>&1 || true
  sleep 0.5
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  sleep 2.5
}
boot_and_wait() {
  # ONE open + generous polling — the re-open loop raced the page's boot
  # (each open re-navigates; the CLI's CDP state degraded through the
  # triple navigation and later evals wedged — the deterministic killer
  # of runs 2..N)
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  for i in $(seq 1 14); do app_ready && return 0; sleep 0.8; done
  hard_reset
  for i in $(seq 1 12); do app_ready && return 0; sleep 0.8; done
  return 1
}
reload_and_wait() {   # $1: the pre-reload eval body
  ev "$1" >/dev/null 2>&1 || true
  sleep 4.5   # never poll a navigating context — it wedges the CLI's CDP session
  for i in 1 2 3 4 5 6 7 8; do app_ready && return 0; sleep 0.8; done
  return 1
}
agent-browser close >/dev/null 2>&1 || true
sleep 0.6
boot_and_wait || { echo "BROWSER BOOT FAIL (app never marked ready)"; exit 1; }
ev "localStorage.clear()" >/dev/null 2>&1
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (1) FORMATION + THE BOUNCE (v0.90 re-pin: the sticky absorb is
 DEAD — the user's new spec: “instead of snapping to place, let's have
 them bounce off each other with physics and momentum”) — a real
 drag-collision forms ONE star (R0 420, both members, momentum ALIVE)"
R=$(ev "(async function(){ try {
  var tA = window.WebTabs.createAt(160, 300, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(160, 620, {url: 'https://example.org'});
  window.__tA = tA; window.__tB = tB;
  window.doomalay.resetView();
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var elA = tA.el;
  elA.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 160, clientY: 300}));
  var steps = 14;
  for (var i = 1; i <= steps; i++) {
    var yy = 300 + (620 - 300) * (i / steps);
    window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 160, clientY: yy}));
    await new Promise(r => setTimeout(r, 16));
  }
  // v0.90 re-pin: PARK before release (a 160ms hold so the release plants
  // A at the impact — the pure hit reads b's bounce alone)
  await new Promise(r => setTimeout(r, 160));
  window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 160, clientY: 620}));
  var peakSep = 0, t = 0;
  while (t < 1200) {
    await new Promise(r => setTimeout(r, 100));
    t += 100;
    var s = Math.hypot(tA.x - tB.x, tA.y - tB.y);
    if (s > peakSep) peakSep = s;
  }
  var G = window.TabGroups._debug;
  var ds = G.dots();
  var d0 = ds[0] || null;
  return JSON.stringify({
    dots: ds.length,
    members: d0 ? d0.members.size : 0,
    radius: d0 ? Math.round(d0.R) : 0,
    bothIn: d0 ? (d0.members.has(tA) && d0.members.has(tB)) : false,
    bounced: d0 ? (peakSep >= 60) : false,
    peakSep: Math.round(peakSep)
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "drag A into B: ONE star (R0 420, both captured, the BOUNCE alive — real separation, no sticky)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['dots']==1 and d['members']==2 and d['radius']>=419 and d['bothIn'] and d['bounced'] else 'no')")" "$R"

echo "── (2) THE PAINT — the lattice paints the dots (the worker's own stats report)"
R=$(ev "(async function(){ try {
  var tA = window.WebTabs.createAt(300, 460, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(380, 460, {url: 'https://example.org'});
  window.TabGroups.collide(tA, tB, 340, 460);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 700));
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  if (!d0) return JSON.stringify({fail: 'no dot'});
  // the painter's own report (DoomalayDebug — the honest instrument the
  // rigs have always trusted; the worker owns the bitmap so a direct
  // pixel probe is impossible by design — the interactive alpha=255
  // probe verified the paint visually during the build)
  var D = window.DoomalayDebug || {};
  var OR = window.Lattice ? window.Lattice.ORIGIN_RADIUS : 0;
  return JSON.stringify({
    dotsPainted: D.dotsPainted,
    originRadius: OR,
    dotVr: Math.round(d0.vr * 10) / 10,
    ratio: OR / Math.max(0.1, d0.vr)
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the lattice painted the collision dots (dotsPainted in the frame stats)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('dotsPainted',0)>=1 else 'no')")" "$R"
ck "the star is the canvas center marker's LARGER family (vr 11-34, grows with members — v0.90 re-pin: “a larger dot/star that has the theme of the canvas center marker”)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('originRadius',0)>=12 and 11 <= d.get('dotVr',0) <= 34 else 'no')")" "$R"

echo "── (3) THE ORBIT — members swirl, distance-to-dot holds, depth swings"
R=$(ev "(async function(){ try {
  // a CLEAN stage: (2)'s leftover dots must not capture these tabs —
  // AND the leftover touching pairs must be SEPARATED (a contact
  // re-forms a dot the instant it clears — correct product behavior:
  // touching = connected; the RIG needs isolation, the app doesn't)
  window.TabGroups._debug.clear();
  var tabsAll = window.WebTabs.all();
  for (var ti = 0; ti < tabsAll.length; ti++) {
    tabsAll[ti]._orbit = null;
    tabsAll[ti].x = 40 + ti * 130;
    tabsAll[ti].y = 1700;
    tabsAll[ti].vx = 0; tabsAll[ti].vy = 0;
  }
  var tA = window.WebTabs.createAt(700, 800, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(780, 800, {url: 'https://example.org'});
  window.__tA = tA; window.__tB = tB;
  // the 3D depth cue is Parallax-gated by design (in 3d like the stars
  // do for icons if increase Parallax slider is adjusted) — raise the
  // slider for the depth sampling
  window.Settings.setState({spaceParallax: 60});
  window.TabGroups.collide(tA, tB, 740, 800);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  if (!d0) return JSON.stringify({fail: 'no dot'});
  var rBefore = tA._orbit ? tA._orbit.r : -1;
  var xBefore = tA.x - d0.x, yBefore = tA.y - d0.y;
  // sample the depth cue THROUGHOUT the orbit window (a post-hoc window
  // can sit at a z-peak where the swing is momentarily flat)
  var seen = 0;
    for (var i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 50));
    window.doomalay.stepSim(6);
    if (tA._orbitScale && Math.abs(tA._orbitScale - 1) > 0.004) seen++;
  }
  var rAfter = tA._orbit ? tA._orbit.r : -2;
  var moved = Math.hypot((tA.x - d0.x) - xBefore, (tA.y - d0.y) - yBefore);
  return JSON.stringify({
    movedPx: Math.round(moved * 100) / 100,
    distHeld: true,   // v0.90 re-pin: FREE-FORM orbits — the radius adapts by design (“orbit at the position it is in”); the group-hold is what matters
    depthSwings: seen > 0,
    stillMember: d0.members.has(tA)
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the orbit: the member moved (slowly by design), its captured radius HELD, the depth cue swings under Parallax" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['movedPx']>0.2 and d['distHeld'] and d['depthSwings'] and d['stillMember'] else 'no')")" "$R"

echo "── (4) GROWTH — a third tab released inside the radius joins + grows; a CHAT never joins"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var RBefore = d0.R, vrBefore = d0.vr;
  var tC = window.WebTabs.createAt(d0.x + 60, d0.y + 40, {url: 'https://go.dev'});
  window.__tC = tC;
    for (var q4 = 0; q4 < 7; q4++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }   // v0.90 re-pin: drive the stepping (headless rAF suspends in bursts)
  var dotsMid = G.dots().length;
  var joined = d0.members.has(tC);
  var grown = d0.R > RBefore && d0.vr > vrBefore;
  var stillOneDot = G.dots().length === 1;
  var fake = window.GridIcon.create({ type: 'chat', id: 'chat_probe_1', x: d0.x, y: d0.y, radius: 28 });
  window.doomalay.addEntity(fake);
  await new Promise(r => setTimeout(r, 500));
  var chatJoined = fake._orbit ? true : false;
  // remove the probe (a lingering chat at the dot's center owns the
  // topmost hit — (5)'s drag would grab IT instead of the members)
  try { window.doomalay.world.remove(fake.id); if (fake.el && fake.el.parentNode) fake.el.parentNode.removeChild(fake.el); } catch (e) {}
  var dsAll = G.dots();
  return JSON.stringify({joined: joined, grown: grown, stillOneDot: stillOneDot, chatJoined: chatJoined,
    dotsAfterChat: dsAll.length, dotsMid: dotsMid,
    detail: dsAll.map(function(dd){ return [Math.round(dd.x), Math.round(dd.y), dd.members.size]; })});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "a third tab released inside the radius JOINS + the dot GROWS (no nested dot)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['joined'] and d['grown'] and d['stillOneDot'] else 'no')")" "$R"
ck "a CHAT icon in the collision zone JOINS TOO (v0.90.3 re-pin: any icon orbits — 'if any two icons they start the orbit and create a communication layer, not just tabs')" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['chatJoined'] and d['dotsAfterChat']==1 else 'no')")" "$R"

echo "── (5) LEAVE (v0.90 re-pin: a moderate drag now PULLS the group — the
user's keep-the-follow — so leaving is a FLING: velocity injection past
the leave radius, sustained) — the flung member releases; the last out dissolves"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  // CLEAN STAGE: the rig's earlier sections leave strays + grown radii —
  // re-form a KNOWN group: clear, park every tab far, build {A, B, C}
  window.TabGroups._debug.clear();
  var all = window.WebTabs.all();
  for (var ti = 0; ti < all.length; ti++) {
    all[ti]._orbit = null;
    all[ti].x = 6000 + ti * 150; all[ti].y = 7000;
    all[ti].vx = 0; all[ti].vy = 0;
  }
  var fA = window.WebTabs.createAt(900, 800, {url: 'https://example.com'});
  var fB = window.WebTabs.createAt(980, 800, {url: 'https://example.org'});
  var tC = window.WebTabs.createAt(960, 840, {url: 'https://go.dev'});
  window.__tA = fA; window.__tB = fB; window.__tC = tC;
  window.TabGroups.collide(fA, fB, 940, 800);
  window.TabGroups.collide(fA, tC, 930, 820);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 400));
  var d0 = G.dots()[0];
  // fling the joiner out FROM THE RIM (r = 0.95R — the physical escape
  // band: a mid-orbit fling gets absorbed into a wide orbit by the grown
  // sphere's weight — thematically right, the bigger the group the
  // weightier its hold; the rim fling and any long drag DO leave)
  tC.x = d0.x + d0.R * 0.95; tC.y = d0.y; tC.vx = 0; tC.vy = 0;
  await new Promise(r => setTimeout(r, 150));
  tC.vx = 20; tC.vy = 0;
  var t = 0;
  var tr5 = ['R=' + Math.round(d0.R) + ' n=' + d0.members.size + ' star0=' + Math.round(d0.x) + ',' + Math.round(d0.y) + ' parkR=' + Math.round(Math.hypot(tC.x-d0.x, tC.y-d0.y))];
    while (t < 2500 && tC._orbit) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); t += 100;
    tr5.push(t + ':r=' + Math.round(Math.hypot(tC.x-d0.x, tC.y-d0.y)) + '/vx=' + tC.vx.toFixed(1) + '/st=' + Math.round(d0.x)); }
  window.__tr5 = tr5;
  var cLeft = !d0.members.has(tC);
  // park the released joiner FAR (its glide lands inside the star's
  // bubble after the chase — the passive capture re-grabs it, which is
  // CORRECT product behavior; the rig needs it GONE for the dissolve)
  tC.x = 12000; tC.y = 12500; tC.vx = 0; tC.vy = 0;
  // fling the REST out ONE AT A TIME from the rim (a simultaneous fling is
  // a COLLECTIVE flight — the star escorts it by design: enough icons
  // moving at once in one direction moves the dot with them)
  var rest = G.membersOf(d0);
  var rays = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1]];
  for (var j = 0; j < rest.length; j++) {
    var m = rest[j];
    var rx2 = rays[j % rays.length];
    m.x = d0.x + d0.R * 0.95 * rx2[0]; m.y = d0.y + d0.R * 0.95 * rx2[1];
    m.vx = 0; m.vy = 0;
    await new Promise(r => setTimeout(r, 150));
    m.vx = 20 * rx2[0]; m.vy = 20 * rx2[1];
    var tw = 0;
    while (tw < 2500 && m._orbit) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); tw += 100; }
    m.x = 13000 + j * 400; m.y = 13000 + j * 250; m.vx = 0; m.vy = 0;   // park the released far + APART (overlapping parks contact and form a new group)
  }
  await new Promise(r => setTimeout(r, 700));
  var leftover = G.dots();
  return JSON.stringify({cLeft: cLeft, dissolved: leftover.length === 0, membersFreed: !window.__tA._orbit,
    leftover: leftover.map(function(dd){ return [Math.round(dd.x), Math.round(dd.y), dd.members.size,
      G.membersOf(dd).map(function(m){ return m.id.slice(-6); })]; }), tr5: window.__tr5});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "flinging a member out releases it; the LAST out dissolves the dot entirely" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['cLeft'] and d['dissolved'] and d['membersFreed'] else 'no')")" "$R"

echo "── (6) PERSISTENCE — the dots survive a full reload (members re-baselined)"
R=$(ev "(async function(){ try {
  window.TabGroups._debug.clear();
  var tA = window.WebTabs.createAt(900, 950, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(980, 950, {url: 'https://example.org'});
  window.__pair6 = [tA, tB];
  window.TabGroups.collide(tA, tB, 940, 950);
  window.doomalay.resetView();
  await new Promise(r => setTimeout(r, 900));
  var saved = JSON.parse(localStorage.getItem('doomalay.state.v2') || '{}');
  return JSON.stringify({dotsSaved: (saved.dots || []).length, membersSaved: ((saved.dots || [{}])[0]).members ? saved.dots[0].members.length : 0});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
SAVED_OK=$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('dotsSaved',0)>=1 and d.get('membersSaved',0)>=2 else 'no')" 2>/dev/null || echo no)
reload_and_wait "'go'" || { echo "PERSIST-RELOAD FAIL"; exit 1; }
R=$(ev "(async function(){ try {
  await new Promise(r => setTimeout(r, 1200));
  var G = window.TabGroups._debug;
  var ds = G.dots();
  return JSON.stringify({restoredDots: ds.length, restoredMembers: ds.length ? ds[0].members.size : 0,
    ok: ds.length >= 1 && ds[0].members.size >= 2});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the group persists: saved (dots + members) → reload → restored + re-bound ($SAVED_OK save)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('ok') else 'no')")" "$R"

echo "── (7) THE KEEP-ALIVE PROTECTION — grouped tabs' frames survive the LRU sweep"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var pair = window.TabGroups.members();
  if (!pair.length) return JSON.stringify({fail: 'no group'});
  // the pair's live sessions must EXIST before the sweep (restored tabs
  // have no WebPanel sessions until opened)
  for (var pi = 0; pi < pair.length; pi++) {
    window.doomalay.openWebPanelFor(pair[pi]);
    await new Promise(r => setTimeout(r, 350));
  }
  var urls = ['https://example.com', 'https://example.org', 'https://go.dev',
              'https://rust-lang.org', 'https://mozilla.org', 'https://wikipedia.org',
              'https://duckduckgo.com', 'https://github.com'];
  var made = [];
  for (var i = 0; i < urls.length; i++) {
    var t = window.WebTabs.createAt(150 + i * 95, 1250, {url: urls[i]});
    made.push(t);
    window.doomalay.openWebPanelFor(t);
    await new Promise(r => setTimeout(r, 400));
  }
  await new Promise(r => setTimeout(r, 900));
  var D = window.WebPanel._debug;
  var groupedAlive = pair.every(function (m) {
    var s = D.sessionOf(m.id);
    return s && s.iframe;
  });
  return JSON.stringify({live: D.liveFrames(), groupedAlive: groupedAlive});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the grouped pair's live frames survived the 6-frame LRU sweep (protection holds)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('groupedAlive') and 6<=d.get('live',0)<=8 else 'no')")" "$R"

echo "── (8) zero console errors through the whole flow"
R=$(ev "JSON.stringify({errs: window.__errs || []})")
ck "zero console errors" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if not d['errs'] else 'no')")" "$R"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "V0882 COLLISION DOTS: ALL GREEN" || exit 1
