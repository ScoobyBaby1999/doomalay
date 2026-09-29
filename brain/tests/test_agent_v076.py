"""test_agent_v076.py — offline unit tests for the v0.76 brain fixes.

Covers the plain core only (no network, no strands Agent loop):
  1. THE BYOK REGISTRY (providers.make_provider_registry consults the
     per-request reqenv ContextVar — the pure-BYOK /chat 400 root cause).
  2. THE DROPPED BUILT-INS (_build_tools attaches the module-level
     TOOL_SPEC to the strands_tools inner functions — seven built-ins
     silently dropped with "unrecognized tool specification" before).
  3. THE TOOL-RESULT EVENTS (_emit_tool_results wraps every tool; the
     completion pushes {type: tool_result, name, text, tool_use_id,
     is_error} onto the callback queue with the MATCHING id; non-dict
     returns normalize to the ToolResult shape).
  4. THE GUARD VALIDATION FIX (v0.75.4's re-decorated *args/**kwargs
     twins validated against the wrapper signature — "Field required:
     args" — every guarded call failed; the no-re-decoration twin keeps
     the original schema AND refuses out-of-workspace paths).
  5. THE THINKING STREAM MAP (BrainLiteLLMModel.format_chunk maps the
     reasoning chunk to the Bedrock-style reasoningContent delta; all
     other chunk shapes delegate to the parent).

Runs standalone (`python3 tests/test_agent_v076.py`) AND under pytest.
"""
from __future__ import annotations

import sys
import types
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


class _FakeCallback:
    def __init__(self):
        self.events = []

    def _emit(self, ev):
        self.events.append(ev)

    def __call__(self, **kw):
        pass


def test_byok_registry():
    print("1. BYOK registry (reqenv → make_provider_registry)")
    import reqenv
    import providers

    # baseline: no request context → same as the old behavior
    reqenv.set_request_env({})
    reg = providers.make_provider_registry()
    names = [p.name for p in reg]
    check("no-context registry unchanged (no nvidia without env)",
          "nvidia" not in names, f"got {names}")

    # BYOK value registers the provider
    reqenv.set_request_env({"NVIDIA_API_KEY": "nvapi-byok-test"})
    reg = providers.make_provider_registry()
    nv = [p for p in reg if p.name == "nvidia"]
    check("BYOK value registers nvidia", bool(nv))
    if nv:
        check("BYOK value lands in p.api_key", nv[0].api_key == "nvapi-byok-test",
              f"got {nv[0].api_key!r}")

    # presence-only keyed registers with an empty value (catalog display)
    reqenv.set_request_env({}, frozenset({"NVIDIA_API_KEY"}))
    reg = providers.make_provider_registry()
    nv = [p for p in reg if p.name == "nvidia"]
    check("keyed presence registers nvidia", bool(nv))
    if nv:
        check("keyed-only api_key is empty (display only)", nv[0].api_key == "",
              f"got {nv[0].api_key!r}")

    # os.environ fallback still works (community secrets on shared spaces)
    import os
    reqenv.set_request_env({})
    old = os.environ.get("NVIDIA_API_KEY")
    os.environ["NVIDIA_API_KEY"] = "nvapi-community-secret"
    try:
        reg = providers.make_provider_registry()
        nv = [p for p in reg if p.name == "nvidia"]
        check("os.environ fallback registers", bool(nv))
    finally:
        if old is None:
            os.environ.pop("NVIDIA_API_KEY", None)
        else:
            os.environ["NVIDIA_API_KEY"] = old
    reqenv.set_request_env({})


def test_builtin_spec_attach():
    print("2. Dropped built-ins (module TOOL_SPEC → function)")
    cb = _FakeCallback()
    import agent as ag
    tools = ag._build_tools(workspace="/tmp/v076-ws", web_search=True,
                            session_id="v076-t", callback=cb,
                            model="nvidia/test")
    names = []
    for t in tools:
        spec = getattr(t, "TOOL_SPEC", None) or {}
        names.append(spec.get("name") or getattr(t, "tool_name", None)
                     or getattr(t, "__name__", ""))
    for want in ("file_read", "file_write", "http_request", "environment",
                 "journal", "retrieve"):
        check(f"built-in {want} carries a spec", want in names,
              f"tool list: {names}")


def test_tool_result_events():
    print("3. Tool-result events (the silent-round fix)")
    cb = _FakeCallback()

    from strands.tools.decorator import tool as strands_tool

    @strands_tool(name="add", description="Add numbers.")
    def add(a: int, b: int) -> str:
        """Add.

        Args:
            a: first
            b: second
        """
        return f"sum={a + b}"

    def plain_tool(tool, **kwargs):
        return {"toolUseId": tool.get("toolUseId", "?"), "status": "success",
                "content": [{"text": "plain-ok"}]}
    plain_tool.TOOL_SPEC = {"name": "plain", "description": "A plain tool.",
                            "inputSchema": {"json": {"type": "object",
                                                     "properties": {}}}}

    import agent as ag
    wrapped = ag._emit_tool_results([add, plain_tool], cb)
    by_name = {}
    for t in wrapped:
        spec = getattr(t, "TOOL_SPEC", None) or {}
        by_name[spec.get("name", "?")] = t

    # decorated tool: full round-trip via the ToolUse convention
    res = by_name["add"]({"toolUseId": "tu-1", "input": {"a": 3, "b": 4}})
    check("decorated tool executes", isinstance(res, dict) and res.get("status") == "success",
          f"got {res}")
    emitted = [e for e in cb.events if e.get("type") == "tool_result"]
    check("tool_result event emitted", len(emitted) == 1, f"got {emitted}")
    if emitted:
        e = emitted[0]
        check("event name matches", e.get("name") == "add", f"got {e}")
        check("event id matches", e.get("tool_use_id") == "tu-1", f"got {e}")
        check("event text carries the result", "sum=7" in (e.get("text") or ""), f"got {e}")
        check("event is_error false", e.get("is_error") is False, f"got {e}")

    # plain tool: also emits + keeps the ToolResult shape
    cb.events.clear()
    res2 = by_name["plain"]({"toolUseId": "tu-2", "input": {}})
    check("plain tool returns dict", isinstance(res2, dict), f"got {res2}")
    emitted = [e for e in cb.events if e.get("type") == "tool_result"]
    check("plain tool_result emitted", len(emitted) == 1, f"got {emitted}")

    # spec preservation (the manifest the model sees)
    spec = getattr(by_name["add"], "TOOL_SPEC", None) or {}
    check("wrapped spec keeps the name", spec.get("name") == "add", f"got {spec}")
    check("wrapped spec keeps the description",
          "Add numbers." == spec.get("description"), f"got {spec.get('description')!r}")


def test_guard_validation_fix():
    print("4. Guard twins (no re-decoration; path refusal keeps shape)")
    cb = _FakeCallback()
    import agent as ag

    # through _build_tools: the v0.75.4 guard block wraps the real
    # strands_tools file built-ins (now spec-attached) + the v0.76.2 emit
    # pass wraps those — the full production chain.
    tools = ag._build_tools(workspace="/tmp/v076-ws", web_search=True,
                            session_id="v076-t2", callback=cb,
                            model="nvidia/test")
    frs = [t for t in tools
           if (getattr(t, "TOOL_SPEC", None) or {}).get("name") == "file_read"]
    check("guarded file_read present", bool(frs), "no file_read in tools")
    if frs:
        wrapped = frs[-1]
        # in-workspace path executes (validation passes — the v0.75.4
        # signature-validation bug made EVERY call fail)
        res = wrapped({"toolUseId": "g-1", "input": {"path": "/tmp/v076-ws/notes.txt"}})
        check("in-workspace read executes (no signature-validation failure)",
              isinstance(res, dict) and "Field required" not in str(res), f"got {res}")

        # out-of-workspace path refuses with a proper ToolResult
        res2 = wrapped({"toolUseId": "g-2", "input": {"path": "/etc/passwd"}})
        check("escape path refused", isinstance(res2, dict)
              and "workspace are not allowed" in str(res2), f"got {res2}")
        check("refusal carries the id", res2.get("toolUseId") == "g-2", f"got {res2}")
        check("refusal has content list", isinstance(res2.get("content"), list), f"got {res2}")

        # the guard's spec survives the emit wrap (the model sees the real schema)
        spec = getattr(wrapped, "TOOL_SPEC", None) or {}
        check("guard+emit keeps the spec name", spec.get("name") == "file_read", f"got {spec}")


def test_reasoning_chunk_map():
    print("5. Thinking stream map (BrainLiteLLMModel.format_chunk)")
    import agent as ag
    m = ag.BrainLiteLLMModel(model_id="openai/test", client_args={})
    out = m.format_chunk({"chunk_type": "content_delta", "data_type": "reasoning",
                          "data": "thinking hard"})
    check("reasoning chunk → reasoningContent delta",
          out == {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "thinking hard"}}}},
          f"got {out}")
    out2 = m.format_chunk({"chunk_type": "content_delta", "data_type": "text", "data": "hi"})
    check("text chunk delegates to parent",
          out2 == {"contentBlockDelta": {"delta": {"text": "hi"}}}, f"got {out2}")
    out3 = m.format_chunk({"chunk_type": "message_start"})
    check("other chunks delegate to parent", out3 == {"messageStart": {"role": "assistant"}},
          f"got {out3}")


def main():
    test_byok_registry()
    test_builtin_spec_attach()
    test_tool_result_events()
    test_guard_validation_fix()
    test_reasoning_chunk_map()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
