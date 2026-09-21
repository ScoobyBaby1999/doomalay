package llm

import (
        "sort"
        "strings"
)

// ── v0.40: MODEL-GONE ONE-TAP RECOVERY ────────────────────────────────
//
// The live-observed pattern (4 sessions running): NVIDIA NIM deprovisions
// models mid-account ("Not found for account" 404s, 410 end-of-life), and
// when the model is single-hosted the v0.38 alternate routing has nowhere
// to rotate — the turn dies with "pick another model" and the user is left
// manually browsing 1200 catalog rows.
//
// SuggestReplacements ranks the closest AVAILABLE replacements from the
// live catalog so the frontend can render one-tap "Switch to X" chips on
// the error bubble: same provider (the key the user already trusts), same
// model family first (glm → glm, nemotron → nemotron), then similar
// context tier, free-ness, and catalog order as quiet tie-breakers.

// ModelSuggestion is one replacement candidate for the error event's
// "suggest" array. Model is the FULL user-facing id ("provider/modelId")
// ready for a model switch; Label is the short display name for the chip.
type ModelSuggestion struct {
        Provider string `json:"provider"`
        Model    string `json:"model"`
        Label    string `json:"label"`
}

// SuggestReplacements returns up to `want` key-backed models on the same
// provider that could replace the dead `userModel` ("provider/modelId").
// Dead routes (the exact failed model) are never suggested. A nil/empty
// result means "no better idea than the browser" — the frontend then just
// renders the plain error, exactly as before.
func SuggestReplacements(userModel, userProvider string, keys map[string]string, want int) []ModelSuggestion {
        if keys == nil || userModel == "" || userProvider == "" || want <= 0 {
                return nil
        }
        // v0.39 cooldown table: if the PROVIDER itself is blacklisted (401/403 —
        // the key is bad) or mid-cooldown, suggesting its models is noise.
        if !ProviderAvailable(userProvider) {
                return nil
        }
        cat := BuildCatalogV2(keys, false)
        if cat == nil {
                return nil
        }

        // The dead model's identity: strip the provider prefix to compare
        // against host ModelIDs, and find its logical entry for the family.
        stripped := strings.TrimPrefix(userModel, userProvider+"/")
        deadLogical := ""
        deadFamily := ""
        deadCtx := int64(0)
        deadCaps := map[string]bool{}
        for _, lm := range cat.Logical {
                for _, h := range lm.Hosts {
                        if h.Provider == userProvider && h.ModelID == stripped {
                                deadLogical = lm.Logical
                                deadFamily = strings.ToLower(lm.Family)
                                if h.ContextLength > 0 {
                                        deadCtx = h.ContextLength
                                }
                                if lm.Attributes != nil {
                                        for _, c := range lm.Attributes.Capabilities {
                                                deadCaps[c] = true
                                        }
                                }
                                break
                        }
                }
                if deadLogical != "" {
                        break
                }
        }

        type cand struct {
                sug  ModelSuggestion
                score int
        }
        var out []cand
        seen := map[string]bool{stripped: true} // never re-suggest the dead route

        for _, lm := range cat.Logical {
                if lm.Logical == deadLogical {
                        continue // same logical model, other hosts: the v0.38 alternate
                        // routing ALREADY tried those — suggesting them again would
                        // just repeat the failure.
                }
                for _, h := range lm.Hosts {
                        if h.Provider != userProvider || !h.HasAPIKey {
                                continue // same provider, key-backed (available NOW)
                        }
                        if seen[h.ModelID] {
                                continue
                        }
                        seen[h.ModelID] = true

                        score := 0
                        fam := strings.ToLower(lm.Family)
                        if fam != "" && deadFamily != "" {
                                if fam == deadFamily {
                                        score += 100 // same family — the strongest signal
                                } else if strings.HasPrefix(fam, deadFamily) || strings.HasPrefix(deadFamily, fam) {
                                        score += 60 // glm-5.3 vs glm-5.4 — generation neighbors
                                }
                        }
                        // v0.40.1 CAPABILITY-AWARE RANKING (live-observed need: the
                        // first cut suggested a video-detector + an EMBEDDING model
                        // to replace a dead chat model — the recovery turn then
                        // 500'd on the detector). A chat model's replacement must
                        // be a chat model: overlap with the dead model's caps is
                        // the signal, embedding-capability and cap-less niche
                        // entries are hard-penalized.
                        if lm.Attributes != nil {
                                caps := lm.Attributes.Capabilities
                                for _, c := range caps {
                                        if deadCaps[c] {
                                                score += 20 // same capability class as the dead model
                                        }
                                        if c == "tools" {
                                                score += 40 // this app is tool-first (native function calling)
                                        }
                                        if c == "reasoning" {
                                                score += 15
                                        }
                                        if c == "chat" {
                                                score += 30
                                        }
                                        if c == "embedding" {
                                                score -= 200 // NEVER a chat replacement
                                        }
                                }
                                if len(caps) == 0 {
                                        score -= 50 // unclassified niche model (detectors, rerankers…) — disfavored
                                }
                        } else {
                                score -= 50 // no metadata at all — same disfavor
                        }
                        // context tier proximity (same order of magnitude = same class)
                        if deadCtx > 0 && h.ContextLength > 0 {
                                ratio := float64(h.ContextLength) / float64(deadCtx)
                                if ratio >= 0.5 && ratio <= 2.0 {
                                        score += 25
                                }
                        }
                        if h.IsFree {
                                score += 10 // free tiers are the friendliest recovery
                        }
                        if h.SyncedLive {
                                score += 5 // confirmed live in the last sync
                        }

                        label := lm.DisplayName
                        if label == "" {
                                label = h.ModelID
                        }
                        out = append(out, cand{
                                sug: ModelSuggestion{
                                        Provider: userProvider,
                                        Model:    userProvider + "/" + h.ModelID,
                                        Label:    label,
                                },
                                score: score,
                        })
                        break // one route per logical model is enough
                }
        }
        if len(out) == 0 {
                return nil
        }

        sort.SliceStable(out, func(i, j int) bool {
                if out[i].score != out[j].score {
                        return out[i].score > out[j].score
                }
                return out[i].sug.Label < out[j].sug.Label // deterministic
        })
        if len(out) > want {
                out = out[:want]
        }
        res := make([]ModelSuggestion, 0, len(out))
        for _, c := range out {
                res = append(res, c.sug)
        }
        return res
}

// ModelGoneMessage reports whether an error text is the model-deprecation
// class (the exact strings friendlyHTTPError emits for 404-not-found-for-
// account and 410 end-of-life). The server hook uses this to decide when
// to attach suggestions to the error event.
func ModelGoneMessage(msg string) bool {
        m := strings.ToLower(msg)
        return strings.Contains(m, "no longer available") ||
                strings.Contains(m, "end of life") ||
                strings.Contains(m, "retired by the provider") ||
                strings.Contains(m, "not found for account")
}
