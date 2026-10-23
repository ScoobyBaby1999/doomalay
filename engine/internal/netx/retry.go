package netx

// retry.go — v1.61.2 THE PATIENT WIRE (PLAN-V161 §v1.61.2, Class C).
//
// THE CONVICTION (the two live chatlogs): tool-side network calls are
// SINGLE-SHOT — kenny and trippy both surfaced raw transient errors
// verbatim to the model:
//
//   error: GET /repos/…/contents/engine/internal/llm/chat.go: Get
//     "https://api.github.com/…": context deadline exceeded (Client.Timeout…)
//   error: GET …: unexpected EOF
//   error: GET …: dial tcp 140.82.121.5:443: i/o timeout
//   fetch error: resolve raw.githubusercontent.com: no address
//
// Each of these is a 1-3s-backoff-retry class (GitHub's own best-practice
// doc: honor retry-after / x-ratelimit-reset; wait for an exponentially
// increasing amount between retries, a specific number of retries; do not
// re-hammer validation-class 4xx). The user's law: the model should feel
// it can do anything — a transient network blip must never become a
// tool failure the model reads (and then "simplifies" around).
//
// THE CLASSIFIER (IsTransient) is lifted from llm's proven
// isTransientNetErr — the set that has run the turn-level pause ladder
// since v0.93.2 (the TLS bad-record + v1.52.1's DNS walking-outage
// rungs included). One truth: llm delegates here.

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"time"
)

// transientRe — the one truth (moved from llm.isTransientNetErr verbatim;
// every class there was live-convicted on the device):
//
//	timeout / context deadline / connection reset / broken pipe /
//	unexpected EOF / refused / temporary / HTTP 5xx / 502 / 503 /
//	network / went silent / no data / tls: bad record MAC / handshake
//	failure / no such host / no address / lookup / dns / SERVFAIL
//
// v1.73.1 THE NET ARM (PLAN-V173 §v1.73.1): the Node/undici forms joined
// the set — the oc-bridge's failure classifier now reads the serve's own
// error shapes (a net interrupt through the serve path used to land as a
// bare oc_bridge_error with NO retry_class, so the chat never joined the
// continuation timer — the user's report: "our timer handler doesn't pick
// up network interrupts"). The serve (opencode 2.x, Node) surfaces undici's
// forms: "fetch failed" (undici's generic network-level TypeError — HTTP
// statuses resolve normally, so it IS the net class), "socket hang up", and
// the errno codes (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN —
// ECONNREFUSED already matched via "refused"). ONE truth: the turn-level
// pause ladder and the bridge classifier learn the same set together.
var transientRe = regexp.MustCompile(`(?i)timeout|context deadline|connection reset|broken pipe|unexpected EOF|^EOF$|: EOF( |$)|refused|temporary|HTTP 5[0-9][0-9]|503|502|network|went silent|no data|bad record mac|tls:|record mac|handshake failure|no such host|no address|lookup|dns|server misbehaving|SERVFAIL|connection abort|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed`)

// IsTransient reports whether err is a transient network class (the
// retry-worth set: it comes back on its own — carrier NAT rebinds,
// mobile DNS walking outages, forge hiccups). Validation classes
// (auth/403/404/422, quota, protocol) never match.
func IsTransient(err error) bool {
	if err == nil {
		return false
	}
	return transientRe.MatchString(err.Error())
}

// RetryDo runs client.Do(req) with a bounded, backoff-paced retry —
// THE PATIENT WIRE for tool-side requests (the forge, webfetch, the
// GitHub device login). newReq builds a FRESH request per attempt (a
// body can only be consumed once — the request-builder pattern avoids
// the GetBody trap entirely). Retries fire ONLY on IsTransient
// transport errors and 5xx responses (GitHub's guidance: a specific
// number of retries, never re-hammering validation-class 4xx).
// attempts counts TOTAL tries (3 = one original + two retries).
// baseDelay paces attempt 2; attempt 3 waits 3×baseDelay (1s/3s with
// the forge's 1s base — exponential-enough for a walking outage).
// The exhausted error carries the honest (retried Nx) suffix — never
// silent, never a naked cause the model reads as its own fumble.
func RetryDo(ctx context.Context, client *http.Client, newReq func() (*http.Request, error), attempts int, baseDelay time.Duration) (*http.Response, error) {
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	made := 0
	for attempt := 1; attempt <= attempts; attempt++ {
		made = attempt
		if cerr := ctx.Err(); cerr != nil {
			return nil, cerr
		}
		req, err := newReq()
		if err != nil {
			return nil, err // a request that cannot be built never retries
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if !IsTransient(err) || attempt == attempts {
				break
			}
			if wait := baseDelay * time.Duration(attempt*2-1); wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			continue
		}
		if resp.StatusCode >= 500 && attempt < attempts {
			// a 5xx is the server saying "again later" — drain + close so
			// the connection can be reused, then pace and retry
			drainClose(resp)
			if wait := baseDelay * time.Duration(attempt*2-1); wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			continue
		}
		return resp, nil
	}
	if lastErr != nil {
		if made > 1 {
			return nil, fmt.Errorf("%w (retried %dx)", lastErr, made)
		}
		return nil, lastErr
	}
	return nil, fmt.Errorf("netx: retry exhausted (retried %dx)", made)
}

// drainClose reads-and-discards the remainder then closes, so the
// keep-alive connection is reusable instead of leaked.
func drainClose(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	buf := make([]byte, 4<<10)
	for {
		if _, err := resp.Body.Read(buf); err != nil {
			break
		}
	}
	resp.Body.Close()
}
