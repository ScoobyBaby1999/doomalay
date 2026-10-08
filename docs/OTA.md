# The Live Update (delta OTA)

**v1.17.4+** — download only what changed, never the whole APK. The engine
checks a release manifest, diffs it against the live web tree it is
actually serving, downloads just the changed bytes (sha256-verified, atomic),
and serves them through an ota-first overlay — **web-asset patches go live
without an engine restart**; the PWA reloads and picks them up.

## How it works

1. **Engine side** (pure stdlib, `engine/internal/ota` + `server/otaapi.go`):
   on boot + every 5 minutes (and on demand) the engine fetches
   `patch-manifest.json` from the newest GitHub release, computes the
   sha256 diff against the live stack, and caches the result.
2. **The live stack** for a manifest path under `engine/internal/server/web/`
   is: the file at `<data-dir>/ota/<web-relative-path>` if present, **else**
   the embedded `web/` asset baked into the engine binary. The plan can
   never disagree with what the browser is being served.
3. **Download**: every changed file streams into `<data-dir>/ota/<rel>.tmp`
   while the sha256 runs over the same stream, then atomically renames.
   Any failure (hash mismatch, size cap, dropped connection) deletes the
   `.tmp` — a corrupt file is gone, and the error says why.
4. **Apply**: the static handler that serves the embedded PWA checks
   `<data-dir>/ota/<web-relative-path>` FIRST — a patched file wins over
   the embedded bytes. No engine restart, no APK reinstall.

## The endpoints

| Endpoint | What it does |
|----------|--------------|
| `GET /api/ota/status` | The cached manifest + live-computed plan. |
| `POST /api/ota/check` | Force a manifest refetch, then the same shape. |
| `POST /api/ota/download` | Execute the plan (refetch + download all changed). |

`/api/ota/status` shape (the PWA's `ota.js` consumes this):

```json
{
  "enabled": true,
  "state": "current",
  "current_version": "1.17.4",
  "manifest": {
    "version": "v1.17.4", "ref": "v1.17.4", "min_engine": "v1.17.4",
    "files": 141, "changed": 2, "changed_bytes": 14321, "skipped": 0
  },
  "checked_at": 1712345678,
  "last_error": ""
}
```

**The state ladder** (every problem is a state, never a silent failure):

| State | Meaning |
|-------|---------|
| `disabled` | `DOOMALAY_OTA_DISABLE=1` (or no URL) — zero network. |
| `unreachable` | The manifest fetch failed — `last_error` says why. HTTP 200. |
| `engine_update_required` | `manifest.min_engine` > the running engine version — the delta is refused; install the full APK. |
| `update_available` | The plan has changed files (per-file cap 10 MB, whole-plan cap 20 MB). |
| `current` | Everything matches the live stack. |

## The manifest

Default URL (config: `ota_url` / env `DOOMALAY_OTA_URL`):

```
https://github.com/ScoobyBaby1999/doomalay/releases/latest/download/patch-manifest.json
```

Per-file downloads resolve to the raw tree at the manifest's `ref`:

```
https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/<ref>/<path>
```

Generated in CI (`.github/workflows/build-apk.yml`) after the APK build:

```bash
python3 scripts/generate-ota-manifest.py "$GITHUB_REF_NAME" patch-manifest.json
```

```json
{
  "version": "v1.17.4", "ref": "v1.17.4", "min_engine": "v1.17.4",
  "files": [
    {"path": "engine/internal/server/web/ota.js", "sha256": "…64 hex…", "size": 4321}
  ]
}
```

Paths are repo-root-relative and **only `engine/internal/server/web/` is
patchable** — anything else in a manifest is skipped and counted in
`manifest.skipped` (a hostile manifest cannot write outside the tree, and
`..`/`//`-shaped paths never resolve to a disk file).

## What can / cannot be patched

| Category | Patchable? | Why |
|----------|-----------|-----|
| PWA assets (`engine/internal/server/web/*`) | ✅ live, no restart | Served through the ota-first overlay. |
| The engine binary (`libdoomalayengine.so`) | ❌ never | The `min_engine` gate refuses the delta — the only path is the full APK (honest `engine_update_required` state). |
| `web/vendor/pm/privatemode.wasm` | ⚠️ effectively no | A dedicated route serves the embedded gzipped bytes (transparent gzip decoding); a patched wasm needs the APK. |
| Kotlin/Java, AndroidManifest, gradle | ❌ | Requires recompilation / APK reinstall. |

## The PWA side

`web/ota.js` polls `/api/ota/status` on boot + every 5 minutes and renders
one small themed banner: `update_available` → "Update available · N files ·
~KB" with an **Update** action (busy state, then "applied — reload" and an
automatic reload after 800 ms); `engine_update_required` → "full app update
needed" with the releases link. Dismiss (✕) hides it for the session
(sessionStorage); the persistent opt-out is the localStorage flag
`doomalay-ota-optout`. When the state returns to `current`, the banner
clears — one banner at a time, never spam.

## Operators

```bash
# Pin a mirror / stub (tests, offline networks):
DOOMALAY_OTA_URL=http://mirror.example.com/patch-manifest.json

# Kill switch — zero network, /api/ota/status answers state "disabled":
DOOMALAY_OTA_DISABLE=1
```

The v0.4.0-era Kotlin `OtaUpdater` + `scripts/generate-patch-manifest.py`
(url-per-entry, brain/app globs) were retired — this file is the v1.17.4
reality.
