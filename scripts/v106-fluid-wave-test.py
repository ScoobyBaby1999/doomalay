#!/usr/bin/env python3
# v106-fluid-wave-test.py — THE FLUID WAVE proof rig (PLAN-V106 §3).
#
# Real-user imitation: boots the engine (real API) + serves the WEB DIR
# FROM DISK on :8099 (the v301 Forwarder pattern — the prebuilt binary
# embeds an older web tree; the rig must test the files on disk), then
# drives Playwright through the flows a human runs:
#   §3-0 THE FIELD      — a surface gradient spec through the app's own
#                         state machinery (the default theme paints no
#                         gradient fields; the projection needs one).
#   §3-1 THE GLIDE      — a 300-message transcript, CDP touch drags of
#                         the panel handle through both docks + settle
#                         springs; rAF-gap sampling per drag, projection
#                         OFF and ON; PLUS the in-page per-frame write
#                         microbenchmark (root var vs element height —
#                         the decisive instrument, both patterns on the
#                         SAME tree).
#   §3-2 THE TOGGLE     — the Colors-tab switch on/off: the DOM trace
#                         ledger (attr, sheets, bakes, vars, flags).
#   §3-3 THE RESURRECTION — view-stack stash/restore with bakes live;
#                         the sweep must strip on detach + land clean.
#   §3-4 THE WEDGE      — a forced mid-enable throw at an unguarded
#                         point (the doom sheet's appendChild); the
#                         toggle must NOT wedge (rollback + self-heal).
#   §3-5 THE LOOK       — rest-state screenshots + the composer glue
#                         (the window stretch must survive the change).
#
# Usage:
#   python3 scripts/v106-fluid-wave-test.py --web <dir> --out <prefix> [--label S]
#   (engine must NOT already run; port 8078 internal / 8099 served)
import argparse, http.client, http.server, json, os, shutil, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v106test"

ap = argparse.ArgumentParser()
ap.add_argument("--web", required=True, help="web dir to serve (fresh files)")
ap.add_argument("--out", required=True, help="output prefix for screenshots/json")
ap.add_argument("--label", default="run")
ap.add_argument("--skip-perf", action="store_true")
args = ap.parse_args()
WEB = os.path.abspath(args.web)
OUT = os.path.abspath(args.out)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".png": "image/png", ".svg": "image/svg+xml", ".mjs": "text/javascript",
        ".woff2": "font/woff2", ".json": "application/json", ".map": "application/json"}

# ── the forwarder: static from disk, /api proxied to the engine ────────
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
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        conn.request(self.command, self.path, body=data, headers=headers)
        resp = conn.getresponse()
        payload = resp.read()
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in ("connection", "transfer-encoding"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        conn.close()

    def do_GET(self):
        (self._fwd(False) if self.path.startswith("/api") or self.path.startswith("/ws")
         else self._static())

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
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v106-engine.log", "w")
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

results = {"label": args.label, "perf": {}, "checks": []}
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

        # ── open a chat the way a user does: first-run CTA (or an icon) ──
        def open_chat_via_dock():
            # the dock's ＋ → the "new chat panel" sub pill — the real user
            # path that always lands viewport-center (canvas icons drift).
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
        ok(pg.evaluate("() => !!document.querySelector('.chatbot')"), "a chatbot icon exists on the canvas")
        if not pg.evaluate("() => document.querySelector('#chat-panel').classList.contains('open')"):
            open_chat_via_dock()
        ok(pg.evaluate("() => document.querySelector('#chat-panel').classList.contains('open')"),
           "tapping the icon opens the master panel")

        # ── CDP touch helpers: grab the handle WHEREVER it sits and drag ──
        cdp = ctx.new_cdp_session(pg)

        def handle_xy():
            return pg.evaluate("""() => {
              const h = document.querySelector('#chat-panel .handle');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                       open: document.querySelector('#chat-panel').classList.contains('open') };
            }""")

        def drag_rel(dy_total, steps=18, hold=12):
            h = handle_xy()
            if not h["open"]:
                return False
            x, y0 = h["x"], h["y"]
            cdp.send("Input.dispatchTouchEvent",
                     {"type": "touchStart", "touchPoints": [{"x": x, "y": y0}]})
            for i in range(1, steps + 1):
                y = y0 + dy_total * i / steps
                cdp.send("Input.dispatchTouchEvent",
                         {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
                time.sleep(hold / 1000.0)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            return True

        # ── seed a heavy transcript (300 rows, real markup shape) ──
        seeded = pg.evaluate("""() => {
          const sc = document.querySelector('#chat-scroll') || document.querySelector('.panel-body');
          if (!sc) return 0;
          const mk = (i) => {
            const row = document.createElement('div');
            row.className = 'msg-row ' + (i % 2 ? 'msg-row-user' : 'msg-row-assistant');
            const bub = document.createElement('div');
            bub.className = 'msg-bubble ' + (i % 2 ? 'msg-user' : 'msg-assistant');
            bub.textContent = 'v106 seed message ' + i + ' — the quick brown fox jumps over the lazy dog. '.repeat(3);
            const tm = document.createElement('div');
            tm.className = 'msg-time';
            tm.textContent = '00:' + String(i % 60).padStart(2, '0');
            row.appendChild(bub); row.appendChild(tm);
            return row;
          };
          for (let i = 0; i < 300; i++) sc.appendChild(mk(i));
          return sc.querySelectorAll('.msg-row').length;
        }""")
        ok(seeded >= 300, f"transcript seeded ({seeded} rows)")

        # ── §3-0 THE FIELD: gradient specs through the app's own state ──
        # surface + accent-1 — the accent twin turns every .msg-user
        # bubble into a REAL projection window (the v0.57 model), so the
        # glide runs with 150+ live windows and the stash test has a
        # genuine stashed-root window class to exercise.
        field = pg.evaluate("""() => {
          const s = Settings.getState();
          const overrides = Object.assign({}, s.themeOverrides);
          overrides[s.theme] = Object.assign({}, overrides[s.theme], {
            '--field-surface': { colors: ['#10101c', '#2a1a4a', '#0e6b6b'], dir: 'auto' },
            '--field-accent-1': { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' }
          });
          Settings.setState({ themeOverrides: overrides });
          const cs = getComputedStyle(document.documentElement);
          return cs.getPropertyValue('--surface-1-gradient').trim().slice(0, 30) + ' | ' +
                 cs.getPropertyValue('--accent-gradient').trim().slice(0, 30);
        }""")
        pg.wait_for_timeout(600)
        ok('linear' in field or 'radial' in field,
           f"surface + accent fields carry gradients now ('{field[:28]}…')")

        # ── §3-1 THE GLIDE ──
        if not args.skip_perf:
            pg.evaluate("""() => {
              window.__v106 = { gaps: [], last: 0, longtasks: 0, stop: false };
              const loop = (t) => {
                if (window.__v106.last) {
                  const d = t - window.__v106.last;
                  if (d > 1) window.__v106.gaps.push(d);
                }
                window.__v106.last = t;
                if (!window.__v106.stop) requestAnimationFrame(loop);
              };
              requestAnimationFrame(loop);
              try {
                new PerformanceObserver((l) => { window.__v106.longtasks += l.getEntries().length; })
                  .observe({ entryTypes: ['longtask'] });
              } catch (e) {}
            }""")
            cdp2 = cdp   # the session is hoisted above

            def glide_sample(tag):
                pg.evaluate("() => { window.__v106.gaps = []; window.__v106.longtasks = 0; }")
                # a full human flow: up to full, down to default, down close,
                # re-open, up again — each from wherever the sheet sits now.
                for dy in [-300, 280, 520, -900, -300]:
                    if not drag_rel(dy):
                        open_chat_via_dock()
                        pg.wait_for_timeout(700)
                        drag_rel(dy)
                    time.sleep(0.65)   # the settle spring rides the sampler
                m = pg.evaluate("""() => {
                  const g = window.__v106.gaps.slice();
                  g.sort((a, b) => a - b);
                  const med = g.length ? g[Math.floor(g.length / 2)] : 0;
                  const p95 = g.length ? g[Math.floor(g.length * 0.95)] : 0;
                  const dropped = g.filter(x => x > 32).length;
                  return { frames: g.length, med, p95, dropped, longtasks: window.__v106.longtasks };
                }""")
                results["perf"][tag] = m
                print(f"  GLIDE[{args.label}:{tag}] med={m['med']:.1f}ms p95={m['p95']:.1f}ms "
                      f"dropped={m['dropped']}/{m['frames']} longtasks={m['longtasks']}")

            glide_sample("proj-off")
            # projection ON mid-glide (the painter's motion path joins)
            pg.evaluate("() => Settings.setState({ doomProjection: true })")
            pg.wait_for_timeout(700)
            glide_sample("proj-on")
            pg.evaluate("() => Settings.setState({ doomProjection: false })")
            pg.wait_for_timeout(500)

            # THE DECISIVE INSTRUMENT — both write patterns, same tree,
            # same flush pressure: the per-frame main-thread cost.
            bench = pg.evaluate("""() => {
              const panel = document.querySelector('#chat-panel');
              const body = panel.querySelector('.panel-body');
              const round = (fn) => {
                const t0 = performance.now();
                for (let i = 0; i < 90; i++) {
                  fn(i);
                  void panel.offsetHeight;   // the flush the next frame would pay
                }
                return (performance.now() - t0) / 90;
              };
              const varMs = round((i) => panel.style.setProperty('--panel-vis-h', (400 + (i % 30)) + 'px'));
              const hMs = round((i) => { body.style.height = (400 + (i % 30)) + 'px'; });
              panel.style.removeProperty('--panel-vis-h');
              body.style.height = '';
              return { varWriteMs: +varMs.toFixed(3), heightWriteMs: +hMs.toFixed(3) };
            }""")
            results["perf"]["write-bench"] = bench
            print(f"  BENCH[{args.label}] var-write={bench['varWriteMs']}ms  height-write={bench['heightWriteMs']}ms"
                  f"  ({bench['varWriteMs'] / max(bench['heightWriteMs'], 0.001):.1f}x)")

        # the glue must hold at a rest dock after all that motion —
        # close (a long deliberate drag) then re-open via the dock pill:
        # the reopen always lands at the remembered 'default' dock.
        if handle_xy()["open"]:
            drag_rel(600)
            pg.wait_for_timeout(900)
        open_chat_via_dock()
        pg.wait_for_timeout(900)
        glue2 = pg.evaluate("""() => {
          const b = document.querySelector('#chat-panel .panel-body');
          const r = b.getBoundingClientRect();
          const ih = innerHeight;
          return { gap: ih - r.bottom, open: document.querySelector('#chat-panel').classList.contains('open') };
        }""")
        if glue2["open"]:
            ok(abs(glue2["gap"]) < 3, f"window still glued after the drags (gap {glue2['gap']:.1f}px)")

        # ── §3-2 THE TOGGLE (the real switch, on the settings page) ──
        # dock the panel down first (a full-dock panel covers the gear —
        # the user drags it down a touch; a 220px slow drag docks default)
        drag_rel(220)
        pg.wait_for_timeout(700)
        pg.locator("#settings-btn").click()
        pg.wait_for_timeout(1100)
        pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\\'appearance\\']'); if (t) t.click(); }")
        pg.wait_for_timeout(700)
        opened = pg.evaluate("""() => {
          const hs = Array.from(document.querySelectorAll('.settings-section h3'));
          const f = hs.find(h => /fields/i.test(h.textContent));
          if (f) f.click();
          return !!f;
        }""")
        pg.wait_for_timeout(500)
        ok(opened, "the Fields section expanded")
        sw = pg.locator('input[data-setting-key="doomProjection"]')
        ok(sw.count() == 1, "the doom projection switch is rendered")

        def set_switch(v):
            pg.evaluate("""(v) => {
              const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
              if (el.checked !== v) {
                el.checked = v;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }""", v)
            pg.wait_for_timeout(650)

        set_switch(True)
        on_state = pg.evaluate("""() => ({
          attr: document.documentElement.getAttribute('data-doom-proj'),
          on: window.DoomProjection && window.DoomProjection.stats().on,
          sheet: !!document.getElementById('doom-proj-override'),
          root: !!document.querySelector('#chat-panel[data-proj-root]'),
          visVar: document.querySelector('#chat-panel').style.getPropertyValue('--panel-vis-h')
        })""")
        ok(on_state["attr"] == "on" and on_state["on"] is True, "projection ON: module state + attr")
        ok(on_state["sheet"] and on_state["root"], "projection ON: the sheet minted + the root tracked")
        ok(on_state["visVar"] != "", f"projection ON: the vis var seeded ({on_state['visVar']})")

        # back to the chat the way a user does — the dock's new-chat pill
        # (always viewport-center; the settings page replaced the root)
        open_chat_via_dock()
        chat_on = pg.evaluate("""() => ({
          painted: window.DoomProjection.stats().painted,
          windows: document.querySelectorAll('#chat-panel [data-proj]').length,
          bakes: document.querySelectorAll('[data-proj-bake]').length
        })""")
        ok(chat_on["painted"] > 0 and (chat_on["windows"] + chat_on["bakes"]) > 0,
           f"projection ON: real windows baked on the chat (painted {chat_on['painted']}, "
           f"L2 {chat_on['windows']}, legacy {chat_on['bakes']})")

        pg.screenshot(path=OUT + "-proj-on.png")

        # ── §3-3 THE RESURRECTION (view-stack stash/restore, chat live) ──
        res = pg.evaluate("""async () => {
          const panel = window.Settings.panelOf();
          if (!panel) return { err: 'no panelRef' };
          const waitFrame = () => new Promise(r =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))));
          // plant a REAL projection window inside the stashed root — a
          // genuine .msg-user bubble (the accent-twin stylesheet rule is
          // exactly the class the chat bakes in production)
          const w = document.createElement('div');
          w.className = 'msg-user v106-resurrect-window';
          w.textContent = 'v106 window';
          w.style.maxWidth = '86%';
          (document.querySelector('#chat-scroll') || document.querySelector('.panel-body')).appendChild(w);
          await waitFrame();   // the observer marks; the bake lands
          const carried = () => !!(w.getAttribute('data-proj') || w.getAttribute('data-proj-bake'));
          const pre = carried();
          panel.pushView({ title: 'v106', render: function () { return '<div class=placeholder>v106 stash test</div>'; } });
          await waitFrame();   // stashed (detached): the painter strips on the next paint
          const stashed = carried();
          panel.popView();
          await waitFrame();   // re-attached: the next paint re-bakes
          const restored = carried();
          const alive = !!document.querySelector('.v106-resurrect-window');
          return { pre, stashed, restored, alive };
        }""")
        if "err" in res:
            ok(False, "resurrection: view stack reachable")
        else:
            ok(res["alive"] and res["pre"],
               "resurrection: a window lives inside the stashed root and carries a bake")
            ok(not res["stashed"],
               "resurrection: the stash STRIPS the bake (detached = stripped)")
            ok(res["restored"],
               "resurrection: the restore re-bakes the window")

        # OFF with the chat live — the sweep must clean the mounted windows
        pg.evaluate("() => Settings.setState({ doomProjection: false })")
        pg.wait_for_timeout(500)
        off_state = pg.evaluate("""() => ({
          attr: document.documentElement.getAttribute('data-doom-proj'),
          on: window.DoomProjection.stats().on,
          sheet: !!document.getElementById('doom-proj-override'),
          layers: document.querySelectorAll('#chat-panel [data-proj]').length,
          bakesAll: document.querySelectorAll('[data-proj-bake]').length,
          varLeft: document.querySelector('#chat-panel').style.getPropertyValue('--panel-vis-h'),
          posLeft: Array.from(document.querySelectorAll('#chat-panel [style*=\"background-position\"]')).length
        })""")
        ok(off_state["attr"] is None and off_state["on"] is False, "projection OFF: module state + attr")
        ok(off_state["layers"] == 0 and off_state["bakesAll"] == 0,
           "projection OFF: zero bakes remain anywhere (orphan sweep holds)")
        ok(not off_state["sheet"] and off_state["varLeft"] == "",
           "projection OFF: sheet detached + var cleared")
        ok(off_state["posLeft"] == 0, "projection OFF: zero inline background-positions in the panel")

        pg.screenshot(path=OUT + "-proj-off.png")

        # ── §3-4 THE WEDGE (a forced throw at the doom sheet's appendChild) ──
        wedge = pg.evaluate("""() => {
          const out = {};
          const ap = Node.prototype.appendChild;
          Node.prototype.appendChild = function (n) {
            if (n && n.id === 'doom-proj-override') throw new Error('v106 forced throw');
            return ap.call(this, n);
          };
          try { Settings.setState({ doomProjection: true }); } catch (e) {}
          Node.prototype.appendChild = ap;
          out.afterThrow = {
            on: window.DoomProjection.stats().on,
            attr: document.documentElement.getAttribute('data-doom-proj'),
            sheet: !!document.getElementById('doom-proj-override'),
            layers: document.querySelectorAll('[data-proj]').length,
            bakes: document.querySelectorAll('[data-proj-bake]').length
          };
          // the user taps OFF afterwards — must not wedge
          Settings.setState({ doomProjection: false });
          out.afterOff = {
            on: window.DoomProjection.stats().on,
            attr: document.documentElement.getAttribute('data-doom-proj'),
            layers: document.querySelectorAll('[data-proj]').length,
            bakes: document.querySelectorAll('[data-proj-bake]').length
          };
          return out;
        }""")
        at = wedge["afterThrow"]; af = wedge["afterOff"]
        ok(at["on"] is False and at["attr"] is None,
           "wedge test: the thrown enable rolled back (module OFF, no attr)")
        ok(at["layers"] == 0 and at["bakes"] == 0 and not at["sheet"],
           "wedge test: zero residue after the rollback")
        ok(af["on"] is False and af["attr"] is None and af["layers"] == 0,
           "wedge test: the OFF tap still works — no stuck switch")

        # ── §3-5 THE LOOK at rest, both states ──
        pg.evaluate("() => Settings.setState({ doomProjection: true })")
        pg.wait_for_timeout(500)
        pg.screenshot(path=OUT + "-rest-on.png")
        pg.evaluate("() => Settings.setState({ doomProjection: false })")
        pg.wait_for_timeout(400)
        pg.screenshot(path=OUT + "-rest-off.png")

        b.close()
finally:
    proc.kill()
    srv.shutdown()
    with open(OUT + "-results.json", "w") as f:
        json.dump(results, f, indent=2)

print(f"\n== [{args.label}] {PASS} passed, {FAIL} failed ==")
sys.exit(1 if FAIL else 0)
