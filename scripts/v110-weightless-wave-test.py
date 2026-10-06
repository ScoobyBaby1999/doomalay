#!/usr/bin/env python3
# v110-weightless-wave-test.py — THE WEIGHTLESS WAVE proof rig (PLAN-V110).
#
# Real-user imitation: boots the engine (real API) + serves the WEB DIR
# FROM DISK on :8099 (the v106/v107/v109 pattern — the prebuilt binary
# embeds an older web tree; the rig must test the files on disk), then
# drives Playwright through the flows a human runs:
#   §A THE DRIFT COAST   — during the anchor glide the root vars FREEZE,
#                          the transcript windows write nothing, mid-glide
#                          paints defer to the settle. (v1.09.1)
#   §B THE FULLSCREEN FIELD — the surface field's scale is dock-independent
#                          (one fullscreen field; no per-dock re-fit; the
#                          no-repeat extent covers every window). (v1.09.2)
#   §C THE STILL HAND    — a pinch/wheel crossing ladder levels recomputes
#                          NOTHING mid-gesture; ONE bake lands at settle.
#                          (v1.09.3)
#   §D THE RARE SKY      — shooting stars: no spawn before ~5.5s, ≤3 in
#                          46s, and the observed shapes span the new
#                          size/distance classes. (v1.09.4)
#
# Usage:
#   python3 scripts/v110-weightless-wave-test.py --web <dir> --out <prefix> [--label S] [--sections ABCD]
#   (engine must NOT already run; port 8078 internal / 8099 served)
import argparse, http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v110test"

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
logf = open("/tmp/doomalay-v110-engine.log", "w")
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

        # ══ §A THE DRIFT COAST (v1.09.1) ═══════════════════════════════
        if "A" in SECTIONS:
            # the fmt slots carry gradients — 2+ colors, the exact user
            # trigger ("low frame rate when the text is set to doom
            # projection with two or more colors")
            pg.evaluate("""() => {
              const s = Settings.getState();
              Settings.setState({ fmtOverrides: Object.assign({}, s.fmtOverrides, {
                a1: { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' },
                bright: { colors: ['#f9d423', '#ffffff'], dir: 'auto' }
              }) });
            }""")
            pg.wait_for_timeout(700)
            seeded = pg.evaluate("""() => {
              const sc = document.querySelector('#chat-scroll');
              if (!sc) return 0;
              const mk = (i) => {
                const d = document.createElement('div');
                d.className = 'fmt';
                d.innerHTML = '<h2>drift probe ' + i + '</h2><p>plain body with <strong>bold glyphs</strong> and an <a href=\\\"#\\">anchor</a> for the field.</p>';
                sc.appendChild(d);
                return 1;
              };
              let n = 0;
              for (let i = 0; i < 60; i++) n += mk(i);
              return n;
            }""")
            pg.wait_for_timeout(1000)
            ok(seeded >= 60, f"fmt transcript seeded ({seeded} blocks)")

            # arm the instruments: a transcript style-mutation counter + a
            # per-rAF sampler (--proj-ty, coast state, paint counter)
            pg.evaluate("""() => new Promise(res => {
              const root = document.getElementById('chat-panel');
              const sc = document.getElementById('chat-scroll');
              const V = window.__v110 = { samples: [], moWrites: 0, frames: 0 };
              const mo = new MutationObserver((muts) => {
                for (const m of muts) {
                  if (m.type !== 'attributes' || m.attributeName !== 'style') continue;
                  const t = m.target;
                  if (sc.contains(t) &&
                      (t.getAttribute('style') || '').indexOf('background-position') !== -1)
                    V.moWrites++;
                }
              });
              mo.observe(sc, { attributes: true, attributeFilter: ['style'], subtree: true });
              V.mo = mo;
              const painted = (window.DoomProjection.counters || {});
              (function sample() {
                const cs = getComputedStyle(root);
                V.samples.push({
                  t: Math.round(performance.now()),
                  ty: cs.getPropertyValue('--proj-ty').trim(),
                  coast: window.DoomProjection.isCoasting ? DoomProjection.isCoasting() : null,
                  paints: (window.DoomProjection.counters || painted).paints,
                  defers: (window.DoomProjection.counters || painted).deferred
                });
                if (++V.frames < 260) V.raf = requestAnimationFrame(sample);
              })();
              res('armed');
            })""")
            paintedN = pg.evaluate("() => (window.DoomProjection.stats() || {}).painted")

            # THE GLIDE — the anchor slide the user reports, driven the way
            # a user drives it: a handle drag past the full dock, released
            # (the settle spring takes over), then back down to default.
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

            # up 30% (> UP_DRAG_FRAC 22%, sub-fling) → full; down 20% (> 10%
            # dock, < 55% close, sub-fling 0.55) → default. Deliberate drags,
            # never flings — the springs glide between the anchors.
            drag(-260)          # up → the spring glides to 'full'
            pg.wait_for_timeout(1500)
            drag(180)           # down → the spring glides to 'default'
            pg.wait_for_timeout(1500)
            ares = pg.evaluate("""() => {
              const V = window.__v110;
              if (V.raf) cancelAnimationFrame(V.raf);
              if (V.mo) V.mo.disconnect();
              const s = V.samples;
              // v1.09.1 proof, flap-tolerant: the coast flag can re-arm via
              // straggler observer batches right after a settle paint, so
              // runs are unreliable. The invariants that MATTER:
              //  (1) across consecutive coast frames with NO paint between,
              //      --proj-ty never moved (the vars froze mid-glide);
              //  (2) the paints only land at settles (≤4 bumps over two
              //      drag+glide cycles; each bump is a re-anchor, not a
              //      mid-glide storm);
              //  (3) the defer held mid-glide marks (stats.deferred).
              let checked = 0, frozenViolations = 0;
              for (let i = 0; i + 1 < s.length; i++) {
                if (s[i].coast && s[i + 1].coast && s[i].paints === s[i + 1].paints) {
                  checked++;
                  if (s[i].ty !== s[i + 1].ty) frozenViolations++;
                }
              }
              const paintBumps = [];
              for (let i = 1; i < s.length; i++)
                if (s[i].paints !== s[i - 1].paints)
                  paintBumps.push({ from: s[i - 1].paints, to: s[i].paints });
              // the settle re-anchor: a text window's position carries the var form again
              let reVar = null;
              const sc = document.getElementById('chat-scroll');
              const el = sc && sc.querySelector('.fmt h2');
              if (el) reVar = (el.style.backgroundPosition || '').indexOf('var(') !== -1;
              const coastFrames = s.filter(x => x.coast === true).length;
              return { coastFrames, checked, frozenViolations,
                       paintBumps, writes: V.moWrites,
                       defers: (window.DoomProjection.counters || {}).deferred || 0,
                       reVar };
            }""")
            results["ledger"]["A"] = ares
            ok(ares["coastFrames"] >= 8,
               f"the glide rode the coast ({ares['coastFrames']} coast frames)")
            ok(ares["checked"] >= 60 and ares["frozenViolations"] == 0,
               f"the root vars FROZE mid-glide ({ares['checked']} frame pairs checked, "
               f"{ares['frozenViolations']} violations)")
            # v1.10.1 THE BREATH updated the contract: the user asked for
            # mid-motion re-anchors ("update like twice a second") — the
            # anchor writes now scale with the breath paints too, and the
            # paint bumps include the breaths (still single-step, no storms).
            ok(ares["writes"] <= max(30, paintedN * 2.5),
               f"the transcript wrote {ares['writes']} anchor writes across TWO glides "
               f"(once-per-edge coasts + the settles + the 2Hz breaths; painted={paintedN})")
            single_step = all(b["to"] == b["from"] + 1 for b in ares["paintBumps"])
            ok(len(ares["paintBumps"]) <= 16 and single_step,
               f"the paints land one at a time, at settles+breaths ({len(ares['paintBumps'])} single-step "
               f"bumps over two drag+glide cycles — no mid-glide storms; the defer held {ares['defers']})")
            ok(ares["defers"] >= 1,
               f"the mid-glide paint defer engaged ({ares['defers']} held)")
            ok(ares["reVar"] is True,
               "the settle re-anchored the text windows (the var form returned)")
            pg.screenshot(path=OUT + "-A-glide.png")

        # ══ §B THE FULLSCREEN FIELD (v1.09.2) ══════════════════════════
        if "B" in SECTIONS:
            pg.wait_for_timeout(400)
            def field_probe():
                return pg.evaluate("""() => {
                  const root = document.getElementById('chat-panel');
                  const body = root.querySelector('.panel-body');
                  const cs = getComputedStyle(root);
                  const bs = getComputedStyle(body);
                  const size = bs.backgroundSize.split(' ');
                  const posy = parseFloat((bs.backgroundPosition.split(' ')[1] || '0')) || 0;
                  const bh = body.getBoundingClientRect().height;
                  return {
                    fieldH: cs.getPropertyValue('--panel-field-h').trim(),
                    sizeY: parseFloat(size[1]) || 0,
                    posY: posy,
                    bodyH: bh,
                    extentBottom: (parseFloat(size[1]) || 0) - posy,
                    covered: ((parseFloat(size[1]) || 0) - posy) >= bh - 0.5
                  };
                }""")
            at_default = field_probe()
            cdpB = ctx.new_cdp_session(pg)
            hdB = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""")
            def dragB(dy_total, steps=16):
                cdpB.send("Input.dispatchTouchEvent",
                          {"type": "touchStart", "touchPoints": [{"x": hdB["x"], "y": hdB["y"]}]})
                for i in range(1, steps + 1):
                    cdpB.send("Input.dispatchTouchEvent",
                              {"type": "touchMove", "touchPoints":
                               [{"x": hdB["x"], "y": hdB["y"] + dy_total * i / steps}]})
                    time.sleep(0.016)
                cdpB.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

            def drag_to(target):
                # instant-ish dock flip: a short deliberate drag toward the
                # anchor (the decision thresholds do the rest), then settle
                cur = pg.evaluate("""() => {
                  const m = getComputedStyle(document.getElementById('chat-panel')).transform;
                  if (!m || m === 'none') return 0;
                  const p = m.match(/matrix.*\\((.+?)\\)/);
                  return p ? (parseFloat(p[1].split(',')[5]) || 0) : 0;
                }""")
                dy = target - cur
                dy = max(-260, min(180, dy))   # stay inside the close fractions
                dragB(dy, steps=10)
                pg.wait_for_timeout(700)

            drag_to(0)          # full dock
            pg.wait_for_timeout(600)
            at_full = field_probe()
            drag_to(304)        # default dock (0.38 × 800)
            pg.wait_for_timeout(600)
            back_default = field_probe()
            results["ledger"]["B"] = {"default": at_default, "full": at_full, "back": back_default}
            ok(at_default["fieldH"] == at_full["fieldH"] == back_default["fieldH"],
               f"the field scale is dock-independent ({at_default['fieldH']} / "
               f"{at_full['fieldH']} / {back_default['fieldH']})")
            ok(at_full["covered"] and at_default["covered"],
               f"the no-repeat extent covers every dock window "
               f"(full: {at_full['extentBottom']:.0f}>={at_full['bodyH']:.0f}, "
               f"default: {at_default['extentBottom']:.0f}>={at_default['bodyH']:.0f})")
            # the header continues the body's field (the v109 §C contract)
            seam = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .panel-header');
              const b = document.querySelector('#chat-panel .panel-body');
              const hs = getComputedStyle(h).backgroundSize.split(' ');
              const hp = getComputedStyle(h).backgroundPosition.split(' ');
              return { headerSizeY: parseFloat(hs[1]) || 0,
                       headerPosY: parseFloat(hp[1]) || 0 };
            }""")
            ok(seam["headerSizeY"] == at_default["sizeY"],
               f"the header windows the SAME field scale ({seam['headerSizeY']} vs {at_default['sizeY']})")
            pg.screenshot(path=OUT + "-B-field.png")

        # ══ §C THE STILL HAND (v1.09.3) ════════════════════════════════
        if "C" in SECTIONS:
            # close the panel — the canvas is the stage now
            pg.evaluate("() => { const s = document.getElementById('chat-scrim'); if (s) s.click(); }")
            pg.wait_for_timeout(800)
            pg.evaluate("""() => {
              // the zoom ladder needs a SEEN level to leave — settle first
              window.__v110c = { samples: [] };
              (function sample() {
                const oo = (window.DoomalayDebug && window.DoomalayDebug.oneObject) || null;
                if (oo) window.__v110c.samples.push({
                  t: Math.round(performance.now()),
                  bakeGen: oo.bakeGen, level: oo.level,
                  misses: oo.ladder ? oo.ladder.misses : null,
                  hold: oo.zoomHold, pending: oo.pending });
                window.__v110c.raf = requestAnimationFrame(sample);
              })();
            }""")
            time.sleep(0.6)
            # the pinch: two fingers spreading 1.0× → ~2.1× (crosses ≥2 levels)
            cdp = ctx.new_cdp_session(pg)
            cx, cy = 210, 400
            cdp.send("Input.dispatchTouchEvent",
                     {"type": "touchStart", "touchPoints": [
                         {"x": cx - 60, "y": cy}, {"x": cx + 60, "y": cy}]})
            for i in range(1, 21):
                d = 60 + 55 * i / 20
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchMove", "touchPoints": [
                             {"x": cx - d, "y": cy}, {"x": cx + d, "y": cy}]})
                time.sleep(0.016)
            mid = pg.evaluate("() => { const s = window.__v110c.samples.filter(x => x.hold === true); return { held: s.length, gens: Array.from(new Set(s.map(x => x.bakeGen))), miss: s.map(x => x.misses) }; }")
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(1200)
            post = pg.evaluate("""() => {
              if (window.__v110c.raf) cancelAnimationFrame(window.__v110c.raf);
              const s = window.__v110c.samples;
              const last = s[s.length - 1] || {};
              const maxGenDuring = Math.max.apply(null, s.filter(x => x.hold === true).map(x => x.bakeGen).concat([0]));
              const finalGen = (window.DoomalayDebug && window.DoomalayDebug.oneObject || {}).bakeGen;
              return { finalGen, maxGenDuring, pending: last.pending, holdNow: last.hold,
                       samples: s.length };
            }""")
            results["ledger"]["C_pinch"] = {"mid": mid, "post": post}
            ok(mid["held"] >= 5 and len(mid["gens"]) <= 1,
               f"the pinch held the ladder (held={mid['held']} frames, bakeGen set={mid['gens']})")
            ok(post["finalGen"] > post["maxGenDuring"],
               f"one bake landed at settle (gen {post['maxGenDuring']} → {post['finalGen']})")

            # the wheel burst (desktop twin)
            pg.evaluate("""() => {
              window.__v110w = { samples: [] };
              (function sample() {
                const oo = (window.DoomalayDebug && window.DoomalayDebug.oneObject) || null;
                if (oo) window.__v110w.samples.push({
                  bakeGen: oo.bakeGen, hold: oo.zoomHold, misses: oo.ladder ? oo.ladder.misses : null });
                window.__v110w.raf = requestAnimationFrame(sample);
              })();
            }""")
            for _ in range(10):
                pg.mouse.wheel(0, -240)
                time.sleep(0.06)
            time.sleep(1.0)
            wres = pg.evaluate("""() => {
              if (window.__v110w.raf) cancelAnimationFrame(window.__v110w.raf);
              const s = window.__v110w.samples;
              const held = s.filter(x => x.hold === true);
              return { held: held.length,
                       gensDuring: Array.from(new Set(held.map(x => x.bakeGen))),
                       finalGen: s.length ? s[s.length - 1].bakeGen : null };
            }""")
            results["ledger"]["C_wheel"] = wres
            ok(wres["held"] >= 3 and len(wres["gensDuring"]) <= 1,
               f"the wheel burst held the ladder (held={wres['held']}, gens={wres['gensDuring']})")
            ok(wres["finalGen"] is not None and (wres["gensDuring"] and wres["finalGen"] >= max(wres["gensDuring"])),
               f"the wheel settle baked once (final gen={wres['finalGen']})")
            pg.screenshot(path=OUT + "-C-zoom.png")

        # ══ §D THE RARE SKY (v1.09.4) ══════════════════════════════════
        if "D" in SECTIONS:
            pg.evaluate("() => Settings.setState({ dotAnimate: true, lineAnimate: true })")
            pg.wait_for_timeout(600)
            obs = pg.evaluate("""() => {
              window.__v110d = { t0: performance.now(), obs: [] };
              window.__v110d.iv = setInterval(() => {
                const oo = (window.DoomalayDebug && window.DoomalayDebug.oneObject) || null;
                if (oo && oo.live) window.__v110d.obs.push({
                  t: Math.round(performance.now() - window.__v110d.t0),
                  spawns: oo.live.spawns, comets: oo.live.comets,
                  last: oo.live.lastComet || null });
              }, 500);
              return 'armed';
            }""")
            # 46s of sky — the new cadence is 18-44s between spawns
            deadline = time.time() + 46
            while time.time() < deadline:
                time.sleep(1)
            dres = pg.evaluate("""() => {
              clearInterval(window.__v110d.iv);
              const o = window.__v110d.obs;
              const first = o.find(x => x.spawns > 0);
              const last = o.length ? o[o.length - 1] : null;
              const classes = Array.from(new Set(o.map(x => x.last ? x.last.cls : null).filter(x => x !== null)));
              const shapes = o.map(x => x.last).filter(Boolean);
              return { firstSpawnAt: first ? first.t : null,
                       totalSpawns: last ? last.spawns : 0,
                       classes, shapes: shapes.slice(-4),
                       samples: o.length };
            }""")
            results["ledger"]["D"] = dres
            ok(dres["firstSpawnAt"] is None or dres["firstSpawnAt"] >= 5000,
               f"the sky starts quiet (first spawn at {dres['firstSpawnAt']}ms; the old cadence fired by 4s)")
            # v1.10.2 updated the contract: the user asked "x10 more rare"
            # (180-440s between spawns) AND a scatter gate ("only when the
            # scatter of dots or grid lines is >0.4"). Zero spawns in a 46s
            # window is now the CORRECT read; the gate + the armed schedule
            # ride the live instrument instead of live class samples.
            ok(dres["totalSpawns"] == 0,
               f"the cadence is x10 rare ({dres['totalSpawns']} spawns in 46s; zero is the new law)")
            gate = pg.evaluate("() => { const oo = (window.DoomalayDebug || {}).oneObject || {}; return (oo.live || {}).cometGate; }")
            ok(gate is False,
               f"the scatter gate holds the sky shut with scatter unset (gate {gate})")
            pg.evaluate("() => Settings.setState({ dotScatter: 80 })")
            gate2 = None
            for _ in range(10):
                pg.wait_for_timeout(500)
                gate2 = pg.evaluate("() => { const oo = (window.DoomalayDebug || {}).oneObject || {}; return (oo.live || {}).cometGate; }")
                if gate2 is True:
                    break
            nxt = pg.evaluate("() => { const oo = (window.DoomalayDebug || {}).oneObject || {}; return (oo.live || {}).cometNextIn; }")
            # the boot schedule arms the FIRST spawn at 60-160s (x10 of the
            # old 6-16s); by §D time part of it has elapsed, so what is left
            # is 0-165s. The 180-440s SUBSEQUENT cadence rides the spawn
            # reset (the v111 rig asserts the armed window at boot).
            ok(gate2 is True and nxt is not None and 0 <= nxt <= 165,
               f"the gate opens at scatter 80 with the boot schedule intact "
               f"(gate {gate2}, first spawn in {nxt}s; the boot window is 60-160s)")
            pg.screenshot(path=OUT + "-D-sky.png")

        pg.screenshot(path=OUT + "-final.png")
        b.close()
except Exception as e:
    print("RIG ERROR:", e)
    FAIL += 1
finally:
    subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)

print(f"\n== v110 rig [{args.label}] sections={''.join(sorted(SECTIONS))}: {PASS} pass / {FAIL} fail ==")
with open(OUT + "-results.json", "w") as f:
    json.dump({"pass": PASS, "fail": FAIL, **results}, f, indent=1)
sys.exit(1 if FAIL else 0)
