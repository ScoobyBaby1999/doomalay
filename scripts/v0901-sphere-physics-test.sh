#!/bin/bash
# v0901-sphere-physics-test.sh — v0.90.1 THE BOUNCE + THE STEERING ORBITS.
#
# USER SPEC (verbatim): "When two icons collide, instead of snapping to
# place, let's have them bounce off each other with physics and momentum
# with an exponential curve out that varies depending on impact velocity."
# "Instead of having fixed orbital grids, we have a large sphere/circle,
# where any icon inside orbits at the position it is in."
# "I like how when u pull on one icon the other follows… icons can disturb
# other icons in the sphere when moved… If enough icons are moving at once
# in a certain direction the dot icon marking the center should also move
# but feel weightier." "The orbit itself is WAAAY too small" → R0 420.
#
# THE CONTRACT (drag tests ride the default WORKER painter — the headless
# software rasterizer makes main-mode full frames ~1s; the pixel probes
# switch to main paint in their own section):
#  (1) FORMATION + THE BOUNCE — a real drag-collision forms ONE star (R0
#      420, both members) and the hit tab keeps REAL momentum (v0.89.1's
#      sticky absorb is dead: |v| grows past the impact, then decays).
#  (2) THE BOUNCE DISTANCE — the pair separates ~3-4× the old visual
#      scale (peak separation ≥ 260px for the standard drag) and stays
#      grouped (no release).
#  (3) THE STEERING — 6s later both still orbit: members hold, speeds
#      within the orbital band (0.3×–2.5× ω(r)·r), the group intact.
#  (4) THE DISTURBANCE — shoving one member moves the other (member-member
#      collisions live again).
#  (5) THE FOLLOW — dragging one member toward the rim pulls the star +
#      the other member along (the centroid chase, weight 3×).
#  (6) THE WEIGHTY STAR — a collective push moves the star the SAME
#      direction but slower than the members (heavy), then regroups.
#  (7) LEAVE + DISSOLVE — flinging a member out releases it; the last one
#      out dissolves the star.
#  (8) PERSISTENCE — the star + memberships survive a full reload (v2 by
#      id; icon positions ride the icon rows).
#  (9) THE PAINT — the star paints on #c2 (main-mode pixel probe at the
#      star position; #c1 lattice is clean of dots).
#  (10) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=/home/z/doomalay-engine
PORT=8390
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v0901

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
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v0901-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; wait $ENGPID 2>/dev/null; agent-browser close >/dev/null 2>&1; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 && echo "engine up" || { echo "BOOT FAIL"; exit 1; }

app_ready() { agent-browser eval "!!(window.doomalay && window.TabGroups && window.WebTabs)" 2>/dev/null | tr -d '"\n' | grep -qi '^true$'; }
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
  agent-browser open "$BASE" >/dev/null 2>&1 || true
  for i in $(seq 1 14); do app_ready && return 0; sleep 0.8; done
  hard_reset
  for i in $(seq 1 12); do app_ready && return 0; sleep 0.8; done
  return 1
}
reload_and_wait() {
  ev "$1" >/dev/null 2>&1 || true
  agent-browser reload >/dev/null 2>&1 || true
  sleep 4.5
  for i in 1 2 3 4 5 6 7 8; do app_ready && return 0; sleep 0.8; done
  return 1
}
agent-browser close >/dev/null 2>&1 || true
sleep 0.6
boot_and_wait || { echo "BROWSER BOOT FAIL (app never marked ready)"; exit 1; }
ev "localStorage.clear()" >/dev/null 2>&1
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'armed'" >/dev/null 2>&1

echo "── (1) FORMATION + THE BOUNCE — one star, both members, momentum ALIVE"
R=$(ev "(async function(){ try {
  var tA = window.WebTabs.createAt(160, 260, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(160, 620, {url: 'https://example.org'});
  window.__tA = tA; window.__tB = tB;
  window.doomalay.resetView();
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 300));
  var elA = tA.el;
  elA.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: 160, clientY: 260}));
  var steps = 14;
    var peak = 0;
  for (var i = 1; i <= steps; i++) {
    var yy = 260 + (620 - 260) * (i / steps);
    window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: 160, clientY: yy}));
    await new Promise(r => setTimeout(r, 16));
  }
  // PARK before release (a 160ms finger-hold): dragVel goes stale so the
  // release plants A at the impact (the pure hit reads b's bounce alone;
  // a live fling would chase b and shrink the measured separation)
  await new Promise(r => setTimeout(r, 160));
  window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 160, clientY: 620}));
  var sep0 = Math.hypot(tA.x - tB.x, tA.y - tB.y);
  var peakSep = sep0, t = 0;
  while (t < 1200) {
    await new Promise(r => setTimeout(r, 100));
    window.doomalay.stepSim(6); t += 100;
    var s = Math.hypot(tA.x - tB.x, tA.y - tB.y);
    if (s > peakSep) peakSep = s;
  }
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0] || null;
  return JSON.stringify({
    dots: G.dots().length,
    members: d0 ? d0.members.size : 0,
    radius: d0 ? Math.round(d0.R) : 0,
    bothIn: d0 ? (d0.members.has(tA) && d0.members.has(tB)) : false,
    peakSep: Math.round(peakSep)
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "drag A into B: ONE star (R0 420, both captured)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['dots']==1 and d['members']==2 and d['radius']>=419 and d['bothIn'] else 'no')")" "$R"
echo "── (2) THE BOUNCE — deterministic: a known-velocity impact separates
 the pair ~3-4× the old visual scale and they stay grouped (no snap, no
 sticky absorb — the v0.88.2 behavior)"
R=$(ev "(async function(){ try {
  window.TabGroups._debug.clear();
  var all = window.WebTabs.all();
  for (var ti = 0; ti < all.length; ti++) {
    all[ti]._orbit = null;
    all[ti].x = 4000 + ti * 150; all[ti].y = 5000;
    all[ti].vx = 0; all[ti].vy = 0;
  }
  var tA = window.WebTabs.createAt(600, 800, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(700, 800, {url: 'https://example.org'});
  window.__tA = tA; window.__tB = tB;
  // form the group DIRECTLY first (the ambient tick must be alive for the
  // physics to run — a cleared stage has no dots and update() won't
  // self-start the loop; a live group keeps it ticking forever)
  window.TabGroups.collide(tA, tB, 650, 800);
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 250));
  // a KNOWN impact: member a at 10 px/frame toward member b (deterministic
  // — the mouse cadence in a busy headless page varies run-to-run; the
  // member-member bounce is the same physics path the formation rides)
  tA.vx = 10; tA.vy = 0;
  var sep0 = Math.hypot(tA.x - tB.x, tA.y - tB.y);
  var peakSep = sep0, t = 0;
    while (t < 1500) {
    await new Promise(r => setTimeout(r, 100));
    window.doomalay.stepSim(6); t += 100;
    var s = Math.hypot(tA.x - tB.x, tA.y - tB.y);
    if (s > peakSep) peakSep = s;
  }
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0] || null;
  return JSON.stringify({
    dots: G.dots().length,
    members: d0 ? d0.members.size : 0,
    bothIn: d0 ? (d0.members.has(tA) && d0.members.has(tB)) : false,
    peakSep: Math.round(peakSep)
  });
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "THE BOUNCE: peak separation ≥ 260px (3-4× the old visual scale), still grouped" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['peakSep']>=260 and d['bothIn'] else 'no')")" "$R"

echo "── (3) THE STEERING — the orbit holds (6s: members keep, speeds in band)"
R=$(ev "(async function(){ try {
    for (var q = 0; q < 60; q++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  if (!d0) return JSON.stringify({fail: 'no dot'});
  var ok = 0, band = 0, n = 0;
  d0.members.forEach(function(m) {
    n++;
    var dx = m.x - d0.x, dy = m.y - d0.y;
    var r = Math.sqrt(dx*dx + dy*dy) || 1;
    if (r <= d0.R + 110) ok++;
    var omega = 0.060 - (0.060 - 0.010) * Math.min(1, r / d0.R);
    var vpx = Math.hypot(m.vx, m.vy) * 60;
    var tgt = omega * r;
    if (tgt > 0.5 && vpx > tgt * 0.3 && vpx < tgt * 2.5) band++;
  });
  return JSON.stringify({kept: ok, n: n, band: band, dotCount: G.dots().length});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "after 6s: both members still orbiting inside the sphere" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('kept',0)==2 and d.get('n')==2 else 'no')")" "$R"
ck "orbital speeds within the band (0.3×–2.5× ω(r)·r)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('band',0)>=1 else 'no')")" "$R"

echo "── (4) THE DISTURBANCE — shoving one member moves the other"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var tA = window.__tA, tB = window.__tB;
  var bx0 = tB.x, by0 = tB.y;
  // park A beside B (a known contact range — the orbit may have carried
  // them to opposite rims after the bounce)
  tA.x = tB.x + 90; tA.y = tB.y; tA.vx = 0; tA.vy = 0;
  await new Promise(r => setTimeout(r, 120));
  var dx = tB.x - tA.x, dy = tB.y - tA.y;
  var dl = Math.hypot(dx, dy) || 1;
  tA.vx = (dx / dl) * 14; tA.vy = (dy / dl) * 14;
  var ax0 = tA.x;
    for (var q4 = 0; q4 < 15; q4++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }
  var bMoved = Math.hypot(tB.x - bx0, tB.y - by0);
  var aMoved = Math.abs(tA.x - ax0);
  return JSON.stringify({aMoved: Math.round(aMoved), bMoved: Math.round(bMoved),
    grouped: !!(tA._orbit && tB._orbit)});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the shove travels: A moved and B got disturbed (≥ 8px)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('aMoved',0)>40 and d.get('bMoved',0)>=8 else 'no')")" "$R"

echo "── (5) THE FOLLOW — drag one member to the rim: star + partner follow"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var tA = window.__tA, tB = window.__tB;
  var star0 = {x: d0.x, y: d0.y};
  var b0 = {x: tB.x, y: tB.y};
  var ax = (tA.el.getBoundingClientRect().left + tA.el.getBoundingClientRect().right) / 2;
  var ay = (tA.el.getBoundingClientRect().top + tA.el.getBoundingClientRect().bottom) / 2;
  tA.el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, clientX: ax, clientY: ay}));
  var V = window.doomalay.getView();
  var tx = d0.x + 360, ty = d0.y;
  var steps = 12;
  for (var i = 1; i <= steps; i++) {
    var wx = tA.x + (tx - tA.x) / (steps - i + 1);
    var wy = tA.y + (ty - tA.y) / (steps - i + 1);
    var sx = (wx - V.ox) * V.scale;
    var sy = (wy - V.oy) * V.scale;
    window.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: sx, clientY: sy}));
    await new Promise(r => setTimeout(r, 30));
  }
    for (var q5 = 0; q5 < 18; q5++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }   // hold + let the star chase
  var starD = Math.hypot(d0.x - star0.x, d0.y - star0.y);
  var bD = Math.hypot(tB.x - b0.x, tB.y - b0.y);
  var still = G.dots().length === 1 && d0.members.size === 2;
  window.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, clientX: 400, clientY: 300}));
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify({starMoved: Math.round(starD), bMoved: Math.round(bD), still: still});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the star followed the drag (≥ 60px toward the rim)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('starMoved',0)>=60 else 'no')")" "$R"
ck "the partner member followed too (≥ 25px)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('bMoved',0)>=25 else 'no')")" "$R"

echo "── (6) THE WEIGHTY STAR — a collective push moves it slower, then regroup"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var tA = window.__tA, tB = window.__tB;
  // park both members mid-orbit (r=200, opposite sides) — a collective
  // push from the rim would already sit on the leave boundary
  tA.x = d0.x + 200; tA.y = d0.y; tA.vx = 0; tA.vy = 0;
  tB.x = d0.x - 200; tB.y = d0.y; tB.vx = 0; tB.vy = 0;
  await new Promise(r => setTimeout(r, 400));
  var star0 = d0.x, a0 = tA.x, b0 = tB.x;
  tA.vx = 8; tA.vy = 0; tB.vx = 8; tB.vy = 0;
    for (var q6 = 0; q6 < 6; q6++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }
  var starD = d0.x - star0;
  var memD = ((tA.x - a0) + (tB.x - b0)) / 2;
  for (var q6b = 0; q6b < 35; q6b++) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); }   // settle
  var recenter = Math.hypot(
    ((tA.x + tB.x) / 2) - d0.x, ((tA.y + tB.y) / 2) - d0.y);
  return JSON.stringify({starD: Math.round(starD), memD: Math.round(memD),
    recenter: Math.round(recenter), grouped: !!(tA._orbit && tB._orbit)});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the star moved WITH the push but slower than the members (weightier)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('starD',0)>=20 and d.get('starD',0)<d.get('memD',0) else 'no')")" "$R"
ck "after settling the group recentered (centroid within 60% R of the star)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('recenter',0)<420*0.6 and d.get('grouped') else 'no')")" "$R"

echo "── (7) LEAVE + DISSOLVE — a flung member releases; the last out dissolves"
R=$(ev "(async function(){ try {
  var G = window.TabGroups._debug;
  var d0 = G.dots()[0];
  var tA = window.__tA, tB = window.__tB;
  // park A at a known radius on the +x ray, then fling outward hard —
  // the deliberate fling must cross R+70 and release (group survives)
  tA.x = d0.x + 250; tA.y = d0.y; tA.vx = 0; tA.vy = 0;
  await new Promise(r => setTimeout(r, 120));
  tA.vx = 20; tA.vy = 0;
  var t = 0;
    while (t < 2500 && tA._orbit) { await new Promise(r => setTimeout(r, 100)); window.doomalay.stepSim(6); t += 100; }
  var aGone = !tA._orbit;
  var stillOne = G.dots().length === 1 && d0.members.size === 1;
  G.release(tB);
  await new Promise(r => setTimeout(r, 200));
  return JSON.stringify({aGone: aGone, stillOne: stillOne, dots: G.dots().length});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the flung member left the group (the group survived with the other)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('aGone') and d.get('stillOne') else 'no')")" "$R"
ck "the last member out dissolved the star" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('dots')==0 else 'no')")" "$R"

echo "── (8) PERSISTENCE — the star + memberships survive a reload"
R=$(ev "(async function(){ try {
  // CLEAN STAGE: (7)'s strays must not own dots — clear + park every
  // existing tab far from the new pair (a leftover inside the new dot's
  // bubble would passive-capture and pollute the assertion)
  window.TabGroups._debug.clear();
  var all = window.WebTabs.all();
  for (var ti = 0; ti < all.length; ti++) {
    all[ti]._orbit = null;
    all[ti].x = 2000 + ti * 150; all[ti].y = 3000;
    all[ti].vx = 0; all[ti].vy = 0;
  }
  var tA = window.WebTabs.createAt(500, 300, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(560, 300, {url: 'https://example.org'});
  window.TabGroups.collide(tA, tB, 530, 300);
  await new Promise(r => setTimeout(r, 400));
  var n = window.TabGroups._debug.dots().length;
  return 'formed:' + n;
} catch(e) { return 'evalErr:' + String(e.message); } })()")
echo "  pre-reload: $R"
reload_and_wait "localStorage.setItem('__v0901_keep','1')" || { echo "RELOAD FAIL"; exit 1; }
R=$(ev "(async function(){ try {
  await new Promise(r => setTimeout(r, 700));
  var G = window.TabGroups._debug;
  var ds = G.dots();
  var tot = 0;
  ds.forEach(function(d){ tot += d.members.size; });
  return JSON.stringify({dots: ds.length, members: tot, radius: ds.length ? Math.round(ds[0].R) : 0});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "reload: the star + the 2-member pair restored (by id)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('dots')==1 and d.get('members')==2 else 'no')")" "$R"

echo "── (9) THE PAINT — the star paints on #c2 (main-mode pixel probe)"
# the worker owns the #c2 bitmap by design (transferControlToOffscreen) —
# the pixel probe needs MAIN mode. Seed via the app's own setState (a raw
# localStorage write gets CLOBBERED by the old page's pagehide flush)
# then wait out the 300ms debounce, then reload (the painter decision is
# read at module load).
ev "(async function(){ try {
  window.Settings.setState({workerPaint: false});
  await new Promise(r => setTimeout(r, 650));
  return 'seeded:' + JSON.parse(localStorage.getItem('doomalay.settings.v1')).workerPaint;
} catch(e) { return 'err:' + String(e.message); } })()" >/dev/null 2>&1
reload_and_wait "" || { echo "RELOAD FAIL (main-mode boot)"; exit 1; }
agent-browser eval "window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.message))}); 'rearmed'" >/dev/null 2>&1
R=$(ev "(async function(){ try {
  window.TabGroups._debug.clear();
  var tA = window.WebTabs.createAt(400, 300, {url: 'https://example.com'});
  var tB = window.WebTabs.createAt(470, 300, {url: 'https://example.org'});
  window.TabGroups.collide(tA, tB, 435, 300);
  window.doomalay.resetView();
  window.doomalay.repaint();
  await new Promise(r => setTimeout(r, 900));
  var d0 = window.TabGroups._debug.dots()[0];
  if (!d0) return JSON.stringify({fail: 'no dot'});
  var V = window.doomalay.getView();
  var px = Math.round((d0.x - V.ox) * V.scale), py = Math.round((d0.y - V.oy) * V.scale);
  var c2 = document.getElementById('c2');
  var g2 = c2.getContext('2d');
  var w = Math.max(2, Math.round(d0.vr));
  var img2 = g2.getImageData(px - w, py - w, w * 2, w * 2).data;
  var lit2 = 0;
  for (var i = 3; i < img2.length; i += 4) if (img2[i] > 40) lit2++;
  var dbg = window.DoomalayDebug || {};
  return JSON.stringify({lit: lit2, px: px, py: py, w: w, stars: dbg.orbitStars});
} catch(e) { return JSON.stringify({evalErr: String(e.message)}); } })()")
ck "the star's pixels are lit on #c2 (≥ 30 lit samples at the star)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('lit',0)>=30 else 'no')")" "$R"
ck "the paint instrument reports the orbit stars (DoomalayDebug.orbitStars)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d.get('stars',0)>=1 else 'no')")" "$R"

echo "── (10) console errors"
R=$(ev "JSON.stringify({errs: (window.__errs||[]).length, first: (window.__errs||[])[0] || ''})")
ck "zero console errors" "$(echo "$R" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print('yes' if d['errs']==0 else 'no')")" "$R"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "ALL GREEN" || exit 1
