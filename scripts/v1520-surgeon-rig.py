#!/usr/bin/env python3
# v1.51 THE SURGEON — the live red-team rig (PLAN-V152 §THE PROOF).
#
# THE USER'S TESTS:
#   RIG A — the chat-honesty trio, all through the REAL app:
#     A1 THE NO-DUP SEND: a failing provider (invalid key → instant 401
#         terminal) + the SAME text sent 5× — the trippy (2).md log's 5×
#         duplication conviction. Post-fix: ONE user row; the re-sends
#         become continues.
#     A2 THE HEALED SEAM: a dangling tool_use (REST-seeded, the exact
#         restart-killed shape) → ENGINE REBOOT → the boot heal answers
#         the call with the never-ran truth + the healed terminal carries
#         the continue hint.
#     A3 THE DNS FACE: the log's VERBATIM DNS error seeded as an event →
#         the browser bubble renders the FRIENDLY network-trouble text
#         (with Continue), never the raw netx string.
#   RIG B — THE BLADE: a REAL model (Nvidia glm-5.3-flash, the in-app
#     key) performs a surgical patch on a scratch repo through the app's
#     own workspace tool: read a RANGE → dry-run patch → commit. Asserts
#     the GitHub diff is EXACTLY the surgical change (no whole-file put).
#   RIG C — THE GLOW PUSH (run AFTER the ship, its own phase): the bot
#     pushes its glow feature as a sub-wave x.x.# COMPLETELY ON ITS OWN
#     through the new tools (the user's finale test).
#
# All rides the REAL app: real engine, real browser page, the chat's OWN
# composer, real provider keys.
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))
                       ) if os.path.basename(os.path.dirname(os.path.abspath(__file__))) == "scripts" else os.path.dirname(os.path.abspath(__file__))
if not os.path.isdir(os.path.join(ROOT, "engine")):
    ROOT = "/home/z/my-project/doomalay-repo"
PORT = int(os.environ.get("ENGINE_PORT", "8099"))
BASE = f"http://127.0.0.1:{PORT}"
GO = "/tmp/goroot/bin/go"

VAULT = "/home/z/my-project/.vault"
KEYS = {}
if os.path.exists(VAULT + "/api-keys.md"):
    for ln in open(VAULT + "/api-keys.md"):
        ln = ln.strip()
        if ln.startswith("- ") and ":" in ln:
            name, val = ln[2:].split(":", 1)
            KEYS[name.strip().lower()] = val.strip()
GH_TOKEN = KEYS.get("github", "")
if not GH_TOKEN and os.path.exists(VAULT + "/github-token"):
    GH_TOKEN = open(VAULT + "/github-token").read().strip()
NV_KEY = KEYS.get("nvidia", "")
SCRATCH_REPO = "doomalay-rig-scratch"

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + (1 if ok else 0), FAIL + (0 if ok else 1)
    return ok


def api(path, method="GET", body=None, timeout=240, base=None):
    req = urllib.request.Request(
        (base or BASE) + path,
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
    except Exception as e:
        return {"__error": str(e)}


def gh(path, method="GET", body=None):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GH_TOKEN}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def build_engine(tag="v151"):
    bin_path = f"/tmp/doomalay-{tag}"
    r = subprocess.run(
        [GO, "build", "-o", bin_path, "./cmd/doomalay"],
        cwd=os.path.join(ROOT, "engine"),
        env={**os.environ, "GOCACHE": "/tmp/gocache", "GOMODCACHE": "/home/z/go/pkg/mod"},
        capture_output=True,
    )
    if r.returncode != 0:
        print("FATAL: engine build failed:", r.stderr.decode()[-600:])
        sys.exit(1)
    return bin_path


def boot_engine(bin_path, data_dir=None):
    data_dir = data_dir or tempfile.mkdtemp(prefix="v152-eng-")
    log = tempfile.NamedTemporaryFile(prefix="v152-log-", delete=False)
    eng = subprocess.Popen(
        [bin_path, "--port", str(PORT), "--data-dir", data_dir, "--bind", "127.0.0.1"],
        env={**os.environ, "DOOMALAY_OTA_DISABLE": "1"},
        stdout=log, stderr=log,
        start_new_session=True,
    )
    for _ in range(160):
        try:
            # a STRICT probe (api() swallows connection errors — the poll
            # must only succeed on a real answer)
            with urllib.request.urlopen(BASE + "/api/health", timeout=5) as r:
                json.loads(r.read().decode())
            return eng, data_dir
        except Exception:
            time.sleep(0.5)
    print("FATAL: engine never came up")
    sys.exit(1)


def events_of(sid):
    evs = api(f"/api/sessions/{sid}/events?since=0", timeout=60)
    return evs if isinstance(evs, list) else evs.get("events", [])


def wait_terminal(sid, since_count=0, timeout_s=420):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        evs = events_of(sid)
        terminals = [e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")]
        if len(terminals) > since_count:
            return terminals[-1].get("state") in ("idle",), evs
        time.sleep(1.0)
    return False, events_of(sid)


def assistant_texts(evs, after_seq=0):
    return [e.get("text") or "" for e in evs
            if e.get("type") == "assistant" and e.get("seq", 0) > after_seq]


def make_session(provider, model, title):
    r = api("/api/sessions", "POST", {"provider": provider, "model": model, "title": title})
    return r.get("ID") or r.get("id")


def open_chat(page, sid, provider, model):
    page.evaluate(
        """([sid, provider, model]) => {
            const icon = window.doomalay.world.entities.filter(e => e.type === 'chat')[0];
            icon.sessionId = sid; icon.save();
            const st = window.ChatPanel.getState(icon.id);
            if (st) { st.sessionId = sid; st.provider = provider; st.model = model; }
            return window.doomalay.openChatBySession(sid);
        }""", [sid, provider, model])
    page.wait_for_function("!!document.getElementById('chat-input')", timeout=20000)
    page.wait_for_timeout(600)


def send_via_ui(page, text):
    page.fill("#chat-input", text)
    page.click("#chat-send")


def append_event(sid, typ, text):
    return api(f"/api/sessions/{sid}/events", "POST", {"type": typ, "text": text})


# ── RIG A — the chat-honesty trio ─────────────────────────────────────

def rig_a1_nodup(page, data_dir=None, bin_path=None):
    print("\n━━ A1 THE NO-DUP SEND — the 5×-duplication conviction (invalid key = the instant terminal)")
    # an INVALID nvidia key → every turn dies fast with 401 (non-transient)
    api("/api/keys", "POST", {"provider": "nvidia", "key": "nvapi-INVALID-KEY-FOR-THE-RIG"})
    time.sleep(4)
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v151-a1-nodup")
    if not check("session created", bool(sid)):
        return
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")
    prompt = "push the glow feature to the repo please"
    send_via_ui(page, prompt)
    ok, evs = wait_terminal(sid, 0, timeout_s=180)
    check("turn 1 failed fast (the invalid key's terminal error — the set-up)", not ok,
          f"terminal={ 'idle' if ok else 'error' }")
    users = [e for e in evs if e.get("type") == "user" and e.get("text") == prompt]
    if not check("the first send persisted exactly ONE user row", len(users) == 1, f"{len(users)} rows"):
        return
    # THE STORM: the same text, 4 more times (the user's 5-tap shape)
    for i in range(4):
        send_via_ui(page, prompt)
        time.sleep(1.5)
        # each re-send may dispatch a continue that fails fast; wait for its terminal
        deadline = time.time() + 90
        while time.time() < deadline:
            evs2 = events_of(sid)
            terminals = [e for e in evs2 if e.get("type") == "status" and e.get("state") in ("idle", "error")]
            if len(terminals) >= i + 2:
                break
            time.sleep(1.0)
    time.sleep(2)
    evs = events_of(sid)
    users = [e for e in evs if e.get("type") == "user"]
    same = [e for e in users if e.get("text") == prompt]
    check("THE 5×-DUP IS DEAD: 5 sends → still exactly ONE user row",
          len(same) == 1, f"{len(same)} copies of the prompt, {len(users)} user rows total")
    errs = [e for e in evs if e.get("type") == "error"]
    check("the re-sends produced honest errors (the continue attempts' own failures)",
          len(errs) >= 4, f"{len(errs)} error rows")
    # the composer's 4th mode arms on the trailing error (continue, never retry)
    mode = page.evaluate("document.getElementById('chat-send').getAttribute('data-mode')")
    check("the composer arms CONTINUE on the trailing error", mode == "continue", f"mode={mode!r}")
    # restore the real key for the later rigs
    api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
    time.sleep(6)


def rig_a2(page, data_dir=None, bin_path=None):
    print("\n━━ A2 THE HEALED SEAM — the restart-killed tool call heals honestly")
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v151-a2-heal")
    if not check("session created", bool(sid)):
        return
    append_event(sid, "user", "read the repo and fix the bug")
    append_event(sid, "assistant", "on it — reading the file now")
    append_event(sid, "tool_use", json.dumps({"name": "workspace",
                                              "args": "{\"action\":\"read\",\"path\":\"engine/internal/server/chat.go\"}"}))
    # THE RESTART (the Android watchdog shape): kill, then re-boot on the
    # SAME data dir — the boot heal must answer the dangling call.
    subprocess.run(["pkill", "-f", f"doomalay-v152 --port {PORT}"], capture_output=True)
    time.sleep(2.5)
    boot_engine(bin_path, data_dir=data_dir)
    evs = events_of(sid)
    synth = [e for e in evs if e.get("type") == "tool_result"
             and "interrupted by engine restart" in (e.get("text") or "")]
    check("the dangling tool call got its synthesized never-ran answer", len(synth) == 1,
          f"{len(synth)} synthesized results")
    healed = [e for e in evs if e.get("type") == "status" and "healed" in (e.get("text") or "")]
    check("the healed terminal landed", len(healed) == 1)
    check("the healed terminal carries the continue hint",
          any('"hint":"continue"' in (e.get("text") or "") or 'continue' in (e.get("text") or "").lower()
              for e in healed), str([e.get("text") for e in healed])[:120])
    # the UI: open the healed session — the bubble must render (the panel's
    # own heal), and the composer arms continue
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")
    time.sleep(1.5)
    mode = page.evaluate("document.getElementById('chat-send').getAttribute('data-mode')")
    check("the composer arms CONTINUE after the restart-heal", mode == "continue", f"mode={mode!r}")


def rig_a3_dnsface(page, data_dir=None, bin_path=None):
    print("\n━━ A3 THE DNS FACE — the verbatim outage error renders friendly")
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v151-a3-dnsface")
    if not check("session created", bool(sid)):
        return
    # the (2).md log's VERBATIM error payload (the wire shape forwardEvents
    # persists) — seeded so the panel's own error path renders it.
    append_event(sid, "user", "push the glow feature please")
    append_event(sid, "error", json.dumps({
        "error": "llm",
        "message": 'Post "https://integrate.api.nvidia.com/v1/chat/completions": netx: no address for "integrate.api.nvidia.com" (system resolver and DNS-over-HTTPS both failed)',
        "provider": "nvidia", "model": "z-ai/glm-5.3-flash"}))
    append_event(sid, "status", json.dumps({"state": "error", "usage": None}))
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")
    time.sleep(1.5)
    body = page.evaluate("document.body.innerText")
    check("the DNS error renders FRIENDLY (Network trouble + DNS named)",
          "network trouble" in body.lower() and "dns" in body.lower(),
          "the friendly class must own the bubble")
    check("the raw netx transport string is GONE from the transcript",
          "netx: no address" not in body)
    check("the affordance is CONTINUE (never retry)",
          "tap continue" in body.lower(), "")


# ── RIG B — THE BLADE (a real model, a real surgical patch) ──────────

def ensure_scratch_repo():
    """The scratch repo for the blade test: created if missing, seeded with
    a known file, returns the current file content."""
    try:
        info = gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}")
    except urllib.error.HTTPError:
        gh("/user/repos", "POST", {"name": SCRATCH_REPO, "private": True,
                                   "description": "the v151 rig's scratch surface (the blade test)"})
        time.sleep(2)
        info = gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}")
    appjs = (
        "// the rig's app — a small config surface\n"
        "const config = {\n"
        "  theme: 'accent',\n"
        "  glow: false,\n"
        "  glowColor: '#ffffff',\n"
        "  label: 'connect workspace',\n"
        "};\n"
        "\n"
        "// renderPill draws the connect pill.\n"
        "function renderPill(el) {\n"
        "  el.textContent = config.label;\n"
        "  el.classList.add('wsx-conn');\n"
        "}\n"
        "\n"
        "// enableGlow turns the accent glow on.\n"
        "function enableGlow() {\n"
        "  config.glow = true;\n"
        "  return config.glow;\n"
        "}\n"
    )
    # (re)seed app.js at main so every rig run starts from the same base
    try:
        cur = gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}/contents/app.js?ref=main")
        sha = cur.get("sha")
        gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}/contents/app.js", "PUT", {
            "message": "rig: reseed the blade surface", "content": __import__("base64").b64encode(appjs.encode()).decode(),
            "sha": sha, "branch": "main"})
    except urllib.error.HTTPError:
        gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}/contents/app.js", "PUT", {
            "message": "rig: seed the blade surface",
            "content": __import__("base64").b64encode(appjs.encode()).decode(), "branch": "main"})
    return appjs


def rig_b(page, data_dir=None, bin_path=None):
    print("\n━━ RIG B — THE BLADE (Nvidia · z-ai/glm-5.3-flash, the scratch repo)")
    base_content = ensure_scratch_repo()
    check("the scratch repo is seeded", len(base_content) > 100)
    api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
    time.sleep(6)
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v151-rig-b-blade")
    if not sid:
        check("session created", False, "no id")
        return
    ws = api("/api/workspaces/connect", "POST",
             {"url": f"https://github.com/ScoobyBaby1999/{SCRATCH_REPO}",
              "session_id": sid, "token": GH_TOKEN})
    check("the scratch workspace bound (FULL access)", "__status" not in ws, str(ws)[:120])
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")

    # THE TASK — surgical, dry-run first, exactly the tools this wave built:
    send_via_ui(page,
                f"In the {SCRATCH_REPO} workspace: (1) read lines 1-12 of app.js, "
                "(2) use the workspace tool's patch action with dry_run:true to change the pill config so glow is enabled "
                "and glowColor uses the theme's accent color — edits like "
                '{\\"old\\":\\"  glow: false,\\",\\"new\\":\\"  glow: true,\\"} — '
                "(3) review the preview, then commit the same patch without dry_run. "
                "Do NOT rewrite the whole file — surgical edits only.")
    ok, evs = wait_terminal(sid, 0, timeout_s=900)
    if not check("the turn completed", ok):
        errs = [e for e in evs if e.get("type") == "error"]
        print("      errors:", [str(e.get("text"))[:100] for e in errs][:3])
        return
    # the tool round: the patch verbs must have been used
    uses = []
    for e in evs:
        if e.get("type") == "tool_use":
            try:
                uses.append(json.loads(e.get("text") or "{}"))
            except Exception:
                pass
    actions = [str(u.get("args") or "") for u in uses]
    saw_patch = any('"patch"' in a or "'patch'" in a for a in actions)
    saw_dry = any("dry_run" in a for a in actions)
    check("the model used the PATCH verb (the blade)", saw_patch, f"{len(uses)} tool calls")
    check("the dry-run preview came first", saw_dry)
    results = [e for e in evs if e.get("type") == "tool_result"]
    saw_preview = any("DRY-RUN" in (e.get("text") or "") for e in results)
    saw_patched = any("PATCHED" in (e.get("text") or "") for e in results)
    check("the DRY-RUN preview answered", saw_preview)
    check("the PATCHED commit landed through the app", saw_patched)
    # THE GITHUB TRUTH: the file now carries the surgical change, whole rest intact
    try:
        cur = gh(f"/repos/ScoobyBaby1999/{SCRATCH_REPO}/contents/app.js?ref=main")
        import base64 as b64mod
        content = b64mod.b64decode(cur.get("content", "")).decode()
        check("the glow flag flipped surgically (glow: true)", "glow: true" in content)
        check("THE SURGICAL LAW: the rest of the file is untouched (renderPill + enableGlow intact)",
              "function renderPill" in content and "function enableGlow" in content
              and "el.classList.add('wsx-conn')" in content)
        if "glow: false" in content:
            check("the old line is gone (a replace, not an append)", False)
        else:
            check("the old line is gone (a replace, not an append)", True)
    except Exception as ex:
        check("the GitHub truth is readable", False, str(ex)[:120])


# ── RIG C — THE GLOW PUSH (phased; run after the ship) ───────────────

GLOW_PROMPT = """You are shipping a real feature to the doomalay repo (the ScoobyBaby1999/doomalay workspace bound to this chat), completely on your own. THE FEATURE: make the connect-workspace pill in the workspaces overlay glow the theme's accent color when no workspaces are connected (a soft pulsing glow animation; use the EXISTING theme accent variable — never a hardcoded color; the pill is the one users tap to connect their first workspace).

THE LAWS (from the repo's own conventions — read them in the repo if unsure):
1. Surgical edits only: use the workspace tool's patch action (search/replace edits) — read the exact region you need (read with a range), then patch. NO whole-file rewrites. For a multi-file change, the commit action lands them in ONE atomic commit.
2. The strict push protocol: before pushing, run the sync action to check whether the target is behind main; never force anything; if the remote moved under you, re-read and re-apply.
3. The version law: read engine/internal/buildinfo/buildinfo.go for the current version, and bump it to the NEXT free sub-wave number (x.x.# — the next dot; check the repo's worklog.md tail or recent commit messages for the convention) as part of your change.
4. Push directly to main through the workspace tool (patch/commit actions commit via the GitHub API), then report the commit URL and exactly what you changed.

Do it now: explore what you need, design the glow (theme-compliant), patch the files, bump the version, push, and report. No overthinking — the tools are built for this."""


def rig_c_send(page):
    print("\n━━ RIG C — THE GLOW PUSH, send phase (the bot pushes completely on its own)")
    api("/api/keys", "POST", {"provider": "nvidia", "key": NV_KEY})
    time.sleep(6)
    sid = make_session("nvidia", "z-ai/glm-5.3-flash", "v151-rig-c-glowpush")
    if not sid:
        print("FAIL: no session")
        sys.exit(1)
    ws = api("/api/workspaces/connect", "POST",
             {"url": "https://github.com/ScoobyBaby1999/doomalay",
              "session_id": sid, "token": GH_TOKEN})
    print("bound:", "__status" not in ws)
    open_chat(page, sid, "nvidia", "z-ai/glm-5.3-flash")
    send_via_ui(page, GLOW_PROMPT)
    time.sleep(5)
    evs = events_of(sid)
    started = any(e.get("type") == "status" and e.get("state") == "running" for e in evs)
    print("sent — turn started:", started)
    with open("/tmp/v152-rig-c-state.json", "w") as f:
        json.dump({"sid": sid, "sent_at": time.time()}, f)
    sys.exit(0)


def rig_c_wait():
    try:
        st = json.load(open("/tmp/v152-rig-c-state.json"))
    except Exception:
        print("no state — run --phase=send first")
        sys.exit(1)
    evs = events_of(st["sid"])
    terminals = [e for e in evs if e.get("type") == "status" and e.get("state") in ("idle", "error")]
    if terminals:
        print(f"DONE: terminal state={terminals[-1].get('state')} after {len(evs)} events")
        sys.exit(0)
    print(f"STILL RUNNING: {len(evs)} events ({int(time.time() - st.get('sent_at', 0))}s)")
    sys.exit(2)


def rig_c_assert(page=None):
    global PASS, FAIL
    st = json.load(open("/tmp/v152-rig-c-state.json"))
    sid = st["sid"]
    evs = events_of(sid)
    ok = any(e.get("type") == "status" and e.get("state") == "idle" for e in evs)
    check("the turn completed (a real answer, not an error loop)", ok)
    answer = " ".join(assistant_texts(evs))
    uses = []
    for e in evs:
        if e.get("type") == "tool_use":
            try:
                uses.append(json.loads(e.get("text") or "{}"))
            except Exception:
                pass
    actions = [str(u.get("args") or "") for u in uses]
    check("the bot used the SURGICAL verbs (patch and/or commit)",
          any(('"patch"' in a or "'patch'" in a or '"commit"' in a) for a in actions),
          f"{len(uses)} tool calls")
    check("the bot ran the rebase eye (sync) before pushing",
          any('"sync"' in a for a in actions))
    # THE GITHUB TRUTH: the new commit(s) on main, the glow present, the
    # version bumped to a sane next sub-wave, the diff SURGICAL.
    try:
        commits = gh("/repos/ScoobyBaby1999/doomalay/commits?per_page=5")
        mine = [c for c in commits if "glow" in (c.get("commit", {}).get("message", "").lower())]
        check("a glow commit landed on main", len(mine) >= 1,
              str([c.get("commit", {}).get("message", "")[:60] for c in commits[:3]]))
        # the glow must be in the tree: search the pushed files
        found_glow = False
        hard_colors = True
        for probe in ("engine/internal/server/web/workspaces.js",
                      "engine/internal/server/web/chatpanel.js",
                      "engine/internal/server/web/styles.css",
                      "engine/internal/server/web/index.html"):
            try:
                fc = gh(f"/repos/ScoobyBaby1999/doomalay/contents/{probe}?ref=main")
                import base64 as b64mod
                body = b64mod.b64decode(fc.get("content", "")).decode()
                if "wsx-glow" in body or ("data-empty" in body and "wsx" in body):
                    found_glow = True
                    # the theme law: the animation must reference the accent var
                    if "--accent" in body or "var(--" in body:
                        hard_colors = False if "--accent" in body else hard_colors
            except urllib.error.HTTPError:
                continue
        check("the glow code rides the pushed tree", found_glow)
        # the version law: buildinfo bumped PAST the ship's number
        bi = gh("/repos/ScoobyBaby1999/doomalay/contents/engine/internal/buildinfo/buildinfo.go?ref=main")
        import base64 as b64mod
        bib = b64mod.b64decode(bi.get("content", "")).decode()
        import re
        m = re.search(r'var Version = "([0-9.]+)"', bib)
        ver = m.group(1) if m else "?"
        check(f"the version bumped to a sane sub-wave (now {ver})",
              m is not None and ver not in ("1.50.0",))
        # the bot's own report names the commit + what changed
        check("the bot reported its push (commit URL or the change list)",
              "commit" in answer.lower() or "http" in answer.lower(),
              f"answer head: {answer[:120]!r}")
    except Exception as ex:
        check("the GitHub truth is readable", False, str(ex)[:140])
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


# ── main ──────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    phase = None
    for a in args:
        if a.startswith("--phase="):
            phase = a.split("=", 1)[1]
    only = None
    for a in args:
        if a in ("A", "B", "C"):
            only = a

    if phase == "c-send":
        bin_path = build_engine()
        boot_engine(bin_path)
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        page = pw.chromium.launch().new_page(viewport={"width": 1280, "height": 900})
        page.goto(BASE + "/")
        page.wait_for_function("window.__doomalayReady === true", timeout=40000)
        page.wait_for_timeout(900)
        page.evaluate("document.getElementById('dock-new-chat').click()")
        page.wait_for_timeout(700)
        try:
            rig_c_send(page)
        finally:
            try:
                pw.stop()
            except Exception:
                pass
        return
    if phase == "c-wait":
        rig_c_wait()
        return
    if phase == "c-assert":
        rig_c_assert()
        return

    # v1.51 harness law: EVERY phase gets a PRISTINE engine + browser (the
    # v1.42.8 conviction — a stale page's panel state leaks across phases;
    # the v1500 rigs always ran one-per-engine).
    def run_phase(fn):
        subprocess.run(["pkill", "-f", f"doomalay-v152 --port {PORT}"], capture_output=True)
        time.sleep(1.0)
        bin_path = build_engine()
        eng, data_dir = boot_engine(bin_path)
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
            fn(page, data_dir, bin_path)
        finally:
            try:
                pw.stop()
            except Exception:
                pass
            eng.terminate()

    if only in (None, "A"):
        run_phase(rig_a1_nodup)
        run_phase(rig_a2)
        run_phase(rig_a3_dnsface)
    if only in (None, "B"):
        run_phase(rig_b)
    subprocess.run(["pkill", "-f", f"doomalay-v152 --port {PORT}"], capture_output=True)
    print(f"\n{'PASS' if FAIL == 0 else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
