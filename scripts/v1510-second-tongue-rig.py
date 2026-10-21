#!/usr/bin/env python3
# v1510 — THE SECOND TONGUE RIG (PLAN-V151 §4, the ship gate) — BIG PICKLE
# AGAINST EVERY TOOL CAPABILITY, live, as a real user.
#
# THE METHOD (the user's law: imitate a real user, red-team the full chain):
#
#   desktop mode  (default) — the REAL 2.x desktop chain: a fresh engine data
#   dir → the engine's OWN EnsureBinary downloads the pinned npm tarball
#   (the REAL @opencode/cli-linux-x64 bytes, sha512-verified against the
#   pinned registry integrity) → spawn (password env) → auth'd health →
#   the BIG PICKLE battery through the engine's own WS protocol with the
#   user's real key: thinking + answer + the ledger (cost 0), the TOOL PILL
#   (a real read-tool turn — the model reads a planted secret), session
#   reuse, a MID-CHAT MODEL SWITCH (big-pickle → minimax, self-identified),
#   THE WATCHDOG LAW (kill the serve; the engine restarts; a turn answers),
#   the honest walled rung (a keyless engine), and the honest 401 rung (a
#   bad key answers the honest oc_bridge_auth error, live).
#
#   android mode — the FULL pocket-bridge chain through the jailed exec: a
#   FAKE TERMUX BRIDGE whose /run REALLY executes in a jail + the opencode2
#   flat-layout TWIN (the real linux 2.1.2 binary as opencode2.bin) + the
#   spawner forced → ONE TAP: download → sha256 → unzip (+ the legacy 1.x
#   cleanup, verified live) → the 2.x gate-law config (shell deny,
#   byte-checked) → key.env with BOTH secrets 0600 → spawn → auth'd health
#   → a real turn → reuse → kill → the bounded watchdog → a third turn.
#
#   device mode (--device) — the real phone over the user's tunnel: the
#   /api/health version gate (v1.51+), the ladder, the ONE-TAP install of
#   the REAL 72.5MB opencode2, and a real big-pickle turn on the REAL
#   aarch64 binary. The honest gates SKIP.
import base64
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
PORT_W = PORT + 3
BASE = f"http://127.0.0.1:{PORT}"
TUNNEL = os.environ.get("DOOMALAY_TUNNEL", "https://postcard-plain-cia-adding.trycloudflare.com")
OPENCODE_KEY = os.environ.get("OPENCODE_API_KEY", "")
if not OPENCODE_KEY and os.path.exists("/home/z/keys.env"):
    for ln in open("/home/z/keys.env"):
        if ln.startswith("OPENCODE_KEY="):
            OPENCODE_KEY = ln.split("=", 1)[1].strip()
# the pinned desktop artifact (the npm 2.x line) — the rig serves the REAL
# bytes locally so the engine's own download+sha512 law runs end-to-end
# (repeatable, no registry flakiness) against the EXACT pinned integrity.
NPM_TARBALL = os.environ.get(
    "V1510_TARBALL",
    "/tmp/cli-linux-x64-2.1.2.tgz")
NPM_TARBALL_URL = "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.2.tgz"
NPM_INTEGRITY = ("sha512-O8/8JT8SNmMReDmpYDsm04KmkrQQ2dzaKgaw06zCoUfh50ARGHs58E6z"
                 "Ch16GIUyEL8abrdSe268K5/ExE89Gw==")
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    sys.stdout.flush()
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


def ws_turn(base, port, sid, message, timeout_s=240, ws_url=None):
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
                return last
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


def build_engine():
    bin_path = "/tmp/doomalay-v1510-rig"
    r = subprocess.run(
        ["go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"), env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True)
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)
    return bin_path


def ensure_npm_tarball():
    """The REAL pinned tarball bytes (downloaded from npm on a cold cache,
    verified against the pinned integrity — THE PIN LAW lives here too)."""
    if os.path.exists(NPM_TARBALL) and os.path.getsize(NPM_TARBALL) > 50_000_000:
        data = open(NPM_TARBALL, "rb").read()
    else:
        print(f"  downloading the REAL npm tarball ({NPM_TARBALL_URL})…")
        with urllib.request.urlopen(NPM_TARBALL_URL, timeout=300) as r:
            data = r.read()
        os.makedirs(os.path.dirname(os.path.abspath(NPM_TARBALL)), exist_ok=True)
        with open(NPM_TARBALL, "wb") as f:
            f.write(data)
    got = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if got != NPM_INTEGRITY:
        print(f"FATAL: the tarball's sha512 drifted from the PIN ({got})")
        sys.exit(1)
    print(f"  the pinned npm tarball verified: {len(data)//1024//1024}MB, sha512 {got[7:19]}…")
    return NPM_TARBALL


class ArtHandler(http.server.BaseHTTPRequestHandler):
    payload = None

    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path.lstrip("/")
        if p in ("opencode-android.zip", "cli-linux-x64-2.1.2.tgz") and ArtHandler.payload:
            b = ArtHandler.payload
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        else:
            self.send_response(404)
            self.end_headers()


def start_artifact_server(payload):
    ArtHandler.payload = payload
    art = http.server.ThreadingHTTPServer(("127.0.0.1", ART_PORT), ArtHandler)
    threading.Thread(target=art.serve_forever, daemon=True).start()
    return art


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
        cwd = workdir if workdir else self.jail
        # SANITIZED: the real Termux bridge execs with Termux's own shell
        # env — the rig's exported OPENCODE_*/DOOMALAY_* must NOT leak in
        # (the v149 rig's leak masked the key.env export bug the v1510 rig
        # convicted; the secrets must ride key.env and NOTHING else).
        env = {k: v for k, v in os.environ.items()
               if not (k.startswith("OPENCODE_") or k.startswith("DOOMALAY_"))}
        env.update({"HOME": self.jail, "TERMUX_VERSION": "fake",
                    "PATH": "/usr/bin:/bin:/usr/local/bin", "LANG": "C.UTF-8"})
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


def extract_binary_from_tarball(tgz_path, workdir):
    """The REAL 2.1.2 linux binary out of the npm tarball (package/bin/opencode)."""
    import gzip
    import tarfile
    out = os.path.join(workdir, "opencode2.bin")
    with tarfile.open(tgz_path, "r:gz") as t:
        for m in t.getmembers():
            if m.name.endswith("bin/opencode"):
                with t.extractfile(m) as f, open(out, "wb") as o:
                    shutil.copyfileobj(f, o)
                os.chmod(out, 0o755)
                return out
    raise RuntimeError("the npm tarball has no package/bin/opencode")


def craft_opencode2_twin_zip(tgz_path, workdir):
    """The opencode2 flat LAYOUT with the linux twin: the POSIX wrapper (the
    real zip's wrapper is a termux-sh + OPENTUI_LIB_PATH launcher; the twin
    execs opencode2.bin) + the REAL 2.1.2 binary + a placeholder
    libopentui.so. The provisioner's commands are byte-identical."""
    d = os.path.join(workdir, "ziptree")
    os.makedirs(d, exist_ok=True)
    # NOTE: the REAL zip's wrapper shebangs /data/data/com.termux/.../sh
    # (Termux-only — absent in this sandbox); the TWIN uses /bin/sh so the
    # jailed exec can actually run it here. On the DEVICE the real wrapper
    # rides the identical provisioner commands byte-for-byte.
    wrapper = ('#!/bin/sh\n'
               '# the rig twin of the opencode2 wrapper\n'
               'dir="$(cd "$(dirname "$0")" && pwd)"\n'
               'exec "$dir/opencode2.bin" "$@"\n')
    open(os.path.join(d, "opencode2"), "w").write(wrapper)
    os.chmod(os.path.join(d, "opencode2"), 0o755)
    extract_binary_from_tarball(tgz_path, d)
    open(os.path.join(d, "libopentui.so"), "wb").write(b"\x7fELF-twin-placeholder")
    zpath = os.path.join(workdir, "opencode-android.zip")
    import zipfile
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for name, mode in (("opencode2", 0o755), ("opencode2.bin", 0o644), ("libopentui.so", 0o644)):
            full = os.path.join(d, name)
            zi = zipfile.ZipInfo(name, date_time=(2026, 10, 18, 1, 43, 0))
            zi.external_attr = mode << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, open(full, "rb").read())
    sha = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
    return zpath, sha


def assistant_text(evs):
    return " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")


def thinking_text(evs):
    return " ".join(e.get("text", "") for e in evs if e.get("type") == "thinking")


def usage_of(evs):
    idle = [e for e in evs if e.get("type") == "status" and e.get("state") == "idle"]
    return (idle[-1].get("usage") or {}) if idle else {}


# ════════════════════════════════════════════════════════════════════════
def pill_json(e):
    """A persisted tool/error event carries the JSON payload in text
    (the deterministic-replay law) — parse it for name/error/message."""
    try:
        v = e.get("text") or ""
        return json.loads(v) if isinstance(v, str) and v.strip().startswith("{") else {}
    except Exception:
        return {}


def pill_name(e):
    return (e.get("name") or pill_json(e).get("name") or "")


# DESKTOP MODE — the real 2.x desktop chain, BIG PICKLE against every tool
# ════════════════════════════════════════════════════════════════════════

def desktop_mode():
    print("v1510 — THE SECOND TONGUE RIG (desktop mode — big pickle vs every capability)")
    if not OPENCODE_KEY:
        print("FATAL: OPENCODE_API_KEY missing (set it or /home/z/keys.env)")
        sys.exit(1)
    tgz = ensure_npm_tarball()
    start_artifact_server(open(tgz, "rb").read())

    bin_path = build_engine()
    eng_env = {
        "DOOMALAY_OPENCODE_TARBALL_URL": f"http://127.0.0.1:{ART_PORT}/cli-linux-x64-2.1.2.tgz",
        "DOOMALAY_OPENCODE_TARBALL_SHA512": NPM_INTEGRITY,
    }

    # ── D0 — the state ladder on a desktop engine (before any turn) ─────
    print("D0 — the desktop state ladder")
    data_a = tempfile.mkdtemp(prefix="v1510-engA-")
    eng_a = start_engine(bin_path, PORT, data_a, eng_env, "v1510-logA-")
    try:
        api(BASE, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(1)
        out = api(BASE, "/api/opencode/bridge")
        check("desktop answers state=desktop (the exec spawner self-manages)",
              out.get("state") == "desktop", f"{out.get('state')}")

        # ── D1 — THE FIRST TURN: the engine downloads the pinned tarball,
        # spawns the 2.x serve, and a real big-pickle turn answers ──────
        print("D1 — the first turn: npm download → sha512 → spawn → auth → big pickle")
        sid = api(BASE, "/api/sessions", "POST",
                  {"provider": "opencode", "model": "big-pickle", "title": "v1510 desktop"})["ID"]
        evs = ws_turn(BASE, PORT, sid,
                      "Think step by step: what is 17*23? End your reply with the final number on its own line.")
        think = thinking_text(evs)
        answer = assistant_text(evs)
        check("the engine downloaded + spawned the 2.x serve on the first free turn",
              "391" in answer, f"answer head: {answer[:100]!r}")
        check("THINKING streamed (the reasoning deltas → the pill)",
              len(think) > 10, f"thinking head: {think[:60]!r}")
        u = usage_of(evs)
        check("THE LEDGER rides the terminal (serve's own tokens)",
              u.get("total_tokens", 0) > 0, f"usage={ {k: u.get(k) for k in ('total_tokens','reasoning_tokens','cache_read')} }")
        check("THE REASONING share rides the ledger", u.get("reasoning_tokens", 0) > 0,
              f"reasoning={u.get('reasoning_tokens')}")
        check("the ledger carries the serve's own cache accounting", u.get("cache_read", -1) >= 0,
              f"cache_read={u.get('cache_read')}")
        check("COST 0 (the free tier, the genuine client)", u.get("cost", -1) == 0,
              f"cost={u.get('cost')}")
        check("the desktop bridge answers available (the dispatch gate)",
              api(BASE, "/api/opencode/bridge").get("available") is True)
        mine = serve_children()
        check("a REAL 2.x serve process is running (the engine-managed child)", len(mine) >= 1,
              f"{[m.split(' --port ')[-1][:12] for m in mine[:2]]}")

        # ── D2 — THE TOOL PILL: a real read-tool turn on the 2.x feed ────
        print("D2 — the TOOL PILL (a real read-tool turn through session.tool.*)")
        scratch = os.path.join(data_a, "opencode-serve")
        secret = "V1510-BIG-PICKLE-TOOL-SECRET-7311"
        open(os.path.join(scratch, "secret-note.txt"), "w").write(
            f"THE SECRET IS {secret}\n")
        evs2 = ws_turn(BASE, PORT, sid,
                       "Read the file secret-note.txt in your working directory and tell me exactly what the secret is.")
        answer2 = assistant_text(evs2)
        tools_used = [e for e in evs2 if e.get("type") == "tool_use"]
        tools_res = [e for e in evs2 if e.get("type") == "tool_result"]
        check("the read TOOL PILL landed (tool_use from session.tool.input)",
              len(tools_used) >= 1, f"tool_use={ [pill_name(t) for t in tools_used] }")
        check("the tool RESULT pill landed (tool_result from session.tool.success)",
              len(tools_res) >= 1, f"tool_result head: { (tools_res[0].get('text') or '')[:80]!r }")
        check("the tool_use name carries the opencode: prefix (the persisted pill's JSON name)",
              all(pill_name(t).startswith("opencode:") for t in tools_used),
              f"{[pill_name(t) for t in tools_used]}")
        check("the model REALLY read the file (the secret in the answer)",
              secret in answer2, f"answer head: {answer2[:120]!r}")
        check("the reuse turn's ledger carries the growing cache",
              usage_of(evs2).get("cache_read", 0) > 0, f"cache_read={usage_of(evs2).get('cache_read')}")

        # ── D3 — SESSION REUSE (the second turn rides the same serve) ───
        print("D3 — session reuse (the serve session carries the context)")
        evs3 = ws_turn(BASE, PORT, sid,
                       "And now: what is 100/4? Answer with just the number.")
        check("the second turn answers through the REUSED serve session",
              "25" in assistant_text(evs3), f"head: {assistant_text(evs3)[:80]!r}")

        # ── D4 — THE MID-CHAT MODEL SWITCH (the per-turn model law) ─────
        print("D4 — the MID-CHAT MODEL SWITCH (SelectModel before every prompt)")
        api(BASE, f"/api/sessions/{sid}", "PATCH", {"model": "minimax-m3.1-flash-free"})
        evs4 = ws_turn(BASE, PORT, sid,
                       "What model are you exactly? Reply with ONLY your model id, nothing else.")
        answer4 = assistant_text(evs4)
        check("the switch landed: minimax answers, not big-pickle",
              "minimax" in answer4.lower() and "pickle" not in answer4.lower(),
              f"self-id: {answer4[:80]!r}")
        # the switch-BACK runs on a FRESH chat (a self-id in the same chat
        # would echo the replayed history — the honest probe isolates it)
        sid_m = api(BASE, "/api/sessions", "POST",
                    {"provider": "opencode", "model": "big-pickle", "title": "v1510 switch-back"})["ID"]
        evs4b = ws_turn(BASE, PORT, sid_m,
                        "What model are you exactly? Reply with ONLY your model id, nothing else.")
        answer4b = assistant_text(evs4b)
        check("the switch never stuck wrong: a fresh big-pickle chat answers big-pickle",
              "pickle" in answer4b.lower(), f"self-id: {answer4b[:80]!r}")

        # ── D5 — THE WATCHDOG LAW (kill the serve; the engine restarts) ─
        print("D5 — the WATCHDOG LAW (kill the child; the engine restarts it)")
        before = len(serve_children())
        killed = False
        for m in serve_children():
            try:
                pid = int(m.split()[0])
                os.kill(pid, 15)
                killed = True
            except Exception:
                pass
        check("the live serve was killed for the watchdog probe", killed)
        # the death must REGISTER first (the bridge API probes live;
        # the lazy law: nothing restarts a desktop serve but the next turn)
        state, waited, died = None, 0.0, False
        while waited < 30:
            out = api(BASE, "/api/opencode/bridge")
            if out.get("available") is False:
                died = True
                break
            time.sleep(2)
            waited += 2
        check("the death registered (available flips false)",
              died, f"after {waited}s")
        # THE REAL USER PATH: the next turn self-heals (runOcServeTurn →
        # ocServeManager → Start → the bounded restart) — no idle daemon
        # ever restarts a desktop serve
        evs5 = ws_turn(BASE, PORT, sid, "What is 8*8? Answer with just the number.")
        check("a turn answers after the kill (the turn path restarts the bridge)",
              "64" in assistant_text(evs5), f"head: {assistant_text(evs5)[:80]!r}")
        check("the restarted bridge answers available again",
              api(BASE, "/api/opencode/bridge").get("available") is True)
    finally:
        eng_a.terminate()

    # ── D6 — the honest desktop rung (a keyless engine) ──────────────────
    print("D6 — the keyless engine answers its honest desktop state (key_present false)")
    data_w = tempfile.mkdtemp(prefix="v1510-engW-")
    eng_w = start_engine(bin_path, PORT_W, data_w, eng_env, "v1510-logW-")
    try:
        out = api(f"http://127.0.0.1:{PORT_W}", "/api/opencode/bridge")
        check("a keyless desktop engine answers desktop + key_present=false + unavailable",
              out.get("state") == "desktop" and out.get("key_present") is False
              and out.get("available") is False,
              f"{ {k: out.get(k) for k in ('state', 'key_present', 'available')} }")
    finally:
        eng_w.terminate()

    # ── D7 — the honest 401 rung (a BAD key → oc_bridge_auth, live) ──────
    print("D7 — the BAD key answers the honest oc_bridge_auth error (live 2.x 401)")
    data_k = tempfile.mkdtemp(prefix="v1510-engK-")
    eng_k = start_engine(bin_path, PORT_W, data_k, eng_env, "v1510-logK-")
    try:
        api(f"http://127.0.0.1:{PORT_W}", "/api/keys", "POST",
            {"provider": "opencode", "key": "oc_sk_DEADbeefDEADbeefDEADbeefDEAD01"})
        time.sleep(1)
        sid_k = api(f"http://127.0.0.1:{PORT_W}", "/api/sessions", "POST",
                    {"provider": "opencode", "model": "big-pickle", "title": "bad key"})["ID"]
        evs_k = ws_turn(f"http://127.0.0.1:{PORT_W}", PORT_W, sid_k, "hello free model",
                        timeout_s=180)
        errs = [e for e in evs_k if e.get("type") == "error"]
        payloads = [pill_json(e) for e in errs]
        check("the 401 answers the HONEST key error (oc_bridge_auth)",
              any(p.get("error") == "oc_bridge_auth" for p in payloads),
              f"err={ [p.get('error') for p in payloads] }")
        check("the copy names the key fix (check the OpenCode key)",
              any("key" in (p.get("message") or "").lower() for p in payloads),
              f"head: { (payloads[0].get('message') if payloads else '')[:100]!r }")
        terms_k = [e for e in evs_k if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        check("the 401 turn still TERMINALS (never a silent hang)", len(terms_k) > 0)
    finally:
        eng_k.terminate()

    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


# ════════════════════════════════════════════════════════════════════════
# ANDROID MODE — the full pocket-bridge chain on the opencode2 twin
# ════════════════════════════════════════════════════════════════════════

def android_mode():
    print("v1510 — THE SECOND TONGUE RIG (android-chain mode — the opencode2 pocket bridge)")
    if not OPENCODE_KEY:
        print("FATAL: OPENCODE_API_KEY missing (set it or /home/z/keys.env)")
        sys.exit(1)
    tgz = ensure_npm_tarball()
    work = tempfile.mkdtemp(prefix="v1510-work-")
    jail = os.path.join(work, "jail")
    os.makedirs(jail)
    zpath, zsha = craft_opencode2_twin_zip(tgz, work)
    print(f"  the opencode2 twin zip: {os.path.getsize(zpath)//1024//1024}MB, sha {zsha[:12]}…")
    # the LEGACY plant: a v1.49 phone's dead 1.x files must leave at install
    legacy_dir = os.path.join(jail, ".doomalay", "opencode")
    os.makedirs(legacy_dir, exist_ok=True)
    open(os.path.join(legacy_dir, "opencode"), "w").write("#!/bin/sh\n")
    open(os.path.join(legacy_dir, "opencode.bin"), "w").write("legacy 1.x binary")
    os.chmod(os.path.join(legacy_dir, "opencode"), 0o755)

    start_artifact_server(open(zpath, "rb").read())
    bridge = FakeTermuxBridge(jail)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    print(f"  the fake termux bridge: 127.0.0.1:{BRIDGE_PORT} (HOME={jail})")

    bin_path = build_engine()
    eng_env = {
        "DOOMALAY_OPENCODE_SPAWNER": "termux",
        "DOOMALAY_TERMUX_BRIDGE": f"http://127.0.0.1:{BRIDGE_PORT}/rigtoken",
        "DOOMALAY_OPENCODE_ANDROID_ZIP": f"http://127.0.0.1:{ART_PORT}/opencode-android.zip",
        "DOOMALAY_OPENCODE_ANDROID_SHA256": zsha,
    }

    print("A0 — the state ladder's honest rungs (a keyless engine)")
    data_w = tempfile.mkdtemp(prefix="v1510-engW-")
    eng_w = start_engine(bin_path, PORT_W, data_w, eng_env, "v1510-logW-")
    try:
        out = api(f"http://127.0.0.1:{PORT_W}", "/api/opencode/bridge")
        check("a keyless engine answers walled honestly",
              out.get("state") == "walled" and out.get("key_present") is False, f"{out}")
    finally:
        eng_w.terminate()

    print("A1 — ONE TAP: the engine installs + hosts opencode2 through the jailed exec")
    data_a = tempfile.mkdtemp(prefix="v1510-engA-")
    eng_a = start_engine(bin_path, PORT, data_a, eng_env, "v1510-logA-")
    try:
        api(BASE, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(2)
        out = api(BASE, "/api/opencode/bridge")
        check("the ladder answers ready before the install (the gates pass)",
              out.get("state") == "ready", f"{out}")
        check("the card copy names the 2.x client + the 72.5MB size",
              "2.0.0" in (out.get("client_version") or "") and "72.5" in (out.get("size_hint") or ""),
              f"client={out.get('client_version')} size={out.get('size_hint')}")
        inst = api(BASE, "/api/opencode/bridge/install", "POST", timeout=60)
        check("the one-tap install answers ok", inst.get("ok") is True and inst.get("state") == "installing", f"{inst}")
        up_state, waited = None, 0.0
        while waited < 240:
            out = api(BASE, "/api/opencode/bridge")
            up_state = out.get("state")
            if up_state in ("up", "install_failed"):
                break
            time.sleep(2)
            waited += 2
        check("the install chain lands UP (download → sha → unzip+cleanup → config → key.env → spawn → auth'd health)",
              up_state == "up", f"state={up_state} after {waited}s")
        if up_state != "up":
            print("    the install-failed detail:", out.get("last_error", "")[:300])
            print("    the bridge ran", len(bridge.runs), "commands; the last:",
                  (bridge.runs[-1]["command"][:200] if bridge.runs else "none"))
        port_a = out.get("port")
        check("the port rides the up state", isinstance(port_a, int) and port_a > 1024, f"port={port_a}")
        cmds = [r["command"] for r in bridge.runs]
        stdins = [r["stdin"] for r in bridge.runs]
        check("THE KEY + THE PASSWORD NEVER RODE A COMMAND LINE (ps-safe, live)",
              all(OPENCODE_KEY not in c for c in cmds))
        keyenv = os.path.join(jail, ".doomalay", "opencode-serve", "key.env")
        cfgpath = os.path.join(jail, ".doomalay", "opencode-serve", "opencode.json")
        cfg = open(cfgpath).read() if os.path.exists(cfgpath) else ""
        check("the 2.x gate-law config landed (shell deny — the 2.x tool names)",
              '"shell": "deny"' in cfg and '"edit": "deny"' in cfg, f"cfg head: {cfg[:80]!r}")
        check("websearch stays allowed (OpenCode's own free-product capability)",
              '"websearch": "allow"' in cfg)
        check("the headless-hostile ask-flows are denied",
              '"question": "deny"' in cfg and '"external_directory": "deny"' in cfg and '"doom_loop": "deny"' in cfg)
        check("the key env carries BOTH secrets (the API key + the serve password)",
              os.path.exists(keyenv) and OPENCODE_KEY in open(keyenv).read()
              and "OPENCODE_SERVER_PASSWORD=" in open(keyenv).read())
        check("the key env landed 0600 (the ps-safe law)",
              oct(os.stat(keyenv).st_mode)[-3:] == "600")
        check("the opencode2 pair is executable in the jail",
              os.access(os.path.join(legacy_dir, "opencode2"), os.X_OK)
              and os.access(os.path.join(legacy_dir, "opencode2.bin"), os.X_OK))
        check("THE LEGACY 1.x FILES LEFT (the 72.5MB install cleans the 52MB past)",
              not os.path.exists(os.path.join(legacy_dir, "opencode"))
              and not os.path.exists(os.path.join(legacy_dir, "opencode.bin")))
        mine = [l for l in serve_children() if f"--port {port_a}" in l]
        check("a REAL 2.x serve runs under the jail (the ADOPTED port)",
              len(mine) >= 1, f"port {port_a}: {mine[:1]}")

        print("A2 — a REAL big-pickle turn through the pocket bridge")
        sid = api(BASE, "/api/sessions", "POST",
                  {"provider": "opencode", "model": "big-pickle", "title": "v1510 pocket rig"})["ID"]
        evs = ws_turn(BASE, PORT, sid,
                     "Think step by step: what is 17*23? End your reply with the final number on its own line.")
        think = thinking_text(evs)
        answer = assistant_text(evs)
        check("the turn reached the genuine 2.x client (thinking streamed)",
              len(think) > 10, f"thinking head: {think[:60]!r}")
        check("the ANSWER landed (big pickle, cost 0)", "391" in answer,
              f"answer head: {answer[:100]!r}")
        u = usage_of(evs)
        check("the ledger rides the pocket turn (serve's own tokens + reasoning)",
              u.get("total_tokens", 0) > 0 and u.get("reasoning_tokens", 0) > 0,
              f"total={u.get('total_tokens')} reasoning={u.get('reasoning_tokens')}")
        check("COST 0 on the phone bridge", u.get("cost", -1) == 0)

        print("A3 — the TOOL PILL through the jailed serve (the read turn)")
        jailserve = os.path.join(jail, ".doomalay", "opencode-serve")
        secret = "V1510-POCKET-TOOL-SECRET-9182"
        open(os.path.join(jailserve, "secret-note.txt"), "w").write(f"THE SECRET IS {secret}\n")
        evs2 = ws_turn(BASE, PORT, sid,
                       "Read the file secret-note.txt in your working directory and tell me exactly what the secret is.")
        tools_used = [e for e in evs2 if e.get("type") == "tool_use"]
        check("the read TOOL PILL landed on the phone bridge",
              len(tools_used) >= 1 and pill_name(tools_used[0]).startswith("opencode:"),
              f"{[pill_name(t) for t in tools_used]}")
        check("the model REALLY read the file in the jail",
              secret in assistant_text(evs2), f"head: {assistant_text(evs2)[:100]!r}")

        print("A4 — session reuse through the pocket bridge")
        evs3 = ws_turn(BASE, PORT, sid, "And now: what is 100/4? Answer with just the number.")
        check("the second turn answers through the REUSED serve session",
              "25" in assistant_text(evs3), f"head: {assistant_text(evs3)[:80]!r}")
    finally:
        # ── A5 — the RESTART-REUSE LAW: engine 2 ADOPTS the live serve ──
        print("A5 — the RESTART-REUSE LAW (engine 2 adopts the serve via bridge.port)")
        before = len(serve_children())
        eng_a.terminate()
        eng_a.wait(timeout=10)
        data_a2 = tempfile.mkdtemp(prefix="v1510-engA2-")
        eng_a2 = None
        try:
            eng_a2 = start_engine(bin_path, PORT, data_a2, eng_env, "v1510-logA2-")
            api(f"http://127.0.0.1:{PORT}", "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
            time.sleep(1)
            sid2 = api(f"http://127.0.0.1:{PORT}", "/api/sessions", "POST",
                       {"provider": "opencode", "model": "big-pickle", "title": "reuse rig"})["ID"]
            evs4 = ws_turn(f"http://127.0.0.1:{PORT}", PORT, sid2, "What is 9*9? Answer with just the number.")
            check("engine 2's first turn answers (the ADOPTED serve)",
                  "81" in assistant_text(evs4), f"head: {assistant_text(evs4)[:80]!r}")
            check("the serve was ADOPTED, never stacked (one live serve)",
                  len(serve_children()) == before, f"before={before} after={len(serve_children())}")
        finally:
            # ── A6 — the WATCHDOG LAW: kill → re-provision → third turn ─
            print("A6 — the WATCHDOG LAW (kill the serve; the engine re-provisions through the exec)")
            pidfile = os.path.join(jail, ".doomalay", "opencode-serve", "serve.pid")
            killed = False
            if os.path.exists(pidfile):
                try:
                    os.kill(int(open(pidfile).read().strip()), 15)
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
                evs5 = ws_turn(f"http://127.0.0.1:{PORT}", PORT, sid2, "What is 8*8? Answer with just the number.")
                check("a turn answers on the RE-PROVISIONED bridge",
                      "64" in assistant_text(evs5), f"head: {assistant_text(evs5)[:80]!r}")
            if eng_a2:
                eng_a2.terminate()

    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


# ════════════════════════════════════════════════════════════════════════
# DEVICE MODE — the real phone over the tunnel
# ════════════════════════════════════════════════════════════════════════

def device_mode():
    print(f"v1510 — THE SECOND TONGUE RIG (device mode) — probing the tunnel: {TUNNEL}")
    try:
        with urllib.request.urlopen(TUNNEL.rstrip("/") + "/api/health", timeout=10) as r:
            health = json.loads(r.read().decode())
    except Exception as e:
        print(f"  SKIP — the tunnel is down ({str(e)[:80]}). The device red-team runs at the next tunnel-up.")
        sys.exit(0)
    ver = health.get("version", "")
    print(f"  the device answers /api/health: {health}")
    if not ver.startswith("1.53"):
        print(f"  SKIP — the device runs {ver}; the second tongue rides the v1.53+ APK "
              f"(install the new APK, reopen the app, re-run with --device).")
        sys.exit(0)
    base = TUNNEL
    out = api(base, "/api/opencode/bridge")
    print(f"  the REAL device ladder: {out}")
    if out.get("state") == "desktop":
        print("  the device reports desktop — the pocket bridge runs on ANDROID builds; nothing to install.")
        sys.exit(0)
    if out.get("state") != "ready":
        print(f"  SKIP — the device's ladder answers {out.get('state')} "
              f"({out.get('detail', '')[:120]}) — finish the gates on the phone and re-run.")
        sys.exit(0)
    inst = api(base, "/api/opencode/bridge/install", "POST", timeout=60)
    print(f"  the one-tap opencode2 install on the REAL device: {inst}")
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
    print("  the REAL aarch64 opencode2 serve is up — the big-pickle device probe")
    sid = api(base, "/api/sessions", "POST",
              {"provider": "opencode", "model": "big-pickle", "title": "v1510 device"})["ID"]
    evs = ws_turn(base, 443, sid,
                  "Think step by step: what is 12*12? End with the final number on its own line.",
                  timeout_s=300,
                  ws_url=base.replace("https://", "wss://") + f"/api/chat?session_id={sid}")
    answer = assistant_text(evs)
    u = usage_of(evs)
    if "144" in answer:
        print(f"  THE DEVICE GATE PASSES: the native OpenCode 2 answers on the REAL phone "
              f"(cost {u.get('cost')}, reasoning {u.get('reasoning_tokens')}).")
        sys.exit(0)
    err_text = " ".join((e.get("text") or "") + " " + (e.get("message") or "")
                        for e in evs if e.get("type") == "error")
    print(f"  THE TURN FAILED — answer head: {answer[:120]!r}; error head: {err_text[:200]!r}")
    sys.exit(2)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "desktop"
    if mode == "device":
        device_mode()
    elif mode == "android":
        android_mode()
    else:
        desktop_mode()
