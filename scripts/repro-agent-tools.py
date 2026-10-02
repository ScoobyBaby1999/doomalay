#!/usr/bin/env python3
"""repro-agent-tools.py — reproduce the space-side Agent tool registration
locally (strands 0.1.5) and dump what the registry ACTUALLY accepts.

The live symptom: the space's agent claims calculator/time/web_search only —
no shell. The run log showed 'unrecognized tool specification' warnings.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT + "/brain")
os.environ.setdefault("DOOMALAY_WORKSPACES_ROOT", "/tmp/ws-repro")
os.makedirs("/tmp/ws-repro", exist_ok=True)


class CB:
    def _emit(self, ev):
        pass


import agent  # noqa: E402

tools = agent._build_tools(
    workspace="/tmp/ws-repro", web_search=True,
    session_id="repro-agent", callback=CB(),
)
print(f"built: {len(tools)} tools")


def name_of(t):
    spec = getattr(t, "TOOL_SPEC", None)
    if isinstance(spec, dict) and spec.get("name"):
        return spec["name"]
    return getattr(t, "tool_name", None) or getattr(t, "__name__", str(t))[:30]


from strands import Agent  # noqa: E402


class _ModelProto:
    """Duck-typed model stub (0.1.5's Model ABC lives elsewhere — the Agent
    only calls .stream/.structured_output/.update_config/.get_config)."""
    def update_config(self, **kwargs):
        pass

    def get_config(self):
        return {}

    def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"message": "stub", "stop_reason": "end_turn"}

    def structured_output(self, *args, **kwargs):
        return {}


DummyModel = _ModelProto


ag = Agent(model=DummyModel(), tools=tools, system_prompt="repro", load_tools_from_directory=False)
names = sorted(ag.tool_registry.registry.keys()) if hasattr(ag, "tool_registry") else []
print(f"registry accepted: {len(names)}")
print("names:", names)
print()
print("shell in registry:", "shell" in names)
missing = [name_of(t) for t in tools if name_of(t) not in names]
print("built-but-rejected:", sorted(set(missing)))
