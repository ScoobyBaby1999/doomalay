#!/usr/bin/env python3
# v111-breathing-field-test.py — THE BREATHING FIELD proof rig (PLAN-V111).
#
# Real-user imitation: boots the engine (real API) + serves the WEB DIR
# FROM DISK on :8099 (the v106/v107/v109/v110 pattern), then drives
# Playwright through the flows a human runs:
#   §A THE BREATH     — during the anchor glide the projection re-anchors
#                       mid-motion (breaths ≥ 1 per drag cycle) while the
#                       coast still freezes the vars BETWEEN breaths, and
#                       the settle lands exact. (v1.10.1)
#   §B THE HONEST SKY — with the amplifier + size variation maxed the bake
#                       mints NO heroes, NO glow, NO over-icons split; the
#                       comet gate obeys the scatter sliders. (v1.10.2)
#   §C THE TRUE DEPTH — the top band's drawn period diverges under zoom
#                       (zoomAdj > 1) and stays 1 at amp 0. (v1.10.3)
#   §D THE NATIVE HAND— settings sliders render NATIVE under the gate
#                       (no custom track, no layered field) and --accent
#                       is the first stop of the accent gradient. (v1.10.4)
#   §E THE MEASURED FIX — during the glide the inherited --panel-vis-h
#                       var writes are throttled to ~2Hz (<< the frame
#                       count), killing the subtree recascade. (v1.10.5)
#
# Usage: python3 scripts/v111-breathing-field-test.py --web <dir> --out <prefix> [--sections ABCDE]
import argparse, http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v111test"

ap = argparse.ArgumentParser()
ap.add_argument("--web", required=True, help="web dir to serve (fresh files)")
ap.add_argument("--out", required=True, help="output prefix for screenshots/json")
ap.add_argument("--label", default="run")
ap.add_argument("--sections", default="ABCDE", help="sections to run, e.g. A or ABCDE")
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
        (self._fwd(None) if self.path.split("?")[0].startswith("/api/") else self._static())

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


import shutil
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v111-engine.log", "w")
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
    print("FATAL: engine did not start")
    sys.exit(1)
print(f"engine up on :{ENG_PORT}; serving {WEB} on :8099")

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8099), Mix)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()

PASS = FAIL = 0


def ok(cond, label):
    global PASS, FAIL
    print(("  PASS " if cond else "  FAIL ") + label)
    if cond:
        PASS += 1
    else:
        FAIL += 1


from playwright.sync_api import sync_playwright

results = {"label": args.label, "checks": []}
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

        # ── boot: a chat, gradient fields, the projection on ───────────
        pg.evaluate("""() => {
          const strip = document.getElementById('dock-strip');
          const nb = document.getElementById('dock-new');
          if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
          const cb = strip ? strip.querySelector('#dock-new-chat') : null;
          if (cb) cb.click();
        }""")
        pg.wait_for_timeout(1600)
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
          const fo = Object.assign({}, s.fmtOverrides, {
            a1: { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' },
            bright: { colors: ['#f9d423', '#ffffff'], dir: 'auto' }
          });
          Settings.setState({ fmtOverrides: fo });
          return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        }""")
        pg.wait_for_timeout(600)
        pg.evaluate("() => Settings.setState({ doomProjection: true })")
        pg.wait_for_timeout(900)
        st = pg.evaluate("() => window.DoomProjection.stats()")
        ok(st.get("on") and st.get("painted", 0) > 0,
           f"the painter lives with a sane population (painted {st.get('painted')})")

        # ══ §C THE TRUE DEPTH ══════════════════════════════════════
        if "C" in SECTIONS:
            # close the panel — the canvas is the stage now
            pg.evaluate("() => { const s = document.getElementById('chat-scrim'); if (s) s.click(); }")
            pg.wait_for_timeout(700)
            # zoom IN the canvas the way a user does — the trusted two-finger
            # CDP pinch (the v110 §C pattern), centered on a CANVAS-CERTAIN
            # point with the WHOLE finger corridor checked (an icon under any
            # finger sample turns the pinch into a drag)
            cdpC = ctx.new_cdp_session(pg)
            center = pg.evaluate("""() => {
              const c = document.getElementById('c');
              const r = c.getBoundingClientRect();
              const cands = [[0.5, 0.5], [0.3, 0.6], [0.7, 0.4], [0.25, 0.35],
                             [0.75, 0.7], [0.2, 0.5], [0.8, 0.5], [0.5, 0.85]];
              const SPREADS = [60, 88, 115];
              for (const [fx, fy] of cands) {
                const x = Math.round(r.left + r.width * fx);
                const y = Math.round(r.top + r.height * fy);
                let clean = true;
                for (const s of SPREADS) {
                  for (const sx of [x - s, x + s]) {
                    const el = document.elementFromPoint(sx, y);
                    if (!el || el.tagName !== 'CANVAS') { clean = false; break; }
                  }
                  if (!clean) break;
                }
                if (clean) return { x, y };
              }
              return { x: Math.round(r.left + r.width / 2),
                       y: Math.round(r.top + r.height * 0.85) };
            }""")
            cx, cy = center["x"], center["y"]
            pg.evaluate("() => { window.__v111cx = " + str(cx) + "; window.__v111cy = " + str(cy) + "; }")

            def wake():
                # one short canvas-certain pan — keeps the canvas loop hot so
                # the gesture that follows is processed live (the start point
                # is probed LIVE: at scale 3 the icons are 3x)
                wx, wy = pg.evaluate("""([cx, cy]) => {
                  const cands = [[0, 0], [-60, 0], [60, 0], [-100, 0], [100, 0],
                                 [0, -100], [0, 100], [-160, 80], [160, 80]];
                  for (const [dx, dy] of cands) {
                    const x = cx + dx, y = cy + dy;
                    const el = document.elementFromPoint(x, y);
                    if (el && el.tagName === 'CANVAS') return [x, y];
                  }
                  return [cx, cy];
                }""", [cx, cy])
                cdpC.send("Input.dispatchTouchEvent",
                          {"type": "touchStart", "touchPoints": [{"x": wx, "y": wy}]})
                for i in range(1, 7):
                    cdpC.send("Input.dispatchTouchEvent",
                              {"type": "touchMove", "touchPoints": [{"x": wx, "y": wy - i * 4}]})
                    time.sleep(0.016)
                cdpC.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                time.sleep(0.05)

            def pinch(spread0, spread1, steps=20):
                cdpC.send("Input.dispatchTouchEvent",
                          {"type": "touchStart", "touchPoints": [
                              {"x": cx - spread0, "y": cy}, {"x": cx + spread0, "y": cy}]})
                for i in range(1, steps + 1):
                    d = spread0 + (spread1 - spread0) * i / steps
                    cdpC.send("Input.dispatchTouchEvent",
                              {"type": "touchMove", "touchPoints": [
                                  {"x": cx - d, "y": cy}, {"x": cx + d, "y": cy}]})
                    time.sleep(0.016)
                cdpC.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

            def wait_quiet():
                for _ in range(12):
                    pend = pg.evaluate("() => ((window.DoomalayDebug || {}).oneObject || {}).pending === true")
                    if not pend:
                        break
                    pg.wait_for_timeout(400)
                pg.wait_for_timeout(600)

            # —— (1) world-true at rest (amp 1, scale 1)
            pg.evaluate("() => Settings.setState({ spaceParallax: 100 })")
            pg.wait_for_timeout(800)
            adj0 = pg.evaluate("() => (window.DoomalayDebug || {}).zoomAdj")
            ok(adj0 is not None and abs(adj0 - 1) < 0.02,
               f"world-true at rest (zoomAdj {adj0})")

            # —— (2) amp 0: byte-flat — and it stays flat WHILE zoomed.
            # set amp 0 FIRST (the publish lands while the loop is hot), then
            # pinch: the bands must render world-true at EVERY scale.
            pg.evaluate("() => Settings.setState({ spaceParallax: 0 })")
            flat = None
            dbgflat = {}
            for _ in range(12):
                pg.wait_for_timeout(500)
                dbgflat = pg.evaluate("() => { const d = window.DoomalayDebug || {}; return { amp: d.amp, zoomAdj: d.zoomAdj }; }")
                flat = dbgflat.get("zoomAdj")
                if dbgflat.get("amp") == 0 and flat == 1:
                    break
            ok(flat == 1 and dbgflat.get("amp") == 0,
               f"amp 0 publishes flat (zoomAdj {flat}, amp {dbgflat.get('amp')})")

            wait_quiet()
            wake()
            pinch(60, 115)
            pg.wait_for_timeout(1400)
            flatzoom = pg.evaluate("() => ({ adj: (window.DoomalayDebug || {}).zoomAdj, scale: (window.DoomalayDebug || {}).zoomScale })")
            ok(flatzoom.get("adj") == 1 and (flatzoom.get("scale") or 1) > 1.15,
               f"byte-flat AT zoom too (zoomAdj {flatzoom.get('adj')} at scale {flatzoom.get('scale')})")

            # —— (3) amp 1 again: the planes diverge under the zoom that is
            # now live (no pre-zoom pan needed — the diverge reads at once)
            pg.evaluate("() => Settings.setState({ spaceParallax: 100 })")
            adj2 = None
            for _ in range(12):
                pg.wait_for_timeout(500)
                adj2 = pg.evaluate("() => ({ adj: (window.DoomalayDebug || {}).zoomAdj, scale: (window.DoomalayDebug || {}).zoomScale })")
                if (adj2.get("adj") or 1) > 1.03:
                    break
            ok(adj2.get("adj") is not None and adj2.get("adj") > 1.03 and (adj2.get("scale") or 1) > 1.15,
               f"the planes diverge under zoom (zoomAdj {adj2.get('adj')} at scale {adj2.get('scale')})")
            results["trueDepth"] = {"rest": adj0, "flat": flat, "flatzoom": flatzoom, "diverge": adj2}

        # ══ §A + §E THE BREATH + THE MEASURED FIX ══════════════════════
        if "A" in SECTIONS or "E" in SECTIONS:
            # the panel may be closed (an earlier section docked it) — open
            # it the way a user does: the dock's new-chat entry
            pg.evaluate("""() => {
              const panel = document.getElementById('chat-panel');
              if (panel && !panel.classList.contains('open')) {
                const strip = document.getElementById('dock-strip');
                const nb = document.getElementById('dock-new');
                if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
                const cb = strip ? strip.querySelector('#dock-new-chat') : null;
                if (cb) cb.click();
              }
            }""")
            pg.wait_for_timeout(1600)
            # seed the transcript (the projection's real workload)
            pg.evaluate("""() => {
              const sc = document.querySelector('#chat-scroll');
              if (!sc) return 0;
              for (let i = 0; i < 60; i++) {
                const d = document.createElement('div');
                d.className = 'fmt';
                d.innerHTML = '<h2>breath probe ' + i + '</h2><p>plain body with <strong>bold glyphs</strong> and an <a href="#">anchor</a>.</p>';
                sc.appendChild(d);
              }
            }""")
            pg.wait_for_timeout(800)
            pg.evaluate("""() => new Promise(res => {
              const root = document.getElementById('chat-panel');
              const V = window.__v111 = { samples: [], frames: 0 };
              const counters = (window.DoomProjection.countors || window.DoomProjection.counters || {});
              (function sample() {
                const cs = getComputedStyle(root);
                V.samples.push({
                  t: Math.round(performance.now()),
                  ty: cs.getPropertyValue('--proj-ty').trim(),
                  visH: cs.getPropertyValue('--panel-vis-h').trim(),
                  coast: window.DoomProjection.isCoasting ? DoomProjection.isCoasting() : null,
                  paints: (window.DoomProjection.counters || counters).paints,
                  breaths: (window.DoomProjection.counters || counters).breaths || 0
                });
                if (++V.frames < 320) V.raf = requestAnimationFrame(sample);
              })();
              res('armed');
            })""")
            cdpA = ctx.new_cdp_session(pg)
            hd = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""")

            def drag(dy_total, steps=16):
                cdpA.send("Input.dispatchTouchEvent",
                          {"type": "touchStart", "touchPoints": [{"x": hd["x"], "y": hd["y"]}]})
                for i in range(1, steps + 1):
                    cdpA.send("Input.dispatchTouchEvent",
                              {"type": "touchMove", "touchPoints":
                               [{"x": hd["x"], "y": hd["y"] + dy_total * i / steps}]})
                    time.sleep(0.016)
                cdpA.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

            drag(-260)          # up → the spring glides to 'full'
            pg.wait_for_timeout(1400)
            drag(180)           # down → the spring glides to 'default'
            pg.wait_for_timeout(1400)
            ares = pg.evaluate("""() => {
              const V = window.__v111;
              if (V.raf) cancelAnimationFrame(V.raf);
              const s = V.samples;
              // (1) between breaths the coast still freezes: consecutive
              //     coast frames with NO paint between → --proj-ty never
              //     moved (the v110 invariant, breath-exempt).
              let checked = 0, frozenViolations = 0;
              for (let i = 0; i + 1 < s.length; i++) {
                if (s[i].coast && s[i + 1].coast && s[i].paints === s[i + 1].paints) {
                  checked++;
                  if (s[i].ty !== s[i + 1].ty) frozenViolations++;
                }
              }
              // (2) the var VALUE changes — the throttle contract: the
              //     inherited --panel-vis-h lands ~2Hz mid-motion, not
              //     per frame. Count distinct value transitions.
              let visChanges = 0;
              for (let i = 1; i < s.length; i++)
                if (s[i].visH !== s[i - 1].visH) visChanges++;
              const counters = (window.DoomProjection.counters || {});
              return {
                breaths: counters.breaths || 0,
                paints: counters.paints || 0,
                deferred: counters.deferred || 0,
                visChanges: visChanges,
                frames: V.frames,
                coastChecked: checked,
                frozenViolations: frozenViolations,
                settled: s.length ? !s[s.length - 1].coast : false
              };
            }""")
            print("  §A/§E ledger:", json.dumps(ares))
            ok(ares["breaths"] >= 2,
               f"THE BREATH: mid-motion re-anchors fired ({ares['breaths']} breaths over two glides)")
            ok(ares["frozenViolations"] == 0 and ares["coastChecked"] > 50,
               f"the coast still freezes BETWEEN breaths ({ares['frozenViolations']} violations in {ares['coastChecked']} checked frames)")
            ok(ares["settled"], "the settle landed un-coasted")
            ok(ares["visChanges"] <= 14 and ares["frames"] >= 200,
               f"THE MEASURED FIX: --panel-vis-h value changes throttled "
               f"({ares['visChanges']} changes vs {ares['frames']} frames; the old code streamed per frame)")
            results["breath"] = ares

        # ══ §B THE HONEST SKY ══════════════════════════════════════════
        if "B" in SECTIONS:
            pg.evaluate("() => { const s = document.getElementById('chat-scrim'); if (s) s.click(); }")
            pg.wait_for_timeout(600)
            pg.evaluate("""() => Settings.setState({
              spaceParallax: 100, dotSizeVariation: 80, lineSizeVariation: 80,
              dotScatter: 80, lineScatter: 80,
              dotAnimate: true, lineAnimate: true
            })""")
            pg.wait_for_timeout(2500)
            dbgAmp = pg.evaluate("() => window.DoomalayDebug || {}")
            one = dbgAmp.get("oneObject") or {}
            glow = dbgAmp.get("glow") or {}
            over = dbgAmp.get("overIcons") or {}
            live = (one.get("live") or {})
            ok(one.get("heroes") == 0,
               f"no hero fireflies mint with the amplifier up (heroes {one.get('heroes')})")
            ok(glow.get("n") == 0,
               f"no glow stars (glow.n {glow.get('n')})")
            ok(over.get("on") == False and over.get("dots", 0) == 0 and over.get("lines", 0) == 0,
               f"nothing renders over icons (on {over.get('on')}, dots {over.get('dots')}, lines {over.get('lines')})")
            ok(live.get("cometGate") == True and (live.get("cometNextIn") or 0) >= 55,
               f"the comet gate opens at scatter 80 with a x10 schedule "
               f"(gate {live.get('cometGate')}, next in {live.get('cometNextIn')}s)")
            ok((dbgAmp.get("dots") or 0) > 0,
               f"the honest population still paints (dots {dbgAmp.get('dots')})")
            # the gate closes at scatter ≤ 40 — poll: the change rides the
            # next posted frame + the re-bake, so allow a settle window
            pg.evaluate("() => Settings.setState({ dotScatter: 30, lineScatter: 30 })")
            gate2 = None
            for _ in range(12):
                pg.wait_for_timeout(500)
                gate2 = ((pg.evaluate("() => window.DoomalayDebug || {}").get("oneObject") or {}).get("live") or {}).get("cometGate")
                if gate2 is False:
                    break
            ok(gate2 == False,
               f"the comet gate closes at scatter 30 (gate {gate2})")
            results["honestSky"] = {"one": one, "glow": glow, "over": over, "live": live,
                                    "gateClosed": gate2}

        # ══ §D THE NATIVE HAND ═════════════════════════════════════════
        if "D" in SECTIONS:
            pg.evaluate("() => Settings.setState({ spaceParallax: 0 })")
            pg.wait_for_timeout(500)
            # dock the panel down a touch (a full-dock panel covers the
            # gear), then the real gear + the Sizing tab — the v106 rig's
            # own navigation
            hd2 = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""")
            cdpD = ctx.new_cdp_session(pg)
            cdpD.send("Input.dispatchTouchEvent",
                      {"type": "touchStart", "touchPoints": [{"x": hd2["x"], "y": hd2["y"]}]})
            for i in range(1, 15):
                cdpD.send("Input.dispatchTouchEvent",
                          {"type": "touchMove", "touchPoints":
                           [{"x": hd2["x"], "y": hd2["y"] + 220 * i / 14}]})
                time.sleep(0.016)
            cdpD.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(700)
            pg.locator("#settings-btn").click()
            pg.wait_for_timeout(1100)
            pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=sizing]'); if (t) t.click(); }")
            pg.wait_for_timeout(900)
            page = pg.evaluate("() => document.querySelectorAll('input.app-range').length")
            dres = pg.evaluate("""() => {
              const el = document.querySelector('input.app-range');
              if (!el) return { found: false };
              const cs = getComputedStyle(el);
              const rootCs = getComputedStyle(document.documentElement);
              return {
                found: true,
                height: cs.height,
                bgImage: cs.backgroundImage,
                appearance: cs.webkitAppearance || cs.appearance,
                accent: cs.accentColor,
                accentVar: rootCs.getPropertyValue('--accent').trim(),
                gradVar: rootCs.getPropertyValue('--accent-gradient').trim().slice(0, 160)
              };
            }""")
            print("  §D slider:", json.dumps(dres))
            ok(dres.get("found") and (page or 0) > 0,
               f"app-ranges are on the Sizing page ({page} found)")
            if dres.get("found"):
                ok(dres["height"] != "10px",
                   f"the custom 10px track is gone (height {dres['height']})")
                ok(dres["bgImage"] == "none",
                   f"no layered field on the slider (background-image {dres['bgImage']})")
                ok(dres["accent"].replace(' ', '').lower()
                   in (dres["accentVar"].replace(' ', '').lower(), "autocolor"),
                   f"accent-color rides --accent ({dres['accent']} vs {dres['accentVar']})")
                import re as _re
                stops = _re.findall(r'rgba?\([^)]*\)|#[0-9a-fA-F]{6}', dres.get("gradVar") or "")
                first_stop = stops[0].strip().lower() if stops else ""

                def rgb_of(c):
                    if c.startswith('#'):
                        return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
                    m = _re.findall(r'\d+', c)
                    return tuple(int(x) for x in m[:3]) if len(m) >= 3 else None

                a_rgb, s_rgb = rgb_of(dres["accentVar"]), rgb_of(first_stop)
                ok(a_rgb and a_rgb == s_rgb,
                   f"--accent IS the gradient's first stop ({dres['accentVar']} vs {first_stop})")
            results["nativeHand"] = dres

        b.close()
finally:
    try:
        proc.terminate()
    except Exception:
        pass

json.dump(results, open(OUT + "-v111.json", "w"), indent=1, default=str)
print(f"\n═══ v111 BREATHING FIELD: {PASS} pass / {FAIL} fail ═══")
sys.exit(1 if FAIL else 0)
