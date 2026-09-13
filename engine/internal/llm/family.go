// family.go — family normalization + display names + capability inference,
// ported verbatim from the old backend (catalog.py make_family /
// derive_display_name / derive_capabilities_from_name). The same logic also
// lived in the old frontend (src/lib/providers/family.ts) — one algorithm,
// two runtimes, so dedup across providers matches exactly.

package llm

import (
	"strings"
)

// familySuffixes are stripped (longest-first, iteratively) to get the model
// family from a raw id — "meta-llama/llama-4-70b-instruct" → "llama-4-70b".
var familySuffixes = []string{
	":free", "-instruct-2507", "-instruct-fp8-fast", "-instruct-fast",
	"-fp8-fast", "-instruct", "-versatile", "-it", "-chat", "-preview", "-free",
}

// MakeFamily normalizes a raw model id to its family key:
// lowercase → segment after the last "/" → strip leading "@" → strip known
// suffixes (longest first, repeat) → last segment again.
func MakeFamily(rawID string) string {
	s := strings.ToLower(strings.TrimSpace(rawID))
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.TrimPrefix(s, "@")
	// Iteratively strip known suffixes (some ids stack two).
	for {
		stripped := false
		for _, suf := range familySuffixes {
			if strings.HasSuffix(s, suf) {
				s = strings.TrimSuffix(s, suf)
				stripped = true
				break
			}
		}
		if !stripped {
			break
		}
	}
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	return s
}

// acronymSet: tokens uppercased in display names.
var acronymSet = map[string]bool{
	"glm": true, "gpt": true, "oss": true, "llm": true, "mimo": true,
	"api": true, "fp8": true, "vl": true, "swe": true, "tts": true,
}

// DeriveDisplayName converts a logical id into a human display name:
// "deepseek-v4-pro" → "Deepseek V4 Pro", "glm-5.1" → "GLM 5.1".
func DeriveDisplayName(logical string) string {
	fam := MakeFamily(logical)
	if fam == "" {
		return logical
	}
	tokens := strings.Split(fam, "-")
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if t == "" {
			continue
		}
		if acronymSet[t] {
			out = append(out, strings.ToUpper(t))
			continue
		}
		// Numeric-ish tokens (5.1, 70b, 4o) keep their casing.
		if hasDigit(t) {
			out = append(out, t)
			continue
		}
		out = append(out, strings.ToUpper(t[:1])+t[1:])
	}
	return strings.Join(out, " ")
}

func hasDigit(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			return true
		}
	}
	return false
}

// capability regex families from the old backend's
// derive_capabilities_from_name — the fallback when no live metadata exists.
var (
	visionKws   = []string{"vision", "-vl", "llava", "florence", "gemma", "kimi", "llama-4", "qwen3", "glm-5", "step"}
	audioKws    = []string{"aura-", "whisper", "-tts", "speech", "bark", "voxtral", "melotts"}
	embedKws    = []string{"bge-", "embed-", "gte-", "e5-"}
	toolsKws    = []string{"tool", "function", "agent", "instruct", "chat", "turbo", "hermes", "big-pickle", "coder"}
	reasonKws   = []string{"r1", "o1", "o3", "o4", "qwq", "nemotron", "reasoning", "thinking", "deepseek-r", "reasoner"}
)

// InferCapabilitiesFromName derives capability strings for a model id
// (used only when live metadata is missing).
func InferCapabilitiesFromName(rawID string) []string {
	name := strings.ToLower(rawID)
	var caps []string
	if matchesAny(name, visionKws) {
		caps = append(caps, "vision")
	}
	if matchesAny(name, audioKws) {
		caps = append(caps, "audio")
	}
	if matchesAny(name, embedKws) {
		caps = append(caps, "embedding")
	}
	if matchesAny(name, toolsKws) {
		caps = append(caps, "tools")
	}
	if matchesAny(name, reasonKws) {
		caps = append(caps, "reasoning")
	}
	return caps
}

func matchesAny(s string, kws []string) bool {
	for _, kw := range kws {
		if strings.Contains(s, kw) {
			return true
		}
	}
	return false
}

// FormatContext renders a context length for the UI: 262144 → "262K",
// 1000000 → "1M", 0 → "—".
func FormatContext(ctx int64) string {
	if ctx <= 0 {
		return "—"
	}
	if ctx >= 1_000_000 && ctx%1_000_000 == 0 {
		return "1M"
	}
	if ctx >= 1000 {
		return strings.TrimSuffix(itoa(ctx/1000), "") + "K"
	}
	return itoa(ctx)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
