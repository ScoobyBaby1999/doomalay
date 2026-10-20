#!/usr/bin/env python3
# v1460-clean-mind-rig.py — v1.46.3 THE PROOF (PLAN-V146 §3): the live
# red-team battery for THE CLEAN MIND, driven the way the real user drives
# the app (a real engine + a real browser page, real key — the user's exact
# report shape: PM-native reasoning that used to show every word twice).
#
#   PM_KEY=... [ENGINE_PORT=8099] python3 scripts/v1460-clean-mind-rig.py
#
#   RA  THE ALIAS LAW, live through the ENGINE (the app's own WS protocol):
#       a real glm-5.3 turn — the persisted thinking events contain NO
#       doubled words (adjacent-word duplicate rate < 0.20; the pre-fix
#       bug measured 0.47 live and doubled EVERY word:
#       'TheThe user user asks asks:: What What is is 2 2++22??…'), the
#       answer is intact, and the turn ends idle (not error/busy).
#   RB  THE REASONING LEDGER, live: the session usage totals + per-model
#       rows carry the provider's reasoning share (reasoning_tokens > 0 on
#       the probe-proven prompt), and the fleet endpoint sums it.
#   RC  THE SOURCE PINS: mergeWireReasoning exists with the alias law and
#       BOTH chat.go merge sites consume it (no raw concatenation left),
#       the live-captured alias pair rides the fixture tests, the usage
#       parse reads the OpenAI detail block, mergeUsage sums the share
#       from birth, the usage panel renders the 🧠 stat on both views with
#       theme tokens only, and the pmlive gate exists.
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8099"))
PM_KEY = os.environ.get("PM_KEY", "")
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    mark = "✓" if ok else "✗"
    print(f"  {mark} {name}" + (f" — {detail}" if detail and not ok else ""))
    if ok:
        PASS += 1
    else:
        FAIL += 1


def api(base, path, method="GET", body=None, timeout=90):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def adjacent_dup_rate(text):
    words = [w.lower() for w in re.findall(r"[\w']+", text)]
    if len(words) < 6:
        return 0.0
    dups = sum(1 for i in range(1, len(words)) if words[i] == words[i - 1])
    return dups / (len(words) - 1)


def session_events(base, sid):
    data = api(base, f"/api/sessions/{sid}/events?since=0")
    evs = data if isinstance(data, list) else data.get("events", data.get("data", []))
    return evs


def main():
    if not PM_KEY:
        print("FATAL: set PM_KEY (real key — the rig is LIVE)")
        sys.exit(1)

    data_dir = tempfile.mkdtemp(prefix="v1460-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1460-log-", delete=False)
    bin_path = "/tmp/doomalay-v1460-rig"
    r = subprocess.run(
        ["/home/z/sdk/go/bin/go", "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-400:])
        sys.exit(1)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1"},
        stdout=log, stderr=log,
    )
    pw = None
    try:
        base = f"http://127.0.0.1:{PORT}"
        up = False
        for _ in range(60):
            try:
                api(base, "/api/health", timeout=5)
                up = True
                break
            except Exception:
                time.sleep(0.5)
        if not up:
            print("FATAL: engine did not start")
            sys.exit(1)

        api(base, "/api/keys", "POST", {"provider": "privatemodeai", "key": PM_KEY})

        print("RA — THE ALIAS LAW, live through the engine's own WS protocol")
        sid = api(
            base, "/api/sessions", "POST",
            {"provider": "privatemodeai", "model": "glm-5.3", "title": "v1460 clean-mind rig"},
        )["ID"]

        # Drive the turn the way the app's chatframework does: a WS to
        # /api/chat with {type:'send'} — collect the wire events in-page.
        # The prompt is the reasoning-FORCING one (17×23 arithmetic — glm-5.3's
        # dynamic reasoning skips recall facts like "2+2" intermittently;
        # multi-step arithmetic streamed thinking on every probe run).
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page()
        page.goto(base + "/")
        page.evaluate(
            """(sid) => new Promise((resolve) => {
                window.__ev = [];
                const ws = new WebSocket('ws://127.0.0.1:' + location.port + '/api/chat?session_id=' + sid);
                ws.onopen = () => { ws.send(JSON.stringify({session_id: sid, type: 'send', message: 'Think step by step: what is 17 times 23? Answer with just the number.' })); };
                ws.onmessage = (m) => {
                  try { window.__ev.push(JSON.parse(m.data)); } catch (e) {}
                  const ev = window.__ev[window.__ev.length - 1];
                  if (ev && ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) { ws.close(); resolve('done'); }
                };
                ws.onerror = () => resolve('wserr');
                setTimeout(() => resolve('timeout'), 150000);
            })""" , sid
        )
        page.wait_for_timeout(500)

        evs = session_events(base, sid)
        # the listed events carry their payload in `text` (the v0.20 persist shape)
        thinking = " ".join(e.get("text", "") for e in evs if e.get("type") == "thinking")
        reply = next((e.get("text", "") for e in reversed(evs) if e.get("type") == "assistant" and e.get("text")), "")
        rate = adjacent_dup_rate(thinking)
        idle = any(e.get("state") == "idle" for e in evs if e.get("type") == "status")
        check("RA1: glm-5.3 streamed thinking (the reasoning-forcing prompt)", len(thinking) > 40, f"{len(thinking)} chars")
        check(f"RA2: NO doubled words (adj-dup rate {rate:.3f} < 0.20; pre-fix measured 0.47)", rate < 0.20, thinking[:120])
        check("RA3: the answer is intact", "391" in reply, repr(reply[:60]))
        check("RA4: the turn terminated idle", idle)

        print("RB — THE REASONING LEDGER, live")
        usage = api(base, f"/api/sessions/{sid}/usage")
        totals = usage.get("totals", {})
        models = usage.get("models", [])
        m0 = models[0] if models else {}
        check("RB1: the chat total carries the reasoning share", totals.get("reasoningTokens", 0) > 0, str(totals))
        check("RB2: the per-model row carries it too", m0.get("reasoningTokens", 0) == totals.get("reasoningTokens", -1))
        fleet = api(base, "/api/usage")
        ft = fleet.get("totals", {})
        check("RB3: the fleet endpoint sums the share", ft.get("reasoningTokens", 0) >= totals.get("reasoningTokens", 1), str(ft))

        print("RC — THE SOURCE PINS")
        def read(p):
            with open(os.path.join(ROOT, p), encoding="utf-8") as f:
                return f.read()
        reasoning_go = read("engine/internal/llm/reasoning.go")
        chat_go = read("engine/internal/llm/chat.go")
        usagepanel_js = read("engine/internal/server/web/usagepanel.js")
        live_test = read("engine/internal/server/pm_v1461_live_test.go")
        fixture_test = read("engine/internal/llm/reasoning_v1461_test.go")

        check("RC1: mergeWireReasoning exists with the alias law", "func mergeWireReasoning(" in reasoning_go and "case reasoningContent == reasoning:" in reasoning_go)
        check("RC2: BOTH chat.go merge sites consume the merge", chat_go.count("mergeWireReasoning(choice.Delta.Reasoning, choice.Delta.ReasoningOR)") == 2)
        check("RC3: no raw concatenation of the two spellings remains", "choice.Delta.Reasoning+choice.Delta.ReasoningOR" not in chat_go)
        check("RC4: the live-captured alias pair rides the fixtures", '"reasoning":"The","reasoning_content":"The"' in fixture_test)
        check("RC5: the usage parses the OpenAI detail block", "completion_tokens_details" in chat_go)
        check("RC6: mergeUsage sums the reasoning share", "ReasoningTokens: a.ReasoningTokens + b.ReasoningTokens" in chat_go)
        check("RC7: the panel renders the 🧠 stat on session + fleet views", usagepanel_js.count("thinkStat(") >= 3 and "usf-think" in usagepanel_js)
        check("RC8: the pmlive gate exists (no-doubbled-words assertion)", "adjDupRate" in live_test and "0.2" in live_test)
        new_panel_colors = re.findall(r"color:\s*(#[0-9a-fA-F]{3,8})\b", usagepanel_js)
        check("RC9: the new UI rides theme tokens only (no hardcoded colors)", len(new_panel_colors) == 0, str(new_panel_colors))
    finally:
        if pw:
            try:
                pw.stop()
            except Exception:
                pass
        eng.terminate()
        try:
            eng.wait(5)
        except Exception:
            eng.kill()

    print()
    print("═" * 44)
    verdict = "PASS" if FAIL == 0 else "FAIL"
    print(f"v1460 clean-mind rig: {PASS}/{PASS + FAIL} — {verdict}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
