#!/data/data/com.termux/files/usr/bin/bash
# setup.sh — v1.17.3 THE SETUP: the Doomalay↔Termux bootstrap (run INSIDE
# Termux — fetched by curl from the repo, NOT bundled in the APK, so it
# evolves without app updates).
#
# THE ONE-LINER (paste in Termux, press enter):
#   curl -fsSL https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/termux/setup.sh | bash
#
# (same file on GitHub if you'd rather read it first:
#    https://github.com/ScoobyBaby1999/doomalay/blob/main/termux/setup.sh )
#
# WHAT IT DOES (each step reports its own honest outcome):
#   1. allow-external-apps = true   (~/.termux/termux.properties + reload
#                                     — lets the Doomalay app send commands)
#   2. termux-setup-storage         (opens the All-Files-Access dialog —
#                                     TAP "Allow all files access")
#   3. pkg update + coreutils      (the file tools the next wave's MCP
#                                     tools rely on)
#   4. the default workspace dir   (~/storage/shared/Doomalay)
#
# WHY THREE TAPS: Termux's own security model — no script can grant these
# for you. Everything else is automatic. After this runs, return to the
# Doomalay app; the setup screen flips to ready on its own.
#
# NON-FATAL BY DESIGN: `set -u` only, NEVER `set -e` — a failed optional
# step must not kill the run; every step echoes its own outcome and the
# next step still runs.

set -u

echo "═══════════════════════════════════════════════════════════"
echo "  Doomalay — Termux setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── 1. allow-external-apps = true ─────────────────────────────────────
echo "▶ 1/4 · allowing external apps (the Doomalay command bridge needs this)…"
mkdir -p "$HOME/.termux" 2>/dev/null || echo "  ⚠ could not create ~/.termux (non-fatal — continuing)"
PROPS="$HOME/.termux/termux.properties"
if [ -f "$PROPS" ] && grep -Eq '^[[:space:]]*allow-external-apps[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$PROPS"; then
    echo "  ✓ already allowed (allow-external-apps = true is present)"
else
    printf '\nallow-external-apps = true\n' >> "$PROPS" 2>/dev/null \
        && echo "  ✓ wrote allow-external-apps = true to ~/.termux/termux.properties" \
        || echo "  ⚠ could not write ~/.termux/termux.properties (non-fatal — continuing)"
fi
if command -v termux-reload-settings >/dev/null 2>&1; then
    if termux-reload-settings; then
        echo "  ✓ settings reloaded"
    else
        echo "  ⚠ termux-reload-settings failed — fully close + reopen Termux to apply the setting"
    fi
else
    echo "  ⚠ termux-reload-settings not found — fully close + reopen Termux to apply the setting"
fi

# ── 2. termux-setup-storage (interactive) ─────────────────────────────
echo ""
echo "▶ 2/4 · storage access — A DIALOG WILL APPEAR: tap \"Allow all files access\""
echo "        (if you cancel it, nothing breaks — rerun this command later)"
if command -v termux-setup-storage >/dev/null 2>&1; then
    if termux-setup-storage; then
        echo "  ✓ storage access granted (~storage is live)"
    else
        echo "  ⚠ storage setup did not finish (canceled or denied) — non-fatal."
        echo "    to retry later, run:  termux-setup-storage   and tap Allow"
    fi
else
    echo "  ⚠ termux-setup-storage not found — storage stays off (non-fatal)"
fi

# ── 3. packages: update + coreutils ───────────────────────────────────
echo ""
echo "▶ 3/4 · updating packages + installing coreutils (the file tools)…"
if command -v pkg >/dev/null 2>&1; then
    pkg update -y \
        || echo "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"
    pkg install -y coreutils \
        || echo "  ⚠ coreutils install failed — non-fatal; retry later with: pkg install coreutils"
else
    echo "  ⚠ pkg not found — skipping package updates (non-fatal)"
fi

# ── 4. the default workspace dir ──────────────────────────────────────
echo ""
echo "▶ 4/4 · the default workspace dir…"
if [ -d "$HOME/storage/shared" ]; then
    WS_DIR="$HOME/storage/shared/Doomalay"
    if mkdir -p "$WS_DIR" 2>/dev/null; then
        echo "  ✓ workspace ready: $WS_DIR"
    else
        echo "  ⚠ could not create $WS_DIR (non-fatal — create it later if the app asks)"
    fi
else
    echo "  ⚠ ~/storage/shared is not live yet — skipping the workspace dir (non-fatal;"
    echo "    rerun this setup after granting storage access)"
fi

# ── done ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  doomalay termux setup complete — return to the Doomalay app"
echo "═══════════════════════════════════════════════════════════"
