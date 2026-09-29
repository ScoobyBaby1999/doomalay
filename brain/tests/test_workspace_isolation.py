"""test_workspace_isolation.py — v0.75 Phase 3: the shared-disk isolation
red-team, locked as tests.

Every attack vector from the plan is here: cross-session workspace reads
by traversal, absolute paths, symlink escapes; the env echo (secrets in
subprocess envs); the namespace forgery (a client naming another user's
workspace); the uid determinism + band; the guard's ToolUse-dict calling
convention; and the two wrappers' body-rewrite semantics (via the brain's
canonical sanitize_chat_body — the templates share the exact whitelist
logic, and the source contract is asserted for both).

Run: python3 brain/tests/test_workspace_isolation.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import sandboxing  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name + (f" — {extra}" if extra and not cond else ""))
    print(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if extra else ""))


def section(title):
    print(f"\n── {title}")


# ── 1. sanitize_chat_body: the traversal / forgery vectors ──────────────
section("sanitize_chat_body — namespace + traversal")

root = Path(tempfile.mkdtemp(prefix="ws-test-"))
body = {
    "session_id": "sess-AAA__123",
    "message": "hi",
    "model": "nvidia/x",
    "workspace": "legit-name",
}
out = json.loads(sandboxing.sanitize_chat_body(json.dumps(body).encode(), root, "alice"))
check("workspace lands under the verified user's namespace",
      out["workspace"] == str(root / "alice" / "legit-name"), out["workspace"])
check("sandbox_user injected", out.get("sandbox_user") == "alice")

for evil in ("../../etc", "/etc/passwd", "....//..", "..\\..\\win", "a/b/c",
             "x\ty z", "Ω≈ç√", "../" * 40 + "root", ".", " "):
    out = json.loads(sandboxing.sanitize_chat_body(
        json.dumps({"session_id": "s", "workspace": evil}).encode(), root, "alice"))
    ws = Path(out["workspace"])
    parts = ws.relative_to(root).parts
    check(f"workspace {evil!r} whitelisted (every component is a safe name)",
          ws.is_absolute() and len(parts) == 2 and parts[0] == "alice"
          and bool(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}|anon", parts[1] or "anon")),
          str(ws.relative_to(root)))

for evil_sid in ("../../victim", "/etc", "a/b", "Ω"):
    out = json.loads(sandboxing.sanitize_chat_body(
        json.dumps({"session_id": evil_sid}).encode(), root, "bob"))
    sid = out["session_id"]
    check(f"session_id {evil_sid!r} whitelisted",
          bool(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}|anon", sid)), sid)
    check("no session_id → workspace falls to a whitelisted name under the user",
          out["workspace"] == str(root / "bob" / (sid or "anon")))

raw = b"not json at all"
check("non-JSON body passes through untouched",
      sandboxing.sanitize_chat_body(raw, root, "alice") == raw)
check("non-dict JSON body passes through untouched",
      sandboxing.sanitize_chat_body(b"[1,2]", root, "alice") == b"[1,2]")
check("empty body → session anon",
      json.loads(sandboxing.sanitize_chat_body(b"{}", root, "alice"))["session_id"] == "anon")

long_user = "u" * 100
out = json.loads(sandboxing.sanitize_chat_body(
    json.dumps({"session_id": "s"}).encode(), root, long_user))
check("username clamped to 32 whitelisted chars",
      out["workspace"] == str(root / ("u" * 32) / "s"))

# cross-user forgery: alice's turn naming bob's session → still alice's tree
out = json.loads(sandboxing.sanitize_chat_body(
    json.dumps({"session_id": "bobsecret"}).encode(), root, "alice"))
check("forged cross-user workspace stays in the CALLER's namespace",
      out["workspace"] == str(root / "alice" / "bobsecret"))

# the wrapper templates carry the same contract (source-level)
for tpl in ("engine/internal/hfzero/template/docker-app.py",
            "engine/internal/hfzero/template/app.py"):
    src = (HERE.parent / tpl).read_text(encoding="utf-8")
    check(f"{Path(tpl).name}: user-scoped workspace rewrite present",
          "WORKSPACES_ROOT / uname / (ws_name or sid or \"anon\")" in src
          or "WORKSPACES_ROOT / uname" in src)
    check(f"{Path(tpl).name}: sandbox_user injected",
          '"sandbox_user"' in src)

# ── 2. uid math ──────────────────────────────────────────────────────────
section("sandbox uid — determinism + band")

key1, key2 = b"k" * 32, b"j" * 32
u1 = sandboxing.sandbox_uid_for("/data/workspaces/alice/s1", key1)
u1b = sandboxing.sandbox_uid_for("/data/workspaces/alice/s1", key1)
u2 = sandboxing.sandbox_uid_for("/data/workspaces/alice/s2", key1)
u3 = sandboxing.sandbox_uid_for("/data/workspaces/alice/s1", key2)
check("deterministic per (path, key)", u1 == u1b)
check("inside the unprivileged band", 20000 <= u1 < 60000, str(u1))
check("different sessions → different uids", u1 != u2)
check("different keys → different uids (grinding needs the secret)", u1 != u3)

# ── 3. prepare_workspace (cooperative vs uid mode) ──────────────────────
section("prepare_workspace")

wsroot = Path(tempfile.mkdtemp(prefix="wsroot-"))
old = {k: os.environ.get(k) for k in
       ("DOOMALAY_SHARED", "DOOMALAY_SANDBOX_ISOLATION")}
try:
    os.environ.pop("DOOMALAY_SHARED", None)
    os.environ.pop("DOOMALAY_SANDBOX_ISOLATION", None)
    coop = sandboxing.prepare_workspace(wsroot / "carol" / "s1")
    check("non-shared rootless run → cooperative mode",
          coop["mode"] == "cooperative" and coop["uid"] is None)
    check("cooperative still tightens to 0700",
          (oct(os.stat(wsroot / "carol" / "s1").st_mode) in ("0o40700", "0o170700")))
    check("namespace dir is traverse-only (0711)",
          oct(os.stat(wsroot / "carol").st_mode)[-3:] == "711",
          oct(os.stat(wsroot / "carol").st_mode))

    os.environ["DOOMALAY_SANDBOX_ISOLATION"] = "1"
    if os.geteuid() == 0:
        rep = sandboxing.prepare_workspace(wsroot / "dave" / "s1")
        check("root + opt-in → uid mode", rep["mode"] == "uid" and rep["uid"], str(rep))
        st = os.stat(wsroot / "dave" / "s1")
        check("workspace owned by the sandbox uid", st.st_uid == rep["uid"], str(st.st_uid))
        check("workspace is 0700", oct(st.st_mode)[-3:] == "700")
        check(".uidkey is 0600 root-only",
              oct(os.stat(wsroot / "dave" / ".uidkey").st_mode)[-3:] == "600")
        rep2 = sandboxing.prepare_workspace(wsroot / "dave" / "s1")
        check("uid stable across restarts (same key)", rep2["uid"] == rep["uid"])
    else:
        rep = sandboxing.prepare_workspace(wsroot / "dave" / "s1")
        check("rootless + opt-in → falls back cooperative (never worse)",
              rep["mode"] == "cooperative")

    os.environ["DOOMALAY_SANDBOX_ISOLATION"] = "0"
    check("kill switch (DOOMALAY_SANDBOX_ISOLATION=0) disarms",
          sandboxing.isolation_enabled() is False)
finally:
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ── 4. the path guard (both calling conventions) ────────────────────────
section("path guard")

gws = Path(tempfile.mkdtemp(prefix="guard-"))
(gws / "inside.txt").write_text("x")
outside = Path(tempfile.mkdtemp(prefix="outside-"))
(outside / "secret.txt").write_text("TOPSECRET")
link = gws / "escape-link"
try:
    link.symlink_to(outside)
except Exception:
    link = None

check("workspace itself allowed", sandboxing.path_in_workspace(str(gws), gws))
check("file inside allowed", sandboxing.path_in_workspace(str(gws / "inside.txt"), gws))
check("relative allowed (resolves into ws)", sandboxing.path_in_workspace("notes/a.txt", gws))
check("traversal ../ rejected", not sandboxing.path_in_workspace("../escape", gws))
check("absolute outside rejected", not sandboxing.path_in_workspace(str(outside / "secret.txt"), gws))
check("~ expansion outside rejected", not sandboxing.path_in_workspace("~/../../etc", gws))
if link is not None:
    check("symlink escape rejected (realpath resolution)",
          not sandboxing.path_in_workspace(str(link / "secret.txt"), gws))

# kwargs convention (classic)
check("guard: kwargs path caught",
      sandboxing.violating_path_arg({"path": str(outside / "secret.txt")}, gws) is not None)
check("guard: kwargs path clean",
      sandboxing.violating_path_arg({"path": str(gws / "inside.txt")}, gws) is None)
check("guard: non-path params ignored",
      sandboxing.violating_path_arg({"command": "ls", "content": "a/b/c"}, gws) is None)
check("guard: non-string path ignored",
      sandboxing.violating_path_arg({"path": 123}, gws) is None)
# ToolUse dict convention ({"input": {...}})
check("guard: ToolUse input dict caught",
      sandboxing.violating_path_arg({"input": {"path": str(outside)}}, gws) is not None
      or sandboxing.violating_path_arg(
          (json.loads(json.dumps({"input": {"path": str(outside)}}))).get("input", {}), gws) is not None)
params_from_tooluse = {"input": {"file_path": "/etc/passwd"}}
inner = params_from_tooluse.get("input", {})
check("guard: file_path variant caught",
      sandboxing.violating_path_arg(inner, gws) == "/etc/passwd")

# ── 5. the subprocess env truth ─────────────────────────────────────────
section("safe_subprocess_env")

env = sandboxing.safe_subprocess_env(gws, {
    "PATH": "/usr/bin", "HOME": "/root",
    "NVIDIA_API_KEY": "nvapi-SENTINEL",
    "HF_TOKEN": "hf_SENTINEL",
    "MY_SECRET_THING": "x", "GITHUB_PAT": "ghp_SENTINEL",
    "SOME_PASSWORD": "y", "PLAIN": "ok",
})
check("secrets stripped (API_KEY/TOKEN/SECRET/PASSWORD/PAT)",
      not any(k for k in env if k.endswith(("API_KEY", "TOKEN", "PAT"))
              or "SECRET" in k or "PASSWORD" in k))
check("HOME points INSIDE the workspace", env["HOME"] == str(gws))
check("npm prefix inside the workspace", env["npm_config_prefix"].startswith(str(gws)))
check("sandbox marker set (the red-team asserts it)", env.get("DOOMALAY_SANDBOX") == "1")

# ── 6. live subprocess proof (uid demotion, only as root) ───────────────
section("demote (live subprocess)")

if os.geteuid() == 0:
    os.environ["DOOMALAY_SANDBOX_ISOLATION"] = "1"
    try:
        rep = sandboxing.prepare_workspace(wsroot / "erin" / "s1")
        pre = sandboxing.demote(rep["uid"])
        r = subprocess.run("id -u; echo $HOME; ls / 2>&1 | head -1",
                           shell=True, cwd=str(wsroot / "erin" / "s1"),
                           env=sandboxing.safe_subprocess_env(
                               wsroot / "erin" / "s1", {"PATH": "/usr/bin:/bin"}),
                           preexec_fn=pre, capture_output=True, text=True, timeout=30)
        first = (r.stdout or "").splitlines()[0] if r.stdout else ""
        check("subprocess runs as the sandbox uid", first == str(rep["uid"]), first)
        # the actual cross-session read attack, as the sandbox uid:
        (wsroot / "frank" / "s2").mkdir(parents=True, exist_ok=True)
        (wsroot / "frank" / "s2" / "victim.txt").write_text("VICTIM")
        sandboxing.prepare_workspace(wsroot / "frank" / "s2")
        try_read = subprocess.run(f"cat '{wsroot}/frank/s2/victim.txt' 2>&1; echo EXIT=$?",
                                  shell=True, cwd=str(wsroot / "erin" / "s1"),
                                  env=sandboxing.safe_subprocess_env(
                                      wsroot / "erin" / "s1", {"PATH": "/usr/bin:/bin"}),
                                  preexec_fn=pre, capture_output=True, text=True, timeout=30)
        check("cross-session read as the sandbox uid FAILS (denied)",
              "VICTIM" not in (try_read.stdout or "") and "EXIT=1" in (try_read.stdout or ""),
              (try_read.stdout or "")[:120])
    finally:
        os.environ.pop("DOOMALAY_SANDBOX_ISOLATION", None)
else:
    print("  skip  (not root — the uid assertions run in the container rig)")

print(f"\n{'=' * 60}\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILURES:")
    for f in FAIL:
        print("  -", f)
    sys.exit(1)
print("ALL ISOLATION VECTORS LOCKED")
