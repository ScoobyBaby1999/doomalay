package llm

// cooldown.go — v0.39 P8-FULL recovery port: the provider cooldown table +
// rpm pacing, ported from the socreate/timemanager SlotScheduler error-class
// table (lib/scheduler.py:290-336) and adapted to this engine's reality:
// ONE slot per provider (single key per provider), consulted at request time
// and by model-gone alternate routing.
//
// Error-class table (socreate semantics, Doomalay adaptation):
//   429            → proportional cooldown: clamp(240/rpm, 15s, 300s)
//                    (low-rpm providers wait longer; NVIDIA free tier = 40 rpm)
//   401 / 403      → blacklist for this engine lifetime (bad key / banned —
//                    retrying is pointless; the UI shows the honest error)
//   402 / 413 / 422→ 60s cooldown (quota spent / payload too large — rotate later)
//   5xx / 524 / net/timeout → 60s cooldown (transient — socreate's network class)
//   404 / 410      → NOT blacklisted here: in this engine a 404 almost always
//                    means THE MODEL is gone (NIM deprovisions mid-session),
//                    which ResolveModelAlternate handles by rotating to another
//                    host of the same logical model. The provider stays usable.
//
// Pacing (scheduler.py:338-361): reserve-under-lock, sleep OUTSIDE the lock —
// concurrent turns (parallel chats) stack staggered reservations instead of
// collapsing onto the provider. min gap = 60/rpm, bounded by pacingMaxWait so
// a hot provider never stalls a turn indefinitely (the 429 path is the
// backstop for real overload).

import (
        "strings"
        "sync"
        "time"
)

const (
        cooldownRateCeil = 300 * time.Second // socreate cooldown_rate_limit
        cooldownFloor    = 15 * time.Second  // 429 minimum wait
        cooldownMinute   = 60 * time.Second  // 5xx/quota/payload class
        pacingMaxWait    = 5 * time.Second   // never stall a turn behind pacing alone
)

// providerRPM is the per-provider requests-per-minute guess driving the 429
// proportional cooldown + pacing. Source: provider_quirks.json (NVIDIA free
// tier 40 RPM captest-verified) + sane defaults. rpm <= 0 means "unknown" →
// default 30.
var providerRPM = map[string]int{
        "nvidia":       40,
        "opencode":     30,
        "openrouter":   60,
        "groq":         30,
        "together":     30,
        "mistral":      30,
        "deepseek":     30,
        "openai":       60,
        "anthropic":    50,
        "cloudflare":   30,
        "privatemodeai": 30,
}

func rpmFor(provider string) int {
        if v, ok := providerRPM[provider]; ok && v > 0 {
                return v
        }
        return 30
}

type slotState struct {
        CooldownUntil time.Time
        Blacklisted   bool
        LastErr       string
        UpdatedAt     time.Time
}

var (
        cooldownMu sync.Mutex
        cooldowns  = map[string]*slotState{}
)

// ClassifyProviderError maps an HTTP status (+ body sniff) to the socreate
// error class. Network/timeout errors arrive as code "net".
func ClassifyProviderError(status int, body string) string {
        switch status {
        case 429:
                return "429"
        case 401, 403:
                return "auth"
        case 402:
                return "quota"
        case 413, 422:
                return "payload"
        case 404, 410:
                return "modelgone"
        }
        // socreate's DEGRADED reclass: an NVIDIA NIM outage answers 400 with
        // "DEGRADED" in the body — that's a server problem, not a client one.
        if status == 400 {
                if strings.Contains(strings.ToUpper(body), "DEGRADED") {
                        return "5xx"
                }
        }
        if status >= 500 {
                return "5xx"
        }
        return "http"
}

// RecordProviderFailure applies the error-class table. reason is surfaced in
// ProviderState for diagnostics.
func RecordProviderFailure(provider, class, reason string) {
        if provider == "" {
                return
        }
        if len(reason) > 200 {
                reason = reason[:200]
        }
        cooldownMu.Lock()
        defer cooldownMu.Unlock()
        st := cooldowns[provider]
        if st == nil {
                st = &slotState{}
                cooldowns[provider] = st
        }
        st.LastErr = class + ": " + reason
        st.UpdatedAt = time.Now()
        switch class {
        case "429":
                rpm := rpmFor(provider)
                wait := time.Duration(240/rpm) * time.Second
                if wait < cooldownFloor {
                        wait = cooldownFloor
                }
                if wait > cooldownRateCeil {
                        wait = cooldownRateCeil
                }
                st.CooldownUntil = time.Now().Add(wait)
        case "auth":
                st.Blacklisted = true
        case "quota", "payload", "5xx", "net", "http":
                st.CooldownUntil = time.Now().Add(cooldownMinute)
        }
        // modelgone / unknown classes: no provider-level penalty.
}

// RecordProviderSuccess clears a cooldown ONLY if it already expired — the
// socreate race guard (scheduler.py:254-272): an in-flight success must never
// erase an ACTIVE 429 cooldown recorded by a sibling request.
func RecordProviderSuccess(provider string) {
        if provider == "" {
                return
        }
        cooldownMu.Lock()
        defer cooldownMu.Unlock()
        st := cooldowns[provider]
        if st == nil {
                return
        }
        if st.CooldownUntil.After(time.Now()) {
                return // active cooldown survives
        }
        st.CooldownUntil = time.Time{}
        st.LastErr = ""
}

// ProviderCooldownRemaining returns how long the provider is still cooling
// (0 = available now). Blacklisted providers report 0 remaining — check
// ProviderAvailable for the hard state.
func ProviderCooldownRemaining(provider string) time.Duration {
        cooldownMu.Lock()
        defer cooldownMu.Unlock()
        st := cooldowns[provider]
        if st == nil {
                return 0
        }
        if r := time.Until(st.CooldownUntil); r > 0 {
                return r
        }
        return 0
}

// ProviderAvailable reports whether the provider may be selected RIGHT NOW
// (not blacklisted, not cooling). Used by alternate routing to skip bad hosts.
func ProviderAvailable(provider string) bool {
        cooldownMu.Lock()
        defer cooldownMu.Unlock()
        st := cooldowns[provider]
        if st == nil {
                return true
        }
        if st.Blacklisted {
                return false
        }
        return !st.CooldownUntil.After(time.Now())
}

// ProviderState is a diagnostic snapshot (best-effort; for logs/tests).
func ProviderState(provider string) (cooling bool, blacklisted bool, lastErr string) {
        cooldownMu.Lock()
        defer cooldownMu.Unlock()
        st := cooldowns[provider]
        if st == nil {
                return false, false, ""
        }
        return st.CooldownUntil.After(time.Now()), st.Blacklisted, st.LastErr
}

// pacing state: per-provider nextAllowed reservation (reserve-under-lock,
// sleep outside — socreate scheduler.py:338-361).
var (
        pacingMu   sync.Mutex
        pacingNext = map[string]time.Time{}
)

// PaceProvider reserves the next send slot for the provider and returns how
// long the caller should wait before issuing the request. Concurrent callers
// get staggered slots; a caller whose wait would exceed pacingMaxWait gets 0
// (skip pacing — overload is the 429 path's job, not this one).
func PaceProvider(provider string) time.Duration {
        if provider == "" {
                return 0
        }
        gap := time.Minute / time.Duration(rpmFor(provider))
        pacingMu.Lock()
        now := time.Now()
        next := pacingNext[provider]
        earliest := now
        if next.After(now) {
                earliest = next
        }
        reserved := earliest.Add(gap)
        pacingNext[provider] = reserved
        wait := earliest.Sub(now)
        pacingMu.Unlock()
        if wait <= 0 || wait > pacingMaxWait {
                return 0
        }
        return wait
}
