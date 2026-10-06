#!/usr/bin/env python3
# v109-seamless-field-test.py — THE SEAMLESS FIELD proof rig (PLAN-V109).
#
# Real-user imitation: boots the engine (real API) + serves the WEB DIR
# FROM DISK on :8099 (the v106/v107 pattern — the prebuilt binary embeds an
# older web tree; the rig must test the files on disk), then drives
# Playwright through the flows a human runs:
#   §A THE STEADY HAND — the metadata/workspace pills hold ONE stable bake
#                        across forced repaints (the projected↔local
#                        oscillation the user reports as pills "switching
#                        to non doom projection randomly for a bit").
#                        (v1.08.2)
#   §B THE FULL SPECTRUM — toggles + sliders window their field LOCALLY
#                        under the gate (full gradient, no painter bake).
#                        (v1.08.3)
#   §C THE SEAMLESS FIELD — the panel header continues the body's gradient
#                        (no restart/tiling at the seam). (v1.08.4)
#   §D THE COAST        — text windows write NOTHING during scroll/motion;
#                        one settle re-anchors. (v1.08.5)
#
# Usage:
#   python3 scripts/v109-seamless-field-test.py --web <dir> --out <prefix> [--label S] [--sections A]
#   (engine must NOT already run; port 8078 internal / 8099 served)
import argparse, http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v109test"

ap = argparse.ArgumentParser()
ap.add_argument("--web", required=True, help="web dir to serve (fresh files)")
ap.add_argument("--out", required=True, help="output prefix for screenshots/json")
ap.add_argument("--label", default="run")
ap.add_argument("--sections", default="A", help="sections to run, e.g. A or ABCD")
args = ap.parse_args()
WEB = os.path.abspath(args.web)
OUT = os.path.abspath(args.out)
SECTIONS = set(args.sections.upper())
os.makedirs(os.path.dirname(OUT), exist_ok=True)

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".png": "image/png", ".svg": "image/svg+xml", ".mjs": "text/javascript",
        ".woff2": "font/woff2", ".json": "application/json", ".map": "application/json"}

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "host"}


class Mix(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _static(self):
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        fp = os.path.join(WEB, path.lstrip("/"))
        fp = os.path.realpath(fp)
        if not fp.startswith(os.path.realpath(WEB)) or not os.path.isfile(fp):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ext = os.path.splitext(fp)[1]
        body = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _fwd(self, body):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if (body and length) else None
        conn = http.client.HTTPConnection("127.0.0.1", ENG_PORT, timeout=90)
        try:
            req = conn.request(self.command, self.path, body=data,
                               headers={k: v for k, v in self.headers.items()
                                        if k.lower() not in HOP})
            r = conn.getresponse()
            rb = r.read()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(rb)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(rb)
        except Exception:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
        finally:
            conn.close()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p.startswith("/api/"):
            self._fwd(None)
        else:
            self._static()

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self._fwd(True)

    def do_PUT(self):
        self._fwd(True)

    def do_PATCH(self):
        self._fwd(True)

    def do_DELETE(self):
        self._fwd(True)

    def do_OPTIONS(self):
        self._fwd(False)

    def log_message(self, *a):
        pass


# ── boot the engine ────────────────────────────────────────────────────
import shutil
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v109-engine.log", "w")
proc = subprocess.Popen([ENG, "--port", str(ENG_PORT), "--bind", "127.0.0.1",
                         "--data-dir", DATA, "--open", "false"],
                        stdout=logf, stderr=subprocess.STDOUT)
for _ in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{ENG_PORT}/api/health", timeout=1)
        break
    except Exception:
        time.sleep(0.25)
else:
    print("FATAL: engine did not start"); sys.exit(1)
print(f"engine up on :{ENG_PORT}; serving {WEB} on :8099")

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    print(("  PASS " if cond else "  FAIL ") + label)
    if cond: PASS += 1
    else: FAIL += 1

from playwright.sync_api import sync_playwright

results = {"label": args.label, "checks": [], "ledger": {}}
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 420, "height": 800},
                            device_scale_factor=2, has_touch=True,
                            is_mobile=True)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: print("  [pageerror]", str(e)[:160]))
        pg.goto(BASE, wait_until="domcontentloaded")
        pg.wait_for_timeout(2600)

        # ── open a chat the way a user does ────────────────────────────
        def open_chat_via_dock():
            pg.evaluate("""() => {
              const strip = document.getElementById('dock-strip');
              const nb = document.getElementById('dock-new');
              if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
              const cb = strip ? strip.querySelector('#dock-new-chat') : null;
              if (cb) cb.click();
            }""")
            pg.wait_for_timeout(1600)

        if not pg.evaluate("() => !!document.querySelector('.chatbot')"):
            pg.evaluate("() => { const b = document.getElementById('canvas-empty-btn'); if (b) b.click(); }")
            pg.wait_for_timeout(1800)
        if not pg.evaluate("() => document.querySelector('#chat-panel').classList.contains('open')"):
            open_chat_via_dock()
        ok(pg.evaluate("() => document.querySelector('#chat-panel').classList.contains('open')"),
           "the master panel is open")

        # ── the fields: surface + accents carry gradients (the app's own
        # state machinery) — the projection needs live gradient fields ──
        field = pg.evaluate("""() => {
          const s = Settings.getState();
          const overrides = Object.assign({}, s.themeOverrides);
          overrides[s.theme] = Object.assign({}, overrides[s.theme], {
            '--field-surface': { colors: ['#10101c', '#2a1a4a', '#0e6b6b'], dir: 'auto' },
            '--field-accent-1': { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' },
            '--field-accent-2': { colors: ['#22d3ee', '#0ea5e9', '#7c3aed'], dir: 'auto' },
            '--field-accent-3': { colors: ['#f472b6', '#c084fc', '#fb7185'], dir: 'auto' }
          });
          Settings.setState({ themeOverrides: overrides });
          const cs = getComputedStyle(document.documentElement);
          return cs.getPropertyValue('--accent-gradient').trim().slice(0, 24);
        }""")
        pg.wait_for_timeout(600)
        ok('linear' in field or 'radial' in field,
           f"accent fields carry gradients ('{field[:20]}…')")

        # ── the projection ON (the app's own switch) ───────────────────
        pg.evaluate("() => Settings.setState({ doomProjection: true })")
        pg.wait_for_timeout(900)
        st = pg.evaluate("() => window.DoomProjection.stats()")
        ok(st.get("on") and st.get("painted", 0) > 0,
           f"the painter lives with a sane population ({st})")

        # ══ §A THE STEADY HAND (v1.08.2) ═══════════════════════════════
        if "A" in SECTIONS:
            # open the header dropdown the way a user does — the pill row
            # lives in #chat-dropdown (closed = display:none = zero rects)
            pg.evaluate("""() => {
              const row = document.getElementById('chat-header-row');
              if (row) row.click();
            }""")
            pg.wait_for_timeout(700)

            def pill_ledger():
                return pg.evaluate("""() => {
                  const row = document.getElementById('pill-row');
                  if (!row) return { found: false, pills: [] };
                  const pills = Array.from(row.querySelectorAll('button')).map(b => ({
                    id: b.id || b.className,
                    proj: b.hasAttribute('data-proj'),
                    bake: b.hasAttribute('data-proj-bake'),
                    sup: !!b.__projSuppressed,
                    pos: (b.style.backgroundPosition || '').slice(0, 24),
                    att: getComputedStyle(b).backgroundAttachment,
                    color: (b.style.backgroundColor || '').slice(0, 40)
                  }));
                  return { found: true, pills,
                           painted: window.DoomProjection.stats().painted };
                }""")

            s0 = pill_ledger()
            results["ledger"]["A_s0"] = s0
            ok(s0["found"] and len(s0["pills"]) >= 3,
               f"the pill row renders ({len(s0['pills'])} pills)")
            suppressed = [x for x in s0["pills"] if x["sup"] or x["proj"]]
            baked = [x for x in s0["pills"] if x["bake"]]
            ok(len(suppressed) > 0,
               f"pills ride the layer path (sup/L2: {len(suppressed)}, legacy: {len(baked)})")

            # THE OSCILLATION PROBE — five forced repaints; the pill states
            # must hold (PRE tree: the suppressed pills DROP on the next
            # paint — the catcher match broke — then re-bake: oscillation).
            ledgers = [s0]
            stable = True
            for i in range(5):
                pg.evaluate("() => window.DoomProjection.paint()")
                pg.wait_for_timeout(140)
                li = pill_ledger()
                ledgers.append(li)
                if li["pills"] != ledgers[-2]["pills"]:
                    stable = False
            results["ledger"]["A_ledgers"] = ledgers
            ok(stable, "THE STEADY HAND: five repaints, zero pill state flips")
            painted_series = [l["painted"] for l in ledgers]
            ok(max(painted_series) - min(painted_series) == 0,
               f"the painted population holds ({painted_series})")
            y = pg.evaluate("() => window.DoomProjection.counters.yielded || 0")
            ok(y == 0, f"the painter never yielded a held window to CSS ({y})")
            pg.screenshot(path=OUT + "-A-pills.png")

        # ══ §B THE FULL SPECTRUM (v1.08.3) ═════════════════════════════
        if "B" in SECTIONS:
            pg.evaluate("""() => {
              const btn = document.getElementById('settings-btn');
              if (btn) btn.click();
            }""")
            pg.wait_for_timeout(900)
            # the appearance page: the doom projection switch (CHECKED —
            # projection is on) + every settings app-switch
            pg.evaluate("""() => {
              const t = document.querySelector('.settings-nav .tab[data-page="appearance"]');
              if (t) t.click();
            }""")
            pg.wait_for_timeout(800)
            bB = pg.evaluate("""() => {
              const input = document.querySelector('input[data-setting-key="doomProjection"]');
              const track = input ? input.parentElement.querySelector('.app-switch-track') : null;
              const anySw = document.querySelector('.app-switch input:checked ~ .app-switch-track');
              const t2 = anySw || track;
              const r = { stats0: window.DoomProjection.counters.paints };
              if (t2) {
                const cs = getComputedStyle(t2);
                r.track = { checked: !!anySw,
                            img: cs.backgroundImage.slice(0, 90),
                            att: cs.backgroundAttachment,
                            size: cs.backgroundSize.slice(0, 40),
                            bake: t2.hasAttribute('data-proj-bake'),
                            layer: t2.hasAttribute('data-proj') };
              }
              return r;
            }""")
            # the doom switch lives on the FIELDS sub-page — navigate in
            pg.evaluate("""() => {
              const rows = document.querySelectorAll('[data-section-toggle], .settings-section');
              for (const s of rows) {
                if ((s.textContent || '').indexOf('The Fields') !== -1) {
                  const h = s.matches('[data-section-toggle]') ? s : s.querySelector('[data-section-toggle]') || s;
                  h.click(); break;
                }
              }
            }""")
            pg.wait_for_timeout(800)
            pg.screenshot(path=OUT + "-B-appearance.png")
            # the sizing page: the .app-range sliders
            pg.evaluate("""() => {
              const t = document.querySelector('.settings-nav .tab[data-page="sizing"]');
              if (t) t.click();
            }""")
            pg.wait_for_timeout(800)
            b2 = pg.evaluate("""() => {
              const range = document.querySelector('input.app-range');
              const r = { stats1: window.DoomProjection.stats().paints };
              if (range) {
                const cs = getComputedStyle(range);
                r.range = { img: cs.backgroundImage.slice(0, 120),
                            att: cs.backgroundAttachment,
                            bake: range.hasAttribute('data-proj-bake'),
                            layer: range.hasAttribute('data-proj') };
              }
              r.stats = window.DoomProjection.stats();
              return r;
            }""")
            b2 = pg.evaluate("""() => {
              const range = document.querySelector('input.app-range');
              const r = { stats1: window.DoomProjection.counters.paints };
              if (range) {
                const cs = getComputedStyle(range);
                r.range = { img: cs.backgroundImage.slice(0, 120),
                            att: cs.backgroundAttachment,
                            bake: range.hasAttribute('data-proj-bake'),
                            layer: range.hasAttribute('data-proj') };
              }
              r.stats = window.DoomProjection.stats();
              return r;
            }""")
            bB.update(b2)
            results["ledger"]["B"] = bB
            if "track" in bB:
                t = bB["track"]
                ok(t["att"].startswith("local"),
                   f"THE GATE WINDOW: the checked track is LOCAL (att={t['att']})")
                ok("gradient" in t["img"],
                   f"the checked track carries the full gradient ('{t['img'][:44]}…')")
                ok(not t["bake"] and not t["layer"],
                   f"the painter never baked the track (bake={t['bake']}, layer={t['layer']})")
            else:
                ok(False, "no checked app-switch track found on the settings page")
            if "range" in bB:
                r = bB["range"]
                # v1.10.4 THE NATIVE HAND updated the contract: the user
                # reverted the slider look ("narrow, clean" native; accent-
                # color is <color>-only, so the first gradient stop is the
                # doom look the user accepted). The slider now renders
                # NATIVE under the gate: no local field window, no layered
                # background, and the painter never bakes it.
                ok(not r["att"].startswith("local"),
                   f"the slider renders NATIVE under the gate (att={r['att']})")
                ok(r["img"] == "none",
                   f"the slider carries no field ('{r['img'][:56]}…')")
                ok(not r["bake"] and not r["layer"],
                   "the painter never baked the slider")
            else:
                ok(False, "no .app-range slider found on the sizing page")
            ok((bB.get("stats") or {}).get("painted", 99) <= 12,
               f"the settings chrome never joined the painted population (painted={bB.get('stats', {}).get('painted')})")
            # expose the sliders (the sections collapse) + screenshot
            pg.evaluate("""() => {
              const s = document.querySelector('[data-section-toggle]');
              if (s && !s.classList.contains('expanded')) s.click();
            }""")
            pg.wait_for_timeout(600)
            pg.screenshot(path=OUT + "-B-chrome.png")
            # CLOSE settings the way a user does: the settings REPLACES the
            # panel root (panel.open, not a view stack) — the dock's new-chat
            # re-render restores the chat root (debug-proven: it works even
            # with the panel still open).
            for _ in range(3):
                if pg.evaluate("() => !!document.getElementById('chat-scroll')"):
                    break
                open_chat_via_dock()
                pg.wait_for_timeout(600)
            ok(pg.evaluate("() => !!document.getElementById('chat-scroll')"),
               "the chat view is back (dock reopen)")

        # ══ §C THE SEAMLESS FIELD (v1.08.4) ════════════════════════════
        if "C" in SECTIONS:
            # close §A's dropdown (its pills would eat the stretch drag)
            pg.evaluate("() => { const r = document.getElementById('chat-header-row'); if (r) r.click(); }")
            pg.wait_for_timeout(500)
            # the user reported this with projection OFF — the surface
            # renders LOCAL in both toggle states (v1.06.1); test OFF.
            pg.evaluate("() => Settings.setState({ doomProjection: false })")
            pg.wait_for_timeout(900)
            c = pg.evaluate("""() => {
              const panel = document.getElementById('chat-panel');
              const head = panel.querySelector('.panel-header');
              const body = panel.querySelector('.panel-body');
              if (!head || !body) return { found: false };
              const csH = getComputedStyle(head);
              const csB = getComputedStyle(body);
              const hr = head.getBoundingClientRect();
              const br = body.getBoundingClientRect();
              return { found: true,
                       hSize: csH.backgroundSize, hPos: csH.backgroundPosition,
                       bSize: csB.backgroundSize, bPos: csB.backgroundPosition,
                       headH: Math.round(hr.height * 10) / 10,
                       fieldH: getComputedStyle(panel).getPropertyValue('--panel-field-h').trim(),
                       headOff: getComputedStyle(panel).getPropertyValue('--panel-head-off').trim(),
                       fieldTop: getComputedStyle(panel).getPropertyValue('--panel-field-top').trim() };
            }""")
            results["ledger"]["C"] = c
            if c.get("found"):
                ok(c["hSize"] == c["bSize"] and c["hSize"].endswith("px"),
                   f"ONE shared field scale (header={c['hSize']} · body={c['bSize']})")
                ok(c["hPos"].startswith("0px") and c["bPos"].startswith("0px") and
                   "-" in c["hPos"] and "-" in c["bPos"],
                   f"the windows are offset into the shared field ({c['hPos']} / {c['bPos']})")
                ok(c["fieldH"] not in ("", "100%"),
                   f"--panel-field-h synced at rest ({c['fieldH']})")
                # continuity by construction: fieldTop - headOff == header height
                try:
                    ft = float(c["fieldTop"].replace("px", ""))
                    ho = float(c["headOff"].replace("px", ""))
                    ok(abs((ft - ho) - c["headH"]) < 2,
                       f"the body's window starts exactly at the header's bottom (Δ={ft - ho:.1f} vs h={c['headH']})")
                except Exception:
                    ok(False, "the field offsets parse as px lengths")
            else:
                ok(False, "the panel header/body not found")
            # THE SEAM PROBE — the header's bottom band and the body's top
            # band must sample the SAME field positions (one continuous
            # gradient, no restart). Pixel truth via clipped screenshots.
            hr = pg.evaluate("""() => {
              const head = document.querySelector('#chat-panel .panel-header');
              const body = document.querySelector('#chat-panel .panel-body');
              const h = head.getBoundingClientRect();
              const b = body.getBoundingClientRect();
              return { hx: h.x, hy: h.y, hw: h.width, hh: h.height,
                       bx: b.x, by: b.y, bw: b.width };
            }""")
            if hr.get("hw"):
                seam_h = OUT + "-C-seam-head.png"
                seam_b = OUT + "-C-seam-body.png"
                pg.screenshot(path=seam_h, clip={"x": hr["hx"] + hr["hw"] * 0.3,
                                                 "y": hr["hy"] + hr["hh"] - 9,
                                                 "width": hr["hw"] * 0.3, "height": 5})
                pg.screenshot(path=seam_b, clip={"x": hr["bx"] + hr["bw"] * 0.3,
                                                 "y": hr["by"] + 2,
                                                 "width": hr["bw"] * 0.3, "height": 5})
                try:
                    from PIL import Image
                    def avg(p):
                        im = Image.open(p).convert("RGB")
                        px = list(im.getdata())
                        n = len(px)
                        return tuple(sum(c[i] for c in px) / n for i in range(3))
                    ah, ab = avg(seam_h), avg(seam_b)
                    d = sum(abs(ah[i] - ab[i]) for i in range(3))
                    results["ledger"]["C_seam"] = {"header": ah, "body": ab, "delta": d}
                    ok(d < 42,
                       f"THE SEAM: header-bottom rgb{tuple(round(v) for v in ah)} ≈ body-top "
                       f"rgb{tuple(round(v) for v in ab)} (Δ={d:.1f} < 42)")
                except Exception as ex:
                    ok(False, f"the seam pixel probe failed: {ex}")
            # the re-sync mechanism end-to-end: a touch drag settles back to
            # the same rest (the field must NOT drift), then the vars are
            # wiped and a rest write (resize) must land them again — the
            # debounced CSSOM sync firing exactly once at rest.
            fh0 = c.get("fieldH", "")
            try:
                cdp = ctx.new_cdp_session(pg)
                hd = pg.evaluate("""() => {
                  const h = document.querySelector('#chat-panel .handle');
                  const r = h.getBoundingClientRect();
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }""")
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": hd["x"], "y": hd["y"]}]})
                for i in range(1, 13):
                    cdp.send("Input.dispatchTouchEvent",
                             {"type": "touchMove", "touchPoints":
                              [{"x": hd["x"], "y": hd["y"] + 70 * i / 12}]})
                    time.sleep(0.014)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(1100)
                fh1 = pg.evaluate("""() => getComputedStyle(document.getElementById('chat-panel'))
                                        .getPropertyValue('--panel-field-h').trim()""")
                ok(fh1 == fh0 and fh1.endswith("px"),
                   f"the field holds through a drag + spring ({fh0} → {fh1})")
                wiped = pg.evaluate("""() => {
                  const sh = document.getElementById('panel-field-vars');
                  if (!sh || !sh.sheet || !sh.sheet.cssRules.length) return false;
                  const st = sh.sheet.cssRules[0].style;
                  st.removeProperty('--panel-field-h');
                  st.removeProperty('--panel-field-top');
                  st.removeProperty('--panel-head-off');
                  return getComputedStyle(document.getElementById('chat-panel'))
                           .getPropertyValue('--panel-field-h').trim() === '';
                }""")
                ok(wiped, "the synced vars wiped clean")
                cdp2 = ctx.new_cdp_session(pg)
                cdp2.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": hd["x"], "y": hd["y"]}]})
                for i in range(1, 9):
                    cdp2.send("Input.dispatchTouchEvent",
                              {"type": "touchMove", "touchPoints":
                               [{"x": hd["x"], "y": hd["y"] + 40 * i / 8}]})
                    time.sleep(0.014)
                cdp2.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(1100)
                fh2 = pg.evaluate("""() => getComputedStyle(document.getElementById('chat-panel'))
                                        .getPropertyValue('--panel-field-h').trim()""")
                ok(fh2 == fh0,
                   f"the rest sync lands the field again ({fh0} → {fh2})")
            except Exception as ex:
                ok(False, f"the re-sync probe failed: {ex}")
            pg.screenshot(path=OUT + "-C-seam.png")
            # back to projection ON for the following sections
            pg.evaluate("() => Settings.setState({ doomProjection: true })")
            pg.wait_for_timeout(600)

        # ══ §D THE COAST (v1.08.5) ═════════════════════════════════════
        if "D" in SECTIONS:
            # the fmt slots carry gradients (the v107 §B pattern) — without
            # them the fmt twins resolve 'none' and no text window exists
            pg.evaluate("""() => {
              const s = Settings.getState();
              Settings.setState({ fmtOverrides: Object.assign({}, s.fmtOverrides, {
                a1: { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' },
                bright: { colors: ['#f9d423', '#ffffff'], dir: 'auto' }
              }) });
            }""")
            pg.wait_for_timeout(700)
            # a long fmt transcript: text windows with live gradient clips
            if not pg.evaluate("() => !!document.getElementById('chat-scroll')"):
                ok(False, "the chat scroller is missing — §D needs the chat view")
            seeded = pg.evaluate("""() => {
              const sc = document.querySelector('#chat-scroll');
              if (!sc) return 0;
              const mk = (i) => {
                const d = document.createElement('div');
                d.className = 'fmt';
                d.innerHTML = '<h2>coast probe ' + i + '</h2><p>plain body with <strong>bold glyphs</strong> and an <a href=\\\"#\\">anchor</a> for the field.</p>';
                sc.appendChild(d);
                return 1;
              };
              let n = 0;
              for (let i = 0; i < 60; i++) n += mk(i);
              return n;
            }""")
            pg.wait_for_timeout(900)
            ok(seeded >= 60, f"fmt transcript seeded ({seeded} blocks)")

            diag = pg.evaluate("""() => {
              const out = { samples: [], scrollChildren: 0 };
              const sc = document.getElementById('chat-scroll');
              out.scrollChildren = sc ? sc.querySelectorAll('.fmt h2, .fmt strong').length : 0;
              const els = sc ? sc.querySelectorAll('.fmt h2, .fmt strong') : [];
              for (let i = 0; i < Math.min(6, els.length); i++) {
                const el = els[i];
                const cs = getComputedStyle(el);
                out.samples.push({
                  tag: el.tagName, i,
                  clipFlag: el.__projClip === undefined ? 'undef' : el.__projClip,
                  compClip: cs.webkitBackgroundClip || cs.backgroundClip,
                  l2ok: el.__projL2ok === undefined ? 'undef' : el.__projL2ok,
                  painted: !!el.__projPainted,
                  pos: (el.style.backgroundPosition || '').slice(0, 30)
                });
              }
              return out;
            }""")
            results["ledger"]["D_diag"] = diag
            print("  [diag]", diag["scrollChildren"], diag["samples"][:3])

            counts = pg.evaluate("""() => {
              // THE WRITE COUNTER — every style-attribute mutation carrying
              // a background-position on a painted text element, observed
              // across a scripted scroll of the transcript.
              window.__v109writes = 0;
              window.__v109who = {};
              const sc = document.getElementById('chat-scroll');
              const mo = new MutationObserver((muts) => {
                for (const m of muts) {
                  if (m.type !== 'attributes' || m.attributeName !== 'style') continue;
                  const t = m.target;
                  const pos = t.style.backgroundPosition || '';
                  if (pos.indexOf('background') !== -1 || t.getAttribute('style').indexOf('background-position') === -1) {
                    if (t.getAttribute('style').indexOf('background-position') === -1) continue;
                  }
                  window.__v109writes++;
                  const k = (t.className || t.tagName) + '|clip=' + (t.__projClip ? 1 : 0) +
                            '|var=' + (pos.indexOf('var(') !== -1 ? 1 : 0);
                  window.__v109who[k] = (window.__v109who[k] || 0) + 1;
                  if (!window.__v109writers) window.__v109writers = [];
                  if (window.__v109writers.length < 4 && t.__projClip !== 1) {
                    window.__v109writers.push({
                      tag: t.tagName, cls: (t.className || '').slice(0, 30),
                      clipFlag: t.__projClip === undefined ? 'undef' : t.__projClip,
                      painted: !!t.__projPainted, carry: !!t.__projCarry,
                      l2ok: t.__projL2ok === undefined ? 'undef' : t.__projL2ok,
                      connected: t.isConnected,
                      pos: pos.slice(0, 40),
                      compClip: (getComputedStyle(t).webkitBackgroundClip || getComputedStyle(t).backgroundClip)
                    });
                  }
                }
              });
              mo.observe(sc, { attributes: true, attributeFilter: ['style'], subtree: true });
              window.__v109mo = mo;
              const step = () => new Promise(res => {
                let n = 0;
                const t = setInterval(() => {
                  sc.scrollTop += 260; n++;
                  if (n >= 14) { clearInterval(t); sc.scrollTop = 0; setTimeout(res, 260); }
                }, 55);
              });
              return step().then(() => {
                const w = window.__v109writes;
                const who = window.__v109who;
                window.__v109mo.disconnect();
                return { writes: w, who, writers: (window.__v109writers || []).slice(0, 4), painted: window.DoomProjection.stats().painted };
              });
            }""")
            results["ledger"]["D"] = counts
            ok(counts and counts.get("painted", 0) > 30,
               f"the text population is baked ({counts and counts.get('painted')})")
            # THE COAST bar: each text window may write at most its FIRST-SIGHT
            # bake (a correct anchor the moment it enters the viewport) plus
            # the settle re-anchors — never the per-scroll-event storm
            # (pre-coast measured: ~11 writes per element across 14 steps).
            storm = counts and counts.get("writes", 999) > counts.get("painted", 0) * 2.0
            ok(not storm,
               f"THE COAST: {counts and counts.get('writes')} anchor writes across the scroll "
               f"for {counts and counts.get('painted')} painted (the pre-coast storm was ~1400)")
            noclip0 = not any(k.endswith("|clip=0") and v > counts["painted"] * 0.2
                              for k, v in (counts.get("who") or {}).items())
            ok(noclip0, "no un-flagged text windows in the write ledger")

            # ── the MOTION leg: a real panel drag with the projected
            # transcript — the coast batch lands ONCE at the motion edge,
            # the drag frames write NOTHING, the settle re-anchors.
            motion = pg.evaluate("""() => new Promise(res => {
              const sc = document.getElementById('chat-scroll');
              window.__v109mwrites = 0;
              const mo = new MutationObserver((muts) => {
                for (const m of muts) {
                  if (m.type !== 'attributes' || m.attributeName !== 'style') continue;
                  const t = m.target;
                  if ((t.getAttribute('style') || '').indexOf('background-position') !== -1 &&
                      sc.contains(t)) window.__v109mwrites++;
                }
              });
              mo.observe(sc, { attributes: true, attributeFilter: ['style'], subtree: true });
              const longTasks = [];
              try {
                new PerformanceObserver((l) => {
                  for (const e of l.getEntries()) longTasks.push(Math.round(e.duration));
                }).observe({ entryTypes: ['longtask'] });
              } catch (e) {}
              window.__v109mo2 = mo;
              window.__v109lt = longTasks;
              res('armed');
            })""")
            cdp3 = ctx.new_cdp_session(pg)
            hd3 = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""")
            cdp3.send("Input.dispatchTouchEvent",
                     {"type": "touchStart", "touchPoints": [{"x": hd3["x"], "y": hd3["y"]}]})
            for i in range(1, 17):
                cdp3.send("Input.dispatchTouchEvent",
                          {"type": "touchMove", "touchPoints":
                           [{"x": hd3["x"], "y": hd3["y"] + 90 * i / 16}]})
                time.sleep(0.016)
            cdp3.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(1300)
            mres = pg.evaluate("""() => {
              const w = window.__v109mwrites, lt = (window.__v109lt || []).slice();
              if (window.__v109mo2) window.__v109mo2.disconnect();
              return { writes: w, longTasks: lt,
                       maxTask: lt.length ? Math.max.apply(null, lt) : 0 };
            }""")
            results["ledger"]["D_motion"] = mres
            # v1.10.1 THE BREATH: mid-motion re-anchors (2Hz) join the
            # once-per-edge coast + the settle — the write bound widens.
            ok(mres["writes"] <= (counts.get("painted") or 130) * 2.5,
               f"the motion coast: {mres['writes']} transcript anchor writes across a full drag "
               f"(the once-per-motion-edge batch + the settle + the 2Hz breaths)")
            ok(mres["maxTask"] < 150,
               f"no extreme long task during the drag (max={mres['maxTask']}ms, tasks={mres['longTasks'][:8]})")
            pg.screenshot(path=OUT + "-D-coast.png")

        pg.screenshot(path=OUT + "-final.png")
        b.close()
except Exception as e:
    print("RIG ERROR:", e)
    FAIL += 1
finally:
    subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)

print(f"\n== v109 rig [{args.label}] sections={''.join(sorted(SECTIONS))}: {PASS} pass / {FAIL} fail ==")
with open(OUT + "-results.json", "w") as f:
    json.dump({"pass": PASS, "fail": FAIL, **results}, f, indent=1)
sys.exit(1 if FAIL else 0)
