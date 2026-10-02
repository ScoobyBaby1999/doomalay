#!/usr/bin/env python3
# v092-degradation-soak2.py — THE REALISTIC-WORLD SOAK.
#
# The first soak (v092-degradation-profile.py) cycled settings tabs on an
# EMPTY world: heap/nodes/fps FLAT — no leak in that path. But the user's
# session has CHATS (icons with bound sessions + transcripts), drags,
# opens, ambient, gradients. This soak builds that world:
#
#   · 8 engine sessions (12 events each) + 8 bound icons in localStorage
#   · the crazy mesh-gradient theme + ambient ON
#   · the loop: open each chat's panel (transcript renders), check it,
#     close, drag 2 icons (orbits + projection motions), poke canvas,
#     cycle a settings tab
#   · samples every 20s: heap, nodes, #chat-root children, sheets,
#     iframes, icons, fps, longTasks, projPaints/motions
#
# THE QUESTION: does ANY metric grow monotonically across 12 minutes?
import json
import sys
import time
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
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

# ── build the world server-side ────────────────────────────────────
sessions = []
for i in range(N_CHATS):
    s = api("POST", "/api/sessions", {})
    sid = s["ID"]
    api("PATCH", f"/api/sessions/{sid}", {"Title": f"Soak Chat {i+1}"})
    for j in range(N_EVENTS):
        typ = "user" if j % 2 == 0 else "assistant"
        txt = (f"Message {j} in chat {i+1}: " + ("lorem ipsum dolor sit amet, " * 12))
        api("POST", f"/api/sessions/{sid}/events", {"type": typ, "text": txt})
    sessions.append(sid)

# the icons layout: 8 chats spread across the canvas
icons = []
for i, sid in enumerate(sessions):
    icons.append({
        "type": "chat", "id": f"chat_soak{i+1}",
        "name": f"Soak {i+1}", "family": "beast", "iconIndex": i,
        "x": 140 + (i % 4) * 260, "y": 260 + (i // 4) * 300,
        "vx": 0, "vy": 0, "radius": 28,
        "sessionId": sid,
    })

STATE = json.dumps({
    "offset": {"x": 0, "y": 0}, "scale": 1,
    "currentFamily": "beast", "icons": icons, "dots": [],
    "savedAt": int(time.time() * 1000),
})

from playwright.sync_api import sync_playwright

SAMPLE_JS = """
() => {
  const P = window.DoomalayPerf || {};
  const PR = (window.DoomProjection && window.DoomProjection.stats) || {};
  const mem = (performance && performance.memory) ? performance.memory : null;
  const cr = document.getElementById('chat-root');
  return new Promise((resolve) => {
    let frames = 0; const t0 = performance.now();
    function cnt() { frames++; if (performance.now() - t0 < 1200) requestAnimationFrame(cnt); }
    requestAnimationFrame(cnt);
    setTimeout(() => {
      resolve({
        fps: Math.round(frames / ((performance.now() - t0) / 1000)),
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
        nodes: document.querySelectorAll('*').length,
        chatKids: cr ? cr.children.length : -1,
        sheets: document.styleSheets.length,
        iframes: document.querySelectorAll('iframe').length,
        icons: document.querySelectorAll('.chatbot').length,
        longTasks: P.longTasks !== undefined ? P.longTasks : -1,
        projPaints: PR.paints !== undefined ? PR.paints : -1,
        projMotions: PR.motions !== undefined ? PR.motions : -1,
      });
    }, 1300);
  });
}
"""

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

results, errors = [], []

def main():
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=["--js-flags=--expose-gc"])
        pg = br.new_page(viewport={"width": 412, "height": 915}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.goto(BASE, wait_until="networkidle")
        pg.wait_for_timeout(1500)
        # inject the world + clear settings (fresh defaults)
        pg.evaluate(f"st => {{ localStorage.clear(); localStorage.setItem('doomalay.state.v2', st); }}", STATE)
        pg.reload(wait_until="networkidle")
        pg.wait_for_timeout(2500)

        def sample(tag):
            s = pg.evaluate(SAMPLE_JS)
            s["tag"] = tag; s["t"] = round(time.time())
            results.append(s)
            print(json.dumps(s), flush=True)

        sample("world-0s")
        # the crazy theme + ambient
        pg.evaluate("ov => window.Settings.setState({themeOverrides: {midnight: ov}})", crazy())
        pg.wait_for_timeout(1200)
        pg.evaluate("() => window.Settings.setState({dotAnimate: true, lineAnimate: true})")
        pg.wait_for_timeout(800)
        sample("grads+ambient")

        deadline = time.time() + MINUTES * 60
        cycle = 0
        chat_idx = 0
        while time.time() < deadline:
            cycle += 1
            chat_idx = (chat_idx % N_CHATS) + 1
            # 1. open a chat's panel via the app's own API (the transcript path)
            pg.evaluate(f"sid => window.doomalay.openChatBySession(sid)", sessions[chat_idx - 1])
            pg.wait_for_timeout(2200)
            # 2. scroll the transcript (the projection scroller path)
            pg.evaluate("""() => {
              const b = document.querySelector('.panel-body');
              if (b) b.scrollTop = Math.min(600, b.scrollHeight / 2);
            }""")
            pg.wait_for_timeout(1200)
            # 3. close the panel
            pg.evaluate("() => { if (window.Panel && window.Panel.close) window.Panel.close(); }")
            pg.wait_for_timeout(700)
            # 4. drag an icon across the canvas (physics + orbits + proj)
            try:
                bots = pg.locator(".chatbot")
                if bots.count() >= 2:
                    b = bots.nth(cycle % 2)
                    box = b.bounding_box()
                    if box:
                        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                        pg.mouse.move(cx, cy); pg.mouse.down()
                        for k in range(8):
                            pg.mouse.move(cx + k * 18, cy - k * 9)
                            pg.wait_for_timeout(16)
                        pg.mouse.up()
            except Exception:
                pass
            # 5. poke the canvas (pan)
            cv = pg.locator("#c").first
            try:
                box = cv.bounding_box()
                if box:
                    cx, cy = box["x"] + 120, box["y"] + 400
                    pg.mouse.move(cx, cy); pg.mouse.down()
                    for k in range(6):
                        pg.mouse.move(cx - k * 14, cy + k * 5)
                        pg.wait_for_timeout(16)
                    pg.mouse.up()
            except Exception:
                pass
            sample(f"cycle-{cycle}")
        sample("final")
        pg.evaluate("() => new Promise(r => { if (window.gc) { window.gc(); window.gc(); } setTimeout(r, 400); })")
        sample("post-gc")
        br.close()

    print("\n## SUMMARY (first vs last cycle)")
    cyc = [r for r in results if r["tag"].startswith("cycle-")]
    first, last = cyc[0] if cyc else results[0], cyc[-1] if cyc else results[-1]
    for k in ["fps", "heapMB", "nodes", "chatKids", "sheets", "iframes", "icons",
              "longTasks", "projPaints", "projMotions"]:
        print(f"  {k:12s}: {first[k]:>6} → {last[k]:>6}  delta={last[k] - first[k]:+}")
    print(f"  post-gc heapMB={results[-1]['heapMB']} nodes={results[-1]['nodes']}")
    real_err = [e for e in errors if "favicon" not in e.lower()]
    print(f"  page errors: {len(real_err)}")
    for e in real_err[:10]:
        print("   !", e[:160])
    with open("/tmp/v092-soak2-samples.json", "w") as f:
        json.dump({"samples": results, "errors": errors[:80]}, f, indent=2)
    print("  samples → /tmp/v092-soak2-samples.json")

if __name__ == "__main__":
    main()
