#!/usr/bin/env python3
"""v0776-corpus-upstream.py — the one-off surgical credit pass.

Patches the LIVE ScoobyBaby1999/doomalay-superpowers dataset without the
upstream tree mirror (the full corpus v3 run needs a checkout; this pass
only rewrites items/index.json + items/<id>.json metas with the upstream
credit, and lands collections/superpowers-obra.json — the bundle's
editorial manifest). Future corpus v3 runs keep everything idempotent.

Usage: python3 scripts/v0776-corpus-upstream.py --token hf_... [--dry]
"""
import argparse
import base64
import json
import os
import sys
import urllib.request

API = "https://huggingface.co"
REPO = "ScoobyBaby1999/doomalay-superpowers"
UPSTREAM_CREDIT = "obra/superpowers — Jesse Vincent (obra), MIT"
COLLECTION_MANIFEST = {
    "description": (
        "Jesse Vincent's celebrated superpowers — the brainstorming, "
        "planning, debugging and discipline workflows for AI agents. "
        "Ported 1:1 from obra/superpowers (MIT, © 2025 Jesse Vincent); "
        "the port and this listing are maintained by ScoobyBaby1999."
    ),
    "upstream": "obra/superpowers by Jesse Vincent (obra)",
    "by": "ScoobyBaby1999",
}


def hf_get(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=None)
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    token = args.token or os.environ.get("DOOMALAY_HF_TOKEN")
    if not token:
        sys.exit("no token: pass --token or set DOOMALAY_HF_TOKEN")

    index = json.loads(hf_get(token, f"{API}/datasets/{args.repo}/resolve/main/items/index.json"))
    print(f"live index: {len(index)} items")

    ops = [{"key": "header", "value": {
        "summary": "v0.77.6: the upstream credit + the bundle manifest",
        "description": "every item carries upstream=\"obra/superpowers — Jesse Vincent (obra), MIT\" so bylines + bot tools credit the ORIGINAL work; collections/superpowers-obra.json is the bundle's editorial manifest"}}]

    changed = 0
    for it in index:
        if it.get("upstream") == UPSTREAM_CREDIT:
            continue
        it["upstream"] = UPSTREAM_CREDIT
        ops.append({"key": "file", "value": {
            "path": f"items/{it['id']}.json",
            "content": base64.b64encode(json.dumps(it, indent=2).encode()).decode(),
            "encoding": "base64"}})
        changed += 1

    # the index itself (upstream fields now ride it)
    ops.append({"key": "file", "value": {
        "path": "items/index.json",
        "content": base64.b64encode(json.dumps(index, indent=2).encode()).decode(),
        "encoding": "base64"}})

    # the bundle's editorial manifest
    ops.append({"key": "file", "value": {
        "path": "collections/superpowers-obra.json",
        "content": base64.b64encode(json.dumps(COLLECTION_MANIFEST, indent=2).encode()).decode(),
        "encoding": "base64"}})

    print(f"ops: {len(ops)} (metas {changed}, index 1, manifest 1)")
    if args.dry:
        print("dry run — no commit")
        return

    body = "\n".join(json.dumps(o) for o in ops).encode()
    req = urllib.request.Request(
        f"{API}/api/datasets/{args.repo}/commit/main",
        data=body,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/x-ndjson"},
        method="POST")
    resp = urllib.request.urlopen(req)
    print("commit:", resp.status, resp.read().decode()[:160])


if __name__ == "__main__":
    main()
