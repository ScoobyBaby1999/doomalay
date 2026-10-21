#!/usr/bin/env python3
# v1490 — THE POCKET BRIDGE RIG (PLAN-V149 §3, the ship gate).
#
# THE METHOD (the user's law: imitate a real user, red-team the full chain):
#
#   SANDBOX MODE (default — runs anywhere, no device): a FAKE TERMUX BRIDGE
#   (a loopback HTTP server speaking the Kotlin TermuxBridgeServer's 4-route
#   contract) whose /run REALLY executes the provisioner's commands in a
#   jail dir (HOME=JAIL, the jailed-exec twin), a LINUX-TWIN artifact zip
#   (the real opencode 1.19.3 binary in the guysoft zip's LAYOUT — the
#   rig's zip swaps the aarch64 wrapper for a POSIX one; on the DEVICE the
#   real pinned aarch64 zip rides the identical commands), and a REAL
#   engine with DOOMALAY_OPENCODE_SPAWNER=termux driving THE FULL CHAIN
#   through the app's own one-tap route: install (curl download → sha256
#   verify → unzip → gate-law config → key env 0600 → wake-lock + nohup
#   spawn → engine-side health poll) → a REAL free-tier turn through the
#   engine's WS protocol with the user's real key → session reuse → THE
#   RESTART-REUSE LAW (a second engine ADOPTS the live serve via
#   bridge.port, never stacking) → THE WATCHDOG LAW (kill the serve; the
#   engine re-provisions through the jailed exec; a third turn answers).
#   Plus the honest rungs live: the state ladder before/after, the walled
#   rung on a keyless engine, the honest-wall turn on a bridge-dead engine.
#
#   DEVICE MODE (--device — the real phone): drives the user's real app
#   over the tunnel; the honest gates SKIP (the v1.49 APK must be on the
#   device first — the release that carries this rig's code).
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8094"))
BRIDGE_PORT = PORT + 1
ART_PORT = PORT + 2
PORT_W = PORT + 3  # the keyless engine (the walled rung)
BASE = f"http://127.0.0.1:{PORT}"
TUNNEL = os.environ.get("DOOMALAY_TUNNEL", "https://postcard-plain-cia-adding.trycloudflare.com")
LINUX_BIN = os.environ.get("DOOMALAY_OPENCODE_BIN", "/home/z/.opencode/bin/opencode")
OPENCODE_KEY = os.environ.get("OPENCODE_API_KEY", "")
if not OPENCODE_KEY and os.path.exists("/home/z/keys.env"):
    for ln in open("/home/z/keys.env"):
        if ln.startswith("OPENCODE_KEY="):
            OPENCODE_KEY = ln.split("=", 1)[1].strip()
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + ok, FAIL + (not ok)


def api(base, path, method="GET", body=None, timeout=120):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"__status": e.code}


def session_events(base, sid):
    data = api(base, f"/api/sessions/{sid}/events?since=0")
    return data if isinstance(data, list) else data.get("events", [])


def ws_turn(base, port, sid, message, timeout_s=180, ws_url=None):
    """One WS turn; polls the events until a NEW terminal lands."""
    import queue
    import websocket as ws_client
    pre = len([e for e in session_events(base, sid)
               if e.get("type") == "status" and e.get("state") in ("idle", "error")])
    q = queue.Queue()
    url = ws_url or f"ws://127.0.0.1:{port}/api/chat?session_id={sid}"

    def run():
        try:
            w = ws_client.create_connection(url, timeout=30)
            w.send(json.dumps({"session_id": sid, "type": "send", "message": message}))
            try:
                w.recv()
            except Exception:
                pass
            try:
                w.close()
            except Exception:
                pass
        except Exception as e:
            q.put("err: " + str(e)[:120])
            return
        q.put("sent")

    threading.Thread(target=run, daemon=True).start()
    try:
        q.get(timeout=40)
    except Exception:
        pass
    deadline = time.time() + timeout_s
    last = []
    while time.time() < deadline:
        last = session_events(base, sid)
        terms = [e for e in last
                 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terms) > pre:
            if pre <= 0:
                return last  # the WHOLE log is this turn's (a fresh session)
            # only THIS turn's rows: everything after the pre-th pre-existing
            # terminal (exact count — cutting after the LAST returns nothing)
            cut = 0
            seen = 0
            for i, e in enumerate(last):
                if e.get("type") == "status" and e.get("state") in ("idle", "error"):
                    seen += 1
                    if seen == pre:
                        cut = i + 1
                        break
            return last[cut:]
        time.sleep(0.5)
    return last


def serve_children():
    try:
        out = subprocess.run(["pgrep", "-fa", "opencode.*serve"], capture_output=True).stdout.decode()
        return [l for l in out.splitlines() if l.strip() and "pgrep" not in l]
    except Exception:
        return []


# ── the fake Termux bridge: the Kotlin 4-route contract, /run REALLY execs ──

class FakeTermuxBridge(http.server.ThreadingHTTPServer):
    def __init__(self, jail):
        self.jail = jail
        self.runs = []
        super().__init__(("127.0.0.1", BRIDGE_PORT), self.handler)

    def handler(self, *a):
        BridgeHandler(self.jail, self.runs, *a)


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def __init__(self, jail, runs, *a):
        self.jail = jail
        self.runs = runs
        super().__init__(*a)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/status"):
            self._json({"installed": True, "api_installed": True, "version_code": 1002,
                        "version_name": "fake-termux", "permission": True,
                        "checkin_url": "", "bootstrap_done": True, "checkin_at": 0,
                        "checkin_storage": False, "checkin_props": False})
        elif self.path.rstrip("/").endswith("/netwait"):
            self._json({"seq": 1, "timeout": True})
        else:
            self._json({"ok": False, "errmsg": "route"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if not (self.path.rstrip("/").endswith("/run") or self.path.rstrip("/").endswith("/probe")):
            self._json({"ok": False, "errmsg": "route"}, 404)
            return
        cmd = body.get("command", "")
        workdir = body.get("workdir") or ""
        stdin = body.get("stdin", "") or ""
        timeout_ms = int(body.get("timeout_ms", 0) or 0)
        self.runs.append({"command": cmd, "workdir": workdir, "stdin": stdin})
        cwd = os.path.join(self.jail, workdir[len(os.path.realpath(self.jail)):] if False else "")
        cwd = workdir if workdir else self.jail
        env = {**os.environ, "HOME": self.jail, "TERMUX_VERSION": "fake",
               "PATH": "/usr/bin:/bin:/usr/local/bin"}
        try:
            r = subprocess.run(["bash", "-c", cmd], cwd=cwd if os.path.isdir(cwd) else self.jail,
                               env=env, input=stdin.encode(), capture_output=True,
                               timeout=(timeout_ms / 1000) + 30 if timeout_ms else 600)
            self._json({"ok": r.returncode == 0, "stdout": r.stdout.decode()[-8000:],
                        "stderr": r.stderr.decode()[-4000:], "exit_code": r.returncode,
                        "err": 0, "errmsg": "", "timeout": False})
        except subprocess.TimeoutExpired:
            self._json({"ok": False, "stdout": "", "stderr": "timeout", "exit_code": -1,
                        "err": 1, "errmsg": "timeout", "timeout": True})


def start_engine(bin_path, port, data_dir, extra_env, log_prefix):
    log = tempfile.NamedTemporaryFile(prefix=log_prefix, delete=False)
    eng = subprocess.Popen(
        [bin_path, "--port", str(port), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1", "PATH": "/usr/bin:/bin", **extra_env},
        stdout=log, stderr=log,
    )
    for _ in range(80):
        try:
            api(f"http://127.0.0.1:{port}", "/api/health", timeout=5)
            return eng
        except Exception:
            time.sleep(0.5)
    eng.terminate()
    raise RuntimeError(f"engine on {port} never became healthy — see the log")


def craft_linux_twin_zip(workdir):
    """The guysoft zip's LAYOUT with a linux twin: the POSIX wrapper (the
    real zip's wrapper is /data/data/… termux-sh + LD_PRELOAD; the twin
    is exec opencode.bin) + the REAL opencode 1.19.3 linux binary. The
    provisioner's commands are byte-identical in both worlds."""
    if not os.path.exists(LINUX_BIN):
        print(f"FATAL: the linux CLI twin is missing ({LINUX_BIN}) — set DOOMALAY_OPENCODE_BIN")
        sys.exit(1)
    d = os.path.join(workdir, "ziptree")
    os.makedirs(d, exist_ok=True)
    wrapper = '#!/bin/sh\ndir="$(cd "$(dirname "$0")" && pwd)"\nexec "$dir/opencode.bin" "$@"\n'
    open(os.path.join(d, "opencode"), "w").write(wrapper)
    os.chmod(os.path.join(d, "opencode"), 0o755)
    shutil.copy2(LINUX_BIN, os.path.join(d, "opencode.bin"))
    zpath = os.path.join(workdir, "opencode-android.zip")
    import zipfile
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        # preserve the exec bit the way the real zip does (external_attr)
        for name in ("opencode", "opencode.bin"):
            full = os.path.join(d, name)
            zi = zipfile.ZipInfo(name, date_time=(2026, 6, 25, 4, 44, 0))
            zi.external_attr = (0o755 if name == "opencode" else 0o644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, open(full, "rb").read())
    sha = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
    return zpath, sha


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "sandbox"
    print(f"v1490 — THE POCKET BRIDGE RIG ({mode} mode)")

    if mode == "device":
        device_mode()
        return

    # ── the setup: jail + twin zip + artifact server + fake bridge ─────
    work = tempfile.mkdtemp(prefix="v1490-work-")
    jail = os.path.join(work, "jail")
    os.makedirs(jail)
    zpath, zsha = craft_linux_twin_zip(work)
    print(f"  the linux-twin artifact: {zpath} ({os.path.getsize(zpath)//1024//1024}MB, sha {zsha[:12]}…)")

    class ArtHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            p = self.path.lstrip("/")
            if p == "opencode-android.zip":
                b = open(zpath, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
            else:
                self.send_response(404)
                self.end_headers()
    art = http.server.ThreadingHTTPServer(("127.0.0.1", ART_PORT), ArtHandler)
    threading.Thread(target=art.serve_forever, daemon=True).start()
    bridge = FakeTermuxBridge(jail)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    print(f"  the fake termux bridge: 127.0.0.1:{BRIDGE_PORT} (HOME={jail})")

    # ── build the engine ────────────────────────────────────────────────
    bin_path = "/tmp/doomalay-v1490-rig"
    r = subprocess.run(
        ["/home/z/sdk/go/bin/go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"), env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True)
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)

    eng_env = {
        "DOOMALAY_OPENCODE_SPAWNER": "termux",
        "DOOMALAY_TERMUX_BRIDGE": f"http://127.0.0.1:{BRIDGE_PORT}/rigtoken",
        "DOOMALAY_OPENCODE_ANDROID_ZIP": f"http://127.0.0.1:{ART_PORT}/opencode-android.zip",
        "DOOMALAY_OPENCODE_ANDROID_SHA256": zsha,
    }

    # ── RC — the honest rungs first (a keyless engine → walled) ─────────
    print("RC — the state ladder's honest rungs (a keyless engine)")
    data_w = tempfile.mkdtemp(prefix="v1490-engW-")
    eng_w = start_engine(bin_path, PORT_W, data_w, eng_env, "v1490-logW-")
    try:
        out = api(f"http://127.0.0.1:{PORT_W}", "/api/opencode/bridge")
        check("a keyless engine answers walled honestly",
              out.get("state") == "walled" and out.get("key_present") is False, f"{out}")
    finally:
        eng_w.terminate()

    # ── ENGINE A: the full chain through the app's own one-tap ─────────
    print("RA — ONE TAP: the engine installs + hosts the client through the jailed exec")
    data_a = tempfile.mkdtemp(prefix="v1490-engA-")
    eng_a = start_engine(bin_path, PORT, data_a, eng_env, "v1490-logA-")
    try:
        api(BASE, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(2)
        out = api(BASE, "/api/opencode/bridge")
        check("the ladder answers ready before the install (the gates pass)",
              out.get("state") == "ready", f"{out}")
        inst = api(BASE, "/api/opencode/bridge/install", "POST", timeout=60)
        check("the one-tap install answers ok", inst.get("ok") is True and inst.get("state") == "installing", f"{inst}")
        # poll to up (the real chain: curl → sha → unzip → config → spawn → health)
        up_state, waited = None, 0.0
        while waited < 240:
            out = api(BASE, "/api/opencode/bridge")
            up_state = out.get("state")
            if up_state == "up":
                break
            if up_state == "install_failed":
                break
            time.sleep(2)
            waited += 2
        check("the install chain lands UP (download → sha → unzip → config → spawn → health)",
              up_state == "up", f"state={up_state} after {waited}s")
        if up_state != "up":
            print("    the install-failed detail:", out.get("last_error", "")[:300])
            print("    the bridge ran", len(bridge.runs), "commands; the last:",
                  (bridge.runs[-1]["command"][:200] if bridge.runs else "none"))
        port_a = out.get("port")
        check("the port rides the up state", isinstance(port_a, int) and port_a > 1024, f"port={port_a}")
        cmds = [r["command"] for r in bridge.runs]
        check("THE KEY NEVER RODE A COMMAND LINE (the ps-safe law, live)",
              all(OPENCODE_KEY not in c for c in cmds))
        keyenv = os.path.join(jail, ".doomalay", "opencode-serve", "key.env")
        cfgpath = os.path.join(jail, ".doomalay", "opencode-serve", "opencode.json")
        check("the gate-law config landed in the serve dir (the real file)",
              os.path.exists(cfgpath) and '"bash": "deny"' in open(cfgpath).read())
        check("the key env landed 0600 in the serve dir (the real file)",
              os.path.exists(keyenv) and oct(os.stat(keyenv).st_mode)[-3:] == "600"
              and OPENCODE_KEY in open(keyenv).read())
        mine = [l for l in serve_children() if f"--port {port_a}" in l]
        check("a REAL serve process is running under the jail (the ADOPTED port, never a stale foreign one)",
              len(mine) >= 1, f"port {port_a}: {mine[:1]}")

        print("RB — a REAL free-model turn through the engine's own WS protocol")
        sid = api(BASE, "/api/sessions", "POST",
                  {"provider": "opencode", "model": "big-pickle", "title": "pocket rig"})["ID"]
        evs = ws_turn(BASE, PORT, sid, "Think step by step: what is 17*23? End your reply with the final number on its own line.")
        thinking = " ".join(e.get("text", "") for e in evs if e.get("type") == "thinking")
        answer = " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")
        check("the turn reached the genuine client (thinking streamed)", len(thinking) > 10,
              f"thinking head: {thinking[:80]!r}")
        check("the ANSWER landed (the model's final text)", "391" in answer,
              f"answer head: {answer[:120]!r}")
        idle = [e for e in evs if e.get("type") == "status" and e.get("state") == "idle"]
        usage = (idle[-1].get("usage") or {}) if idle else {}
        check("the terminal carries serve's own usage (the ledger)",
              usage.get("total_tokens", 0) > 0, f"usage={usage}")
        check("the REASONING share rides the ledger",
              usage.get("reasoning_tokens", 0) > 0, f"reasoning={usage.get('reasoning_tokens')}")

        print("RD — the SECOND turn (serve-session reuse through the pocket bridge)")
        evs2 = ws_turn(BASE, PORT, sid, "And now: what is 100/4? Answer with just the number.")
        answer2 = " ".join(e.get("text", "") for e in evs2 if e.get("type") == "assistant")
        check("the second turn answers through the reused serve session",
              "25" in answer2, f"answer head: {answer2[:120]!r}")
    finally:
        # ── RE — the RESTART-REUSE LAW: a second engine ADOPTS the serve ─
        print("RE — the RESTART-REUSE LAW (engine 2 adopts the live serve via bridge.port)")
        before = len(serve_children())
        eng_a.terminate()
        eng_a.wait(timeout=10)
        data_a2 = tempfile.mkdtemp(prefix="v1490-engA2-")
        eng_a2 = None
        try:
            eng_a2 = start_engine(bin_path, PORT, data_a2, eng_env, "v1490-logA2-")
            api(f"http://127.0.0.1:{PORT}", "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
            time.sleep(1)
            sid2 = api(f"http://127.0.0.1:{PORT}", "/api/sessions", "POST",
                       {"provider": "opencode", "model": "big-pickle", "title": "reuse rig"})["ID"]
            evs3 = ws_turn(f"http://127.0.0.1:{PORT}", PORT, sid2, "What is 9*9? Answer with just the number.")
            answer3 = " ".join(e.get("text", "") for e in evs3 if e.get("type") == "assistant")
            check("engine 2's first turn answers (the ADOPTED serve, not a fresh spawn)",
                  "81" in answer3, f"answer head: {answer3[:100]!r}")
            check("the serve was ADOPTED, never stacked (one live serve)",
                  len(serve_children()) == before, f"before={before} after={len(serve_children())}")
        finally:
            # ── RF — the WATCHDOG LAW: kill the serve; it re-provisions ──
            print("RF — the WATCHDOG LAW (kill the serve; the engine re-provisions through the exec)")
            pidfile = os.path.join(jail, ".doomalay", "opencode-serve", "serve.pid")
            killed = False
            if os.path.exists(pidfile):
                pid = open(pidfile).read().strip()
                try:
                    os.kill(int(pid), 15)
                    killed = True
                except Exception:
                    killed = False
            check("the live serve was killed for the watchdog probe", killed)
            state, waited = None, 0.0
            while waited < 180:
                out = api(f"http://127.0.0.1:{PORT}", "/api/opencode/bridge")
                state = out.get("state")
                if state == "up":
                    break
                time.sleep(3)
                waited += 3
            check("the engine re-provisioned the died serve (the bounded watchdog)",
                  state == "up", f"state={state} after {waited}s")
            if state == "up":
                evs4 = ws_turn(f"http://127.0.0.1:{PORT}", PORT, sid2, "What is 8*8? Answer with just the number.")
                answer4 = " ".join(e.get("text", "") for e in evs4 if e.get("type") == "assistant")
                check("a turn answers on the RE-PROVISIONED bridge", "64" in answer4,
                      f"answer head: {answer4[:100]!r}")
            if eng_a2:
                eng_a2.terminate()
    # ── ENGINE B: the honest wall (a dead bridge) ───────────────────────
    print("RG — the bridge is dead: the turn answers the honest wall, never a hang")
    data_b = tempfile.mkdtemp(prefix="v1490-engB-")
    eng_b = start_engine(bin_path, PORT_W, data_b,
                         {"DOOMALAY_OPENCODE_SPAWNER": "termux",
                          "DOOMALAY_TERMUX_BRIDGE": "http://127.0.0.1:1/deadtoken",
                          "PATH": "/usr/bin:/bin"}, "v1490-logB-")
    try:
        api(f"http://127.0.0.1:{PORT_W}", "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(2)
        out = api(f"http://127.0.0.1:{PORT_W}", "/api/opencode/bridge")
        check("a dead bridge answers unconfigured honestly (the status ladder)",
              out.get("state") == "unconfigured", f"{out}")
        sid_b = api(f"http://127.0.0.1:{PORT_W}", "/api/sessions", "POST",
                    {"provider": "opencode", "model": "big-pickle", "title": "wall rig"})["ID"]
        evs_b = ws_turn(f"http://127.0.0.1:{PORT_W}", PORT_W, sid_b, "hello free model", timeout_s=120)
        err_text = " ".join((e.get("text") or "") + " " + (e.get("message") or "")
                            for e in evs_b if e.get("type") == "error")
        check("the unavailable bridge answers the HONEST wall copy (the bridge + alternatives)",
              "walled" in err_text and ("DESKTOP" in err_text or "POCKET" in err_text or "bridge" in err_text),
              f"error head: {err_text[:160]!r}")
        terms_b = [e for e in evs_b if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        check("the walled turn still TERMINALS (never a silent hang)", len(terms_b) > 0)
    finally:
        eng_b.terminate()

    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


def device_mode():
    """The real phone over the user's tunnel. The honest gates SKIP:
    the tunnel may be down, and the pocket bridge rides the v1.49+ APK."""
    print(f"  probing the tunnel: {TUNNEL}")
    try:
        with urllib.request.urlopen(TUNNEL.rstrip("/") + "/api/health", timeout=10) as r:
            health = json.loads(r.read().decode())
    except Exception as e:
        print(f"  SKIP — the tunnel is down ({str(e)[:80]}). The device red-team runs at the next tunnel-up.")
        sys.exit(0)
    ver = health.get("version", "")
    print(f"  the device answers /api/health: {health}")
    if not ver.startswith("1.49"):
        print(f"  SKIP — the device runs {ver}; the pocket bridge rides the v1.49+ APK "
              f"(install the new APK, reopen the app, re-run with --device).")
        sys.exit(0)
    base = TUNNEL
    out = api(base, "/api/opencode/bridge")
    print(f"  the REAL device ladder: {out}")
    if out.get("state") != "ready":
        print(f"  SKIP — the device's ladder answers {out.get('state')} "
              f"({out.get('detail', '')[:120]}) — finish the gates on the phone and re-run.")
        sys.exit(0)
    inst = api(base, "/api/opencode/bridge/install", "POST", timeout=60)
    print(f"  the one-tap install on the REAL device: {inst}")
    state, waited = None, 0.0
    while waited < 600:
        out = api(base, "/api/opencode/bridge")
        state = out.get("state")
        print(f"    [{waited:4.0f}s] state={state}")
        if state in ("up", "install_failed"):
            break
        time.sleep(5)
        waited += 5
    if state != "up":
        print(f"  FAIL — the device install ended {state}: {out.get('last_error', '')[:300]}")
        sys.exit(1)
    print("  the REAL aarch64 serve is up — THE DECISION GATE probe (a real free turn on the phone)")
    sid = api(base, "/api/sessions", "POST",
              {"provider": "opencode", "model": "big-pickle", "title": "device gate"})["ID"]
    evs = ws_turn(base, 443, sid, "Think step by step: what is 12*12? End with the final number on its own line.", timeout_s=240,
                  ws_url=base.replace("https://", "wss://") + f"/api/chat?session_id={sid}")
    answer = " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")
    err_text = " ".join((e.get("text") or "") + " " + (e.get("message") or "")
                        for e in evs if e.get("type") == "error")
    if "144" in answer:
        print("  THE DECISION GATE PASSES: the native 1.17.9 client answers through the free tier on the REAL device.")
        sys.exit(0)
    print(f"  THE GATE REFUSED or the turn failed — answer head: {answer[:120]!r}; error head: {err_text[:200]!r}")
    print("  → PLAN-V149's plan-B (opencode2 + the 2.x adapter) is the path.")
    sys.exit(2)



if __name__ == "__main__":
    main()
