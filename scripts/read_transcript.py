#!/usr/bin/env python3
"""read_transcript.py — dump the current chat transcript from the running
v0894 browser session (helper for the final test; robust JSON extraction)."""
import json
import subprocess
import sys

SESSION = "doomalay-v0894"

JS = """(function(){
  var rows = [];
  var nodes = document.querySelectorAll('#chat-messages > *');
  document.querySelectorAll('#chat-messages .msg-row-user, #chat-messages .msg-row-assistant, #chat-messages .msg-row-error').forEach(function(r){
    rows.push({cls: r.className, text: (r.innerText||'').slice(0, 3000)});
  });
  var arts = [];
  document.querySelectorAll('#chat-messages [class*=artifact], #chat-messages [class*=file]').forEach(function(a){ arts.push((a.innerText||'').slice(0,120)); });
  return JSON.stringify({rows: rows, arts: arts});
})()"""


def ev(js: str):
    p = subprocess.run(
        ["agent-browser", "eval", js],
        capture_output=True, text=True, timeout=120,
        env={"AGENT_BROWSER_SESSION": SESSION, "PATH": "/usr/local/bin:/usr/bin:/bin:/home/z/.local/bin"},
    )
    out = p.stdout.strip()
    # the result may be a JSON blob or a bare string; find the outermost JSON
    for ln in out.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            v = json.loads(ln)
            if isinstance(v, dict):
                v = v.get("data", {}).get("result", v)
            return v
        except Exception:
            continue
    return out


def main():
    d = ev(JS)
    if isinstance(d, str):
        try:
            d = json.loads(d)
        except Exception:
            print("RAW:", d[:2000])
            return
    rows = d.get("rows") or []
    print(f"{len(rows)} rows, artifacts-hints: {len(d.get('arts') or [])}")
    for i, r in enumerate(rows):
        cls = "USER" if "user" in (r.get("cls") or "") else ("ERROR" if "error" in (r.get("cls") or "") else "BOT ")
        print(f"\n===== [{i}] {cls} =====")
        print((r.get("text") or "")[:2800])


if __name__ == "__main__":
    main()
