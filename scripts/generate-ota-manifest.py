#!/usr/bin/env python3
"""
generate-ota-manifest.py — v1.17.4 THE LIVE UPDATE (PLAN-V117 §v1.17.4).

Builds the patch-manifest.json the engine's delta OTA system consumes
(engine/internal/ota — the v1.17.4 manifest shape):

    {
      "version":     <tag>,   # the release this manifest describes
      "ref":         <tag>,   # the git ref the per-file raw URLs resolve at
      "min_engine":  <tag>,   # the semver gate: an OLDER engine refuses the
                              # delta and answers engine_update_required
                              # (the engine binary is never hot-patched)
      "files": [
        {"path": "engine/internal/server/web/…", "sha256": …, "size": …},
        …  # EVERY file under engine/internal/server/web/, sorted (deterministic)
      ]
    }

The only patchable root is the embedded web tree — that is what the
engine serves through the ota-first overlay (see docs/OTA.md). Paths are
repo-root-relative so the engine's traversal guard can verify them.

Run in CI after the APK build (the same tree the engine embeds):

    python3 scripts/generate-ota-manifest.py "$GITHUB_REF_NAME" patch-manifest.json

Then upload patch-manifest.json to the GitHub release alongside the APK
(the engine's default manifest URL is the release "latest" asset; the
per-file downloads resolve to raw.githubusercontent.com at `ref`).

Replaces the v0.4.0-era scripts/generate-patch-manifest.py (url fields,
generated_at, brain/app globs — a shape the v1.17.4 engine cannot use).
"""

import hashlib
import json
import os
import sys
from pathlib import Path

# The ONLY patchable root (must match otaWebPrefix in
# engine/internal/server/otaapi.go — drift here means skipped entries).
WEB_ROOT = "engine/internal/server/web"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_files(repo_root: Path) -> list:
    web_dir = repo_root / WEB_ROOT
    if not web_dir.is_dir():
        raise SystemExit(f"error: {web_dir} does not exist — run from the repo root")
    files = []
    for path in web_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = f"{WEB_ROOT}/{path.relative_to(web_dir).as_posix()}"
        files.append({
            "path": rel,
            "sha256": sha256_file(path),
            "size": path.stat().st_size,
        })
    # Sort by the PATH STRING (not the Path object — pathlib compares
    # parts tuple-wise, which orders icons/ before icons.js; the manifest
    # is byte-deterministic this way).
    files.sort(key=lambda f: f["path"])
    return files


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/generate-ota-manifest.py <version_tag> [output_path]", file=sys.stderr)
        sys.exit(1)
    version = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "patch-manifest.json"
    repo_root = Path(__file__).parent.parent.resolve()

    files = collect_files(repo_root)
    manifest = {
        "version": version,
        "ref": version,
        "min_engine": version,
        "files": files,
    }
    with open(output_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    total = sum(f["size"] for f in files)
    print(f"Wrote {output_path}: version={version} files={len(files)} total={total} bytes")
    # The honest size narrative: the manifest carries hashes for the whole
    # tree, but a delta only downloads what CHANGED (typically 1–50KB).
    print("(the engine downloads only the files whose sha256 differs — the whole tree never moves)")


if __name__ == "__main__":
    main()
