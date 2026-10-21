package llm

import "strings"

// IsOpenCodeFreeModelSlot reports whether an OpenCode model id is a FREE-tier
// model — v1.55.4 THE LIVE LAW: the registry's cost-0/0 data decides (the
// old free-name literals with their hand-carved paid exceptions are DEAD —
// "no static lists, not even fallback"). v1.48.5 THE SERVE BRIDGE: free models
// (`opencode serve`) — the hosted API's free tier is walled below-HTTP to
// OpenCode's own apps (live-verified 2026-10: byte-faithful CLI-identity
// replays still answer 403 FreeTierError), while the genuine serve passes
// with the same key.
//
// The slot may arrive bare or provider-prefixed ("opencode/<id>") — both
// spellings resolve here. A model the live registry doesn't know answers
// false (honest) — the direct path's 403 wall copy names the bridge, so
// nothing degrades silently.
func IsOpenCodeFreeModelSlot(model string) bool {
        id := strings.TrimSpace(model)
        if id == "" {
                return false
        }
        if strings.HasPrefix(id, "opencode/") {
                id = strings.TrimPrefix(id, "opencode/")
        }
        dm := LookupDevModel("opencode", id)
        if dm == nil {
                // the serve bridge's OWN catalogue is the device-local belt (its
                // cost entries ride the v1.55.3 hook through the catalog build)
                return false
        }
        return dm.IsFree()
}
