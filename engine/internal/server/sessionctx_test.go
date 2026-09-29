package server

import (
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestSessionContextPreamble — the v0.78.1 bot's dashboard block: with a
// real store it reports usage/context/connections/workspaces; db-less it
// still composes (guarded); the block stays compact (token budget).
func TestSessionContextPreamble(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "sx", Title: "t", Model: "deepseek-v4.1-flash", Provider: "nvidia"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        // two turns with real usage + some live text
        db.AppendEvent("sx", "user", "hello there, this is a user message", "")
        db.AppendEvent("sx", "assistant", "hi! this is an assistant reply of some length", "")
        db.AppendEvent("sx", "status", `{"state":"idle","usage":{"input_tokens":1200,"output_tokens":340}}`, "")
        db.AppendEvent("sx", "user", "second turn", "")
        db.AppendEvent("sx", "status", `{"state":"idle","usage":{"input_tokens":1600,"output_tokens":600}}`, "")

        s := &Server{db: db}
        out := s.sessionContextPreamble(sess)

        // headline + context window line (deepseek → 131072)
        if !strings.HasPrefix(out, "\n\n## Your session (live") {
                t.Fatalf("missing headline, got %.60s", out)
        }
        if !strings.Contains(out, "Context window: ~131,072 tokens") {
                t.Fatalf("missing context window line:\n%s", out)
        }
        // last real usage wins the fill: 1600 > char estimate
        if !strings.Contains(out, "this turn rides ~1,600") {
                t.Fatalf("missing real-token fill (got):\n%s", out)
        }
        // usage totals: 2 turns, 2800 in / 940 out
        if !strings.Contains(out, "This chat so far: 2 turn(s), 2,800 tokens in / 940 tokens out") {
                t.Fatalf("missing usage totals:\n%s", out)
        }
        if !strings.Contains(out, "≈$") {
                t.Fatalf("deepseek is priced — expected a cost estimate:\n%s", out)
        }
        // pricing line (deepseek → $0.27 in / $1.10 out per M)
        if !strings.Contains(out, "$0.27 in / $1.10 out per 1M tokens") {
                t.Fatalf("missing rate line:\n%s", out)
        }
        // connections (no vault in this server → not connected/not signed in)
        if !strings.Contains(out, "Connected platforms:") ||
                !strings.Contains(out, "Hugging Face: not connected") ||
                !strings.Contains(out, "GitHub: not signed in") {
                t.Fatalf("missing connections:\n%s", out)
        }
        // workspaces: none bound + the capability line
        if !strings.Contains(out, "Repos bound to this chat: none yet.") {
                t.Fatalf("missing empty-workspace line:\n%s", out)
        }
        if !strings.Contains(out, "You CAN be connected to workspaces") ||
                !strings.Contains(out, "Hugging Face repos (models, datasets and Spaces)") {
                t.Fatalf("missing capability line:\n%s", out)
        }

        // bind a workspace → it appears with its access level
        ws := &store.Workspace{Kind: "github", Name: "me/project", Owner: "me", Repo: "project", Access: "full"}
        if err := db.CreateWorkspace(ws); err != nil {
                t.Fatalf("ws: %v", err)
        }
        if err := db.BindWorkspace("sx", ws.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        out = s.sessionContextPreamble(sess)
        if !strings.Contains(out, "Repos bound to this chat (1): github me/project (full)") {
                t.Fatalf("missing bound workspace:\n%s", out)
        }
        if !strings.Contains(out, "You have 1 workspace(s) connected in total") {
                t.Fatalf("missing workspace total:\n%s", out)
        }

        // HF-sandbox chats get the honest-degradation line
        sess.Sandbox = "hf"
        out = s.sessionContextPreamble(sess)
        if !strings.Contains(out, "sandbox runs on your Hugging Face Space") {
                t.Fatalf("missing HF-sandbox note:\n%s", out)
        }
        sess.Sandbox = ""

        // db-less guard: still composes, no usage lines
        bare := (&Server{}).sessionContextPreamble(sess)
        if !strings.Contains(bare, "## Your session (live") {
                t.Fatalf("db-less compose broke:\n%s", bare)
        }
        if strings.Contains(bare, "This chat so far") {
                t.Fatalf("db-less compose should skip usage:\n%s", bare)
        }
}

// TestSessionContextPreambleCompact — a fresh session (0 turns) keeps the
// block lean and never reports zero-usage noise.
func TestSessionContextPreambleCompact(t *testing.T) {
        sess := &store.Session{ID: "fresh", Model: "some-unknown-model"}
        out := (&Server{}).sessionContextPreamble(sess)
        if strings.Contains(out, "This chat so far") {
                t.Fatalf("zero-turn session should not emit a usage line:\n%s", out)
        }
        // unpriced model → the honest "no price data" line
        if !strings.Contains(out, "no price data for this model") {
                t.Fatalf("expected unpriced line:\n%s", out)
        }
        if len(out) > 1800 {
                t.Fatalf("session block too fat for a fresh chat: %d chars", len(out))
        }
}

// TestSessionContextPreambleRidesSystemPrompt — the block is actually
// appended by the composer (all three return paths share `meta`).
func TestSessionContextPreambleRidesSystemPrompt(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "sp", Title: "t", Model: "glm-5.3", Provider: "nvidia"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        s := &Server{db: db}
        prompt := s.systemPromptFor(sess)
        if !strings.Contains(prompt, "## Your session (live") {
                t.Fatalf("session block missing from composed system prompt")
        }
        if !strings.Contains(prompt, "## This chat's controls") {
                t.Fatalf("controls block lost from composed system prompt")
        }
        if !strings.Contains(prompt, "You are glm-5.3") { // identity line still first (pretty name = last path segment)
                t.Fatalf("identity line missing")
        }
}
