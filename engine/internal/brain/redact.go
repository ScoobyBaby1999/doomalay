// redact.go — v0.75 in-flight redaction for the brain package (the shape
// twin of internal/server/redact.go; the vault-value pass lives with the
// Server, which owns the vault). Used by remote.go for remote-space error
// bodies — a compromised space could echo the headers it saw.
package brain

import "regexp"

const redactedKey = "‹redacted:key›"

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

// urlCreds — an embedded URL credential: the secret half is redacted, the
// structure preserved.
var urlCreds = regexp.MustCompile(`(://[^/\s:@]+:)([^@\s]{8,})(@)`)

// redactBody — the shape scrub for remote error bodies.
func redactBody(s string) string {
	if s == "" {
		return s
	}
	out := redactShapes.ReplaceAllString(s, redactedKey)
	return urlCreds.ReplaceAllString(out, "${1}"+redactedKey+"${3}")
}
