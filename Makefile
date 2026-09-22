.PHONY: dev build-engine build-apk build-hf-space sync-hfzero release clean

# Dev: run the engine (serves the PWA from the embedded web/ dir)
dev:
	cd engine && go run ./cmd/doomalay --port 8080

# Sync brain/ → engine/internal/hfzero/brain/ (the embedded HF-space
# template). Run after ANY brain/ change; CI runs it before every build and
# engine/internal/hfzero/hfzero_test.go fails on drift.
sync-hfzero:
	@echo "→ syncing brain/ → engine/internal/hfzero/brain/"
	@rsync -a --delete --copy-links \
	        --exclude 'tests/' --exclude '__pycache__/' --exclude '.venv/' \
	        --exclude '.chat-ws/' --exclude '*.pyc' --exclude '.pytest_cache/' \
	        brain/ engine/internal/hfzero/brain/
	@echo "  $(shell find engine/internal/hfzero/brain -type f | wc -l) files"

# Build the Go engine for the current platform
build-engine: sync-hfzero
	cd engine && go build -o doomalay-engine ./cmd/doomalay

# Cross-compile the Go engine for Android ARM64 (pure Go, no NDK)
build-engine-android: sync-hfzero
	cd engine && GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build -o ../platforms/android/app/src/main/jniLibs/arm64-v8a/libdoomalayengine.so ./cmd/doomalay

# Cross-compile for all desktop platforms
build-desktop: sync-hfzero
	@mkdir -p bin
	cd engine && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../bin/doomalay-linux-amd64 ./cmd/doomalay
	cd engine && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o ../bin/doomalay-windows-amd64.exe ./cmd/doomalay
	cd engine && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/doomalay-macos-arm64 ./cmd/doomalay

# Build the APK (requires Android SDK + Gradle)
build-apk: build-engine-android
	cd platforms/android && ./gradlew assembleDebug

# Build the HF Space Docker image
build-hf-space: sync-hfzero
	cd engine && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../platforms/hf-space/engine/doomalay-engine ./cmd/doomalay
	cd platforms/hf-space && docker build -t doomalay-hf-space .

# Release: tag + push (triggers all CI builds)
release:
	@read -p "Version (e.g. v0.3.0): " version; \
	git tag $$version && git push origin $$version; \
	echo "CI will build all artifacts. Check GitHub Releases."

clean:
	rm -rf bin engine/doomalay-engine
	rm -f platforms/android/app/src/main/jniLibs/arm64-v8a/libdoomalayengine.so
	rm -f platforms/hf-space/engine/doomalay-engine
