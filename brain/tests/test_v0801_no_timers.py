"""v0.80.1 THE NO-TIMER CONTRACT (user directive: "remove any timer that
canceles an output or reply — models should be able to keep going as long
as they like"). Source-level pins: every timer that used to KILL a turn,
a model call, or a tool output is either removed or raised to a
runaway-guard level that no legitimate work will ever hit.
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRAIN = HERE.parent


def _src(rel: str) -> str:
    return (BRAIN / rel).read_text()


def test_engine_has_no_turn_budget():
    """server/chat.go: the WithTimeout turn budget is gone — only Stop
    (WithCancel) ends a turn."""
    src = _src("../engine/internal/server/chat.go")
    assert "context.WithTimeout(context.Background(), turnBudget)" not in src
    assert "turnBudget :=" not in src
    assert "context.WithCancel(context.Background())" in src


def test_engine_idle_kill_disarmed():
    """llm/chat.go: idleWaitFor returns 0 — the silent-stream kill is off."""
    src = _src("../engine/internal/llm/chat.go")
    m = re.search(r"func idleWaitFor\([^)]*\) time\.Duration \{\s*([^}]*)\}", src)
    assert m, "idleWaitFor not found"
    assert "return 0" in m.group(1), "idleWaitFor must return 0 (kill disabled)"


def test_engine_tool_loops_fit_long_chains():
    """ReAct + native-tools loops: 64 rounds (30+ tool chains must fit)."""
    chat = _src("../engine/internal/llm/chat.go")
    nat = _src("../engine/internal/llm/nativetools.go")
    assert "for round := 0; round < 64; round++" in chat
    assert "const maxRounds = 64" in nat


def test_brain_model_calls_are_no_cap():
    """agent.py + agent_core.py: the per-call LLM timeout is 86400 (a day on
    a SINGLE call = effectively no cap), never 120/900/60/300."""
    ag = _src("agent.py")
    core = _src("agent_core.py")
    assert '"timeout": 86400' in ag
    assert '"timeout": 900 if' not in ag
    assert 'client_args["timeout"] = 86400' in core
    assert 'client_args["timeout"] = 60' not in core


def test_brain_pump_has_no_kill_watchdog():
    """agent.py: the 960s idle / 55-min hard cap are gone — the pump only
    heartbeats; the executor thread decides when the turn ends."""
    ag = _src("agent.py")
    assert "_IDLE_S" not in ag
    assert "_HARD_CAP_S" not in ag
    assert "_HB_S = 25" in ag  # the heartbeat stays (keepalive, not a killer)


def test_brain_agent_core_watchdog_removed():
    """agent_core.py: no idle kill, no hard cap — plain join."""
    core = _src("agent_core.py")
    assert "_IDLE_TIMEOUT_S" not in core
    assert "_HARD_CAP_S" not in core
    assert "agent_call_hard_cap" not in core


def test_brain_tool_guards_are_generous():
    """shell/python_repl/parallel 1800s, install 3600s — runaway brakes, not
    output cancellers (the old 300/600s cut real builds mid-output)."""
    ag = _src("agent.py")
    assert "text=True, timeout=1800," in ag
    assert "timeout=1800, env=env" in ag
    assert "text=True, timeout=3600," in ag
    assert "timeout=300,\n" not in ag.split("# v0.48 task 7")[1]
    assert "timed out after 300s" not in ag


def test_swarm_and_hub_budgets_raised():
    """dt_swarm: 900 default / 3600 cap; dt_hublib: 900s per-gap SSE budget."""
    swarm = _src("tools/dt_swarm.py")
    hub = _src("tools/dt_hublib.py")
    assert "DEFAULT_TIMEOUT_SECS = 900" in swarm
    assert "DOOMALAY_SWARM_TIMEOUT_CAP\", 3600" in swarm
    assert "COLLECTION_TIMEOUT = 900.0" in hub
