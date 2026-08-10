#!/data/data/com.termux/files/usr/bin/bash
# install-android-termux.sh — one-click Doomalay setup for Android (via Termux).
#
# WHAT IT DOES:
#   1. Installs Termux packages (golang, python, git, nodejs, proot-distro)
#   2. Clones the doomalay repo (lib branch) + the app branch
#   3. Sets up the Python brain venv + deps
#   4. Builds the Go engine (cross-compiles natively on Android ARM64)
#   5. Builds the PWA + embeds it into the engine
#   6. Starts the engine on localhost:8080
#   7. Opens the phone's browser to http://localhost:8080
#
# PREREQUISITES:
#   - Termux installed (from F-Droid — NOT Play Store, the Play Store version is broken)
#   - ~500MB free storage (for Go toolchain + Python deps + the build)
#
# USAGE:
#   curl -fsSL ${REPO_RAW:-https://raw.githubusercontent.com/ScoobyBaby1999/doomalay}/lib/scripts/install-android-termux.sh | bash
#
#   OR, if you've cloned the repo already:
#   cd doomalay && bash scripts/install-android-termux.sh
#
# After install, the engine runs in the foreground. To restart it later:
#   cd ~/doomalay && ./doomalay-engine
#
# To make the engine start automatically when Termux opens:
#   echo 'cd ~/doomalay && ./doomalay-engine' >> ~/.bashrc
#
# SECURITY: the engine binds to 127.0.0.1 (localhost only) by default.
# No other device on your network can access it. Your chats + API keys
# never leave your phone. See SECURITY.md for the full threat model.

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  Doomalay — Android (Termux) installer"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── 1. Install Termux packages ────────────────────────────────────────────
echo "▶ Installing packages (golang, python, git, nodejs)…"
pkg update -y >/dev/null 2>&1
pkg install -y golang python git nodejs jq >/dev/null 2>&1
echo "  ✓ packages installed"

# ── 2. Clone the repo ─────────────────────────────────────────────────────
DOOMALAY_DIR="$HOME/doomalay"
DOOMALAY_APP_DIR="$HOME/doomalay-app"

if [ ! -d "$DOOMALAY_DIR" ]; then
    echo "▶ Cloning doomalay (lib branch)…"
    git clone --branch lib --depth 1 ${REPO_URL:-https://github.com/ScoobyBaby1999/doomalay.git} "$DOOMALAY_DIR"
    echo "  ✓ cloned to $DOOMALAY_DIR"
else
    echo "  ✓ $DOOMALAY_DIR exists, pulling latest…"
    cd "$DOOMALAY_DIR" && git pull --quiet
fi

if [ ! -d "$DOOMALAY_APP_DIR" ]; then
    echo "▶ Cloning doomalay (app branch)…"
    git clone --branch app --depth 1 ${REPO_URL:-https://github.com/ScoobyBaby1999/doomalay.git} "$DOOMALAY_APP_DIR"
    echo "  ✓ cloned to $DOOMALAY_APP_DIR"
else
    echo "  ✓ $DOOMALAY_APP_DIR exists, pulling latest…"
    cd "$DOOMALAY_APP_DIR" && git pull --quiet
fi

# ── 3. Set up the Python brain ────────────────────────────────────────────
echo "▶ Setting up Python brain venv…"
cd "$DOOMALAY_DIR/brain"
if [ ! -d ".venv" ]; then
    python -m venv .venv
fi
source .venv/bin/activate
pip install --quiet -r requirements.txt
echo "  ✓ brain deps installed"

# ── 4. Build the PWA ──────────────────────────────────────────────────────
echo "▶ Building the PWA…"
cd "$DOOMALAY_APP_DIR"
npm install --silent 2>/dev/null || npm install
npm run build
echo "  ✓ PWA built"

# ── 5. Embed PWA into engine + build engine ───────────────────────────────
echo "▶ Embedding PWA + building Go engine…"
# Copy built PWA into engine's embed dir
cp -r "$DOOMALAY_APP_DIR/dist/"* "$DOOMALAY_DIR/engine/internal/server/web/"
# Build the engine (native Android ARM64 binary)
cd "$DOOMALAY_DIR/engine"
go build -o "$DOOMALAY_DIR/doomalay-engine" ./cmd/doomalay
echo "  ✓ engine built: $DOOMALAY_DIR/doomalay-engine"
ls -lh "$DOOMALAY_DIR/doomalay-engine" | awk '{print "    size:", $5}'

# ── 6. Start the engine ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Setup complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Starting the engine on http://localhost:8080 …"
echo ""
echo "  → The engine runs in this terminal. Keep Termux open."
echo "  → To open the app: tap the URL, or run 'termux-open-url http://localhost:8080'"
echo "  → To install as an app: in Chrome → ⋮ → 'Add to Home screen'"
echo "  → To stop: press Ctrl+C"
echo ""
echo "  SECURITY: bound to localhost. Your chats + keys never leave this phone."
echo ""

cd "$DOOMALAY_DIR"
./doomalay-engine --port 8080
