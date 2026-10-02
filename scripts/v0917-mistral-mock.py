#!/usr/bin/env python3
"""v0917-mistral-mock.py — the mock Mistral API for the e2e rig.

Serves the DOCUMENTED /v1/models shape (the wire format Mistral's docs
specify, researched 2026-10-02) + a /v1/chat/completions SSE responder that
RECORDS every request body to /tmp/v0917-mistral-captured.json so the rig
can assert the engine's translation (auth header, model id, effort shape).
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {
    "object": "list",
    "data": [
        {"id": "mistral-medium-3-5", "object": "model", "owned_by": "mistralai",
         "max_context_length": 262144,
         "capabilities": {"completion_chat": True, "function_calling": True, "vision": True}},
        {"id": "glm-5.3", "object": "model", "owned_by": "zai",
         "max_context_length": 1000000,
         "capabilities": {"completion_chat": True, "function_calling": True, "vision": False}},
        {"id": "magistral-medium-latest", "object": "model", "owned_by": "mistralai",
         "max_context_length": 128000,
         "capabilities": {"completion_chat": True, "function_calling": False, "vision": False}},
        {"id": "mistral-small-2506", "object": "model", "owned_by": "mistralai",
         "max_context_length": 131000,
         "capabilities": {"completion_chat": True, "function_calling": True, "vision": False}},
    ],
}

CAPTURE = "/tmp/v0917-mistral-captured.json"
lock = threading.Lock()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/v1/models":
            if self.headers.get("Authorization") != "Bearer mstrl_mock_key":
                return self._json(401, {"detail": "Invalid API Key"})
            return self._json(200, MODELS)
        self._json(404, {"detail": "not found"})

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            with lock:
                with open(CAPTURE, "a") as f:
                    f.write(json.dumps({
                        "auth": self.headers.get("Authorization"),
                        "body": body,
                    }) + "\n")
            # a minimal OpenAI-shaped SSE stream
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunk = {
                "id": "mock", "object": "chat.completion.chunk",
                "model": body.get("model", "?"),
                "choices": [{"index": 0, "delta": {"content": "ok from mock"},
                             "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            done = {"id": "mock", "object": "chat.completion.chunk",
                    "model": body.get("model", "?"),
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}}
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self._json(404, {"detail": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1])
    open(CAPTURE, "w").close()
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
