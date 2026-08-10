#!/usr/bin/env python3
"""
generate-patch-manifest.py

Builds a patch-manifest.json for the OTA hot-patch system.
Run this in CI after building the APK to produce a manifest of all
patchable files (Python brain, PWA assets, configs) with their SHA256 hashes.

Usage:
    python scripts/generate-patch-manifest.py <version_tag> [output_path]

The manifest is uploaded to GitHub Releases alongside the APK.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

# Files and directories that can be hot-patched (relative to repo root)
PATCHABLE_PATHS = [
    "brain/*.py",
    "brain/**/*.py",
    "brain/**/*.json",
    "engine/internal/server/web/assets/**/*",
    "engine/internal/server/web/*.html",
    "engine/internal/server/web/*.js",
    "engine/internal/server/web/*.css",
    "app/dist/**/*",
]

# Files to exclude from patching
EXCLUDE_PATTERNS = [
    "*.pyc",
    "__pycache__",
    ".git",
    "*.so",
    "*.dll",
    "*.dylib",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def should_include(rel_path: str) -> bool:
    for pat in EXCLUDE_PATTERNS:
        if pat in rel_path:
            return False
    return True


def collect_files(repo_root: Path) -> list[dict]:
    files = []
    for pattern in PATCHABLE_PATHS:
        for path in repo_root.glob(pattern):
            if path.is_file():
                rel = path.relative_to(repo_root).as_posix()
                if not should_include(rel):
                    continue
                files.append({
                    "path": rel,
                    "sha256": sha256_file(path),
                    "url": f"https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/{rel}",
                    "size": path.stat().st_size,
                })
    # Sort for deterministic output
    files.sort(key=lambda x: x["path"])
    return files


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate-patch-manifest.py <version_tag> [output_path]")
        sys.exit(1)

    version = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "patch-manifest.json"
    repo_root = Path(__file__).parent.parent.resolve()

    manifest = {
        "version": version,
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "base_apk_version": version,
        "files": collect_files(repo_root),
    }

    with open(output_path, "w") as f:
        json.dump(manifest, f, indent=2)

    total_size = sum(f["size"] for f in manifest["files"])
    print(f"Wrote {output_path}: {len(manifest['files'])} files, {total_size} bytes total")


if __name__ == "__main__":
    main()
