"""v1.10.2 THE BLACK-HOLE GUARD (brain side) — pre-flight provider
reachability for HF-space deployments.

Live-found (2026-10-06, the v110 D1 diagnosis): integrate.api.nvidia.com
silently stalls HF-originated calls — the agent's model call sits silent
essentially forever (per-call timeout 86400s) while the heartbeat pump
tells the user "still working — Ns elapsed". Every other provider answers
in seconds with REAL API errors, so this is provider-specific egress
behavior, not a general outage — and it CHANGES (NVIDIA worked from HF on
2026-10-01), so the verdict must be live-probed, never hardcoded.

THE DESIGN (respecting the v0.80.1 no-kill directive — no timer may cancel
a RUNNING turn): probe BEFORE the first model call of a turn, never during.
A 1-token completion with a 15s budget; verdicts:
  ok    -> cached 10 min (warm providers add zero latency)
  stall -> cached 30 min as "cooling" — turns fail FAST (~15s) with an
          honest, actionable error instead of hanging a day
  error -> NOT a stall (a real HTTP error response proves egress works —
          auth/billing/quota failures surface through the normal turn path
          with their real messages)

Only active when running inside a Space (env SPACE_ID present) — the local
brain never probes (its egress is the user's own device network).
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

# module state: {provider_name: {"verdict": "ok"|"stall", "until": ts}}
_CACHE: dict[str, dict] = {}
_LOCK = threading.Lock()

_OK_TTL = 10 * 60        # a passing probe is trusted for 10 minutes
_STALL_TTL = 30 * 60     # a stalling provider cools down for 30 minutes
# v1.10.2 CALIBRATION (live-measured 2026-10-06): NVIDIA's chat endpoint
# answered a 1-token probe in 29.3s while its /v1/models answered in 0.17s
# — the free-tier queue is SLOW, not dead. A 15s budget would have
# false-positive'd a working provider. 120s = 4x the observed healthy-queue
# worst case; the 10-06 black hole (125s+ of heartbeats, zero LLM events,
# per-call timeout 86400s) still fails it. A true black hole now costs 120s
# before the honest error instead of a day — a 720x improvement.
_PROBE_TIMEOUT = 120


def on_space() -> bool:
    """True when running inside an HF Space (the only deployment that probes)."""
    return bool(os.environ.get("SPACE_ID") or os.environ.get("HF_SPACE_ID"))


def _probe_once(base_url: str, api_key: str, model: str,
                 budget: float | None = None) -> str:
    """One 1-token reachability probe against the provider's chat endpoint.

    Any HTTP response — including 401/402/429 — proves the endpoint ANSWERS
    from here (egress fine); only a timeout / connect stall is a "stall".
    budget: the timeout in seconds (tests inject a small value; production
    uses _PROBE_TIMEOUT — see the calibration note above).
    """
    if budget is None:
        budget = _PROBE_TIMEOUT
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        base_url, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "doomalay-brain-probe/1.10.2",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=budget) as resp:
            resp.read(256)  # drain the head — the status line already decided it
            return "ok"
    except urllib.error.HTTPError:
        # a real API answer (auth refused, quota, billing…) — egress WORKS;
        # let the actual turn surface the provider's honest error message.
        return "ok"
    except Exception:
        return "stall"


def check(provider: str, base_url: str, api_key: str, model: str) -> str | None:
    """Pre-flight gate for a turn. Returns None to proceed, or an honest
    error message the caller streams to the user (fail-fast path).
    Never raises; a probe crash reads as "ok" (the turn runs normally).
    """
    if not on_space():
        return None
    if not base_url or not api_key or not model:
        return None
    now = time.time()
    with _LOCK:
        entry = _CACHE.get(provider)
        if entry:
            if entry["verdict"] == "ok" and now < entry["until"]:
                return None
            if entry["verdict"] == "stall" and now < entry["until"]:
                return (
                    f"{provider} is not answering from this sandbox right now "
                    f"(a reachability check failed less than 30 min ago — the provider "
                    f"has been stalling from Hugging Face egress). No tokens were spent. "
                    f"Switch to another provider for this turn, or retry {provider} "
                    f"in {int((entry['until'] - now) // 60) + 1} min."
                )

    verdict = "ok"
    try:
        verdict = _probe_once(base_url, api_key, model)
    except Exception:
        verdict = "ok"  # the probe itself misbehaving must never block a turn

    with _LOCK:
        _CACHE[provider] = {
            "verdict": verdict,
            "until": now + (_OK_TTL if verdict == "ok" else _STALL_TTL),
        }
    if verdict == "stall":
        mins = _PROBE_TIMEOUT // 60
        return (
            f"{provider} did not answer a {mins}-minute reachability check from "
            f"this sandbox (its API has been stalling from Hugging Face egress — "
            f"observed live with NVIDIA). No tokens were spent. Switch to another "
            f"provider for this turn (the model picker), or retry {provider} in ~30 min."
        )
    return None


def reset_cache() -> None:
    """Test seam — clear the verdict cache."""
    with _LOCK:
        _CACHE.clear()
