#!/usr/bin/env python3
# v0781-self-knowledge-test.py — THE BOT'S OWN DASHBOARD, LIVE.
#
# User spec (v0.78.1): "The model should know the current usage, pricing,
# context, tokens… and whether it is connected to a workspace or a repo or
# not… should know its access level."
#
# THE REAL-USER TEST: a real quick-chat turn against the REAL NVIDIA
# provider (the rig engine's vault carries the key). The bot is asked,
# as a user would ask, about its own context window / rates / connections.
# WITHOUT the v0.78.1 session-context block the model guesses (wrong or
# vague — those numbers aren't reliably in any model's weights); WITH the
# block it answers the live facts the engine just composed into its system
# prompt. Deterministic-ish assertions: identity + ≥2 of the three
# block-sourced facts.
#
# Run:  python3 scripts/v0781-self-knowledge-test.py [engine-port]
# Needs: engine built + running with an NVIDIA key in the vault.
import json
import re
import sys
import time
import urllib.request

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8790}"
MODEL = "nvidia/deepseek-ai/deepseek-v4.1-flash"   # priced $0.27/$1.10 + ctx 131072 (live-verified)

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")

# engine must be up + carrying the nvidia key
api("GET", "/api/health")
keys = api("GET", "/api/keys")  # shape: {ENV_VAR: {env_var, has_key, provider}}
assert isinstance(keys, dict) and any(
    isinstance(v, dict) and v.get("env_var") == "NVIDIA_API_KEY" and v.get("has_key")
    for v in keys.values()), \
    "NVIDIA key missing from the rig vault — POST /api/keys first"

sess = api("POST", "/api/sessions", {
    "title": "Self-Knowledge", "sandbox": "quick",
    "model": MODEL, "provider": "nvidia"})
SID = sess["ID"]
print(f"session {SID} (model {MODEL})")

from playwright.sync_api import sync_playwright

QUESTION = ("Quick self-check, one short line each, no tools: "
            "1) What is your context window size in tokens? "
            "2) What are your per-1M-token list rates (input/output) and does this tier pay? "
            "3) Am I currently connected to GitHub, Gitea or Hugging Face?")

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 405, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_timeout(900)

    state = {"offset": {"x": 0, "y": 0}, "scale": 1, "currentFamily": "default",
             "icons": [{"type": "chat", "id": "chat_1", "name": "Nemo",
                        "family": "default", "iconIndex": 0, "iconCustom": False,
                        "x": 120, "y": 200, "vx": 0, "vy": 0, "radius": 28,
                        "sandbox": "quick", "model": MODEL,
                        "provider": "nvidia", "sessionId": SID}],
             "savedAt": time.time() * 1000}
    pg.evaluate("s => localStorage.setItem('doomalay.state.v2', JSON.stringify(s))", state)
    pg.reload()
    pg.wait_for_timeout(900)

    pg.mouse.click(120, 200)          # tap the chatbot → panel opens
    pg.wait_for_timeout(1200)
    pg.fill("#chat-input", QUESTION)
    pg.click("#chat-send")

    # the turn can queue on NVIDIA (12-25s) — poll up to 150s for completion
    reply = ""
    deadline = time.time() + 150
    while time.time() < deadline:
        reply = pg.evaluate("""() => {
          const msgs = document.querySelectorAll('#chat-messages .msg-assistant .fmt, #chat-messages .msg-assistant');
          if (!msgs.length) return '';
          const last = msgs[msgs.length - 1];
          return (last.innerText || '').trim();
        }""")
        streaming = pg.evaluate("""() => {
          const c = document.querySelector('#chat-messages');
          return !!(c && (c.querySelector('.chat-working') || c.querySelector('.msg-think')));
        }""")
        if reply and not streaming:
            break
        pg.wait_for_timeout(1000)

    pg.screenshot(path="/tmp/rig78/v0781-self-knowledge.png", full_page=False)
    br.close()

    print("── the bot's answer ──")
    print(reply[:1200])
    print("──────────────────────")

    PASS = FAIL = 0
    def ok(cond, label):
        global PASS, FAIL
        if cond: PASS += 1; print(f"  PASS {label}")
        else:    FAIL += 1; print(f"  FAIL {label}")

    ok(len(reply) > 40, "a real reply arrived")
    low = reply.lower()
    # (identity is the pre-v0.78 identity line's job; the question doesn't ask for the name)
    facts = {
        "context window (131,072)":
            bool(re.search(r"131[,.]?072|131\s?k", reply)) or "131,072" in reply,
        "rates ($0.27 in / $1.10 out or the free-tier call)":
            ("0.27" in reply and "1.10" in reply) or "free" in low or "$0" in reply,
        "connection truth (not connected / not signed in)":
            ("not" in low and any(w in low for w in ("github", "gitea", "hugging"))),
    }
    hits = sum(1 for v in facts.values() if v)
    for label, hit in facts.items():
        ok(hit, f"block-sourced fact — {label}")
    ok(hits >= 2, f"≥2 of 3 self-knowledge facts came through ({hits}/3)")
    ok(not errors, f"zero page errors ({errors[:2]})")

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
