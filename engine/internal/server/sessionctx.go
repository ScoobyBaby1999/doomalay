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
        // v0.81.6: NAME the tools. The old line said "the repo tools can…"
        // without ever naming them — the user's live repro watched the model
        // reason "I don't see repo tools in my tool list" and guess names
        // ("repo_list" → unknown tool). Every chat path now tells the model
        // exactly what the repo hand is called on THAT path.
        b.WriteString("- THE REPO TOOLS on this chat: the `workspace` tool (the workspace tool with {\"action\":\"…\",\"ws\":\"owner/repo\"} on the ACTION paths; the `workspace` function/tool on function-calling paths; the unbounded `explore` tool for ANY public repo without connecting). Verbs: ls, tree, read, grep, view (issues|pulls|releases|workflows|runs|commits|branches|discussions), put (push = API commit), branch, pr, pr_diff + pr_review + pr_comment + pr_merge (CODE REVIEW), issue_create + issue_comment + issue_close, discussion_post, workflow_dispatch, file_delete, release_create, fork, create, discover — the workspace tool with {\"action\":\"help\"} lists them all. Ask what a repo contains BEFORE answering from memory; never claim you lack repo access while a workspace is bound.\n")
        if sess.Sandbox == "hf" {
                b.WriteString("- This chat's sandbox runs on your Hugging Face Space — repo tools there can't reach the device's engine bridge; run repo work in a quick (on-device) chat when the user needs it.\n")
        }
        // v1.17.1 THE PIVOT: the sandbox teaching line is RETIRED — new
        // chats are quick by birth (no picker; the user stacks capabilities
        // instead, from the chat's capabilities library). The old prose
        // taught picking between quick/hf/terminal/device sandbox TYPES,
        // which no longer happens. What the model needs now: the caps
        // actually stacked on THIS chat, honestly derived from the session
        // fields (legacy hf chats keep their context line above).
        var caps []string
        if sess.WebSearch {
                caps = append(caps, "web search")
        }
        if sess.DeepResearch {
                caps = append(caps, "deep research")
        }
        if sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto {
                caps = append(caps, "library")
        }
        capsLine := "none stacked yet"
        if len(caps) > 0 {
                capsLine = strings.Join(caps, ", ")
        }
        b.WriteString("- Your capabilities (stacked by the user in this chat's capabilities library): " + capsLine + ".\n")
        // v1.20.3 THE ARM: the Termux capability is LIVE. With a bound
        // device folder the block teaches the hand (the tool's name, the
        // REAL jail roots, the verb map, the sessions model, the honesty
        // caps); without one it stays the honest one-liner (mention only
        // if the user asks).
        if sess.Termux {
                if roots := s.sessionTermuxRoots(sess.ID); len(roots) > 0 {
                        b.WriteString("- THE TERMUX HAND on this chat: the `termux` tool — a real Termux Linux shell on the user's device, jailed to this chat's bound device folders: " +
                                strings.Join(roots, ", ") + ". Verbs: exec (shell commands, workdir = the first bound folder), ls, read, write, append, rm, mkdir, grep (unlimited hits), find, pkg (install/update/remove packages), and background-process sessions — session_start {\"name\",\"command\"} launches a nohup'd process with a pid and a tailable out.log (create and kill e.g. python servers on the fly), session_list / session_log / session_kill watch and stop them. Honesty caps: output is FULL everywhere, Termux's own 100KB result bundle is the only cap (reported when it hits), exec paces at ≥4s between runs with 12 per minute, and file-destroying/device-destroying/power commands are refused. Use it whenever the user asks about their device's files or wants something run, installed or served on the phone.\n")
                } else {
                        b.WriteString("- Termux capability: ARMED but no device folder is connected yet (the user connects one via +workspace → device storage; mention only if the user asks).\n")
                }
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
