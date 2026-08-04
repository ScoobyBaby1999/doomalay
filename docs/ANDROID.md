# Android — Testing Doomalay on your phone

There are **three ways** to test on Android. Pick the one that fits you.

## Option 1: Termux (full self-hosted, $0, runs on the phone) — RECOMMENDED

The Go engine cross-compiles to Android ARM64 natively. You run it in
[Termux](https://termux.dev) (a Linux terminal for Android). The PWA opens
in Chrome, you "Add to Home Screen" for an app icon.

### One-click install

1. Install **Termux** from **F-Droid** (NOT the Play Store — the Play Store
   version is broken/deprecated). Get it from https://f-droid.org/packages/com.termux/

2. Open Termux, paste this one-liner:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/lib/scripts/install-android-termux.sh | bash
   ```

3. Wait ~5 minutes (it installs Go, Python, clones the repo, builds everything).

4. The engine starts on `http://localhost:8080`. Termux auto-opens Chrome.

5. In Chrome: **⋮ → "Add to Home screen"**. Now you have a Doomalay app icon.

6. To start the engine again later (it stops when you close Termux):
   ```bash
   cd ~/doomalay && ./doomalay-engine
   ```

### Auto-start on boot (optional)

Install [Termux:Boot](https://wiki.termux.com/wiki/Termux:Boot) from F-Droid.
Create `~/.termux/boot/doomalay.sh`:
```bash
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/doomalay && ./doomalay-engine
```
Now the engine starts automatically when your phone boots.

### Keep the engine alive (prevent Android killing it)

Termux foreground service: run `termux-wake-lock` once to prevent doze.
The notification "Termux is running" must stay visible. If Android kills
it, the engine restarts on next Termux open.

## Option 2: Connect to a remote engine (PC or cloud)

If you don't want to run the engine on your phone, run it on your PC/Mac
and connect the phone's PWA to it over your local network.

1. On your PC: clone + build the engine (see the main README).
2. In `~/.config/doomalay/config.yaml`, set:
   ```yaml
   bind: 0.0.0.0
   auth_token: "<a-random-string>"
   allowed_origins:
     - "http://<your-phone's-origin>"
   ```
3. Start the engine: `./doomalay-engine`
4. Find your PC's LAN IP: `ip addr | grep inet` (look for `192.168.x.x`)
5. On your phone, open Chrome → `http://192.168.x.x:8080`
6. Enter the `auth_token` when the PWA asks for it.
7. Add to Home Screen.

**Note**: this is HTTP (not HTTPS) on your LAN. The token transits in
plaintext over your WiFi. This is acceptable on a trusted home network.
For public WiFi, use a VPN or Tailscale.

## Option 3: HF Demo (zero install) — COMING IN PHASE 3

Phase 3 will deploy the engine to Hugging Face Spaces. You'll be able to
open `https://scoobybaby1999-doomalay.hf.space` on your phone, tap "Try
Demo", and chat with zero install. The HF Demo is a capable bubblewrap
sandbox (canBuild, canShell) — limited only by HF's free tier (no KVM,
no GPU, ~16GB RAM, 48h sleep).

For now (Phase 1), use Option 1 or 2.

## Why no APK yet?

A real "download APK and launch" experience (where the APK bundles the Go
engine inside, runs as a foreground service, no Termux needed) requires:
- `gomobile` to build a Go → Android AAR library
- Android NDK + a native Android app shell (Kotlin/Java)
- A foreground service to keep the engine alive
- JNI bridge between the Android UI and the Go engine

This is a Phase 2+ deliverable (multi-day effort). For Phase 1, the
Termux + PWA path gives you the full experience today — it's just 2 taps
to install (Termux + the one-liner) instead of 1 tap (APK).

The PWA itself IS installable as an app icon (Add to Home Screen) — so
after the initial Termux setup, launching Doomalay is one tap on the icon,
just like a native app.

## Security on Android

- The engine binds to `127.0.0.1` by default — no other device on your
  network can access it. Your chats + keys never leave your phone.
- Provider keys are AES-256-GCM encrypted at `~/.local/share/doomalay/secrets.json`
  (mode 0600 — only your Termux user can read them).
- The brain (Python subprocess) is localhost-only.
- No telemetry, no phone-home, no analytics.
- See `docs/SECURITY.md` for the full threat model.
