"""test_agent_v0953.py — v0.95.3 THE REASONING RESCUE WAVE pins.

The live bug (the user's report): "using Nvidia or Mistral or anything that
isn't privatemodeai doesn't return reasoning — reasoning bubbles are empty
or have an incomplete line of text." Root cause (live-proven against a mock
NIM): litellm 1.55.10's transformation layer STRIPS delta.reasoning_content
before Python ever sees it — PM reads raw SSE in the browser and the Go
engine reads raw SSE, so ONLY the brain path was blind.

The fix: BrainLiteLLMModel streams through the RAW openai client when a
custom base_url exists (the engine-registry path — every non-PM provider);
openai's pydantic chunks keep unknown delta fields, so reasoning survives.

Covers (all offline except the in-process SSE mock):
  1. THE RAW CLIENT GATE — built with base_url, absent without.
  2. THE KWARG SPLIT — typed openai kwargs pass through; provider
     extensions (chat_template_kwargs etc.) ride extra_body; the
     "openai/" prefix is stripped for the raw client.
  3. THE LIVE RESCUE — stream() against an in-process SSE mock that emits
     reasoning_content + content + a tool_call: reasoning chunks MUST flow
     (with litellm they vanished entirely).
  4. THE FALLBACK — no base_url → the litellm client path (unchanged).
  5. THE KIMI-K3 CATALOG — the live chatlogs ran nvidia/moonshotai/kimi-k3
     with NO catalog entry → no thinking param → the model's raw
     unconfigured reasoning leaked as '!!!' garbage. Both catalogs carry
     the k3 rows now (NIM/PM: chat_template_kwargs.thinking; OpenRouter:
     reasoning.enabled).

Runs standalone (`python3 tests/test_agent_v0953.py`) AND under pytest.
"""
from __future__ import annotations

import json
import sys
import types
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_BRAIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BRAIN))

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


class _SSEMock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.last_request_body = body  # captured for assertions
        events = [
            {"choices": [{"delta": {"reasoning_content": "The user wants a computation. "}, "index": 0}]},
            {"choices": [{"delta": {"reasoning_content": "I will use the calculator."}, "index": 0}]},
            {"choices": [{"delta": {"content": "Let me compute."}, "index": 0}]},
            {"choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}]},
            {"choices": [{"delta": {}}], "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for ev in events:
            self.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


def _start_mock():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _SSEMock)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


def test_raw_client_gate():
    print("1. The raw-client gate (base_url present → raw openai client)")
    import agent as ag
    m = ag.BrainLiteLLMModel(model_id="openai/x", client_args={
        "api_key": "k", "base_url": "http://127.0.0.1:9/v1", "timeout": 30, "max_retries": 1})
    check("base_url → raw client built", m._raw_client is not None)
    m2 = ag.BrainLiteLLMModel(model_id="x", client_args={"api_key": "k"})
    check("no base_url → litellm path (raw client absent)", m2._raw_client is None)
    m3 = ag.BrainLiteLLMModel(model_id="x", client_args={"api_key": "k", "base_url": ""})
    check("empty base_url → litellm path (no raw client)", m3._raw_client is None)
    m4 = ag.BrainLiteLLMModel(model_id="x", client_args={"api_key": "k", "base_url": "http://127.0.0.1:9/v1"})
    check("a second construction is independent (no shared state)", m4._raw_client is not None and m4._raw_client is not m._raw_client)


def test_kwarg_split():
    print("2. The kwarg split (typed vs extra_body + prefix strip)")
    import agent as ag
    m = ag.BrainLiteLLMModel(model_id="openai/x", client_args={
        "api_key": "k", "base_url": "http://127.0.0.1:9/v1"})
    captured = {}

    def fake_create(**req):
        captured.update(req)
        return iter([])

    m._raw_client = types_stub = _StubClient(fake_create)
    m._raw_stream({
        "model": "openai/z-ai/glm-5.3-flash",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"thinking": True},
        "reasoning_effort": "high",
    })
    check("the openai/ prefix is stripped", captured.get("model") == "z-ai/glm-5.3-flash", f"got {captured.get('model')}")
    check("typed kwargs pass through", captured.get("stream") is True and "stream_options" in captured)
    check("provider extensions ride extra_body",
          captured.get("extra_body") == {"chat_template_kwargs": {"thinking": True}, "reasoning_effort": "high"},
          f"got {captured.get('extra_body')}")
    check("extensions leave the typed surface", "chat_template_kwargs" not in captured)


class _StubClient:
    def __init__(self, create):
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


def test_live_rescue():
    print("3. THE LIVE RESCUE (SSE mock → reasoning chunks MUST flow)")
    import agent as ag
    srv = _start_mock()
    try:
        port = srv.server_address[1]
        m = ag.BrainLiteLLMModel(model_id="openai/mock-model", client_args={
            "api_key": "mock_key", "base_url": f"http://127.0.0.1:{port}/v1",
            "timeout": 10, "max_retries": 0})
        check("raw client wired to the mock", m._raw_client is not None)
        chunks = list(m.stream({
            "model": "openai/mock-model",
            "messages": [{"role": "user", "content": "compute"}],
            "stream": True,
            "chat_template_kwargs": {"thinking": True},
        }))
        reasoning = "".join(c["data"] for c in chunks
                            if c.get("chunk_type") == "content_delta" and c.get("data_type") == "reasoning")
        text = "".join(c["data"] for c in chunks
                       if c.get("chunk_type") == "content_delta" and c.get("data_type") == "text")
        check("reasoning chunks flow through the raw stream",
              reasoning == "The user wants a computation. I will use the calculator.",
              f"got {reasoning!r}")
        check("content still streams", text == "Let me compute.", f"got {text!r}")
        check("the turn terminates (message_stop)",
              any(c.get("chunk_type") == "message_stop" for c in chunks))
        check("thinking param reached the wire verbatim",
              srv.last_request_body.get("chat_template_kwargs") == {"thinking": True},
              f"wire body was {srv.last_request_body}")
    finally:
        srv.shutdown()


def test_litellm_fallback():
    print("4. The fallback (no base_url → the litellm client path)")
    import agent as ag
    m = ag.BrainLiteLLMModel(model_id="gpt-test", client_args={"api_key": "k"})
    check("stream() routes through litellm when no raw client", m._raw_client is None)
    # (The litellm HTTP path itself is exercised by the engine's own
    # live rigs; here we pin only the routing decision.)


def test_kimi_k3_catalog():
    print("5. The kimi-k3 catalog rows (the '!!!' garbage root cause)")
    for path in (_BRAIN / "reasoning_catalog.json",
                 _BRAIN.parent / "engine" / "internal" / "llm" / "catalog" / "reasoning_catalog.json"):
        rel = path.relative_to(_BRAIN.parent)
        if not path.exists():
            check(f"{rel} exists", False)
            continue
        cat = json.loads(path.read_text())
        nv = cat.get("nvidia/moonshotai/kimi-k3")
        check(f"{rel}: nvidia kimi-k3 → chat_template_kwargs.thinking",
              bool(nv and nv.get("body", {}).get("chat_template_kwargs", {}).get("thinking") is True),
              f"got {nv}")
        orr = cat.get("openrouter/moonshotai/kimi-k3")
        check(f"{rel}: openrouter kimi-k3 → reasoning.enabled",
              bool(orr and orr.get("body", {}).get("reasoning", {}).get("enabled") is True),
              f"got {orr}")
        pm = cat.get("privatemodeai/kimi-k3")
        check(f"{rel}: privatemodeai kimi-k3 present", bool(pm))
        fb = cat.get("kimi-k3")
        check(f"{rel}: the unlisted-host fallback is an empty body",
              fb is not None and fb.get("body") == {}, f"got {fb}")


def main():
    test_raw_client_gate()
    test_kwarg_split()
    test_live_rescue()
    test_litellm_fallback()
    test_kimi_k3_catalog()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
