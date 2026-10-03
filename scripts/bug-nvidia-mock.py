#!/usr/bin/env python3
"""bug-nvidia-mock.py — a mock OpenAI-compatible SSE provider that emits a
REAL two-round native tool chain (round 1: reasoning + prose + tool_calls;
round 2: reasoning + final prose), for driving the engine's WS wire capture.
Port arg: the listen port."""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8531
N = [0]


def sse(handler, events):
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.end_headers()
    for ev in events:
        handler.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
    handler.wfile.write(b"data: [DONE]\n\n")


def chunk(delta=None, finish=None, usage=None):
    c = {"choices": [{"delta": delta or {}, "index": 0}]}
    if finish:
        c["choices"][0]["finish_reason"] = finish
    if usage:
        c["usage"] = usage
    return c


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"data": [
                {"id": "z-ai/glm-5.3-flash", "max_context_length": 131072,
                 "capabilities": {"function_calling": True}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(ln) or b"{}")
        msgs = req.get("messages") or []
        tool_rounds = sum(1 for m in msgs if m.get("role") == "tool")
        # v0.95.4 rig mode: a message containing "dsml" makes the mock emit
        # deepseek-style native tool markup AS CONTENT (no tool_calls array
        # — the live leak shape: markup in the visible stream, calls lost).
        first_user = next((m.get("content", "") for m in msgs if m.get("role") == "user"), "")
        if "dsml" in str(first_user).lower() and tool_rounds == 0:
            sse(self, [
                chunk({"content": "I will run the calculator now.\n<｜DSML｜calls>\n<｜DSML｜invoke name=\"calculator\">\n<｜DSML｜parameter name=\"expression\">2+2*10<｜DSML｜/parameter>\n<｜DSML｜/invoke>\n<｜DSML｜/calls>"}),
                chunk(None, "stop", {"prompt_tokens": 5, "completion_tokens": 25, "total_tokens": 30}),
            ])
            return
        # litellm (brain path) or the engine (direct path) — same mock shape
        N[0] += 1
        if tool_rounds < 3:
            # ROUNDS 1-3: reasoning → prose narration → calculator call
            sse(self, [
                chunk({"reasoning_content": f"Round {tool_rounds + 1}: the user wants a computation. "}),
                chunk({"reasoning_content": "I will use the calculator tool."}),
                chunk({"content": f"Let me run step {tool_rounds + 1} for you."}),
                chunk({"tool_calls": [{"index": 0, "id": f"call_{tool_rounds + 1}", "type": "function",
                                       "function": {"name": "calculator", "arguments": ""}}]}),
                chunk({"tool_calls": [{"index": 0, "function": {"arguments": "{\"expression\": \"2+2*10\"}"}}]}),
                chunk(None, "tool_calls"),
            ])
        else:
            # FINAL ROUND: reasoning → the answer
            sse(self, [
                chunk({"reasoning_content": "All three steps returned 22. Now I answer."}),
                chunk({"content": "The result is "}),
                chunk({"content": "22."}),
                chunk(None, "stop", {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}),
            ])


if __name__ == "__main__":
    print(f"mock nvidia on :{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
