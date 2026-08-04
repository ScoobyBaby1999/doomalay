# Android APK

A native Android app that bundles the Go engine + Python brain (via Chaquopy)
+ PWA (via WebView). Full Strands SDK capability — same as PC/Mac.

## Structure
```
platforms/android/
├── build.gradle.kts          # root Gradle (Chaquopy plugin)
├── settings.gradle.kts
├── gradle.properties
└── app/
    ├── build.gradle.kts       # Chaquopy pip config + Python source
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/doomalay/engine/
        │   ├── MainActivity.kt       # WebView host
        │   ├── EngineService.kt      # foreground service (Go + Python)
        │   └── EngineBinary.kt       # binary path resolution
        ├── res/                      # layouts, strings, icons
        └── jniLibs/arm64-v8a/
            └── libdoomalayengine.so  # Go binary (built by CI, gitignored)
```

## Build (CI)
The GitHub Actions workflow (`.github/workflows/build-apk.yml`):
1. Builds the PWA → embeds in Go binary
2. Cross-compiles Go: `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build`
3. Copies binary to `jniLibs/arm64-v8a/libdoomalayengine.so`
4. Builds APK via Gradle: `./gradlew assembleRelease`
5. Signs + uploads to GitHub Releases

## Runtime flow
1. User opens the app → MainActivity starts EngineService
2. EngineService starts Go engine (ProcessBuilder) on :8080
3. EngineService starts Python brain (Chaquopy) on :9090
4. MainActivity polls /api/health, then loads WebView → http://localhost:8080
5. The PWA loads → user adds provider keys → chats

## Security
- Engine binds to 127.0.0.1 (localhost only)
- No network exposure without explicit user config
- Provider keys AES-256-GCM encrypted
- No telemetry, no phone-home
