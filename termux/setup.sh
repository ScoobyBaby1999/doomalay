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
#   5. the checkin (v1.20.1)        (when the app passes --checkin <url>:
#                                     one curl tells Doomalay this script
#                                     finished — zero extra commands,
#                                     zero notifications)
#
# WHY THREE TAPS: Termux's own security model — no script can grant these
# for you. Everything else is automatic. After this runs, return to the
# Doomalay app; the setup screen flips to ready on its own.
#
# NON-FATAL BY DESIGN: `set -u` only, NEVER `set -e` — a failed optional
# step must not kill the run; every step echoes its own outcome and the
# next step still runs.

set -u

# ── args ───────────────────────────────────────────────────────
# --checkin <url>: the Doomalay app's loopback checkin URL (v1.20.1 THE
# QUIET GATE — the app hands it out inside the bootstrap command it
# shows). When present, step 5 below tells the app this script finished
# with ZERO extra commands. Unknown args are ignored, never fatal (the
# same law every step below lives by).
DOOMALAY_CHECKIN_URL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --checkin)
            if [ $# -ge 2 ]; then
                DOOMALAY_CHECKIN_URL="$2"
                shift 2
            else
                echo "  ⚠ --checkin needs a URL after it (ignored — non-fatal)"
                shift 1
            fi
            ;;
        *)
            shift 1
            ;;
    esac
done

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

# ── 5. the checkin (v1.20.1 THE QUIET GATE) ──────────────────────────
# Tell the Doomalay app the bootstrap ran, with this script's OWN honest
# step outcomes as the two flags. Non-fatal by the same law as everything
# above: a failed curl changes nothing — the setup still worked, the app
# simply keeps watching the old way.
if [ -n "$DOOMALAY_CHECKIN_URL" ]; then
    __storage_flag=0; [ -d "$HOME/storage/shared" ] && __storage_flag=1
    __props_flag=0; grep -q "^allow-external-apps" "$HOME/.termux/termux.properties" 2>/dev/null && __props_flag=1
    if curl -fsS --max-time 6 "${DOOMALAY_CHECKIN_URL}?storage=${__storage_flag}&props=${__props_flag}" >/dev/null 2>&1; then
        echo "doomalay app notified — setup state is live"
    else
        echo "(could not notify the doomalay app — the setup still worked; return to the app)"
    fi
fi
