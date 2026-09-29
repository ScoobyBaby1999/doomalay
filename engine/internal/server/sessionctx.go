package server

// sessionctx.go — v0.78.1 THE BOT'S OWN DASHBOARD (user spec: "The model
// should know the current usage, pricing, context, tokens… and whether it is
// connected to a workspace or a repo or not… if the user has any workspaces,
// is connected to GitHub, or any other default external hosts, should know
// its access level").
//
// A compact, LIVE-VALUED block appended to every composed system prompt (all
// three return paths of systemPromptForMetrics — which also feeds the brain
// path, since the engine always sends system_prompt). Everything it reports
// already existed server-side (usage events, the curated rate table, the
// context-limit rules, the vault's forge sign-ins, the session's bound
// workspaces); this module is the first thing that TELLS the model.
//
// The PM client composes the same block client-side (pmSessionContextBlock —
// PM turns bypass the engine); keep the two texts in sync, same as the
// v0.68 metadata-preamble twins.

import (
        "encoding/json"
        "strconv"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// sessionContextPreamble builds the "## Your session (live)" block.
// db-less Servers (tests) still compose: usage/context lines are skipped,
// connections/workspaces degrade to "unknown" only when a vault/store is
// genuinely absent (the real engine always has both).
func (s *Server) sessionContextPreamble(sess *store.Session) string {
        if sess == nil {
                return ""
        }

        var usageIn, usageOut, turns int64
        var cost float64
        var priced bool
        var lastIn int
        var liveChars int
        if s.db != nil {
                if events, err := s.db.ListEvents(sess.ID, 0); err == nil {
                        for _, ev := range events {
                                if ev.Seq <= sess.CompactSeq {
                                        continue
                                }
                                switch ev.EventType {
                                case "user", "assistant", "assistant_delta", "thinking":
                                        liveChars += len(ev.Content)
                                }
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
                                usageIn += int64(st.Usage.InputTokens)
                                usageOut += int64(st.Usage.OutputTokens)
                                turns++
                                if st.Usage.InputTokens > 0 {
                                        lastIn = st.Usage.InputTokens
                                }
                                if c, ok := llm.CostFor(sess.Model, st.Usage.InputTokens, st.Usage.OutputTokens); ok {
                                        cost += c
                                        priced = true
                                }
                        }
                }
        }

        b := &strings.Builder{}
        b.WriteString("\n\n## Your session (live — what you are and what you're connected to)\n")

        // Context window + fill (usage.go's method: char estimate until the first
        // real usage lands, then the provider's own measured input_tokens).
        if limit := llm.ContextLimitFor(sess.Model); limit > 0 {
                ctxTokens := llm.EstimateTokens(sess.CompactSummary) + llm.EstimateTokensN(liveChars)
                if lastIn > ctxTokens {
                        ctxTokens = lastIn
                }
                fill := 0
                if ctxTokens > 0 {
                        fill = ctxTokens * 100 / limit
                }
                if remain := limit - ctxTokens; remain > 0 {
                        b.WriteString("- Context window: ~" + commaI64(int64(limit)) + " tokens; this turn rides ~" +
                                commaI64(int64(ctxTokens)) + " (" + strconv.Itoa(fill) + "% full, ~" +
                                commaI64(int64(remain)) + " still free" + compactNote(sess) + ").\n")
                } else {
                        b.WriteString("- Context window: ~" + commaI64(int64(limit)) + " tokens; currently at ~" +
                                commaI64(int64(ctxTokens)) + " (~" + strconv.Itoa(fill) + "% of the window" + compactNote(sess) + ").\n")
                }
        }

        // Usage so far (only once there is any).
        if turns > 0 {
                line := "- This chat so far: " + strconv.FormatInt(turns, 10) + " turn(s), " +
                        commaI64(usageIn) + " tokens in / " + commaI64(usageOut) + " tokens out"
                if priced {
                        line += ", ≈$" + trimCost(cost) + " at list rates"
                }
                b.WriteString(line + ".\n")
        }

        // Pricing of the CURRENT model (the user's "the model should know pricing").
        if p := llm.LookupPrice(sess.Model); p.Source != "unpriced" {
                if p.Free {
                        b.WriteString("- Your rates: this tier is FREE ($0) — list would be $" +
                                trimCost(p.InputPerM) + " in / $" + trimCost(p.OutputPerM) + " out per 1M tokens.\n")
                } else {
                        b.WriteString("- Your rates: $" + trimCost(p.InputPerM) + " in / $" + trimCost(p.OutputPerM) +
                                " out per 1M tokens (list).\n")
                }
        } else {
                b.WriteString("- Your rates: no price data for this model — tokens only, no cost estimate.\n")
        }

        // Connected platforms (vault truth; never the secrets themselves).
        var conns []string
        if s.hub != nil && s.hub.Token() != "" {
                if u := s.hub.Username(); u != "" {
                        conns = append(conns, "Hugging Face: signed in as "+u)
                } else {
                        conns = append(conns, "Hugging Face: signed in (username unknown)")
                }
        } else {
                conns = append(conns, "Hugging Face: not connected")
        }
        if login, ok := s.accountInfo("github"); ok && login != "" {
                conns = append(conns, "GitHub: signed in as "+login)
        } else if ok {
                conns = append(conns, "GitHub: signed in")
        } else {
                conns = append(conns, "GitHub: not signed in")
        }
        if login, ok := s.accountInfo("gitea"); ok && login != "" {
                conns = append(conns, "Gitea: signed in as "+login)
        } else if ok {
                conns = append(conns, "Gitea: signed in")
        } else {
                conns = append(conns, "Gitea: not signed in")
        }
        b.WriteString("- Connected platforms: " + strings.Join(conns, "; ") + ".\n")

        // Workspaces: this chat's bound repos (with access levels) + the totals.
        var bound []string
        totalWS := 0
        if s.db != nil {
                if wss, err := s.db.ListSessionWorkspaces(sess.ID); err == nil {
                        for _, w := range wss {
                                bound = append(bound, describeWorkspace(w))
                        }
                }
                if all, err := s.db.ListWorkspaces(); err == nil {
                        totalWS = len(all)
                }
        }
        if len(bound) > 0 {
                b.WriteString("- Repos bound to this chat (" + strconv.Itoa(len(bound)) + "): " +
                        strings.Join(bound, ", ") + ".\n")
        } else {
                b.WriteString("- Repos bound to this chat: none yet.\n")
        }
        b.WriteString("- You have " + strconv.Itoa(totalWS) + " workspace(s) connected in total. You CAN be connected to workspaces — GitHub, Gitea, GitLab, Sourcehut and Hugging Face repos (models, datasets and Spaces) — many repo structures are available; the user connects them from the library/hub connect flow, and when bound the repo tools can list, grep, read and edit them at the access level shown above (read / partial / full).\n")
        if sess.Sandbox == "hf" {
                b.WriteString("- This chat's sandbox runs on your Hugging Face Space — repo tools there can't reach the device's engine bridge; run repo work in a quick (on-device) chat when the user needs it.\n")
        }
        return b.String()
}

// describeWorkspace renders one bound workspace for the block: kind + name +
// access level (e.g. "github doomalay/doomalay (full)").
func describeWorkspace(w *store.Workspace) string {
        kind := w.Kind
        if kind == "" {
                kind = "repo"
        }
        name := w.Name
        if name == "" {
                name = w.Owner + "/" + w.Repo
        }
        access := w.Access
        if access == "" {
                access = forge.AccessRead
        }
        return kind + " " + name + " (" + access + ")"
}

// compactNote appends the compaction state when relevant.
func compactNote(sess *store.Session) string {
        if sess.CompactSeq > 0 {
                return ", older turns compacted to a summary"
        }
        return ""
}

// commaI64 formats an int with thousands separators (120000 → "120,000") —
// token counts read best grouped.
func commaI64(n int64) string {
        s := strconv.FormatInt(n, 10)
        if len(s) <= 3 {
                return s
        }
        var out []byte
        for i, c := range []byte(s) {
                if i > 0 && (len(s)-i)%3 == 0 {
                        out = append(out, ',')
                }
                out = append(out, c)
        }
        return string(out)
}

// trimCost renders a small USD figure without trailing zeros (0.60 → "0.60",
// 2.4 → "2.40", 0 → "0").
func trimCost(f float64) string {
        s := strconv.FormatFloat(f, 'f', 2, 64)
        return s
}
