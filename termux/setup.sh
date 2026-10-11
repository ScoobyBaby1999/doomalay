#!/data/data/com.termux/files/usr/bin/bash
# setup.sh — v1.24.1 THE TERMINAL PULSE: the Doomalay↔Termux bootstrap (run
# INSIDE Termux — fetched by curl from the repo, NOT bundled in the APK, so
# it evolves without app updates).
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
#                                     TAP "Allow all files access"; skipped
#                                     when storage is already granted)
#   3. pkg update + coreutils      (the file tools the MCP tools rely on)
#   4. the default workspace dir   (~/storage/shared/Doomalay)
#   + the checkin (v1.20.1)        (when the app passes --checkin <url>:
#                                     one curl tells Doomalay this script
#                                     finished — zero extra commands,
#                                     zero notifications)
#
# THE BAR (v1.24.1): a live 2-line ASCII progress block drawn on THIS
# terminal while the script runs — line 1 is the spinner + percent + a █/░
# bar that fills one quarter per completed step (never a fake percent),
# line 2 is the phase note or the newest package-download line (real apt
# output, trimmed). The note is HONEST about leaving:
#   · while `termux-wake-lock` is held (the script takes it at start and
#     releases it at exit) an autonomous step says:
#       ↩ it's ok to go back to the app now — setup keeps running in the
#         background
#   · the interactive storage step always says:
#       ⏳ please wait — tap "Allow" on the storage dialog
#   · with no wakelock available, autonomous steps say:
#       ⏳ please wait — keep Termux open until setup finishes
#
# WHY THREE TAPS: Termux's own security model — no script can grant these
# for you. Everything else is automatic. After this runs, return to the
# Doomalay app; the setup screen flips to ready on its own.
#
# NON-FATAL BY DESIGN: `set -u` only, NEVER `set -e` — a failed optional
# step must not kill the run; every step echoes its own outcome and the
# next step still runs.
#
# RENDER-DEMO (for rigs + human eyes, touches NOTHING):
#   DM_DEMO_SAFE=1 bash setup.sh --render-demo   # the safe-to-leave notes
#   bash setup.sh --render-demo                  # the please-wait notes
#   DM_COLS=39 bash setup.sh --render-demo       # a narrow Termux portrait

set -u

# ── args (FIRST — DM_DEMO shapes the whole render path) ──────
# --checkin <url>: the Doomalay app's loopback checkin URL (v1.20.1 THE
# QUIET GATE — the app hands it out inside the bootstrap command it
# shows). When present, the tail of this script tells the app it finished
# with ZERO extra commands. --render-demo renders the whole flow with the
# real actions stubbed (rigs + human eyes). Unknown args are ignored, never fatal —
# the same law every step below lives by.
DOOMALAY_CHECKIN_URL=""
DM_DEMO=""
while [ $# -gt 0 ]; do
    case "$1" in
        --checkin)
            if [ $# -ge 2 ]; then
                DOOMALAY_CHECKIN_URL="$2"
                shift 2
            else
                printf '%s\n' "  ⚠ --checkin needs a URL after it (ignored — non-fatal)"
                shift 1
            fi
            ;;
        --render-demo)
            DM_DEMO=1
            shift 1
            ;;
        *)
            shift 1
            ;;
    esac
done

# ── shared texts (the user's honest-leave law) ─────────────────
DM_NOTE_SAFE='↩ it'"'"'s ok to go back to the app now — setup keeps running in the background'
DM_NOTE_HOLD='⏳ please wait — keep Termux open until setup finishes'
DM_NOTE_DIALOG='⏳ please wait — tap "Allow" on the storage dialog'

# ── the bar machinery ──────────────────────────────────────────
# TTY mode: a background watcher subshell is the SINGLE writer to the
# terminal; the main thread only writes a tiny state file (atomic mv) and
# a print queue (atomic mv drain). Plain mode (piped output): the same
# __out/__phase helpers print plain lines, no escapes, no watcher.
DM_TTY=""
if [ -t 1 ] || [ -n "${DM_DEMO:-}" ]; then DM_TTY=1; fi

DM_SPIN_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧'
DM_T0="$(date +%s 2>/dev/null || echo 0)"

if [ -n "$DM_TTY" ]; then
    DM_STATEDIR="$(mktemp -d 2>/dev/null)" || DM_STATEDIR=""
    if [ -z "$DM_STATEDIR" ]; then DM_TTY=""; fi
fi
if [ -n "$DM_TTY" ]; then
    DM_STATE="$DM_STATEDIR/state"
    DM_QUEUE="$DM_STATEDIR/queue"
    DM_QTMP="$DM_STATEDIR/qtmp"
    DM_STMP="$DM_STATEDIR/stmp"
    : > "$DM_QUEUE"
    # state file lines: 1 units · 2 label · 3 note · 4 log · 5 t0 · 6 run|done
    printf '0\n\n\n\n%s\nrun\n' "$DM_T0" > "$DM_STMP" && mv -f "$DM_STMP" "$DM_STATE"
fi

# __out — a static line, either mode. In TTY mode it lands via the queue
# (the watcher owns the terminal); in plain mode it prints directly.
__out() {
    if [ -n "$DM_TTY" ]; then
        printf '%s\n' "$1" >> "$DM_QUEUE"
    else
        printf '%s\n' "$1"
    fi
}

# __dm_state — atomically rewrite the state file (a no-op when the TTY
# machinery never came up — the mktemp-failure / plain-mode path).
__dm_state() { # $1 units  $2 label  $3 note  $4 log  $5 run|done
    [ -n "${DM_STMP:-}" ] || return 0
    printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$4" "$DM_T0" "$5" \
        > "$DM_STMP" 2>/dev/null && mv -f "$DM_STMP" "$DM_STATE" 2>/dev/null
    return 0
}

# __dm_spin — the braille frame for index $1 (locale-proof: whole
# literals, never a multibyte slice).
__dm_spin() {
    case $(( $1 % 8 )) in
        0) printf '⠋';; 1) printf '⠙';; 2) printf '⠹';; 3) printf '⠸';;
        4) printf '⠼';; 5) printf '⠴';; 6) printf '⠦';; 7) printf '⠧';;
    esac
}

# __dm_rep — repeat a character $2 times (no external tools).
__dm_rep() {
    local __r="" __i=0
    while [ "$__i" -lt "$2" ]; do __r="$__r$1"; __i=$((__i+1)); done
    printf '%s' "$__r"
}

# __dm_note_for — the honest leave/stay note for a phase.
__dm_note_for() { # $1 = phase number
    if [ "$1" = "2" ]; then
        printf '%s' "$DM_NOTE_DIALOG"
    elif [ "${DM_SAFE:-0}" = "1" ]; then
        printf '%s' "$DM_NOTE_SAFE"
    else
        printf '%s' "$DM_NOTE_HOLD"
    fi
}

# __dm_cols — the terminal width, clamped. DM_COLS is the explicit
# override (the rig), then tput, then stty, then 60. Non-numeric input
# falls through to the probes (a garbage width must never reach the math).
__dm_cols() {
    local __w=""
    if [ -n "${DM_COLS:-}" ] && printf '%s' "$DM_COLS" | grep -Eq '^[0-9]+$' 2>/dev/null; then
        __w="$DM_COLS"
    else
        __w="$(tput cols 2>/dev/null || true)"
        if ! printf '%s' "$__w" | grep -Eq '^[0-9]+$' 2>/dev/null; then
            __w="$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2)"
        fi
        if ! printf '%s' "$__w" | grep -Eq '^[0-9]+$' 2>/dev/null; then
            __w=60
        fi
        if [ "$__w" -lt 20 ]; then __w=60; fi
    fi
    if [ "$__w" -gt 110 ]; then __w=110; fi
    printf '%s' "$__w"
}

# ── the watcher (TTY mode only): the single terminal writer ────
# Each frame: drain the print queue (erasing the live block first), read
# the state, redraw the 2-line block. Exits on the `done` marker.
__dm_watch() (
    local block_on=0 spin_i=0 qf
    local units label note log t0 mode W prefix suffix cells filled bar \
          el line1 line2 act line
    while :; do
        # drain the queue — statics erase the live block, print, repaint
        if [ -s "$DM_QUEUE" ]; then
            qf="$DM_QUEUE.$$"
            mv -f "$DM_QUEUE" "$qf" 2>/dev/null && {
                if [ "$block_on" = "1" ]; then
                    printf '\033[1A\r\033[K\n\033[K'
                fi
                block_on=0
                while IFS= read -r line || [ -n "$line" ]; do
                    printf '%s\n' "$line"
                done < "$qf"
                rm -f "$qf" 2>/dev/null
            }
        fi
        mode="$(sed -n 6p "$DM_STATE" 2>/dev/null)"
        if [ "$mode" = "done" ] && [ ! -s "$DM_QUEUE" ]; then
            exit 0
        fi
        units="$(sed -n 1p "$DM_STATE" 2>/dev/null)"; units="${units:-0}"
        label="$(sed -n 2p "$DM_STATE" 2>/dev/null)"
        note="$(sed -n 3p "$DM_STATE" 2>/dev/null)"
        log="$(sed -n 4p "$DM_STATE" 2>/dev/null)"
        t0="$(sed -n 5p "$DM_STATE" 2>/dev/null)"; t0="${t0:-$DM_T0}"
        W="$(__dm_cols)"
        # ── line 1: spinner + pct + adaptive bar + label (+ elapsed) ──
        # the elapsed is the least valuable glance element — it yields
        # first: it only rides when the bar still keeps ≥ 12 cells.
        spin_i=$((spin_i+1))
        pct=$((units * 25))
        prefix="$(__dm_spin "$spin_i") $pct% · ["
        suffix="] $label"
        el=$(( $(date +%s) - t0 )); [ "$el" -lt 0 ] && el=0
        cells=$(( W - ${#prefix} - ${#suffix} - ${#el} - 4 ))
        if [ "$cells" -ge 12 ]; then
            suffix="$suffix · ${el}s"
        else
            cells=$(( W - ${#prefix} - ${#suffix} - 1 ))
        fi
        [ "$cells" -lt 8 ] && cells=8
        [ "$cells" -gt 20 ] && cells=20
        filled=$(( units * cells / 4 ))
        bar="$(__dm_rep '█' "$filled")$(__dm_rep '░' $((cells - filled)))"
        line1="$prefix$bar$suffix"
        # ── line 2: the note, overridden by the newest log line ──
        line2="$note"
        if [ -n "$log" ] && [ -s "$log" ]; then
            act="$(tail -n 1 "$log" 2>/dev/null | tr -d '\r')"
            if [ -n "$act" ]; then line2="↓ $act"; fi
        fi
        line2="${line2:0:$((W-1))}"
        if [ "$block_on" = "1" ]; then
            printf '\033[1A\r\033[K%s\n\033[K%s' "$line1" "$line2"
        else
            printf '%s\n%s' "$line1" "$line2"
            block_on=1
        fi
        sleep 0.15
    done
)

# __phase_begin — announce a phase + set the live state.
__phase_begin() { # $1 n  $2 label  $3 what
    __out "▶ $1/4 · $2 — $3"
    if [ -n "$DM_TTY" ]; then
        __dm_state "$(( $1 - 1 ))" "$1/4 $2" "$(__dm_note_for "$1")" "${DM_LOG:-}" run
    fi
}

# __phase_end — the honest verdict line + the bar bump.
__phase_end() { # $1 n  $2 verdict line (the ✓/⚠ text)
    __out "  $2"
    if [ -n "$DM_TTY" ]; then
        __dm_state "$1" "$1/4 ${DM_LAST_LABEL:-}" "" "" run
    fi
}

# ── the wake lock (the safe-to-leave text is EARNED) ───────────
DM_SAFE=0
if [ -n "$DM_DEMO" ]; then
    [ "${DM_DEMO_SAFE:-0}" = "1" ] && DM_SAFE=1
elif command -v termux-wake-lock >/dev/null 2>&1; then
    if termux-wake-lock >/dev/null 2>&1; then DM_SAFE=1; fi
fi

# ── start the watcher ──────────────────────────────────────────
DM_WATCH_PID=""
if [ -n "$DM_TTY" ]; then
    __dm_watch &
    DM_WATCH_PID=$!
fi

__dm_cleanup() {
    if [ -n "$DM_WATCH_PID" ]; then
        kill "$DM_WATCH_PID" 2>/dev/null
        wait "$DM_WATCH_PID" 2>/dev/null
    fi
    if [ -n "${DM_STATEDIR:-}" ]; then
        rm -rf "$DM_STATEDIR" 2>/dev/null
    fi
    if [ "${DM_SAFE:-0}" = "1" ] && [ -z "$DM_DEMO" ]; then
        # release the lock the script took (the wiki's law: manage the
        # unlock yourself — never leak a wakelock past setup)
        command -v termux-wake-unlock >/dev/null 2>&1 \
            && termux-wake-unlock >/dev/null 2>&1
    fi
    return 0
}
trap __dm_cleanup EXIT

# ── THE RENDER DEMO — same machinery, zero real actions ───────
if [ -n "$DM_DEMO" ]; then
    __out "═══════════════════════════════════════════════════════════"
    __out "  Doomalay — Termux setup (RENDER DEMO — nothing is touched)"
    __out "═══════════════════════════════════════════════════════════"
    __out ""
    DM_LOG="$(mktemp 2>/dev/null)" || DM_LOG=""
    __phase_begin 1 "external apps" "the Doomalay command bridge needs this"
    sleep 1
    __out "  ✓ wrote allow-external-apps = true to ~/.termux/termux.properties"
    __out "  ✓ settings reloaded"
    DM_LAST_LABEL="external apps"; __phase_end 1 "✓ 1/4 external apps allowed"
    __phase_begin 2 "storage access" 'A DIALOG WILL APPEAR: tap "Allow all files access"'
    sleep 1
    __out '  ✓ storage access granted (~storage is live)'
    DM_LAST_LABEL="storage access"; __phase_end 2 "✓ 2/4 storage access granted"
    __phase_begin 3 "packages" "updating packages + installing coreutils (the file tools)…"
    __dm_state 2 "3/4 packages" "$(__dm_note_for 3)" "$DM_LOG" run
    printf 'Hit:1 https://packages-cf.termux.dev/apt/termux-main InRelease\n' >> "$DM_LOG"
    sleep 1
    printf 'Get:2 https://packages-cf.termux.dev/apt/termux-main Packages [2,345 kB]\n' >> "$DM_LOG"
    sleep 1
    printf 'Fetched 9,812 kB in 4s (2,451 kB/s)\n' >> "$DM_LOG"
    sleep 1
    __out "  ✓ coreutils is already the newest version"
    DM_LAST_LABEL="packages"; __phase_end 3 "✓ 3/4 packages ready"
    __phase_begin 4 "workspace" "the Doomalay folder on shared storage…"
    sleep 1
    __out "  ✓ workspace ready: ~/storage/shared/Doomalay"
    DM_LAST_LABEL="workspace"; __phase_end 4 "✓ 4/4 workspace ready"
    __out ""
    __out "═══════════════════════════════════════════════════════════"
    __out "  doomalay termux setup complete — return to the Doomalay app"
    __out "═══════════════════════════════════════════════════════════"
    rm -f "$DM_LOG" 2>/dev/null
    if [ -n "$DM_TTY" ]; then
        __dm_state 4 "" "" "" done
        sleep 1
    fi
    exit 0
fi

# ── the header ─────────────────────────────────────────────────
__out "═══════════════════════════════════════════════════════════"
__out "  Doomalay — Termux setup"
__out "═══════════════════════════════════════════════════════════"
__out ""

# ── 1. allow-external-apps = true ─────────────────────────────
__phase_begin 1 "external apps" "the Doomalay command bridge needs this"
mkdir -p "$HOME/.termux" 2>/dev/null \
    || __out "  ⚠ could not create ~/.termux (non-fatal — continuing)"
PROPS="$HOME/.termux/termux.properties"
if [ -f "$PROPS" ] && grep -Eq '^[[:space:]]*allow-external-apps[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$PROPS"; then
    __out "  ✓ already allowed (allow-external-apps = true is present)"
else
    printf '\nallow-external-apps = true\n' >> "$PROPS" 2>/dev/null \
        && __out "  ✓ wrote allow-external-apps = true to ~/.termux/termux.properties" \
        || __out "  ⚠ could not write ~/.termux/termux.properties (non-fatal — continuing)"
fi
if command -v termux-reload-settings >/dev/null 2>&1; then
    if termux-reload-settings >/dev/null 2>&1; then
        __out "  ✓ settings reloaded"
    else
        __out "  ⚠ termux-reload-settings failed — fully close + reopen Termux to apply the setting"
    fi
else
    __out "  ⚠ termux-reload-settings not found — fully close + reopen Termux to apply the setting"
fi
DM_LAST_LABEL="external apps"
__phase_end 1 "✓ 1/4 external apps allowed"

# ── 2. termux-setup-storage (interactive — the dialog) ────────
__phase_begin 2 "storage access" 'A DIALOG WILL APPEAR: tap "Allow all files access"'
if [ -d "$HOME/storage/shared" ]; then
    __out "  ✓ storage already granted (~/storage is live)"
    DM_LAST_LABEL="storage access"
    __phase_end 2 "✓ 2/4 storage access confirmed"
elif command -v termux-setup-storage >/dev/null 2>&1; then
    if termux-setup-storage >/dev/null 2>&1; then
        __out "  ✓ storage access granted (~storage is live)"
    else
        __out "  ⚠ storage setup did not finish (canceled or denied) — non-fatal."
        __out "    to retry later, run:  termux-setup-storage   and tap Allow"
    fi
    DM_LAST_LABEL="storage access"
    __phase_end 2 "✓ 2/4 storage access granted"
else
    __out "  ⚠ termux-setup-storage not found — storage stays off (non-fatal)"
    DM_LAST_LABEL="storage access"
    __phase_end 2 "⚠ 2/4 storage setup unavailable"
fi

# ── 3. packages: update + coreutils ───────────────────────────
__phase_begin 3 "packages" "updating packages + installing coreutils (the file tools)…"
if command -v pkg >/dev/null 2>&1; then
    if [ -n "$DM_TTY" ]; then
        DM_LOG="$(mktemp 2>/dev/null)" || DM_LOG=""
        if [ -n "$DM_LOG" ]; then
            __dm_state 2 "3/4 packages" "$(__dm_note_for 3)" "$DM_LOG" run
        fi
        pkg update -y >> "$DM_LOG" 2>&1 \
            || __out "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"
        pkg install -y coreutils >> "$DM_LOG" 2>&1 \
            || { __out "  ⚠ coreutils install failed — non-fatal; retry later with: pkg install coreutils"
                 if [ -s "$DM_LOG" ]; then
                     tail -n 3 "$DM_LOG" 2>/dev/null | while IFS= read -r l; do
                         __out "    | $l"
                     done
                 fi; }
        __dm_state 2 "3/4 packages" "$(__dm_note_for 3)" "" run
        rm -f "$DM_LOG" 2>/dev/null
        DM_LOG=""
    else
        pkg update -y \
            || __out "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"
        pkg install -y coreutils \
            || __out "  ⚠ coreutils install failed — non-fatal; retry later with: pkg install coreutils"
    fi
else
    __out "  ⚠ pkg not found — skipping package updates (non-fatal)"
fi
DM_LAST_LABEL="packages"
__phase_end 3 "✓ 3/4 packages ready"

# ── 4. the default workspace dir ──────────────────────────────
__phase_begin 4 "workspace" "the Doomalay folder on shared storage…"
if [ -d "$HOME/storage/shared" ]; then
    WS_DIR="$HOME/storage/shared/Doomalay"
    if mkdir -p "$WS_DIR" 2>/dev/null; then
        __out "  ✓ workspace ready: $WS_DIR"
        DM_LAST_LABEL="workspace"
        __phase_end 4 "✓ 4/4 workspace ready"
    else
        __out "  ⚠ could not create $WS_DIR (non-fatal — create it later if the app asks)"
        DM_LAST_LABEL="workspace"
        __phase_end 4 "⚠ 4/4 workspace dir failed"
    fi
else
    __out "  ⚠ ~/storage/shared is not live yet — skipping the workspace dir (non-fatal;"
    __out "    rerun this setup after granting storage access)"
    DM_LAST_LABEL="workspace"
    __phase_end 4 "⚠ 4/4 workspace skipped (no storage)"
fi

# ── done ──────────────────────────────────────────────────────
__out ""
__out "═══════════════════════════════════════════════════════════"
__out "  doomalay termux setup complete — return to the Doomalay app"
__out "═══════════════════════════════════════════════════════════"

# ── the checkin (v1.20.1 THE QUIET GATE) ──────────────────────
# Tell the Doomalay app the bootstrap ran, with this script's OWN honest
# step outcomes as the two flags. Non-fatal by the same law as everything
# above: a failed curl changes nothing — the setup still worked, the app
# simply keeps watching the old way.
if [ -n "$DOOMALAY_CHECKIN_URL" ]; then
    __storage_flag=0; [ -d "$HOME/storage/shared" ] && __storage_flag=1
    __props_flag=0; grep -q "^allow-external-apps" "$HOME/.termux/termux.properties" 2>/dev/null && __props_flag=1
    if curl -fsS --max-time 6 "${DOOMALAY_CHECKIN_URL}?storage=${__storage_flag}&props=${__props_flag}" >/dev/null 2>&1; then
        __out "doomalay app notified — setup state is live"
    else
        __out "(could not notify the doomalay app — the setup still worked; return to the app)"
    fi
fi

# ── the handoff to the watcher's final frame ──────────────────
if [ -n "$DM_TTY" ]; then
    __dm_state 4 "" "" "" done
    # give the watcher one frame to drain the queue + print, then the
    # EXIT trap reaps it (the wait makes the handoff deterministic)
    wait "$DM_WATCH_PID" 2>/dev/null
fi
