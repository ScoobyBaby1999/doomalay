#!/usr/bin/env python3
# v38-gestures-test.py — THE PANEL PHYSICS REWORK red-team.
# Drives REAL touch sequences (CDP dispatchTouchEvent) and asserts:
#   1. 1:1 finger tracking + transition:none during the drag
#   2. deliberate drag down from default → CLOSE
#   3. small drag → springs back to default (spring, not CSS snap)
#   4. drag up → full; from full, modest down → default (the dock)
#   5. hard fling down from full → CLOSE (velocity projection)
#   6. the chat-body scroll chain still scrolls first, sheet grabs only at top+slop
import json, os, shutil, subprocess, sys, time
import urllib.request

BASE = "http://127.0.0.1:8157"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine")
DATA = "/tmp/doomalay-v38gest"
PORT = 8157
CW = "/tmp/dm-gest-cwd"

if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA); os.makedirs(CW, exist_ok=True)
elog = open("/tmp/v38gest-eng.log", "w")
proc = subprocess.Popen([os.path.abspath(ENG), "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
                        stdout=elog, stderr=elog, cwd=CW)
for _ in range(60):
    try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r: return r.read()

SID = json.loads(api("POST", "/api/sessions", {"title": "G", "sandbox": "quick",
    "model": "nvidia/z-ai/glm-5.3-flash", "provider": "nvidia"}))["ID"]
for i in range(12):
    api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": f"message {i} " + "x" * 80})
    api("POST", f"/api/sessions/{SID}/events", {"type": "assistant", "text": f"reply {i}: " + "lorem ipsum dolor sit amet. " * 12})

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "g1", "type": "chat", "name": "G", "family": "nvidia",
                "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                "sandbox": "quick", "model": "nvidia/z-ai/glm-5.3-flash",
                "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(800)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1600)

    cdp = ctx.new_cdp_session(pg)
    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": pts})
    def drag(x, y0, y1, steps=14, step_ms=16):
        touch("touchStart", [{"x": x, "y": y0}])
        for i in range(1, steps + 1):
            y = y0 + (y1 - y0) * i / steps
            touch("touchMove", [{"x": x, "y": y}])
            pg.wait_for_timeout(step_ms)
        touch("touchEnd", [])
    def fling(x, y0, y1, steps=6):
        drag(x, y0, y1, steps=steps, step_ms=8)
    # the handle sits ~20px below the sheet's CURRENT top — position-aware
    def handleY():
        r = pg.evaluate("() => document.getElementById('chat-panel').getBoundingClientRect().top")
        return int(r) + 22

    def panel_state():
        return pg.evaluate("""() => {
          const el = document.getElementById('chat-panel');
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return {open: el.classList.contains('open'), full: el.classList.contains('panel-full'),
                  h: Math.round(r.height), y: Math.round(r.top),
                  transition: st.transitionDuration + ' ' + st.transitionProperty,
                  transform: el.style.transform, inlineT: el.style.transition};
        }""")

    PASS = FAIL = 0
    def ok(cond, label, extra=""):
        global PASS, FAIL
        if cond: PASS += 1; print(f"  PASS {label}")
        else:    FAIL += 1; print(f"  FAIL {label} {extra}")

    # ══ 1. open state + 1:1 tracking during drag ═══════════════════════
    st0 = panel_state()
    ok(st0["open"] and 400 < st0["h"] < 520, f"default height ~62dvh ({st0['h']}px)", str(st0))
    # a live drag: sample mid-gesture
    touch("touchStart", [{"x": 200, "y": 300}])   # the header zone
    moved = 0
    for i in range(1, 11):
        y = 300 + 12 * i
        touch("touchMove", [{"x": 200, "y": y}])
        pg.wait_for_timeout(16)
        if i == 10:
            mid = panel_state()
            expected_top = st0["y"] + 120  # finger moved 120px down → sheet top follows
            ok(abs(mid["y"] - expected_top) < 18, f"1:1 tracking mid-drag (top {mid['y']} ≈ {expected_top})", str(mid))
            ok(mid["inlineT"] == "none", f"transition SUPPRESSED during drag ('{mid['inlineT']}')")
    touch("touchEnd", [])
    pg.wait_for_timeout(500)  # the settle springs back

    # ══ 2. small drag springs back to default ══════════════════════════
    settled = None
    for _ in range(24):  # up to 1.2s — poll the spring
        stx = panel_state()
        if stx["transform"] == "" and stx["inlineT"] == "":
            settled = stx; break
        pg.wait_for_timeout(50)
    ok(settled is not None, f"after release the sheet settles (spring completes: transform '' + transition cleared)",
       str(settled or panel_state()))
    st = settled or panel_state()
    ok(400 < st["h"] < 520 and st["open"], f"still open at default height ({st['h']}px)")

    # ══ 3. drag up → full ══════════════════════════════════════════════
    yh = handleY(); drag(200, yh, yh - 210, steps=12)
    pg.wait_for_timeout(600)
    st = panel_state()
    ok(st["open"] and st["full"] and st["h"] > 740, f"drag up docked FULL ({st['h']}px, full={st['full']})", str(st))

    # ══ 4. from full: modest down drag → default (the dock) ════════════
    yh = handleY(); drag(200, yh, yh + 130, steps=12)   # modest down drag from the handle
    pg.wait_for_timeout(600)
    st = panel_state()
    ok(st["open"] and not st["full"] and 400 < st["h"] < 520, f"modest down from full DOCKED at default (h={st['h']}, full={st['full']})", str(st))

    # ══ 5. hard fling down from default → CLOSE ════════════════════════
    yh = handleY(); fling(200, yh, yh + 400, steps=5)   # hard fling down from the handle
    pg.wait_for_timeout(800)
    st = panel_state()
    ok(not st["open"], f"hard fling CLOSED the panel ({st['open']})")

    # reopen
    pg.mouse.click(120, 200); pg.wait_for_timeout(1500)
    st = panel_state()
    ok(st["open"], "panel reopens after close")

    # ══ 6. the scroll chain: body scrolls first ════════════════════════
    scrolled = pg.evaluate("""() => {
      const sc = document.getElementById('chat-scroll');
      const before = sc ? sc.scrollTop : -1;
      return before;
    }""")
    # scroll down to the middle first (drag UP on the body)
    drag(200, 600, 400, steps=10)
    pg.wait_for_timeout(400)
    after = pg.evaluate("() => { const sc = document.getElementById('chat-scroll'); return sc ? sc.scrollTop : -1; }")
    ok(after > scrolled and after > 40, f"body drag UP scrolled the conversation ({scrolled} → {after})")
    # now at depth: drag DOWN scrolls the conversation back up (sheet must NOT grab)
    top_before = after
    drag(200, 400, 620, steps=10)
    pg.wait_for_timeout(400)
    top_after = pg.evaluate("() => { const sc = document.getElementById('chat-scroll'); return sc ? sc.scrollTop : -1; }")
    ok(top_after <= top_before, f"body drag DOWN never grabbed the sheet mid-scroll ({top_before} → {top_after})")
    st = panel_state()
    ok(st["open"], "panel still open (scroll didn't close it)")
    # at TOP + slop → the sheet grabs (drag down far)
    pg.evaluate("() => { const sc = document.getElementById('chat-scroll'); sc.scrollTop = 0; }")
    pg.wait_for_timeout(200)
    drag(200, 500, 780, steps=14)
    pg.wait_for_timeout(800)
    st = panel_state()
    ok(not st["open"], "from the top with slop+intent, the drag CLOSES (scroll chain hands off)")

    ok(len(errors) == 0, f"zero page errors ({errors[:3]})")
    br.close()

proc.terminate(); proc.wait()
print(f"\n{'='*50}\nGESTURES TEST: {PASS} passed, {FAIL} failed\n{'='*50}")
sys.exit(1 if FAIL else 0)
