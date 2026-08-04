"""ChatSession + Strands agent runner — with the V0 bug fixes applied.

V0 FIXES (the bugs from the old c-branch chatbot):
  1. Fresh Strands Agent per turn — NEVER reuse self.agent (the old code
     reused a non-thread-safe Agent across turns, causing corruption).
  2. No 90s daemon-thread timeout — the agent runs in the request handler's
     coroutine; the SSE stream stays open as long as the agent runs; the
     user's "Stop" aborts via the Go engine's ctx cancellation.
  3. No post-turn walk — the Strands callback handler is the SOLE event
     source. The old code re-walked self.agent.messages post-turn, causing
     duplicates and the empty "{}" tool_result bug.
  4. tool_use_id pairing — every tool_use and tool_result event carries
     the matching tool_use_id so the PWA can pair them as one card.
  5. Backend-writes-events-as-it-emits — the brain emits events; the Go
     engine persists each one to chat_events as it arrives (not the
     frontend at turn-end). This brain doesn't write to any DB.
  6. Auto-name flag-after-success — not the brain's job; the Go engine
     derives the title from the first user message and emits the title
     event. The brain could do an LLM title later (Phase 2).
  7. Cumulative session_usage — the brain emits usage on each status
     event; the Go engine accumulates per-session.

Phase 1 scope: chat only (no tools, no panel, no templates). The agent
calls the LLM directly via LiteLLM and streams tokens back. Tools, panel,
templates, memory, etc. land in later phases.
"""
from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator

# We use litellm directly for Phase 1 (Strands integration lands in Phase 2
# when we add tools). LiteLLM gives us streaming + provider-agnostic routing
# in one call. The Strands Agent wrapper will replace this in Phase 2 — same
# V0 fixes apply (fresh per turn, no daemon timeout, callback-only events).
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
) -> AsyncIterator[dict]:
    """Run one chat turn. Yields events as dicts.

    Events emitted (the wire format the Go engine forwards to the PWA):
        {"type": "thinking", "text": "..."}     — reasoning (if supported)
        {"type": "assistant_delta", "text": "..."} — content token
        {"type": "tool_use", "name": "...", "summary": "...", "tool_use_id": "..."}
        {"type": "tool_result", "text": "...", "tool_use_id": "...", "is_error": bool}
        {"type": "status", "state": "idle"|"error", "usage": {...}}
        {"type": "error", "error": "...", "message": "..."}

    Phase 1: assistant_delta + status only (no tools, no thinking yet).
    """
    if not _HAS_LITELLM:
        yield {"type": "error", "error": "deps", "message": "litellm not installed (run: pip install -r brain/requirements.txt)"}
        yield {"type": "status", "state": "error", "usage": None}
        return

    api_key = os.environ.get(env_var, "")
    if not api_key:
        yield {"type": "error", "error": "auth", "message": f"no API key in env {env_var}"}
        yield {"type": "status", "state": "error", "usage": None}
        return

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": message})

    # Build the LiteLLM call. extra_body carries provider-specific effort
    # (e.g. OpenAI reasoning_effort, Anthropic thinking).
    extra_body = _build_effort_body(model, effort)

    yield {"type": "status", "state": "running", "usage": None}

    try:
        # V0 FIX: fresh stream per turn. No agent reuse, no daemon thread.
        # The stream is awaited in this coroutine; the Go engine's ctx
        # cancellation will abort the HTTP request if the user clicks Stop.
        response = await litellm.acompletion(
            model=model,
            messages=messages,
            api_key=api_key,
            api_base=base_url,
            stream=True,
            extra_body=extra_body,
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
            if delta is None:
                continue

            # Reasoning / thinking (some providers expose this).
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if reasoning:
                yield {"type": "thinking", "text": reasoning}

            # Content tokens.
            content = delta.content
            if content:
                yield {"type": "assistant_delta", "text": content}

            # Usage (LiteLLM surfaces usage on the final chunk when stream_options
            # include_usage is set; some providers include it per-chunk).
            if hasattr(chunk, "usage") and chunk.usage:
                total_in = getattr(chunk.usage, "prompt_tokens", 0) or 0
                total_out = getattr(chunk.usage, "completion_tokens", 0) or 0
    except Exception as e:
        yield {"type": "error", "error": "stream", "message": str(e)}
        yield {"type": "status", "state": "error", "usage": None}
        return

    # V0 FIX: cumulative session_usage — the Go engine accumulates this
    # per-session and feeds the context circle.
    usage = {
        "input_tokens": total_in,
        "output_tokens": total_out,
        "total_tokens": total_in + total_out,
    }
    yield {"type": "status", "state": "idle", "usage": usage}


def _build_effort_body(model: str, effort: str) -> dict:
    """Translate the effort level to the provider's extra_body.

    - OpenAI o-series: reasoning_effort = "low"|"medium"|"high"
    - Anthropic: thinking = {"type": "enabled", "budget_tokens": ...}
    - Others: no-op (effort is a UI concept only)
    """
    if effort == "off" or effort == "med":
        return {}
    if model.startswith("openai/o") or "o1" in model or "o3" in model:
        mapping = {"low": "low", "med": "medium", "high": "high", "max": "high"}
        return {"reasoning_effort": mapping.get(effort, "medium")}
    if model.startswith("anthropic/"):
        budget = {"low": 2000, "med": 4000, "high": 8000, "max": 16000}.get(effort, 4000)
        return {"thinking": {"type": "enabled", "budget_tokens": budget}}
    return {}
