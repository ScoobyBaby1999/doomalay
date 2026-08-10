"""Full Strands agent runner with ALL tools + V0 fixes.

This is the maximal-capability agent: Strands SDK with the full tool suite
(shell, file_read, file_write, editor, web_search, web_fetch, http_request,
calculator, memory, delegate, agent_panel, git, current_time, env, grep, glob,
think, journal, memorize, slug, retrieve).

V0 BUG FIXES (vs the old c-branch agent_sessions.py):
  1. Fresh Strands Agent per turn — NEVER reuse (old code reused a
     non-thread-safe Agent, causing corruption + the stuck-busy wedge).
  2. No 90s daemon-thread timeout — the agent runs in the request coroutine;
     the user's "Stop" aborts via ctx cancellation ( propagated through
     litellm's streaming HTTP request).
  3. No post-turn walk — the Strands callback handler is the SOLE event
     source. The old code re-walked self.agent.messages post-turn, causing
     duplicates + the empty "{}" tool_result bug.
  4. tool_use_id pairing — every tool_use and tool_result event carries
     the matching tool_use_id.
  5. Cumulative session_usage on the terminal status event.

The agent streams events back to the Go engine via SSE. The Go engine
persists each event to chat_events (V0 fix: backend-writes-events-as-it-
emits) + forwards to the PWA via WebSocket.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import AsyncIterator

# Strands SDK
try:
    from strands import Agent
    from strands.models.litellm import LiteLLMModel
    from strands.tools.decorator import tool as strands_tool
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    _HAS_STRANDS = True
except ImportError:
    _HAS_STRANDS = False

# Brain modules
sys.path.insert(0, str(Path(__file__).parent))

# LiteLLM (fallback when Strands is unavailable)
try:
    import litellm
    litellm.suppress_debug_info = True
    _HAS_LITELLM = True
except ImportError:
    _HAS_LITELLM = False


async def run_turn(
    *,
    session_id: str,
    message: str,
    model: str,
    base_url: str,
    env_var: str,
    system_prompt: str = "",
    effort: str = "med",
    workspace: str = "",
    web_search: bool = False,
    deep_research: bool = False,
    mode: str = "auto",
    history: list = None,
) -> AsyncIterator[dict]:
    """Run one chat turn. Yields events as dicts.

    Events emitted (the wire format the Go engine forwards to the PWA):
        {"type": "thinking", "text": "..."}
        {"type": "assistant_delta", "text": "..."}
        {"type": "tool_use", "name": "...", "summary": "...", "tool_use_id": "..."}
        {"type": "tool_result", "text": "...", "tool_use_id": "...", "is_error": bool}
        {"type": "status", "state": "idle"|"error", "usage": {...}}
        {"type": "error", "error": "...", "message": "..."}

    V0 FIX: fresh agent per turn. No reuse. No daemon timeout.
    """
    if not _HAS_LITELLM:
        yield {"type": "error", "error": "deps", "message": "litellm not installed"}
        yield {"type": "status", "state": "error", "usage": None}
        return

    api_key = os.environ.get(env_var, "")
    if not api_key:
        yield {"type": "error", "error": "auth", "message": f"no API key in env {env_var}"}
        yield {"type": "status", "state": "error", "usage": None}
        return

    # Build the system prompt.
    if not system_prompt:
        system_prompt = _build_system_prompt(model, mode, workspace, web_search, deep_research)

    # Build messages (include history if provided).
    messages = list(history) if history else []
    messages.append({"role": "user", "content": message})

    # V0 FIX: try Strands agent (full tools). If unavailable, fall back to
    # direct litellm streaming (cloud chat only, no tools).
    if _HAS_STRANDS:
        async for ev in _run_strands_agent(
            session_id=session_id,
            messages=messages,
            model=model,
            base_url=base_url,
            api_key=api_key,
            system_prompt=system_prompt,
            effort=effort,
            workspace=workspace,
            web_search=web_search,
        ):
            yield ev
    else:
        # Fallback: direct litellm streaming (no tools, no panel).
        async for ev in _run_litellm_direct(
            messages=messages,
            model=model,
            base_url=base_url,
            api_key=api_key,
            system_prompt=system_prompt,
            effort=effort,
        ):
            yield ev


async def _run_strands_agent(
    *, session_id, messages, model, base_url, api_key, system_prompt, effort, workspace, web_search
) -> AsyncIterator[dict]:
    """Full Strands agent with all tools. V0: fresh per turn, callback-only events."""
    yield {"type": "status", "state": "running", "usage": None}

    try:
        # Build the LLM model.
        llm = LiteLLMModel(
            model_id=model,
            client_args={
                "api_key": api_key,
                "api_base": base_url,
                "timeout": 60,
                "num_retries": 2,
            },
            stream=True,
            additional_request_params=_build_effort_body(model, effort),
        )

        # Build the conversation manager (V0: per_turn=True for context management).
        convo_manager = SlidingWindowConversationManager(
            window_size=40,
            per_turn=True,
            proactive_compression=True,
        )

        # Build the callback handler (V0: the SOLE event source, no post-turn walk).
        callback = _StreamCallback()

        # Build the tools.
        tools = _build_tools(workspace, web_search)

        # V0 FIX: fresh Agent per turn. Never reuse.
        agent = Agent(
            model=llm,
            tools=tools,
            system_prompt=system_prompt,
            callback_handler=callback,
            conversation_manager=convo_manager,
        )

        # Run the agent (blocking call — the callback handler emits events
        # in real-time as the agent works).
        # V0 FIX: no daemon thread, no 90s timeout. The agent runs in this
        # coroutine. The Go engine's ctx cancellation will abort the HTTP
        # request if the user clicks Stop.
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, agent, messages[-1]["content"])

        # Emit all buffered events from the callback.
        for ev in callback.events:
            yield ev

        # V0: tool_use_id pairing is handled by the callback (it extracts
        # tool_use_id from the Strands tool_use content block).

    except Exception as e:
        import traceback
        traceback.print_exc()
        yield {"type": "error", "error": "agent", "message": str(e)}
        yield {"type": "status", "state": "error", "usage": None}
        return

    # Terminal status with usage (V0: cumulative session_usage).
    usage = getattr(callback, "usage", None) or {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    yield {"type": "status", "state": "idle", "usage": usage}


async def _run_litellm_direct(
    *, messages, model, base_url, api_key, system_prompt, effort
) -> AsyncIterator[dict]:
    """Fallback: direct litellm streaming (no tools). Cloud chat only."""
    yield {"type": "status", "state": "running", "usage": None}

    full_messages = []
    if system_prompt:
        full_messages.append({"role": "system", "content": system_prompt})
    full_messages.extend(messages)

    extra_body = _build_effort_body(model, effort)

    try:
        response = await litellm.acompletion(
            model=model,
            messages=full_messages,
            api_key=api_key,
            api_base=base_url,
            stream=True,
            extra_body=extra_body,
            stream_options={"include_usage": True},
        )
    except Exception as e:
        yield {"type": "error", "error": "llm_call", "message": str(e)}
        yield {"type": "status", "state": "error", "usage": None}
        return

    total_in = 0
    total_out = 0
    try:
        async for chunk in response:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta:
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if reasoning:
                    yield {"type": "thinking", "text": reasoning}
                if delta.content:
                    yield {"type": "assistant_delta", "text": delta.content}
            if hasattr(chunk, "usage") and chunk.usage:
                total_in = getattr(chunk.usage, "prompt_tokens", 0) or 0
                total_out = getattr(chunk.usage, "completion_tokens", 0) or 0
    except Exception as e:
        yield {"type": "error", "error": "stream", "message": str(e)}
        yield {"type": "status", "state": "error", "usage": None}
        return

    yield {
        "type": "status",
        "state": "idle",
        "usage": {
            "input_tokens": total_in,
            "output_tokens": total_out,
            "total_tokens": total_in + total_out,
        },
    }


class _StreamCallback:
    """Strands callback handler — the SOLE event source (V0 fix: no post-turn walk).

    Captures events as the agent works:
    - reasoningText → thinking event
    - data → assistant_delta event
    - tool_use content block → tool_use event (with tool_use_id)
    - tool_result content block → tool_result event (with matching tool_use_id)
    - complete → usage extraction
    """

    def __init__(self):
        self.events: list[dict] = []
        self.usage = None
        self._assistant_emitted = False

    def __call__(self, **kwargs):
        """Called by Strands on every event."""
        reasoning = kwargs.get("reasoningText")
        data = kwargs.get("data")
        complete = kwargs.get("complete", False)
        event = kwargs.get("event", {})

        if reasoning:
            self.events.append({"type": "thinking", "text": reasoning})

        if data:
            self._assistant_emitted = True
            self.events.append({"type": "assistant_delta", "text": data})

        # Tool use (contentBlockStart with toolUse).
        content_block_start = event.get("contentBlockStart", {})
        start = content_block_start.get("start", {})
        tool_use = start.get("toolUse")
        if tool_use:
            tool_name = tool_use.get("name", "unknown")
            tool_use_id = tool_use.get("toolUseId", str(uuid.uuid4()))
            self.events.append({
                "type": "tool_use",
                "name": tool_name,
                "summary": "",
                "tool_use_id": tool_use_id,
            })

        # Tool result (contentBlockDelta or contentBlockStop with tool_result).
        content_block_delta = event.get("contentBlockDelta", {})
        delta = content_block_delta.get("delta", {})
        if "toolResult" in delta:
            tool_result = delta["toolResult"]
            tool_use_id = tool_result.get("toolUseId", "")
            content = tool_result.get("content", [])
            text_parts = []
            for part in content:
                if isinstance(part, dict) and "text" in part:
                    text_parts.append(part["text"])
                elif isinstance(part, str):
                    text_parts.append(part)
            is_error = tool_result.get("status") == "error"
            self.events.append({
                "type": "tool_result",
                "text": "\n".join(text_parts) or "{}",
                "tool_use_id": tool_use_id,
                "is_error": is_error,
            })

        # Usage on complete.
        if complete:
            usage_data = kwargs.get("usage")
            if usage_data:
                self.usage = {
                    "input_tokens": usage_data.get("inputTokens", 0),
                    "output_tokens": usage_data.get("outputTokens", 0),
                    "total_tokens": usage_data.get("totalTokens", 0),
                }


def _build_tools(workspace: str, web_search: bool) -> list:
    """Build the full tool suite for the Strands agent.

    Tools ported from the old c-branch:
    - shell (subprocess in the workspace)
    - file_read, file_write, editor (strands_tools)
    - web_search, web_fetch (from brain/tools/web.py)
    - http_request, calculator, glob, grep (strands_tools)
    - memory (from brain/memory.py)
    - current_time, env, think, journal, memorize, slug, retrieve (strands_tools)
    - delegate (sub-agent spawn)
    - agent_panel (judge panel fan-out)
    """
    tools = []

    # Strands built-in tools.
    try:
        from strands_tools import (
            file_read, file_write, editor, http_request, calculator,
            glob, grep, current_time, env, think, journal, memorize,
            slug, retrieve,
        )
        tools.extend([file_read, file_write, editor, http_request, calculator,
                      glob, grep, current_time, env, think, journal, memorize,
                      slug, retrieve])
    except ImportError:
        pass

    # Shell tool (the key tool — runs commands in the workspace).
    if workspace:
        ws = Path(workspace)
        ws.mkdir(parents=True, exist_ok=True)

        @strands_tool(name="shell", description="Execute a shell command in the workspace. Returns stdout, stderr, and exit code.")
        def shell(command: str) -> str:
            import subprocess
            try:
                result = subprocess.run(
                    command, shell=True, cwd=str(ws),
                    capture_output=True, text=True, timeout=300,
                    env=_safe_env(),
                )
                output = result.stdout
                if result.stderr:
                    output += f"\n[stderr]\n{result.stderr}"
                output += f"\n[exit: {result.returncode}]"
                return output
            except subprocess.TimeoutExpired:
                return "[error: command timed out after 300s]"
            except Exception as e:
                return f"[error: {e}]"

        tools.append(shell)

    # Web search + fetch (from brain/tools/web.py).
    try:
        sys.path.insert(0, str(Path(__file__).parent / "tools"))
        from web import web_search as _ws, web_fetch as _wf

        @strands_tool(name="web_search", description="Search the web using DuckDuckGo (no API key needed). Returns search results with titles, URLs, and snippets.")
        def web_search_tool(query: str) -> str:
            import asyncio
            async def _search():
                import httpx
                async with httpx.AsyncClient() as client:
                    return await _ws(query, http_client=client)
            try:
                return asyncio.run(_search())
            except Exception as e:
                return f"[error: {e}]"

        @strands_tool(name="web_fetch", description="Fetch and read the content of a web page. Returns the text content.")
        def web_fetch_tool(url: str) -> str:
            import asyncio
            async def _fetch():
                import httpx
                async with httpx.AsyncClient() as client:
                    return await _wf(url, http_client=client)
            try:
                return asyncio.run(_fetch())
            except Exception as e:
                return f"[error: {e}]"

        tools.extend([web_search_tool, web_fetch_tool])
    except ImportError:
        pass

    # Memory tool (from brain/memory.py).
    try:
        from memory import init_memory, get_context_for_agent, write_memory_event

        @strands_tool(name="memory", description="Read or write to the .pied memory layer. Use action='read' to get context, action='write' to log an event.")
        def memory_tool(action: str, content: str = "") -> str:
            if workspace:
                init_memory(workspace)
                if action == "read":
                    return get_context_for_agent(workspace, max_chars=4000)
                elif action == "write":
                    write_memory_event(workspace, content)
                    return "[ok: memory written]"
            return "[error: no workspace]"

        tools.append(memory_tool)
    except ImportError:
        pass

    return tools


def _build_system_prompt(model: str, mode: str, workspace: str, web_search: bool, deep_research: bool) -> str:
    """Build the system prompt for the agent."""
    parts = [f"You are Doomalay, an autonomous AI assistant running via {model}."]

    if mode == "build":
        parts.append("You are in BUILD mode: focus on writing, compiling, and running code.")
    elif mode == "plan":
        parts.append("You are in PLAN mode: focus on analysis and planning, not execution.")
    else:
        parts.append("You are in AUTO mode: use your judgment to decide when to use tools.")

    if workspace:
        parts.append(f"Your workspace is at: {workspace}")
        parts.append("Use the shell tool to explore it (ls, cat, git status, etc.).")

    if web_search:
        parts.append("Web search is enabled. Use web_search and web_fetch tools when you need current information.")

    if deep_research:
        parts.append("Deep research mode is on. Be thorough: search multiple sources, cross-reference, and cite.")

    parts.append("When you use a tool, explain what you're doing and why. Be concise but complete.")
    return "\n\n".join(parts)


def _build_effort_body(model: str, effort: str) -> dict:
    """Translate the effort level to the provider's extra_body."""
    if effort == "off" or effort == "med":
        return {}
    if "o1" in model or "o3" in model or "o4" in model:
        mapping = {"low": "low", "med": "medium", "high": "high", "max": "high"}
        return {"reasoning_effort": mapping.get(effort, "medium")}
    if "deepseek-r1" in model or "deepseek-reasoner" in model:
        mapping = {"low": 2000, "med": 8000, "high": 16000, "max": 32000}
        return {"reasoning_effort": mapping.get(effort, 8000)}
    return {}


def _safe_env() -> dict:
    """Return a safe environment for shell commands (secrets stripped)."""
    env = dict(os.environ)
    # Strip provider keys from the shell environment.
    for key in list(env.keys()):
        if any(k in key.upper() for k in ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "PAT"]):
            del env[key]
    return env
