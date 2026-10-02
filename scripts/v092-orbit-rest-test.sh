#!/bin/bash
# v092-orbit-rest-test.sh — THE ORBIT REST, PROVEN (PLAN-V092 §v0.92.1).
#
# The measured root cause of the sustained gradient lag (RESEARCH-V092's
# orbit rig): while a tab group orbits at rest, every member's per-frame
# style.transform write woke the projection painter — ~30 FULL paints/s
# + ~92 motion ticks/s, forever, each one re-anchoring + re-rastering
# every gradient surface in the DOM (the phone's 30-50% frame-rate loss
# with gradient themes; the heat + raster pressure behind "degrades
# fast, fresh boot is best").
#
# THE CONTRACT (v0.92.1: the icon chrome went LOCAL + the observer
# learned orbit noise + .chatbot left the root registry):
#  (1) with a group orbiting + mesh gradients + ambient + ZERO input:
#      paints/s ≤ 1 (was 25-31) and motions/s ≤ 2 (was 92);
#  (2) the released control is quiet too (no self-sustaining loop);
#  (3) the disc still renders the theme's gradient (LOCAL now);
#  (4) the panel's big surfaces still project (the field look survives);
#  (5) zero console errors.
set -u
cd "$(dirname "$0")/.."
ENG=engine/bin/doomalay-engine
PORT=$((8460 + $$ % 300))
BASE=http://127.0.0.1:$PORT
DATA=/tmp/doomalay-v092-orbit

rm -rf $DATA; mkdir -p $DATA
$ENG -open=false -port=$PORT -data-dir=$DATA >/tmp/v092or-eng.log 2>&1 &
ENGPID=$!
cleanup(){ kill $ENGPID 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 80); do curl -s $BASE/api/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -s $BASE/api/health >/dev/null 2>&1 || { echo "BOOT FAIL"; exit 1; }
echo "engine up :$PORT"

python3 - $PORT <<'PYEOF'
import json, sys, time, urllib.request
from playwright.sync_api import sync_playwright
PORT = sys.argv[1]
BASE = f"http://127.0.0.1:{PORT}"
STATE = json.dumps({"offset":{"x":0,"y":0},"scale":1,"currentFamily":"beast","icons":[
 {"type":"chat","id":"chat_o1","name":"Orbit A","family":"beast","iconIndex":0,"x":200,"y":400,"vx":0,"vy":0,"radius":28,"sessionId":""},
 {"type":"chat","id":"chat_o2","name":"Orbit B","family":"beast","iconIndex":1,"x":300,"y":420,"vx":0,"vy":0,"radius":28,"sessionId":""}],
 "dots":[],"savedAt":int(time.time()*1000)})
def mesh(cs): return {"colors":cs,"dir":"mesh"}
crazy = {"--bg-app":mesh(["#1a0b2e","#0b1e3a","#3a0b2a","#0b3a2e","#2e1a0b"]),
 "--bg-panel":mesh(["#2e0b1a","#0b2e3a","#1a2e0b","#3a1a0b","#0b1a2e"]),
 "--surface-1":mesh(["#241339","#13395c","#5c1323","#135c39","#392413"]),
 "--surface-2":mesh(["#2b1a44","#1a44b0","#441a2b","#1a442b","#442b1a"]),
 "--surface-3":mesh(["#331f50","#1f5069","#501f33","#1f5033","#50331f"]),
 "--border":mesh(["#4a2a66","#2a6685","#662a3f","#2a6640","#664a2a"]),
 "--accent":mesh(["#e879f9","#22d3ee","#f472b6","#34d399","#fbbf24"])}

PASS=0; FAIL=0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ✓ {name}")
    else: FAIL += 1; print(f"  ✗ {name}  {extra}")

with sync_playwright() as pw:
    br = pw.chromium.launch()
    pg = br.new_page(viewport={"width":412,"height":915}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE, wait_until="networkidle"); pg.wait_for_timeout(1500)
    pg.evaluate(f"st => {{ localStorage.clear(); localStorage.setItem('doomalay.state.v2', st); }}", STATE)
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(2200)
    pg.evaluate("ov => window.Settings.setState({themeOverrides:{midnight:ov}})", crazy); pg.wait_for_timeout(900)
    pg.evaluate("() => window.Settings.setState({dotAnimate: true, lineAnimate: true})"); pg.wait_for_timeout(700)

    # form the group
    formed = pg.evaluate("""() => {
      const e = window.doomalay.world.entities;
      if (window.TabGroups && e.length >= 2) window.TabGroups.collide(e[0], e[1], 250, 410);
      return window.TabGroups ? window.TabGroups._debug.dotCount() : -1;
    }""")
    ok("the group formed (a dot exists)", formed >= 1, f"got {formed}")
    pg.wait_for_timeout(900)

    def stats():
        return json.loads(pg.evaluate("() => JSON.stringify(window.DoomProjection.stats)"))

    # (1) the orbit is QUIET: measure 6s of pure orbit
    s0 = stats(); pg.wait_for_timeout(6000); s1 = stats()
    pr = (s1["paints"] - s0["paints"]) / 6
    mr = (s1["motions"] - s0["motions"]) / 6
    ok(f"orbit paints/s ≤ 1 (got {pr:.1f}; pre-fix 25-31)", pr <= 1)
    ok(f"orbit motions/s ≤ 2 (got {mr:.1f}; pre-fix 92)", mr <= 2)

    # (2) release → still quiet (no self-sustaining loop)
    pg.evaluate("() => { if (window.TabGroups._debug) window.TabGroups._debug.clear(); }")
    pg.wait_for_timeout(400)
    s2 = stats(); pg.wait_for_timeout(3000); s3 = stats()
    pr2 = (s3["paints"] - s2["paints"]) / 3
    ok(f"released paints/s ≤ 1 (got {pr2:.1f})", pr2 <= 1)

    # (3) the disc renders the theme gradient, locally
    disc = pg.evaluate("""() => {
      const ic = document.querySelector('.chatbot .icon');
      if (!ic) return {bg: '', painted: false, botsAreRoots: -1};
      return { bg: getComputedStyle(ic).backgroundImage,
               painted: !!ic.__projPainted,
               botsAreRoots: Array.from(document.querySelectorAll('.chatbot'))
                 .filter(b => b.hasAttribute('data-proj-root')).length };
    }""")
    ok("the disc paints a gradient (the theme look survives)",
       "gradient(" in disc["bg"], disc["bg"][:60])
    ok("the disc left the painted set (LOCAL)", disc["painted"] is False)
    ok("no .chatbot is a projection root anymore", disc["botsAreRoots"] == 0,
       f"got {disc['botsAreRoots']}")

    # (4) the panel's big surfaces still project
    pg.evaluate("() => { const b = document.getElementById('settings-btn'); if (b) b.click(); }")
    pg.wait_for_timeout(1800)
    panel = pg.evaluate("""() => {
      const sec = document.querySelector('.settings-section');
      return { painted: sec ? !!sec.__projPainted : false,
               paintedCount: document.querySelectorAll('[style*="proj-tx"]').length };
    }""")
    ok("the settings section still projects (the field look)",
       panel["painted"] and panel["paintedCount"] > 0,
       f"painted={panel['painted']} n={panel['paintedCount']}")
    pg.evaluate("() => { if (window.Panel && window.Panel.close) window.Panel.close(); }")
    pg.wait_for_timeout(600)

    # (5) zero errors
    ok(f"zero console/page errors ({len(errs)})", len(errs) == 0)
    br.close()

print(f"════ v0.92.1 ORBIT REST: {PASS} passed, {FAIL} failed ════")
sys.exit(1 if FAIL else 0)
PYEOF
RC=$?
exit $RC
