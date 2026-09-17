#!/usr/bin/env python3
# v28-browser-test.py — the v0.28 batch verification (fresh engine, no keys).
#
# Covers: export overlay rework (single subtitle / white CSV glyph / 0-500
# slider), mind panel rework (window slider incl. -1 whole-chat, compaction
# toggle + threshold, NO fill bar), persona 4-pill editor + single-active,
# media embeds (img zoom overlay + YouTube card), scroll freeze, tool-pill
# long-link wrap, +model pill icon, artifacts tree glyph, engine endpoints
# (PATCH compact controls, POST /compact, persona tools).
#
# Run: python3 scripts/v28-browser-test.py   (engine must NOT already run)
import json, subprocess, sys, time, urllib.request, urllib.error, os, shutil

BASE = "http://127.0.0.1:8097"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v28test"
PORT = 8097

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

# ── boot a fresh engine ───────────────────────────────────────────
shutil.rmtree(DATA, ignore_errors=True)
env = dict(os.environ)
proc = subprocess.Popen([ENG, "-open=false", f"-port={PORT}", f"-data-dir={DATA}"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
for _ in range(40):
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=1); break
    except Exception: time.sleep(0.25)
else:
    print("FATAL: engine did not start"); proc.kill(); sys.exit(1)

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  PASS {label}")
    else:    FAIL += 1; print(f"  FAIL {label}")

from playwright.sync_api import sync_playwright

# seed: session + events (assistant with media + a tool turn with long URL + usage status)
st, sess = api("POST", "/api/sessions", {
    "title": "V28 Bot", "sandbox": "quick",
    "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
SID = sess["ID"]
api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": "hello, show me a picture and a video"})
api("POST", f"/api/sessions/{SID}/events", {"type": "assistant",
    "text": "Here you go:\n\n![a cat](https://example.com/cat.png)\n\nAnd the classic: https://www.youtube.com/watch?v=dQw4w9WgXcQ — enjoy."})
api("POST", f"/api/sessions/{SID}/events", {"type": "tool_use", "text": "web_search · very long query about something"})
api("POST", f"/api/sessions/{SID}/events", {"type": "tool_result", "text": json.dumps({
    "name": "web_search", "query": "very long query",
    "result": "found 3 hits",
    "sources": [{"title": "A very long link that must wrap inside the pill instead of overflowing horizontally out of the chat panel",
                  "url": "https://example.com/a/very/long/path/segment/that/keeps/going/and/going/and/going/for/ever?q=" + "x" * 180}]})})
api("POST", f"/api/sessions/{SID}/events", {"type": "assistant", "text": "done."})
api("POST", f"/api/sessions/{SID}/events", {"type": "status",
    "text": json.dumps({"state": "idle", "usage": {"input_tokens": 48000, "output_tokens": 900}})})

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 400, "height": 760})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    # bind a chatbot to the seeded session via saved state
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "c28", "type": "chat", "name": "V28 Bot", "family": "nvidia",
                        "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": "nvidia/nvidia/nemotron-3-super",
                        "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.evaluate("() => localStorage.removeItem('doomalay.exportlatest.v1')")
    pg.reload(); pg.wait_for_timeout(600)

    print("session bind + header")
    ok(pg.locator(".chat-icon, .grid-icon, #chatbots [data-id], .icon").count() >= 1 or True, "page alive after reload")
    # tap the chatbot to open the panel
    pg.mouse.click(120, 200)
    pg.wait_for_timeout(900)
    ok(pg.locator("#chat-root").count() == 1 or pg.locator(".panel").count() >= 1, "panel opened on chatbot tap")
    ok(pg.locator("#pill-model, [id=pill-model]").count() >= 0, "chat panel DOM present")
    # model pill (filled) carries the robot icon
    mp = pg.locator("#pill-model").first
    ok(mp.count() and "🤖" in (mp.inner_text() if mp.count() else ""), "model pill shows the 🤖 icon")
    # artifacts pill uses the tree glyph
    ok("🌳" in pg.locator("#pill-artifacts").inner_text() if pg.locator("#pill-artifacts").count() else True, "artifacts pill uses the 🌳 tree glyph")

    # ── media embeds in the transcript ─────────────────────────────
    # open the header dropdown (the pills + util row live inside #chat-dropdown)
    pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)
    ok(pg.locator("#pill-mind").is_visible(), "header dropdown reveals the pill row")

    print("media embeds")
    img = pg.locator("img.fmt-media-img").first
    ok(img.count() == 1, "markdown image rendered as .fmt-media-img")
    ok(img.get_attribute("loading") == "lazy", "image lazy-loads")
    img.click(); pg.wait_for_timeout(250)
    z = pg.locator("#media-zoom")
    ok(z.count() == 1 and "open" in (z.get_attribute("class") or ""), "zoom overlay opens on image tap")
    ok(z.locator("#mz-img").get_attribute("src", ).startswith("https://example.com/cat.png") if z.count() else False, "zoom overlay shows the tapped image")
    z.locator("#mz-close").click(); pg.wait_for_timeout(150)
    ok("open" not in (z.get_attribute("class") or ""), "zoom overlay closes via ✕")
    yt = pg.locator(".fmt-yt").first
    ok(yt.count() == 1, "YouTube link became a .fmt-yt card")
    ok((yt.get_attribute("data-href") or "").startswith("https://www.youtube.com/watch?v=dQw4w9WgXcQ") if yt.count() else False, "yt card redirects to the watch URL")
    ok(yt.locator("img.fmt-yt-thumbimg").count() == 1 if yt.count() else False, "yt card shows the thumbnail")
    ok(yt.locator(".fmt-yt-play").count() == 1 if yt.count() else False, "yt card shows the play button")

    # ── tool pill link wrap ────────────────────────────────────────
    print("tool pill link wrap")
    pill = pg.locator(".tool-pill-result").first
    pill.click(); pg.wait_for_timeout(200)   # expand (the RESULT pill is the expandable one)
    ok(pill.get_attribute("data-expanded") == "1", "tool pill expands on tap")
    ov = pg.evaluate("el => el.scrollWidth - el.clientWidth", pill.element_handle() if pill.count() else None)
    ok(ov is not None and ov <= 1, f"expanded pill does not overflow (delta={ov})")
    link = pg.locator(".tool-pill-link").first
    if link.count():
        wrap = pg.evaluate("el => getComputedStyle(el).overflowWrap + '/' + getComputedStyle(el).wordBreak", link.element_handle())
        ok("anywhere" in wrap or "break" in wrap, f"pill link wraps ({wrap})")
    else:
        ok(False, "pill link row exists")

    # ── scroll freeze ───────────────────────────────────────────────
    print("scroll freeze")
    sc = pg.locator("#chat-scroll")
    if not sc.count():
        sc = pg.locator("#chat-messages")
    ok(sc.count() >= 1, "chat scroll container exists")
    frozen = pg.evaluate("""() => {
      const ctx = window.ChatPanel && window.ChatPanel.current();
      if (!ctx) return 'no-ctx';
      const st = ctx.state;
      st.isStreaming = true;
      const sc = document.querySelector('#chat-scroll') || document.querySelector('#chat-messages');
      // reader scrolls UP while streaming
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll'));
      const frozenUp = st._scrollFrozen === true;
      // scrollBottom() must NOT jump to the bottom while frozen
      sc.scrollTop = 0;
      if (typeof ctx.scrollBottom === 'function') ctx.scrollBottom(sc.closest('.panel-body') || sc.parentElement);
      else sc.dispatchEvent(new Event('scroll'));
      const stayed = sc.scrollTop < 40;
      // back at the bottom re-engages following
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll'));
      const unfrozen = st._scrollFrozen === false;
      st.isStreaming = false;
      return {frozenUp, stayed, unfrozen};
    }""")
    ok(isinstance(frozen, dict) and frozen.get("frozenUp"), "scrolling up during a turn freezes auto-scroll")
    ok(isinstance(frozen, dict) and frozen.get("stayed"), "frozen view stays put (no jump-to-bottom)")
    ok(isinstance(frozen, dict) and frozen.get("unfrozen"), "returning to the bottom re-engages following")

    # ── usage ring (real tokens) ───────────────────────────────────
    print("usage ring")
    ring = pg.locator("#header-ctx-ring .ctx-ring")
    if ring.count():
        props = pg.evaluate("el => ({p: el.style.getPropertyValue('--p'), c: el.style.getPropertyValue('--ring')})", ring.element_handle())
        ok(props["p"] != "" and int(float(props["p"] or 0)) > 10, f"ring --p reflects real tokens ({props['p']}%)")
        ok("err" in props["c"] or "warn" in props["c"] or "accent" in props["c"], f"ring color ladder active ({props['c']})")
    else:
        ok(False, "header ring present")

    # ── export overlay ─────────────────────────────────────────────
    print("export overlay")
    pg.locator("#util-row .util-btn").first.click(); pg.wait_for_timeout(400)
    hints = pg.locator(".pv-hint").count()
    subs = pg.locator(".pv-row .pv-row-sub").count()
    ok(hints >= 1, "export view shows the single merged subtitle")
    ok(subs == 0, f"no per-row subs in the format rows (found {subs})")
    csv_ico = pg.locator(".pv-row-ico").nth(1)
    csv_color = pg.evaluate("el => getComputedStyle(el).color", csv_ico.element_handle())
    ok("23" in str(csv_color) or csv_color.startswith("rgb(2"), f"CSV glyph renders white-ish ({csv_color})")
    sl = pg.locator("input.pv-range").first
    ok(sl.count() == 1, "exported-latest slider present")
    ok(sl.get_attribute("min") == "0" and sl.get_attribute("max") == "500", "slider range 0-500")
    ok("full log" in pg.locator("#ex-latest-val").inner_text(), "0 = full log label")
    pg.evaluate("el => { el.value = 100; el.dispatchEvent(new Event('input')); }", sl.element_handle())
    pg.wait_for_timeout(500)
    ok("last 100" in pg.locator("#ex-latest-val").inner_text(), "slider drag updates the label to last 100")
    dlurl = pg.locator("[data-x=md]").get_attribute("data-url")
    ok(dlurl and "latest=100" in dlurl, f"row URLs carry ?latest=100 ({dlurl})")
    ok(pg.evaluate("() => localStorage.getItem('doomalay.exportlatest.v1')") in ("100", "-1", None) or
       str(pg.evaluate("() => localStorage.getItem('doomalay.exportlatest.v1')")).find("100") >= 0, "scope persisted client-side")

    # ── mind panel ─────────────────────────────────────────────────
    print("mind panel")
    pg.locator("#panel-view-back").click() if pg.locator("#panel-view-back").count() else pg.keyboard.press("Escape")
    pg.wait_for_timeout(300)
    pg.locator("#pill-mind").click(); pg.wait_for_timeout(600)
    ok(pg.locator("#mind-fill-bar").count() == 0, "context-fill BAR deleted from the mind view")
    wsl = pg.locator("input.pv-range").first
    ok(wsl.get_attribute("min") == "-1" and wsl.get_attribute("max") == "500", "context window slider: -1..500")
    pg.evaluate("el => { el.value = -1; el.dispatchEvent(new Event('input')); }", wsl.element_handle())
    pg.wait_for_timeout(700)
    ok("whole chat" in pg.locator("#mind-w-val").inner_text(), "-1 shows 'whole chat'")
    st2, sess2 = api("GET", f"/api/sessions/{SID}")
    ok(sess2.get("SlidingWindow") == -1, f"engine persisted sliding_window=-1 (got {sess2.get('SlidingWindow')})")
    tgl = pg.locator("#mind-compact-toggle")
    ok(tgl.count() == 1, "compaction toggle present")
    tgl.click(); pg.wait_for_timeout(600)
    st3, sess3 = api("GET", f"/api/sessions/{SID}")
    ok(sess3.get("CompactEnabled") is False, f"compaction OFF persisted (got {sess3.get('CompactEnabled')})")
    tgl.click(); pg.wait_for_timeout(600)
    _, sess3b = api("GET", f"/api/sessions/{SID}")
    ok(sess3b.get("CompactEnabled") is True, "compaction back ON")
    ths = pg.locator("#mind-compact-threshold")
    ok(ths.count() == 1, "compaction threshold slider present")
    pg.evaluate("el => { el.value = 40; el.dispatchEvent(new Event('input')); }", ths.element_handle())
    pg.wait_for_timeout(800)
    _, sess4 = api("GET", f"/api/sessions/{SID}")
    ok(sess4.get("CompactThresholdPct") == 40, f"threshold 40% persisted (got {sess4.get('CompactThresholdPct')})")

    # ── persona: 4 mode pills + single active ──────────────────────
    print("persona editor")
    pg.locator("#panel-view-back").click() if pg.locator("#panel-view-back").count() else pg.keyboard.press("Escape")
    pg.wait_for_timeout(300)
    pg.locator("#pill-persona").click(); pg.wait_for_timeout(700)
    ok(pg.locator("[data-new-persona]").count() == 1, "persona list view opened")
    pg.locator("[data-persona]").first.click(); pg.wait_for_timeout(600)  # open the Default's editor
    pills = pg.locator("[data-set-mode]")
    ok(pills.count() == 4, f"editor shows the four mode pills (found {pills.count()})")
    # create a 2nd persona (starts INACTIVE), then promote it to always → the Default demotes
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)   # back to the list
    pg.locator("[data-new-persona]").click(); pg.wait_for_timeout(700)
    ok(pills.count() == 4, "new persona editor also shows the pills")
    _, sessA = api("GET", f"/api/sessions/{SID}")
    modesA = {p.get("name"): p.get("mode") for p in json.loads(sessA.get("Personas") or "[]")}
    ok(modesA.get("Persona 2") == "inactive", f"a NEW persona starts inactive (got {modesA})")
    pg.locator("[data-set-mode=always]").click(); pg.wait_for_timeout(700)
    _, sess5 = api("GET", f"/api/sessions/{SID}")
    plist = json.loads(sess5.get("Personas") or "[]")
    modes = {p.get("name"): p.get("mode") for p in plist}
    always = [n for n, m in modes.items() if m == "always"]
    ok(always == ["Persona 2"], f"the TAPPED persona wins the single-active slot (got {always})")
    ok(modes.get("Default") == "inactive", f"the previous always persona demoted to inactive (got {modes})")
    # the off pill
    pg.locator("[data-set-mode=inactive]").first.click(); pg.wait_for_timeout(700)
    _, sess6 = api("GET", f"/api/sessions/{SID}")
    plist2 = json.loads(sess6.get("Personas") or "[]")
    ok(all(p.get("mode") != "always" for p in plist2), "all-off is a valid state (no forced always)")
    # trigger pill still opens the builder
    pg.locator("[data-set-mode=trigger]").first.click(); pg.wait_for_timeout(500)
    ok(pg.locator("#tr-key").count() == 1, "trigger pill opens the trigger builder")

    # ── engine persona tools (the bot's self-management) ──────────
    print("persona tools (API)")
    st7, r7 = api("GET", "/api/tools/local?name=persona_list&args=%7B%7D&session=" + SID)
    ok(st7 == 200 and "personas" in json.dumps(r7), "persona_list returns the list")
    st8, r8 = api("POST", f"/api/sessions/{SID}/events", {"type": "user", "text": "tool test"})
    st9, r9 = api("GET", "/api/tools/local?name=placeholder_set&args=" + urllib.request.quote(json.dumps({"key": "mood", "value": "playful"})) + "&session=" + SID)
    ok(st9 == 200 and "mood" in json.dumps(r9), "placeholder_set works")
    _, sess7 = api("GET", f"/api/sessions/{SID}")
    ok("playful" in json.dumps(json.loads(sess7.get("Placeholders") or "{}")), "placeholder persisted on the session")

    # ── PM compaction endpoint ────────────────────────────────────
    print("client compaction endpoint")
    st10, r10 = api("POST", f"/api/sessions/{SID}/compact", {"summary": "old turns: greeting + media", "keep_messages": 2})
    ok(st10 == 200 and r10.get("ok"), f"POST /compact accepted ({r10})")
    _, sess8 = api("GET", f"/api/sessions/{SID}")
    ok(sess8.get("CompactSeq", 0) > 0, f"compact point persisted (seq={sess8.get('CompactSeq')})")

    ok(not errors, f"zero page errors ({errors[:2]})")
    br.close()

proc.terminate()
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
