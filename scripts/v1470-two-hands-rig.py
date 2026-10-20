#!/usr/bin/env python3
# v1470-two-hands-rig.py — v1.47.4 THE PROOF (PLAN-V147 §4): the live
# red-team battery for THE TWO HANDS + THE BRIDGE PURGE, driven the way
# the real user drives the app: a real engine + a real browser page on
# the engine's own WS chat protocol, real keys, real model turns that
# REALLY call the tools.
#
#   RIG_MODEL (default minimax/minimax-m3.1-flash:free) is the live-turn
#   model — any OpenRouter model with native tool calling works (the probe
#   verified the exact tool_call shape on this one).
#
#   OPENROUTER_API_KEY=... [ENGINE_PORT=8098] python3 scripts/v1470-two-hands-rig.py
#
#   (PM's key is quota-exhausted this month — "you have exceeded your
#   organization's monthly limit of 1000000 prompt tokens", the same 401
#   that killed the Kenny bot mid-plan — so the rig drives its turns
#   through OpenRouter's free router, whose native tool calling the probe
#   verified live. The journal + fleet hands are provider-agnostic: the
#   manifest rides the standard tools[] wire.)
#
#   RA  THE JOURNAL HAND, live through the ENGINE (the app's own WS
#       protocol): a real model turn calls djournal write (the persisted
#       tool_use + the Saved-confirmation receipt with the mood glyph),
#       the diary file lands under <DataDir>/journal/entries.jsonl, a
#       read turn returns the entry, a review turn returns the stats, and
#       an export turn writes the state-dir file AND sinks the artifact
#       card into the session's drawer (GET /api/sessions/:id/artifacts).
#   RB  THE FLEET HAND, live: seeded chats across a canvas (the digest
#       join), a roster turn lists them with title/model/canvas/state/
#       turns, the q filter narrows, a detail turn expands one card, and
#       a REAL mid-turn probe: a long generation runs in one chat while
#       a fleet roster in another shows it RUNNING (the turn gauge — the
#       engine's own live-turn truth).
#   RC  THE BRIDGE PURGE, live: the five /api/tools/* routes answer 404
#       (the old PM bridge's orphaned contract is gone) while the
#       current surfaces stay: /api/health answers, and the brain's PM
#       bridge (/api/pm/local/v1/chat/completions) still answers with its
#       honest api-key-fallback=never 401.
#   RD  THE SOURCE PINS: both Defs + both Turn closures + both handler
#       cases + both ChatRequest fields + both direct-dispatch cases +
#       the census at 31; the pyRound banker's law; the gold parity
#       cross-check file; the DataDir journal path + the bare-string
#       tolerance; the fleet's gauge + digest joins; ZERO handleTools*
#       handlers or /api/tools registrations left.
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error

import websocket as ws_client  # websocket-client: a plain-WS turn driver (thread-safe where sync-playwright is not)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8098"))
RIG_MODEL = os.environ.get("RIG_MODEL", "minimax/minimax-m3.1-flash:free")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
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


def http_code(base, path, method="GET", body=None):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def session_events(base, sid):
    data = api(base, f"/api/sessions/{sid}/events?since=0")
    return data if isinstance(data, list) else data.get("events", data.get("data", []))


def ws_turn_raw(port, sid, message, timeout_s=200):
    """One WS turn over plain websockets (thread-safe — sync-playwright is
    bound to its creating thread). Returns the persisted events."""
    import queue
    q = queue.Queue()

    def run():
        try:
            w = ws_client.create_connection(
                f"ws://127.0.0.1:{port}/api/chat?session_id={sid}", timeout=timeout_s)
            w.send(json.dumps({"session_id": sid, "type": "send", "message": message}))
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                try:
                    m = json.loads(w.recv())
                except Exception:
                    break
                if m.get("type") == "status" and m.get("state") in ("idle", "error"):
                    break
            try:
                w.close()
            except Exception:
                pass
            q.put("done")
        except Exception as e:
            q.put("err: " + str(e)[:120])

    threading.Thread(target=run, daemon=True).start()
    try:
        q.get(timeout=timeout_s + 10)
    except queue.Empty:
        pass
    return session_events(BASE, sid)


def ws_turn(page, base, sid, message, timeout_ms=150000):
    """One WS turn the way the app's chatframework drives it. Returns the events."""
    page.evaluate(
        """([sid, msg, timeoutMs]) => new Promise((resolve) => {
            window.__ev = [];
            const ws = new WebSocket('ws://127.0.0.1:' + location.port + '/api/chat?session_id=' + sid);
            ws.onopen = () => { ws.send(JSON.stringify({session_id: sid, type: 'send', message: msg })); };
            ws.onmessage = (m) => {
              try { window.__ev.push(JSON.parse(m.data)); } catch (e) {}
              const ev = window.__ev[window.__ev.length - 1];
              if (ev && ev.type === 'status' && (ev.state === 'idle' || ev.state === 'error')) { ws.close(); resolve('done'); }
            };
            ws.onerror = () => resolve('wserr');
            setTimeout(() => resolve('timeout'), timeoutMs);
        })""",
        [sid, message, timeout_ms],
    )
    page.wait_for_timeout(400)
    return session_events(BASE, sid)


def tool_results(evs, name):
    """The tool_result texts for one tool, in order. The persisted event
    carries its payload as a JSON-encoded string in `text`
    ({name, text} for results) — the replay parser's own shape."""
    out = []
    for e in evs:
        if e.get("type") != "tool_result":
            continue
        payload = {}
        try:
            payload = json.loads(e.get("text", ""))
            if not isinstance(payload, dict):
                payload = {"text": e.get("text", "")}
        except Exception:
            payload = {"text": e.get("text", "")}
        if payload.get("name", "") == name or (not payload.get("name") and name == ""):
            out.append(payload.get("text", ""))
    return out


def any_tool_use(evs, name):
    for e in evs:
        if e.get("type") != "tool_use":
            continue
        try:
            payload = json.loads(e.get("text", ""))
        except Exception:
            payload = {}
        if isinstance(payload, dict) and payload.get("name", "") == name:
            return True
    return False


BASE = f"http://127.0.0.1:{PORT}"


def fresh_session(title="v1470 rig"):
    """A brand-new session per action turn: no history means the model
    cannot answer from memory — it MUST call the tool (flash models
    imitate earlier tool_calls otherwise)."""
    return api(
        BASE, "/api/sessions", "POST",
        {"provider": "openrouter", "model": RIG_MODEL, "title": title},
    )["ID"]





def main():
    global BASE
    if not OPENROUTER_KEY:
        print("FATAL: set OPENROUTER_API_KEY (PM's key is quota-dead this month; the rig rides minimax-m2)")
        sys.exit(1)

    data_dir = tempfile.mkdtemp(prefix="v1470-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v1470-log-", delete=False)
    bin_path = "/tmp/doomalay-v1470-rig"
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
        up = False
        for _ in range(60):
            try:
                api(BASE, "/api/health", timeout=5)
                up = True
                break
            except Exception:
                time.sleep(0.5)
        if not up:
            print("FATAL: engine did not start")
            sys.exit(1)
        ver = api(BASE, "/api/health").get("version", "?")
        check(f"engine up (version {ver}) — the two hands ship in the build", ver == "1.46.0",
              f"unexpected version {ver} (the ship commit bumps it)")

        api(BASE, "/api/keys", "POST", {"provider": "openrouter", "key": OPENROUTER_KEY})

        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page()
        page.goto(BASE + "/")

        # ════════════════════════════════════════════════════════════════
        print("RA — THE JOURNAL HAND, live through the engine's own WS protocol")
        jid = api(
            BASE, "/api/sessions", "POST",
            {"provider": "openrouter", "model": RIG_MODEL, "title": "v1470 journal rig"},
        )["ID"]

        # RA1: a real model turn calls djournal write
        evs = ws_turn(
            page, BASE, jid,
            'Use the djournal tool with action "write", text "the two-hands rig passed its live test", '
            'mood "good", tags "rig, test". Then reply with one short sentence.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "djournal")[-1:]
        check("RA1: the model called djournal (tool_use on the wire)", any_tool_use(evs, "djournal"),
              str([e.get("summary") for e in evs if e.get("type") == "tool_use"]))
        check("RA2: the write receipt says Saved + the mood glyph + the streak",
              bool(tr) and "Saved journal entry" in tr[0] and "🙂" in tr[0] and "streak:" in tr[0], tr[0][:160] if tr else "no tool_result")
        diary_path = os.path.join(data_dir, "journal", "entries.jsonl")
        diary_ok = os.path.exists(diary_path)
        entry_line = ""
        if diary_ok:
            with open(diary_path, encoding="utf-8") as f:
                entry_line = f.read().strip().splitlines()[-1] if f else ""
        check("RA3: the diary file landed under <DataDir>/journal/entries.jsonl", diary_ok, diary_path)
        check("RA4: the JSONL entry carries the text + word_count + the canonical shape",
              '"the two-hands rig passed its live test"' in entry_line and '"word_count"' in entry_line and '"mood":4' in entry_line,
              entry_line[:200])

        # RA5: read today — a FRESH session (no history: the model must
        # actually call the tool, not answer from the write receipt)
        j2 = fresh_session("v1470 read")
        evs = ws_turn(
            page, BASE, j2,
            'You have a djournal tool. Call it now with action "read" and target "today", then tell me what today\'s entry says.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "djournal")[-1:]
        check("RA5: read today returns the entry text",
              bool(tr) and "the two-hands rig passed its live test" in tr[0], tr[0][:160] if tr else "no tool_result")

        # RA6: review week — fresh session again
        j3 = fresh_session("v1470 review")
        evs = ws_turn(
            page, BASE, j3,
            'You have a djournal tool. Call it now with action "review" and period "week", then summarize the average mood and the streak in one sentence.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "djournal")[-1:]
        check("RA6: the review carries the stats",
              bool(tr) and "Journal review — week" in tr[0] and "avg mood: 4.0/5" in tr[0], tr[0][:200] if tr else "no tool_result")

        # RA7: export md — fresh session; the artifact lands in J4's drawer
        j4 = fresh_session("v1470 export")
        evs = ws_turn(
            page, BASE, j4,
            'You have a djournal tool. Call it now with action "export" and format "md", then confirm where the file was saved.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "djournal")[-1:]
        check("RA7a: the export answers with the state-dir save note",
              bool(tr) and "(export saved to" in tr[0] and "# doomalay journal export" in tr[0], tr[0][:160] if tr else "no tool_result")
        check("RA7b: the export ALSO sank the artifact card",
              bool(tr) and 'Saved as artifact "export.md"' in tr[0], tr[0][-200:] if tr else "no tool_result")
        arts = api(BASE, f"/api/sessions/{j4}/artifacts")
        arts_blob = json.dumps(arts)
        check("RA7c: the artifact drawer lists export.md", "export.md" in arts_blob, arts_blob[:200])
        check("RA7d: the state-dir export.md exists",
              os.path.exists(os.path.join(data_dir, "journal", "export.md")))

        # ════════════════════════════════════════════════════════════════
        print("RB — THE FLEET HAND, live (roster + filter + detail + the RUNNING truth)")
        alpha = api(BASE, "/api/sessions", "POST",
                    {"provider": "openrouter", "model": RIG_MODEL, "title": "Rig Alpha"})["ID"]
        beta = api(BASE, "/api/sessions", "POST",
                   {"provider": "mistral", "model": "mistral-small-latest", "title": "Rig Beta"})["ID"]
        state = {
            "icons": [
                {"id": "ic-a", "sessionId": alpha},
                {"id": "ic-b", "sessionId": beta},
                {"id": "ic-j", "sessionId": jid},
            ],
            "savedAt": "2026-10-21",
        }
        api(BASE, "/api/canvases", "POST",
            {"id": "rig-canvas", "name": "Rig Canvas", "state": state})

        # seed one event on alpha so the turns count is real
        fid = api(BASE, "/api/sessions", "POST",
                  {"provider": "openrouter", "model": RIG_MODEL, "title": "fleet seeder"})["ID"]

        # RB1: the roster lists the chats with the canvas
        evs = ws_turn(
            page, BASE, fid,
            'Use the fleet tool with action "roster" and no filter. Paste the roster lines that mention Rig.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "fleet")[-1:]
        check("RB1: the model called fleet roster", any_tool_use(evs, "fleet"))
        check("RB2: the roster lists Rig Alpha + Rig Beta with the canvas",
              bool(tr) and "Rig Alpha" in tr[0] and "Rig Beta" in tr[0] and '"Rig Canvas"' in tr[0], tr[0][:400] if tr else "no tool_result")
        check("RB3: the roster rows carry model + state + turns",
              bool(tr) and "minimax" in tr[0] and "idle" in tr[0] and "turn" in tr[0], tr[0][:400] if tr else "no tool_result")

        # RB4: the filter narrows — fresh session (no history to imitate)
        f2 = fresh_session("v1470 filter")
        evs = ws_turn(
            page, BASE, f2,
            'You have a fleet tool. Call it now with action "roster" and q "alpha", then tell me how many chats matched.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "fleet")[-1:]
        check("RB4: q=alpha narrows to Rig Alpha only",
              bool(tr) and "Rig Alpha" in tr[0] and "Rig Beta" not in tr[0], tr[0][:300] if tr else "no tool_result")

        # RB5: the detail card — fresh session
        f3 = fresh_session("v1470 detail")
        evs = ws_turn(
            page, BASE, f3,
            'You have a fleet tool. Call it now with action "detail" and target "Rig Alpha", then tell me its model.',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "fleet")[-1:]
        check("RB5: the detail card expands (identity + home + capabilities + current action)",
              bool(tr) and "fleet — detail: Rig Alpha" in tr[0] and "identity:" in tr[0]
              and 'canvas: "Rig Canvas"' in tr[0] and "capabilities:" in tr[0] and "current action:" in tr[0],
              tr[0][:400] if tr else "no tool_result")
        check("RB6: the snapshot honesty note rides the card",
              bool(tr) and "snapshot" in tr[0], "")

        # RB7: THE RUNNING TRUTH — a long generation in alpha driven over
        # plain WS (a background thread — sync-playwright can't cross
        # threads), probed mid-turn by the fleet roster in the main thread.
        results = {}

        def slow_alpha():
            results["alpha"] = ws_turn_raw(
                PORT, alpha,
                "Write a 400-word story about a lighthouse keeper. Take your time and be thorough.",
                timeout_s=240,
            )

        f4 = fresh_session("v1470 probe1")
        f5 = fresh_session("v1470 probe2")
        t = threading.Thread(target=slow_alpha)
        t.start()
        time.sleep(6)  # let alpha's turn arm
        evs = ws_turn(
            page, BASE, f4,
            'You have a fleet tool. Call it now with action "roster" and tell me: is Rig Alpha running right now?',
            timeout_ms=120000,
        )
        tr = tool_results(evs, "fleet")[-1:]
        running_seen = bool(tr) and "RUNNING" in tr[0]
        if not running_seen and tr:
            # the roster may have fired before alpha's turn armed; ONE retry
            time.sleep(4)
            evs = ws_turn(page, BASE, f5,
                          'You have a fleet tool. Call it now with action "roster" and tell me: is Rig Alpha RUNNING?',
                          timeout_ms=120000)
            tr = tool_results(evs, "fleet")[-1:]
            running_seen = bool(tr) and "RUNNING" in tr[0]
        check("RB7: a LIVE turn shows RUNNING in the roster (the turn gauge)",
              running_seen, tr[0][:300] if tr else "no tool_result")
        t.join(timeout=240000)
        alpha_evs = results.get("alpha", [])
        alpha_done = any(e.get("state") == "idle" for e in alpha_evs if e.get("type") == "status")
        check("RB8: alpha's long turn completed (the probe never broke it)", alpha_done)

        # ════════════════════════════════════════════════════════════════
        print("RC — THE BRIDGE PURGE, live (the dead routes 404; the live surfaces stay)")
        for route in ["/api/tools/local", "/api/tools/skills", "/api/tools/hublib",
                      "/api/tools/websearch", "/api/tools/webfetch"]:
            code = http_code(BASE, route + "?x=1")
            check(f"RC: {route} answers 404 (the old PM bridge contract is gone)", code == 404, f"got {code}")
        code = http_code(BASE, "/api/health")
        check("RC: /api/health still answers 200", code == 200, f"got {code}")
        # the brain's PM bridge still lives: a POST with a bogus key gets
        # the honest api-key-fallback=never 401 (never 404)
        code = http_code(BASE, "/api/pm/local/v1/chat/completions", method="POST",
                         body={"model": "glm-5.3", "messages": []})
        check("RC: the brain's PM bridge still lives (honest 401, never 404)",
              code in (401, 503), f"got {code}")

        # ════════════════════════════════════════════════════════════════
        print("RD — THE SOURCE PINS")
        def read(p):
            with open(os.path.join(ROOT, p), encoding="utf-8") as f:
                return f.read()

        defgo = read("engine/internal/mcpbus/def.go")
        turngo = read("engine/internal/mcpbus/turn.go")
        handlersgo = read("engine/internal/mcpbus/handlers.go")
        llmchat = read("engine/internal/llm/chat.go")
        mcpbridge = read("engine/internal/llm/mcpbridge.go")
        serverchat = read("engine/internal/server/chat.go")
        djournaltool = read("engine/internal/server/djournaltool.go")
        fleettool = read("engine/internal/server/fleettool.go")
        djournalgo = read("engine/internal/djournal/djournal.go")
        parity = read("engine/internal/djournal/djournal_parity_test.go")
        mcpbus_test = read("engine/internal/mcpbus/mcpbus_test.go")
        servergo = read("engine/internal/server/server.go")

        check("RD1: both Defs registered (31-tool census comment)",
              '{Name: "djournal"' in defgo and '{Name: "fleet"' in defgo and "31 tools" in defgo)
        check("RD2: both Turn closures + both summary rows",
              "Djournal func" in turngo and "Fleet func" in turngo and 'case "djournal":' in turngo and 'case "fleet":' in turngo)
        check("RD3: both handler cases",
              'case d.Name == "djournal":' in handlersgo and 'case d.Name == "fleet":' in handlersgo)
        check("RD4: both ChatRequest fields + both direct-dispatch cases",
              "DjournalToolFn" in llmchat and "FleetToolFn" in llmchat and 'action == "djournal"' in llmchat and 'action == "fleet"' in llmchat)
        check("RD5: both wired through mcpTurnFor",
              "req.DjournalToolFn" in mcpbridge and "req.FleetToolFn" in mcpbridge)
        check("RD6: both wired in the server ChatRequest literal",
              "DjournalToolFn:" in serverchat and "FleetToolFn:" in serverchat)
        check("RD7: the journal state path + the bare-string tolerance",
              '"journal", djournal.StateFile' in djournaltool and '"action": "write", "text": trimmed' in djournaltool)
        check("RD8: the fleet reads the turn gauge + the canvas digest",
              "turnGaugeSessions" in fleettool and "ListCanvasDigest" in fleettool and "CountUserTurnsPerSession" in fleettool)
        check("RD9: pyRound is the banker's law (the Python parity)",
              "half to even" in djournalgo and "func pyRound" in djournalgo)
        check("RD10: the gold parity cross-check runs the Python spec itself",
              "dt_journal.py" in parity and "PARITY DIVERGENCE" in parity)
        check("RD11: the census pins say 31", "want 31 tools" in mcpbus_test and "22 always-on" in mcpbus_test)
        check("RD12: ZERO /api/tools route registrations remain",
              'HandleFunc("GET /api/tools' not in servergo)
        check("RD13: the informative pill rows (the v1.40.2 law)",
              'case "djournal":' in turngo and 'case "fleet":' in turngo)
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
    print(f"v1470 two-hands rig: {PASS}/{PASS + FAIL} — {verdict}")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
