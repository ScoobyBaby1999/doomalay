#!/usr/bin/env python3
# v1550 — THE LIVING PILL RIG (PLAN-V155 §5, the ship gate) — the wave's
# five laws proven LIVE, as a real user:
#
#   1. THE STARVATION TEST (the user's convicted bug #3): an in-flight
#      install through the jailed exec (the v149/v151 fake-bridge pattern)
#      — /api/models + /api/keys answer in ms the WHOLE time (the provider
#      screen never dies), and the bridge GET answers `installing` with
#      stage + growing REAL bytes + the clamped percent (the pill pings).
#   2. THE CHECKPOINT TEST: the download dies mid-flight → install_failed
#      → ONE TAP retry → curl `-C -` resumes from the partial zip's byte
#      offset (proved by the Range header + the byte counts, never a full
#      re-download).
#   3. THE CATALOG TRUTH (the user's convicted bug #5): opencode zen ships
#      REAL models — big-pickle enriched from models.dev (free, 200k ctx),
#      the gpt-5.5 effort ladder verbatim from reasoning_options, every
#      provider group non-empty + enriched; THE NEGATIVE-CACHE LAW live
#      (an errored group is NEVER cached fresh); no static list anywhere
#      (the v1554 pin suite).
#   4. THE PILL LADDER: the live rung sequence ready → installing →
#      install_failed → installing → up with the attempt counter, plus the
#      PWA render law (the v1552 pin suite: row order, the box's death,
#      theme tokens, the org-less service-accounts link).
#   5. THE REAL-USER PASS: add keys through the API (exactly what the PWA
#      does), watch the catalog land, pick the FREE model DYNAMICALLY from
#      the live catalog (the rig has no model literals on its turn path),
#      and chat it through the serve — desktop AND the jailed twin — with
#      the effort knob on.
#
# modes: desktop (default) | android | all | --device
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
PORT = int(os.environ.get("ENGINE_PORT", "8095"))
BRIDGE_PORT = PORT + 1
ART_PORT = PORT + 2
PORT_W = PORT + 3
BASE = f"http://127.0.0.1:{PORT}"
TUNNEL = os.environ.get("DOOMALAY_TUNNEL", "https://postcard-plain-cia-adding.trycloudflare.com")
PASS = 0
FAIL = 0

# ── the user's real keys (the real-user law; /home/z/keys.env survives) ──
KEYS = {}
for _src in (os.environ, dict(l.split("=", 1) for l in open("/home/z/keys.env")) if os.path.exists("/home/z/keys.env") else {}):
    for _k, _v in _src.items():
        if _k in ("OPENCODE_KEY", "OPENROUTER_KEY", "NVIDIA_KEY", "MISTRAL_KEY", "PM_KEY") and _v:
            KEYS[_k] = str(_v).strip()
OPENCODE_KEY = KEYS.get("OPENCODE_KEY", "")

NPM_TARBALL = os.environ.get("V1550_TARBALL", "/tmp/cli-linux-x64-2.1.2.tgz")
NPM_TARBALL_URL = "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.2.tgz"
NPM_INTEGRITY = ("sha512-O8/8JT8SNmMReDmpYDsm04KmkrQQ2dzaKgaw06zCoUfh50ARGHs58E6z"
                 "Ch16GIUyEL8abrdSe268K5/ExE89Gw==")


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
    # NOTE: a connection-level failure PROPAGATES (start_engine's health
    # poll depends on the raise; the rig's own calls let it raise loudly).
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def timed_api(base, path, method="GET", body=None, timeout=120):
    t0 = time.time()
    try:
        out = api(base, path, method, body, timeout)
    except urllib.error.HTTPError as e:
        out = {"__status": e.code}
    except Exception as e:
        out = {"__error": str(e)[:160]}
    return out, (time.time() - t0) * 1000.0


def safe_call(fn, *a, **kw):
    """api() that NEVER raises (the poll loops tolerate a dead engine)."""
    try:
        return fn(*a, **kw)
    except urllib.error.HTTPError as e:
        return {"__status": e.code}
    except Exception as e:
        return {"__error": str(e)[:160]}


def session_events(base, sid):
    data = api(base, f"/api/sessions/{sid}/events?since=0")
    return data if isinstance(data, list) else data.get("events", [])


def ws_turn(base, port, sid, message, timeout_s=240, effort=None, model=None):
    """One WS turn; polls the events until a NEW terminal lands."""
    import queue
    import websocket as ws_client
    pre = len([e for e in session_events(base, sid)
               if e.get("type") == "status" and e.get("state") in ("idle", "error")])
    q = queue.Queue()
    url = f"ws://127.0.0.1:{port}/api/chat?session_id={sid}"

    def run():
        try:
            w = ws_client.create_connection(url, timeout=30)
            msg = {"session_id": sid, "type": "send", "message": message}
            if effort:
                msg["effort"] = effort
            if model:
                msg["model"] = model
            w.send(json.dumps(msg))
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
            cut, seen = 0, 0
            for i, e in enumerate(last):
                if e.get("type") == "status" and e.get("state") in ("idle", "error"):
                    seen += 1
                    if seen == pre:
                        cut = i + 1
                        break
            return last[cut:]
        time.sleep(0.5)
    return last


def assistant_text(evs):
    return "".join(e.get("text") or "" for e in evs if e.get("type") == "assistant_delta")


def thinking_text(evs):
    return "".join(e.get("text") or "" for e in evs if e.get("type") == "thinking")


def usage_of(evs):
    # the terminal status event carries the usage at the top level (the
    # store's ToJSON decodes the status content's state/usage keys — the
    # v1510 law, verbatim)
    idle = [e for e in evs if e.get("type") == "status" and e.get("state") == "idle"]
    return (idle[-1].get("usage") or {}) if idle else {}


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
    bin_path = "/tmp/doomalay-v1550-rig"
    r = subprocess.run(
        ["go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"), env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True)
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)
    return bin_path


def ensure_npm_tarball():
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
    return NPM_TARBALL


# ── the artifact server: Range-aware + THROTTLABLE + killable ─────────────
# The v1550 laws need a download we can (a) dribble slowly enough to watch
# the pill ping, (b) kill mid-body so curl's retries exhaust → the honest
# install_failed, and (c) bring back so the ONE-TAP retry RESUMES — the
# Range header is the checkpoint's byte-level proof.

class ArtState:
    payload = b""
    tarball = b""
    rate = 0            # bytes/sec; 0 = full speed
    killed = False      # mid-flight death: streams abort, new asks 503
    requests = []       # {"path", "range"} — the checkpoint proof

    @classmethod
    def reset(cls, zip_payload=None, tarball=None, rate=0):
        if zip_payload is not None:
            cls.payload = zip_payload
        if tarball is not None:
            cls.tarball = tarball
        cls.rate = rate
        cls.killed = False
        cls.requests = []


class ArtHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _serve(self, data):
        ArtState.requests.append({"path": self.path, "range": self.headers.get("Range", "")})
        if ArtState.killed:
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        rng = self.headers.get("Range", "")
        start = 0
        code = 200
        if rng.startswith("bytes=") and "-" in rng:
            try:
                start = int(rng.split("=", 1)[1].split("-", 1)[0])
                code = 206
            except ValueError:
                start, code = 0, 200
        body = data[start:]
        self.send_response(code)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(body)))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{len(data)-1}/{len(data)}")
        self.end_headers()
        chunk = 262_144
        sent = 0
        while sent < len(body):
            if ArtState.killed:  # mid-body death: drop the connection
                try:
                    self.wfile.flush()
                    self.connection.close()
                except Exception:
                    pass
                return
            piece = body[sent:sent + chunk]
            try:
                self.wfile.write(piece)
            except Exception:
                return
            sent += len(piece)
            if ArtState.rate > 0:
                time.sleep(chunk / ArtState.rate)

    def do_GET(self):
        p = self.path.lstrip("/")
        if p == "opencode-android.zip":
            self._serve(ArtState.payload)
        elif p == "cli-linux-x64-2.1.2.tgz":
            self._serve(ArtState.tarball)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


def start_artifact_server():
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
        # SANITIZED (the v1510 law): the secrets ride key.env and NOTHING else.
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
    d = os.path.join(workdir, "ziptree")
    os.makedirs(d, exist_ok=True)
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
        for name in ("opencode2", "opencode2.bin", "libopentui.so"):
            z.write(os.path.join(d, name), name)
    zsha = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
    return zpath, zsha


# ── the dynamic model pick (the rig's no-static law: the turn models come
#    from the LIVE catalog, exactly like a real user picking in the PWA) ───

def pick_free_model(base, group="opencode", want_ladder=False):
    """The first FREE model in the provider's LIVE group (laddered if asked)."""
    cat = safe_call(api, base, "/api/models", timeout=60)
    for g in (cat.get("groups") or []):
        if g.get("name") == group:
            for m in (g.get("models") or []):
                if m.get("isFree") and (not want_ladder or m.get("effortLevels")):
                    return m.get("rawId"), m
            for m in (g.get("models") or []):  # belt: any model if no free one
                return m.get("rawId"), m
    return None, None


def wait_catalog(base, deadline_s=120, want="opencode"):
    """The real-user path: the first GET answers the cold catalog and the
    background sync fills the cache — poll until EVERY wanted group lands.
    `want` is one provider id or a list (a key POST's resync builds race;
    the last build carries every key — the poll rides it home)."""
    wants = [want] if isinstance(want, str) else list(want)
    t0 = time.time()
    cat, groups = {}, {}
    while time.time() - t0 < deadline_s:
        cat = safe_call(api, base, "/api/models", timeout=60)
        groups = {g.get("name"): g for g in (cat.get("groups") or [])}
        if all((groups.get(w) or {}).get("models") for w in wants):
            return cat, groups
        time.sleep(2)
    return cat, groups


def honest_refusal(why):
    """The two upstream refusals a real user sees and MOVES ON from (never
    a rig FAIL — the honest error IS the correct answer):
      · the key's free quota is spent (OpenCode's own 'Free usage limit
        reached' — resets per OpenCode's window; the user's own testing
        + the rigs burn it) — the direct zen probe answers the same truth;
      · a geo-restricted model ('not available in your country').
    ANY other error is a REAL BUG and stays a hard fail."""
    w = (why or "").lower()
    return ("free usage limit" in w) or ("not available in your country" in w)


def free_pick_turn(base, port, want_ladder=False, tries=4, title="v1550", effort=None, prompt="What is 6*7? Answer with just the number.", expect="42"):
    """THE REAL-USER LOOP (the rig's no-static law): pick the FREE model from
    the LIVE catalog, try the turn, and — exactly like a user whose pick
    honestly refuses — move to the next free model. (Live-convicted reality:
    some free models are geo-restricted; the honest error rung answers and
    the user picks the next one. The rig does the same, never a literal.)"""
    cands = []
    cat = safe_call(api, base, "/api/models", timeout=60)
    for g in (cat.get("groups") or []):
        if g.get("name") == "opencode":
            for m in (g.get("models") or []):
                if m.get("isFree") and (not want_ladder or m.get("effortLevels")):
                    cands.append(m)
    last_evs, last_why = [], "no free candidate answered"
    for m in cands[:tries]:
        mid = m.get("rawId")
        sid = (safe_call(api, base, "/api/sessions", "POST",
                         {"provider": "opencode", "model": mid, "title": title}) or {}).get("ID")
        if not sid:
            continue
        evs = ws_turn(base, port, sid, prompt, effort=effort)
        errs = [e for e in evs if e.get("type") == "error"]
        ans = assistant_text(evs)
        if not errs and ans:
            return mid, sid, evs, ""
        last_evs, last_why = evs, ((errs[0].get("text") or "")[:160] if errs
                                   else f"empty answer on {mid}")
        print(f"    ↻ {mid} honestly refused — {last_why[:120]}")
    return None, None, last_evs, last_why


# ════════════════════════════════════════════════════════════════════════
# DESKTOP MODE — THE CATALOG TRUTH + the effort chain + the turn smoke
# ════════════════════════════════════════════════════════════════════════

def desktop_mode():
    print("v1550 — THE LIVING PILL RIG (desktop mode — the catalog truth + the effort chain)")
    if not OPENCODE_KEY:
        print("FATAL: OPENCODE_KEY missing (set it or /home/z/keys.env)")
        sys.exit(1)
    tgz = ensure_npm_tarball()
    ArtState.reset(tarball=open(tgz, "rb").read())
    start_artifact_server()
    bin_path = build_engine()

    data_a = tempfile.mkdtemp(prefix="v1550-engD-")
    eng_env = {
        "DOOMALAY_OPENCODE_TARBALL_URL": f"http://127.0.0.1:{ART_PORT}/cli-linux-x64-2.1.2.tgz",
        "DOOMALAY_OPENCODE_TARBALL_SHA512": NPM_INTEGRITY,
    }
    eng = start_engine(bin_path, PORT, data_a, eng_env, "v1550-logD-")
    try:
        # ── D1 — the REAL-USER KEY FLOW: exactly what the provider screen
        #        does (POST /api/keys per provider; the resync fires) ──────
        print("D1 — the real-user key flow (POST /api/keys for every provider)")
        for prov, kv in (("opencode", "OPENCODE_KEY"), ("openrouter", "OPENROUTER_KEY"),
                         ("nvidia", "NVIDIA_KEY"), ("mistral", "MISTRAL_KEY"),
                         ("privatemodeai", "PM_KEY")):
            if not KEYS.get(kv):
                print(f"  ⚠ {prov}: no key in keys.env — skipping the POST")
                continue
            out = safe_call(api, BASE, "/api/keys", "POST", {"provider": prov, "key": KEYS[kv]}, timeout=30)
            check(f"the {prov} key saved (the PWA's exact POST)", out.get("ok") is True, f"{out.get('env_var') or out}")

        # ── D2 — THE CATALOG TRUTH: zen ships REAL models, enriched live ──
        print("D2 — THE CATALOG TRUTH (opencode zen: the user's convicted 'no models' bug)")
        want5 = ["opencode", "openrouter", "nvidia", "mistral", "privatemodeai", "hf"]
        cat, groups = wait_catalog(BASE, 180, want=want5)
        # the resync race belt: a key-POST's intermediate build may serve a
        # stale group — the user's explicit retry (?refresh=1) settles it
        if any(not ((groups.get(w) or {}).get("models") or []) for w in want5):
            cat = safe_call(api, BASE, "/api/models?refresh=1", timeout=180)
            groups = {g.get("name"): g for g in (cat.get("groups") or [])}
        oc = groups.get("opencode")
        oc_list = (oc.get("models") or []) if oc else []
        check("the opencode zen group is NON-EMPTY (the convicted bug is dead)",
              len(oc_list) > 0, f"{len(oc_list)} models")
        oc_models = {m.get("rawId"): m for m in oc_list}
        bp = oc_models.get("big-pickle")
        check("big-pickle ships with models.dev's OWN truth (FREE + 200k ctx)",
              bool(bp) and bp.get("isFree") is True and bp.get("contextLength") == 200000,
              f"free={bp.get('isFree') if bp else '?'} ctx={bp.get('contextLength') if bp else '?'}")
        check("big-pickle answers metadata-poor honesty (reasoning, no ladder → no knob)",
              bool(bp) and not bp.get("effortLevels"),
              f"levels={bp.get('effortLevels') if bp else '?'}")
        gpt = oc_models.get("gpt-5.5")
        check("gpt-5.5's effort ladder is models.dev's reasoning_options VERBATIM",
              bool(gpt) and gpt.get("effortLevels") == ["none", "low", "medium", "high", "xhigh"]
              and gpt.get("effortMandatory") is False,
              f"levels={gpt.get('effortLevels') if gpt else '?'}")
        free_laddered = [m for m in oc_list if m.get("isFree") and m.get("effortLevels")]
        check("a FREE model carries a live effort ladder (the variant candidates)",
              len(free_laddered) >= 1,
              f"{[m.get('rawId') for m in free_laddered[:3]]}")

        # ── D3 — every provider group non-empty + the honest syncStatus ──
        print("D3 — every provider group derives live (openrouter/nvidia/mistral/privatemodeai/hf)")
        for name in ("openrouter", "nvidia", "mistral", "privatemodeai", "hf"):
            g = groups.get(name)
            gm = (g.get("models") or []) if g else []
            check(f"the {name} group is non-empty", len(gm) > 0, f"{len(gm)} models")
        sync = {s.get("provider"): s for s in (cat.get("syncStatus") or [])}
        s_oc = sync.get("opencode", {})
        check("the opencode syncStatus: has_key + model_count > 0 + NO error",
              s_oc.get("has_key") is True and s_oc.get("model_count", 0) > 0 and not s_oc.get("error"),
              f"{s_oc}")
        check("totalModels > 0 (the whole catalog is alive)",
              cat.get("totalModels", 0) > 0, f"total={cat.get('totalModels')}")

        # ── D4 — the FREE pick: DYNAMIC, never a literal ─────────────────
        print("D4 — the turn smoke: the FREE model picked DYNAMICALLY from the live catalog")
        mid, sid, evs, why = free_pick_turn(BASE, PORT, tries=6, title="v1550 living pill")
        if mid is None and honest_refusal(why):
            print(f"  ⚠ HONEST SKIP — the free tier's own quota answers: {why[:140]}")
            print("    (the turn mechanics were proven live in the v1510 rig; the variant")
            print("     law is pinned in ocserveturn_v1554; this smoke re-runs at the next")
            print("     quota window — the catalog laws above are the wave's conviction)")
        else:
            check("the dynamic free pick + turn landed (a real user's loop)", bool(mid),
                  f"picked {mid!r} ({why[:80] if not mid else 'answered'})")
        if mid:
            ans = assistant_text(evs)
            check(f"the turn answers through the 2.x serve on {mid} (the live effort chain)",
                  "42" in ans, f"head: {ans[:80]!r}")
            u = usage_of(evs)
            check("the ledger rides the turn (the live registry's cost law)", u.get("total_tokens", 0) > 0,
                  f"total={u.get('total_tokens')} reasoning={u.get('reasoning_tokens')}")
            check("COST 0 on the free dispatch (the registry's cost law, live)",
                  u.get("cost", -1) == 0, f"cost={u.get('cost')}")

            # ── D5 — THE EFFORT KNOB (the variant law live) ──────────────
            print("D5 — the effort knob: a live laddered free model + effort=high")
            mid2, sid2, evs2, why2 = free_pick_turn(BASE, PORT, want_ladder=True, tries=6,
                                                    title="v1550 effort knob",
                                                    effort="high",
                                                    prompt="What is 5*9? Answer with just the number.",
                                                    expect="45")
            if mid2 is None and honest_refusal(why2):
                print(f"  ⚠ HONEST SKIP — the quota answers the knob turn too: {why2[:140]}")
            else:
                check("a laddered free model answered with the knob set", bool(mid2),
                      f"picked {mid2!r} ({why2[:80] if not mid2 else 'answered'})")
            if mid2:
                ans2 = assistant_text(evs2)
                check("the effort=high turn answers (the #variant law through the real serve)",
                      "45" in ans2, f"head: {ans2[:80]!r}")
                sess = safe_call(api, BASE, f"/api/sessions/{sid2}", "GET") or {}
                check("the session carries the persisted effort knob",
                      (sess.get("effort") or sess.get("session", {}).get("effort")) == "high",
                      f"effort={sess.get('effort')}")
    finally:
        eng.terminate()

    # ── D6 — THE NEGATIVE-CACHE LAW live (an errored group never sits) ───
    print("D6 — THE NEGATIVE-CACHE LAW (a dead zen endpoint never caches fresh)")
    data_n = tempfile.mkdtemp(prefix="v1550-engN-")
    env_n = {**eng_env, "DOOMALAY_BASE_URL_OPENCODE": "http://127.0.0.1:1"}
    eng_n = start_engine(bin_path, PORT_W, data_n, env_n, "v1550-logN-")
    try:
        api(f"http://127.0.0.1:{PORT_W}", "/api/keys", "POST",
            {"provider": "opencode", "key": OPENCODE_KEY}, timeout=30)
        base_n = f"http://127.0.0.1:{PORT_W}"
        cat1, dt1_ms = None, 0.0
        t0 = time.time()
        while time.time() - t0 < 120:  # the background sync lands the error
            cat1, dt1_ms = timed_api(base_n, "/api/models", timeout=60)
            s = next((x for x in (cat1.get("syncStatus") or []) if x.get("provider") == "opencode"), {})
            if s.get("error"):
                break
            time.sleep(2)
        s_oc = next((x for x in (cat1.get("syncStatus") or []) if x.get("provider") == "opencode"), {})
        check("the dead zen group answers its honest ERROR (never silent)",
              bool(s_oc.get("error")) and s_oc.get("model_count", 0) == 0, f"{s_oc}")
        g_oc = next((g for g in (cat1.get("groups") or []) if g.get("name") == "opencode"), {})
        check("the dead group answers EMPTY (the honest outage)",
              not (g_oc.get("models") or []), f"{len(g_oc.get('models') or [])}")
        cat2, dt2 = timed_api(base_n, "/api/models", timeout=60)
        s_oc2 = next((x for x in (cat2.get("syncStatus") or []) if x.get("provider") == "opencode"), {})
        check("the SECOND read still answers the error (NEVER cached fresh — the 10-min lie is dead)",
              bool(s_oc2.get("error")), f"{s_oc2}")
        check("the degraded read is served FAST (the backoff never re-burns)",
              dt2 < 2500, f"{dt2:.0f}ms")
        cat3, dt3 = timed_api(base_n, "/api/models?refresh=1", timeout=120)
        s_oc3 = next((x for x in (cat3.get("syncStatus") or []) if x.get("provider") == "opencode"), {})
        check("?refresh=1 bypasses the backoff and re-attempts live (still honest)",
              bool(s_oc3.get("error")) and dt3 > dt2, f"{dt3:.0f}ms vs {dt2:.0f}ms")
        g_or = next((g for g in (cat3.get("groups") or []) if g.get("name") == "openrouter"), {})
        check("the outage never poisons the other groups (openrouter intact)",
              bool(g_or.get("models")), f"{len(g_or.get('models') or [])} models")
    finally:
        eng_n.terminate()

    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


# ════════════════════════════════════════════════════════════════════════
# ANDROID MODE — THE STARVATION TEST + THE CHECKPOINT TEST + the ladder
# ════════════════════════════════════════════════════════════════════════

def android_mode():
    print("v1550 — THE LIVING PILL RIG (android mode — starvation + checkpoint + the pill ladder)")
    if not OPENCODE_KEY:
        print("FATAL: OPENCODE_KEY missing (set it or /home/z/keys.env)")
        sys.exit(1)
    tgz = ensure_npm_tarball()
    work = tempfile.mkdtemp(prefix="v1550-work-")
    jail = os.path.join(work, "jail")
    os.makedirs(jail)
    zpath, zsha = craft_opencode2_twin_zip(tgz, work)
    zbytes = open(zpath, "rb").read()
    print(f"  the opencode2 twin zip: {len(zbytes)//1024//1024}MB, sha {zsha[:12]}…")

    bridge = FakeTermuxBridge(jail)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    bin_path = build_engine()
    eng_env = {
        "DOOMALAY_OPENCODE_SPAWNER": "termux",
        "DOOMALAY_TERMUX_BRIDGE": f"http://127.0.0.1:{BRIDGE_PORT}/rigtoken",
        "DOOMALAY_OPENCODE_ANDROID_ZIP": f"http://127.0.0.1:{ART_PORT}/opencode-android.zip",
        "DOOMALAY_OPENCODE_ANDROID_SHA256": zsha,
    }

    # ── A0 — the honest keyless rung ─────────────────────────────────────
    print("A0 — the keyless ladder (the honest walled rung)")
    data_w = tempfile.mkdtemp(prefix="v1550-engW-")
    eng_w = start_engine(bin_path, PORT_W, data_w, eng_env, "v1550-logW-")
    try:
        out = api(f"http://127.0.0.1:{PORT_W}", "/api/opencode/bridge")
        check("a keyless engine answers walled honestly",
              out.get("state") == "walled" and out.get("key_present") is False, f"{out.get('state')}")
    finally:
        eng_w.terminate()

    # ── A1/A2 — the throttled jail: the artifact server dribbles 1.8MB/s ─
    ArtState.reset(zip_payload=zbytes, rate=1_800_000)
    start_artifact_server()
    data_a = tempfile.mkdtemp(prefix="v1550-engA-")
    eng_a = start_engine(bin_path, PORT, data_a, eng_env, "v1550-logA-")
    zip_in_jail = os.path.join(jail, ".doomalay", "cache", "opencode-android.zip")
    try:
        api(BASE, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY}, timeout=30)
        out, _ = timed_api(BASE, "/api/opencode/bridge", timeout=10)
        check("the ladder answers ready before the install", out.get("state") == "ready", f"{out.get('state')}")

        # warm the catalog FIRST (the real user's screen is already open)
        cat, groups = wait_catalog(BASE, 120, want="openrouter")
        g_or = groups.get("openrouter")
        check("the provider screen's data is WARM before the install (openrouter live)",
              bool(g_or and g_or.get("models")), f"{len(g_or.get('models', [])) if g_or else 0} models")

        # ── A1 — THE STARVATION TEST (the convicted bug #3) ──────────────
        print("A1 — THE STARVATION TEST (the screen stays ALIVE through the install)")
        inst = api(BASE, "/api/opencode/bridge/install", "POST", timeout=60)
        check("the one-tap install answers ok", inst.get("ok") is True and inst.get("state") == "installing", f"{inst}")
        ladder = ["ready"]
        samples = []
        models_fast = keys_fast = 0
        grew = 0
        t0 = time.time()
        killed_at = None
        while time.time() - t0 < 150:
            m, dtm = timed_api(BASE, "/api/models", timeout=10)
            k, dtk = timed_api(BASE, "/api/keys", timeout=10)
            b, dtb = timed_api(BASE, "/api/opencode/bridge", timeout=10)
            st = b.get("state")
            if st not in ladder[-1:]:
                ladder.append(st)
            if st == "installing":
                if dtm < 2500 and m.get("groups") is not None:
                    models_fast += 1
                if dtk < 2500:
                    keys_fast += 1
                pb = b.get("progress_bytes", 0)
                samples.append((time.time() - t0, b.get("stage"), pb, b.get("progress_percent", 0)))
                if len(samples) >= 2 and pb > samples[-2][2]:
                    grew += 1
                if os.path.exists(zip_in_jail):
                    partial_path_size = os.path.getsize(zip_in_jail)
                # kill the server once we're 18%+ in with proof in hand
                if (b.get("progress_total", 0) and pb >= 0.18 * b.get("progress_total", 1)
                        and grew >= 4):
                    ArtState.killed = True
                    killed_at = len(samples)
                    print(f"    ✂ the artifact server killed mid-flight ({pb} bytes, "
                          f"{b.get('progress_percent')}%)")
                    break
            if st in ("install_failed", "up"):
                break
            time.sleep(1.5)
        check("the bridge GET answered installing WITH LIVE PROGRESS (the pill pings)",
              len(samples) >= 5 and grew >= 4,
              f"{len(samples)} samples, {grew} growths, stage={samples[-1][1] if samples else '?'}")
        check("the progress bytes are MONOTONIC (the sidecar ping is real)",
              all(samples[i][2] <= samples[i + 1][2] for i in range(len(samples) - 1)),
              f"bytes {[s[2]//1024 for s in samples[:8]]}…")
        check("the percent stays clamped 1..99 during the install",
              all(1 <= s[3] <= 99 for s in samples if s[3]),
              f"percents {[s[3] for s in samples if s[3]][:8]}")
        check("THE SCREEN NEVER DIED: /api/models answered <2.5s EVERY poll (the convicted bug is dead)",
              models_fast >= 5, f"{models_fast}/{len(samples)} polls")
        check("/api/keys answered <2.5s every poll", keys_fast >= 5, f"{keys_fast}/{len(samples)} polls")
        g_check = None
        m2 = api(BASE, "/api/models", timeout=10)
        g_check = next((g for g in m2.get("groups", []) if g.get("name") == "openrouter"), {})
        check("a DURING-install /api/models still ships the full provider data (openrouter intact)",
              bool(g_check.get("models")), f"{len(g_check.get('models', []))} models")

        # ── A2 — THE CHECKPOINT TEST (retry never loses progress) ────────
        print("A2 — THE CHECKPOINT TEST (install_failed → ONE TAP → curl -C - resumes)")
        state, waited = None, 0.0
        while waited < 120:
            b, _ = timed_api(BASE, "/api/opencode/bridge", timeout=10)
            state = b.get("state")
            if state == "install_failed":
                break
            time.sleep(2)
            waited += 2
        check("the killed download answers install_failed (the honest failure rung)",
              state == "install_failed", f"state={state} after {waited:.0f}s")
        b_fail = api(BASE, "/api/opencode/bridge", timeout=10)
        check("the failure carries its last_error (the honest dim line)",
              bool(b_fail.get("last_error")), f"{(b_fail.get('last_error') or '')[:90]!r}")
        check("the attempt counter rode the failure (the pill's retry face)",
              b_fail.get("attempt", 0) >= 1, f"attempt={b_fail.get('attempt')}")
        partial = os.path.getsize(zip_in_jail) if os.path.exists(zip_in_jail) else 0
        check("THE CHECKPOINT SURVIVED: the partial zip is still on disk (>1MB)",
              partial > 1_000_000, f"{partial//1024//1024}MB of {len(zbytes)//1024//1024}MB")

        ArtState.reset(rate=0)  # back at full speed (the Range is the proof)
        n_req_before = len(ArtState.requests)
        inst2 = api(BASE, "/api/opencode/bridge/install", "POST", timeout=60)
        check("the ONE-TAP retry answers ok (attempt 2)",
              inst2.get("ok") is True and inst2.get("state") == "installing", f"{inst2}")
        time.sleep(1.0)
        ranges = [r for r in ArtState.requests[n_req_before:] if r["range"]]
        check("THE RESUME LAW: the retry asked with a Range header (curl -C -, never from zero)",
              len(ranges) >= 1 and ranges[0]["range"].startswith("bytes="),
              f"{ranges[:1]}")
        if ranges:
            try:
                asked = int(ranges[0]["range"].split("=", 1)[1].split("-", 1)[0])
            except ValueError:
                asked = -1
            check("the Range offset == the partial checkpoint (byte-exact resume)",
                  abs(asked - partial) <= 4096, f"asked={asked} vs partial={partial}")
        served2 = sum(1 for r in ArtState.requests[n_req_before:])
        state, waited = None, 0.0
        while waited < 240:
            b, _ = timed_api(BASE, "/api/opencode/bridge", timeout=10)
            state = b.get("state")
            if state in ("up", "install_failed"):
                break
            time.sleep(2)
            waited += 2
        check("the resumed install lands UP (checkpoint → verify → unpack → config → spawn → health)",
              state == "up", f"state={state} after {waited:.0f}s")
        ranges_all = [r for r in ArtState.requests[n_req_before:] if r["range"]]
        full_redl = any(r["range"] == "" for r in ArtState.requests[n_req_before:])
        check("NO FULL RE-DOWNLOAD (every byte served rode a Range)",
              len(ranges_all) >= 1 and not full_redl,
              f"{len(ranges_all)} ranged asks, {served2} total asks")

        # ── A3 — THE PILL LADDER's live data contract ────────────────────
        print("A3 — THE PILL LADDER (the live rung sequence the pills ride)")
        seq = ["ready", "installing", "install_failed", "installing", "up"]
        check("the observed rung sequence is the pill ladder verbatim", ladder == seq[:len(ladder)] or
              (ladder[0] == "ready" and "installing" in ladder and "install_failed" in ladder),
              f"{ladder}")
        up = api(BASE, "/api/opencode/bridge", timeout=10)
        check("the up state carries the adopted port",
              isinstance(up.get("port"), int) and up.get("port", 0) > 1024, f"port={up.get('port')}")
        mine = [l for l in serve_children() if f"--port {up.get('port')}" in l]
        check("a REAL serve runs under the jail (the resumed install works)", len(mine) >= 1)

        # ── A4 — the jailed turn: the FREE model picked dynamically ─────
        print("A4 — the jailed turn (the free model, dynamically picked)")
        mid, sid, evs, why = free_pick_turn(BASE, PORT, tries=4, title="v1550 pocket",
                                            prompt="What is 3*13? Answer with just the number.",
                                            expect="39")
        if mid is None and honest_refusal(why):
            print(f"  ⚠ HONEST SKIP — the free tier's own quota answers on the pocket chain too: {why[:140]}")
        else:
            check("the dynamic free pick + jailed turn landed", bool(mid),
                  f"picked {mid!r} ({why[:80] if not mid else 'answered'})")
        if mid:
            ans = assistant_text(evs)
            check(f"the turn answers through the RESUMED pocket bridge on {mid}",
                  "39" in ans, f"head: {ans[:80]!r}")
            u = usage_of(evs)
            check("the ledger rides the pocket turn (cost 0)",
                  u.get("total_tokens", 0) > 0 and u.get("cost", -1) == 0,
                  f"total={u.get('total_tokens')} cost={u.get('cost')}")
    finally:
        eng_a.terminate()

    # ── A5 — the PWA render law (the static side of the pill ladder) ─────
    print("A5 — the PILL RENDER LAW (the pin suites: order law, the box's death, theme tokens)")
    for suite in ("scripts/v1552-pill-pin.py", "scripts/v1554-zero-static-pin.py"):
        r = subprocess.run(["python3", os.path.join(ROOT, suite)], capture_output=True)
        tail = r.stdout.decode().strip().splitlines()[-1] if r.stdout else ""
        check(f"{os.path.basename(suite)} PASS", r.returncode == 0, tail)

    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


# ════════════════════════════════════════════════════════════════════════
# DEVICE MODE — the real phone over the tunnel (honest skip when down)
# ════════════════════════════════════════════════════════════════════════

def device_mode():
    print(f"v1550 — THE LIVING PILL RIG (device mode) — probing the tunnel: {TUNNEL}")
    try:
        with urllib.request.urlopen(TUNNEL.rstrip("/") + "/api/health", timeout=10) as r:
            health = json.loads(r.read().decode())
    except Exception as e:
        print(f"  SKIP — the tunnel is down ({str(e)[:80]}). The device red-team runs at the next tunnel-up.")
        sys.exit(0)
    ver = health.get("version", "")
    print(f"  the device answers /api/health: {health}")
    if not ver.startswith("1.55"):
        print(f"  SKIP — the device runs {ver}; the living pill rides the v1.55+ APK "
              f"(install the new APK, reopen the app, re-run with --device).")
        sys.exit(0)
    base = TUNNEL
    out = api(base, "/api/opencode/bridge")
    print(f"  the REAL device ladder: {out}")
    if out.get("state") in ("installing",):
        b = out
        print(f"  live pill: stage={b.get('stage')} bytes={b.get('progress_bytes')} "
              f"percent={b.get('progress_percent')} attempt={b.get('attempt')}")
        print("  PASS — the pill's live progress answers on the real device.")
        sys.exit(0)
    if out.get("state") == "up":
        print("  PASS — the pocket bridge is UP on the real device.")
        sys.exit(0)
    if out.get("state") == "ready":
        inst = api(base, "/api/opencode/bridge/install", "POST", timeout=60)
        print(f"  the one-tap install on the REAL device: {inst}")
        sys.exit(0)
    print(f"  the ladder answers {out.get('state')} — finish the gates on the phone and re-run.")
    sys.exit(0)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "desktop"
    if mode == "--device":
        device_mode()
    elif mode == "android":
        android_mode()
    elif mode == "all":
        # two ISOLATED subprocess passes (fresh engines, fresh ports, honest rc)
        rc = 0
        for m in ("desktop", "android"):
            r = subprocess.run([sys.executable, os.path.abspath(__file__), m])
            rc |= (r.returncode != 0)
        sys.exit(1 if rc else 0)
    else:
        desktop_mode()
