.PHONY: dev build-engine build-app build release clean

BRAIN_VENV ?= brain/.venv
ENGINE_BIN ?= doomalay-engine

# Dev: run engine + brain + PWA together (3 terminals or tmux)
dev:
	@echo "Run these in 3 terminals:"
	@echo "  1. make dev-engine"
	@echo "  2. make dev-brain"
	@echo "  3. make dev-app"

dev-engine:
	cd engine && go run ./cmd/doomalay --port 8080

dev-brain:
	cd brain && $$(.venv)/bin/python server.py --port 9090

dev-app:
	cd app && npx vite

# Build the PWA from the app/ branch + embed into the engine + build the engine binary.
# Requires: the app/ branch checked out in a sibling dir (or ./app symlink).
build-app:
	@if [ -d "../doomalay-app" ]; then cd ../doomalay-app && npm run build; \
	elif [ -d "./app" ]; then cd app && npm run build; \
	else echo "Error: app/ branch not found. Clone it: git clone --branch app <repo> ../doomalay-app"; exit 1; fi
	@# Copy built PWA into engine's embed dir
	@if [ -d "../doomalay-app/dist" ]; then cp -r ../doomalay-app/dist/* engine/internal/server/web/; \
	elif [ -d "./app/dist" ]; then cp -r app/dist/* engine/internal/server/web/; fi
	@echo "PWA built + copied to engine/internal/server/web/"

build-engine:
	cd engine && go build -o $(ENGINE_BIN) ./cmd/doomalay

build: build-app build-engine
	@echo "✓ Built $(ENGINE_BIN) with embedded PWA"

# Cross-compile for all platforms (for releases)
release: build-app
	@mkdir -p bin
	@for target in \
		"linux/amd64 doomalay-engine-linux-amd64" \
		"linux/arm64 doomalay-engine-linux-arm64" \
		"darwin/amd64 doomalay-engine-mac-intel" \
		"darwin/arm64 doomalay-engine-mac-arm64" \
		"windows/amd64 doomalay-engine.exe"; do \
		set -- $$target; \
		echo "Building $$2..."; \
		GOOS=$${1%/*} GOARCH=$${1#*/} cd engine && go build -o ../bin/$$2 ./cmd/doomalay && cd ..; \
	done
	@echo "✓ All binaries in bin/"

clean:
	rm -rf bin $(ENGINE_BIN) engine/internal/server/web/assets
