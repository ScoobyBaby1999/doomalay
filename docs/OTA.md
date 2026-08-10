# OTA Hot-Patch System

Doomalay v0.4.0+ supports **over-the-air hot-patching**. Instead of downloading a
50MB APK for every bugfix, the app downloads only the files that changed
(typically 1–50KB) and applies them at runtime.

## How it works

1. **On startup**, the app checks GitHub Releases for `patch-manifest.json`.
2. It compares SHA256 hashes of local files vs. the manifest.
3. Only changed files are downloaded to `filesDir/ota/`.
4. The engine loads from `ota/` first, falling back to bundled assets.
5. A restart of the engine (not the app) applies patches.

## What can be patched

| Category | Examples | Size per patch |
|----------|----------|----------------|
| Python brain | `brain/*.py`, `server_android.py` | ~5–30KB |
| PWA assets | `app/dist/*.js`, `*.css`, `*.html` | ~10–100KB |
| Configs | `panel.json`, `models_catalog.json` | ~1–5KB |

## What CANNOT be patched

| Category | Why |
|----------|-----|
| Kotlin/Java source | Requires recompilation |
| Native binaries (.so) | Requires APK reinstall |
| Android manifest | Requires APK reinstall |
| Gradle build files | Requires APK reinstall |

## For developers

### Generate a patch manifest locally

```bash
python scripts/generate-patch-manifest.py v0.4.1 patch-manifest.json
```

### Upload to a release

```bash
gh release upload v0.4.1 patch-manifest.json
```

### Force the app to check immediately

Clear the OTA prefs in Android:
```bash
adb shell pm clear com.doomalay.engine  # wipes ALL data, use with care
```

Or programmatically:
```kotlin
OtaUpdater.clearAll(context)
```

## Troubleshooting

**"OTA: checked recently, skipping"**
→ The app checks every 5 minutes. Restart the app or clear prefs to force a check.

**"OTA: hash mismatch for X"**
→ The downloaded file is corrupt. The app deletes it and retries on next check.

**Patches not applying**
→ The engine caches modules. Kill and restart the app (swipe away from recents).
