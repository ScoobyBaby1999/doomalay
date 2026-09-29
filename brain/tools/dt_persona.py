"""dt_persona.py — the persona hand for the BRAIN path (v0.76.4).

THE GAP (found in the v0.76 E2E): the engine's direct + PM paths have
persona_list/persona_set/persona_activate/persona_placeholder (the v0.73
PERSONA HAND — a downloaded hub persona becomes the chat's active persona
with a deterministic PERSONA ACTIVE marker), but the brain path — local
sandbox and the HF space chats — had NO persona tool: models could browse
and DOWNLOAD personas via hublib, then flail (the download observation
teaches a persona_set follow-up the sandbox couldn't run). This module is
the bridge: every action proxies to the engine's session-scoped persona
runner (GET /api/tools/local?name=persona_…&args=…&session=…), the same
one-source-of-truth the PM bridge uses.

Degradation is honest: no engine URL (offline tests) or an unreachable
engine (a REMOTE space can't see the user's device) returns an actionable
message, never a hang, and the remote case says exactly where persona
switching works (the user's device / quick chat).

State: none (the engine's session store is the truth). httpx lazy; the
dt_spec rules hold (never raise into the loop, ~5s timeout, observations
clipped).
"""
from __future__ import annotations

import json
from urllib.parse import quote

TOOL_NAMES = ["persona"]

_TIMEOUT = 6.0   # a persona flip is a tiny engine round-trip

TOOL_DESCRIPTION = (
    "Switch, inspect, or import this chat's personas — the character sheets "
    "that shape how you speak. Use when the user asks you to become or act "
    "like someone else, to list the personas on this chat, or right after "
    "downloading a hub persona with hublib (persona {action:'set', "
    "from:'<name>', activate:true} makes it THE active persona — the reply "
    "carries the PERSONA ACTIVE marker). Actions: list (this chat's "
    "personas + the downloaded hub personas importable via from), set "
    "(from a hub persona / by id / or a fresh text sheet; activate:true "
    "promotes it), activate {id} (or no id to return to the app default), "
    "placeholder (the chat's custom fill-ins), help."
)

HELP = """persona — switch, inspect, or import this chat's personas.
    Actions:
  list                     personas on this chat + downloaded hub personas
  set                      import (from:'<hub name>'), edit (id:…), or
                           create (text:…); name:… labels it;
                           activate:true makes it THE active persona
  activate                 {id} promotes one; NO id deactivates everything
                           (the app's default persona returns)
  placeholder              this chat's placeholder values ({name} etc.)
  help                     this sheet
  Persona text is a full character sheet; the ACTIVE one shapes every
  later turn. Downloading a hub persona (hublib) does NOT activate it —
  call set {from, activate:true} to make it live."""


# ── plain core (no HTTP, no strands) ─────────────────────────────────────

def _engine_base(ctx) -> str:
    return str(getattr(ctx, "engine_url", "") or "").rstrip("/")


def _session_id(ctx) -> str:
    return str(getattr(ctx, "chat_session_id", "") or "")


def run_action(ctx, action: str, args: dict | None = None) -> str:
    """Proxy one persona action to the engine's session-scoped runner."""
    action = (action or "").strip().lower()
    args = dict(args or {})

    if action in ("", "help"):
        return HELP

    engine = _engine_base(ctx)
    sid = _session_id(ctx)
    if not engine or not sid:
        return ("personas live on the user's engine (their device) — this "
                "sandbox has no engine URL to reach. On the device the "
                "quick-chat path switches personas; here you can only "
                "recommend one the user imports from the hub panel.")

    name_map = {
        "list": "persona_list",
        "set": "persona_set",
        "activate": "persona_activate",
        "placeholder": "placeholder_set",
    }
    engine_tool = name_map.get(action)
    if engine_tool is None:
        return ("persona error: unknown action '" + str(action) + "'. Valid: "
                + ", ".join(sorted(name_map)) + ", help.")

    # the engine's placeholder_set expects a verb; keep the passthrough thin
    if engine_tool == "placeholder_set":
        verb = args.pop("verb", "") or args.pop("action_verb", "")
        if verb:
            args["verb"] = verb

    qs = "name=" + quote(engine_tool)
    qs += "&session=" + quote(sid)
    if args:
        qs += "&args=" + quote(json.dumps(args))

    try:
        import httpx
        with httpx.Client(timeout=_TIMEOUT) as client:
            r = client.get(engine + "/api/tools/local?" + qs)
        if r.status_code != 200:
            return (f"persona error: engine answered {r.status_code} — "
                    "the persona store is on the user's device; if this is "
                    "a remote sandbox, persona switching works on the "
                    "device's quick chat.")
        blob = r.json()
        out = str(blob.get("result") or "")
        if out.startswith("OBSERVATION:\n"):
            out = out[len("OBSERVATION:\n"):]
        return out[:4000] if out else "(empty persona observation)"
    except Exception as exc:
        return (f"persona error: the engine at {engine} is unreachable "
                f"({type(exc).__name__}) — personas are engine-side. On a "
                "remote sandbox ask the user to switch persona from the "
                "device; on the device's own sandbox check the engine is "
                "running.")


# ── strands surface ──────────────────────────────────────────────────────

def build(ctx) -> list:
    try:
        from strands import tool as strands_tool_decorator
    except Exception:
        return []

    try:
        @strands_tool_decorator(name="persona", description=TOOL_DESCRIPTION)
        def persona(action: str, frm: str = "", pid: str = "",
                    name: str = "", text: str = "",
                    activate: bool = False) -> str:
            """Work with this chat's personas (character sheets).

            action: list | set | activate | placeholder | help
            frm: hub persona name to import (persona_set {"from"}) — a
                persona you downloaded via hublib; use with activate
            pid: persona id for set (edit) / activate (promote)
            name: label for a new/imported persona
            text: full character-sheet text for a fresh persona
            activate: make it THE always-active persona of this chat
            """
            try:
                args: dict = {}
                if frm:
                    args["from"] = frm
                if pid:
                    args["id"] = pid
                if name:
                    args["name"] = name
                if text:
                    args["text"] = text
                if activate:
                    args["activate"] = True
                return run_action(ctx, action, args)
            except Exception as exc:  # never raise into the loop
                return f"persona error: {type(exc).__name__}: {exc}"

        return [persona]
    except Exception:
        return []  # decorator/schema trouble: register nothing


# ── offline self-test: python3 tools/dt_persona.py ───────────────────────
def _selftest() -> int:
    import types

    fails = 0

    def expect(label, got, want_substr):
        nonlocal fails
        ok = want_substr.lower() in str(got).lower()
        print(("  ok   " if ok else "  FAIL ") + label)
        if not ok:
            fails += 1
            print(f"       got: {str(got)[:160]}")

    print("dt_persona selftest (no engine — the honest degradation path)")

    ctx = types.SimpleNamespace(engine_url="", chat_session_id="s1")
    expect("no engine → honest message", run_action(ctx, "list"),
           "no engine URL")

    ctx2 = types.SimpleNamespace(engine_url="http://eng.test",
                                 chat_session_id="s1")
    expect("unreachable engine → honest message", run_action(ctx2, "list"),
           "unreachable")

    expect("help sheet", run_action(ctx, "help"), "Actions")

    # engine proxy via MockTransport
    import httpx
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if "name=persona_list" in str(request.url):
            return httpx.Response(200, json={
                "tool": "persona_list",
                "result": "OBSERVATION:\n{\"personas\":[], \"hub_personas\":[]}"})
        if "name=persona_set" in str(request.url):
            return httpx.Response(200, json={
                "tool": "persona_set",
                "result": "OBSERVATION:\nPERSONA ACTIVE — Noir Detective."})
        return httpx.Response(200, json={"tool": "?", "result": "?"})

    real_get = httpx.Client.get

    def patched_get(self, url, **kw):
        transport = httpx.MockTransport(handler)
        with httpx.Client(transport=transport, timeout=_TIMEOUT) as c2:
            return real_get(c2, url, **kw)

    httpx.Client.get = patched_get
    try:
        out = run_action(ctx2, "list")
        expect("list proxies with session param", calls[-1] if calls else "",
               "session=s1")
        expect("list strips OBSERVATION prefix", out, "personas")

        out2 = run_action(ctx2, "set", {"from": "Noir Detective",
                                        "activate": True})
        expect("set from+activate proxies", out2, "PERSONA ACTIVE — Noir")
        expect("set URL carries from", calls[-1], "from")
    finally:
        httpx.Client.get = real_get

    print(f"\n{'FAIL' if fails else 'PASS'}: {fails} failures")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
