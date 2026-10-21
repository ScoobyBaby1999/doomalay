#!/usr/bin/env python3
# v1.48.6 THE PROOF — the v1.48 THE SEEN SIGNAL rig: all five phases driven
# the way the real user drives the app. The five phase probes (each with its
# own pre-fix flip conviction, run at commit time) are the wave's live
# batteries; this rig ORCHESTRATES them + pins the source laws + runs the
# regression summary — the ship gate.
#
#   RA  THE SINGLE ECHO   — the stub provider counts the REAL wire payload
#   RB  THE LIVE STARS    — the worker's own counters, a frozen canvas, a
#                           real workspace, the real signal
#   RC  THE DIRECT PLUS  — the real picker, one real DOM click, one press
#   RD  THE INFORMATIVE PILL — a real tool_call → the real tool → the pill
#   RE  THE SERVE BRIDGE  — the genuine OpenCode client, two real engines
#   RF  the source pins   — the five phases' laws in the tree
#
# Usage: python3 scripts/v1480-the-seen-signal-rig.py [--quick]
#   --quick skips RE (the bridge probe spawns a real serve child and burns
#   real free-tier turns) — the CI-facing shape. The full battery runs
#   before every ship.
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUICK = "--quick" in sys.argv
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))
    PASS, FAIL = PASS + ok, FAIL + (not ok)


def run_probe(name, script):
    print(f"{name} — running {script}")
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", script)],
        capture_output=True, text=True, timeout=900,
    )
    out = r.stdout + r.stderr
    m = re.search(r"(?:^|\n)PASS: (\d+) passed, (\d+) failed", out)
    if m:
        p, f = int(m.group(1)), int(m.group(2))
        check(f"{name}: {script} {p}/{p + f}", f == 0 and p > 0, out.strip().splitlines()[-1] if out.strip() else "")
        return f == 0
    check(f"{name}: {script} — NO VERDICT", False, out[-300:])
    return False


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as fh:
        return fh.read()


def main():
    print("v1.48 THE SEEN SIGNAL — the ship-proof rig")
    ok_a = run_probe("RA — THE SINGLE ECHO", "v1481-echo-probe.py")
    ok_b = run_probe("RB — THE LIVE STARS", "v1482-stars-probe.py")
    ok_c = run_probe("RC — THE DIRECT PLUS", "v1483-plus-probe.py")
    ok_d = run_probe("RD — THE INFORMATIVE PILL", "v1484-pill-probe.py")
    ok_e = True
    if not QUICK:
        ok_e = run_probe("RE — THE SERVE BRIDGE", "v1485-bridge-probe.py")

    print("RF — the source pins (the five phases' laws in the tree)")
    compact = read("engine/internal/server/compact.go")
    chatgo = read("engine/internal/server/chat.go")
    check("v1.48.1: trimInFlightUser exists and is wired at BOTH sites",
          "func trimInFlightUser" in compact and
          compact.count("drops only ONE trailing user-role row") > 0 and
          "trimInFlightUser(history, userText)" in chatgo and
          "trimInFlightUser(hist, userText)" in chatgo)
    check("v1.48.1: the Turns metric lost its +1",
          "Turns: countUserTurns(history)}" in chatgo)
    appjs = read("engine/internal/server/web/app.js")
    check("v1.48.2: the session-hash rides entitiesSig + the forced frame on atoms-changed",
          "sessionHashOf(e)" in appjs and
          "paintGridFrame(true, true)" in appjs)
    wsjs = read("engine/internal/server/web/workspace.js")
    check("v1.48.3: the ＋ badge is its own affordance (data-plus + the shared chain)",
          'data-plus="1"' in wsjs and "plusBindToChat" in wsjs and
          "ev.stopPropagation();" in wsjs)
    panel = read("engine/internal/server/web/chatpanel.js")
    check("v1.48.4: the workspace pill's full verb table",
          all(v in panel for v in ["act === 'grep'", "act === 'view'", "act === 'pr_diff'",
                                   "act === 'create'", "act === 'release_create'"]))
    ocgo = read("engine/internal/ocserve/ocserve.go")
    check("v1.48.5: the gate-law config + the pinned version + the wall detector",
          '"bash": "deny"' in ocgo and 'const Version = "1.19.3"' in ocgo and
          "IsFreeTierError" in ocgo)
    turn = read("engine/internal/server/ocserveturn.go")
    check("v1.48.5: the recycle law + the synthesizeRounds wrap + the honest second-wall terminal",
          "ocServeForgetSession" in turn and "synthesizeRounds(sessionID, events)" in turn and
          "refused this turn twice" in turn)
    llmgo = read("engine/internal/llm/chat.go")
    check("v1.48.5: the honest wall copy names the desktop bridge",
          "On the DESKTOP engine the free models run through the built-in OpenCode bridge" in llmgo)

    print("RG — the regression summary (the go battery)")
    env = {**os.environ, "PATH": "/home/z/sdk/go/bin:" + os.environ.get("PATH", "")}
    r = subprocess.run(["go", "test", "./internal/server/", "./internal/ocserve/",
                        "./internal/llm/", "./internal/llm/", "-count=1"],
                       cwd=os.path.join(ROOT, "engine"), capture_output=True, text=True,
                       timeout=900, env=env)
    out = r.stdout
    ok = ("ok" in out and "FAIL" not in out)
    check("the go battery (server + ocserve + llm) green", ok, out.strip()[-160:])

    all_ok = ok_a and ok_b and ok_c and ok_d and ok_e and FAIL == 0
    print(f"\n{'PASS' if all_ok else 'FAIL'}: {PASS} passed, {FAIL} failed")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
