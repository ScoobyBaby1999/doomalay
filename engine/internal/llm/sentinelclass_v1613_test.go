package llm

// sentinelclass_v1613_test.go — v1.61.3 THE RETRY SENTINEL pins, the
// llm side: the park sites wrap, the chunk carries the class, the
// Retry-After parser honors OpenRouter's header, and the auth classes
// never classify.

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestV1613_RetryClassFromError(t *testing.T) {
	cause := errors.New("OpenRouter is unreachable right now")
	err := wrapRetryable(cause, "net", "openrouter", 0)
	class, raMS, ok := RetryClassFromError(err)
	if !ok || class != "net" || raMS != 0 {
		t.Fatalf("wrap classify: %q %v %v", class, raMS, ok)
	}
	// the cause survives (friendlyStreamError reads it)
	if !errors.Is(err, cause) {
		t.Fatal("the wrap must unwrap to the cause")
	}
	// a naked error never classifies
	if _, _, ok := RetryClassFromError(errors.New("401 invalid api key")); ok {
		t.Fatal("an auth-shaped error must never classify")
	}
}

func TestV1613_HoldExpiryParksRetryable(t *testing.T) {
	// the bounded hold with a 1ms budget: one last attempt fails → the
	// verdict wraps the net class for the sentinel.
	old := netProviderHoldTotal
	netProviderHoldTotal = time.Millisecond
	t.Cleanup(func() { netProviderHoldTotal = old })

	ch := make(chan ChatChunk, 64)
	err := netProviderHoldLoop(context.Background(), ch, "openrouter", "", func() (bool, error) {
		return false, errors.New("Get \"https://openrouter.ai/api/v1/chat/completions\": dial tcp: lookup openrouter.ai: no such host")
	})
	if err == nil {
		t.Fatal("the hold must expire")
	}
	class, _, ok := RetryClassFromError(err)
	if !ok || class != "net" {
		t.Fatalf("the hold-expiry verdict must park retryable (class=%q ok=%v): %v", class, ok, err)
	}
	if got := err.Error(); !contains(got, "Tap Continue") && !contains(got, "auto-retry") {
		t.Fatalf("the verdict must keep the continue affordance + name the auto-retry: %q", got)
	}
}

func TestV1613_EmitTurnErrorCarriesTheClass(t *testing.T) {
	// the terminal error chunk carries the sentinel fields — the
	// server-side arm reads them.
	ch := make(chan ChatChunk, 8)
	emitTurnError(ch, wrapRetryable(errors.New("HTTP 429: rate limited"), "429", "openrouter", 4200))
	found := false
	for len(ch) > 0 {
		c := <-ch
		if c.Type == "error" {
			if c.RetryClass != "429" || c.RetryProvider != "openrouter" || c.RetryAfterMS != 4200 {
				t.Fatalf("the error chunk must carry the sentinel fields: %+v", c)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("no error chunk rode")
	}
	// a plain (non-retryable) error carries NOTHING
	ch2 := make(chan ChatChunk, 8)
	emitTurnError(ch2, errors.New("401 invalid api key"))
	for len(ch2) > 0 {
		c := <-ch2
		if c.RetryClass != "" {
			t.Fatalf("an auth error must carry no retry class: %+v", c)
		}
	}
}

func TestV1613_RetryAfterHeader(t *testing.T) {
	if got := retryAfterHeaderMS(""); got != 0 {
		t.Fatalf("empty header = %d", got)
	}
	if got := retryAfterHeaderMS("120"); got != 120000 {
		t.Fatalf("seconds form = %d", got)
	}
	if got := retryAfterHeaderMS("999999"); got != 3600000 {
		t.Fatalf("the fat-header clamp = %d", got)
	}
	// the HTTP-date form
	future := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	if got := retryAfterHeaderMS(future); got < 20000 || got > 40000 {
		t.Fatalf("the date form ≈ 30s, got %d", got)
	}
}

func TestV1613_AbortClassIsTransient(t *testing.T) {
	// the trippy conviction: "software caused connection abort" was NOT
	// in the transient set — the seam parked on the first abort.
	if !isTransientNetErr(errors.New("read tcp 10.0.2.15:443->140.82.121.5:443: read: software caused connection abort")) {
		t.Fatal("the connection-abort class must be transient (the trippy conviction)")
	}
	if isTransientNetErr(errors.New("HTTP 401 unauthorized")) {
		t.Fatal("auth must stay permanent")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
