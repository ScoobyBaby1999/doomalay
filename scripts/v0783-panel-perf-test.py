#!/usr/bin/env python3
# v0783-panel-perf-test.py — THE PANEL FEEL II, PROVEN.
#
# User spec: "the browser in browser panel feels like its running on 80 fps
# and the regular panel feels like its running on 8 fps. Even when
# scrolling within the panel like scrolling thru text and stuff or clicking
# stuff in the panel."
#
# The fixes under test (v0.78.3):
#   1. scroll  → ONE CSSOM var write (--proj-sy), NO projection paints
#   2. taps    → cosmetic transitions paint nothing (transform → motion)
#   3. drags   → --panel-vis-h rides motion (0 full paints mid-glide)
#   4. streams → the two-tier render (stable tier append-only + tail-only
#                re-renders; the whole-text O(n²) re-parse is gone)
#   5. virtualized transcript rows (content-visibility)
#
# Run: python3 scripts/v0783-panel-perf-test.py [engine-port]
# Needs: engine running + an NVIDIA key in the vault (the stream test is a
# REAL model turn).
import json
import sys
import time
import urllib.request

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8790}"
MODEL = "nvidia/deepseek-ai/deepseek-v4.1-flash"

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = json.dumps(body).encode() if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=25) as r:
        return json.loads(r.read().decode() or "{}")

api("GET", "/api/health")
keys = api("GET", "/api/keys")
assert isinstance(keys, dict) and any(
    isinstance(v, dict) and v.get("env_var") == "NVIDIA_API_KEY" and v.get("has_key")
    for v in keys.values()), "NVIDIA key missing from the rig vault"

# a session with a long transcript (seeded events replay on open)
sess = api("POST", "/api/sessions", {"title": "Perf", "sandbox": "quick",
                                     "model": MODEL, "provider": "nvidia"})
SID = sess["ID"]
md = ("## Section %d\n\n" + ("- point one with **bold** and `code`\n"
     "- point two\n- point three\n\n" +
     "```python\n# a code block\ndef f(%d):\n    return %d * 2\n```\n\n" +
     "A paragraph of ordinary prose that wraps a couple of lines and " * 3 + "\n\n"))
for i in range(40):
    api("POST", f"/api/sessions/{SID}/events",
        {"type": "user", "text": f"question {i}"})
    api("POST", f"/api/sessions/{SID}/events",
        {"type": "assistant", "text": md % (i, i, i)})

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 405, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(900)
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "default",
             "icons": [{"type": "chat", "id": "chat_1", "name": "Perf",
                        "family": "default", "iconIndex": 0, "iconCustom": False,
                        "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": MODEL,
                        "provider": "nvidia", "sessionId": SID}],
             "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload()
    pg.wait_for_timeout(900)
    pg.mouse.click(120, 200)          # open the chat panel
    pg.wait_for_timeout(1800)
    rows = pg.evaluate("() => document.querySelectorAll('#chat-messages .msg-row').length")
    sc_info = pg.evaluate("""() => {
      const sc = document.querySelector('#chat-scroll');
      return sc ? {sh: sc.scrollHeight, ch: sc.clientHeight} : null;
    }""")
    assert sc_info and sc_info["sh"] > sc_info["ch"] * 3, f"transcript not long enough: {sc_info}"

    PASS = FAIL = 0
    def ok(cond, label):
        global PASS, FAIL
        if cond: PASS += 1; print(f"  PASS {label}")
        else:    FAIL += 1; print(f"  FAIL {label}")

    def stats():
        return pg.evaluate("() => window.DoomProjection && window.DoomProjection.stats")

    # ── 1. SCROLL: motion-grade, zero projection paints ──────────────
    pg.mouse.move(200, 420)                        # INSIDE the message area (the
    pg.wait_for_timeout(200)                       # old runs wheeled the CANVAS — pan paints)
    before = stats()
    for step in range(14):                         # ~1.2s of real wheel scrolling
        pg.mouse.wheel(0, 260)
        pg.wait_for_timeout(80)
    during = stats()
    scrollPaints = during["paints"] - before["paints"]
    pg.wait_for_timeout(350)                       # let the debounced settle land
    after = stats()
    ok(scrollPaints <= 2, f"scroll: ≤2 paints DURING the scroll (got {scrollPaints})")
    ok(after["paints"] - before["paints"] <= 4,
       f"scroll: ≤4 paints including the settle (got {after['paints'] - before['paints']})")
    # v0.78.3c: the incremental re-bake — no var, no rule; the painted
    # elements under the scroller carry adjusted constants. Verify the
    # anchors are TRUE at the final scroll position (numbers match rects).
    trueup = pg.evaluate("""() => {
      const sc = document.querySelector('#chat-scroll');
      if (!sc) return {ok: false, n: 0, drift: -1};
      let n = 0, worst = 0;
      for (const t of document.querySelectorAll('#chat-panel [style*="calc(var(--proj-tx"]')) {
        const r = t.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || !sc.contains(t)) continue;
        const m = /(-?[0-9.]+)px (-?[0-9.]+)px/.exec(getComputedStyle(t).backgroundPosition);
        if (!m) continue;
        n++;
        worst = Math.max(worst, Math.abs(parseFloat(m[2]) + r.top));
      }
      return {ok: n > 0 && worst < 2, n: n, drift: Math.round(worst * 10) / 10};
    }""")
    ok(trueup["ok"] and trueup["n"] >= 3,
       f"the scroll re-bake keeps anchors TRUE (n={trueup['n']}, worst drift={trueup['drift']}px)")

    # ── 2. TAPS ─────────────────────────────────────────────────────────
    # (a) PURE COSMETIC: hovering a markdown link (color transition) — the
    # old code full-painted 1-2× per cosmetic transition; now: zero.
    link = pg.locator(".msg-assistant .fmt-link").first
    if link.count():
        before = stats()
        link.hover()
        pg.wait_for_timeout(450)
        hoverPaints = stats()["paints"] - before["paints"]
        ok(hoverPaints == 0, f"a cosmetic hover (link color transition) costs ZERO paints (got {hoverPaints})")
    # (b) the header-row reveal ADDS DOM (toolbar pills) — legitimate
    # anchor paints, but BOUNDED (a couple, not one per transition frame)
    before = stats()
    pg.locator("#chat-header-row").click()
    pg.wait_for_timeout(600)
    tapPaints = stats()["paints"] - before["paints"]
    ok(tapPaints <= 8, f"a header-row reveal stays bounded — a one-shot DOM burst, NOT per-frame (got {tapPaints} paints)")
    # (c) the jump pill: scrolling UP shows it via a transform transition,
    # clicking it smooth-scrolls back — both stay paint-free
    before = stats()
    pg.mouse.wheel(0, -900)                       # away from the bottom → the pill shows
    pg.wait_for_timeout(700)
    jump = pg.locator("#chat-jump")
    if jump.is_visible():
        pg.evaluate("() => document.getElementById('chat-jump').click()")
        pg.wait_for_timeout(900)
    tapPaints2 = stats()["paints"] - before["paints"]
    ok(tapPaints2 <= 4, f"the jump pill (transform + smooth scroll) stays bounded — real show/hide flips only (got {tapPaints2})")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(700)

    # ── 3. DRAG: the panel glide (writeY + writeVis motion path) ─────
    # (the scrim click above CLOSED the panel — reopen it first; dragging
    # a closed panel exercises the dismiss path, not the glide)
    pg.mouse.click(120, 200)
    pg.wait_for_timeout(1500)
    before = stats()
    box = pg.locator("#panel-handle").bounding_box() or {"x": 200, "y": 700}
    pg.mouse.move(box["x"] + 150, box["y"] + 10)
    pg.mouse.down()
    for i in range(10):
        pg.mouse.move(box["x"] + 150, box["y"] + 10 + i * 12)
        pg.wait_for_timeout(30)
    mid = stats()
    dragPaints = mid["paints"] - before["paints"]
    pg.mouse.up()
    pg.wait_for_timeout(900)                       # spring settle paint
    ok(dragPaints <= 1, f"the panel glide costs ≤1 mid-drag paint (the one-time grab write; got {dragPaints}) — per-frame painting is DEAD")
    ok(stats()["motions"] - before["motions"] >= 10,
       "the glide rode the motion path (motions ≥ 10)")
    pg.evaluate("() => document.getElementById('chat-scrim').click()")
    pg.wait_for_timeout(700)

    # ── 4. STREAM: the two-tier render on a REAL model turn ──────────
    pg.mouse.click(120, 200)
    pg.wait_for_timeout(1200)
    pg.fill("#chat-input",
            "Write a 400-word markdown story with 3 sections, each with a list and "
            "one python code block. Plain content, no artifacts.")
    pg.click("#chat-send")
    # watch the streaming bubble: the stable tier grows by CHUNKS (append-only)
    tier_info = pg.evaluate("""async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let saw = null;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const rows = document.querySelectorAll('#chat-messages .msg-bubble.msg-assistant');
        const last = rows[rows.length - 1];
        if (last) {
          const stable = last.querySelector(':scope > .fmt-tier-stable');
          const tail = last.querySelector(':scope > .fmt-tier-tail');
          if (stable && tail) {
            const chunks = stable.children.length;
            if (saw === null || chunks > saw) saw = chunks;
          }
        }
        const streaming = !!(document.querySelector('#chat-messages .chat-working') ||
                             document.querySelector('.msg-assistant .fmt-cursor'));
        if (!streaming && saw !== null) break;
        await sleep(700);
      }
      const rows = document.querySelectorAll('#chat-messages .msg-bubble.msg-assistant');
      const last = rows[rows.length - 1];
      return {
        sawChunks: saw,
        tier: !!(last && last.querySelector(':scope > .fmt-tier-stable')),
        content: last ? (last.innerText || '').length : 0
      };
    }""")
    ok(tier_info["sawChunks"] is not None and tier_info["sawChunks"] >= 1,
       f"the streaming bubble used the two-tier render (stable chunks seen: {tier_info['sawChunks']})")
    ok(tier_info["content"] > 800,
       f"the final full render completed ({tier_info['content']} chars)")
    ok(not tier_info["tier"], "the tier was reset on completion (the final full render)")

    # ── 5. virtualization present ────────────────────────────────────
    cv = pg.evaluate("""() => {
      const row = document.querySelector('#chat-messages .msg-row');
      return row ? getComputedStyle(row).contentVisibility : 'missing';
    }""")
    ok(cv == "auto", f"transcript rows are content-visibility: auto (got {cv})")

    pg.screenshot(path="/tmp/rig78/v0783-after.png")
    ok(not errors, f"zero page errors ({errors[:2]})")
    br.close()
    print(f"\n{PASS} passed, {FAIL} failed — rows in transcript: {rows}")
    sys.exit(1 if FAIL else 0)
