#!/data/data/com.termux/files/usr/bin/bash
# setup.sh — v1.24.1 THE TERMINAL PULSE: the Doomalay↔Termux bootstrap (run
# INSIDE Termux — fetched by curl from the repo, NOT bundled in the APK, so
# it evolves without app updates).
# v1.35.1 THE PENDING LEDGER (PLAN-V136 THE FINISHER WAVE): an offline run no
# longer dead-ends — the failed package steps land in $HOME/.doomalay-setup/
# state (the ledger) + resume.sh (the finisher), and the Doomalay engine
# completes them automatically when the device is back online. THE LAW: a
# setup that RAN is a setup that FINISHES.
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
#   + THE EVERALIVE (v1.74.9, PLAN-V175): the persistent wake lock (Termux
#                                     survives screen-off + the OEM idle
#                                     passes), the ~/.termux/boot/ script
#                                     (Termux re-arms itself at every boot
#                                     when the Termux:Boot add-on is in),
#                                     and the ~/.doomalay/alive heartbeat
#                                     (the engine's diagnostic trail).
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

# ── THE PENDING LEDGER (v1.35.1 THE FINISHER WAVE) ────────────
# $HOME/.doomalay-setup/state — one key=value line per step, the honest
# record of what THIS run completed. The Doomalay engine reads it through
# the bridge and finishes the pending steps itself when the device is back
# online (PLAN-V136): the user never re-runs, remembers, or babysits.
# THE LAWS: (1) only the REAL run writes it (the render demo touches
# nothing — DM_LEDGER_LIVE stays empty there); (2) every write is atomic
# (the tmp+mv idiom this script already lives by); (3) a write failure is
# non-fatal — the ledger is a gift to the recovery, never a dependency.
DM_LEDGER_DIR="$HOME/.doomalay-setup"
DM_LEDGER="$DM_LEDGER_DIR/state"
DM_PKGS_STATE=""      # ok | pending
DM_STORAGE_STATE=""   # granted | missing
DM_WS_STATE=""        # ok | skipped
DM_LEDGER_LIVE=""

__ledger_write() {
    [ "$DM_LEDGER_LIVE" = "1" ] || return 0
    mkdir -p "$DM_LEDGER_DIR" 2>/dev/null || return 0
    {
        [ -n "$DM_PKGS_STATE" ]     && printf 'pkgs=%s\n' "$DM_PKGS_STATE"
        [ -n "$DM_STORAGE_STATE" ]  && printf 'storage=%s\n' "$DM_STORAGE_STATE"
        [ -n "$DM_WS_STATE" ]       && printf 'workspace=%s\n' "$DM_WS_STATE"
        true
    } > "${DM_LEDGER}.tmp" 2>/dev/null \
        && mv -f "${DM_LEDGER}.tmp" "$DM_LEDGER" 2>/dev/null
    return 0
}

# __write_resume — the recovery method itself (v1.35.1): a self-contained
# idempotent finisher the Doomalay engine fires through the bridge (and the
# user can run by hand). Offline it is a SECONDS-LONG no-op (the probe is
# the one pkg itself uses — bounded curl, no `timeout` dependency); online
# it completes exactly what the ledger says is missing, rewrites the
# ledger, and re-checkins with the third honest flag. Written ONLY when
# something is actually pending. The baked checkin URL rides its own file
# (never shell-injected into the heredoc); the engine always passes a
# fresh --checkin, which wins.
__write_resume() {
    mkdir -p "$DM_LEDGER_DIR" 2>/dev/null || return 0
    cat > "${DM_LEDGER_DIR}/resume.sh" <<'RESUME_EOF'
#!/data/data/com.termux/files/usr/bin/bash
# resume.sh — v1.35.1 THE FINISHER (PLAN-V136): completes what an offline
# setup left pending, then rewrites the ledger + re-checkins. Written by
# setup.sh; run by the Doomalay engine (via the bridge) or by hand:
#   bash ~/.doomalay-setup/resume.sh
# Offline → exits 0 in seconds with NOTHING touched (the ledger stands;
# the next attempt rides whenever the caller chooses). Online → the
# pending steps run, the ledger flips, the app hears the bell.
set -u
DM_DIR="$HOME/.doomalay-setup"
DM_LEDGER="$DM_DIR/state"
DM_CHECKIN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --checkin)
            if [ $# -ge 2 ]; then DM_CHECKIN="$2"; shift 2; else shift 1; fi
            ;;
        *) shift 1 ;;
    esac
done
[ -n "$DM_CHECKIN" ] || DM_CHECKIN="$(cat "$DM_DIR/checkin" 2>/dev/null || true)"

# ── the reachability probe (pkg's own idiom, self-bounded) ────
DM_MIRROR="https://packages-cf.termux.dev/apt/termux-main/dists/stable/Release"
DM_MIRROR2="https://packages.termux.dev/apt/termux-main/dists/stable/Release"
__online() {
    command -v curl >/dev/null 2>&1 || return 1
    curl --head --fail --max-time 6 --connect-timeout 5 "$DM_MIRROR" >/dev/null 2>&1 \
        && return 0
    curl --head --fail --max-time 6 --connect-timeout 5 "$DM_MIRROR2" >/dev/null 2>&1
}
__online || exit 0

# ── the pending steps (only what the ledger says is missing) ──
DM_OK=1
command -v pkg >/dev/null 2>&1 || DM_OK=0
if [ "$DM_OK" = "1" ]; then
    pkg update -y >/dev/null 2>&1 || DM_OK=0
    pkg install -y coreutils >/dev/null 2>&1 || DM_OK=0
fi

# ── the workspace step (auto-completable once storage is live) ──
DM_WS="ok"
if [ -d "$HOME/storage/shared" ]; then
    mkdir -p "$HOME/storage/shared/Doomalay" 2>/dev/null || DM_WS="skipped"
else
    DM_WS="skipped"
fi

# ── the ledger rewrite (the truth the engine reads) ───────────
mkdir -p "$DM_DIR" 2>/dev/null
if [ "$DM_OK" = "1" ]; then DM_PKGS_OUT="ok"; else DM_PKGS_OUT="pending"; fi
if [ -d "$HOME/storage/shared" ]; then DM_ST_OUT="granted"; else DM_ST_OUT="missing"; fi
{
    printf 'pkgs=%s\n' "$DM_PKGS_OUT"
    printf 'storage=%s\n' "$DM_ST_OUT"
    printf 'workspace=%s\n' "$DM_WS"
    true
} > "${DM_LEDGER}.tmp" 2>/dev/null \
    && mv -f "${DM_LEDGER}.tmp" "$DM_LEDGER" 2>/dev/null

# ── the bell (non-fatal — the ledger is the truth, this is the sound) ──
if [ -n "$DM_CHECKIN" ]; then
    if [ "$DM_OK" = "1" ]; then DM_PK=1; else DM_PK=0; fi
    curl -fsS --max-time 6 "${DM_CHECKIN}?resume=1&pkgs=${DM_PK}" >/dev/null 2>&1 || true
fi
exit 0
RESUME_EOF
    chmod +x "${DM_LEDGER_DIR}/resume.sh" 2>/dev/null
    if [ -n "${DOOMALAY_CHECKIN_URL:-}" ]; then
        printf '%s\n' "$DOOMALAY_CHECKIN_URL" > "${DM_LEDGER_DIR}/checkin" 2>/dev/null
    fi
    return 0
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
    if [ "${DM_SAFE:-0}" = "1" ] && [ -z "$DM_DEMO" ] && [ "${DM_KEEPALIVE_ARMED:-0}" != "1" ]; then
        # release the lock the script took (the wiki's law: manage the
        # unlock yourself — never leak a wakelock past setup). v1.74.9
        # THE EVERALIVE: when the persistent keep-alive lock was ARMED at
        # the end of setup, the lock is not a leak — it is the product
        # (Termux survives screen-off; termux-wake-unlock is the off-switch).
        command -v termux-wake-unlock >/dev/null 2>&1 \
            && termux-wake-unlock >/dev/null 2>&1
    fi
    return 0
}
trap __dm_cleanup EXIT

# ── the real run begins — the ledger goes live. The demo below NEVER
# calls __ledger_write (only the real phases do), so the render-demo keeps
# touching nothing; the flag simply arms the real run's writes. ──
DM_LEDGER_LIVE=1
__pkg_fail=0

# ── THE RENDER DEMO — same machinery, zero real actions ───────
# v1.35.1: DM_DEMO_PENDING=1 renders the OFFLINE shape (the packages step
# fails honestly + the pending banner + the finisher teaching) — the rig's
# window into both outcomes. The default demo stays byte-identical.
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
    if [ -n "${DM_DEMO_PENDING:-}" ]; then
        # the OFFLINE shape — the honest failure the finisher wave recovers
        printf 'Err:1 https://packages-cf.termux.dev/apt/termux-main InRelease\n' >> "$DM_LOG"
        sleep 1
        printf "Temporary failure resolving 'packages-cf.termux.dev'\n" >> "$DM_LOG"
        sleep 1
        __out "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"
        __out "  ⚠ coreutils install failed — the step waits in the ledger"
        DM_LAST_LABEL="packages"; __phase_end 3 "⚠ 3/4 packages pending (no network) — the app finishes this automatically"
    else
        printf 'Hit:1 https://packages-cf.termux.dev/apt/termux-main InRelease\n' >> "$DM_LOG"
        sleep 1
        printf 'Get:2 https://packages-cf.termux.dev/apt/termux-main Packages [2,345 kB]\n' >> "$DM_LOG"
        sleep 1
        printf 'Fetched 9,812 kB in 4s (2,451 kB/s)\n' >> "$DM_LOG"
        sleep 1
        __out "  ✓ coreutils is already the newest version"
        DM_LAST_LABEL="packages"; __phase_end 3 "✓ 3/4 packages ready"
    fi
    __phase_begin 4 "workspace" "the Doomalay folder on shared storage…"
    sleep 1
    __out "  ✓ workspace ready: ~/storage/shared/Doomalay"
    DM_LAST_LABEL="workspace"; __phase_end 4 "✓ 4/4 workspace ready"
    __out ""
    __out "═══════════════════════════════════════════════════════════"
    if [ -n "${DM_DEMO_PENDING:-}" ]; then
        __out "  doomalay termux setup complete — 1 step pending: packages"
        __out "  no network right now — the Doomalay app finishes this automatically"
        __out "  when you're back online (or run: bash ~/.doomalay-setup/resume.sh)"
    else
        __out "  doomalay termux setup complete — return to the Doomalay app"
    fi
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
    DM_STORAGE_STATE="granted"
    DM_LAST_LABEL="storage access"
    __phase_end 2 "✓ 2/4 storage access confirmed"
elif command -v termux-setup-storage >/dev/null 2>&1; then
    if termux-setup-storage >/dev/null 2>&1; then
        __out "  ✓ storage access granted (~storage is live)"
    else
        __out "  ⚠ storage setup did not finish (canceled or denied) — non-fatal."
        __out "    to retry later, run:  termux-setup-storage   and tap Allow"
    fi
    # the ledger records the TRUTH either way (the dialog is interactive —
    # the finisher NEVER re-fires it; the ledger just says where things stand)
    if [ -d "$HOME/storage/shared" ]; then
        DM_STORAGE_STATE="granted"
    else
        DM_STORAGE_STATE="missing"
    fi
    DM_LAST_LABEL="storage access"
    __phase_end 2 "✓ 2/4 storage access granted"
else
    __out "  ⚠ termux-setup-storage not found — storage stays off (non-fatal)"
    DM_STORAGE_STATE="missing"
    DM_LAST_LABEL="storage access"
    __phase_end 2 "⚠ 2/4 storage setup unavailable"
fi
__ledger_write

# ── 3. packages: update + coreutils ───────────────────────────
# v1.35.1: a failure here is no longer a dead end — it lands in the ledger
# (pkgs=pending) + resume.sh is written, and the Doomalay engine finishes
# the step on its own when the device is back online (PLAN-V136).
__phase_begin 3 "packages" "updating packages + installing coreutils (the file tools)…"
if command -v pkg >/dev/null 2>&1; then
    if [ -n "$DM_TTY" ]; then
        DM_LOG="$(mktemp 2>/dev/null)" || DM_LOG=""
        if [ -n "$DM_LOG" ]; then
            __dm_state 2 "3/4 packages" "$(__dm_note_for 3)" "$DM_LOG" run
        fi
        pkg update -y >> "$DM_LOG" 2>&1 \
            || { __pkg_fail=1; __out "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"; }
        pkg install -y coreutils >> "$DM_LOG" 2>&1 \
            || { __pkg_fail=1; __out "  ⚠ coreutils install failed — non-fatal; the finisher retries it"
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
            || { __pkg_fail=1; __out "  ⚠ pkg update failed (network?) — non-fatal, continuing anyway"; }
        pkg install -y coreutils \
            || { __pkg_fail=1; __out "  ⚠ coreutils install failed — non-fatal; the finisher retries it"; }
    fi
else
    __out "  ⚠ pkg not found — skipping package updates (non-fatal)"
    __pkg_fail=1
fi
DM_LAST_LABEL="packages"
if [ "$__pkg_fail" = "1" ]; then
    DM_PKGS_STATE="pending"
    __ledger_write
    __write_resume
    __phase_end 3 "⚠ 3/4 packages pending (no network?) — the app finishes this automatically"
else
    DM_PKGS_STATE="ok"
    __ledger_write
    __phase_end 3 "✓ 3/4 packages ready"
fi

# ── 4. the default workspace dir ──────────────────────────────
__phase_begin 4 "workspace" "the Doomalay folder on shared storage…"
if [ -d "$HOME/storage/shared" ]; then
    WS_DIR="$HOME/storage/shared/Doomalay"
    if mkdir -p "$WS_DIR" 2>/dev/null; then
        __out "  ✓ workspace ready: $WS_DIR"
        DM_WS_STATE="ok"
        DM_LAST_LABEL="workspace"
        __phase_end 4 "✓ 4/4 workspace ready"
    else
        __out "  ⚠ could not create $WS_DIR (non-fatal — create it later if the app asks)"
        DM_WS_STATE="skipped"
        DM_LAST_LABEL="workspace"
        __phase_end 4 "⚠ 4/4 workspace dir failed"
    fi
else
    __out "  ⚠ ~/storage/shared is not live yet — skipping the workspace dir (non-fatal;"
    __out "    rerun this setup after granting storage access)"
    DM_WS_STATE="skipped"
    DM_LAST_LABEL="workspace"
    __phase_end 4 "⚠ 4/4 workspace skipped (no storage)"
fi
__ledger_write

# ── done ──────────────────────────────────────────────────────
# v1.35.1: the banner speaks the ledger's truth — the all-ok line is
# byte-identical (the v1.24.1 rig pins it); a pending run adds its own
# honest variant + the finisher teaching (the app OR one command).
__out ""
__out "═══════════════════════════════════════════════════════════"
if [ "$__pkg_fail" = "1" ]; then
    __out "  doomalay termux setup complete — 1 step pending: packages"
    __out "  no network right now — the Doomalay app finishes this automatically"
    __out "  when you're back online (or run: bash ~/.doomalay-setup/resume.sh)"
else
    __out "  doomalay termux setup complete — return to the Doomalay app"
fi
__out "═══════════════════════════════════════════════════════════"

# ── THE EVERALIVE (v1.74.9, PLAN-V175 — the user's law: "termux needs to
# be persistent… truly one time… no user input needed at all"). Three
# additive arms, every one non-fatal + honestly reported:
#   1. THE PERSISTENT WAKE LOCK — termux-wake-lock held past setup (the
#      documented Termux answer to Android killing the idle shell: the
#      lock keeps Termux's own service class alive through screen-off +
#      the OEM idle passes; termux-wake-unlock is the user's off-switch).
#   2. THE BOOT SCRIPT — ~/.termux/boot/doomalay-keepalive re-arms the
#      lock + stamps the heartbeat at every device boot (needs the
#      Termux:Boot add-on — F-Droid, opened once — Termux's own security
#      model; without it the script simply waits, harmless).
#   3. THE HEARTBEAT — ~/.doomalay/alive (epoch), the engine's phoenix
#      probe re-stamps it on every revival; the boot script stamps it on
#      every boot (the diagnostic trail).
DM_KEEPALIVE_ARMED=0
__out ""
if [ -z "$DM_DEMO" ]; then
    if command -v termux-wake-lock >/dev/null 2>&1 \
        && termux-wake-lock >/dev/null 2>&1; then
        DM_KEEPALIVE_ARMED=1
        __out "  ✓ everalive: wake lock held — Termux survives screen-off + idle kills"
        __out "    (termux-wake-unlock releases it if you ever want it off)"
    else
        __out "  ⚠ everalive: termux-wake-lock unavailable — the wake lock stays off"
        __out "    (the Doomalay app still auto-revives Termux when a command dies)"
    fi
    DM_BOOT_DIR="$HOME/.termux/boot"
    mkdir -p "$DM_BOOT_DIR" 2>/dev/null
    cat > "$DM_BOOT_DIR/doomalay-keepalive" <<'KEEPALIVE_EOF'
#!/data/data/com.termux/files/usr/bin/sh
# doomalay-keepalive — written by setup.sh (v1.74.9 THE EVERALIVE SCRIPT,
# PLAN-V175). Termux:Boot runs this at every device boot (the add-on app
# must be installed from F-Droid and opened ONCE — Termux's own security
# model; until then this file simply waits, harmless).
termux-wake-lock >/dev/null 2>&1 || true
mkdir -p "$HOME/.doomalay" 2>/dev/null || true
date +%s > "$HOME/.doomalay/alive" 2>/dev/null || true
echo "$(date '+%Y-%m-%d %H:%M:%S') doomalay keepalive armed (boot)" >> "$HOME/.doomalay/keepalive.log" 2>/dev/null || true
KEEPALIVE_EOF
    if [ -s "$DM_BOOT_DIR/doomalay-keepalive" ]; then
        chmod +x "$DM_BOOT_DIR/doomalay-keepalive" 2>/dev/null
        __out "  ✓ everalive: boot script written (~/.termux/boot/doomalay-keepalive)"
        __out "    with the Termux:Boot app (F-Droid — install + open once), Termux"
        __out "    re-arms itself at every boot — that one open is the only ritual"
    else
        __out "  ⚠ everalive: could not write ~/.termux/boot/ — the boot script waits"
    fi
    if mkdir -p "$HOME/.doomalay" 2>/dev/null \
        && date +%s > "$HOME/.doomalay/alive" 2>/dev/null; then
        __out "  ✓ everalive: heartbeat live (~/.doomalay/alive)"
    else
        __out "  ⚠ everalive: could not write the heartbeat — non-fatal"
    fi
fi

# ── the checkin (v1.20.1 THE QUIET GATE) ──────────────────────
# Tell the Doomalay app the bootstrap ran, with this script's OWN honest
# step outcomes as the flags. v1.35.1: the third honest flag — pkgs=1|0 —
# rides the same curl (an older bridge ignores the unknown param, the
# additive law; a newer one reads it). Non-fatal by the same law as
# everything above: a failed curl changes nothing — the setup still
# worked, the app simply keeps watching the old way.
if [ -n "$DOOMALAY_CHECKIN_URL" ]; then
    __storage_flag=0; [ -d "$HOME/storage/shared" ] && __storage_flag=1
    __props_flag=0; grep -q "^allow-external-apps" "$HOME/.termux/termux.properties" 2>/dev/null && __props_flag=1
    __pkgs_flag=1; [ "$__pkg_fail" = "1" ] && __pkgs_flag=0
    if curl -fsS --max-time 6 "${DOOMALAY_CHECKIN_URL}?storage=${__storage_flag}&props=${__props_flag}&pkgs=${__pkgs_flag}" >/dev/null 2>&1; then
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
