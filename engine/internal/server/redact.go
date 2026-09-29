// redact.go — v0.75 in-flight redaction (Phase 4 log hygiene, engine twin
// of brain/redact.py).
//
// Two passes:
//  1. SHAPE patterns (sk-, nvapi-, hf_, ghp_ …) — catches the provider key
//     forms anywhere they appear.
//  2. EXACT vault values — the engine HAS the vault, so any secret it
//     holds that appears verbatim in a message dies here too (covers the
//     shapes the regexes can't know: space tokens, workspace tokens).
//
// Wired at the sinks: forwardEvents' error path (persist + WS forward —
// see chat.go), the remote-brain error bodies, and any log line that
// carries a remote response. A provider 401 that echoes the Authorization
// header, a tool result that prints a key: nothing survives in flight.
package server

import (
	"regexp"
	"strings"
	"sync"
)

// redactedKey is the replacement marker (matches the brain's twin).
const redactedKey = "‹redacted:key›"

// redactShapes — provider/service key shapes (ordered longest-first is
// unnecessary for alternation; Go's regexp picks the leftmost-longest).
var redactShapes = regexp.MustCompile(
	`sk-proj-[A-Za-z0-9_-]{20,}|` +
		`sk-[A-Za-z0-9_-]{16,}|` +
		`nvapi-[A-Za-z0-9_-]{16,}|` +
		`hf_[A-Za-z0-9]{20,}|` +
		`github_pat_[A-Za-z0-9_]{20,}|` +
		`ghp_[A-Za-z0-9]{20,}|` +
		`gho_[A-Za-z0-9]{20,}|` +
		`ghu_[A-Za-z0-9]{20,}|` +
		`ghs_[A-Za-z0-9]{20,}|` +
		`ghr_[A-Za-z0-9]{20,}|` +
		`glpat-[A-Za-z0-9_-]{15,}|` +
		`dop_v1_[A-Za-z0-9]{20,}|` +
		`pypi-[A-Za-z0-9]{20,}|` +
		`xox[baprs]-[A-Za-z0-9-]{10,}|` +
		`AIza[A-Za-z0-9_-]{30,}|` +
		`ant-api-key-[A-Za-z0-9_-]{20,}|` +
		`doom-space-[A-Za-z0-9_-]{16,}`)

// urlCreds — an embedded URL credential (scheme://user:secret@host): the
// secret half of the pair is redacted, the structure preserved.
var urlCreds = regexp.MustCompile(`(://[^/\s:@]+:)([^@\s]{8,})(@)`)

// the exact-value set (vault values ≥ 16 chars), refreshed on key writes.
var (
	redactValsMu sync.RWMutex
	redactVals   []string
)

// Redact redacts key-shaped + known-vault substrings from a string.
// Never panics; nil-safe.
func Redact(s string) string {
	if s == "" {
		return s
	}
	out := redactShapes.ReplaceAllString(s, redactedKey)
	out = urlCreds.ReplaceAllString(out, "${1}"+redactedKey+"${3}")
	redactValsMu.RLock()
	vals := redactVals
	redactValsMu.RUnlock()
	for _, v := range vals {
		if len(v) >= 16 && strings.Contains(out, v) {
			out = strings.ReplaceAll(out, v, redactedKey)
		}
	}
	return out
}

// RedactAny — Redact for the loose event fields (string passthrough,
// anything else returned unchanged).
func RedactAny(v any) any {
	if s, ok := v.(string); ok {
		return Redact(s)
	}
	return v
}

// refreshRedactVals rebuilds the exact-value set from the vault (called
// on key writes — keys.go / devkeys.go / fanOutRemoteEnv's neighborhood).
func (s *Server) refreshRedactVals() {
	if s.vault == nil {
		return
	}
	env := s.vault.AsEnv()
	vals := make([]string, 0, len(env))
	for _, v := range env {
		if len(v) >= 16 {
			vals = append(vals, v)
		}
	}
	redactValsMu.Lock()
	redactVals = vals
	redactValsMu.Unlock()
}
