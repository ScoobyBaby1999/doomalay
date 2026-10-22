package llm

// sentinelclass.go — v1.61.3 THE RETRY SENTINEL, the llm side (PLAN-V161
// §v1.61.3, Class D). The chatlogs convicted the parked turns: kenny
// sat on "OpenRouter is unreachable right now … Tap Continue" ×2,
// trippy on mid-stream aborts ×2 — every one a class that CLEARS
// ITSELF, and the chat sat dead until a human tapped.
//
// This file is the CLASSIFICATION half: the park sites wrap their
// terminal verdicts in RetryableError, emitTurnError lifts the class
// onto the terminal error chunk, and the server-side sentinel arms a
// dynamic timer. The classes:
//
//   net  — the provider-hold expiry (netProviderHoldLoop's verdict) +
//          the seam-exhausted mid-stream abort; probed by the wake
//          broadcast + a cheap reachability probe.
//   429  — the rate-limit ladder's exhaustion; the provider's own
//          Retry-After (OpenRouter documents the header on 429/503)
//          clamps the first probe.
//   5xx  — the overload ladder's exhaustion (503/502/529-class).
//
// Non-retryable classes (auth/quota/modelgone/payload/cancelled) never
// wrap — the user's tap stays the only way forward for those, exactly
// as before. THE SENTINEL LAW (the user's explicit order, superseding
// the v135/v150.5 no-auto-continue law for retryable classes): a turn
// that dies on a retryable signal auto-resumes when the signal
// clears — the user's tap is always still faster, never required.

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RetryableError marks a terminal turn failure that CLEARS ITSELF —
// the sentinel's arming signal. The class vocabulary: "net", "429",
// "5xx". RetryAfterMS is the provider's own Retry-After header when
// present (OpenRouter-documented; clamps the first probe), else 0.
type RetryableError struct {
	Class        string
	Provider     string
	RetryAfterMS int64
	cause        error
}

func (e *RetryableError) Error() string {
	if e.cause == nil {
		return e.Class + " (retryable)"
	}
	return e.cause.Error()
}
func (e *RetryableError) Unwrap() error { return e.cause }

// wrapRetryable marks err retryable for the sentinel (nil-safe).
func wrapRetryable(err error, class, provider string, retryAfterMS int64) error {
	if err == nil {
		return nil
	}
	return &RetryableError{Class: class, Provider: provider, RetryAfterMS: retryAfterMS, cause: err}
}

// retryAfterHeaderMS parses a Retry-After response header (seconds or
// HTTP-date). 0 when absent/unparseable. OpenRouter's docs: 429/503
// carry it in SECONDS — the SDKs honor it; so does the sentinel.
func retryAfterHeaderMS(h string) int64 {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0
	}
	if secs, err := strconv.ParseInt(h, 10, 64); err == nil && secs >= 0 {
		if secs > 3600 {
			secs = 3600 // a fat header never wedges the first probe past an hour
		}
		return secs * 1000
	}
	if t, err := http.ParseTime(h); err == nil {
		d := time.Until(t).Milliseconds()
		if d < 0 {
			d = 0
		}
		if d > 3600*1000 {
			d = 3600 * 1000
		}
		return d
	}
	return 0
}

// RetryClassFromError lifts the sentinel's class off a turn error
// ("" when the failure is not retryable — auth/quota/modelgone/
// payload/cancelled never wrap). Exported for the server-side tests.
func RetryClassFromError(err error) (class string, retryAfterMS int64, retryable bool) {
	var re *RetryableError
	if errors.As(err, &re) {
		return re.Class, re.RetryAfterMS, true
	}
	return "", 0, false
}

// ProviderProbeTarget resolves a provider's /models probe target
// (base URL + key). ok=false when the provider is unknown — the
// sentinel then probes bare reachability via netx instead.
func ProviderProbeTarget(provider string, keys map[string]string) (baseURL, apiKey string, ok bool) {
	catalog, err := LoadCatalog()
	if err != nil {
		return "", "", false
	}
	cfg, known := catalog[provider]
	if !known {
		return "", "", false
	}
	return resolveBaseURL(cfg, keys[cfg.ExtraEnvVar]), keys[cfg.EnvVar], true
}

// errRetryableHint is the shadow error carrying the sentinel fields
// through emitTurnError (the chunk is the wire — the sentinel reads it
// server-side).
func retryChunkFields(err error) (class, provider string, retryAfterMS int64) {
	var re *RetryableError
	if errors.As(err, &re) {
		return re.Class, re.Provider, re.RetryAfterMS
	}
	return "", "", 0
}

// ensure fmt stays referenced (the park sites below may not all use it
// in every build configuration).
var _ = fmt.Sprintf
