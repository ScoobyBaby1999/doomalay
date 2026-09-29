"""redact.py — v0.75 in-flight redaction (Phase 4 log hygiene).

Every sink that persists or forwards error text — the brain's SSE error
events (the /chat + /judge choke points stamp every one), the oplog —
passes strings through redact() first. A provider 401 that echoes the
Authorization header, a tool result that prints a key, an exception with
a URL credential: none of it survives in flight.

The patterns are SHAPE-based (the brain never sees the engine's vault,
so exact values are unknowable here; the engine-side twin
internal/server/redact.go ADDS exact vault-value matching). Shapes cover
the providers we actually ship plus the common forges/services.
"""
from __future__ import annotations

import re

# Ordered longest-first so overlapping prefixes don't half-match.
_PATTERNS = [
    # OpenAI-style
    r"sk-[A-Za-z0-9_-]{16,}",
    r"sk-proj-[A-Za-z0-9_-]{20,}",
    # NVIDIA NIM
    r"nvapi-[A-Za-z0-9_-]{16,}",
    # Hugging Face tokens (fine-grained + classic shapes)
    r"hf_[A-Za-z0-9]{20,}",
    # GitHub tokens (PAT classic, fine-grained, OAuth app/user/server/refresh)
    r"ghp_[A-Za-z0-9]{20,}",
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"gho_[A-Za-z0-9]{20,}",
    r"ghu_[A-Za-z0-9]{20,}",
    r"ghs_[A-Za-z0-9]{20,}",
    r"ghr_[A-Za-z0-9]{20,}",
    # GitLab / DigitalOcean / PyPI / Slack / Google / Anthropic-ish
    r"glpat-[A-Za-z0-9_-]{15,}",
    r"dop_v1_[A-Za-z0-9]{20,}",
    r"pypi-[A-Za-z0-9]{20,}",
    r"xox[baprs]-[A-Za-z0-9-]{10,}",
    r"AIza[A-Za-z0-9_-]{30,}",
    r"ant-api-key-[A-Za-z0-9_-]{20,}",
    # The engine's own space tokens (hex secrets minted at create time)
    r"doom-space-[A-Za-z0-9_-]{16,}",
]

_RE = re.compile("|".join(_PATTERNS))
# A URL-embedded credential (https://user:pass@host) — the pair itself.
_URL_CREDS = re.compile(r"(://[^/\s:@]+:)([^@\s]{8,})(@)")

REDACTED = "‹redacted:key›"


def redact(text) -> str:
    """Redact key-shaped substrings. Never raises; non-strings stringify."""
    try:
        s = text if isinstance(text, str) else str(text)
    except Exception:
        return ""
    try:
        s = _RE.sub(REDACTED, s)
        s = _URL_CREDS.sub(r"\1" + REDACTED + r"\3", s)
        s = _RE.sub(REDACTED, s)  # once more: shapes may un-wrap from URLs
    except Exception:
        pass
    return s


def redact_dict(d: dict, keys=("message", "error", "text", "detail", "content")) -> dict:
    """Redact the message-carrying fields of an event dict IN PLACE (the
    sinks' choke point). Returns the same dict for chaining."""
    if not isinstance(d, dict):
        return d
    for k in keys:
        if k in d and isinstance(d[k], str):
            d[k] = redact(d[k])
    return d
