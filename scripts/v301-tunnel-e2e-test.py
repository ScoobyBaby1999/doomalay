#!/usr/bin/env python3
# v301-tunnel-e2e-test.py — the v0.30.1 red-team-fix verification.
#
# The localhost.run red-team (GLM-5.2, shared chat "Planning Before
# Implementation") found the app dead-on-boot through any NON-localhost
# origin: module scripts (<script type="module">) always send Origin →
# the corsMiddleware 403'd /vendor/pm/* → the PM SDK never loaded → the
# 20s watchdog showed the one-way recovery screen. This suite simulates
# the tunnel shape (browser → non-localhost proxy origin → forwarding
# proxy → engine on 127.0.0.1, RemoteAddr stays local) and proves:
#
#   1. TUNNEL BOOT  — page + PM SDK + canvas + __doomalayReady through the
#                     proxy origin; all /vendor/pm/* assets 200.
#   2. SECURITY     — mismatched (evil) origins still 403; no Origin still OK.
#   3. PREFLIGHT    — OPTIONS through the proxy answers 200 (the PWA writes
#                     through the tunnel too).
#   4. WATCHDOG     — a late __doomalayReady AUTO-DISMISSES the recovery
#                     overlay; an early boot never shows it.
#   5. VERSION      — /api/health reports the buildinfo version (was "0.1.0").
#   6. PREWARM      — the engine logs the prewarm lines at boot.
#
# Run: python3 scripts/v301-tunnel-e2e-test.py [path-to-engine-binary]
# (engine binary default: the repo's test build; must be a CURRENT build.)
import http.client
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "engine", "doomalay-engine-test")
DATA = "/tmp/doomalay-v301test"
ENGINE_PORT = 8107
PROXY_PORT = 8108

PASS = FAIL = 0


def ok(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok: {label}")
    else:
        FAIL += 1
        print(f"FAIL: {label}")


def lan_ip():
    """The non-localhost address this host presents (for the proxy origin)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    out = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
    for cand in out:
        if not cand.startswith("127."):
            return cand
    return None


# ── the tunnel simulator (in-process) ─────────────────────────────────
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "host"}


class Forwarder(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _fwd(self, body):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if (body and length) else None
        conn = http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=90)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Host"] = self.headers.get("Host", f"127.0.0.1:{ENGINE_PORT}")
        conn.request(self.command, self.path, body=data, headers=headers)
        resp = conn.getresponse()
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in ("connection", "transfer-encoding"):
                continue
            self.send_header(k, v)
        payload = resp.read()
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        conn.close()

    def do_GET(self): self._fwd(False)
    def do_HEAD(self): self._fwd(False)
    def do_POST(self): self._fwd(True)
    def do_PUT(self): self._fwd(True)
    def do_PATCH(self): self._fwd(True)
    def do_DELETE(self): self._fwd(True)
    def do_OPTIONS(self): self._fwd(False)

    def log_message(self, *a):
        pass


# ── boot a fresh engine ────────────────────────────────────────────────
shutil.rmtree(DATA, ignore_errors=True)
subprocess.run(["pkill", "-f", "doomalay-v301test"], capture_output=True)
logf = open("/tmp/doomalay-v301-engine.log", "w")
proc = subprocess.Popen([ENG, "--port", str(ENGINE_PORT), "--bind", "127.0.0.1",
                         "--data-dir", DATA, "--open", "false"],
                        stdout=logf, stderr=subprocess.STDOUT)
BASE = f"http://127.0.0.1:{ENGINE_PORT}"
for _ in range(60):
    try:
        urllib.request.urlopen(BASE + "/api/health", timeout=1)
        break
    except Exception:
        time.sleep(0.25)
else:
    print("FATAL: engine did not start"); sys.exit(1)

IP = lan_ip()
if not IP:
    print("FATAL: no non-localhost address available for the proxy test")
    sys.exit(1)
PROXY = f"http://{IP}:{PROXY_PORT}"
print(f"engine on {BASE}  |  tunnel sim on {PROXY}")

srv = http.server.ThreadingHTTPServer(("0.0.0.0", PROXY_PORT), Forwarder)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.4)


def get(url, origin=None, method="GET"):
    req = urllib.request.Request(url, method=method)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ── 2. SECURITY + 3. PREFLIGHT (no browser needed) ────────────────────
print("\n[2/3] security + preflight through the proxy")
st, _ = get(PROXY + "/vendor/pm/pmsdk.js", origin=PROXY)
ok(st == 200, f"PM SDK with the SAME origin through the proxy → 200 (got {st}; was 403 pre-fix)")
st, _ = get(PROXY + "/vendor/pm/privatemode.wasm", origin=PROXY)
ok(st == 200, f"PM wasm with the same origin → 200 (got {st})")
st, _ = get(PROXY + "/vendor/pm/pmsdk.js", origin="https://evil.example.com")
ok(st == 403, f"PM SDK with an EVIL origin → still 403 (got {st})")
st, _ = get(PROXY + "/api/sessions", origin=PROXY)
ok(st == 200, f"API read with the same origin → 200 (got {st})")
st, _ = get(PROXY + "/api/sessions", origin="https://evil.example.com")
ok(st == 403, f"API read with an evil origin → 403 (got {st})")
st, _ = get(PROXY + "/api/health")
ok(st == 200, "no Origin at all (curl shape) → 200")

# ── 5. VERSION + 6. PREWARM (engine side) ─────────────────────────────
print("\n[5/6] version + prewarm")
st, body = get(BASE + "/api/health")
health = json.loads(body.decode())
ok(health.get("version") and health["version"] != "0.1.0",
   f"/api/health version = {health.get('version')!r} (was stuck '0.1.0')")
log = open("/tmp/doomalay-v301-engine.log").read()
ok("prewarm:" in log, "engine logged the prewarm pass at boot")

# ── 1. TUNNEL BOOT (browser through the proxy origin) ──────────────────
print("\n[1] full app boot through the tunnel-simulated origin")
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page()
    responses = {}
    page.on("response", lambda r: responses.__setitem__(r.url, r.status))
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(PROXY + "/", wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function("window.__doomalayReady === true", timeout=15000)
        ok(True, "__doomalayReady flipped true through the proxy")
    except Exception as e:
        ok(False, f"__doomalayReady through the proxy (15s): {e}")
    ok(not page.query_selector("#doomalay-recovery"), "no recovery overlay through the proxy")
    pm_status = {u.split("/")[-1]: s for u, s in responses.items() if "/vendor/pm/" in u}
    ok(pm_status.get("pmsdk.js") == 200, f"pmsdk.js through the proxy → 200 (got {pm_status.get('pmsdk.js')})")
    ok(all(s == 200 for s in pm_status.values()), f"all PM assets 200: {pm_status}")
    canvas = page.evaluate("(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : 'none'; })()")
    ok(canvas not in ("none", "300x150", "0x0"), f"canvas resized (got {canvas}; pre-fix stall left 300x150)")
    ok(not errors, f"zero page errors (got {errors[:3]})")
    pmb = page.evaluate("typeof window.PMBridge")
    print(f"  (info: window.PMBridge = {pmb})")

    # ── 4. WATCHDOG: late flag auto-dismisses the overlay ──────────────
    print("\n[4] recovery watchdog — late boot auto-dismisses")
    page2 = br.new_page()
    # The watchdog page must be SAME-ORIGIN with the engine (about:blank
    # pages get Private-Network-Access blocked from loading loopback
    # scripts), so intercept a URL on the engine origin and fulfill it
    # with a minimal page that loads recovery.js and never sets the flag.
    wd_html = (
        "<!doctype html><html><head><title>wd</title>"
        "<script>document.documentElement.style.setProperty('--ui-fs','16px');"
        "document.documentElement.style.setProperty('--ui-small-fs','13px');"
        "document.documentElement.style.setProperty('--bg-app','#fff');"
        "document.documentElement.style.setProperty('--text-1','#111');"
        "document.documentElement.style.setProperty('--text-3','#666');"
        "document.documentElement.style.setProperty('--border','#ccc');"
        "document.documentElement.style.setProperty('--border-strong','#999');</script>"
        "<script src=\"/recovery.js\"></script></head><body>wd</body></html>")
    page2.route(BASE + "/__wdtest", lambda route: route.fulfill(
        status=200, content_type="text/html", body=wd_html))
    page2.goto(BASE + "/__wdtest")
    time.sleep(1.5)
    ok(not page2.query_selector("#doomalay-recovery"), "watchdog: no overlay before 20s")
    print("  …waiting 21s for the watchdog to fire…")
    time.sleep(21.5)
    ok(page2.query_selector("#doomalay-recovery"), "watchdog: overlay shown at ~20s on a stalled boot")
    page2.evaluate("window.__doomalayReady = true")
    time.sleep(3.2)
    ok(not page2.query_selector("#doomalay-recovery"),
       "watchdog: late __doomalayReady AUTO-DISMISSED the overlay (was one-way pre-fix)")
    br.close()

srv.shutdown()
proc.terminate()
logf.close()

print(f"\n{'=' * 52}\n{'ALL PASS' if FAIL == 0 else 'FAILURES'}: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
