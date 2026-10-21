package llm

import "strings"

// IsOpenCodeFreeModelSlot reports whether an OpenCode model id is one of
// the FREE-tier models — the exact rule fetchOpenCodeModels applies to the
// live zen list (models_v2.go): big-pickle, or any *-free id minus the
// paid exceptions. v1.48.5 THE SERVE BRIDGE: free models route through
// the engine-managed genuine client (`opencode serve`) — the hosted API's
// free tier is walled below-HTTP to OpenCode's own apps (live-verified
// 2026-10: byte-faithful CLI-identity replays still answer 403
// FreeTierError), while the genuine serve passes with the same key.
// The slot may arrive bare ("big-pickle") or provider-prefixed
// ("opencode/big-pickle") — both spellings resolve here.
func IsOpenCodeFreeModelSlot(model string) bool {
	id := strings.TrimSpace(model)
	if id == "" {
		return false
	}
	if strings.HasPrefix(id, "opencode/") {
		id = strings.TrimPrefix(id, "opencode/")
	}
	switch id {
	case "minimax-m3-free", "qwen3.6-plus-free":
		return false // the paid exceptions (models_v2.go's own table)
	}
	return id == "big-pickle" || strings.HasSuffix(id, "-free")
}
