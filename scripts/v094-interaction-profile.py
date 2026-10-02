#!/usr/bin/env python3
# v094-interaction-profile.py — THE INTERACTION PROFILER.
#
# THE GOAL (the user, live): double the interaction performance. The v092
# rigs measured the RESTING canvas (idle churn) — this rig measures the
# INTERACTIONS the user says still lag on the BlackView:
#
#   · canvas PAN with a finger (the #1 complaint — "only after I move")
#   · panel DRAG on the handle ("immensely laggy")
#   · TYPING in the messagebox ("worse with longer messages")
#   · panel OPEN/CLOSE ×10
#   · RESIZE burst (the Android gesture-nav viewport churn)
#
# FAITHFULNESS: real touch via CDP Input.dispatchTouchEvent at 120Hz
# (digitizer rate — the main-thread drain behavior is the root cause),
# CPU throttled 6x (CDP Emulation.setCPUThrottlingRate — BlackView
# class), mobile viewport 412x915 DPR 2, the gradient-mesh theme + 8
# bound chats (the v092-soak2 world).
#
# Metrics per scenario: fps + worst frame gap (a rAF probe running
# through the scenario), longTasks delta, DoomProjection paints/motions
# delta, lattice cache hits/misses delta.
#
# Usage: v094-interaction-profile.py [port] [--tag NAME]
import json
import sys
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8794
TAG = "run"
if "--tag" in sys.argv:
    TAG = sys.argv[sys.argv.index("--tag") + 1]
BASE = f"http://127.0.0.1:{PORT}"

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=25) as r:
        return json.loads(r.read().decode() or "{}")

api("GET", "/api/health")

N_CHATS = 8
N_EVENTS = 12
N_LONG_EVENTS = 60

# ── build the world server-side (the v092-soak2 world + 1 LONG chat) ──
# NB: icons carry sandbox+model (the gatelock needs them to render the
# composer — the typing scenario depends on it); the long chat is part of
# the world state so it opens via an EXISTING icon (the materialize path
# has a pre-existing state quirk where the first render misses the gate).
sessions = []
long_sid = None
for i in range(N_CHATS + 1):
    s = api("POST", "/api/sessions", {})
    sid = s["ID"]
    is_long = (i == N_CHATS)
    api("PATCH", f"/api/sessions/{sid}", {"Title": f"Perf Chat {i+1}", "Model": "privatemodeai/glm-5.3", "Sandbox": "quick"})
    n_ev = N_LONG_EVENTS if is_long else N_EVENTS
    for j in range(n_ev):
        typ = "user" if j % 2 == 0 else "assistant"
        if is_long:
            txt = ("A considerably longer message body number %d with real "
                   "sentences that wrap across the narrow panel width. " % j) * 3
        else:
            txt = (f"Message {j} in chat {i+1}: " + ("lorem ipsum dolor sit amet, " * 12))
        api("POST", f"/api/sessions/{sid}/events", {"type": typ, "text": txt})
    if is_long:
        long_sid = sid
    else:
        sessions.append(sid)

icons = []
for i, sid in enumerate(sessions + [long_sid]):
    icons.append({
        "type": "chat", "id": f"chat_perf{i+1}",
        "name": f"Perf {i+1}", "family": "beast", "iconIndex": i % 8,
        "x": 140 + (i % 4) * 260, "y": 260 + (i // 4) * 300,
        "vx": 0, "vy": 0, "radius": 28,
        "sandbox": "quick", "model": "privatemodeai/glm-5.3",
        "sessionId": sid,
    })

STATE = json.dumps({
    "offset": {"x": 0, "y": 0}, "scale": 1,
    "currentFamily": "beast", "icons": icons, "dots": [],
    "savedAt": int(time.time() * 1000),
})

def crazy():
    def mesh(colors):
        return {"colors": colors, "dir": "mesh"}
    return {
        "--bg-app":     mesh(["#1a0b2e", "#0b1e3a", "#3a0b2a", "#0b3a2e", "#2e1a0b"]),
        "--bg-panel":   mesh(["#2e0b1a", "#0b2e3a", "#1a2e0b", "#3a1a0b", "#0b1a2e"]),
        "--surface-1":  mesh(["#241339", "#13395c", "#5c1323", "#135c39", "#392413"]),
        "--surface-2":  mesh(["#2b1a44", "#1a44b0", "#441a2b", "#1a442b", "#442b1a"]),
        "--surface-3":  mesh(["#331f50", "#1f5069", "#501f33", "#1f5033", "#50331f"]),
        "--border":     mesh(["#4a2a66", "#2a6685", "#662a3f", "#2a6640", "#664a2a"]),
        "--accent":     mesh(["#e879f9", "#22d3ee", "#f472b6", "#34d399", "#fbbf24"]),
    }

from playwright.sync_api import sync_playwright

PROBE_START = """
window.__probe = { frames: 0, t0: performance.now(), last: performance.now(), maxGap: 0 };
window.__probeStop = false;
(function loop() {
  if (window.__probeStop) return;
  const now = performance.now();
  const dt = now - window.__probe.last;
  if (dt > window.__probe.maxGap) window.__probe.maxGap = dt;
  window.__probe.last = now; window.__probe.frames++;
  requestAnimationFrame(loop);
})();
"""

PROBE_READ = """
() => {
  const p = window.__probe || {};
  const secs = Math.max(0.001, (performance.now() - p.t0) / 1000);
  const PR = (window.DoomProjection && window.DoomProjection.stats) || {};
  const P = window.DoomalayPerf || {};
  return {
    fps: Math.round((p.frames || 0) / secs),
    maxGapMs: Math.round(p.maxGap || 0),
    frames: p.frames || 0,
    paints: PR.paints || 0, motions: PR.motions || 0,
    longTasks: P.longTasks || 0, longWorst: Math.round(P.longTaskWorst || 0),
    hits: P.cacheHits || 0, misses: P.cacheMisses || 0,
  };
}
"""

def snap(pg):
    return pg.evaluate(PROBE_READ)

def delta(a, b):
    d = {}
    for k in ("fps", "maxGapMs", "longWorst"):
        d[k] = b[k] if k in ("fps", "maxGapMs", "longWorst") else 0
    for k in ("frames", "paints", "motions", "longTasks", "hits", "misses"):
        d[k] = b.get(k, 0) - a.get(k, 0)
    d["fps"] = b["fps"]; d["maxGapMs"] = b["maxGapMs"]; d["longWorst"] = b["longWorst"]
    return d

def touch(cdp, typ, pts):
    cdp.send("Input.dispatchTouchEvent", {"type": typ, "touchPoints": pts})

def main():
    out = {"tag": TAG, "scenarios": [], "errors": []}
    errors = out["errors"]
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=["--js-flags=--expose-gc"])
        ctx = br.new_context(has_touch=True, viewport={"width": 412, "height": 915}, device_scale_factor=2)
        pg = ctx.new_page()
        cdp = pg.context.new_cdp_session(pg)
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 6})   # BlackView class
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.goto(BASE, wait_until="networkidle")
        pg.wait_for_timeout(1500)
        pg.evaluate(f"st => {{ localStorage.clear(); localStorage.setItem('doomalay.state.v2', st); }}", STATE)
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2500)
        # the crazy theme + ambient (the user's laggy configuration)
        pg.evaluate("ov => window.Settings.setState({themeOverrides: {midnight: ov}})", crazy())
        pg.wait_for_timeout(1200)
        pg.evaluate("() => window.Settings.setState({dotAnimate: true, lineAnimate: true})")
        pg.wait_for_timeout(800)

        def record(name, fn, dur):
            before = snap(pg)
            pg.evaluate(PROBE_START)
            t_scen = time.time()
            fn()
            real = round(time.time() - t_scen, 2)
            pg.wait_for_timeout(250)
            pg.evaluate("() => { window.__probeStop = true; }")
            after = snap(pg)
            d = delta(before, after)
            d["name"] = name; d["wallS"] = real
            out["scenarios"].append(d)
            print(json.dumps(d), flush=True)

        W, H = 412, 915

        # ── 1. CANVAS PAN STRESS — 120Hz touch zigzag, 4s ─────────────
        def pan():
            touch(cdp, "touchStart", [{"x": 200, "y": 450}])
            n = 480
            for i in range(n):
                x = 200 + 140 * __import__("math").sin(i / 28.0)
                y = 450 + 220 * __import__("math").sin(i / 19.0)
                touch(cdp, "touchMove", [{"x": x, "y": y}])
                time.sleep(4.0 / n)
            touch(cdp, "touchEnd", [])
            time.sleep(0.6)   # momentum tail
        record("canvas-pan-120hz", pan, 4.6)

        # ── 2. PANEL OPEN/CLOSE ×10 ──────────────────────────────────
        def open_close():
            for i in range(10):
                pg.evaluate(f"sid => window.doomalay.openChatBySession(sid)", sessions[i % N_CHATS])
                pg.wait_for_timeout(700)
                pg.evaluate("() => window.doomalay && window.doomalay.handleBack && window.doomalay.handleBack()")
                pg.wait_for_timeout(350)
        record("panel-open-close-x10", open_close, 11)

        # ── 3. TYPING STRESS — long transcript + a long multi-line draft ─
        # (the user's exact case: "laggy especially with longer messages";
        #  runs BEFORE the drag scenario — the drag-dismiss leaves the sheet
        #  in a state the rig can't cleanly reopen from)
        pg.evaluate("() => window.doomalay && window.doomalay.handleBack && window.doomalay.handleBack()")
        pg.wait_for_timeout(600)
        pg.evaluate(f"sid => window.doomalay.openChatBySession(sid)", long_sid)
        pg.wait_for_timeout(1500)
        def typing():
            ok = pg.evaluate("""() => {
              const i = document.querySelector('#chat-input');
              if (!i) return null;
              i.focus();
              return { rows: document.querySelectorAll('.msg-row, .msg').length };
            }""")
            if ok is None:
                raise RuntimeError("no #chat-input — panel not open")
            pg.wait_for_timeout(200)
            # 129 chars, then keep going to 630 — the multi-line autogrow case
            pg.keyboard.type("The quick brown fox jumps over the lazy dog. " * 3, delay=25)
            pg.keyboard.type(("This is a much longer line that wraps and wraps "
                              "and forces the textarea to grow past its cap, "
                              "exactly like the user's real laggy draft. "), delay=18)
            pg.wait_for_timeout(300)
            vlen = pg.evaluate("() => (document.querySelector('#chat-input') || {value:''}).value.length")
            print(f"  [typing] rows={ok['rows']} typedValueLen={vlen}", flush=True)
        record("typing-630-chars", typing, 12)

        # ── 4. PANEL DRAG STRESS on the header, 4s ────────────────────
        # open + wait for the rise to settle
        pg.evaluate("() => window.doomalay && window.doomalay.handleBack && window.doomalay.handleBack()")
        pg.wait_for_timeout(600)
        pg.evaluate(f"sid => window.doomalay.openChatBySession(sid)", sessions[0])
        pg.wait_for_timeout(1200)
        hdr = pg.evaluate("""() => {
          const h = document.querySelector('#chat-panel .panel-header') || document.querySelector('#panel-handle');
          if (!h) return null;
          const r = h.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + 12, w: r.width };
        }""")
        if hdr:
            hx, hy = hdr["x"], hdr["y"]
            def drag():
                touch(cdp, "touchStart", [{"x": hx, "y": hy}])
                n = 240
                for i in range(n):
                    y = hy + 60 * (1 - __import__("math").cos(i / 12.0))
                    touch(cdp, "touchMove", [{"x": hx + (i % 7) - 3, "y": y}])
                    time.sleep(4.0 / n)
                touch(cdp, "touchEnd", [])
                time.sleep(0.8)
            record("panel-drag-60hz", drag, 4.8)
        else:
            print("!! no panel header found — skipping panel drag", flush=True)

        # ── 5. RESIZE BURST — the Android gesture-nav churn ───────────
        def resize():
            for i in range(10):
                pg.set_viewport_size({"width": 412, "height": 895 if i % 2 else 915})
                time.sleep(0.12)
            pg.set_viewport_size({"width": 412, "height": 915})
            time.sleep(0.8)
        record("resize-burst-x10", resize, 2.4)

        # ── 6. POST-EVERYTHING settle (the after-gesture feel) ───────
        pg.wait_for_timeout(1500)
        settle = snap(pg)
        settle["name"] = "final-settle"; settle["wallS"] = 0
        out["scenarios"].append(settle)
        print(json.dumps(settle), flush=True)

        br.close()

    path = f"/tmp/v094-{TAG}.json"
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n## {TAG} RESULTS → {path}")
    print(f"{'scenario':24s} {'fps':>4} {'maxGap':>7} {'paints':>7} {'motions':>8} {'longT':>6} {'worst':>6} {'hits':>6} {'miss':>6}")
    for s in out["scenarios"]:
        print(f"{s['name']:24s} {s['fps']:>4} {s['maxGapMs']:>6}ms {s['paints']:>7} {s['motions']:>8} {s['longTasks']:>6} {s['longWorst']:>6} {s['hits']:>6} {s['misses']:>6}")
    real_err = [e for e in errors if "favicon" not in e.lower()]
    print(f"  page errors: {len(real_err)}")
    for e in real_err[:8]:
        print("   !", e[:150])

if __name__ == "__main__":
    main()
