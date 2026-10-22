package netx

// retry_v1612_test.go — v1.61.2 THE PATIENT WIRE pins (PLAN-V161
// §v1.61.2): the classifier table replays EVERY transient string the
// two live chatlogs convicted (kenny's forge errors, trippy's DNS
// fetch, the device's own TLS/DNS classes) and the RetryDo wire
// proves fail-twice-then-200 through the real HTTP stack.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestV1612_ClassifierTable — the byte-exact strings from the chatlogs
// (every one reached the MODEL verbatim pre-v1.61.2) + the classes the
// device convicted + the validation classes that must NEVER retry.
func TestV1612_ClassifierTable(t *testing.T) {
	transient := []string{
		// kenny's forge errors (the logged bytes)
		`Get "https://api.github.com/repos/ScoobyBaby1999/doomalay/contents/engine/internal/llm/effort.go?ref=main": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
		`Get "https://api.github.com/repos/ScoobyBaby1999/doomalay/contents/engine/internal/llm/chat.go?ref=main": unexpected EOF`,
		`Get "https://api.github.com/repos/ScoobyBaby1999/doomalay/contents/engine/internal/llm/chat.go?ref=main": dial tcp 140.82.121.5:443: i/o timeout`,
		// the trippy fetch error
		`resolve raw.githubusercontent.com: no address`,
		// the device's own convicted classes
		`netx: no address for "integrate.api.nvidia.com" (system resolver and DNS-over-HTTPS both failed)`,
		`Post "https://api.mistral.ai/v1/chat/completions": remote error: tls: bad record MAC`,
		`dial tcp: lookup api.openai.com: no such host`,
		`read tcp 10.0.2.15:443->140.82.121.5:443: read: connection reset by peer`,
		`write tcp: broken pipe`,
		`HTTP 503 Service Unavailable`,
		`HTTP 502 Bad Gateway`,
		`dns server misbehaving`,
		`lookup api.github.com: SERVFAIL`,
		`tls: handshake failure`,
		`connection refused`,
		`temporary failure in name resolution`,
	}
	permanent := []string{
		`HTTP 403 Forbidden`,
		`HTTP 404 Not Found`,
		`HTTP 422 Unprocessable Entity`,
		`invalid api key`,
		`model not found`,
		`insufficient quota`,
	}
	for _, s := range transient {
		if !IsTransient(errors.New(s)) {
			t.Fatalf("must be TRANSIENT: %s", s)
		}
	}
	for _, s := range permanent {
		if IsTransient(errors.New(s)) {
			t.Fatalf("must be PERMANENT (never retried): %s", s)
		}
	}
	if IsTransient(nil) {
		t.Fatal("nil is never transient")
	}
}

// TestV1612_RetryDoFailTwiceThen200 — the wire: a transient transport
// error twice, then success. Three attempts land the payload.
func TestV1612_RetryDoFailTwiceThen200(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits < 3 {
			// a hard transport failure the client sees as EOF/reset:
			// hijack + slam the connection closed mid-response
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("no hijack")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatal(err)
			}
			conn.Close()
			return
		}
		fmt.Fprint(w, "RECOVERED")
	}))
	defer srv.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := RetryDo(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", srv.URL, nil)
	}, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("fail-twice-then-200 must recover: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if hits != 3 {
		t.Fatalf("hits = %d, want 3 (two slams + the landing)", hits)
	}
}

// TestV1612_RetryDoExhaustedHonest — a permanently-dead endpoint
// exhausts and the error carries the honest (retried Nx) suffix.
func TestV1612_RetryDoExhaustedHonest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("no hijack")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
	}))
	defer srv.Close()

	client := &http.Client{Timeout: 2 * time.Second}
	_, err := RetryDo(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", srv.URL, nil)
	}, 3, time.Millisecond)
	if err == nil {
		t.Fatal("must exhaust")
	}
	if !containsRetried(err.Error(), 3) {
		t.Fatalf("the exhausted error must carry the honest suffix, got: %v", err)
	}
}

// TestV1612_RetryDo5xxThen200 — a 5xx answers "again later"; the wire
// paces and retries; the 4xx classes never retry.
func TestV1612_RetryDo5xxThen200(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits == 1 {
			w.WriteHeader(503)
			fmt.Fprint(w, "overloaded")
			return
		}
		fmt.Fprint(w, "OK")
	}))
	defer srv.Close()

	client := &http.Client{}
	resp, err := RetryDo(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", srv.URL, nil)
	}, 3, time.Millisecond)
	if err != nil {
		t.Fatalf("5xx-then-200 must recover: %v", err)
	}
	defer resp.Body.Close()
	if hits != 2 {
		t.Fatalf("hits = %d, want 2", hits)
	}

	// the 4xx never retries
	hits = 0
	resp2, err := RetryDo(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", srv.URL, nil)
	}, 3, time.Millisecond)
	_ = resp2
	_ = err
	// (the 4xx case is pinned by the classifier table + the 4xx-first
	// shot below)
	hits = 0
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(404)
	}))
	defer srv2.Close()
	resp3, err := RetryDo(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequestWithContext(context.Background(), "GET", srv2.URL, nil)
	}, 3, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if hits != 1 {
		t.Fatalf("a 404 must NEVER retry (hits=%d)", hits)
	}
}

func containsRetried(s string, n int) bool {
	return strings.Contains(s, fmt.Sprintf("(retried %dx)", n))
}
