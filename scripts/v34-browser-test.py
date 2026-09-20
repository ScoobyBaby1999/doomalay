#!/usr/bin/env python3
# v34-browser-test.py — the v0.34 batch verification.
#
# Boots a fresh engine + drives the real PWA. Covers:
#
#   0. the chat-header ★ quick-switch is GONE (favorites moved to the
#      model browser's own ★ tab).
#   1. PER-CHAT SCROLL MEMORY — #chat-scroll restores where the user was
#      after close/reopen AND after a stacked view pops (stash round-trip);
#      persisted in localStorage.
#   2. TWEAKS LIVE UPDATE — "inherit the global sizes again" snaps the
#      sliders + inline vars in place (no close/reopen); a scheme preset
#      repaints the fmt color rows live.
#   3. USAGE LIVE NUMBERS — the usage view polls while open (request
#      count grows) + the live footer text.
#   4. TEXT-SIZE SCALING — chat text 100 scales bubbles' padding, code
#      text, thinking chrome and the input TOGETHER (--chat-scale);
#      inherit restores the defaults.
#   5. THE MODEL BROWSER — three tabs (★/Providers/Models), tab memory,
#      the 6-column rows (name|★|ℹ|⚖|ctx|price), the subtext line with
#      provider dots + ➜, the 🔑-icon priority drop-down (no ⠿ grip, no
#      key pill), ▲ reorder + persistence.
#   6. PERFORMANCE — the list renders capped (≤100 rows + "show more"),
#      ℹ drawer + tab switches respond fast.
#   7. AVAILABLE / ALL — the exclusive pair (no keys → empty; a key
#      posted via the API → nvidia turns ready + counts).
#   8. THE CROP PICKER — the slider is touch-draggable again (no
#      touch-action:none), touches on the overlay DON'T pan the canvas
#      behind it, and a touchscreen tap on apply commits the crop.
#   9. zero page errors.
#
# Run: python3 scripts/v34-browser-test.py   (engine must NOT already run)

import base64, json, os, shutil, struct, subprocess, sys, time
import urllib.request, urllib.error, zlib

BASE = "http://127.0.0.1:8134"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v34test"
PORT = 8134

def make_png(rgb=(30, 60, 220)):
    w = h = 24
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b""))

if os.path.exists(DATA): shutil.rmtree(DATA)
os.makedirs(DATA)
_englog = open("/tmp/doomalay-v34-eng.log", "w")
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=_englog, stderr=_englog)
for _ in range(40):
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
else:
    print("FATAL: engine did not start"); proc.kill(); sys.exit(1)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def japi(method, path, body=None):
    st, bodyb = api(method, path, body)
    try: return st, json.loads(bodyb.decode() or "{}")
    except Exception: return st, {}

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

# ── seed: a long conversation (tall scroll), a code block, usage ────
st, sess = api("POST", "/api/sessions", {
    "title": "V34 Bot", "sandbox": "quick",
    "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
SID = json.loads(sess)["ID"]

api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": "hello"})
api("POST", f"/api/sessions/{SID}/events", {"type": "assistant",
    "text": "Hi! Ask me anything — here is a code sample:\n\n```python\n"
            "def greet(name):\n    return f'hello {name}'\n\n"
            "for i in range(10):\n    print(greet(i))\n```\n\n"
            "And some **markdown** with a [link](https://example.com)."})
for i in range(6):
    api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": f"question number {i} " + "x" * 40})
    api("POST", f"/api/sessions/{SID}/events", {"type": "assistant",
        "text": f"answer number {i}: " + ("lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 6)})
api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": "one last thing"})
api("POST", f"/api/sessions/{SID}/events", {"type": "assistant", "text": "done — this is the very last line of the conversation."})
api("POST", f"/api/sessions/{SID}/events", {"type": "status",
    "text": json.dumps({"state": "idle", "usage": {"input_tokens": 51000, "output_tokens": 2100}})})

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 400, "height": 760}, has_touch=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "c34", "type": "chat", "name": "V34 Bot", "family": "nvidia",
                        "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": "nvidia/nvidia/nemotron-3-super",
                        "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(700)

    def open_chat():
        if not pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"):
            pg.mouse.click(120, 200)
            pg.wait_for_timeout(1400)

    def close_chat():
        if pg.evaluate("() => document.getElementById('chat-panel').classList.contains('open')"):
            pg.evaluate("() => document.getElementById('chat-scrim').click()")
            pg.wait_for_timeout(700)

    def root_inline(prop):
        return pg.evaluate(f"""() => {{
          const st = window.ChatPanel.getState('c34');
          const r = st && st._chatRootEl;
          return r ? r.style.getPropertyValue('{prop}') : null;
        }}""")

    def computed(sel, prop):
        return pg.evaluate(f"""() => {{
          const el = document.querySelector('{sel}');
          return el ? getComputedStyle(el)['{prop}'] : null;
        }}""")

    # ══ 0. the ★ quick-switch is gone from the chat header ══════════
    print("star button removal")
    open_chat()
    ok(pg.evaluate("() => document.getElementById('panel-star-btn')") is None,
       "#panel-star-btn is GONE from the DOM")
    ok(pg.evaluate("() => !!document.getElementById('panel-model-btn')",
       ) if False else pg.evaluate("() => document.getElementById('panel-model-btn') !== null"),
       "the model button remains (the browser's entry point)")

    # ══ 1. PER-CHAT SCROLL MEMORY ════════════════════════════════════
    print("per-chat scroll memory")
    sc = pg.locator("#chat-scroll")
    pg.wait_for_timeout(600)
    h = pg.evaluate("() => document.getElementById('chat-scroll').scrollHeight")
    ok(h > 900, f"the seeded conversation is tall (scrollHeight {h})")
    bottom = pg.evaluate("() => document.getElementById('chat-scroll').scrollTop")
    ok(bottom > 300, f"first open lands at the bottom ({bottom}px)")
    # park mid-history
    pg.evaluate("() => { const s = document.getElementById('chat-scroll'); s.scrollTop = 300; }")
    pg.wait_for_timeout(900)  # the debounced localStorage write
    m = pg.evaluate("() => JSON.parse(localStorage.getItem('doomalay.chatscroll.v1') || '{}')")
    ok(isinstance(m.get("c34"), (int, float)) and abs(m.get("c34", 0) - 300) <= 6,
       f"the scroll position persisted to localStorage ({m.get('c34')})")
    # close + reopen → same spot
    close_chat(); open_chat()
    got = pg.evaluate("() => document.getElementById('chat-scroll').scrollTop")
    ok(abs(got - 300) <= 40, f"close/reopen restores the reading spot ({got}px ≈ 300)")
    # a stacked view push/pop keeps it too (the stash round-trip)
    pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)
    pg.get_by_text("usage").click(); pg.wait_for_timeout(900)
    ok(pg.locator("#us-in").count() == 1, "the usage view opened over the chat")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(700)
    got2 = pg.evaluate("() => document.getElementById('chat-scroll').scrollTop")
    ok(abs(got2 - 300) <= 40, f"view pop keeps the reading spot ({got2}px ≈ 300)")

    # ══ 2. TWEAKS LIVE UPDATE ═══════════════════════════════════════
    print("tweaks live update")
    pg.get_by_text("tweaks").click(); pg.wait_for_timeout(800)
    for title in ["Text Size"]:
        pg.locator(".settings-section h3", has_text=title).first.click(); pg.wait_for_timeout(250)
    slider = pg.locator('input.app-range[data-scope="chat"]').first
    slider.evaluate("el => { el.value = 80; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(800)
    ok(root_inline("--chat-fs") == "21.6px", "slider 80 → --chat-fs 21.6px")
    ok(root_inline("--chat-scale") == "1.350", "…and --chat-scale 1.350 (21.6 ÷ 16 — the message scope follows)")
    # the LIVE reset — the sliders must snap back WITHOUT close/reopen
    pg.get_by_text("inherit the global sizes again").click()
    pg.wait_for_timeout(700)
    ok(slider.input_value() == "50", "'inherit the global sizes again' snaps the slider back to 50 in place")
    ok(root_inline("--chat-fs") == "", "…and the inline --chat-fs is cleared live")
    ok(root_inline("--chat-scale") == "", "…and the inline --chat-scale is cleared live")
    # a scheme preset repaints the fmt rows live
    pg.locator(".settings-section h3", has_text="Chat Colors").first.click(); pg.wait_for_timeout(250)
    pg.locator('[data-action="chat-scheme"][data-scope="chat"][data-scheme="rose"]').click()
    pg.wait_for_timeout(700)
    v = pg.evaluate("""() => {
      const inp = document.querySelector('input[data-custom="fmt"][data-scope="chat"]');
      return inp ? inp.value : null;
    }""")
    ok(v == "#f472b6", f"the rose preset repaints the fmt color row live ({v})")
    pg.get_by_text("inherit the global colors again").click(); pg.wait_for_timeout(500)
    ok(root_inline("--fmt-a1") == "", "inherit colors clears the inline slots live")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)

    # ══ 3. USAGE LIVE NUMBERS ════════════════════════════════════════
    print("usage live numbers")
    usage_hits = []
    pg.on("request", lambda r: usage_hits.append(r.url) if "/usage" in r.url else None)
    pg.get_by_text("usage").click(); pg.wait_for_timeout(600)
    ok(pg.locator("#us-ctx-fill").count() == 1, "the usage view renders (context bar present)")
    live_txt = pg.evaluate("() => document.body.innerText.includes('refreshes every few seconds')")
    ok(live_txt, "the view announces its live refresh")
    pg.wait_for_timeout(5500)
    ok(len(usage_hits) >= 2, f"the usage poll fired while viewing ({len(usage_hits)} fetches)")
    ok(pg.evaluate("() => window.ChatPanel.getState('c34')._usage !== undefined"),
       "the poll also refreshed state._usage (the header meters stay in sync)")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)

    # ══ 4. TEXT-SIZE SCALING ═══════════════════════════════════════
    print("text-size scaling (one look, one lever)")
    # NOTE: the chat root is STASHED (detached) while the tweaks view is
    # open — getComputedStyle on a detached tree lies, so every assertion
    # runs after the view pops and the live chat re-attaches.
    def set_chat_size(v):
        pg.get_by_text("tweaks").click(); pg.wait_for_timeout(700)
        pg.locator(".settings-section h3", has_text="Text Size").first.click(); pg.wait_for_timeout(250)
        pg.locator('input.app-range[data-scope="chat"]').first.evaluate(
            "el => { el.value = %d; el.dispatchEvent(new Event('input')) }" % v)
        pg.wait_for_timeout(600)
        pg.locator("#panel-view-back").click(); pg.wait_for_timeout(500)

    def inherit_sizes():
        pg.get_by_text("tweaks").click(); pg.wait_for_timeout(700)
        pg.locator(".settings-section h3", has_text="Text Size").first.click(); pg.wait_for_timeout(250)
        pg.get_by_text("inherit the global sizes again").click(); pg.wait_for_timeout(600)
        pg.locator("#panel-view-back").click(); pg.wait_for_timeout(500)

    set_chat_size(100)
    ok(computed(".msg-bubble", "fontSize") == "24px", "bubble text 24px at chat=100")
    ok(computed(".msg-user", "paddingTop") == "15px", "bubble padding scales (10px × 1.5 = 15px)")
    ok(computed(".msg-user", "paddingLeft") == "21px", "…and horizontal padding (14px × 1.5 = 21px)")
    ok(computed(".fmt-codetext", "fontSize") == "19.2px",
       f"code text scales (24 × 0.8 = 19.2px, got {computed('.fmt-codetext', 'fontSize')})")
    ok(computed("#chat-input", "fontSize") == "23px", "the input rides the chat size (24 − 1)")
    ok(root_inline("--chat-scale") == "1.500", "the chat root carries --chat-scale 1.5")
    set_chat_size(0)
    ok(computed(".msg-bubble", "fontSize") == "12px", "bubble text 12px at chat=0")
    ok(computed(".msg-user", "paddingTop") == "7.5px", "padding 7.5px at the minimum (10 × 0.75)")
    ok(computed(".fmt-codetext", "fontSize") == "9.6px",
       f"code text 9.6px (12 × 0.8, got {computed('.fmt-codetext', 'fontSize')})")
    inherit_sizes()
    ok(computed(".msg-bubble", "fontSize") == "18px",
       f"inherit restores the global default 18px (slider 50, got {computed('.msg-bubble', 'fontSize')})")
    ok(computed(".msg-user", "paddingTop") == "11.25px",
       f"…and the default padding (10 × 18/16, got {computed('.msg-user', 'paddingTop')})")
    close_chat()

    # ══ 5. THE MODEL BROWSER ═════════════════════════════════════════
    print("model browser — tabs, rows, drop-down")
    open_chat()
    pg.locator("#panel-model-btn").click(); pg.wait_for_timeout(1800)
    tabs = pg.evaluate("""() => Array.from(document.querySelectorAll('[data-viewtab]')).map(b => b.dataset.viewtab)""")
    ok(tabs == ["favorites", "providers", "models"], f"three tabs: ★/Providers/Models ({tabs})")

    # ── models tab: structure + perf cap ──
    t0 = time.time()
    pg.locator('[data-viewtab="models"]').click()
    pg.wait_for_selector(".mb-logrow", timeout=8000)
    dt = time.time() - t0
    ok(dt < 2.0, f"the models tab paints fast ({dt:.2f}s)")
    nrows = pg.locator(".mb-logrow").count()
    ok(0 < nrows <= 100, f"the list is page-capped ({nrows} rows ≤ 100)")
    ok(pg.locator("#mb-more").count() == 1, "the 'show more' pagination row present")
    ok(pg.locator("#mb-more").inner_text().startswith("show"), "its label reads 'show N more'")

    row = pg.locator(".mb-logrow").first
    ok(pg.locator(".mb-logrow .mb-r6").count() == nrows, "every row carries the 6-column grid")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-name").count() == nrows, "…the NAME column (biggest)")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-starbtn").count() == nrows, "…the ★ column")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-ic").count() == 2 * nrows, "…the ℹ + ⚖ columns")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-ctx").count() == nrows, "…the context column")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-price").count() == nrows, "…the pricing column")
    ok(pg.locator(".mb-logrow .mb-sub").count() == nrows, "the subtext line under every model row")
    ok(pg.locator(".mb-logrow .mb-sub .mb-dots").count() == nrows, "the provider dots moved to the subtext")
    ok(pg.locator(".mb-logrow .mb-r6 .mb-dots").count() == 0, "…OFF the top formatted row")
    ok(pg.locator(".mb-logrow .mb-sub .mb-arrowbtn").count() == nrows, "the ➜ arrow right-aligned in the subtext")
    name_wraps = pg.evaluate("""() => {
      const n = document.querySelector('.mb-logrow .mb-name');
      return n ? getComputedStyle(n).overflowWrap === 'anywhere' || getComputedStyle(n).wordBreak === 'break-word' : false;
    }""")
    ok(name_wraps, "the name wraps (full model names are never cut off)")

    # ── the ℹ drawer (row-level, fast) ──
    t0 = time.time()
    pg.locator(".mb-logrow [data-info]").first.click()
    pg.wait_for_selector(".mb-detail", timeout=5000)
    dt = time.time() - t0
    ok(dt < 1.5, f"the ℹ drawer opens fast ({dt:.2f}s)")
    ok(pg.evaluate("() => document.querySelector('.mb-detail').innerText.includes('Benchmarks')") or
       pg.evaluate("() => document.querySelector('.mb-detail').innerText.length > 40"),
       "the drawer shows the model's benchmarks/details")
    pg.locator(".mb-logrow [data-info]").first.click(); pg.wait_for_timeout(400)
    ok(pg.locator(".mb-detail").count() == 0, "toggling ℹ again closes the drawer")

    # ── the ➜ drop-down: 🔑 icon columns, no grip, no key pill ──
    # walk down the rows until one has ≥2 provider routes (the first rows
    # in 'best' order can be single-provider)
    drop_row = None
    for i in range(min(8, nrows)):
        pg.locator(".mb-logrow .mb-arrowbtn").nth(i).click()
        pg.wait_for_timeout(500)
        if pg.locator("[data-hostslot]").count() >= 2:
            drop_row = i
            break
        pg.locator(".mb-logrow .mb-arrowbtn").nth(i).click()  # close it again
        pg.wait_for_timeout(300)
    ok(drop_row is not None, f"a multi-provider row found for the drop-down (row {drop_row})")
    hrows = pg.locator("[data-hostslot]")
    ok(hrows.count() >= 2, f"the provider-priority drop-down lists routes ({hrows.count()})")
    ok(pg.locator("[data-hostslot] .mb-keyic").count() == hrows.count(),
       "every route row carries the 🔑 key/no-key icon")
    ok(pg.locator("[data-hostgrip]").count() == 0, "the ⠿ grip dots are GONE")
    body_txt = pg.evaluate("() => document.querySelector('#mb-list').innerText")
    ok("key ✓" not in body_txt and "no key" not in body_txt, "the key ✓ / no-key PILL is gone (the icon carries it)")
    ok(pg.locator("[data-hostup]").count() == hrows.count(), "▲ arrows on every row")
    ok(pg.locator("[data-hostdown]").count() == hrows.count(), "▼ arrows on every row")
    # ▲ tap = move: the first two rows swap
    first_two = pg.evaluate("""() => Array.from(document.querySelectorAll('[data-hostslot]'))
        .slice(0, 2).map(e => e.dataset.hostslot)""")
    pg.locator("[data-hostup]").nth(1).click(); pg.wait_for_timeout(700)
    after_two = pg.evaluate("""() => Array.from(document.querySelectorAll('[data-hostslot]'))
        .slice(0, 2).map(e => e.dataset.hostslot)""")
    ok(after_two == [first_two[1], first_two[0]], "tapping ▲ on the 2nd row swaps it up")
    ho = pg.evaluate("() => JSON.parse(localStorage.getItem('doomalay.model-select.hostOrder') || '{}')")
    lid = pg.evaluate("""() => {
      const open = document.querySelector('[data-hostlist]');
      return open ? open.dataset.hostlist : null;
    }""")
    ok(lid and isinstance(ho.get(lid), list) and ho[lid][0] == first_two[1].split("|")[0],
       "the new provider order persisted (localStorage hostOrder)")
    pg.locator(".mb-logrow .mb-arrowbtn").nth(drop_row).click(); pg.wait_for_timeout(400)

    # ── ★ star → gold, favorites tab ──
    first_name = pg.locator(".mb-logrow .mb-name").first.inner_text().strip()
    star = pg.locator(".mb-logrow [data-star]").first
    star.click(); pg.wait_for_timeout(400)
    ok(star.get_attribute("data-on") == "1", "tapping ★ turns it on in place (no re-render)")
    gold = pg.evaluate("() => getComputedStyle(document.querySelector('.mb-logrow [data-star]')).color")
    ok(gold == "rgb(234, 179, 8)", f"the star is bare GOLD, no chip ({gold})")
    pg.locator('[data-viewtab="favorites"]').click(); pg.wait_for_timeout(600)
    fav_rows = pg.locator(".mb-logrow").count()
    ok(fav_rows == 1, f"the ★ tab lists exactly the starred model ({fav_rows} row)")
    ok(first_name in pg.locator("#mb-list").inner_text(), f"…and it is {first_name}")
    ok("1 favorite" in pg.locator("#mb-list").inner_text(), "the favorites count line reads '1 favorite'")

    # ── providers tab: 6-column rows + the ℹ drawer beneath ──
    pg.locator('[data-viewtab="providers"]').click(); pg.wait_for_timeout(1000)
    ok(pg.locator("#mb-provlist .mb-provbox").count() >= 2, "the provider boxes render")
    pg.locator('[data-provhead]').first.click(); pg.wait_for_timeout(900)
    prows = pg.locator(".mb-prow")
    ok(prows.count() >= 2, f"the expanded box lists its models as rows ({prows.count()})")
    ok(pg.locator(".mb-prow .mb-r6").count() == prows.count(), "provider rows use the same 6-column grid")
    ok(pg.locator(".mb-prow [data-star]").count() == prows.count(), "…with the ★ column")
    ok(pg.locator(".mb-prow [data-info]").count() == prows.count(), "…the ℹ column (same method as the models tab)")
    ok(pg.locator(".mb-prow [data-compare]").count() == prows.count(), "…the ⚖ compare column")
    # pick a row that maps to a logical model (data-logical-id non-empty)
    # — the ℹ drawer rides the logical's attributes
    prow = pg.locator('.mb-prow[data-logical-id]:not([data-logical-id=""])').first
    ok(prow.count() == 1, "a provider row maps to the logical catalogue")
    prow.locator("[data-info]").click(); pg.wait_for_timeout(600)
    ok(pg.locator(".mb-prow .mb-detail").count() == 1,
       "ℹ on a provider row uncollapses the model info + benchmarks BENEATH its row")

    # ── Available / All (no keys yet → empty; key posted → ready) ──
    pg.locator("#mb-filters-toggle").click(); pg.wait_for_timeout(500)
    ok(pg.locator('[data-avail="available"]').count() == 1, "the 'Available' pill exists in the filter box")
    ok(pg.locator('[data-avail="all"]').count() == 1, "the 'All' pill exists beside it")
    pg.locator('[data-avail="available"]').click(); pg.wait_for_timeout(800)
    ok(pg.locator('[data-avail="available"]').get_attribute("aria-pressed") == "true", "Available selects")
    empty_txt = pg.evaluate("() => document.querySelector('#mb-list').innerText")
    ok("No providers with API keys yet" in empty_txt, "no keys → the providers tab explains (empty, not broken)")
    pg.locator('[data-viewtab="models"]').click(); pg.wait_for_timeout(700)
    ok("No models match" in pg.evaluate("() => document.querySelector('#mb-list').innerText"),
       "no keys → the models tab under Available is empty (honest)")
    pg.locator('[data-avail="all"]').click(); pg.wait_for_timeout(700)
    ok(pg.locator(".mb-logrow").count() > 10, "'All' restores the default catalogue")

    # post a real key through the API, refresh the catalogue in-app
    st, models = japi("GET", "/api/models")
    nv_env = None
    for g in (models or {}).get("groups", []):
        if g.get("name") == "nvidia": nv_env = g.get("envVar")
    ok(bool(nv_env), f"the catalogue names nvidia's key env ({nv_env})")
    if nv_env:
        st, _ = api("POST", "/api/keys", {"provider": "nvidia", "env_var": nv_env, "key": "nvtest-key-123"})
        ok(st == 200, "a key was posted through the API")
        pg.locator('[data-viewtab="providers"]').click(); pg.wait_for_timeout(400)
        pg.locator("#mb-refresh").click(); pg.wait_for_timeout(2200)
        ready = pg.evaluate("""() => Array.from(document.querySelectorAll('.mb-provbox'))
            .some(b => b.innerText.toLowerCase().includes('nvidia') && b.innerText.includes('ready'))""")
        ok(ready, "after the refresh, nvidia's box wears the 'ready' badge")
        pg.locator('[data-viewtab="models"]').click(); pg.wait_for_timeout(800)
        counts = pg.evaluate("() => document.querySelector('#mb-list').innerText")
        ok("with your keys" in counts and "0 with your keys" not in counts,
           "the models count line shows keyed models")
        pg.locator('[data-avail="available"]').click(); pg.wait_for_timeout(800)
        ok(pg.locator(".mb-logrow").count() >= 1, "Available now shows the key-backed models")

    # ── tab memory + close ──
    pg.locator('[data-viewtab="favorites"]').click(); pg.wait_for_timeout(500)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(600)  # Esc closes the overlay
    ok(not pg.evaluate("() => window.ConnectOverlay.isOpen()"), "Esc closes the browser")
    close_chat(); open_chat()
    pg.locator("#panel-model-btn").click(); pg.wait_for_timeout(1800)
    active = pg.evaluate("""() => {
      const b = document.querySelector('[data-viewtab="favorites"]');
      return b ? b.classList.contains('dd-active-tab') : false;
    }""")
    ok(active, "the panel re-opens on the ★ favorites tab (the tab it was closed on)")
    ok(pg.locator(".mb-logrow").count() == 1, "…and the favorite is still listed")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    close_chat()

    # ══ 8. THE CROP PICKER ═══════════════════════════════════════════
    print("crop picker — touch fixes")
    png64 = base64.b64encode(make_png()).decode()
    pg.evaluate(f"""() => {{
      window.__cropDone = null;
      window.CropUI.open({{
        src: 'data:image/png;base64,{png64}',
        aspect: 1.5,
        onDone: (b64, meta) => {{ window.__cropDone = {{ len: (b64||'').length, w: meta && meta.width, h: meta && meta.height }}; }}
      }});
    }}""")
    pg.wait_for_selector(".crop-ui", timeout=5000)
    pg.wait_for_timeout(500)
    ta = pg.evaluate("() => getComputedStyle(document.querySelector('.crop-zoom')).touchAction")
    ok(ta != "none", f"the zoom slider is touch-draggable again (touch-action: {ta})")

    # touches on the overlay must NOT pan the canvas behind it
    before = pg.evaluate("() => document.querySelector('.icon').parentElement.style.transform")
    panned = pg.evaluate("""() => {
      const el = document.elementFromPoint(200, 380);
      const mk = (type, x, y) => {
        const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
        return new TouchEvent(type, { cancelable: true, bubbles: true,
          touches: type === 'touchend' ? [] : [t], targetTouches: [t], changedTouches: [t] });
      };
      el.dispatchEvent(mk('touchstart', 200, 380));
      el.dispatchEvent(mk('touchmove', 250, 430));
      el.dispatchEvent(mk('touchend', 250, 430));
      return true;
    }""")
    pg.wait_for_timeout(400)
    after = pg.evaluate("() => document.querySelector('.icon').parentElement.style.transform")
    ok(before == after, f"a touch-drag on the crop overlay does NOT pan the canvas ({panned})")

    # the zoom slider still zooms (input event → image grows)
    w0 = pg.evaluate("() => document.querySelector('.crop-img').getBoundingClientRect().width")
    pg.locator(".crop-zoom").evaluate("el => { el.value = 2.5; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(300)
    w1 = pg.evaluate("() => document.querySelector('.crop-img').getBoundingClientRect().width")
    ok(w1 > w0 * 1.2, f"the slider zooms the image ({w0:.0f} → {w1:.0f}px)")

    # a REAL touchscreen tap on apply commits the crop (isInsideUI lets it through)
    box = pg.locator(".crop-ok").bounding_box()
    pg.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.wait_for_timeout(800)
    ok(pg.evaluate("() => window.__cropDone !== null"),
       "a touchscreen tap on 'apply' commits the crop (no dead buttons)")
    ok(not pg.evaluate("() => !!document.querySelector('.crop-ui')"), "the crop overlay closed")

    # ══ 9. zero page errors ══════════════════════════════════════════
    ok(len(errors) == 0, f"no page errors across the whole suite ({len(errors)})")
    if errors: print("   errors:", errors[:6])

    br.close()

proc.kill()
print()
print("=" * 50)
print(f"TOTAL: {PASS} pass, {FAIL} fail")
sys.exit(1 if FAIL else 0)
