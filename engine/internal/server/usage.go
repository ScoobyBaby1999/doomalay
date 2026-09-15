package server

// usage.go — v0.21 CONTEXT + COST TRACKING (ported from the HF space's
// metrics concept: real per-turn token usage, aggregated per model and
// provider, with list-price cost estimates).
//
// The engine persists the exact usage every provider reports inside each
// turn's terminal status event. This module aggregates those events:
//
//      GET /api/sessions/{id}/usage  — this chat: per-model token/cost totals,
//                                       context fill %, compact state
//      GET /api/usage                — ALL chats: per-provider/per-model totals
//
// Cost uses llm.LookupPrice (curated list rates); unpriced models show
// tokens without a dollar figure (never invented).

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// usageAccum aggregates one session's usage events.
type usageAccum struct {
	TokensIn   int64   `json:"tokensIn"`
	TokensOut  int64   `json:"tokensOut"`
	Turns      int     `json:"turns"`
	Cost       float64 `json:"cost"`
	HasCost    bool    `json:"hasCost"`
	LastSeq    int     `json:"lastSeq"`
	HistTokens []int64 `json:"-"` // per-turn totals (context chart)
}

// handleSessionUsage is GET /api/sessions/{id}/usage.
func (s *Server) handleSessionUsage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, err := s.db.GetSession(id)
	if err != nil || sess == nil {
		writeError(w, 404, "session not found")
		return
	}
	events, err := s.db.ListEvents(id, 0)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	byModel := map[string]*usageAccum{}
	var order []string
	var total usageAccum
	total.Turns = 0

	for _, ev := range events {
		if ev.EventType != "status" || ev.Content == "" {
			continue
		}
		var st struct {
			State string `json:"state"`
			Usage *struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal([]byte(ev.Content), &st) != nil || st.Usage == nil {
			continue
		}
		// The turn's model: the session's CURRENT model is close enough for
		// per-model splits after switches (each turn's model isn't stored on
		// the event). Track the running model via the event stream's
		// best-known value: we attribute to the session's models by time —
		// simplest correct-enough: attribute to the session model.
		key := sess.Model
		if key == "" {
			key = "unknown"
		}
		acc := byModel[key]
		if acc == nil {
			acc = &usageAccum{}
			byModel[key] = acc
			order = append(order, key)
		}
		acc.TokensIn += int64(st.Usage.InputTokens)
		acc.TokensOut += int64(st.Usage.OutputTokens)
		acc.Turns++
		acc.LastSeq = ev.Seq
		if cost, priced := llm.CostFor(key, st.Usage.InputTokens, st.Usage.OutputTokens); priced {
			acc.Cost += cost
			acc.HasCost = true
		}
		total.TokensIn += int64(st.Usage.InputTokens)
		total.TokensOut += int64(st.Usage.OutputTokens)
		total.Turns++
		if cost, priced := llm.CostFor(key, st.Usage.InputTokens, st.Usage.OutputTokens); priced {
			total.Cost += cost
			total.HasCost = true
		}
	}

	// context fill: estimate the current assembled context vs the model's window
	limit := llm.ContextLimitFor(sess.Model)
	// events AFTER the compact point are what's sent to the model
	var liveChars int
	for _, ev := range events {
		if ev.Seq <= sess.CompactSeq {
			continue
		}
		switch ev.EventType {
		case "user", "assistant", "assistant_delta", "thinking":
			liveChars += len(ev.Content)
		}
	}
	ctxTokens := llm.EstimateTokens(sess.CompactSummary) + llm.EstimateTokensN(liveChars)
	fillPct := 0
	if limit > 0 {
		fillPct = ctxTokens * 100 / limit
	}

	models := make([]map[string]any, 0, len(order))
	sort.Strings(order)
	for _, k := range order {
		acc := byModel[k]
		models = append(models, map[string]any{
			"model": k, "tokensIn": acc.TokensIn, "tokensOut": acc.TokensOut,
			"turns": acc.Turns, "cost": round2(acc.Cost), "hasCost": acc.HasCost,
		})
	}
	writeJSON(w, 200, map[string]any{
		"sessionId": id,
		"totals": map[string]any{
			"tokensIn": total.TokensIn, "tokensOut": total.TokensOut,
			"turns": total.Turns, "cost": round2(total.Cost), "hasCost": total.HasCost,
		},
		"context": map[string]any{
			"model": sess.Model, "limit": limit, "usedTokens": ctxTokens,
			"fillPct": fillPct, "compacted": sess.CompactSeq > 0,
			"compactSeq": sess.CompactSeq,
		},
		"models": models,
	})
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}

// handleUsageGlobal is GET /api/usage — totals across ALL sessions,
// grouped by provider + model (the fleet-wide cost tracker).
func (s *Server) handleUsageGlobal(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.db.ListSessions()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	byProvider := map[string]*usageAccum{}
	byModel := map[string]*usageAccum{}
	var grand usageAccum
	for _, sess := range sessions {
		events, err := s.db.ListEvents(sess.ID, 0)
		if err != nil {
			continue
		}
		for _, ev := range events {
			if ev.EventType != "status" || ev.Content == "" {
				continue
			}
			var st struct {
				Usage *struct {
					InputTokens  int `json:"input_tokens"`
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}
			if json.Unmarshal([]byte(ev.Content), &st) != nil || st.Usage == nil {
				continue
			}
			prov := sess.Provider
			if prov == "" {
				prov = "unknown"
			}
			pa := byProvider[prov]
			if pa == nil {
				pa = &usageAccum{}
				byProvider[prov] = pa
			}
			ma := byModel[sess.Model]
			if ma == nil {
				ma = &usageAccum{}
				byModel[sess.Model] = ma
			}
			for _, a := range []*usageAccum{pa, ma, &grand} {
				a.TokensIn += int64(st.Usage.InputTokens)
				a.TokensOut += int64(st.Usage.OutputTokens)
				a.Turns++
			}
			if cost, priced := llm.CostFor(sess.Model, st.Usage.InputTokens, st.Usage.OutputTokens); priced {
				pa.Cost += cost
				ma.Cost += cost
				grand.Cost += cost
				pa.HasCost, ma.HasCost, grand.HasCost = true, true, true
			}
		}
	}
	provOut := map[string]any{}
	for k, a := range byProvider {
		provOut[k] = map[string]any{"tokensIn": a.TokensIn, "tokensOut": a.TokensOut, "turns": a.Turns, "cost": round2(a.Cost), "hasCost": a.HasCost}
	}
	modelOut := map[string]any{}
	for k, a := range byModel {
		modelOut[k] = map[string]any{"tokensIn": a.TokensIn, "tokensOut": a.TokensOut, "turns": a.Turns, "cost": round2(a.Cost), "hasCost": a.HasCost}
	}
	writeJSON(w, 200, map[string]any{
		"totals":    map[string]any{"tokensIn": grand.TokensIn, "tokensOut": grand.TokensOut, "turns": grand.Turns, "cost": round2(grand.Cost), "hasCost": grand.HasCost},
		"providers": provOut,
		"models":    modelOut,
		"sessions":  len(sessions),
	})
}
