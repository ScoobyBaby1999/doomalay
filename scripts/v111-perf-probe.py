#!/usr/bin/env python3
# v111-perf-probe.py — THE PROFILER (PLAN-V111, phase "probe").
#
# The user's report: "doom projection isn't the one that is making the panel
# slow, I think the panel itself gets slower the more custom colors it holds…
# the contents and scrolling inside the canvas is fine, the canvas itself
# feels slow to respond."
#
# This probe MEASURES instead of guessing. Two theme configurations on the
# same flows, real CDP input, real timeline traces:
#   LEAN — the default theme (a handful of colors), projection ON.
#   RICH — many custom colors: 8-stop gradients on the surface + accents 1-3,
#          the shadow/highlight fields, the fmt fields; projection ON.
#
# Windows per configuration:
#   GLIDE — two handle drags (the anchor springs); rAF frame deltas + a CDP
#           devtools.timeline trace (UpdateLayoutTree / Paint / FunctionCall
#           attribution).
#   PAN   — a single-finger canvas drag; per-event pointer→rAF latency.
#   ZOOM  — a wheel burst on the canvas; frame deltas across the burst.
#
# Output: <prefix>-probe.json + a printed comparison table.
#
# Usage: python3 scripts/v111-perf-probe.py --web <dir> --out <prefix>
import argparse, http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v111probe"

ap = argparse.ArgumentParser()
ap.add_argument("--web", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()
WEB = os.path.abspath(args.web)
OUT = os.path.abspath(args.out)
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


shutil = __import__("shutil")
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v111probe-engine.log", "w")
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

from playwright.sync_api import sync_playwright

RICH_OVERRIDES = """() => {
  const s = Settings.getState();
  const overrides = Object.assign({}, s.themeOverrides);
  overrides[s.theme] = Object.assign({}, overrides[s.theme], {
    '--field-surface':    { colors: ['#10101c', '#2a1a4a', '#0e6b6b', '#3b1053', '#7597de', '#1c1c3a', '#0e6b6b', '#2a1a4a'], dir: 'auto' },
    '--field-accent-1':   { colors: ['#e945c3', '#7b2ff7', '#f9d423', '#ff6b6b', '#4ecdc4', '#1a535c', '#f72585', '#7209b7'], dir: 'auto' },
    '--field-accent-2':   { colors: ['#22d3ee', '#0ea5e9', '#7c3aed', '#06b6d4', '#3b82f6', '#8b5cf6', '#6366f1', '#14b8a6'], dir: 'auto' },
    '--field-accent-3':   { colors: ['#f472b6', '#c084fc', '#fb7185', '#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6'], dir: 'auto' },
    '--field-shadow':     { colors: ['#05050c', '#0a0a18', '#05050c', '#0a0a18', '#05050c', '#0a0a18', '#05050c', '#0a0a18'], dir: 'auto' },
    '--field-highlight':  { colors: ['#fdf4ff', '#e0f2fe', '#fdf4ff', '#e0f2fe', '#fdf4ff', '#e0f2fe', '#fdf4ff', '#e0f2fe'], dir: 'auto' }
  });
  Settings.setState({ themeOverrides: overrides });
  const fo = Object.assign({}, s.fmtOverrides, {
    a1:     { colors: ['#e945c3', '#7b2ff7', '#f9d423', '#ff6b6b', '#4ecdc4', '#1a535c', '#f72585', '#7209b7'], dir: 'auto' },
    bright: { colors: ['#f9d423', '#ffffff', '#f9d423', '#ffffff', '#f9d423', '#ffffff', '#f9d423', '#ffffff'], dir: 'auto' }
  });
  Settings.setState({ fmtOverrides: fo });
  return true;
}"""

LEAN_OVERRIDES = """() => {
  Settings.setState({ themeOverrides: {}, fmtOverrides: {} });
  return true;
}"""


def stats_frame_deltas(samples):
    dts = []
    for i in range(1, len(samples)):
        d = samples[i]["t"] - samples[i - 1]["t"]
        if 0 < d < 1000:
            dts.append(d)
    if not dts:
        return {"n": 0}
    dts.sort()
    return {"n": len(dts),
            "median": round(dts[len(dts) // 2], 1),
            "p95": round(dts[int(len(dts) * 0.95)], 1),
            "max": round(dts[-1], 1)}


class Trace:
    """A RAW-WEBSOCKET CDP devtools.timeline capture (playwright filters the
    Tracing domain on its own sessions — the honest timeline needs a second,
    direct connection to the page target)."""

    NAMES = ("UpdateLayoutTree", "Layout", "PrePaint", "Paint", "UpdateLayerTree",
             "FunctionCall", "EventDispatch", "HitTest", "ImageDecodeTask",
             "DecodeImage", "RasterTask", "CompositeLayers", "FireAnimationFrame",
             "RequestAnimationFrame")

    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self.events = []
        self.done = threading.Event()
        self._run = True
        self._t = threading.Thread(target=self._pump, daemon=True)
        self._t.start()
        self._cmd("Tracing.start", {"traceConfig": {
            "recordMode": "recordAsMuchAsPossible",
            "includedCategories": ["devtools.timeline",
                                   "disabled-by-default-devtools.timeline"]}})

    def _send(self, obj):
        self.ws.send(json.dumps(obj))

    def _cmd(self, method, params=None):
        self._send({"id": int(time.time() * 1000) % 1000000,
                    "method": method, "params": params or {}})

    def _pump(self):
        try:
            while self._run:
                msg = json.loads(self.ws.recv())
                if msg.get("method") == "Tracing.dataCollected":
                    self.events.extend(msg["params"].get("value", []))
                elif msg.get("method") == "Tracing.tracingComplete":
                    self.done.set()
        except Exception:
            self.done.set()

    def stop(self):
        try:
            self._cmd("Tracing.end")
        except Exception:
            pass
        self.done.wait(8.0)
        self._run = False
        try:
            self.ws.close()
        except Exception:
            pass
        by = {}
        for e in self.events:
            n = e.get("name", "")
            if n in self.NAMES:
                d = e.get("dur", 0)  # microseconds
                if d <= 0:
                    continue
                b = by.setdefault(n, {"count": 0, "totalMs": 0.0, "maxMs": 0.0})
                b["count"] += 1
                b["totalMs"] += d / 1000.0
                b["maxMs"] = max(b["maxMs"], d / 1000.0)
        for n in by:
            by[n]["totalMs"] = round(by[n]["totalMs"], 1)
            by[n]["maxMs"] = round(by[n]["maxMs"], 1)
        return by


def page_ws_endpoint(port, base):
    """The raw CDP ws URL of the page target serving `base`."""
    import urllib.request
    for _ in range(30):
        try:
            targets = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json", timeout=2))
            for t in targets:
                if t.get("type") == "page" and t.get("url", "").startswith(base) \
                        and t.get("webSocketDebuggerUrl"):
                    return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.3)
    return None


results = {}
try:
    with sync_playwright() as p:
        DBG_PORT = 9333
        b = p.chromium.launch(args=[f"--remote-debugging-port={DBG_PORT}",
                                    "--remote-allow-origins=*"])

        def run_config(label, overrides_js):
            print(f"\n════ {label} ════")
            pg = b.new_context(viewport={"width": 420, "height": 800},
                               device_scale_factor=2, has_touch=True,
                               is_mobile=True).new_page()
            pges = []
            pg.on("pageerror", lambda e: pges.append(str(e)[:120]))
            pg.on("framenavigated",
                  lambda f: pges.append("NAV:" + (f.url or "")[:80]))
            pg.on("crash", lambda p2: pges.append("CRASH"))
            pg.goto(BASE, wait_until="domcontentloaded")
            pg.wait_for_timeout(2600)
            pg.evaluate(overrides_js)
            pg.reload(wait_until="domcontentloaded")
            pg.wait_for_timeout(2600)

            # a chat + a seeded transcript (the projection's real workload)
            pg.evaluate("""() => {
              const strip = document.getElementById('dock-strip');
              const nb = document.getElementById('dock-new');
              if (nb && nb.getAttribute('aria-expanded') !== 'true') nb.click();
              const cb = strip ? strip.querySelector('#dock-new-chat') : null;
              if (cb) cb.click();
            }""")
            pg.wait_for_timeout(1600)
            seeded = pg.evaluate("""() => {
              const sc = document.querySelector('#chat-scroll');
              if (!sc) return 0;
              const mk = (i) => {
                const d = document.createElement('div');
                d.className = 'fmt';
                d.innerHTML = '<h2>probe ' + i + '</h2><p>plain body with <strong>bold glyphs</strong> and an <a href="#">anchor</a> for the field.</p>';
                sc.appendChild(d);
                return 1;
              };
              let n = 0;
              for (let i = 0; i < 60; i++) n += mk(i);
              return n;
            }""")
            pg.evaluate("() => Settings.setState({ doomProjection: true })")
            pg.wait_for_timeout(900)
            dstats = pg.evaluate("() => window.DoomProjection.stats()")
            WS = page_ws_endpoint(DBG_PORT, BASE)
            print(f"  raw CDP ws: {'OK' if WS else 'MISSING'}")

            # ── GLIDE window (traced + JS-sampled) ────────────────────────
            sampler = pg.evaluate("""() => new Promise(res => {
              const V = window.__v111 = { samples: [] };
              (function sample() {
                V.samples.push({ t: Math.round(performance.now() * 10) / 10 });
                if (V.samples.length < 400) V.raf = requestAnimationFrame(sample);
              })();
              res('armed');
            })""")
            cdp = pg.context.new_cdp_session(pg)
            cdp.send("Profiler.enable")
            cdp.send("Profiler.setSamplingInterval", {"interval": 200})
            cdp.send("Profiler.start")
            tr = Trace(WS) if WS else None
            hd = pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""")

            def drag(dy_total, steps=16):
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchStart", "touchPoints": [{"x": hd["x"], "y": hd["y"]}]})
                for i in range(1, steps + 1):
                    cdp.send("Input.dispatchTouchEvent",
                             {"type": "touchMove", "touchPoints":
                              [{"x": hd["x"], "y": hd["y"] + dy_total * i / steps}]})
                    time.sleep(0.016)
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

            drag(-260)
            pg.wait_for_timeout(1400)
            drag(180)
            pg.wait_for_timeout(1400)
            glide_trace = tr.stop() if tr else {}
            prof = cdp.send("Profiler.stop")
            js_by_fn = {}
            for n in prof["profile"]["nodes"]:
                hc = n.get("hitCount", 0)
                if hc <= 0:
                    continue
                cf = n["callFrame"]
                fn = cf.get("functionName") or "(anon)"
                url = (cf.get("url") or "").split("/")[-1] or "(native)"
                key = url + ":" + fn
                js_by_fn[key] = js_by_fn.get(key, 0) + hc
            js_top = dict(sorted(js_by_fn.items(), key=lambda kv: -kv[1])[:12])
            glide = pg.evaluate("""() => {
              const V = window.__v111;
              if (V.raf) cancelAnimationFrame(V.raf);
              return V.samples.map(s => s.t);
            }""")
            dts = [glide[i] - glide[i - 1] for i in range(1, len(glide))
                   if 0 < glide[i] - glide[i - 1] < 1000]
            dts.sort()
            dstats2 = pg.evaluate("() => window.DoomProjection.stats()")

            # ── PAN window (canvas single-finger drag; traced) ─────────
            # close the panel the way a user does (the scrim), then drag
            # the CANVAS with trusted CDP touch. Frame deltas + a trace.
            pg.evaluate("() => { const s = document.getElementById('chat-scrim'); if (s) s.click(); }")
            pg.wait_for_timeout(700)
            pan_arm = pg.evaluate("""() => new Promise(res => {
              const V = window.__v111p = { samples: [], lat: [], evs: 0, last: 0 };
              const onMove = (e) => {
                V.evs++; V.last = performance.now();
                requestAnimationFrame(() => { const d = performance.now() - V.last;
                  V.lat.push(Math.round(d * 10) / 10); });
              };
              window.addEventListener('touchmove', onMove, { passive: true });
              (function sample() {
                V.samples.push({ t: Math.round(performance.now() * 10) / 10 });
                if (V.samples.length < 220) V.raf = requestAnimationFrame(sample);
              })();
              res('armed');
            })""")
            trp = Trace(WS) if WS else None
            pc = pg.evaluate("""() => {
              const c = document.getElementById('c');
              const r = c.getBoundingClientRect();
              // a canvas-certain start point: probe candidates, the first
              // whose elementFromPoint is the canvas itself wins
              const cands = [[0.5, 0.5], [0.3, 0.6], [0.7, 0.4], [0.25, 0.35], [0.75, 0.7]];
              for (const [fx, fy] of cands) {
                const x = r.left + r.width * fx, y = r.top + r.height * fy;
                const el = document.elementFromPoint(x, y);
                if (el && (el.id === 'c' || el.id === 'c2' || el.tagName === 'CANVAS'))
                  return { x, y, el: 'canvas#' + el.id };
              }
              const x = r.left + r.width * 0.5, y = r.top + r.height * 0.85;
              const el = document.elementFromPoint(x, y);
              return { x, y, el: el ? (el.className || el.id || el.tagName) : 'none' };
            }""")
            cdp.send("Input.dispatchTouchEvent",
                     {"type": "touchStart", "touchPoints": [{"x": pc["x"], "y": pc["y"]}]})
            for i in range(1, 49):
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchMove", "touchPoints":
                          [{"x": pc["x"] + i * 6, "y": pc["y"] + i * 2}]})
                time.sleep(0.016)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(700)
            pan_trace = trp.stop() if trp else {}
            pandt = pg.evaluate("""() => {
              const V = window.__v111p;
              if (V.raf) cancelAnimationFrame(V.raf);
              return { ts: V.samples.map(s => s.t), lat: V.lat.slice(),
                       evs: V.evs, el: null };
            }""")
            pts = pandt["ts"]
            pdts = sorted(pts[i] - pts[i - 1] for i in range(1, len(pts))
                          if 0 < pts[i] - pts[i - 1] < 1000)
            plat = sorted(pandt["lat"])

            # ── ZOOM window (wheel burst; traced) ─────────────────────
            tr2 = Trace(WS) if WS else None
            zsamp = pg.evaluate("""() => new Promise(res => {
              const V = window.__v111z = { samples: [] };
              (function sample() {
                V.samples.push({ t: Math.round(performance.now() * 10) / 10 });
                if (V.samples.length < 260) V.raf = requestAnimationFrame(sample);
              })();
              res('armed');
            })""")
            pg.evaluate("""() => {
              const c = document.getElementById('c');
              const r = c.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              let d = 0;
              for (let i = 0; i < 14; i++) {
                d += 120;
                c.dispatchEvent(new WheelEvent('wheel', {
                  deltaX: 0, deltaY: -d, clientX: cx, clientY: cy,
                  bubbles: true, cancelable: true }));
              }
            }""")
            pg.wait_for_timeout(1600)
            zoom_trace = tr2.stop() if tr2 else {}
            zoom = pg.evaluate("""() => {
              const V = window.__v111z;
              if (V.raf) cancelAnimationFrame(V.raf);
              return V.samples.map(s => s.t);
            }""")
            zdts = [zoom[i] - zoom[i - 1] for i in range(1, len(zoom))
                    if 0 < zoom[i] - zoom[i - 1] < 1000]
            zdts.sort()

            def q(arr, f):
                return round(arr[min(len(arr) - 1, int(len(arr) * f))], 1) if arr else None

            results[label] = {
                "doomStats": {k: dstats2.get(k) for k in ("painted", "paints", "deferred", "coasts", "motions")},
                "glideFrames": {"n": len(dts), "median": q(dts, 0.5), "p95": q(dts, 0.95), "max": dts[-1] if dts else None},
                "panFrames": {"n": len(pdts), "median": q(pdts, 0.5), "p95": q(pdts, 0.95), "max": pdts[-1] if pdts else None,
                              "moveEvents": pandt["evs"], "startEl": pc["el"]},
                "panLatencyMs": {"n": len(plat), "median": q(plat, 0.5), "p95": q(plat, 0.95)},
                "zoomFrames": {"n": len(zdts), "median": q(zdts, 0.5), "p95": q(zdts, 0.95), "max": zdts[-1] if zdts else None},
                "glideTrace": glide_trace,
                "glideJS": js_top,
                "panTrace": pan_trace,
                "zoomTrace": zoom_trace,
                "pageErrors": pges,
                "seeded": seeded,
            }
            pg.context.close()

        run_config("LEAN", LEAN_OVERRIDES)
        run_config("RICH", RICH_OVERRIDES)
        b.close()
finally:
    try:
        proc.terminate()
    except Exception:
        pass

json.dump(results, open(OUT + "-probe.json", "w"), indent=1)

print("\n════ COMPARISON ════")
for metric in ("glideFrames", "panFrames", "panLatencyMs", "zoomFrames"):
    print(f"{metric:14s} LEAN {results['LEAN'][metric]}")
    print(f"{'':14s} RICH {results['RICH'][metric]}")
for win in ("glideTrace", "panTrace", "zoomTrace"):
    print(f"--- {win} (top 6 by totalMs) ---")
    for cfg in ("LEAN", "RICH"):
        t = results[cfg][win]
        top = sorted(t.items(), key=lambda kv: -kv[1]["totalMs"])[:6]
        print(f"  {cfg:5s} " + "  ".join(f"{k}:{v['count']}x{v['totalMs']}ms(max {v['maxMs']})" for k, v in top))
print("--- glideJS (sampler hits by file:function) ---")
for cfg in ("LEAN", "RICH"):
    print(f"  {cfg:5s}", json.dumps(results[cfg]["glideJS"])[:500])
print("\nJSON →", OUT + "-probe.json")
