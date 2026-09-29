"""test_redaction.py — v0.75 Phase 4: sentinel keys through every sink.

The shapes, the URL-credential pair, the event-dict choke point, the
oplog path — a bogus key that reaches any of them must come out ‹redacted:key›.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import redact  # noqa: E402

FAIL = []


def check(name, cond, extra=""):
    print(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if not cond else ""))
    if not cond:
        FAIL.append(name)


SENTINELS = [
    "sk-proj-abcdefghij1234567890abcdefghij",
    "sk-abcdefghij123456789",
    "nvapi-ABCDEFGHIJKLMNOPQRSTUV",
    "hf_ABCDEFGHIJKLMNOPQRSTUVWXyz",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
    "github_pat_11_ABCDEFGHIJKLMNOPQRSTUV",
    "glpat-ABCDEFGHIJKLMNOPQ",
    "dop_v1_abcdefghijklmnopqrst",
    "pypi-ABCDEFGHIJKLMNOPQRST",
    "xoxb-123456789012-abcdefghij",
    "AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    "ant-api-key-abcdefghij1234567890",
]

print("── shape redaction")
for sent in SENTINELS:
    out = redact.redact(f"provider said: {sent} is invalid")
    check(f"{sent[:14]}… redacted", sent not in out and "‹redacted:key›" in out, out)

print("── URL credential redaction")
out = redact.redact("failed to reach https://user:supersecret99@api.example.com/v1")
check("password half redacted, structure kept",
      "supersecret99" not in out and "://user:" in out and "@api.example.com" in out, out)

print("── innocence")
check("plain text untouched",
      redact.redact("a plain 404 error happened") == "a plain 404 error happened")
check("short words with dashes survive (sk-a, nvapi-b)",
      redact.redact("compare sk-a and nvapi-b prefixes") == "compare sk-a and nvapi-b prefixes")
check("non-string input stringified safely", redact.redact(12345) == "12345")

print("── the event choke point (redact_dict)")
ev = {"type": "error", "error": "llm", "message": "401 with sk-abcdefghij123456789",
      "text": "nvapi-ABCDEFGHIJKLMNOPQRSTUV echoed", "provider": "nvidia", "suggest": ["a"]}
redact.redact_dict(ev)
check("message redacted", "sk-abcdefghij123456789" not in ev["message"])
check("text redacted", "nvapi-" + "ABCDEFGHIJKLMNOPQRSTUV" not in ev["text"])
check("non-message fields untouched", ev["provider"] == "nvidia" and ev["suggest"] == ["a"])

print("── the oplog sink (dual-write path)")
os.environ["DOOMALAYSOCREATE_LOG"] = "1"
try:
    import importlib
    import oplog
    importlib.reload(oplog)
    # capture stderr
    import io
    import contextlib
    buf = io.StringIO()
    # oplog writes to sys.stderr directly (and the ring); swap it
    old_err = sys.stderr
    sys.stderr = buf
    try:
        oplog.log_event("tool_result", text="the key was sk-abcdefghij123456789 here")
    finally:
        sys.stderr = old_err
    line = buf.getvalue()
    check("oplog output redacted",
          "sk-abcdefghij123456789" not in line and "‹redacted:key›" in line, line.strip()[:100])
finally:
    os.environ.pop("DOOMALAYSOCREATE_LOG", None)

print("── the server.py choke points exist (source contract)")
src = (HERE / "server.py").read_text(encoding="utf-8")
check("/chat error wrapper redacts", "redact.redact_dict(ev)" in src)
check("/chat except path redacts", '"message": redact.redact(str(e))' in src)
check("/judge error paths redact", src.count("redact.redact") >= 3)

print(f"\n{len(FAIL)} failures")
if FAIL:
    for f in FAIL:
        print("  -", f)
    sys.exit(1)
print("ALL REDACTION SINKS LOCKED")
