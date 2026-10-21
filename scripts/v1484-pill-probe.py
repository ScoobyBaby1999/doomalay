#!/usr/bin/env python3
# v1.48.4 THE INFORMATIVE PILL — the live red-team probe (pre-ship gate for
# the phase). The user's ask: "The workspace tool is still not clear when
# the pill is collapsed, it's still an ambiguous collapsed pill when the
# workspace tool is used, other tools are much more clear. How about,
# instead of showing a static workspace title followed by a simple
# formatted description of the file being read or whatever for the
# workspace tool calls, we replace the workspace static text with a
# dynamic text of the action being used (grep, view, ext..) and include
# the 'what' parameter aswell in the collapsed pill description."
#
# THE METHOD: a real engine + a real browser page + a stub provider that
# issues a REAL OpenAI tool_call (workspace grep, query "readme") — the
# engine executes the REAL workspace tool against a REAL bound repo
# (octocat/Hello-World, the user's token), and the chat's OWN pill renders
# the call in the panel the user reads. The assertion reads the collapsed
# pill's OWN DOM (.tool-pill-name = the verb, .tool-pill-text = the
# operand). The pre-fix flip (stashed chatpanel.js): the pill renders the
# static 'workspace' title + the repo summary — the ambiguous pill the
# user complained about, convicted live.
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
PORT = int(os.environ.get("ENGINE_PORT", "8096"))
STUB_PORT = int(os.environ.get("STUB_PORT", "4598"))
BASE = f"http://127.0.0.1:{PORT}"
STUB = f"http://127.0.0.1:{STUB_PORT}"
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not GH_TOKEN and os.path.exists("/home/z/keys.env"):
    for ln in open("/home/z/keys.env"):
        if ln.startswith("GITHUB_TOKEN="):
            GH_TOKEN = ln.split("=", 1)[1].strip()
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + ok, FAIL + (not ok)


def api(path, method="GET", body=None, timeout=120):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"__status": e.code, "__body": e.read().decode()[:200]}


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"object": "list", "data": [{"id": "openai/gpt-4o", "object": "model"}]}).encode()
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
        msgs = payload.get("messages", [])
        has_tools = bool(payload.get("tools"))
        has_tool_result = any(m.get("role") == "tool" for m in msgs)
        chunks = []
        if has_tools and not has_tool_result:
            # the FIRST round: a real OpenAI tool_call — workspace grep
            args = json.dumps({"action": "grep", "ws": "octocat/Hello-World", "query": "readme"})
            chunks.append({"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "openai/gpt-4o",
                           "choices": [{"index": 0, "finish_reason": None, "delta": {"role": "assistant",
                             "tool_calls": [{"index": 0, "id": "call_probe1", "type": "function",
                                             "function": {"name": "workspace", "arguments": args}}]}}]})
            chunks.append({"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "openai/gpt-4o",
                           "choices": [{"index": 0, "finish_reason": "tool_calls", "delta": {}}],
                           "usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}})
        else:
            text = "FINAL-OK the grep is complete."
            chunks.append({"id": "c2", "object": "chat.completion.chunk", "created": 0, "model": "openai/gpt-4o",
                           "choices": [{"index": 0, "finish_reason": None, "delta": {"role": "assistant", "content": text}}]})
            chunks.append({"id": "c2", "object": "chat.completion.chunk", "created": 0, "model": "openai/gpt-4o",
                           "choices": [{"index": 0, "finish_reason": "stop", "delta": {}}],
                           "usage": {"prompt_tokens": 120, "completion_tokens": 8, "total_tokens": 128}})
        body = ("\n\n".join("data: " + json.dumps(c) for c in chunks) + "\n\ndata: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    stub = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), StubHandler)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    print("v1.48.4 THE INFORMATIVE PILL — live probe (real tool call, real pill DOM)")
    data_dir = tempfile.mkdtemp(prefix="v1484-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1484-log-", delete=False)
    bin_path = "/tmp/doomalay-v1484-probe"
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
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1",
             "DOOMALAY_BASE_URL_OPENROUTER": f"{STUB}/v1"},
        stdout=log, stderr=log,
    )
    pw = None
    try:
        for _ in range(60):
            try:
                api("/api/health", timeout=5)
                break
            except Exception:
                time.sleep(0.5)
        api("/api/keys", "POST", {"provider": "openrouter", "key": "sk-stub-pill-probe"})
        time.sleep(1.5)  # the async key validation (the stub answers it)

        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page(viewport={"width": 1280, "height": 800})
        page.goto(BASE + "/")
        page.wait_for_function("window.__doomalayReady === true", timeout=30000)
        page.wait_for_timeout(800)

        # one chat the real way + a session bound with a tools-capable model
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(600)
        sid = api("/api/sessions", "POST",
                  {"provider": "openrouter", "model": "openai/gpt-4o", "title": "pill"})["ID"]
        page.evaluate(
            """(sid) => {
                const c = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
                c.sessionId = sid; c.save(); return true;
            }""", sid)
        # a REAL workspace bound to the chat (the tool's gate + target)
        ws = api("/api/workspaces/connect", "POST",
                 {"url": "https://github.com/octocat/Hello-World", "session_id": sid, "token": GH_TOKEN})
        if "__status" in ws:
            print("FATAL: workspace connect failed:", ws)
            sys.exit(1)
        check("real workspace bound to the chat", True)

        # open the chat panel + hydrate the chat state the way the REAL
        # model-connect flow does (state.model = the picked slot — the
        # composer's isFulfilled gate), then re-open via the exposed rig
        # path (global-search jump's own API) so the panel re-renders
        # with the composer; then the REAL UI send
        page.evaluate(
            """(sid) => {
                const icon = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
                const st = window.ChatPanel.getState(icon.id);
                if (st) { st.sessionId = sid; st.provider = 'openrouter'; st.model = 'openai/gpt-4o'; }
                return window.doomalay.openChatBySession(sid);
            }""", sid)
        page.wait_for_function("!!document.getElementById('chat-input')", timeout=15000)
        page.wait_for_timeout(400)
        page.fill("#chat-input", "grep the readme please")
        page.click("#chat-send")

        # wait for the turn: the pill renders on tool_use; the turn ends on idle
        pre_terms = 0
        pill = {}
        for _ in range(80):
            time.sleep(0.25)
            evs = api(f"/api/sessions/{sid}/events?since=0")
            evs = evs if isinstance(evs, list) else evs.get("events", [])
            terms = len([e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")])
            has_tool = any(e.get("type") == "tool_use" for e in evs)
            if has_tool:
                pill = page.evaluate(
                    """(() => {
                        const names = Array.from(document.querySelectorAll('#chat-messages .tool-pill-name')).map(n => n.textContent);
                        const texts = Array.from(document.querySelectorAll('#chat-messages .tool-pill-text')).map(n => n.textContent);
                        return { names: names, texts: texts };
                    })()""")
            if terms > pre_terms and has_tool and pill:
                break
        check("the workspace tool REALLY ran (tool_use event)", has_tool)
        name = (pill.get("names") or [""])[0]
        text = (pill.get("texts") or [""])[0]
        check("THE PILL SPEAKS THE VERB (title = 'grep')", name == "grep", f"name={name!r}")
        check("THE PILL CARRIES THE OPERAND (body = the query)",
              "readme" in text.lower(), f"text={text[:80]!r}")
        evs = api(f"/api/sessions/{sid}/events?since=0")
        evs = evs if isinstance(evs, list) else evs.get("events", [])
        check("the turn completed (final answer landed)",
              any("FINAL-OK" in (e.get("text") or "") for e in evs if e.get("type") == "assistant"))
    finally:
        try:
            pw.stop()
        except Exception:
            pass
        eng.terminate()
        stub.shutdown()
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
