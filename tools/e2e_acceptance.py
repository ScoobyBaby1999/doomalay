#!/usr/bin/env python3
"""E2E acceptance driver — the v0.60 superpowers port, Phase 10.

Drives the REAL stack (engine :8080 + brain :9090 + privatemodeai glm-5.3)
through a chat session with the lib gate ON, sends the porting guide's
acceptance test ("Let's make a react todo list") and verifies the skill
discipline: a methodology skill (brainstorming) must LOAD before code.

Usage: python3 e2e_acceptance.py [--msg "..."] [--model privatemodeai/glm-5.3]
       [--lib off] [--max-wait 600]
"""
import argparse
import json
import sys
import time
import uuid

import requests
import websocket

ENGINE = "http://127.0.0.1:8080"


def create_session(model: str, lib_auto: bool, title: str) -> dict:
    r = requests.post(f"{ENGINE}/api/sessions", json={
        "title": title,
        "model": model,
        "provider": model.split("/")[0],
        "mode": "auto",
        "lib_auto": lib_auto,
    }, timeout=15)
    r.raise_for_status()
    return r.json()


def run_turn(session_id: str, message: str, max_wait: int) -> list:
    """Open the WS, send the message, collect events until status idle/error."""
    ws = websocket.create_connection(
        f"ws://127.0.0.1:8080/api/chat?session_id={session_id}",
        timeout=max_wait,
    )
    events = []
    ws.send(json.dumps({"type": "send", "message": message}))
    deadline = time.time() + max_wait
    ws.settimeout(20)
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        if not raw:
            break
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            continue
        events.append(ev)
        if ev.get("type") == "status" and ev.get("state") in ("idle", "error"):
            break
    try:
        ws.close()
    except Exception:
        pass
    return events


def analyze(events: list) -> dict:
    """Extract the verification signals from the event stream."""
    out = {"tool_uses": [], "assistant_chars": 0, "errors": [], "final_state": None,
           "deltas": [], "skill_loads": [], "first_code_idx": None}
    # pass 1: collect
    texts_by_delta_idx = []
    for i, ev in enumerate(events):
        t = ev.get("type")
        if t == "tool_use":
            out["tool_uses"].append({
                "idx": i,
                "name": ev.get("name"),
                "tool_use_id": ev.get("tool_use_id"),
            })
        elif t == "assistant_delta":
            out["assistant_chars"] += len(ev.get("text") or "")
            texts_by_delta_idx.append((i, ev.get("text") or ""))
            out["deltas"].append(ev.get("text") or "")
        elif t == "error":
            out["errors"].append(f'{ev.get("error")}: {ev.get("message")}')
        elif t == "status":
            out["final_state"] = ev.get("state")
    # pass 2: pair tool_use → tool_result by id (args aren't in the event,
    # the RESULT text carries the loaded skill body).
    id2use = {tu["tool_use_id"]: tu for tu in out["tool_uses"]}
    for i, ev in enumerate(events):
        if ev.get("type") == "tool_result" and ev.get("tool_use_id") in id2use:
            tu = id2use[ev["tool_use_id"]]
            if tu["name"] == "skills":
                txt = (ev.get("text") or "")[:400]
                if not ev.get("is_error"):
                    out["skill_loads"].append({"idx": i, "result_head": txt})
    # pass 3: first substantial code block position (by event index)
    accum = ""
    for i, txt in texts_by_delta_idx:
        accum += txt
        if _code_started(accum):
            out["first_code_idx"] = i
            break
    return out


def _code_started(text: str) -> bool:
    """A substantial code signal: a fenced code block with real code inside,
    or a react-ish import — not just a passing mention."""
    for marker in ("```jsx", "```tsx", "```javascript", "```js"):
        p = text.find(marker)
        if p >= 0 and len(text) - p > 120:
            return True
    return ("import React" in text or "npx create-react-app" in text
            or "function TodoList" in text or "<TodoList" in text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--msg", default="Let's make a react todo list")
    ap.add_argument("--model", default="privatemodeai/glm-5.3")
    ap.add_argument("--lib", default="on", choices=["on", "off"])
    ap.add_argument("--max-wait", type=int, default=600)
    ap.add_argument("--keep", action="store", default=None,
                    help="reuse this session id instead of creating one")
    args = ap.parse_args()

    if args.keep:
        sid = args.keep
    else:
        sess = create_session(args.model, args.lib == "on",
                              f"e2e-superpowers-{args.lib}")
        sid = sess.get("id") or sess.get("ID")
    print(f"SESSION {sid} model={args.model} lib={args.lib}")
    print(f"SEND: {args.msg!r}")

    events = run_turn(sid, args.msg, args.max_wait)
    a = analyze(events)

    print(f"\n== TURN SUMMARY: {len(events)} events, final_state={a['final_state']}")
    print(f"   assistant chars: {a['assistant_chars']}")
    if a["errors"]:
        print(f"   ERRORS: {a['errors'][:5]}")
    print(f"   tool calls ({len(a['tool_uses'])}):")
    for tu in a["tool_uses"]:
        print(f"     [{tu['idx']:3d}] {tu['name']}")
    for sl in a["skill_loads"][:6]:
        head = sl["result_head"].replace(chr(10), " | ")[:110]
        print(f"     ↳ skills@{sl['idx']}: {head}")

    # dump full event stream for offline inspection
    dump = f"/tmp/e2e-{sid[-8:]}.jsonl"
    with open(dump, "w") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")
    print(f"\nFull stream: {dump}")

    # ── ACCEPTANCE CHECKS ──────────────────────────────────────────────
    ok = True
    if a["final_state"] != "idle":
        ok = False
        print("✗ FAIL: turn did not complete idle (state=%s, errors=%s)"
              % (a["final_state"], a["errors"][:3]))
    else:
        print("✓ turn completed idle")
    if args.lib == "on":
        loads = a["skill_loads"]
        if not loads:
            ok = False
            print("✗ FAIL: lib gate ON but NO skills load — bootstrap not steering")
        else:
            print(f"✓ skill discipline: {len(loads)} skills tool load(s)")
            first_load_idx = min(l["idx"] for l in loads)
            brainstorm = [l for l in loads
                          if "brainstorm" in l["result_head"].lower()]
            check_idx = brainstorm[0]["idx"] if brainstorm else first_load_idx
            if a["first_code_idx"] is not None and a["first_code_idx"] < check_idx:
                ok = False
                print(f"✗ FAIL: code started at event {a['first_code_idx']} BEFORE "
                      f"the first skill load at {check_idx}")
            elif brainstorm:
                print(f"✓ ACCEPTANCE: brainstorming skill loaded (event {check_idx}) "
                      f"before any code (first code at "
                      f"{a['first_code_idx'] if a['first_code_idx'] is not None else 'never'})")
            else:
                print(f"⚠ skills loaded (first at {first_load_idx}) but none is "
                      "brainstorming — inspect the stream")
    else:
        gated = [tu for tu in a["tool_uses"] if tu["name"] in ("skills", "hublib")]
        if gated:
            ok = False
            print(f"✗ FAIL: lib gate OFF but {len(gated)} skills/hublib calls slipped through")
        else:
            print("✓ lib gate OFF honored: no skills/hublib tool calls")
    print(f"\nVERDICT: {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
