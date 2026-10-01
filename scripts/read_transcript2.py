#!/usr/bin/env python3
"""read_transcript2.py — deeper DOM dump: every child of #chat-messages with
class + text length + text head; plus the artifacts drawer and any error
banners. For diagnosing what the HF final-test turn actually rendered."""
import json
import subprocess

SESSION = "doomalay-v0894"

JS = """(function(){
  var wrap = document.getElementById('chat-messages');
  var kids = [];
  if (wrap) {
    for (var i = 0; i < wrap.children.length; i++) {
      var c = wrap.children[i];
      kids.push({cls: (c.className||'').toString().slice(0,60), len: (c.innerText||'').length,
                 head: (c.innerText||'').slice(0,220).replace(/\\n/g,' | ')});
    }
  }
  var drawer = document.querySelectorAll('[class*=artifact]');
  var artNames = [];
  drawer.forEach(function(a){ var t=(a.innerText||'').slice(0,100); if (/\\.(txt|md|py|html|json|csv)/.test(t)) artNames.push(t); });
  var errs = document.querySelectorAll('.msg-row-error, [class*=error]');
  var errTxt = [];
  errs.forEach(function(e){ errTxt.push((e.innerText||'').slice(0,200)); });
  return JSON.stringify({kids: kids, artNames: artNames.slice(0,8), errs: errTxt.slice(0,4)});
})()"""


def ev(js):
    p = subprocess.run(
        ["agent-browser", "eval", js],
        capture_output=True, text=True, timeout=120,
        env={"AGENT_BROWSER_SESSION": SESSION, "PATH": "/usr/local/bin:/usr/bin:/bin:/home/z/.local/bin"},
    )
    out = p.stdout.strip()
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
            print("RAW:", d[:3000])
            return
    kids = d.get("kids") or []
    print(f"=== {len(kids)} children of #chat-messages ===")
    for i, k in enumerate(kids):
        print(f"[{i:2}] {k['cls'][:52]:52} len={k['len']:5}  {k['head'][:150]}")
    print("\n=== artifact-ish names ===")
    for a in d.get("artNames") or []:
        print(" ", a[:100])
    print("=== errors ===")
    for e in d.get("errs") or []:
        print(" ", e[:200])


if __name__ == "__main__":
    main()
