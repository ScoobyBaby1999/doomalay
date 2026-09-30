"""Full Strands agent runner with ALL tools + V0 fixes.

This is the maximal-capability agent: Strands SDK with the full tool suite
(shell, file_read, file_write, editor, web_search, web_fetch, http_request,
calculator, memory, current_time, env, grep, glob, think, journal, memorize,
slug, retrieve + the doomalay dt registry).

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
import queue as _queue
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

    # v0.76.6 THE NONE-USAGE GUARD (live-found: github-models streams a
    # final metadata chunk with usage=None → strands 0.1.5's openai adapter
    # raises AttributeError: 'NoneType' object has no attribute
    # 'prompt_tokens' and the WHOLE turn dies after the model already
    # answered). Guard just the metadata case; a usage-less chunk maps to
    # zeros — never worse than the pre-patch crash.
    try:
        from strands.types.models import openai as _strands_openai
        import types as _types

        _orig_format_chunk = _strands_openai.OpenAIModel.format_chunk

        def _format_chunk_none_usage_safe(self, event):
            if isinstance(event, dict) and event.get("chunk_type") == "metadata" \
                    and event.get("data") is None:
                event = dict(event)
                event["data"] = _types.SimpleNamespace(
                    prompt_tokens=0, completion_tokens=0, total_tokens=0)
            return _orig_format_chunk(self, event)

        _strands_openai.OpenAIModel.format_chunk = _format_chunk_none_usage_safe
    except Exception:
        pass
except ImportError:
    _HAS_STRANDS = False


class BrainLiteLLMModel(LiteLLMModel):
    """v0.76.2 THINKING STREAMS: strands 0.1.5's OpenAIModel only maps the
    Bedrock-style reasoningContent delta — OpenAI-style providers (NVIDIA's
    deepseek, Qwen, Kimi…) stream ``delta.reasoning_content`` and the stock
    stream() DROPS it, so a reasoning model's whole thinking phase was
    silent dead air (2+ minutes of nothing between events on slow turns).
    This subclass re-emits those deltas as reasoning chunks (→ the
    callback's reasoningText → thinking events → the PWA's reasoning pill),
    and keeps every other behavior byte-identical to the pinned parent.

    Round-trip safety: strands' block-stop assembly only appends a
    reasoningContent block when the message has NO text and NO tool_use —
    mixed reasoning→tool turns drop the reasoning from the history (same
    as the native Bedrock path), so tool rounds never see reasoning
    content in the request.
    """

    def stream(self, request: dict):
        response = self.client.chat.completions.create(**request)

        yield {"chunk_type": "message_start"}
        yield {"chunk_type": "content_start", "data_type": "text"}

        tool_calls: dict[int, list] = {}

        for event in response:
            choice = event.choices[0]
            delta = getattr(choice, "delta", None)
            if delta is not None:
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if reasoning:
                    yield {"chunk_type": "content_delta", "data_type": "reasoning", "data": reasoning}
                if getattr(delta, "content", None):
                    yield {"chunk_type": "content_delta", "data_type": "text", "data": delta.content}
                for tool_call in getattr(delta, "tool_calls", None) or []:
                    tool_calls.setdefault(tool_call.index, []).append(tool_call)
            if getattr(choice, "finish_reason", None):
                break

        yield {"chunk_type": "content_stop", "data_type": "text"}

        for tool_deltas in tool_calls.values():
            yield {"chunk_type": "content_start", "data_type": "tool", "data": tool_deltas[0]}
            for tool_delta in tool_deltas:
                yield {"chunk_type": "content_delta", "data_type": "tool", "data": tool_delta}
            yield {"chunk_type": "content_stop", "data_type": "tool"}

        yield {"chunk_type": "message_stop", "data": getattr(choice, "finish_reason", None)}

        # Skip remaining events as we don't have use for anything except the final usage payload
        for event in response:
            _ = event

        yield {"chunk_type": "metadata", "data": getattr(event, "usage", None)}

    def format_chunk(self, event: dict):
        if event.get("chunk_type") == "content_delta" and event.get("data_type") == "reasoning":
            return {"contentBlockDelta": {"delta": {"reasoningContent": {"text": event.get("data") or ""}}}}
        return super().format_chunk(event)

# Brain modules
sys.path.insert(0, str(Path(__file__).parent))

# v0.75: shared-disk isolation (prepare_workspace / demote / the tool
# guards' path checks — brain/sandboxing.py).
import sandboxing  # noqa: E402

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
    api_key: str = "",  # v0.72 BYOK: the per-request key (req_env first, space secret fallback — resolved by the caller so concurrent shared-space turns NEVER race on os.environ)
    system_prompt: str = "",
    effort: str = "med",
    workspace: str = "",
    web_search: bool = True,  # v0.45 ITEM 2: default-on (pill removed)
    deep_research: bool = False,
    mode: str = "auto",
    history: list = None,
    workspaces: list = None,
    template_auto: bool = False,   # v0.52: the [template|+] pill (legacy)
    skills_auto: bool = False,     # v0.52: the [skills|+] pill (legacy)
    lib_auto: bool = False,       # v0.60 pt C.9: THE LIB PILL (the single gate)
    bot_lib: bool | None = None,  # v0.68: the effective Bot Library gate
    bot_dl: bool | None = None,   # v0.68: the effective Can-download-bundles gate
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

    # v0.72 BYOK: explicit per-request key (the caller resolved req_env →
    # os.environ). The fallback keeps old direct callers (tests, local
    # runs) on the pre-v0.72 behavior.
    if not api_key:
        api_key = os.environ.get(env_var, "")
    if not api_key:
        yield {"type": "error", "error": "auth", "message": f"no API key in env {env_var}"}
        yield {"type": "status", "state": "error", "usage": None}
        return

    # v0.60 pt C.9: THE LIB PILL — one gate. lib_auto wins; a legacy pill
    # (or an old engine payload) promotes through the OR of the old two.
    lib_on = bool(lib_auto or template_auto or skills_auto)
    template_auto = lib_on
    skills_auto = lib_on
    # v0.68: the effective tweaks gates (None = an old engine payload →
    # fall back to the lib gate's value; the engine's own system_prompt
    # carries the full live metadata block either way).
    if bot_lib is None:
        bot_lib = lib_on
    if bot_dl is None:
        bot_dl = lib_on

    # Build the system prompt.
    if not system_prompt:
        system_prompt = _build_system_prompt(model, mode, workspace, web_search, deep_research,
                                            workspaces=workspaces,
                                            template_auto=template_auto, skills_auto=skills_auto,
                                            bot_lib=bot_lib, bot_dl=bot_dl)

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
            workspaces=workspaces,
            template_auto=template_auto,
            skills_auto=skills_auto,
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
    *, session_id, messages, model, base_url, api_key, system_prompt, effort, workspace, web_search,
    workspaces=None, template_auto=False, skills_auto=False,
) -> AsyncIterator[dict]:
    """Full Strands agent with all tools. V0: fresh per turn, callback-only events."""
    yield {"type": "status", "state": "running", "usage": None}

    # v0.43 CRITICAL FIX — the litellm cross-loop deadlock (full story in
    # agent_core.StrandsAdapter.turn): litellm's cached async httpx client
    # outlives the isolated event loop strands built for the PREVIOUS agent
    # call, and every later call in the process hangs awaiting a dead loop.
    # Flush the client cache at the top of every fresh agent so THIS turn's
    # client binds to THIS turn's loop. One reconnect per turn — cheap.
    try:
        import litellm as _litellm
        _litellm.in_memory_llm_clients_cache.flush_cache()
    except Exception:
        pass

    try:
        # Build the LLM model.
        # v0.38: litellm 1.55's LiteLLM client takes base_url + max_retries
        # (the old api_base/num_retries kwargs 500'd every brain turn).
        # A custom base_url (provider registry) forces the OpenAI-compatible
        # client via the "openai/" prefix — and litellm wants the BASE url
        # (registry URLs point at the /chat/completions endpoint).
        litellm_id = model
        litellm_base = base_url
        if litellm_base:
            if litellm_base.endswith("/chat/completions"):
                litellm_base = litellm_base[: -len("/chat/completions")]
            litellm_id = "openai/" + model
        # v0.80.1 NO-CAP MODEL CALLS (user directive: "remove any timer that
        # canceles an output or reply — models should be able to keep going
        # as long as they like"). History: v0.46 raised the flat 60s to
        # 120s/900s (slow-reasoning split) after live HF-space redteams — but
        # the shared space's egress still pays 2-6 min PER MODEL CALL, and any
        # per-call cap eventually cancels a healthy completion. 86400s (one
        # calendar day) on a SINGLE call = effectively no cap while keeping
        # the numeric type litellm/httpx expect (None would also disable the
        # CONNECT timeout — a black-holed host would hang forever with no
        # signal; this way a dead host still fails fast at TCP level). The
        # TURN itself has no watchdog any more — the engine's Stop button
        # (abortTurn) is the only canceller.
        client_args = {
            "api_key": api_key,
            "timeout": 86400,
            "max_retries": 2,
        }
        if litellm_base:
            client_args["base_url"] = litellm_base
        llm = BrainLiteLLMModel(
            model_id=litellm_id,
            client_args=client_args,
            stream=True,
            additional_request_params=_build_effort_body(model, effort),
        )

        # Build the conversation manager (V0: per_turn=True for context management).
        # v0.38: strands 0.1.5's SlidingWindowConversationManager takes ONLY
        # window_size (per_turn/proactive_compression were from a different
        # strands build and 500'd every brain turn).
        convo_manager = SlidingWindowConversationManager(window_size=40)

        # Build the callback handler (V0: the SOLE event source, no post-turn walk).
        callback = _StreamCallback()

        # Build the tools.
        # v0.60 pt C.9: THE LIB PILL — OFF keeps browsing + recommending
        # (hublib + the skills index stay); only the USING tools drop: the
        # template runner (dtemplate) goes, and the skills LOAD action
        # refuses with the switch path (gated inside dt_skills).
        _exclude = []
        if not template_auto:
            _exclude.append("dtemplate")
        tools = _build_tools(workspace, web_search, session_id=session_id,
                             callback=callback, model=model,
                             llm_info=(litellm_id, litellm_base or "", api_key),
                             workspaces=workspaces, exclude=_exclude)

        # V0 FIX: fresh Agent per turn. Never reuse.
        # v0.38 MEMORY: the agent is pre-seeded with the conversation
        # history (all messages before the current one) — a fresh agent
        # used to see ONLY the current user message, making every brain
        # turn amnesiac. messages= is the constructor's documented way to
        # load prior turns; the current message still goes through
        # agent(prompt) so the callback stream is unchanged.
        # Strands expects content as a LIST OF BLOCKS (a bare string is
        # iterated char-by-char — "content_type=<T>" TypeError).
        prior = None
        if len(messages) > 1:
            prior = []
            for m in messages[:-1]:
                c = m.get("content")
                if isinstance(c, str):
                    c = [{"text": c}]
                prior.append({"role": m.get("role", "user"), "content": c})
        agent = Agent(
            model=llm,
            tools=tools,
            system_prompt=system_prompt,
            callback_handler=callback,
            conversation_manager=convo_manager,
            messages=prior,
        )

        # V0.38 LIVE STREAMING: the old code ran the agent to completion in
        # the executor and THEN yielded every buffered callback event in one
        # post-completion burst — the browser saw thinking + content land
        # milliseconds apart, so the reasoning pill read "0s · 90 chars" and
        # brain-path turns never actually streamed. The callback now also
        # pushes onto a thread-safe queue and this coroutine PUMPS it live
        # while the agent works (50ms poll; drains to empty after done).
        loop = asyncio.get_event_loop()
        fut = loop.run_in_executor(None, agent, messages[-1]["content"])

        # v0.80.1 — NO KILL WATCHDOG (user directive: "remove any timer that
        # canceles an output or reply — models should be able to keep going
        # as long as they like"). The old no-stall watchdog (960s idle /
        # 55-min hard cap, v0.48) killed turns that were merely SLOW (the
        # shared space pays 2-6 min PER MODEL CALL; a 30+ tool chain runs
        # 10+ min legitimately). It is REMOVED: the pump runs until the
        # agent's executor thread finishes — however long that takes. The
        # Stop button (engine abortTurn → SSE disconnect) is the only
        # canceller. The 25s heartbeat below stays: it keeps every hop
        # (brain SSE → engine WS → PWA) alive during silent model calls and
        # tells the user the turn is still moving.
        _turn_t0 = time.monotonic()
        # v0.76.6 THE HEARTBEAT (live-found on the HF-space rig): a model
        # call can sit SILENT for minutes (observed 2-6 min per call on the
        # shared community space) — the SSE stream carries no bytes, proxies
        # with idle timeouts kill the connection, and the user sees a frozen
        # chat. While the agent is busy and the queue is empty, emit a
        # lightweight progress heartbeat every 25s: keeps every hop (brain
        # SSE → engine WS → PWA) alive and updates the activity line.
        # progress events are EPHEMERAL on the engine (never persisted —
        # the v0.23 NO-SILENCE contract), so replays stay clean.
        _HB_S = 25
        _next_hb = time.monotonic() + _HB_S

        async def _pump():
            nonlocal _next_hb
            while True:
                try:
                    ev = callback.q.get_nowait()
                    _next_hb = time.monotonic() + _HB_S  # real activity resets the beat
                    yield ev
                except _queue.Empty:
                    if fut.done():
                        # final drain — everything the callback queued before
                        # the executor finished, THEN stop.
                        while True:
                            try:
                                yield callback.q.get_nowait()
                            except _queue.Empty:
                                return
                    else:
                        _now = time.monotonic()
                        if _now >= _next_hb:
                            _next_hb = _now + _HB_S
                            yield {"type": "progress",
                                   "message": f"still working — {int(_now - _turn_t0)}s elapsed"}
                        await asyncio.sleep(0.05)

        try:
            async for ev in _pump():
                yield ev
            await fut  # propagate agent exceptions
        except Exception as e:
            raise

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

    V0.38: every event ALSO lands on a thread-safe queue (self.q) — the
    streaming pump in _run_strands_agent drains it live so the browser sees
    thinking/content/tool events as they happen (not as one post-turn burst
    that made the reasoning pill read "0s").
    """

    def __init__(self):
        self.events: list[dict] = []
        self.usage = None
        self._assistant_emitted = False
        self.q = _queue.Queue()

    def _emit(self, ev: dict):
        self.events.append(ev)
        self.q.put(ev)

    def __call__(self, **kwargs):
        """Called by Strands on every event."""
        reasoning = kwargs.get("reasoningText")
        data = kwargs.get("data")
        complete = kwargs.get("complete", False)
        event = kwargs.get("event", {})

        if reasoning:
            self._emit({"type": "thinking", "text": reasoning})

        if data:
            self._assistant_emitted = True
            self._emit({"type": "assistant_delta", "text": data})

        # Tool use (contentBlockStart with toolUse).
        content_block_start = event.get("contentBlockStart", {})
        start = content_block_start.get("start", {})
        tool_use = start.get("toolUse")
        if tool_use:
            tool_name = tool_use.get("name", "unknown")
            tool_use_id = tool_use.get("toolUseId", str(uuid.uuid4()))
            self._emit({
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
            self._emit({
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


# v0.43→v0.44 — sub-agent recursion depth guard: a sub-agent's tool suite
# still includes swarm, so an undisciplined model could recurse spawns
# forever. The user spec (v0.44): "swarm as much agents and sub processes
# as it wants… no artificial caps" — so nested fan-out is now allowed and
# the guard is a RUNAWAY LOOP BREAK, not a capability limit: depth grows
# only when a sub-agent ITSELF spawns more agents, and past
# DOOMALAY_SWARM_DEPTH (default 6, env-tunable — set it higher for deeper
# recursive task decomposition) spawns are refused with an actionable
# message instead of an infinite agent tree.
def _swarm_depth_limit() -> int:
    try:
        return max(1, int(str(os.environ.get("DOOMALAY_SWARM_DEPTH", "")).strip()))
    except Exception:
        return 6


_SUBAGENT_DEPTH = {"n": 0}


def run_subagent_turn(task: str, model: str = "", workspace: str = "",
                      timeout: float = 150.0, sub_id: str = "",
                      llm_info: "tuple[str, str, str] | None" = None) -> dict:
    """v0.43 — spawn a sub-agent as a LIGHTWEIGHT synchronous turn.

    WHY THIS EXISTS: the original spawn went through agent_core's
    AgentSession → StrandsAdapter stack, which deadlocks inside strands
    1.56's concurrent tool executor in the live server (py-spy + a
    coroutine watchdog showed the sub-agent loops parked forever with
    nothing runnable). The CHAT path — fresh Agent per turn, plain
    synchronous ``agent(prompt)`` call, message walk for the reply — is
    proven live (tools, multi-turn, streaming all verified). This function
    is that exact shape minus the SSE plumbing, so sub-agents inherit the
    working mechanics instead of the deadlocking ones.

    Contract (identical to the old spawn_subagent): returns
    {"id", "status": done|error|timeout, "text"?, "error"?}; never raises.
    The sub-agent shares the caller's workspace, gets the full tool suite
    (registry included — sub-agents can read memory, write files, use
    artifacts), and a focused system prompt.
    """
    sub_id = sub_id or uuid.uuid4().hex[:8]
    if not _HAS_STRANDS:
        return {"id": sub_id, "status": "error",
                "error": "strands not installed"}
    if _SUBAGENT_DEPTH["n"] >= _swarm_depth_limit():
        return {"id": sub_id, "status": "error",
                "error": f"swarm recursion limit reached (depth "
                         f"{_swarm_depth_limit()}, env DOOMALAY_SWARM_DEPTH) — "
                         f"do the work directly instead of spawning more agents"}
    _SUBAGENT_DEPTH["n"] += 1
    try:
        return _run_subagent_inner(task, model, workspace, timeout, sub_id,
                                   llm_info=llm_info)
    finally:
        _SUBAGENT_DEPTH["n"] -= 1


def _run_subagent_inner(task: str, model: str, workspace: str,
                        timeout: float, sub_id: str,
                        llm_info: "tuple[str, str, str] | None" = None) -> dict:
    try:
        # LLM routing — PREFER the caller's already-resolved routing
        # (llm_info = (litellm_id, base_url, api_key), threaded from the
        # parent chat turn). Name re-resolution goes through the catalog,
        # whose synced-models section is EMPTY without the panel's
        # provider_sync module — a "glm-5.3-flash" spawn then matched the
        # HEAVY glm-5.3 and every sub-agent timed out at the provider.
        if llm_info and len(llm_info) == 3 and llm_info[2]:
            litellm_id, litellm_base, api_key = llm_info[0], llm_info[1], llm_info[2]
        else:
            litellm_id, litellm_base, api_key = model, "", ""
            try:
                import agent_core
                pair = agent_core._resolve_open_model(model)
                if pair:
                    m, base_url, key_env, _label, _extra = pair
                    litellm_id, litellm_base = m, base_url or ""
                    api_key = os.environ.get(key_env or "", "") if key_env else ""
            except Exception:
                pass
        if not api_key:
            # best-effort env fallbacks for common providers
            for k in ("NVIDIA_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
                      "GITHUB_TOKEN", "CF_API_TOKEN"):
                if os.environ.get(k, "").strip():
                    api_key = os.environ[k]
                    break
        if not api_key:
            return {"id": sub_id, "status": "error",
                    "error": f"no API key resolvable for model {model}"}

        if litellm_base and litellm_base.endswith("/chat/completions"):
            litellm_base = litellm_base[: -len("/chat/completions")]

        client_args = {"api_key": api_key, "timeout": 86400, "max_retries": 1}  # v0.80.1: no-cap model calls (was 300s — sub-agents are model turns too; slow egress must not cancel them)
        if litellm_base:
            client_args["base_url"] = litellm_base
        # v0.43 cross-loop fix (see _run_strands_agent): the cached async
        # httpx client must not outlive its loop — flush before every turn.
        try:
            import litellm as _litellm
            _litellm.in_memory_llm_clients_cache.flush_cache()
        except Exception:
            pass
        llm = BrainLiteLLMModel(model_id=litellm_id, client_args=client_args,
                                stream=True)
        tools = _build_tools(workspace or ".", web_search=False,
                             session_id=f"sub-{sub_id}", callback=None,
                             model=model)
        system_prompt = (
            "You are a focused sub-agent in a doomalay swarm. Complete the "
            "task you are given, working inside the CURRENT directory (the "
            "shared workspace). You may use tools (memory, file ops, shell, "
            "artifact, etc.) when they genuinely help. Reply with your final "
            "answer as plain text — concise and complete; the orchestrator "
            "merges it into the swarm report."
        )
        agent = Agent(model=llm, tools=tools, system_prompt=system_prompt)

        result: dict = {}
        done = {"ok": False}

        def _run():
            t0 = time.time()
            try:
                agent(f"You are sub-agent {sub_id}. Your task:\n{task}")
                done["ok"] = True
            except Exception as e:  # noqa: BLE001 — surfaced as status
                result["error"] = f"{type(e).__name__}: {str(e)[:250]}"
            result["secs"] = round(time.time() - t0, 1)

        import threading as _threading
        t = _threading.Thread(target=_run, daemon=True,
                              name=f"subagent-{sub_id}")
        t.start()
        t.join(timeout=max(10.0, float(timeout)))
        if not done["ok"] and "error" not in result:
            return {"id": sub_id, "status": "timeout",
                    "error": f"sub-agent exceeded {timeout:.0f}s"}
        if "error" in result:
            return {"id": sub_id, "status": "error", "error": result["error"]}

        # Walk the transcript for the LAST assistant text (the final answer
        # — intermediate tool-loop turns are skipped by taking the last).
        text = ""
        try:
            for m in reversed(agent.messages or []):
                if m.get("role") != "assistant":
                    continue
                for block in (m.get("content") or []):
                    if isinstance(block, dict) and block.get("text", "").strip():
                        text = block["text"]
                        break
                if text:
                    break
        except Exception:
            text = ""
        return {"id": sub_id, "status": "done", "text": text[:8000] or
                "(sub-agent finished without a text reply)"}
    except Exception as exc:  # noqa: BLE001 — tool-surface contract
        return {"id": sub_id, "status": "error",
                "error": f"sub-agent turn failed: {type(exc).__name__}: "
                         f"{str(exc)[:200]}"}


def _build_tools(workspace: str, web_search: bool,
                 session_id: str = "", callback=None,
                 model: str = "",
                 llm_info: "tuple[str, str, str] | None" = None,
                 workspaces: list = None, template_auto: bool = False,
                 skills_auto: bool = False, exclude: list = None) -> list:
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

    v0.43: the DOOMALAY TOOL REGISTRY — every brain/tools/dt_*.py module
    (swarm, rtsearch, timemgr, djournal, socreate, skills, dtemplate,
    artifact, hf, stocks) is discovered and built against a ToolContext.
    Quick chat (no workspace in the request body) gets a STABLE per-chat
    workspace under brain/.chat-ws/<session_id>/ so the stateful tools
    (timemgr tasks, journal entries, socreate sessions) persist across
    turns of the same conversation. ctx.spawn fans sub-agents out through
    agent_core.spawn_subagent (shared workspace, .pied memory); progress
    events (swarm agent done, rtsearch rounds) ride the SAME live
    callback queue as thinking/tool events so the chat streams them.
    """
    tools = []

    # v0.76.6 THE CONSENT-GATE FIX (live-found on the 30-tool-chain rig):
    # a brain chat with no bound repo used to fall through to the strands
    # BUILT-IN shell, which prompts for interactive consent on stdin — a
    # headless server has none, so EVERY shell call returned "Command
    # execution cancelled by user" (the model retried 6× then gave up;
    # the same class of thrash the user's "without letting the model have
    # to reason so much" mandate names). The docstring above already
    # documents the contract — quick chat gets the stable per-chat
    # .chat-ws/<session_id>/ workspace — but only dt_registry honored it.
    # Default the workspace the same way so the workspace-scoped custom
    # shell/python_repl (no consent gate, 300s cap, safe env) ALWAYS arm.
    if not workspace:
        workspace = str(Path(__file__).parent / ".chat-ws" / (session_id or "default"))

    # v0.75 SHARED-DISK ISOLATION (brain/sandboxing.py — the Phase 3
    # hardening): every subprocess tool (shell / python_repl / install /
    # parallel) drops to a per-workspace unprivileged uid before exec
    # (workspaces are 0700 + uid-owned — a shell can no longer READ
    # another session's or user's workspace even by absolute path), and
    # the in-process strands file tools get a path guard to the same
    # root. Armed when the brain runs as root on a shared deployment;
    # cooperative (namespace + guards only) elsewhere — never worse than
    # pre-v0.75.
    _sandbox = None
    _preexec = None

    # Strands built-in tools (v0.38: import ONE BY ONE — strands-agents-tools
    # renamed modules across releases (env→environment, no glob/grep/memorize/
    # slug), and ONE stale name in a single big import used to silently drop
    # the WHOLE tool suite, so brain turns ran with zero tools (and litellm
    # then rejected the empty tools list with UnsupportedParamsError).
    from importlib import import_module as _im
    for mod in ("file_read", "file_write", "editor", "http_request", "calculator",
                "glob", "grep", "current_time", "environment", "env", "think",
                "journal", "memorize", "slug", "retrieve", "shell"):
        try:
            m = _im("strands_tools." + mod)
            fn = getattr(m, mod, None)
            if fn is not None:
                # v0.76.2 THE DROPPED BUILT-INS: strands_tools' 0.1.x exports
                # carry the spec on the MODULE (TOOL_SPEC = {...}) while the
                # inner function ships bare — strands' registry only accepts
                # decorated functions or fn.TOOL_SPEC, so seven built-ins
                # (file_read/file_write/http_request/environment/journal/
                # retrieve/shell) silently DROPPED with "unrecognized tool
                # specification" warnings while the system prompt advertised
                # them (models burned rounds on "Unknown tool" — observed
                # live on the community space). Attach the module's spec to
                # the function: the registry's FunctionTool path accepts it.
                # Name collisions resolve later-wins in the registry dict —
                # the custom workspace shell/python guards below and the
                # v0.75.4 guard twins intentionally override these.
                if not hasattr(fn, "TOOL_SPEC"):
                    _spec = getattr(m, "TOOL_SPEC", None)
                    if isinstance(_spec, dict) and _spec.get("name"):
                        fn.TOOL_SPEC = dict(_spec)
                tools.append(fn)
        except Exception:
            continue

    # Shell tool (the key tool — runs commands in the workspace).
    if workspace:
        ws = Path(workspace)
        ws.mkdir(parents=True, exist_ok=True)
        _sandbox = sandboxing.prepare_workspace(ws)
        if _sandbox.get("uid"):
            _preexec = sandboxing.demote(_sandbox["uid"])

        @strands_tool(name="shell", description="Execute a shell command in the workspace. Returns stdout, stderr, and exit code.")
        def shell(command: str) -> str:
            import subprocess
            try:
                # v0.80.1: 30 min (was 5) — long builds/installs/data processing
                # are legitimate model work; the old 300s cap cancelled real
                # outputs. The guard stays only as a runaway-command brake.
                result = subprocess.run(
                    command, shell=True, cwd=str(ws),
                    capture_output=True, text=True, timeout=1800,
                    env=sandboxing.safe_subprocess_env(ws, _safe_env()),
                    preexec_fn=_preexec,
                )
                output = result.stdout
                if result.stderr:
                    output += f"\n[stderr]\n{result.stderr}"
                output += f"\n[exit: {result.returncode}]"
                return output
            except subprocess.TimeoutExpired:
                return "[error: command timed out after 1800s]"
            except Exception as e:
                return f"[error: {e}]"

        tools.append(shell)

        # v0.48 task 7 — the HF-sandbox power tools: python_repl, install
        # (pip/npm/apt with progress), parallel (concurrent shell commands).
        # Same workspace + stripped env discipline as shell itself.
        @strands_tool(name="python_repl", description=(
            "Execute Python 3 code and return stdout + stderr. Runs in the "
            "chat's workspace with a 30-min cap. Prefer this over `python3 -c` "
            "in the shell tool for anything non-trivial — write the code, "
            "get the output."))
        def python_repl(code: str) -> str:
            import subprocess, tempfile
            try:
                with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False,
                                                 dir=str(ws), prefix="repl_") as fh:
                    fh.write(code)
                    p = fh.name
                # v0.76.4 THE DEMOTED-UID READ FIX: the temp file is written
                # by the BRAIN process (root on a shared space, default 0600
                # root-owned) but EXECUTED by the demoted per-session uid —
                # observed live on the community space as "Permission
                # denied" on every python_repl call under uid isolation.
                # World-readable fixes it (the workspace dir itself is 0700
                # uid-owned, so only the sandbox uid can reach the file).
                try:
                    import os as _os
                    _os.chmod(p, 0o644)
                except Exception:
                    pass
                try:
                    # v0.80.1: 30 min (was 5) — long computations are legit work.
                    result = subprocess.run(
                        [sys.executable, p], cwd=str(ws), capture_output=True,
                        text=True, timeout=1800,
                        env=sandboxing.safe_subprocess_env(ws, _safe_env()),
                        preexec_fn=_preexec)
                    output = result.stdout
                    if result.stderr:
                        output = (output + "\n[stderr]\n" if output else "") + result.stderr
                    if not output.strip():
                        output = "(no output)"
                    if result.returncode != 0:
                        output = f"Exit code: {result.returncode}\n{output}"
                    return output[:50000]
                finally:
                    try:
                        import os as _os
                        _os.unlink(p)
                    except Exception:
                        pass
            except Exception as e:
                return f"[error: {e}]"
        tools.append(python_repl)

        @strands_tool(name="install", description=(
            "Install a package into this sandbox with the right manager: "
            "pip for Python packages, npm for Node packages, apt for system "
            "packages. manager: 'auto' (default), 'pip', 'npm', or 'apt'. "
            "Returns the install output (may take a few minutes)."))
        def install(package: str, manager: str = "auto") -> str:
            import subprocess
            pkg = (package or "").strip()
            if not pkg:
                return "no package given"
            m = (manager or "auto").strip().lower()
            if m == "auto":
                m = "npm" if (pkg.startswith(("@", "npm:", "node:")) or "/" in pkg) else "pip"
            if m in ("pip", "pip3"):
                cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", pkg]
            elif m == "npm":
                cmd = ["npm", "install", "--no-audit", "--no-fund", pkg]
            elif m == "apt":
                cmd = ["bash", "-lc",
                       f"apt-get update -qq && apt-get install -y --no-install-recommends {pkg}"]
            else:
                return f"unknown manager '{manager}' (pip | npm | apt)"
            try:
                # v0.80.1: 60 min (was 10) — big installs (apt update + install,
                # torch-class wheels) legitimately run long.
                result = subprocess.run(cmd, cwd=str(ws), capture_output=True,
                                        text=True, timeout=3600,
                                        env=sandboxing.safe_subprocess_env(ws, _safe_env()),
                                        preexec_fn=_preexec)
                output = result.stdout
                if result.stderr:
                    output = (output + "\n[stderr]\n" if output else "") + result.stderr
                if not output.strip():
                    output = "(no output)"
                if result.returncode != 0:
                    output = f"Exit code: {result.returncode}\n{output}"
                return output[:50000]
            except subprocess.TimeoutExpired:
                return f"[error: install timed out after 3600s: {pkg}]"
            except FileNotFoundError:
                return f"[error: manager not available in this sandbox ({m})]"
            except Exception as e:
                return f"[error: {e}]"
        tools.append(install)

        @strands_tool(name="parallel", description=(
            "Run several bash commands CONCURRENTLY and return every result. "
            "Give ONLY independent commands (they run at the same time, up "
            "to 8 concurrently, 30 min each) — use this to fan out builds, "
            "tests, or fetches instead of chaining them one by one. "
            "Input: {commands: [string, ...]}."))
        def parallel(commands: list) -> str:
            import subprocess
            from concurrent.futures import ThreadPoolExecutor
            cmds = [str(c).strip() for c in (commands or []) if str(c).strip()]
            if not cmds:
                return "no commands given"
            if len(cmds) > 16:
                return "too many commands (max 16 per call)"
            env = sandboxing.safe_subprocess_env(ws, _safe_env())

            def _one(cmd):
                try:
                    r = subprocess.run(cmd, shell=True, cwd=str(ws),
                                       capture_output=True, text=True,
                                       timeout=1800, env=env, preexec_fn=_preexec)
                    out = r.stdout
                    if r.stderr:
                        out = (out + "\n[stderr]\n" if out else "") + r.stderr
                    if not out.strip():
                        out = "(no output)"
                    return (f"exit {r.returncode}" if r.returncode else "ok"), out[:12000]
                except subprocess.TimeoutExpired:
                    return "timeout", "[error: timed out after 1800s]"
                except Exception as e:
                    return "error", f"[error: {e}]"

            with ThreadPoolExecutor(max_workers=min(8, len(cmds))) as pool:
                results = list(pool.map(_one, cmds))
            parts = []
            for i, (cmd, (status, out)) in enumerate(zip(cmds, results)):
                parts.append(f"-- [{i + 1}] $ {cmd}  ->  {status}\n{out}")
            return "\n\n".join(parts)[:50000]
        tools.append(parallel)

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

    # v0.43 — the doomalay tool registry (the 10 swarm-wave tools). The
    # workspace STAYS STABLE per chat session so stateful tools persist;
    # the spawn seam routes sub-agents through agent_core.spawn_subagent
    # (same workspace + .pied memory); progress events ride the live
    # callback queue when one was passed. Broken/missing modules are
    # skipped inside the registry — this block can never kill the agent.
    try:
        import dt_registry

        if workspace:
            ws_path = Path(workspace)
        elif session_id:
            ws_path = Path(__file__).parent / ".chat-ws" / (session_id or "default")
        else:
            ws_path = Path(__file__).parent / ".chat-ws" / "default"
        ws_path.mkdir(parents=True, exist_ok=True)

        def _dt_progress(event: str = "status", **fields):
            """Best-effort live progress line (activity indicator) + oplog.

            v0.52 dt_hublib: the chat_event pass-through — a tool hands a
            FULL chat event (the hub item cards) to the turn's emit verbatim
            instead of a status line; mirrors agent_core._emit_dt_progress.
            """
            try:
                import oplog
                oplog.log_event(event, **fields)
            except Exception:
                pass
            if callback is None:
                return
            try:
                if event == "chat_event":
                    ev = fields.get("ev")
                    if isinstance(ev, dict) and ev.get("type"):
                        callback._emit(ev)
                    return
                import agent_core
                msg = agent_core._format_dt_progress(event, fields)
                if msg:
                    callback._emit({"type": "status", "state": "running",
                                    "message": msg})
            except Exception:
                pass

        def _dt_spawn(task: str, model: str = "", wait: bool = True,
                      timeout: float = 150.0, **kw):
            """Sub-agent seam — run_subagent_turn (the lightweight
            fresh-Agent-per-turn path). llm_info carries the PARENT turn's
            resolved (litellm_id, base_url, api_key) so sub-agents ride the
            exact same provider routing instead of re-resolving the model
            name against a catalog whose synced-models section needs the
            panel's provider_sync (absent here — name resolution matched a
            different, heavier model and timed out at the provider)."""
            try:
                return run_subagent_turn(
                    task, model=model or _dt_spawn._default_model,
                    workspace=str(ws_path),
                    timeout=float(timeout),
                    llm_info=None if model.strip() else _dt_spawn._llm_info,
                    **({"sub_id": kw["sub_id"]} if "sub_id" in kw else {}))
            except Exception as exc:  # noqa: BLE001 — tool-surface contract
                return {"id": "?", "status": "error",
                        "error": f"spawn seam unavailable: {exc}"}

        _dt_spawn._default_model = model
        _dt_spawn._llm_info = llm_info

        ctx = dt_registry.ToolContext(
            workspace=ws_path,
            chat_session_id=session_id or None,
            model=model or None,
            emit=_dt_progress,
            spawn=_dt_spawn,
            workspaces=list(workspaces) if workspaces else [],
        )
        dt_tools = dt_registry.load_doomalay_tools(ctx, exclude=exclude)
        if dt_tools:
            # v0.44 UNBOUNDED SWARM: sub-agents KEEP the swarm tool — nested
            # fan-out (a sub-agent swarming its own sub-agents) is exactly
            # what "swarm as much as it wants" means. The recursion guard
            # in run_subagent_turn (_swarm_depth_limit, default 6) is the
            # runaway-loop break; the tool is only stripped on the LAST
            # permitted level so the refusal message never even gets built.
            if _SUBAGENT_DEPTH["n"] >= _swarm_depth_limit() - 1:
                dt_tools = [t for t in dt_tools
                            if (getattr(t, "tool_name", None)
                                or getattr(t, "__name__", "")) != "swarm"]
            tools.extend(dt_tools)
    except Exception:
        pass

    # ── v0.75 THE TOOL GUARDS (shared-disk isolation, in-process half) ──
    # The red-team finding: strands' file tools (file_read / file_write /
    # editor / glob / grep) run IN the brain's process — root on a shared
    # space — with NO path restriction, and strands' ``environment`` tool
    # can list (and even SET, process-globally!) env vars: the community
    # keys were one prompt away. Every guarded tool keeps the ORIGINAL's
    # name + schema (the LLM sees no difference); the call gets a path
    # guard to this chat's workspace, and the env tool becomes a
    # secret-stripped READ-ONLY twin (set/delete refuse).
    if workspace:
        try:
            _ws_guard = Path(workspace).resolve()

            def _tool_name_of(t):
                spec = getattr(t, "TOOL_SPEC", None) or {}
                if isinstance(spec, dict) and spec.get("name"):
                    return spec["name"]
                return getattr(t, "tool_name", None) or getattr(t, "__name__", None) or ""

            def _guard_file_tool(orig):
                spec = dict(getattr(orig, "TOOL_SPEC", None) or {})
                name = _tool_name_of(orig)

                def guarded(*args, **kwargs):
                    # both calling conventions land here: classic kwargs
                    # or the ToolUse dict whose ["input"] carries the params
                    params = {}
                    tu_id = ""
                    if args and isinstance(args[0], dict) and "input" in args[0]:
                        try:
                            params = dict(args[0].get("input") or {})
                        except Exception:
                            params = {}
                        tu_id = str(args[0].get("toolUseId") or "")
                    params.update(kwargs)
                    bad = sandboxing.violating_path_arg(params, _ws_guard)
                    if bad is not None:
                        return {
                            "toolUseId": tu_id or "unknown",
                            "status": "error",
                            "content": [{"text": ("[error: paths outside this chat's "
                                                  "workspace are not allowed on this "
                                                  f"sandbox: {bad}]")}],
                        }
                    return orig(*args, **kwargs)

                # v0.76.2 NO RE-DECORATION (the guard fix): the v0.75.4 twin
                # re-decorated a *args/**kwargs wrapper with the original
                # spec — strands' @tool validates against the WRAPPER's
                # signature ("Field required: args"), so every guarded
                # file-tool call on a shared sandbox FAILED since v0.75.4
                # (observed as validation errors, never as path guards).
                # Attach the spec directly (the registry's FunctionTool
                # path): the manifest keeps the ORIGINAL schema, invoke
                # passes the ToolUse dict through, the guard runs before
                # orig, and orig's own decorator validates for real.
                guarded.__name__ = "guarded_" + (name or "tool")
                if spec.get("name"):
                    guarded.TOOL_SPEC = dict(spec)
                return guarded

            def _env_twin():
                @strands_tool(name="environment", description=(
                    "Read the sandbox environment (read-only, secrets "
                    "stripped). Writes are refused on shared sandboxes."))
                def env_twin(action: str = "list", prefix: str = "", **kwargs) -> str:
                    if action not in ("list", "get"):
                        return ("[error: environment writes are disabled on this "
                                "sandbox (shared deployment — process env is "
                                "common to every user's turns)]")
                    view = sandboxing.safe_subprocess_env(_ws_guard, _safe_env())
                    if prefix:
                        view = {k: v for k, v in view.items() if k.startswith(prefix)}
                    return "\n".join(f"{k}={v}" for k, v in sorted(view.items())) or "(none)"
                return env_twin

            _guards = []
            _seen = set()
            for t in tools:
                nm = _tool_name_of(t)
                if nm in ("file_read", "file_write", "editor", "glob", "grep") and nm not in _seen:
                    _seen.add(nm)
                    _guards.append(_guard_file_tool(t))
                elif nm in ("environment", "env") and nm not in _seen:
                    _seen.add(nm)
                    _guards.append(_env_twin())
            tools.extend(_guards)  # later-wins in the strands registry
        except Exception:
            pass

    # ── v0.76.2 THE TOOL-RESULT EVENTS (the silent-round fix) ──────────
    # The brain path emitted tool_use but NEVER tool_result — strands
    # delivers results as internal messages, not stream events, so every
    # tool round was a black hole between the tool_use pill and the next
    # model answer (up to minutes of dead air on reasoning models; the
    # PWA's tool pills never completed; bundle/skill hint markers in tool
    # results never fired on the brain path). Wrap every tool so its
    # completion pushes a tool_result event onto the callback queue —
    # name + text + tool_use_id + is_error, the same shape the direct
    # path emits. Sub-agent turns (callback=None) skip the wrap.
    if callback is not None and tools:
        tools = _emit_tool_results(tools, callback)

    return tools


def _emit_tool_results(tools, callback):
    """Wrap each tool so its completion emits a tool_result event.

    The wrap preserves each tool's registration shape: decorated functions
    and spec-carrying plain functions keep their name + description +
    inputSchema (re-decorated with the ORIGINAL spec — the decorator's
    own schema inference never runs); the call passes through with the
    exact args/kwargs strands supplied (both the ToolUse-dict and the
    classic-kwargs conventions), and the return value flows back
    unchanged. Only the event emission is added — best-effort, never a
    failure mode for the tool itself."""

    def _spec_of(t):
        spec = getattr(t, "TOOL_SPEC", None)
        if isinstance(spec, dict) and spec.get("name"):
            return dict(spec)
        return None

    def _name_of(t):
        s = _spec_of(t)
        if s:
            return s["name"]
        return getattr(t, "tool_name", None) or getattr(t, "__name__", "") or ""

    out = []
    for t in tools:
        try:
            spec = _spec_of(t)
            name = _name_of(t)
            if not name or spec is None:
                out.append(t)  # unknown shape — pass through untouched
                continue

            def _wrap(orig, tname, tspec):
                def wrapped(*args, **kwargs):
                    result = orig(*args, **kwargs)
                    try:
                        tu_id = ""
                        if args and isinstance(args[0], dict) and "toolUseId" in args[0]:
                            tu_id = str(args[0].get("toolUseId") or "")
                        # normalize non-dict returns to the ToolResult shape
                        # (strands' executor does result.get() — a bare string
                        # would kill the tool round silently)
                        if not (isinstance(result, dict) and "content" in result):
                            result = {
                                "toolUseId": tu_id or "unknown",
                                "status": "success",
                                "content": [{"text": str(result)}],
                            }
                            if args and isinstance(args[0], dict) and "toolUseId" in args[0]:
                                result["toolUseId"] = tu_id or "unknown"
                        text = ""
                        is_err = False
                        if isinstance(result, dict):
                            is_err = result.get("status") == "error"
                            for part in result.get("content") or []:
                                if isinstance(part, dict) and "text" in part:
                                    text += str(part["text"])
                                elif isinstance(part, str):
                                    text += part
                        text = (text or "").strip()[:600]
                        callback._emit({
                            "type": "tool_result",
                            "name": tname,
                            "text": text or "(empty)",
                            "tool_use_id": tu_id,
                            "is_error": bool(is_err),
                        })
                    except Exception:
                        pass  # never let telemetry break the tool
                    return result
                # v0.76.2 NO RE-DECORATION: strands' @tool builds its input
                # validation from the SIGNATURE — a *args/**kwargs wrapper
                # re-decorated with the original inputSchema still VALIDATES
                # against the wrapper's signature ("Field required: args" —
                # every call fails; the v0.75.4 guard twins shipped exactly
                # this bug). Attaching TOOL_SPEC directly takes the registry's
                # FunctionTool path instead: the spec drives the manifest,
                # FunctionTool.invoke passes the ToolUse dict through to us
                # untouched, and orig's OWN decorator validates against the
                # REAL schema. The dict travels: args[0] IS the ToolUse.
                wrapped.__name__ = "emit_" + tname
                wrapped.TOOL_SPEC = dict(tspec)
                return wrapped

            out.append(_wrap(t, name, spec))
        except Exception:
            out.append(t)
    return out


def _build_system_prompt(model: str, mode: str, workspace: str, web_search: bool, deep_research: bool,
                        workspaces: list = None, template_auto: bool = False,
                        skills_auto: bool = False, bot_lib: bool = True,
                        bot_dl: bool = True) -> str:
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

    # v0.44 WORKSPACES: the chat's bound cloud repos — the model must know
    # they exist and which access tier each carries, or it will guess.
    if workspaces:
        rows = []
        for ws in workspaces:
            acc = str(ws.get("access") or "read")
            rows.append(f"- {ws.get('name')} [{ws.get('kind')}] access={acc} "
                        f"(workspace ref: {ws.get('id')} or '{ws.get('owner')}/{ws.get('repo')}')")
        parts.append(
            "CONNECTED CLOUD WORKSPACES (this chat's repos — act on them "
            "with the workspace tool, explore with the explore tool):\n"
            + "\n".join(rows)
            + "\naccess=read → browse/tree/read/grep only; partial → fork+PR "
            "flows; full → direct file writes (API commits). The tools "
            "route through the engine, which holds the credentials."
        )

    if web_search:
        parts.append("Web search is enabled. Use web_search and web_fetch tools when you need current information.")

    if deep_research:
        parts.append("Deep research mode is on. Be thorough: search multiple sources, cross-reference, and cite.")

    # v0.43 — the doomalay tool suite: the model must KNOW the purpose-built
    # tools exist and reach for them first (the user's mandate: "tools u must
    # use"). Without this block the model improvises text answers for jobs
    # that have dedicated tools.
    # v0.52 THE 3 PILLS: the skills + dtemplate lines ride only when the
    # chat's auto-search pills are on (the tools themselves are excluded
    # from the registry in _build_tools — the prompt must not advertise
    # what isn't there).
    _discipline_lines = [
        "- swarm: fan a list of tasks out to PARALLEL sub-agents at once "
        "(whenever 2+ independent sub-tasks exist — this harness has no "
        "single-task delegate tool)",
        "- rtsearch: the REAL-TIME iterative research loop — decomposes a "
        "question, searches, fetches pages, refines queries over rounds, "
        "synthesizes a cited brief. Use for ANY current-events question "
        "instead of guessing from training data",
        "- timemgr: the time manager — tasks with priorities/deadlines/"
        "subtasks, natural dates ('tomorrow', 'next friday'), templates, "
        "pomodoro, today board, stats",
        "- djournal: the rich journal — mood/tags/highlights/gratitude, "
        "search, week/month reviews with trends + streaks, prompts, export",
        "- socreate: the 10x productivity creation loop — start(goal) → plan "
        "→ execute steps (sub-agents) → critique → iterate until done",
        # v0.60 pt C.9: THE LIB PILL — one gate. pt C.12: when ON, the
        # one-line hint is REPLACED by THE BOOTSTRAP — the full
        # using-superpowers skill injected below (porting guide Part 3:
        # "the bootstrap is the entire difference between the port
        # working and not working").
        ("- lib: the chat's library is ON — the skill discipline below is "
         "ACTIVE") if skills_auto else None,
        ("- lib: the chat's Bot Library switch is OFF — you can still BROWSE "
         "and RECOMMEND (hublib search + the skills index), but loads and "
         "downloads refuse until the user flips ✦ tweaks → Bot Library back on"
         ) if not skills_auto else None,
        "- hublib: browse + recommend the PUBLIC HUB's community templates, "
        "skills, scripts and docs — search/popular, tappable one-press "
        "download cards for the user (downloads need the chat's Bot Library "
        "switch ON), payload in hand to follow",
        "- persona: switch this chat's personas — list, import a DOWNLOADED "
        "hub persona (set from, activate) or write a fresh character sheet; "
        "the active persona shapes every later turn",
        "- artifact: create AND surgically EDIT (find/replace, line splices, "
        "inserts, dry_run) the REAL chat artifacts — including files made in "
        "earlier turns; write deliverables HERE, not just as chat text",
        "- workspace: act on this chat's CONNECTED cloud repos (GitHub/"
        "Gitea/GitLab/any forge) — tree, ls, read (head/tail/line ranges), "
        "grep, write files as API commits (full access), fork, clone, "
        "create repos, issues/pulls/releases/actions/discussions views",
        "- explore: the UNBOUNDED repo explorer — give it ANY repo URL (no "
        "connect needed): full tree walks, batch file reads, grep, history, "
        "releases, CI runs, issues; paginated, no artificial caps",
        "- hf: publish results/datasets to the HuggingFace community library",
        "- stocks: keyless market data — quotes, history, MA/RSI/volatility "
        "analysis, compare (Stooq)",
    ]
    _discipline_lines = [ln for ln in _discipline_lines if ln]
    parts.append(
        "TOOL-FIRST DISCIPLINE — you have purpose-built tools; USE THEM:\n"
        + "\n".join(_discipline_lines)
        + "\nRules: fresh info → rtsearch (never answer from memory what it can "
        "verify); tasks/time → timemgr; journaling → djournal; non-trivial "
        "goal → socreate (parallelize with swarm); market questions → "
        "stocks; files the user should keep → artifact; repo questions "
        "(structure, issues, releases, CI, code search) → workspace or "
        "explore — they reach ANY repo URL, not just connected ones. "
        "Unsure what a tool offers? Call it with action='help' first."
    )

    # v0.60 pt C.12: THE BOOTSTRAP — porting guide Part 3: "at the start of
    # every session, the full skills/using-superpowers/SKILL.md is injected
    # into the model's context… the bootstrap is the entire difference
    # between the port working and not working." The local port's copy
    # (brain/agent_skills/superpowers-using-superpowers/SKILL.md, verbatim
    # upstream body — never edited) rides in when the lib gate is ON; the
    # per-harness TOOL MAP (guide Part 2: the action vocabulary → this
    # harness's real tool names) follows it.
    if skills_auto:
        parts.append("SUPERPOWERS — THE SKILL DISCIPLINE (injected, active):\n\n"
                     + _bootstrap_skill()
                     + "\n\nHARNESS TOOL MAP (this harness's real tools):\n"
                     "- *invoke a skill* → the `skills` tool: action='load', "
                     "skill='superpowers-<name>' (e.g. 'superpowers-brainstorming')\n"
                     "- *list/search skills* → the `skills` tool: action='list' or 'search'\n"
                     "- *read a skill's companion files* → the `skills` tool: "
                     "action='read', skill='…', path='…'\n"
                     "- *dispatch a subagent* → the `swarm` tool (parallel "
                     "fan-out; one focused task → just do it yourself — this "
                     "harness has no single-task delegate tool)\n"
                     "- *create/update todos* → the `timemgr` tool (tasks)\n"
                     "- *the skill library* is the chat's library — the hub "
                     "(`hublib` tool) carries more, downloadable on demand")

    parts.append("When you use a tool, explain what you're doing and why. Be concise but complete.")

    # v0.68 THE METADATA PERSONAS — the compact controls block (the engine
    # path gets the full live-valued version via its system_prompt; this is
    # the standalone-brain fallback). Basic info on every pill so the bot
    # can name the flip path when the user asks.
    parts.append(
        "THIS CHAT'S CONTROLS (what the user can flip — name the pill + the path when relevant):\n"
        "- effort (toolbar pill): how deeply you reason per turn (low/med/high).\n"
        "- web search: ON by default — search whenever a live fact matters.\n"
        "- deep research: thorough multi-source research mode (" + ("currently ON" if deep_research else "currently OFF") + ").\n"
        "- Bot Library (the 🛠 lib toolbar pill + ✦ tweaks → Bot Library): "
        + ("currently ON — you may browse, download and use the app's library on the fly."
           if bot_lib else
           "currently OFF — browse + recommend only; downloads/loads refuse until the user flips it back on.") + "\n"
        "- Can download bundles (✦ tweaks → Bot Library → Can download bundles): "
        + ("currently ON — you may download new bundles and use them right away."
           if bot_dl else
           "currently OFF — only bundles already in the user's library (\"Yours\") are usable; new downloads refuse with that switch path.") + "\n"
        "- ✦ tweaks (the header pill): this chat's own look — icon, colors, text sizes, background — plus the library switches above.\n"
    )
    return "\n\n".join(parts)


def _bootstrap_skill() -> str:
    """The bootstrap body: using-superpowers/SKILL.md verbatim, frontmatter
    stripped (the name/description block is registry metadata — the BODY is
    what teaches the model the discipline). Falls back to "" (never raises:
    a missing file must not kill the system prompt)."""
    try:
        p = (Path(__file__).parent / "agent_skills"
             / "superpowers-using-superpowers" / "SKILL.md")
        body = p.read_text(encoding="utf-8")
        if body.startswith("---"):
            end = body.find("\n---", 3)
            if end > 0:
                body = body[end + 4:].lstrip("\r\n")
        return body.strip()
    except Exception:
        return ""


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
