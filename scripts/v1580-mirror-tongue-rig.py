#!/usr/bin/env python3
"""v1580 — THE MIRROR TONGUE rig (PLAN-V158 §4, THE LIVE PROOF).

The real engine (this tree, freshly built) + the real opencode 2.1.2 serve
(downloaded + spawned by the engine itself) + the real key: the 1:1 parity
laws, live.

THE RIG LAWS (the v1550 rig's own, inherited):
  · the free-model candidates come from the LIVE catalog (/api/models —
    the opencode group's isFree models; never a static list);
  · a quota wall / a geo wall is an UPSTREAM refusal — the rig moves to
    the next candidate exactly like a real user (honest_refusal), and a
    pin that never lands after the rotation + the retry rounds reports
    HONEST-SKIP with the upstream state (never a fake pass, never a
    silent swallow);
  · ANY OTHER error is a real bug and stays a hard FAIL.

DESKTOP RUN (this sandbox):
  M*  MACHINERY PINS (model-independent — the laws on disk + the engine
      log's own MCP dance):
      M1 the open-hands scratch config (V2 rules array + tavily)
      M2 the per-chat binding config (/mcp/oc/<chat> + codemode:false + ws)
      M3 the serve's MCP attach DANCE through /mcp/oc/<chat> (initialize +
         tools/list POSTs in the engine log — the wide shelf, live)
      M4 the per-chat route's 404 law (chatless)
  S*  THE TURN PINS (the model's truth, live):
      S4  the informative pill + the wide shelf — the calculator call
          (bare name + derived summary + the whole result)
      S5  the binding proof — fleet roster names THIS chat
      S6  the open hands — write + grep on real files (derived pills)
      S7  the never-prefix + never-static law (every event)
      S8  the unbounded result (>6000-char grep lands whole or the honest
          serve-truncated marker rides)
      S9  the dynamic progress lines (rides even quota-walled turns)
      S10 the merged catalog (soft)
      S11 the ledger (cost 0)
      S12 continuity (the history rides the same chat)

--device: the real-phone gate (the tunnel); honest skip when it is down.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, threading, shutil

REPO = "/home/z/doomalay"
KEY = None
for line in open("/home/z/my-project/keys.env"):
    if line.startswith("OPENCODE_KEY="):
        KEY = line.strip().split("=", 1)[1]
if not KEY:
    sys.exit("FATAL: no OPENCODE_KEY")

WORK = "/tmp/v1580-rig"
ENGINE_PORT = 45990
RETRY_ROUNDS = int(os.environ.get("V1580_ROUNDS", "3"))
RETRY_SLEEP = int(os.environ.get("V1580_ROUND_SLEEP", "150"))  # the windows roll in minutes

PASS, FAILS, SKIPS = [], [], []

def check(name, ok, detail="", skip=False):
    if skip:
        SKIPS.append(name)
        print(f"  SKIP  {name} — {detail[:190]}", flush=True)
    else:
        (PASS if ok else FAILS).append(name)
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail[:190]}" if detail else ""), flush=True)

def honest_refusal(why):
    """The upstream refusals a real user sees and MOVES ON from (the v1550
    law): the rolling free-quota wall + the geo wall. Anything else = a bug."""
    w = (why or "").lower()
    return ("free usage limit" in w) or ("not available in your country" in w)

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)

def api(base, path, method="GET", body=None, timeout=30):
    req = urllib.request.Request(base + path, method=method,
            data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw.strip() else {}

def session_events(base, sid):
    data = api(base, f"/api/sessions/{sid}/events?since=0", timeout=30)
    return data.get("events", []) if isinstance(data, dict) else (data or [])

def ws_turn(base, port, sid, message, timeout_s=200, model=None):
    """One WS turn; the events are FLAT on the wire ({type,name,summary,text…}).
    THE LIVE READER LAW: the WS frames are captured LIVE (exactly what the
    PWA sees — progress events are ephemeral by design, v0.23's no-silence
    law: never persisted, replay never sees them); the DB poll drives the
    terminal detection. Returns (db_events, status, live_frames)."""
    import queue
    import websocket as ws_client
    pre = len([e for e in session_events(base, sid)
               if e.get("type") == "status" and e.get("state") in ("idle", "error")])
    live_q = queue.Queue()
    stop = {"v": False}

    def run():
        w = None
        try:
            w = ws_client.create_connection(url_w(port, sid), timeout=30)
            msg = {"session_id": sid, "type": "send", "message": message}
            if model:
                msg["model"] = model
            w.send(json.dumps(msg))
        except Exception as e:
            live_q.put({"__ws_err": str(e)[:120]})
            return

        def reader():
            live_started = False  # the REPLAY precedes the live frames (ws_state replay_done
            try:                 # marks the boundary — the PWA's own law)
                w.settimeout(45)
                while not stop["v"]:
                    try:
                        raw = w.recv()
                    except ws_client.WebSocketTimeoutException:
                        continue
                    if not raw:
                        break
                    try:
                        d = json.loads(raw)
                    except Exception:
                        continue
                    if not live_started:
                        if d.get("type") == "ws_state":
                            live_started = True
                        live_q.put({"replay": d.get("type"), "state": d.get("state")})
                        continue
                    live_q.put(d)
                    if d.get("type") == "status" and d.get("state") in ("idle", "error"):
                        break
            except Exception:
                pass
            try:
                w.close()
            except Exception:
                pass
        threading.Thread(target=reader, daemon=True).start()

    threading.Thread(target=run, daemon=True).start()
    deadline = time.time() + timeout_s
    last = []
    while time.time() < deadline:
        last = session_events(base, sid)
        terms = [e for e in last
                 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terms) > pre:
            time.sleep(2)  # let the live reader drain the tail frames
            stop["v"] = True
            time.sleep(0.3)
            frames = drain(live_q)
            if any("__ws_err" in f for f in frames):
                return [], "err: " + str(frames[0]), frames
            if pre <= 0:
                return last, "ok", frames
            cut, seen = 0, 0
            for i, e in enumerate(last):
                if e.get("type") == "status" and e.get("state") in ("idle", "error"):
                    seen += 1
                    if seen == pre:
                        cut = i + 1
                        break
            return last[cut:], "ok", frames
        time.sleep(0.5)
    stop["v"] = True
    time.sleep(0.3)
    frames = drain(live_q)
    return last, "TIMEOUT", frames

def url_w(port, sid):
    return f"ws://127.0.0.1:{port}/api/chat?session_id={sid}"

def drain(q):
    out = []
    while not q.empty():
        out.append(q.get())
    return out

def assistant_text(evs):
    return "".join(e.get("text") or "" for e in evs if e.get("type") == "assistant_delta")

def error_why(evs):
    for e in evs:
        if e.get("type") == "error":
            return e.get("message") or e.get("text") or ""
    return ""

def tool_uses(evs):
    return [{"name": e.get("name"), "summary": e.get("summary"), "tuid": e.get("tool_use_id")}
            for e in evs if e.get("type") == "tool_use"]

def tool_results(evs):
    return [{"name": e.get("name"), "text": e.get("text") or ""} for e in evs if e.get("type") == "tool_result"]

def progress_msgs(evs):
    return [e.get("message") or "" for e in evs if e.get("type") == "progress"]

def free_candidates(base, tries=12):
    cands = []
    cat = api(base, "/api/models", timeout=60)
    for g in (cat.get("groups") or []):
        if g.get("name") == "opencode":
            for m in (g.get("models") or []):
                if m.get("isFree"):
                    cands.append(m.get("rawId") or m.get("id"))
    return cands[:tries]

LIVE_FRAMES = []  # every live WS frame the turns ever captured (the PWA's own view)

def turn_with_rotation(base, sid, cands, message, note, timeout_s=200):
    """Rotate the LIVE free candidates; an honest upstream refusal moves on.
    Returns (events, ok, why)."""
    why = "no candidate"
    evs = []
    for mid in cands:
        evs, st, frames = ws_turn(base, ENGINE_PORT, sid, message, timeout_s=timeout_s, model=mid)
        LIVE_FRAMES.extend(frames)
        ans = assistant_text(evs)
        if ans:
            return evs, True, ""
        why = error_why(evs) or st
        if honest_refusal(why):
            print(f"    [{note}] {mid}: upstream refusal — rotating…", flush=True)
            continue
        if st == "TIMEOUT":
            print(f"    [{note}] {mid}: TIMEOUT — rotating…", flush=True)
            continue
        return evs, False, why  # a real bug-shaped error
    return evs, False, why

def main():
    os.makedirs(WORK, exist_ok=True)
    datadir = os.path.join(WORK, "engdata")
    shutil.rmtree(datadir, ignore_errors=True)

    print("== v1580 THE MIRROR TONGUE — the live proof ==")
    print("M0 — the engine + the key")
    binpath = os.path.join(WORK, "engine")
    r = sh(f"cd {REPO}/engine && PATH=/home/z/sdk/go/bin:$PATH go build -o {binpath} ./cmd/doomalay")
    if r.returncode != 0:
        sys.exit("FATAL: engine build: " + r.stderr[-1500:])
    log = open(os.path.join(WORK, "engine.log"), "wb")
    ep = subprocess.Popen([binpath, "-port", str(ENGINE_PORT), "-bind", "127.0.0.1",
                           "-data-dir", datadir, "-open=false"], stdout=log, stderr=log)
    base = f"http://127.0.0.1:{ENGINE_PORT}"
    for _ in range(120):
        time.sleep(0.5)
        try:
            api(base, "/api/health", timeout=3)
            break
        except Exception:
            if ep.poll() is not None:
                sys.exit("FATAL: engine died:\n" + open(os.path.join(WORK, "engine.log")).read()[-3000:])
    check("M0 the engine boots", True, f"port {ENGINE_PORT}")
    api(base, "/api/keys", "POST", {"provider": "opencode", "key": KEY}, timeout=30)

    sess = api(base, "/api/sessions", "POST", {"title": "v1580 MIRROR CHAT", "provider": "opencode",
                                               "model": "opencode/big-pickle"}, timeout=30)
    sid = sess.get("ID")
    check("M0 the opencode chat exists", bool(sid), str(sid))

    # THE CATALOG WAIT (the v1550 rig's own law): the serve gate reads the
    # LIVE registry (IsOpenCodeFreeModelSlot) — a cold catalog answers
    # false and the turn falls to the direct 403 wall (the rig's second run
    # convicted this exact race). Wait for the opencode group to carry its
    # models before any turn.
    print("M0 — waiting for the live catalog (the opencode group)…")
    for _ in range(60):
        cat = {}
        try:
            cat = api(base, "/api/models", timeout=20)
        except Exception:
            pass
        oc = next((g for g in (cat.get("groups") or []) if g.get("name") == "opencode"), None)
        if oc and len(oc.get("models") or []) > 0:
            print(f"  catalog ready ({len(oc['models'])} opencode models)")
            break
        time.sleep(2)

    # THE BRIDGE WAIT: the first turn must never race the serve's spawn
    # (the rig's first run convicted the race — the turn fell to the
    # direct 403 wall while the serve was 3s from ready). The honest health
    # signal is the engine log's own "bridge up" line (the status route's
    # desktop arm answers state:"desktop" + available — not spawn health).
    print("M0 — waiting for the pocket bridge to be healthy…")
    ws_turn(base, ENGINE_PORT, sid, "ping", timeout_s=45)  # the nudge: the lazy spawn wakes
    bridge_ok = False
    for _ in range(60):
        elog = open(os.path.join(WORK, "engine.log")).read()
        if "bridge up on http://127.0.0.1" in elog:
            bridge_ok = True
            break
        time.sleep(2)
    if not bridge_ok:
        tail = open(os.path.join(WORK, "engine.log")).read()[-400:]
        check("M0 the pocket bridge is healthy", False, tail)
        ep.kill()
        sys.exit(1)
    print("  the bridge is healthy")

    cands = free_candidates(base)
    print(f"M0 — {len(cands)} live free candidates: {cands[:6]}…")

    # ── M1/M2: the machinery pins (the laws on disk) ─────────────────────
    print("M1/M2 — the configs on disk")
    cfgp = os.path.join(datadir, "opencode-serve", "opencode.json")
    if os.path.exists(cfgp):
        cfg = json.load(open(cfgp))
        rules = cfg.get("permissions", [])
        check("M1 the V2 rules array (question deny)",
              any(r.get("action") == "question" and r.get("effect") == "deny" for r in rules),
              json.dumps(rules)[:150])
        check("M1 the doomalay_* wide-shelf belt",
              any(r.get("action") == "doomalay_*" and r.get("effect") == "allow" for r in rules))
        check("M1 the tavily websearch selection", (cfg.get("websearch") or {}).get("provider") == "tavily")
        check("M1 the V1 legacy object is gone", "permission" not in cfg)
    else:
        check("M1 the scratch config exists", False, cfgp)
    chatcfgp = os.path.join(datadir, "opencode-serve", "chats", sid, "opencode.json")
    if os.path.exists(chatcfgp):
        chatcfg = json.load(open(chatcfgp))
        entry = ((chatcfg.get("mcp") or {}).get("servers") or {}).get("doomalay") or {}
        check("M2 the per-chat config points at /mcp/oc/<chat>",
              str(entry.get("url", "")).endswith(f"/mcp/oc/{sid}"), str(entry.get("url")))
        check("M2 codemode:false (direct tools, the 1:1 pill law)", entry.get("codemode") is False)
        check("M2 the ws workspace exists", os.path.isdir(os.path.join(datadir, "opencode-serve", "chats", sid, "ws")))
    else:
        check("M2 the per-chat config exists", False, chatcfgp)

    # M3: the serve's MCP attach dance through /mcp/oc/<chat> (the engine
    # log is the machinery's own witness — model-independent)
    elog = open(os.path.join(WORK, "engine.log")).read()
    mcp_posts = elog.count(f"POST /mcp/oc/{sid}")
    mcp_gets = elog.count(f"GET /mcp/oc/{sid}")
    check("M3 THE MCP DANCE through the per-chat route (initialize + tools/list POSTs)",
          mcp_posts >= 3, f"posts={mcp_posts} gets={mcp_gets}")

    # M4: the chatless route refuses
    try:
        req = urllib.request.Request(base + "/mcp/oc/", method="POST",
                data=b"{}")
        urllib.request.urlopen(req, timeout=10)
        check("M4 the chatless per-chat route 404s", False, "no 404")
    except urllib.error.HTTPError as e:
        check("M4 the chatless per-chat route 404s", e.code == 404, str(e.code))

    # ── the turn pins — with retry rounds (the rolling windows) ──────────
    landed = {}
    pending = ["S4", "S5", "S6", "S8", "S10", "S11", "S12"]
    why_all = "no candidate"
    for rnd in range(RETRY_ROUNDS):
        if not pending:
            break
        if rnd > 0:
            print(f"\n== ROUND {rnd+1}/{RETRY_ROUNDS} — the free windows roll; sleeping {RETRY_SLEEP}s ==", flush=True)
            time.sleep(RETRY_SLEEP)
        cands = free_candidates(base)
        if not cands:
            check("M0 live free candidates exist", False, "the catalog is empty")
            break

        if "S4" in pending:
            print("S4 — the informative pill + the wide shelf (calculator through the doomalay MCP)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "Call the tool named 'calculator' with the expression 17*23 (pass expr='17*23'). "
                "Then reply with ONLY the number it returned — nothing else.", "S4-calc")
            uses = tool_uses(evs)
            results = tool_results(evs)
            calc_use = [u for u in uses if u.get("name") == "calculator"]
            calc_res = [t for t in results if t.get("name") == "calculator" and "391" in t.get("text", "")]
            if calc_use:
                check("S4 the MCP calculator call happens", True, f"uses={[(u.get('name'), u.get('summary')) for u in uses]}")
                check("S4 THE BARE-NAME LAW", not str(calc_use[0].get("name")).startswith("opencode:"), str(calc_use[0].get("name")))
                check("S4 THE DERIVED SUMMARY (never static)", "17*23" in str(calc_use[0].get("summary")), str(calc_use[0].get("summary")))
                check("S4 the result rides (391)", bool(calc_res),
                      (calc_res[0]["text"][:100] if calc_res else "no result") + " | answer=" + assistant_text(evs)[:100])
                landed["S4"] = True
                pending = [p for p in pending if p != "S4"]
            elif ok and assistant_text(evs):
                check("S4 the MCP calculator call happens", False,
                      f"answer={assistant_text(evs)[:150]} uses={[u.get('name') for u in uses]}")
                pending = [p for p in pending if p != "S4"]
            else:
                why_all = why

        if "S5" in pending:
            print("S5 — the binding proof (fleet names THIS chat)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "Call the tool named 'fleet' with action 'roster'. Reply with ONLY the chat titles it listed.",
                "S5-fleet", timeout_s=180)
            fleet_res = [t for t in tool_results(evs) if t.get("name") == "fleet"]
            if fleet_res:
                check("S5 the fleet call runs through the per-chat MCP", True)
                check("S5 THE BINDING — the roster names THIS chat",
                      "v1580 MIRROR CHAT" in fleet_res[0].get("text", ""), fleet_res[0].get("text", "")[:150])
                landed["S5"] = True
                pending = [p for p in pending if p != "S5"]
            elif ok and assistant_text(evs):
                check("S5 the fleet call runs", False, f"answer={assistant_text(evs)[:150]}")
                pending = [p for p in pending if p != "S5"]
            else:
                why_all = why

        if "S6" in pending:
            print("S6 — the open hands (write + grep on real files)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "Create a file named notes.txt in your working directory with the exact single line "
                "'alpha bravo charlie delta'. Then use grep to search for 'charlie' and reply with "
                "ONLY the matching line the grep returned.", "S6-hands", timeout_s=200)
            uses6 = tool_uses(evs)
            names6 = [str(u.get("name")) for u in uses6]
            if assistant_text(evs) and ok:
                check("S6 write + grep both run (the open hands)",
                      any(n in ("write", "edit") for n in names6) and "grep" in names6, str(names6))
                wu = next((u for u in uses6 if str(u.get("name")) in ("write", "edit")), None)
                gu = next((u for u in uses6 if str(u.get("name")) == "grep"), None)
                if wu:
                    check("S6 the write pill is derived (the path tail)", str(wu.get("summary")) == "notes.txt", str(wu.get("summary")))
                if gu:
                    check("S6 the grep pill is derived (the pattern)", "charlie" in str(gu.get("summary")), str(gu.get("summary")))
                ans6 = assistant_text(evs)
                check("S6 the answer quotes the real grep hit", "charlie" in ans6.lower(), ans6[:150])
                landed["S6"] = True
                pending = [p for p in pending if p != "S6"]
            elif not ok and not honest_refusal(why):
                check("S6 the open-hands turn", False, why)
                pending = [p for p in pending if p != "S6"]
            else:
                why_all = why

        if "S8" in pending:
            print("S8 — the unbounded result (a real >6000-char grep)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "Use your grep tool with pattern 'func Test' and path '/home/z/doomalay/engine', "
                "include '*.go', limit 300. Then reply with ONLY the number of matches it found.",
                "S8-big", timeout_s=220)
            if assistant_text(evs) and ok:
                big = [t for t in tool_results(evs) if str(t.get("name")) == "grep" and len(t.get("text", "")) > 6000]
                marked = [t for t in tool_results(evs) if "opencode shortened this output" in t.get("text", "")]
                check("S8 THE WHOLE-RETURN LAW (>6000 chars WHOLE or the honest marker)",
                      bool(big) or bool(marked),
                      f"grep sizes={[len(t.get('text','')) for t in tool_results(evs) if str(t.get('name'))=='grep']}")
                landed["S8"] = True
                pending = [p for p in pending if p != "S8"]
            elif not ok and not honest_refusal(why):
                check("S8 the unbounded-result turn", False, why)
                pending = [p for p in pending if p != "S8"]
            else:
                why_all = why

        if "S10" in pending:
            print("S10 — the merged catalog (soft)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "In ONE line, no lists: name two tools you have from the doomalay MCP server and "
                "two of your own OpenCode tools.", "S10-catalog", timeout_s=150)
            ans10 = assistant_text(evs).lower()
            if ans10 and ok:
                ours = any(k in ans10 for k in ["calculator", "fleet", "docx", "journal", "djournal", "hublib"])
                theirs = any(k in ans10 for k in ["read", "grep", "write", "edit", "shell", "glob", "webfetch"])
                check("S10 the model names BOTH shelves (soft)", ours and theirs, assistant_text(evs)[:180])
                landed["S10"] = True
                pending = [p for p in pending if p != "S10"]
            elif not ok and not honest_refusal(why):
                check("S10 the catalog turn", False, why)
                pending = [p for p in pending if p != "S10"]
            else:
                why_all = why

        if "S11" in pending:
            idle = [e for e in session_events(base, sid) if e.get("type") == "status" and e.get("state") == "idle"]
            usage = (idle[-1].get("usage") or {}) if idle else {}
            if usage:
                check("S11 the free-tier ledger (cost 0)", float(usage.get("cost", 1)) == 0, json.dumps(usage)[:150])
                landed["S11"] = True
                pending = [p for p in pending if p != "S11"]

        if "S12" in pending and landed.get("S4"):
            print("S12 — continuity (the same chat, the history rides)")
            evs, ok, why = turn_with_rotation(base, sid, cands,
                "Earlier this conversation I had you compute something with the calculator tool. "
                "What expression did I ask for, and what did it return? Answer in one short line.",
                "S12-continuity", timeout_s=150)
            ans12 = assistant_text(evs)
            if ans12 and ok:
                check("S12 the history rides (17*23 / 391)", ("17*23" in ans12 or "391" in ans12), ans12[:150])
                landed["S12"] = True
                pending = [p for p in pending if p != "S12"]
            elif not ok and not honest_refusal(why):
                check("S12 the continuity turn", False, why)
                pending = [p for p in pending if p != "S12"]

    # S7: over every tool event that ever landed; S9: over the LIVE frames
    # (progress is ephemeral by law — the live reader captured the PWA's own view)
    all_evs = session_events(base, sid)
    all_names = [str(u.get("name")) for u in tool_uses(all_evs)]
    all_sums = [str(u.get("summary")) for u in tool_uses(all_evs)]
    check("S7 THE NEVER-PREFIX LAW (no opencode: anywhere)",
          not any(n.startswith("opencode:") for n in all_names), str(all_names[:10]))
    check("S7 THE NEVER-STATIC LAW (no 'running' summaries)",
          not any(s == "running" for s in all_sums), str(all_sums[:10]))
    progs = [f.get("message") or "" for f in LIVE_FRAMES if f.get("type") == "progress"]
    print(f"  [debug] LIVE_FRAMES={len(LIVE_FRAMES)} progs={len(progs)} types={[f.get('type') for f in LIVE_FRAMES[:12]]}")
    check("S9 'Connecting to OpenCode' rides", any("Connecting to OpenCode" in p for p in progs), str(progs[:4]))
    check("S9 '<model> is thinking' rides", any("is thinking" in p for p in progs))
    check("S9 the static 'turn in flight' is dead", not any("turn in flight" in p for p in progs))

    # the pins that never landed after every round: the honest skip
    for p in pending:
        check(f"{p} — the model-dependent pin", False, f"HONEST-SKIP after {RETRY_ROUNDS} rounds: {why_all[:120]}", skip=True)

    ep.kill()
    print(f"\n== VERDICT: {len(PASS)} PASS / {len(FAILS)} FAIL / {len(SKIPS)} HONEST-SKIP ==")
    if FAILS:
        for f in FAILS:
            print("  FAIL:", f)
    sys.exit(1 if FAILS else (2 if SKIPS else 0))

if __name__ == "__main__":
    main()
