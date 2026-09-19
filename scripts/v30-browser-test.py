#!/usr/bin/env python3
# v30-browser-test.py — the v0.30 batch verification (fresh engine, no keys).
#
# Covers:
#   1. EXPORT LATEST defaults to -1 / "full log" (the slider's left edge IS
#      the default, mirroring the mind slider's "whole chat").
#   2. THE ONE COMPACTION LADDER: UsagePanel.ctxColor reads the chat's own
#      compactThreshold/compactEnabled — threshold at 80 shows in the usage
#      view, compaction-off swaps the top band from --err red to the
#      adjacent theme-owned --notice, and the header ring + every meter
#      refresh the moment the mind panel PATCHes (one method, all UIs).
#   3. THE +MODEL GATELOCK reads "tap to change" after a model is selected
#      (same as its sandbox sibling).
#   4. THE ✦ TWEAKS PILL + per-chat settings view: same UI builders as the
#      settings (scheme swatches, fmt color rows, size sliders — all
#      data-scope="chat"), per-chat overrides land as inline CSS vars on
#      #chat-root only, the engine-side blob round-trips (reload!), the
#      background image upload pipeline (pick → downscale → PUT → ?v=rev
#      URL), and the global settings stay untouched.
#
# Run: python3 scripts/v30-browser-test.py   (engine must NOT already run)
import json, struct, subprocess, sys, time, urllib.request, urllib.error, os, shutil, zlib

BASE = "http://127.0.0.1:8099"
ENG = os.path.join(os.path.dirname(__file__), "..", "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v30test"
PORT = 8099

def api(method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, method=method, data=data,
        headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def japi(method, path, body=None):
    st, bodyb = api(method, path, body)
    try: return st, json.loads(bodyb.decode() or "{}")
    except Exception: return st, {}

# ── boot a fresh engine ───────────────────────────────────────────
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine-test"], capture_output=True)
time.sleep(0.5)
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

# a real 8×8 PNG (red) for the background-upload pipeline
def make_png(path):
    w = h = 8
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b""))
    with open(path, "wb") as f: f.write(png)
    return path

from playwright.sync_api import sync_playwright

# seed: one session (model already selected → the gatelock renders filled)
st, sess = api("POST", "/api/sessions", {
    "title": "V30 Bot", "sandbox": "quick",
    "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
SID = json.loads(sess)["ID"]

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 400, "height": 760})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/")
    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "nvidia",
             "icons": [{"id": "c30", "type": "chat", "name": "V30 Bot", "family": "nvidia",
                        "iconIndex": 0, "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": "nvidia/nvidia/nemotron-3-super",
                        "provider": "nvidia", "sessionId": SID}], "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload(); pg.wait_for_timeout(700)
    pg.mouse.click(120, 200)          # tap the chatbot → panel opens
    pg.wait_for_timeout(1000)
    pg.locator("#chat-header-row").click(); pg.wait_for_timeout(300)   # reveal the pill row

    # helper — read a style off the (possibly stashed) chat root
    def root_style(prop):
        return pg.evaluate(f"""() => {{
          const st = window.ChatPanel.getState('c30');
          const r = st && st._chatRootEl;
          return r ? r.style.getPropertyValue('{prop}') : null;
        }}""")

    # ── 3. the +model gatelock sub reads "tap to change" ────────────
    print("+model gatelock sub")
    ok(pg.locator("#gate-box-model span").nth(2).text_content().strip() == "tap to change",
       "gatelock +model sub = 'tap to change' after a model is selected")
    ok(pg.locator("#gate-box-sandbox span").nth(2).text_content().strip() == "tap to change",
       "gatelock +sandbox sub still 'tap to change' (unchanged sibling)")

    # ── 1. export latest defaults to -1 / full log ──────────────────
    print("export latest default -1")
    pg.get_by_text("export / share").click(); pg.wait_for_timeout(500)
    ok(pg.locator(".pv-range").get_attribute("min") == "-1", "slider min = -1")
    ok(pg.locator(".pv-range").input_value() == "-1", "slider value = -1 (the default)")
    ok(pg.locator("#ex-latest-val").text_content().strip() == "full log", "label reads 'full log'")
    pg.locator(".pv-range").evaluate("el => { el.value = 120; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(600)
    ok(pg.locator("#ex-latest-val").text_content().strip() == "last 120", "dragging to 120 → 'last 120'")
    lat = pg.evaluate("() => JSON.parse(localStorage.getItem('doomalay.exportlatest.v1'))")
    ok(lat and lat.get(SID) == 120, "persisted 120 for this chat")
    md_url = pg.locator('[data-x="md"]').get_attribute("data-url")
    ok("latest=120" in md_url, "export URLs carry ?latest=120")
    pg.locator(".pv-range").evaluate("el => { el.value = -1; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(600)
    ok(pg.locator("#ex-latest-val").text_content().strip() == "full log", "back to the left edge = 'full log'")
    lat = pg.evaluate("() => JSON.parse(localStorage.getItem('doomalay.exportlatest.v1'))")
    ok(not lat or SID not in lat, "full log persists as -1 (map entry dropped)")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(400)

    # ── 2. the one compaction ladder ────────────────────────────────
    print("compaction settings → every meter")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(90, {compactEnabled:true, compactThreshold:70}) === 'var(--err)'"),
       "ctxColor: on + default thr → err red at 90%")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(90, {compactEnabled:false, compactThreshold:70}) === 'var(--notice)'"),
       "ctxColor: OFF → the adjacent --notice at 90% (no alarm red)")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(55, {compactEnabled:false}) === 'var(--warn)'"),
       "ctxColor: OFF mid-band stays warn")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(75, {compactEnabled:true, compactThreshold:80}) === 'var(--warn)'"),
       "ctxColor: thr 80 → 75% is warn (below the user's threshold)")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(85, {compactEnabled:true, compactThreshold:80}) === 'var(--err)'"),
       "ctxColor: thr 80 → 85% is err (past the user's threshold)")
    notice = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--notice').trim()")
    errc = pg.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--err').trim()")
    ok(bool(notice) and notice != errc, f"--notice is theme-owned + distinct from --err ({notice} vs {errc})")

    # mind panel: threshold → 80, then the usage view reflects it
    pg.locator("#pill-mind").click(); pg.wait_for_timeout(700)
    pg.locator("#mind-compact-threshold").evaluate("el => { el.value = 80; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(1200)  # debounce + PATCH + meters refresh
    _, sess2 = japi("GET", f"/api/sessions/{SID}")
    ok(sess2.get("CompactThresholdPct") == 80, "engine PATCHed: threshold 80")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(300)
    pg.get_by_text("usage").click(); pg.wait_for_timeout(600)
    body = pg.locator(".panel-body").inner_text()
    ok("arms at 80%" in body, "usage view reads 'auto-compact arms at 80%'")
    ok(pg.evaluate("() => window.UsagePanel.ctxColor(75, {compactThreshold: window.ChatPanel.getState('c30')._usage.context.compactThreshold})") ==
       pg.evaluate("() => { const c = window.ChatPanel.getState('c30')._usage.context; return window.UsagePanel.ctxColor(75, c); }"),
       "the usage endpoint reports the chat's own threshold (80)")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(300)

    # mind panel: compaction OFF → usage view + the header ring follow
    pg.locator("#pill-mind").click(); pg.wait_for_timeout(700)
    pg.locator("#mind-compact-toggle").click(); pg.wait_for_timeout(1400)  # PATCH + refreshMetersSoon
    _, sess3 = japi("GET", f"/api/sessions/{SID}")
    ok(sess3.get("CompactEnabled") == False, "engine PATCHed: compaction off")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(300)
    pg.get_by_text("usage").click(); pg.wait_for_timeout(600)
    ok("auto-compact off" in pg.locator(".panel-body").inner_text(),
       "usage view reads 'auto-compact off — context fills unchecked'")
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(300)
    # the (restored) header ring's tooltip carries the off state
    ring_title = pg.evaluate("""() => {
      const st = window.ChatPanel.getState('c30');
      const r = st && st._chatRootEl && st._chatRootEl.querySelector('#header-ctx-ring');
      return r ? r.title : '';
    }""")
    ok("compaction off" in ring_title, f"header ring tooltip carries 'compaction off' ({ring_title!r})")
    # restore: on + 70 for the rest of the suite
    pg.locator("#pill-mind").click(); pg.wait_for_timeout(700)
    pg.locator("#mind-compact-toggle").click(); pg.wait_for_timeout(500)
    pg.locator("#mind-compact-threshold").evaluate("el => { el.value = 70; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(800)
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(300)

    # ── 4. the tweaks pill + per-chat settings view ────────────────
    print("tweaks pill + per-chat view")
    utils = pg.locator(".util-btn")
    # v0.31.2 update: the util row is back to 3 pills — the ◈ hub pill
    # (added v0.31.0) moved to the CANVAS DOCK (the library glyph in the
    # strip left of the settings gear). export + tweaks + usage.
    ok(utils.count() == 3, "util row: export + tweaks + usage (3 pills — hub moved to the canvas dock)")
    ok("tweaks" in utils.nth(1).inner_text().lower(), "the tweaks pill sits between export and usage")
    utils.nth(1).click(); pg.wait_for_timeout(700)
    ok("tweaks" in pg.locator("#panel-name").inner_text().lower(), "the tweaks view opens")
    for title in ["Chat Colors", "Text Size", "Background"]:
        pg.locator(".settings-section h3", has_text=title).first.click(); pg.wait_for_timeout(200)
    ok(pg.locator('[data-action="chat-scheme"][data-scope="chat"]').count() > 0,
       "same scheme swatches as the settings, scoped chat")
    ok(pg.locator('input[data-custom="fmt"][data-scope="chat"]').count() == 5,
       "same five fmt color rows as the settings, scoped chat")
    ok(pg.locator('input.app-range[data-scope="chat"]').count() == 3,
       "same three size sliders as the settings, scoped chat")

    # scheme → inline --fmt-* on #chat-root, global untouched
    before_global = pg.evaluate("() => JSON.stringify(window.Settings.getState().chatScheme)")
    pg.locator('[data-action="chat-scheme"][data-scope="chat"][data-scheme="rose"]').click()
    pg.wait_for_timeout(700)
    ok(root_style("--fmt-a1") == "#f472b6", "rose scheme → --fmt-a1 #f472b6 on #chat-root (inline)")
    ok(root_style("--fmt-bright") == "#fff0f6", "…and the bright slot rode along")
    after_global = pg.evaluate("() => JSON.stringify(window.Settings.getState().chatScheme)")
    ok(before_global == after_global, "the GLOBAL chat scheme is untouched")
    _, tw = japi("GET", f"/api/sessions/{SID}/tweaks")
    ok(tw.get("tweaks", {}).get("chatScheme") == "rose", "engine blob: chatScheme rose")

    # text size → inline --chat-fs + engine blob
    pg.locator('input.app-range[data-scope="chat"]').first.evaluate(
        "el => { el.value = 80; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(900)
    ok(root_style("--chat-fs") == "21.6px", "chat text 80 → --chat-fs 21.6px (12 + 0.8×12)")
    _, tw = japi("GET", f"/api/sessions/{SID}/tweaks")
    ok(tw.get("tweaks", {}).get("chatTextSize") == 80, "engine blob: chatTextSize 80")
    ok(pg.evaluate("() => window.Settings.getState().chatTextSize") == 50,
       "the GLOBAL chat text size is untouched (50)")

    # background color → inline background-color
    pg.locator("[data-bg-color]").evaluate(
        "el => { el.value = '#101020'; el.dispatchEvent(new Event('input')) }")
    pg.wait_for_timeout(700)
    ok(pg.evaluate("""() => window.ChatPanel.getState('c30')._chatRootEl.style.backgroundColor""") == "rgb(16, 16, 32)",
       "background color applies to the chat panel")
    _, tw = japi("GET", f"/api/sessions/{SID}/tweaks")
    ok(tw.get("tweaks", {}).get("bg") == {"type": "color", "color": "#101020"}, "engine blob: bg color")

    # background image — the full client pipeline (pick → downscale → PUT → ?v=rev)
    png_path = make_png("/tmp/v30-bg.png")
    pg.locator("#tweaks-bg-file").set_input_files(png_path)
    pg.wait_for_timeout(1500)
    # v0.33: the tweaks rebuild now PRESERVES which sections are expanded
    # (the gradient editor rebuilds on every add/remove — sections can't
    # fold up mid-edit), so the old "reopen Background" workaround is GONE
    ok(pg.evaluate("""() => {
      const secs = document.querySelectorAll('.settings-section');
      for (const s of secs) {
        const h = s.querySelector('h3');
        if (h && h.textContent.includes('Background')) return s.classList.contains('expanded');
      }
      return false;
    }"""), "the Background section stays expanded across the upload rebuild (v0.33)")
    bgimg = pg.evaluate("() => window.ChatPanel.getState('c30')._chatRootEl.style.backgroundImage")
    ok("background?v=1" in bgimg and "/api/sessions/" in bgimg, f"image set → rev-1 cache-busted URL ({bgimg!r})")
    ok("an image is set" in pg.locator("#tweaks-bg-status").inner_text(), "the status line confirms the image")
    stbg, bodybg = api("GET", f"/api/sessions/{SID}/background")
    ok(stbg == 200 and bodybg[:3] == b"\xff\xd8\xff", "engine serves the stored background (re-encoded JPEG bytes)")
    _, tw = japi("GET", f"/api/sessions/{SID}/tweaks")
    ok(tw.get("tweaks", {}).get("bg", {}).get("type") == "image", "engine blob: bg image + rev")

    # remove the image
    pg.locator("#tweaks-bg-remove").click(); pg.wait_for_timeout(900)
    ok(pg.evaluate("() => window.ChatPanel.getState('c30')._chatRootEl.style.backgroundImage") == "",
       "removing the image clears the background")
    stbg2, _ = api("GET", f"/api/sessions/{SID}/background")
    ok(stbg2 == 404, "engine: the background row is gone")

    # pop the view — the LIVE CHAT carries the per-chat look
    pg.locator("#panel-view-back").click(); pg.wait_for_timeout(500)
    ok(root_style("--fmt-a1") == "#f472b6" and root_style("--chat-fs") == "21.6px",
       "back on the chat: the per-chat scheme + size survived the view round-trip")

    # reload → the tweaks come back from the engine blob
    pg.reload(); pg.wait_for_timeout(700)
    pg.mouse.click(120, 200); pg.wait_for_timeout(1200)
    ok(root_style("--fmt-a1") == "#f472b6", "after reload: the per-chat scheme is back (engine-side)")
    ok(root_style("--chat-fs") == "21.6px", "after reload: the per-chat size is back")
    ok(pg.evaluate("() => window.Settings.getState().chatScheme === 'teal'"),
       "after reload: the GLOBAL settings still never changed")

    # a second chat inherits the global look (no per-chat overrides)
    pg.locator("#chat-scrim").click(position={"x": 10, "y": 10}); pg.wait_for_timeout(400)
    st2, sess2b = api("POST", "/api/sessions", {"title": "Plain", "sandbox": "quick",
        "model": "nvidia/nvidia/nemotron-3-super", "provider": "nvidia"})
    SID2 = json.loads(sess2b)["ID"]
    pg.evaluate("""([id, sid]) => {
      const s = JSON.parse(localStorage.getItem('doomalay.state.v2'));
      s.icons.push({id: id, type: 'chat', name: 'Plain', family: 'nvidia', iconIndex: 0,
        x: 240, y: 320, vx: 0, vy: 0, radius: 28, sandbox: 'quick',
        model: 'nvidia/nvidia/nemotron-3-super', provider: 'nvidia', sessionId: sid});
      localStorage.setItem('doomalay.state.v2', JSON.stringify(s));
    }""", ["c31", SID2])
    pg.reload(); pg.wait_for_timeout(700)
    pg.mouse.click(240, 320); pg.wait_for_timeout(1200)
    ok(pg.evaluate("""() => {
      const st = window.ChatPanel.getState('c31');
      const r = st && st._chatRootEl;
      return r && r.style.getPropertyValue('--chat-fs') === '' &&
             r.style.getPropertyValue('--fmt-a1') === '';
    }"""), "a second, untweaked chat inherits the global look (no inline overrides)")

    ok(len(errors) == 0, f"no page errors across the whole suite ({len(errors)})")
    if errors: print("   page errors:", errors)
    br.close()

print(f"\n{'='*50}\nTOTAL: {PASS} pass, {FAIL} fail")
try: br.close()
except Exception: pass
proc.kill()
sys.exit(1 if FAIL else 0)
