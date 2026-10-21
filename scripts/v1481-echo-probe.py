#!/usr/bin/env python3
# v1.48.1 THE SINGLE ECHO — the live red-team probe (the pre-ship gate for
# the phase; folded into scripts/v1480-the-seen-signal-rig.py at the proof
# phase). The user's report: "the users messages send twice when talking to
# bots. Each user message is duplicate and sent twice."
#
# THE METHOD — no real provider needed, no flake: a stub OpenAI-compat
# server stands in for the provider (via the engine's own
# DOOMALAY_BASE_URL_OPENROUTER knob) and COUNTS the user rows in the
# incoming payload — the exact wire the model would receive. One turn
# through the engine's own WS chat protocol proves the in-flight message
# rides EXACTLY ONCE (the pre-fix flip measured it twice: the emit
# persisted the row, buildHistoryCompacted picked it up, and the append
# supplied it a second time — [user M, user M] on every provider).
#
# Usage: python3 scripts/v1481-echo-probe.py
#   (expects: buildable tree; runs the engine on a scratch data dir)
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8099"))
STUB_PORT = int(os.environ.get("STUB_PORT", "4599"))
BASE = f"http://127.0.0.1:{PORT}"
STUB = f"http://127.0.0.1:{STUB_PORT}"
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + ok, FAIL + (not ok)


def api(base, path, method="GET", body=None, timeout=90):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def session_events(sid):
    data = api(BASE, f"/api/sessions/{sid}/events?since=0")
    return data if isinstance(data, list) else data.get("events", data.get("data", []))


def ws_turn(sid, message, timeout_s=120):
    """One WS turn over plain websockets; then POLLS the persisted events
    until a NEW terminal state (idle/error) lands — one more than existed
    before the send. The recv loop alone can race an instant stub (the
    events land before the WS reader wakes), and earlier turns' terminals
    are already in the log."""
    import queue
    import websocket as ws_client
    pre = len([e for e in session_events(sid)
               if e.get("type") == "status" and e.get("state") in ("idle", "error")])
    q = queue.Queue()

    def run():
        try:
            w = ws_client.create_connection(
                f"ws://127.0.0.1:{PORT}/api/chat?session_id={sid}", timeout=30)
            w.send(json.dumps({"session_id": sid, "type": "send", "message": message}))
            try:
                w.recv()  # the user echo (or whatever leads) — don't care
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
        got = q.get(timeout=40)
        if got.startswith("err"):
            print("    send error:", got)
    except queue.Empty:
        pass
    # poll events until one more terminal lands (or timeout)
    deadline = time.time() + timeout_s
    last = []
    while time.time() < deadline:
        last = session_events(sid)
        terms = [e for e in last
                 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terms) > pre:
            return last
        time.sleep(0.25)
    return last


# ── the stub provider: counts user rows, replies with the observation ──
STUB_HITS = []


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"object": "list", "data": [{"id": "counter-model", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(n) or b"{}")
        STUB_HITS.append({"path": self.path, "stream": bool(payload.get("stream")),
                          "n_msgs": len(payload.get("messages", []))})
        msgs = payload.get("messages", [])
        counts = {}
        for m in msgs:
            if m.get("role") == "user":
                counts[m.get("content", "")] = counts.get(m.get("content", ""), 0) + 1
        # the reply speaks EVERY observed count: "MARKER:N MARKER2:N"
        obs = " ".join(f"{k}:{v}" for k, v in sorted(counts.items()) if "MARKER" in k)
        text = f"OBS {obs}"
        if payload.get("stream"):
            # the SSE shape the engine's scanSSE parses (OpenAI chunks)
            chunks = [
                {"id": "stub-1", "object": "chat.completion.chunk", "created": 0,
                 "model": "counter-model",
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                {"id": "stub-1", "object": "chat.completion.chunk", "created": 0,
                 "model": "counter-model",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
            ]
            body = ("\n\n".join("data: " + json.dumps(c) for c in chunks) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        reply = {"id": "stub-1", "object": "chat.completion", "created": 0,
                 "model": "counter-model",
                 "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                              "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        body = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    stub = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), StubHandler)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    print("v1.48.1 THE SINGLE ECHO — live probe (stub provider counts the wire)")

    data_dir = tempfile.mkdtemp(prefix="v1481-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1481-log-", delete=False)
    bin_path = "/tmp/doomalay-v1481-probe"
    r = subprocess.run(
        ["/home/z/sdk/go/bin/go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ,
             "DOOMALAY_OTA_DISABLE": "1",
             "DOOMALAY_BASE_URL_OPENROUTER": f"{STUB}/v1"},
        stdout=log, stderr=log,
    )
    try:
        up = False
        for _ in range(60):
            try:
                api(BASE, "/api/health", timeout=5)
                up = True
                break
            except Exception:
                time.sleep(0.5)
        if not up:
            print("FATAL: engine did not start")
            sys.exit(1)
        api(BASE, "/api/keys", "POST", {"provider": "openrouter", "key": "sk-stub-echo-probe"})

        sid = api(BASE, "/api/sessions", "POST",
                  {"provider": "openrouter", "model": "counter-model", "title": "echo probe"})["ID"]

        # RA — the first turn: the in-flight message must ride EXACTLY ONCE
        print("RA — the in-flight message rides the wire exactly once")
        m1 = "MARKER-ONE-7f3a what is the count?"
        evs = ws_turn(sid, m1)
        reply1 = " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")
        ok = f"{m1}:1" in reply1 and f"{m1}:2" not in reply1
        check("first turn: the model-facing payload carries the message exactly once",
              ok, f"reply head: {reply1[:120]}")

        # RB — the second turn in the SAME chat: history + the new in-flight
        # message — each user row exactly once, the prior turn intact.
        print("RB — the second turn: history intact, each message once")
        m2 = "MARKER-TWO-91bd and now this one?"
        evs = ws_turn(sid, m2)
        reply2 = " ".join(e.get("text", "") for e in evs if e.get("type") == "assistant")
        check("second turn: the new message rides exactly once",
              f"{m2}:1" in reply2 and f"{m2}:2" not in reply2, f"reply head: {reply2[:160]}")
        check("second turn: the PRIOR user message still rides exactly once",
              f"{m1}:1" in reply2 and f"{m1}:2" not in reply2, f"reply head: {reply2[:160]}")

        # RC — the persisted transcript: one user row per send (the UI's
        # transcript was never doubled — the bug was on the model wire).
        users = [e for e in session_events(sid) if e.get("type") == "user"]
        check("transcript: exactly 2 user rows for 2 sends", len(users) == 2,
              f"got {len(users)}")
    finally:
        if FAIL:
            try:
                log.flush()
                tail = open(log.name, "rb").read().decode(errors="replace")[-3000:]
                print("--- engine log tail ---")
                print(tail)
            except Exception:
                pass
        print("--- stub hits:", json.dumps(STUB_HITS))
        eng.terminate()
        stub.shutdown()
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
