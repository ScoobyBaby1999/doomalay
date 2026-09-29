#!/usr/bin/env python3
"""superpowers-corpus.py — the obra/superpowers corpus generator (v3).

Mirrors the upstream obra/superpowers tree into the
ScoobyBaby1999/doomalay-superpowers HF dataset and keeps the hub-native
items/ metas pointing at the TREE paths (not flat payload copies), so:

  · the repo view shows the REAL upstream tree (skills/<name>/SKILL.md +
    companions, docs/**, scripts/*.sh, tests/**, assets/*)
  · file rows in the repo view open the matching hub card (items[].file
    == the tree path)
  · every item wears the upstream assets/superpowers-small.svg icon
    (the "file:<path>" icon convention — the app renders it as an <img>)
  · items/index.json stays canonical (scan + tag discovery read it)

Item ids/descriptions/tags/createdAt are PRESERVED from the live index
(downloads + heart state + the local overlay key on them); only file,
icon and files change. Idempotent: re-running refreshes the tree and
rewrites the metas.

v3 (v0.77.6): THE UPSTREAM CREDIT — every item carries
upstream="obra/superpowers — Jesse Vincent (obra), MIT" so the hub
bylines, the bundle hero and every bot-facing tool read "by
ScoobyBaby1999 — ported from obra/superpowers" (a port NEVER reads as
the publisher's original work), and collections/superpowers-obra.json
lands as the bundle's editorial manifest (description + credit — the
hero's real description, v0.77.10's data).

Usage:
  python3 tools/superpowers-corpus.py \
    [--upstream /path/to/superpowers] \
    [--repo ScoobyBaby1999/doomalay-superpowers] \
    --token hf_...            (or $DOOMALAY_HF_TOKEN)

The token needs write access to the dataset. Dry-run prints the plan
without committing: --dry.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
MIRROR_DIRS = ("skills", "docs", "scripts", "tests", "assets")
ICON = "file:assets/superpowers-small.svg"  # the upstream brand icon
# v3 (v0.77.6): THE UPSTREAM CREDIT — every item carries it; the hub
# bylines, the bundle hero and every bot-facing tool read "by
# ScoobyBaby1999 — ported from obra/superpowers" (a port NEVER reads as
# the publisher's original work).
UPSTREAM_CREDIT = "obra/superpowers — Jesse Vincent (obra), MIT"
# v3: the bundle's editorial manifest (the hero's real description, the
# v0.77.10 data contract).
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
# v3: the credit every item carries — the bylines + bot tools surface it
UPSTREAM_CREDIT = "obra/superpowers — Jesse Vincent (obra), MIT"
# v3: the bundle's editorial manifest (the hero's real description)
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


def load_index(token, repo):
    raw = hf_get(token, f"{API}/datasets/{repo}/resolve/main/items/index.json")
    return json.loads(raw)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", default="/tmp/superpowers-upstream")
    ap.add_argument("--repo", default="ScoobyBaby1999/doomalay-superpowers")
    ap.add_argument("--token", default=None)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    token = args.token or os.environ.get("DOOMALAY_HF_TOKEN")
    if not token:
        sys.exit("no token: pass --token or set DOOMALAY_HF_TOKEN")

    up = Path(args.upstream)
    if not (up / "skills").is_dir():
        sys.exit(f"no upstream checkout at {up}")

    # ── 1. the live index (ids + descriptions must stay stable) ──────────
    index = load_index(token, args.repo)
    print(f"live index: {len(index)} items")

    # ── 2. the tree payloads to mirror (content-hashed for matching) ─────
    tree_files = {}   # relpath -> bytes
    for d in MIRROR_DIRS:
        for p in sorted((up / d).rglob("*")):
            if p.is_file():
                tree_files[p.relative_to(up).as_posix()] = p.read_bytes()
    print(f"tree files to mirror: {len(tree_files)} "
          f"({sum(len(v) for v in tree_files.values()) // 1024} KB)")
    by_hash = {}
    for rel, b in tree_files.items():
        by_hash.setdefault(sha(b), []).append(rel)

    # ── 3. match each item's CURRENT payload to a tree file ──────────────
    # (the v1 corpus served skills as a JSON envelope
    # {"v":1,"entry":"SKILL.md","files":[{path,content}…]} with the raw
    # SKILL.md embedded — nothing parses the envelope (the repo view
    # supersedes it), so v2 points file straight at the tree file and the
    # matcher hashes the ENVELOPE'S SKILL.md content for skills)
    unmatched, matched = [], {}
    for it in index:
        old = it.get("file", "")
        if not old:
            unmatched.append(it["id"])
            continue
        try:
            payload = hf_get(token, f"{API}/datasets/{args.repo}/resolve/main/{old}")
        except Exception:
            unmatched.append(it["id"])
            continue
        h = sha(payload)
        cands = by_hash.get(h, [])
        if not cands:
            try:
                env = json.loads(payload)
                entry = env.get("entry") or "SKILL.md"
                for f in env.get("files", []):
                    if f.get("path") == entry:
                        h = sha(f.get("content", "").encode())
                        cands = by_hash.get(h, [])
                        break
            except Exception:
                pass
        if len(cands) == 1:
            matched[it["id"]] = cands[0]
        elif len(cands) > 1:
            # tie-break: the stem resembles the item name
            stem = it["id"].rsplit("-", 1)[0].replace("-", "")
            pick = [c for c in cands if stem in c.replace("-", "")]
            if pick:
                matched[it["id"]] = pick[0]
            else:
                unmatched.append(it["id"])
        else:
            unmatched.append(it["id"])
    print(f"matched {len(matched)}/{len(index)} payloads to tree paths")
    if unmatched:
        print("  UNMATCHED:", ", ".join(unmatched[:10]))
        sys.exit("payload matching failed — refusing to rewrite those metas")

    # ── 4. build the v2 metas ─────────────────────────────────────────────
    new_index = []
    for it in index:
        it = dict(it)
        rel = matched[it["id"]]
        it["file"] = rel                       # the tree path IS the payload
        it["icon"] = ICON                      # the upstream brand icon
        it["upstream"] = UPSTREAM_CREDIT       # v3: the credit, always
        # companions: the OTHER files sharing the payload's directory
        # (a skill's scripts/spec docs ride the skill folder)
        if rel.startswith("skills/"):
            skill_dir = rel.rsplit("/", 1)[0]
            it["files"] = sorted(
                r for r in tree_files if r.startswith(skill_dir + "/") and r != rel)
        else:
            it["files"] = []
        new_index.append(it)

    # ── 5. the commit ops ────────────────────────────────────────────────
    ops = [{"key": "header", "value": {
        "summary": "corpus v3: the upstream credit + the bundle manifest",
        "description": "every item carries upstream=\"obra/superpowers — Jesse Vincent (obra), MIT\"; collections/superpowers-obra.json lands as the bundle's editorial manifest (description + credit)"}}]
    for rel, b in sorted(tree_files.items()):
        ops.append({"key": "file", "value": {
            "path": rel,
            "content": base64.b64encode(b).decode(),
            "encoding": "base64"}})
    for it in new_index:
        ops.append({"key": "file", "value": {
            "path": f"items/{it['id']}.json",
            "content": base64.b64encode(
                json.dumps(it, indent=2).encode()).decode(),
            "encoding": "base64"}})
    ops.append({"key": "file", "value": {
        "path": "items/index.json",
        "content": base64.b64encode(
            json.dumps(new_index, indent=2).encode()).decode(),
        "encoding": "base64"}})
    # v3: the bundle's editorial manifest — the hero's real description
    ops.append({"key": "file", "value": {
        "path": "collections/superpowers-obra.json",
        "content": base64.b64encode(
            json.dumps(COLLECTION_MANIFEST, indent=2).encode()).decode(),
        "encoding": "base64"}})
    # the old flat payload copies move to the tree — delete them
    deleted = 0
    for it in index:
        old = it.get("file", "")
        if old.startswith("items/") and old != f"items/{it['id']}.json":
            ops.append({"key": "deletedFile", "value": {"path": old}})
            deleted += 1
    print(f"ops: {len(ops)} (files {len(tree_files)}, metas {len(new_index)}, "
          f"index 1, deletions {deleted})")

    if args.dry:
        for it in new_index[:5]:
            print(" ", it["id"], "→", it["file"], "· icon", it["icon"])
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
    print("commit:", resp.status, resp.read().decode()[:120])


if __name__ == "__main__":
    main()
