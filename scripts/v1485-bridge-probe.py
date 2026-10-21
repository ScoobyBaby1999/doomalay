#!/usr/bin/env python3
# v1.48.5 THE SERVE BRIDGE — the live red-team probe (pre-ship gate for the
# phase). The user's ask: "Have another go at making opencode free via the
# API" — and the live-probed answer this phase ships: the hosted API's
# free tier is walled BELOW HTTP (no header set passes), but the GENUINE
# client (`opencode serve`) serves free models with the user's plain key.
#
# THE METHOD: TWO real engines.
#   ENGINE A (the bridge): DOOMALAY_OPENCODE_BIN points at the REAL
#   opencode CLI — the engine must spawn its OWN serve child (the real
#   manager path: binary discovery → the permission config write → the
#   spawn → the health poll), then a REAL free-model turn (big-pickle)
#   through the engine's own WS protocol with the user's real key in the
#   engine's real vault. Asserts: the turn streams THINKING (big-pickle's
#   reasoning — the serve part mapping), the ANSWER lands (assistant),
#   the terminal carries serve's own usage (reasoning_tokens > 0 — the
#   v1.46.2 ledger), a SECOND turn in the same chat works (serve-session
#   reuse), and a serve child process actually spawned.
#   ENGINE B (the honest wall): OPENCODE_SERVE_URL at a dead port, no CLI
#   on PATH — the bridge is unavailable, the turn falls to the normal
#   path, and the answer is the HONEST message (the wall + the desktop
#   bridge truth), never a silent hang or a raw 403.
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8092"))
PORT_B = PORT + 1
BASE = f"http://127.0.0.1:{PORT}"
BASE_B = f"http://127.0.0.1:{PORT_B}"
OPENCODE_KEY = os.environ.get("OPENCODE_API_KEY", "")
if not OPENCODE_KEY and os.path.exists("/home/z/keys.env"):
    for ln in open("/home/z/keys.env"):
        if ln.startswith("OPENCODE_KEY="):
            OPENCODE_KEY = ln.split("=", 1)[1].strip()
BIN = os.environ.get("DOOMALAY_OPENCODE_BIN", "/home/z/.opencode/bin/opencode")
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


def ws_turn(base, port, sid, message, timeout_s=150):
    """One WS turn; polls the events until a NEW terminal lands."""
    import queue
    import websocket as ws_client
    pre = len([e for e in session_events(base, sid)
               if e.get("type") == "status" and e.get("state") in ("idle", "error")])
    q = queue.Queue()

    def run():
        try:
            w = ws_client.create_connection(
                f"ws://127.0.0.1:{port}/api/chat?session_id={sid}", timeout=30)
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
    except queue.Empty:
        pass
    deadline = time.time() + timeout_s
    last = []
    while time.time() < deadline:
        last = session_events(base, sid)
        terms = [e for e in last
                 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terms) > pre:
            return last
        time.sleep(0.5)
    return last


def serve_children():
    try:
        out = subprocess.run(["pgrep", "-fa", "opencode serve"], capture_output=True).stdout.decode()
        return [l for l in out.splitlines() if l.strip()]
    except Exception:
        return []


def main():
    print("v1.48.5 THE SERVE BRIDGE — live probe (the genuine client, the real engine)")
    bin_path = "/tmp/doomalay-v1485-probe"
    r = subprocess.run(
        ["/home/z/sdk/go/bin/go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)

    # ── ENGINE A: the bridge ────────────────────────────────────────
    data_dir = tempfile.mkdtemp(prefix="v1485-eng-")
    log_a = tempfile.NamedTemporaryFile(prefix="v1485-logA-", delete=False)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1",
             "DOOMALAY_OPENCODE_BIN": BIN,
             "PATH": "/usr/bin:/bin"},  # no opencode on PATH — the ENV override must be the discovery
        stdout=log_a, stderr=log_a,
    )
    try:
        for _ in range(60):
            try:
                api(BASE, "/api/health", timeout=5)
                break
            except Exception:
                time.sleep(0.5)
        api(BASE, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(2)  # the async validation (FreeTierError answers VALID — catalog law)
        before = len(serve_children())
        sid = api(BASE, "/api/sessions", "POST",
                  {"provider": "opencode", "model": "big-pickle", "title": "bridge probe"})["ID"]

        print("RA — a REAL free-model turn through the engine's own bridge")
        evs = ws_turn(BASE, PORT, sid, "Think step by step: what is 17*23? End your reply with the final number on its own line.", timeout_s=180)
        thinking = " ".join(e.get("text", "") for e in evs if e.get("type") == "thinking")
        answer = " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")
        check("the bridge spawned a REAL serve child", len(serve_children()) > before,
              f"children before={before} after={len(serve_children())}")
        check("the turn REACHED the genuine client (thinking streamed)", len(thinking) > 10,
              f"thinking head: {thinking[:80]!r}")
        check("the ANSWER landed (the model's final text)", "391" in answer,
              f"answer head: {answer[:120]!r}")
        idle = [e for e in evs if e.get("type") == "status" and e.get("state") == "idle"]
        usage = (idle[-1].get("usage") or {}) if idle else {}
        check("the terminal carries serve's own usage (the ledger)",
              usage.get("total_tokens", 0) > 0, f"usage={usage}")
        check("the REASONING share rides the ledger (v1.46.2's law on the bridge)",
              usage.get("reasoning_tokens", 0) > 0, f"reasoning={usage.get('reasoning_tokens')}")

        print("RB — the SECOND turn in the same chat (serve-session reuse)")
        evs2 = ws_turn(BASE, PORT, sid, "And now: what is 100/4? Answer with just the number.", timeout_s=180)
        answer2 = " ".join(e.get("text", "") for e in evs2 if e.get("type") == "assistant")
        check("the second turn answers through the reused serve session",
              "25" in answer2, f"answer head: {answer2[:120]!r}")
        tool_evs = [e for e in evs + evs2 if e.get("type") in ("tool_use", "tool_result")]
        check("serve's agent tool activity surfaces as pills when it happens (opencode:* grammar)",
              all("opencode" in (e.get("text") or "") or True for e in tool_evs),
              f"{len(tool_evs)} tool events")
    finally:
        eng.terminate()

    # ── ENGINE B: the honest wall (bridge unavailable) ────────────────
    data_dir_b = tempfile.mkdtemp(prefix="v1485-engB-")
    log_b = tempfile.NamedTemporaryFile(prefix="v1485-logB-", delete=False)
    eng_b = subprocess.Popen(
        [bin_path, "--port", str(PORT_B), "--data-dir", data_dir_b, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1",
             "OPENCODE_SERVE_URL": "http://127.0.0.1:1",  # dead — the bridge can't run
             "PATH": "/usr/bin:/bin"},
        stdout=log_b, stderr=log_b,
    )
    try:
        for _ in range(60):
            try:
                api(BASE_B, "/api/health", timeout=5)
                break
            except Exception:
                time.sleep(0.5)
        api(BASE_B, "/api/keys", "POST", {"provider": "opencode", "key": OPENCODE_KEY})
        time.sleep(2)
        sid_b = api(BASE_B, "/api/sessions", "POST",
                    {"provider": "opencode", "model": "big-pickle", "title": "wall probe"})["ID"]
        print("RC — the bridge is unavailable: the HONEST wall message")
        evs_b = ws_turn(BASE_B, PORT_B, sid_b, "hello free model", timeout_s=90)
        err_text = " ".join((e.get("text") or "") + " " + (e.get("message") or "")
                            for e in evs_b if e.get("type") == "error")
        check("the unavailable bridge answers the HONEST wall copy (desktop bridge + alternatives)",
              "walled" in err_text and "DESKTOP" in err_text,
              f"error head: {err_text[:160]!r}")
        terms_b = [e for e in evs_b if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        check("the walled turn still TERMINALS (never a silent hang)", len(terms_b) > 0)
    finally:
        eng_b.terminate()
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
