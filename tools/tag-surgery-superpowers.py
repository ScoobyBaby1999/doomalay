#!/usr/bin/env python3
"""tag-surgery-superpowers.py — v0.91.3 (user spec: "change the #docs,
#scripts, and any other vague tags to something much more appropriate to
what superpowers does").

One-off surgical patch of the LIVE superpowers index (the corpus tool
PRESERVES live tags, so the patch persists through future regens):
  · ["superpowers", "docs"]    → ["superpowers", "agent-skills", "methodology"]
    (the 45 doc members ARE the methodology guides behind the skills)
  · ["superpowers", "scripts"] → ["superpowers", "automation", "tooling"]
    (the 4 script members are install/utility automation)
Everything else untouched. Ids/descriptions stable (download/heart state
is keyed on ids).

Usage: python3 tools/tag-surgery-superpowers.py --token hf_... [--dry]
"""
import argparse
import json
import urllib.request

API = "https://huggingface.co"
REPO = "ScoobyBaby1999/doomalay-superpowers"

# token-level surgery: "docs" → methodology + agent-skills;
# "scripts" → automation + tooling (shell stays — it's real: they're sh)
TOKEN_MAP = {
    "docs": ["agent-skills", "methodology"],
    "scripts": ["automation", "tooling"],
}


def hf_get(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    raw = hf_get(args.token, f"{API}/datasets/{REPO}/resolve/main/items/index.json")
    idx = json.loads(raw)
    items = idx.get("items", idx) if isinstance(idx, dict) else idx
    changed = 0
    for it in items:
        tags = it.get("tags") or []
        if any(t in TOKEN_MAP for t in tags):
            out = []
            for t in tags:
                if t in TOKEN_MAP:
                    out.extend(x for x in TOKEN_MAP[t] if x not in out)
                elif t not in out:
                    out.append(t)
            it["tags"] = out
            changed += 1
    print(f"{changed}/{len(items)} items retagged")

    if args.dry:
        for it in items[:3]:
            print(" ", it.get("type"), it.get("id"), it.get("tags"))
        print("dry run — no commit")
        return

    # the commit — THE NDJSON SHAPE the corpus tools use (the REST
    # {"summary","operations"} form returns 200 but silently no-ops on
    # this endpoint; base64 file ops are the working contract)
    import base64
    payload = json.dumps(idx, indent=2).encode()
    ops = [
        {"key": "header", "value": {
            "summary": "v0.91.3 tag surgery: docs→methodology, scripts→automation (meaningful bundle tags)"}},
        {"key": "file", "value": {
            "path": "items/index.json",
            "content": base64.b64encode(payload).decode(),
            "encoding": "base64"}},
    ]
    req = urllib.request.Request(
        f"{API}/api/datasets/{REPO}/commit/main",
        data="\n".join(json.dumps(o) for o in ops).encode(), method="POST",
        headers={"Authorization": f"Bearer {args.token}",
                 "Content-Type": "application/x-ndjson"})
    with urllib.request.urlopen(req) as r:
        print("commit:", r.status, r.read()[:160])


if __name__ == "__main__":
    main()
