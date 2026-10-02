#!/usr/bin/env python3
"""v0937-fresh-session-redteam.py — P7 closeout: the user's issue 14 bar.

"fresh session（无先验上下文）必须能用所有 provider 在 HF sandbox 里
bash/ssh；此前模型建过 sandbox，但新聊天里模型说做不到、不知道
harness.md 是什么/在哪"

For EVERY connected provider (nvidia, mistral, openrouter — the non-PM
set the shared space relays), on a FRESH session each:
  1. ask the bot to cat HARNESS.md in its workspace (the awareness test —
     v0.93.3's chat-path seed),
  2. run real bash (uname -a + a python one-liner) and show the output,
  3. report what it did honestly.

Pass = the turn completes with real command output in the final answer
(uname/Linux present) AND the harness mention (or an actual read). The
SSE stream is consumed to its end (status idle).
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

SECRETS = Path("/home/z/my-project/.secrets").read_text()
def sec(name):
    try:
        return SECRETS.split(name + "=")[1].split("\n")[0].strip()
    except Exception:
        return ""

HF_TOKEN = sec("HF_TOKEN")
SPACE = "https://scoobybaby1999-doomalaysocreate.hf.space"

PROVIDERS = [
    # (provider, model, env var, key)
    ("nvidia", "nvidia/deepseek-ai/deepseek-v4.1-flash", "NVIDIA_API_KEY", sec("NVIDIA_API_KEY")),
    ("mistral", "mistral/codestral-2508", "MISTRAL_API_KEY", sec("MISTRAL_API_KEY")),
    ("openrouter", "openrouter/liquid/lfm-2.5-2.6b:free", "OPENROUTER_API_KEY", sec("OPENROUTER_API_KEY")),
]

PROMPT = (
    "Capability check, fresh session. (1) Read HARNESS.md at your workspace root, "
    "name its 2 most important sections. (2) Run exactly: uname -a && python3 -c 'print(6*7)' "
    "and paste the real output. (3) One line: are you in a real Linux sandbox? Be brief."
)


def turn(provider, model, envvar, key, timeout=560):
    sid = f"v0937-fresh-{provider}-{int(time.time())}"
    body = json.dumps({
        "session_id": sid, "message": PROMPT, "model": model,
        "provider": provider, "web_search": False,
    }).encode()
    req = urllib.request.Request(SPACE + "/chat", data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-HF-Token": HF_TOKEN,
        f"X-Env-{envvar}": key,
    })
    final = []
    thinking = []
    tools = []
    status = None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:])
            except Exception:
                continue
            t = ev.get("type")
            if t == "assistant_delta":
                final.append(ev.get("content", "") or ev.get("text", ""))
            elif t == "thinking_delta":
                thinking.append(ev.get("content", "") or ev.get("text", ""))
            elif t in ("tool_use", "tool_result", "tool"):
                tools.append(json.dumps(ev)[:120])
            elif t == "status":
                status = ev.get("state")
            elif t == "error":
                final.append("[ERROR] " + str(ev.get("message", ev))[:200])
    return "".join(final), "".join(thinking), tools, status


def main():
    overall = True
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    for provider, model, envvar, key in PROVIDERS:
        if only and only != provider:
            continue
        print(f"── {provider} ({model})")
        if not key:
            print(f"  ✗ no key for {envvar} in .secrets — SKIP")
            overall = False
            continue
        try:
            final, thinking, tools, status = turn(provider, model, envvar, key)
        except Exception as e:
            print(f"  ✗ turn failed: {str(e)[:160]}")
            overall = False
            continue
        low = (final + " " + thinking).lower()
        bash_ok = ("linux" in low or "gnu/linux" in low) and ("42" in final or "42" in "".join(tools))
        harness_ok = "harness" in low
        n_tools = len(tools)
        print(f"  {'✓' if bash_ok else '✗'} real bash output (uname/Linux + 42) — answer {len(final)} chars")
        print(f"  {'✓' if harness_ok else '✗'} knows HARNESS.md")
        print(f"  · {n_tools} tool events, status={status}, thinking {len(thinking)} chars")
        if not bash_ok:
            print(f"    answer head: {final[:300]!r}")
        overall &= bash_ok and harness_ok
    print("\nFRESH-SESSION RED-TEAM:", "ALL PASS" if overall else "FAILURES PRESENT")
    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
