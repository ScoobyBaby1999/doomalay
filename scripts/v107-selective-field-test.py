#!/usr/bin/env python3
# v107-selective-field-test.py — THE SELECTIVE FIELD proof rig (PLAN-V107).
#
# Real-user imitation: boots the engine (real API) + serves the WEB DIR
# FROM DISK on :8099 (the v106 pattern — the prebuilt binary embeds an
# older web tree; the rig must test the files on disk), then drives
# Playwright through the flows a human runs:
#   §A THE EXEMPTION   — projection ON with live fields: the surface renders
#                        LOCAL (no bake, no fixed), the accents still window.
#                        (v1.06.1)
#   §B THE TEXT FIELD  — the fmt track joins the projection: the Blink probe
#                        (fixed + background-clip:text), an in-panel fmt h2
#                        carrying the inline bake with its clip preserved.
#                        (v1.06.2)
#   §C THE CHROME      — C1: the chat metadata pills project (the white-pill
#                        report — state ledger + screenshots); C2: the doom
#                        projection pill flips visually in-place (no reopen);
#                        C3: sliders / switch tracks / tiny pills window the
#                        surface field LOCALLY under the projection gate and
#                        stay painter-free. (v1.06.3)
#   §D THE SHADOW & THE HIGHLIGHT — the two derived colors become editable
#                        theme slots with CSS≡JS triplet parity + resets.
#                        (v1.06.4)
#
# Usage:
#   python3 scripts/v107-selective-field-test.py --web <dir> --out <prefix> [--label S]
#   (engine must NOT already run; port 8078 internal / 8099 served)
import argparse, http.client, http.server, json, os, subprocess, sys, threading, time, urllib.request

BASE = "http://127.0.0.1:8099"
ENG_PORT = 8078
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine", "bin", "doomalay-engine")
DATA = "/tmp/doomalay-v107test"

ap = argparse.ArgumentParser()
ap.add_argument("--web", required=True, help="web dir to serve (fresh files)")
ap.add_argument("--out", required=True, help="output prefix for screenshots/json")
ap.add_argument("--label", default="run")
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
shutil_ret = None
import shutil
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-engine"], capture_output=True)
time.sleep(0.5)
logf = open("/tmp/doomalay-v107-engine.log", "w")
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

        # ── seed a real transcript (the .msg-user bubbles are the accent
        # windows the v0.57 model promises; §B's .fmt probe needs a home) ──
        seeded = pg.evaluate("""() => {
          const sc = document.querySelector('#chat-scroll') || document.querySelector('.panel-body');
          if (!sc) return 0;
          const mk = (i) => {
            const row = document.createElement('div');
            row.className = 'msg-row ' + (i % 2 ? 'msg-row-user' : 'msg-row-assistant');
            const bub = document.createElement('div');
            bub.className = 'msg-bubble ' + (i % 2 ? 'msg-user' : 'msg-assistant');
            bub.textContent = 'v107 seed ' + i + ' — the quick brown fox jumps over the lazy dog. ';
            row.appendChild(bub);
            return row;
          };
          for (let i = 0; i < 40; i++) sc.appendChild(mk(i));
          return sc.querySelectorAll('.msg-row').length;
        }""")
        pg.wait_for_timeout(700)
        ok(seeded >= 40, f"transcript seeded ({seeded} rows)")

        # ── the fields: surface + accent-1 + accent-2 gradients (the app's
        # own state machinery) — the projection needs live gradient fields ──
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

        # ── §A THE EXEMPTION (v1.06.1) ─────────────────────────────────
        pg.evaluate("() => Settings.setState({ doomProjection: true })")
        pg.wait_for_timeout(900)

        a = pg.evaluate("""() => {
          const body = document.querySelector('#chat-panel .panel-body');
          const csB = getComputedStyle(body);
          const bake = body.getAttribute('data-proj-bake');
          const layer = body.hasAttribute('data-proj');
          // an accent window: a real .msg-user bubble (the v0.57 model —
          // every user bubble windows the accent field).
          const acc = document.querySelector('.msg-user');
          const accCS = acc ? getComputedStyle(acc) : null;
          return {
            bodyImage: csB.backgroundImage.slice(0, 60),
            bodyAtt: csB.backgroundAttachment,
            bodyBake: bake, bodyLayer: layer,
            accFound: !!acc,
            accAtt: accCS ? accCS.backgroundAttachment : null,
            accBaked: acc ? (acc.hasAttribute('data-proj-bake') || acc.hasAttribute('data-proj')) : null,
            stats: window.DoomProjection.stats()
          };
        }""")
        results["ledger"]["A"] = a
        ok(a["bodyImage"] == "none" or "gradient" in a["bodyImage"],
           "the panel body keeps its surface gradient (exempt ≠ stripped)")
        ok(a["bodyAtt"] != "fixed" and not a["bodyBake"] and not a["bodyLayer"],
           f"THE EXEMPTION: the panel body is local (att={a['bodyAtt']}, bake={a['bodyBake']}, layer={a['bodyLayer']})")
        ok(a["accFound"] and (a["accAtt"] == "fixed" or a["accBaked"]),
           f"the accents still window (att={a['accAtt']}, baked={a['accBaked']})")
        ok(a["stats"]["on"] and a["stats"]["painted"] > 0,
           f"the painter lives with a sane population ({a['stats']})")
        pg.screenshot(path=OUT + "-A-exemption.png")

        # ── §B THE TEXT FIELD (v1.06.2) ────────────────────────────────
        # a fmt slot gradient + real .fmt markup in the transcript, then:
        # the Blink probe (outside the panel root) + the in-panel bake.
        pg.evaluate("""() => {
          const s = Settings.getState();
          Settings.setState({ fmtOverrides: Object.assign({}, s.fmtOverrides, {
            a1: { colors: ['#e945c3', '#7b2ff7', '#f9d423'], dir: 'auto' },
            bright: { colors: ['#f9d423', '#ffffff'], dir: 'auto' }
          }) });
        }""")
        pg.wait_for_timeout(500)
        injected = pg.evaluate("""() => {
          const sc = document.querySelector('#chat-scroll');
          if (!sc) return 0;
          const d = document.createElement('div');
          d.className = 'fmt';
          d.innerHTML = '<h2>the v107 text probe</h2><p>plain <strong>bold text</strong> and an <a href=\\"#\\">in-pane link</a></p>';
          sc.appendChild(d);
          return 1;
        }""")
        pg.wait_for_timeout(700)
        blink = pg.evaluate("""() => {
          // THE BLINK PROBE — a .fmt h2 OUTSIDE any transformed root:
          // the DOOM SHEET's fixed mint + the clip must coexist.
          const probe = document.createElement('div');
          probe.className = 'fmt';
          probe.innerHTML = '<h2>outside probe</h2>';
          document.body.appendChild(probe);
          const h = probe.querySelector('h2');
          const cs = getComputedStyle(h);
          const out = { att: cs.backgroundAttachment, clip: cs.webkitBackgroundClip || cs.backgroundClip,
            img: cs.backgroundImage.slice(0, 40), color: cs.color };
          probe.remove();
          return out;
        }""")
        inner = pg.evaluate("""() => {
          const h = document.querySelector('#chat-scroll .fmt h2');
          if (!h) return null;
          const cs = getComputedStyle(h);
          return { pos: h.style.backgroundPosition || '', att: cs.backgroundAttachment,
            clip: cs.webkitBackgroundClip || cs.backgroundClip,
            baked: h.hasAttribute('data-proj-bake') || h.hasAttribute('data-proj') };
        }""")
        results["ledger"]["B"] = {"blink": blink, "inner": inner}
        ok(blink["att"] == "fixed" and "text" in (blink["clip"] or ""),
           f"BLINK PROBE: fixed + clip:text coexist outside roots (att={blink['att']}, clip={blink['clip']})")
        ok(inner and inner["baked"] and "text" in (inner["clip"] or ""),
           f"the in-panel fmt h2 rides the painter bake with its clip (baked={inner and inner['baked']}, clip={inner and inner['clip']})")
        pg.screenshot(path=OUT + "-B-textfield.png")

        # ── §C1 THE WHITE PILL (v1.06.3 — the ledger + the strict proxy) ──
        # open the chat header dropdown the way a user does (the chevron)
        open_chat_via_dock()
        pg.evaluate("""() => {
          const ch = document.getElementById('header-chevron');
          if (ch) ch.click();
        }""")
        pg.wait_for_timeout(900)
        pills = pg.evaluate("""() => {
          const row = document.getElementById('pill-row');
          if (!row) return [];
          return Array.from(row.querySelectorAll('button')).map((el) => {
            const cs = getComputedStyle(el);
            const layer = el.hasAttribute('data-proj');
            // the LAYER path: the base is suppressed BY DESIGN (transparent
            // + none) and the ::before layer paints the tint + gradient —
            // read the layer's live declarations, not the base's.
            let limg = '', lcolor = '';
            if (layer && el.__projL2 && el.__projL2.br) {
              limg = (el.__projL2.br.style.backgroundImage || '').slice(0, 44);
              lcolor = el.__projL2.br.style.backgroundColor || '';
            }
            return { id: el.id, img: cs.backgroundImage.slice(0, 44),
              color: cs.backgroundColor, att: cs.backgroundAttachment,
              ink: cs.color, bake: el.getAttribute('data-proj-bake'),
              layer, limg, lcolor,
              ownTint: (function (s) {
                // cssText serializes with a space — the catchers match
                // both spellings; so does this probe. While a pill RIDES
                // its layer the suppression legitimately holds the
                // property — the author's values must then be SAVED.
                return s.indexOf('background-color:rgba(var(') !== -1 ||
                       s.indexOf('background-color: rgba(var(') !== -1 ||
                       !!(el.__projAuthorBg && el.__projAuthorBg.color);
              })(el.getAttribute('style') || '') };
          });
        }""")
        results["ledger"]["C1"] = pills
        ok(len(pills) >= 3, f"the metadata pills are in the DOM ({len(pills)})")
        # the white-pill signature: the UA buttonface gray (rgb(239,239,239))
        # or a flat transparent fill — the strip killed the pill's own tint
        # + gradient twin and the catchers lost their [style*=] match.
        # Layered pills are healthy when the LAYER carries the gradient;
        # unlayered ones when their own computed image/color does. The
        # ownership invariant: every pill keeps its OWN inline tint.
        white = []
        for q in pills:
            if q["layer"]:
                if "gradient" not in q["limg"]:
                    white.append(q["id"] + " [layer-no-image]")
            elif (q["color"] in ("rgb(239, 239, 239)", "rgba(0, 0, 0, 0)") or
                    ("gradient" not in q["img"])):
                white.append(q["id"] + " [flat]")
        stripped = [q["id"] for q in pills if not q["ownTint"]]
        ok(not white, f"no pill paints flat/white under projection (flat: {white})")
        ok(not stripped, f"THE OWNERSHIP LAW: every riding pill has its tint live or SAVED (stripped: {stripped})")
        # THE RESTORE PROOF — the same elements, no re-render: toggle the
        # projection OFF (the teardown's drops) and the pills' OWN inline
        # tint must come BACK (restoreAuthorBg), then ON again below.
        pg.evaluate("() => Settings.setState({ doomProjection: false })")
        pg.wait_for_timeout(700)
        rback = pg.evaluate("""() => {
          const row = document.getElementById('pill-row');
          if (!row) return [];
          return Array.from(row.querySelectorAll('button')).map((el) => {
            const s = el.getAttribute('style') || '';
            return { id: el.id,
              tint: s.indexOf('background-color:rgba(var(') !== -1 ||
                    s.indexOf('background-color: rgba(var(') !== -1,
              layer: el.hasAttribute('data-proj') };
          });
        }""")
        lost = [q["id"] for q in rback if not q["tint"] or q["layer"]]
        ok(not lost, f"THE RESTORE PROOF: the pills' own tint came back after the toggle-off (lost: {lost})")
        pg.evaluate("() => Settings.setState({ doomProjection: true })")
        pg.wait_for_timeout(600)
        pg.screenshot(path=OUT + "-C1-pills.png")

        # ── §C2 THE LIVE SWITCH (v1.06.3) ──────────────────────────────
        pg.locator("#settings-btn").click()
        pg.wait_for_timeout(1100)
        pg.evaluate("() => { const t = document.querySelector('.settings-nav .tab[data-page=\\'appearance\\']'); if (t) t.click(); }")
        pg.wait_for_timeout(700)
        pg.evaluate("""() => {
          const hs = Array.from(document.querySelectorAll('.settings-section h3'));
          const f = hs.find(h => /fields/i.test(h.textContent));
          if (f && !f.parentElement.classList.contains('expanded')) f.click();
        }""")
        pg.wait_for_timeout(500)
        switch_vis = pg.evaluate("""() => {
          const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
          if (!el) return null;
          const track = el.parentElement.querySelector('.app-switch-track');
          const thumb = el.parentElement.querySelector('.app-switch-thumb');
          return { trackBg: track ? track.style.background : '', thumbLeft: thumb ? thumb.style.left : '',
                   checked: el.checked };
        }""")
        # tap the switch OFF (projection was ON since §A) — the visuals must
        # follow IN PLACE, no close/reopen
        pg.evaluate("""() => {
          const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
          el.checked = false;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        pg.wait_for_timeout(650)
        after_off = pg.evaluate("""() => {
          const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
          const track = el.parentElement.querySelector('.app-switch-track');
          const thumb = el.parentElement.querySelector('.app-switch-thumb');
          return { trackBg: track ? track.style.background : '', thumbLeft: thumb ? thumb.style.left : '',
                   checked: el.checked, projOn: window.DoomProjection.stats().on };
        }""")
        pg.evaluate("""() => {
          const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        pg.wait_for_timeout(650)
        after_on = pg.evaluate("""() => {
          const el = document.querySelector('input[data-setting-key=\"doomProjection\"]');
          const track = el.parentElement.querySelector('.app-switch-track');
          const thumb = el.parentElement.querySelector('.app-switch-thumb');
          return { trackBg: track ? track.style.background : '', thumbLeft: thumb ? thumb.style.left : '',
                   checked: el.checked, projOn: window.DoomProjection.stats().on };
        }""")
        results["ledger"]["C2"] = {"before": switch_vis, "off": after_off, "on": after_on}
        ok(after_off["checked"] is False and after_off["projOn"] is False,
           "the module follows the OFF tap")
        ok(after_off["thumbLeft"] == "2px" and "surface-3" in after_off["trackBg"],
           f"THE LIVE SWITCH: the pill flips OFF in place (thumb={after_off['thumbLeft']}, track={after_off['trackBg'][:24]})")
        ok(after_on["checked"] is True and after_on["projOn"] is True and after_on["thumbLeft"] == "20px",
           f"and flips ON again in place (thumb={after_on['thumbLeft']})")

        # ── §C3 THE CHROME FOLLOW (v1.06.3) ────────────────────────────
        chrome = pg.evaluate("""() => {
          const r = document.querySelector('.app-range, input[type=range]');
          const sw = document.querySelector('.app-switch-track');
          const inp = document.querySelector('input[type=text].app-search, input[type=text]');
          const g = (el) => el ? getComputedStyle(el).backgroundImage.slice(0, 40) : null;
          const bake = (el) => el ? (el.hasAttribute('data-proj-bake') || el.hasAttribute('data-proj')) : null;
          const att = (el) => el ? getComputedStyle(el).backgroundAttachment : null;
          return { range: g(r), rangeBake: bake(r), rangeAtt: att(r),
                   track: g(sw), trackBake: bake(sw),
                   input: g(inp), inputBake: bake(inp) };
        }""")
        results["ledger"]["C3"] = chrome
        # the rules reference var(--surface-1-gradient) — solid slots resolve
        # it; assert the RULE exists (gate-scoped) + no painter involvement.
        rule_hit = pg.evaluate("""() => {
          const want = /data-doom-proj[^{]*\\.(app-range|hub-libpill|hub-searchico|hi-fab)/;
          for (const sh of document.styleSheets) {
            let rules; try { rules = sh.cssRules; } catch (e) { continue; }
            for (const r of rules) {
              if (r.selectorText && want.test(r.selectorText) &&
                  /surface-1-gradient/.test(r.style.backgroundImage || '')) return true;
            }
          }
          return false;
        }""")
        ok(rule_hit, "the chrome-follow rule family is minted (gate-scoped, surface field)")
        ok(not chrome["rangeBake"] and chrome["rangeAtt"] != "fixed",
           f"the chrome stays painter-free (bake={chrome['rangeBake']}, att={chrome['rangeAtt']})")
        pg.screenshot(path=OUT + "-C3-chrome.png")

        # ── §D THE SHADOW & THE HIGHLIGHT (v1.06.4) ────────────────────
        d = pg.evaluate("""() => {
          const s = Settings.getState();
          const ov = Object.assign({}, s.themeOverrides);
          ov[s.theme] = Object.assign({}, ov[s.theme], {
            '--field-shadow': { colors: ['#3b1f5e'], dir: 'auto' },
            '--field-highlight': { colors: ['#ffe9a8'], dir: 'auto' }
          });
          Settings.setState({ themeOverrides: ov });
          const cs = getComputedStyle(document.documentElement);
          return { ink: cs.getPropertyValue('--shadow-ink-rgb').trim(),
                   hl: cs.getPropertyValue('--highlight-inset-rgb').trim() };
        }""")
        pg.wait_for_timeout(500)
        d_reset = pg.evaluate("""() => {
          const s = Settings.getState();
          const ov = Object.assign({}, s.themeOverrides);
          delete ov[s.theme]['--field-shadow'];
          delete ov[s.theme]['--field-highlight'];
          Settings.setState({ themeOverrides: ov });
          const cs = getComputedStyle(document.documentElement);
          return { ink: cs.getPropertyValue('--shadow-ink-rgb').trim(),
                   hl: cs.getPropertyValue('--highlight-inset-rgb').trim() };
        }""")
        pg.wait_for_timeout(500)
        results["ledger"]["D"] = {"set": d, "reset": d_reset}
        # THE EXPOSURE — the user's literal ask: the two rows must exist
        # in the settings screen's Fields section (we're still on the
        # appearance page after §C2).
        rows_d = pg.evaluate("""() => {
          const names = Array.from(document.querySelectorAll('.slot-row-name'))
            .map((n) => (n.textContent || '').trim());
          return { shadow: names.some((t) => /shadow/i.test(t)),
                   highlight: names.some((t) => /highlight/i.test(t)),
                   count: names.length };
        }""")
        ok(rows_d["shadow"] and rows_d["highlight"],
           f"THE EXPOSURE: Shadow + Highlight rows render in the Fields section "
           f"(shadow={rows_d['shadow']}, highlight={rows_d['highlight']}, rows={rows_d['count']})")
        ok(d["ink"] != "" and d["ink"] != d_reset["ink"],
           f"THE SHADOW: the override lands on the triplet ({d['ink']} → reset {d_reset['ink']})")
        ok(d["hl"] != "" and d["hl"] != d_reset["hl"],
           f"THE HIGHLIGHT: the override lands on the triplet ({d['hl']} → reset {d_reset['hl']})")

        # ── leave clean + THE RESTORE PROOF — toggle off, re-read the
        # pills: the teardown's drops must hand the pills their OWN tint
        # back (restoreAuthorBg), byte-equal to the builder's spelling ──
        open_chat_via_dock()
        pg.evaluate("() => Settings.setState({ doomProjection: false })")
        pg.wait_for_timeout(700)
        open_chat_via_dock()
        pg.evaluate("() => { const ch = document.getElementById('header-chevron'); if (ch) ch.click(); }")
        pg.wait_for_timeout(700)
        restored = pg.evaluate("""() => {
          const row = document.getElementById('pill-row');
          if (!row) return [];
          return Array.from(row.querySelectorAll('button')).map((el) => {
            const s = el.getAttribute('style') || '';
            return { id: el.id,
              tint: s.indexOf('background-color:rgba(var(') !== -1 ||
                    s.indexOf('background-color: rgba(var(') !== -1 };
          });
        }""")
        lost = [q["id"] for q in restored if not q["tint"]]
        ok(not lost, f"THE RESTORE PROOF: the pills' own tint survived a full toggle cycle (lost: {lost})")
        pg.evaluate("() => Settings.setState({ doomProjection: false })")
        pg.wait_for_timeout(300)
        b.close()
except Exception as e:
    print("RIG ERROR:", str(e)[:300])
    FAIL += 1

print(f"\n== v107 selective-field [{args.label}] == PASS {PASS} / FAIL {FAIL}")
json.dump(results, open(OUT + "-results.json", "w"), indent=1)
proc.terminate()
sys.exit(0 if FAIL == 0 else 1)
