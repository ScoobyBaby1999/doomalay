.PHONY: dev build-pwa build-engine build-apk build-hf-space release clean

# Dev: run engine + brain + PWA dev server (3 terminals)
dev:
	@echo "Run these in 3 terminals:"
	@echo "  1. make dev-engine"
	@echo "  2. make dev-brain"
	@echo "  3. make dev-app"

dev-engine:
	cd engine && go run ./cmd/doomalay --port 8080

dev-brain:
	cd brain && .venv/bin/python server.py --port 9090

dev-app:
	cd app && npx vite

# Build the PWA from app/
build-pwa:
	cd app && npm install && npm run build
	rm -rf engine/internal/server/web/assets
	cp -r app/dist/* engine/internal/server/web/

# Build the Go engine for the current platform
build-engine: build-pwa
	cd engine && go build -o doomalay-engine ./cmd/doomalay

# Cross-compile the Go engine for Android ARM64 (pure Go, no NDK)
build-engine-android: build-pwa
	cd engine && GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build -o ../platforms/android/app/src/main/jniLibs/arm64-v8a/libdoomalayengine.so ./cmd/doomalay

# Cross-compile for all desktop platforms
build-desktop: build-pwa
	@mkdir -p bin
	cd engine && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../bin/doomalay-linux-amd64 ./cmd/doomalay
	cd engine && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o ../bin/doomalay-windows-amd64.exe ./cmd/doomalay
	cd engine && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/doomalay-macos-arm64 ./cmd/doomalay

# Build the APK (requires Android SDK + Gradle)
build-apk: build-engine-android
	cd platforms/android && ./gradlew assembleDebug

# Build the HF Space Docker image
build-hf-space:
	cd engine && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../platforms/hf-space/engine/doomalay-engine ./cmd/doomalay
	cd platforms/hf-space && docker build -t doomalay-hf-space .

# Release: tag + push (triggers all CI builds)
release:
	@read -p "Version (e.g. v0.3.0): " version; \
	git tag $$version && git push origin $$version; \
	echo "CI will build all artifacts. Check GitHub Releases."

clean:
	rm -rf bin engine/doomalay-engine app/dist app/node_modules
	rm -f platforms/android/app/src/main/jniLibs/arm64-v8a/libdoomalayengine.so
	rm -f platforms/hf-space/engine/doomalay-engine
