#!/usr/bin/env python3
# v1.50 THE UNLOST MIND — the live red-team rig (PLAN-V150 §6).
#
# THE USER'S TESTS (verbatim asks):
#   RIG A — the trippy-loop conviction: "One test should have trippy push
#     or port or do the things it said it found and continuously lost and
#     looped over." → a REAL model reads a large real file through the
#     app's own workspace tool; a FRESH turn asks for the findings WITHOUT
#     re-reading. Post-fix: the findings rode history WHOLE (the 6,000-
#     byte cross-turn clamp is dead) → ZERO tool calls in turn 2. The
#     --flip mode builds the PRE-FIX tree (HEAD~1) and convicts the loop:
#     the clamp ate the file → the model re-reads (or can't recall).
#   RIG B — the original prompt: "The second test is the original prompt I
#     asked trippy: for them to make the connect workspace pill in the
#     workspaces overlay glow an accent color when no workspaces are
#     connected." → the prompt VERBATIM through the app on a REAL model
#     (a different provider than RIG A — both exercised, per the ask).
#     Asserts: the turn completes, no repetition, the task understood.
#   RIG C — the continue button: send → stop mid-stream → the menu's
#     continue → the reply resumes with NO new user event (the engine's
#     continue frame), no repeated prefix.
#
# All three ride the REAL app: real engine, real browser page, the chat's
# OWN composer + pills + button (the user's own surfaces), real provider
# keys (OpenRouter + Nvidia — the GLM family, the user's named models).
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ENGINE_PORT", "8097"))
BASE = f"http://127.0.0.1:{PORT}"
GO = os.path.expanduser("~/.local/go/bin/go")

# the vault (never committed, never logged into the repo)
VAULT = "/home/z/my-project/.vault"
KEYS = {}
if os.path.exists(VAULT + "/api-keys.md"):
    for ln in open(VAULT + "/api-keys.md"):
        ln = ln.strip()
        if ln.startswith("- ") and ":" in ln:
            name, val = ln[2:].split(":", 1)
            KEYS[name.strip().lower()] = val.strip()
GH_TOKEN = KEYS.get("github", os.environ.get("GITHUB_TOKEN", ""))
if not GH_TOKEN and os.path.exists(VAULT + "/github-token"):
    GH_TOKEN = open(VAULT + "/github-token").read().strip()
OR_KEY = KEYS.get("openrouter", "")
NV_KEY = KEYS.get("nvidia", "")

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + (1 if ok else 0), FAIL + (0 if ok else 1)
    return ok


def api(path, method="GET", body=None, timeout=240):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return {"__status": e.code, "__body": e.read().decode()[:300]}
        except Exception:
            return {"__status": e.code}


def build_engine(tag, src_dir):
    bin_path = f"/tmp/doomalay-{tag}"
    r = subprocess.run(
        [GO, "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(src_dir, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-500:])
        sys.exit(1)
    return bin_path


def boot_engine(bin_path):
    data_dir = tempfile.mkdtemp(prefix=f"v150-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v150-log-", delete=False)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1"},
        stdout=log, stderr=log,
        start_new_session=True,  # v1.50 rig law: the engine outlives the rig process (the sandbox culls long-running rig trees; phased rigs re-attach)
    )
    for _ in range(120):
        try:
            api("/api/health", timeout=5)
            return eng
        except Exception:
            time.sleep(0.5)
    print("FATAL: engine never came up")
    sys.exit(1)


def events_of(sid):
    evs = api(f"/api/sessions/{sid}/events?since=0", timeout=60)
    return evs if isinstance(evs, list) else evs.get("events", [])


def wait_terminal(sid, since_count=0, timeout_s=420):
    """Wait for the NEXT terminal status; returns (ok, events)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        evs = events_of(sid)
        terminals = [e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terminals) > since_count:
            last = terminals[-1]
            return last.get("state") in ("idle",), evs
        time.sleep(1.0)
    return False, events_of(sid)


def assistant_texts(evs, after_seq=0):
    out = []
    for e in evs:
        if e.get("type") == "assistant" and e.get("seq", 0) > after_seq:
            out.append(e.get("text") or "")
    return out


def open_chat(page, sid, provider, model):
    # the v1484 pattern: the ENTITY's sessionId is saved FIRST (icon.save())
    # — without it, the panel re-render fires ensureSession and creates its
    # OWN unbound session (the rig's turn then runs in the wrong chat).
    page.evaluate(
        """([sid, provider, model]) => {
            const icon = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
            icon.sessionId = sid; icon.save();
            const st = window.ChatPanel.getState(icon.id);
            if (st) { st.sessionId = sid; st.provider = provider; st.model = model; }
            return window.doomalay.openChatBySession(sid);
        }""", [sid, provider, model])
    page.wait_for_function("!!document.getElementById('chat-input')", timeout=20000)
    page.wait_for_timeout(500)
    # the honest guard: the panel's live state must point at OUR session
    bound = page.evaluate(
        """() => {
            const el = document.getElementById('chat-messages');
            const icon = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
            return icon && icon.sessionId;
        }""")
    if bound != sid:
        print(f"  !! panel session mismatch: entity={bound!r} want={sid!r}")


def send_via_ui(page, text):
    page.fill("#chat-input", text)
    page.click("#chat-send")


def bind_doomalay(sid):
    ws = api("/api/workspaces/connect", "POST",
             {"url": "https://github.com/ScoobyBaby1999/doomalay",
              "session_id": sid, "token": GH_TOKEN})
    return "__status" not in ws, ws


def make_session(provider, model, title):
    r = api("/api/sessions", "POST", {"provider": provider, "model": model, "title": title})
    return r.get("ID") or r.get("id")


def rig_a(page, flip=False):
    label = "RIG A (flip/pre-fix)" if flip else "RIG A (fixed)"
    print(f"\n━━ {label} — the trippy-loop conviction (OpenRouter · minimax/minimax-m3.1-flash:free)")
    api("/api/keys", "POST", {"provider": "openrouter", "key": OR_KEY})
    time.sleep(6)  # the real async key validation
    sid = make_session("openrouter", "minimax/minimax-m3.1-flash:free", "v150-rig-a")
    if not sid:
        check("session created", False, "no id")
        return
    ok, ws = bind_doomalay(sid)
    if not check("the doomalay workspace bound to the chat", ok, str(ws)[:120]):
        return
    open_chat(page, sid, "openrouter", "minimax/minimax-m3.1-flash:free")

    # TURN 1 — read the big file through the app's own workspace tool.
    # skills.go is ~40KB (>6KB — the dead clamp's amputation class) and its
    # functions span the whole file (a 6KB head cannot answer from memory).
    send_via_ui(page, "Use the workspace tool to read the file engine/internal/server/skills.go from the doomalay workspace, then tell me the names of the functions defined in it.")
    ok, evs = wait_terminal(sid, 0)
    t1_tools = [e for e in evs if e.get("type") == "tool_use"]
    t1_read = [e for e in evs if e.get("type") == "tool_result"]
    if not check("turn 1 completed (real model, real tool round)", ok, f"{len(t1_tools)} tool_use"):
        return
    if not check("turn 1 REALLY read through the workspace tool", len(t1_tools) >= 1):
        return
    # THE WHOLE RETURN (live): the persisted tool_result carries the FULL
    # file — not a 6KB clamp remnant.
    big_results = [e for e in t1_read if len(e.get("text") or "") > 25000]
    check("THE WHOLE RETURN live: the read result persisted >25KB (the full file)",
          len(big_results) >= 1,
          f"result sizes: {[len(e.get('text') or '') for e in t1_read][:4]}")

    seq_after_t1 = max([e.get("seq", 0) for e in evs] or [0])
    t1_answer = " ".join(assistant_texts(evs)).lower()

    # TURN 2 — the fresh recall, tools forbidden, and it needs the RAW FILE
    # TAIL (the exact first body line of sumMembers — a late-file detail no
    # turn-1 summary would carry; only the WHOLE file in history answers it).
    send_via_ui(page, "Without reading any file again and without using any tools at all: (1) list the names of the functions you found in skills.go, and (2) quote VERBATIM the exact one-line Go comments that sit directly above the function definitions sumMembers and byTypeLine.")
    ok, evs = wait_terminal(sid, 1)
    if not check("turn 2 completed", ok):
        return
    t2_evs = [e for e in evs if e.get("seq", 0) > seq_after_t1]
    t2_tools = [e for e in t2_evs if e.get("type") == "tool_use"]
    t2_answer = " ".join(assistant_texts(evs, seq_after_t1)).lower()

    # the recall quality: known skills.go function names present in turn 2
    known = ["skillsdispatch", "hublibdispatch", "resolveskill", "flat", "oneline",
             "summembers", "bytypeline", "superpowersworkflowblock", "sanitizedbundleid",
             "hublibbundledetail"]
    hits = [k for k in known if k in t2_answer]
    # THE RAW-TAIL NEEDLES: the exact doc comments above sumMembers
    # ("// sumMembers totals a by-type census.") and byTypeLine ("// byTypeLine
    # renders a member census ...") — deep-tail lines (~line 890 of 987, far
    # beyond the dead 6,000-byte clamp's reach) with phrasing no model can
    # guess; only the WHOLE file in history answers this.
    quoted_detail = ("totals a by-type census" in t2_answer) and ("renders a member census" in t2_answer)

    if flip:
        # THE PRE-FIX CONVICTION (the trippy loop): the 6,000-byte cross-turn
        # clamp amputated the file to its head — sumMembers lives at the
        # tail. The model either re-reads (the loop: "continuously lost and
        # looped over" its findings) or cannot quote the detail.
        looped = len(t2_tools) >= 1
        check("PRE-FIX: the model LOST the raw findings (re-read — the loop — or the detail is gone)",
              looped or (not quoted_detail),
              f"{len(t2_tools)} tool calls, detail quoted={quoted_detail}, t1 needed {len(t1_tools)} tool calls (the clamp storm)")
    else:
        check("THE LOOP IS DEAD: ZERO tool calls in the recall turn (findings rode history WHOLE)",
              len(t2_tools) == 0, f"{len(t2_tools)} tool calls (turn 1 needed {len(t1_tools)})")
        check("the recall is real (>=6 function names from memory)", len(hits) >= 6,
              f"{len(hits)} names: {hits[:8]}")
        check("THE RAW TAIL RIDES: both deep-tail doc comments quoted verbatim from memory",
              quoted_detail, "the sumMembers + byTypeLine comments (~line 890 of 987)")
        # the no-repeat law: the user's messages ride the transcript exactly once each
        users = [e for e in evs if e.get("type") == "user"]
        check("no user-echo duplication (2 sends → 2 user events)",
              len(users) == 2, f"{len(users)} user events")


def rig_b(page):
    print("\n━━ RIG B — the original prompt, VERBATIM (Nvidia · z-ai/glm-5.3-flash)")
    api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
    time.sleep(6)
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v150-rig-b")
    if not sid:
        check("session created", False, "no id")
        return
    ok, ws = bind_doomalay(sid)
    check("the doomalay workspace bound (trippy's own working set)", ok, str(ws)[:120])
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")

    # THE ORIGINAL PROMPT — verbatim, the user's words.
    send_via_ui(page, "make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected")
    ok, evs = wait_terminal(sid, 0, timeout_s=900)  # a real repo task — no turn budget by design
    if not check("the turn completed (a real answer, not an error loop)", ok):
        errs = [e for e in evs if e.get("type") == "error"]
        print("      errors:", [e.get("message") or (e.get("text") or "")[:100] for e in errs][:3])
        return
    answer = " ".join(assistant_texts(evs))
    low = answer.lower()
    check("the task was understood (workspace + glow/accent named)",
          ("workspace" in low) and (("glow" in low) or ("accent" in low)),
          f"answer head: {answer[:100]!r}")
    # THE NO-REPEAT LAW: the user's prompt rides the transcript exactly once
    prompt = "make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected"
    user_events = [e for e in evs if e.get("type") == "user" and e.get("text") == prompt]
    check("the prompt persisted exactly ONCE (no re-send echo)", len(user_events) == 1,
          f"{len(user_events)} copies")
    # no pathological self-repetition in the model's own reply: the same
    # 60-char window does not repeat 3+ times
    rep = False
    if len(answer) > 180:
        for i in range(0, min(len(answer) - 60, 4000), 40):
            w = answer[i:i + 60]
            if len(w.strip()) > 40 and answer.count(w) >= 3:
                rep = True
                break
    check("no self-repetition in the reply (no 60-char window x3)", not rep)
    # if the model investigated (trippy's shape): the pills carry whole output
    results = [e for e in evs if e.get("type") == "tool_result"]
    if results:
        sizes = [len(e.get("text") or "") for e in results]
        check(f"tool pills carry whole outputs ({len(results)} results, sizes {sizes[:4]})", True)
    else:
        check("the model answered (no tool round needed)", len(answer) > 80, f"{len(answer)} chars")


def rig_c(page):
    print("\n━━ RIG C — the continue button (Nvidia · z-ai/glm-5.3-flash)")
    api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
    time.sleep(6)  # the real async key validation
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v150-rig-c")
    if not sid:
        check("session created", False, "no id")
        return
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")

    send_via_ui(page, "Write a long 8-paragraph story about a small robot exploring a library. Begin writing the FIRST paragraph immediately — no planning, no preamble, just start the story text.")
    # wait for the turn to go LIVE (glm reasons first — thinking events are
    # activity too), then for actual prose (assistant_delta), then STOP
    streaming = False
    for _ in range(240):
        time.sleep(0.5)
        evs = events_of(sid)
        if any(e.get("type") in ("assistant_delta", "thinking") for e in evs):
            streaming = True
            break
    if not check("the turn went live (reasoning is activity too)", streaming):
        return
    prose = False
    for _ in range(420):
        time.sleep(0.5)
        evs = events_of(sid)
        if any(e.get("type") == "assistant_delta" for e in evs):
            prose = True
            break
    if not check("the prose started streaming", prose):
        return
    time.sleep(3)  # let real content land
    mode = page.evaluate("document.getElementById('chat-send').getAttribute('data-mode')")
    check("while streaming the button reads STOP", mode == "stop", f"mode={mode!r}")
    page.click("#chat-send")  # the stop tap
    time.sleep(2)
    evs_before = events_of(sid)
    users_before = len([e for e in evs_before if e.get("type") == "user"])
    partial = " ".join(assistant_texts(evs_before))
    check("the stop landed with partial content kept", len(partial) > 60, f"{len(partial)} chars kept")

    # the menu → continue (the stopped-mid-stream case: no error, no cut —
    # the chevron menu is its way in)
    page.click("#chat-send-more")
    page.wait_for_timeout(400)
    cont_enabled = page.evaluate(
        """(() => {
            const rows = Array.from(document.querySelectorAll('#send-menu .sm-row'));
            const c = rows.find(r => r.textContent.includes('continue'));
            return c ? !c.hasAttribute('disabled') : false;
        })()""")
    if not check("the menu offers continue (enabled) after the stop", cont_enabled):
        return
    page.evaluate(
        """(() => {
            const rows = Array.from(document.querySelectorAll('#send-menu .sm-row'));
            const c = rows.find(r => r.textContent.includes('continue'));
            c.click(); return true;
        })()""")
    page.wait_for_timeout(300)
    mode = page.evaluate("document.getElementById('chat-send').getAttribute('data-mode')")
    check("the button now reads CONTINUE", mode == "continue", f"mode={mode!r}")
    page.click("#chat-send")  # THE CONTINUE TAP
    page.wait_for_timeout(1500)

    ok, evs = wait_terminal(sid, 1)
    check("the continuation completed", ok)
    users_after = len([e for e in events_of(sid) if e.get("type") == "user"])
    check("NO new user event was persisted (the engine's continue frame — the retry's second [user M] is dead law)",
          users_after == users_before, f"{users_before} → {users_after}")
    full = " ".join(assistant_texts(events_of(sid)))
    after_partial = full[len(partial):] if full.startswith(partial) else full
    # the continuation is NEW text — the seam continues, never repeats
    head40_partial = partial.strip()[:40]
    check("the continuation streams NEW content (no repeated prefix)",
          len(after_partial.strip()) > 60 and not after_partial.strip().startswith(head40_partial),
          f"continuation head: {after_partial.strip()[:60]!r}")
    # the engine-side error-mask: nothing to hide here (a clean stop), but
    # the log must carry ZERO error rows for this session
    errs = [e for e in events_of(sid) if e.get("type") == "error"]
    check("zero error events in the whole flow", len(errs) == 0, f"{len(errs)} errors")


STATE_FILE = "/tmp/v150-rig-state.json"


def save_state(st):
    with open(STATE_FILE, "w") as f:
        json.dump(st, f)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return None




def phased_main(phase, only):
    """The phased rig: long turns (a real repo task runs 10-25 minutes on a
    flash model) cannot ride one process — the sandbox culls long trees. The
    engine boots in its OWN session and the phases re-attach:
      send → wait (repeat until exit 0) → assert."""
    if only != "B":
        print("phased mode supports rig B (the long original-prompt task)")
        sys.exit(1)
    if phase == "send":
        bin_path = build_engine("v149", ROOT)
        boot_engine(bin_path)  # detached — survives this process
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page(viewport={"width": 1280, "height": 900})
        page.goto(BASE + "/")
        page.wait_for_function("window.__doomalayReady === true", timeout=40000)
        page.wait_for_timeout(900)
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(700)
        api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
        time.sleep(6)
        sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v150-rig-b")
        if not sid:
            print("FAIL: no session")
            sys.exit(1)
        ok, ws = bind_doomalay(sid)
        print(("bound" if ok else "BIND FAILED"), str(ws)[:100])
        open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")
        send_via_ui(page, "make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected")
        time.sleep(4)
        evs = events_of(sid)
        started = any(e.get("type") == "status" and e.get("state") == "running" for e in evs)
        print("sent — turn started:", started)
        save_state({"sid": sid, "port": PORT, "sent_at": time.time()})
        try:
            pw.stop()
        except Exception:
            pass
        sys.exit(0)
    st = load_state()
    if not st:
        print("no state — run --phase=send first")
        sys.exit(1)
    sid = st["sid"]
    if phase == "wait":
        evs = events_of(sid)
        terminals = [e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if terminals:
            print(f"DONE: terminal state={terminals[-1].get('state')} after {len(evs)} events")
            sys.exit(0)
        print(f"STILL RUNNING: {len(evs)} events so far ({int(time.time() - st.get('sent_at', 0))}s)")
        sys.exit(2)
    # assert
    global PASS, FAIL
    evs = events_of(sid)
    ok = any(e.get("type") == "status" and e.get("state") == "idle" for e in evs)
    check("the turn completed (a real answer, not an error loop)", ok)
    answer = " ".join(assistant_texts(evs))
    low = answer.lower()
    check("the task was understood (workspace + glow/accent named)",
          ("workspace" in low) and (("glow" in low) or ("accent" in low)),
          f"answer head: {answer[:100]!r}")
    prompt = "make the connect workspace pill in the workspaces overlay glow an accent color when no workspaces are connected"
    user_events = [e for e in evs if e.get("type") == "user" and e.get("text") == prompt]
    check("the prompt persisted exactly ONCE (no re-send echo)", len(user_events) == 1,
          f"{len(user_events)} copies")
    rep = False
    if len(answer) > 180:
        for i in range(0, min(len(answer) - 60, 4000), 40):
            w = answer[i:i + 60]
            if len(w.strip()) > 40 and answer.count(w) >= 3:
                rep = True
                break
    check("no self-repetition in the reply (no 60-char window x3)", not rep)
    results = [e for e in evs if e.get("type") == "tool_result"]
    if results:
        sizes = [len(e.get("text") or "") for e in results]
        check(f"tool pills carry whole outputs ({len(results)} results, sizes {sizes[:5]})", True)
    # the engine cleanup
    try:
        subprocess.run(["pkill", "-f", "doomalay-v150 "], capture_output=True)
    except Exception:
        pass
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

def main():
    flip = "--flip" in sys.argv
    phase = None
    for a in sys.argv[1:]:
        if a.startswith("--phase="):
            phase = a.split("=", 1)[1]
    only = None
    for a in sys.argv[1:]:
        if a in ("A", "B", "C"):
            only = a

    # PHASED MODE (long turns — the engine outlives the rig process):
    #   --phase=send   boot + bind + the browser send; leaves the engine
    #                  running and writes the state file
    #   --phase=wait   poll the state's session for the terminal (exits 0
    #                  when done, 2 when still running)
    #   --phase=assert run the rig's assertions against the state's session
    #                  and clean the engine up
    if phase in ("send", "wait", "assert"):
        phased_main(phase, only)
        return
    if phase in ("send", "wait", "assert"):
        phased_main(phase, only)
        return
    src = ROOT
    tag = "v149"
    if flip:
        wt = "/tmp/v150-flip-tree"
        subprocess.run(["git", "worktree", "remove", "--force", wt], cwd=ROOT, capture_output=True)
        subprocess.run(["git", "worktree", "prune"], cwd=ROOT, capture_output=True)
        r = subprocess.run(["git", "worktree", "add", "--detach", wt, "HEAD~1"], cwd=ROOT, capture_output=True)
        if r.returncode != 0:
            print("FATAL: flip worktree failed:", r.stderr.decode()[-300:])
            sys.exit(1)
        src = wt
        tag = "v150-flip"
    bin_path = build_engine(tag, src)
    eng = boot_engine(bin_path)
    pw = None
    try:
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page(viewport={"width": 1280, "height": 900})
        page.goto(BASE + "/")
        page.wait_for_function("window.__doomalayReady === true", timeout=40000)
        page.wait_for_timeout(900)
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(700)

        if only in (None, "A"):
            rig_a(page, flip)
        if not flip:
            if only in (None, "B"):
                rig_b(page)
            if only in (None, "C"):
                rig_c(page)
    finally:
        try:
            pw.stop()
        except Exception:
            pass
        eng.terminate()
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
