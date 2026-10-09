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

        // headline + context window line (deepseek-v4.1-flash → the
        // models.dev snapshot's 327680; the old curated guess was 131072)
        if !strings.HasPrefix(out, "\n\n## Your session (live") {
                t.Fatalf("missing headline, got %.60s", out)
        }
        if !strings.Contains(out, "Context window: ~327,680 tokens") {
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
        // pricing line (deepseek-v4.1-flash → snapshot $0.04 in / $0.08
        // out per 1M; the old curated deepseek guess was 0.27/1.10)
        if !strings.Contains(out, "$0.04 in / $0.08 out per 1M tokens") {
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
        // v1.17.1 THE PIVOT: the sandbox-type teaching is RETIRED (the
        // picker died; quick by birth) — the line now teaches the STACKED
        // CAPABILITIES, and the Termux capability gets its own honest
        // inert note when armed.
        if !strings.Contains(out, "Your capabilities (stacked by the user in this chat's capabilities library): none stacked yet") {
                t.Fatalf("expected the capabilities line for a default chat:\n%s", out)
        }
        if strings.Contains(out, "quick / hf / terminal / device") || strings.Contains(out, "Your sandbox:") {
                t.Fatalf("the sandbox-type teaching survived the pivot:\n%s", out)
        }
        sess.Termux = true
        out = (&Server{}).sessionContextPreamble(sess)
        if !strings.Contains(out, "Termux capability: ARMED but no device folder is connected yet") {
                t.Fatalf("expected the armed-but-no-folder line when stacked:\n%s", out)
        }
        sess.Termux = false
        if len(out) > 1800 {
                t.Fatalf("session block too fat for a fresh chat: %d chars", len(out))
        }
}

// TestSessionContextPreambleTermuxArm — v1.20.3 THE ARM: with the ⌨
// capability stacked AND a bound device folder, the block teaches the
// termux hand (the tool's name, the REAL jail roots, the verbs, the
// sessions model, the honesty caps); the v1.17.1 inert note is retired.
func TestSessionContextPreambleTermuxArm(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "tarm", Title: "t", Model: "deepseek-v4.1-flash", Provider: "nvidia", Termux: true}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        ws := &store.Workspace{Kind: "termux", Name: "device", Access: "full",
                Meta: `{"termux_path":"/storage/emulated/0/Doomalay"}`}
        if err := db.CreateWorkspace(ws); err != nil {
                t.Fatalf("ws: %v", err)
        }
        if err := db.BindWorkspace("tarm", ws.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }
        s := &Server{db: db}
        out := s.sessionContextPreamble(sess)
        if !strings.Contains(out, "THE TERMUX HAND on this chat: the `termux` tool") {
                t.Fatalf("missing the armed teach headline:\n%s", out)
        }
        if !strings.Contains(out, "/storage/emulated/0/Doomalay") {
                t.Fatalf("the teach must carry the REAL jail root:\n%s", out)
        }
        for _, pin := range []string{
                "session_start {\"name\",\"command\"} launches a nohup'd process",
                "session_list / session_log / session_kill watch and stop them",
                "Termux's own 100KB result bundle is the only cap",
                "exec paces at ≥4s between runs with 12 per minute",
        } {
                if !strings.Contains(out, pin) {
                        t.Fatalf("missing teach pin %q:\n%s", pin, out)
                }
        }
        if strings.Contains(out, "tools arrive next update") {
                t.Fatalf("the v1.17.1 inert note survived THE ARM:\n%s", out)
        }
        // a bound termux row WITHOUT a termux_path (no meta) is skipped —
        // the good root still arms the teach
        ws2 := &store.Workspace{Kind: "termux", Name: "broken", Access: "full"}
        if err := db.CreateWorkspace(ws2); err != nil {
                t.Fatalf("ws2: %v", err)
        }
        if err := db.BindWorkspace("tarm", ws2.ID); err != nil {
                t.Fatalf("bind2: %v", err)
        }
        out2 := s.sessionContextPreamble(sess)
        if !strings.Contains(out2, "THE TERMUX HAND on this chat") {
                t.Fatalf("the good root still arms the teach:\n%s", out2)
        }
        // the rootless row must not leak into the TEACH's jail list (it may
        // legitimately appear in the generic bound-workspaces line above).
        teach := out2[strings.Index(out2, "THE TERMUX HAND"):]
        if strings.Contains(teach, "broken") {
                t.Fatalf("a rootless termux row leaked into the teach's jail list:\n%s", teach)
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

// TestMetadataPreamblePillLedger — v0.82.1 THE PILL LEDGER (user spec:
// "let's have the chat know it has a metadata with tweak-able settings
// and all the pills"). The metadata block names EVERY pill the chat UI
// renders — the workspaces +workspace badge (live bound list), the
// bundle pill right of the lib pill (live armed name), the mind pill —
// plus the answer-from-this-block rule, so the bot can never again
// answer "I don't have any information about a workspaces pill".
func TestMetadataPreamblePillLedger(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        sess := &store.Session{ID: "pl", Title: "t", Model: "privatemodeai/kimi-k2.6", Provider: "privatemodeai",
                Effort: "med", SlidingWindow: 40}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        // one connected workspace, bound to this chat
        ws := &store.Workspace{Kind: "github", Owner: "ScoobyBaby1999", Repo: "doomalay-ws-write-test",
                Name: "ScoobyBaby1999/doomalay-ws-write-test", Access: "full", Branch: "main"}
        if err := db.CreateWorkspace(ws); err != nil {
                t.Fatalf("workspace: %v", err)
        }
        if err := db.BindWorkspace("pl", ws.ID); err != nil {
                t.Fatalf("bind: %v", err)
        }

        s := &Server{db: db}
        out := s.chatMetadataPreamble(sess, "")

        if !strings.Contains(out, "workspaces (the +workspace badge on the toolbar, right of the lib pill)") {
                t.Fatalf("missing the workspaces pill line:\n%s", out)
        }
        if !strings.Contains(out, "currently 1 (github ScoobyBaby1999/doomalay-ws-write-test (full))") {
                t.Fatalf("missing the live bound list:\n%s", out)
        }
        if !strings.Contains(out, "bundle (the small pill immediately right of the lib pill)") {
                t.Fatalf("missing the bundle pill line:\n%s", out)
        }
        if !strings.Contains(out, "context (the mind pill + ✦ tweaks → mind): the last 40 messages") {
                t.Fatalf("missing the mind pill line:\n%s", out)
        }
        if !strings.Contains(out, "answer from THIS block") {
                t.Fatalf("missing the answer-from-this-block rule:\n%s", out)
        }

        // the armed bundle name rides the turn (not the session)
        armed := s.chatMetadataPreamble(sess, "superpowers-core")
        if !strings.Contains(armed, `currently armed: "superpowers-core"`) {
                t.Fatalf("missing the live armed bundle:\n%s", armed)
        }
        // unbound chat: the honest none-yet shape
        if !strings.Contains(s.chatMetadataPreamble(&store.Session{ID: "none", Effort: "med"}, ""), "NO repo is bound to this chat yet") {
                t.Fatalf("missing the unbound shape")
        }
}

// TestBundleNameOf — the manifest-text label extraction for the pill
// ledger's live bundle state.
func TestBundleNameOf(t *testing.T) {
        cases := []struct{ in, want string }{
                {"", ""},
                {"some other preamble", ""},
                {"THE ATTACHED BUNDLE — superpowers-core (#tag) — 4 members\nThe user attached…", "superpowers-core"},
                {"THE ATTACHED BUNDLE — my-bundle — 2 members\n", "my-bundle"},
        }
        for _, c := range cases {
                if got := bundleNameOf(c.in); got != c.want {
                        t.Fatalf("bundleNameOf(%q) = %q, want %q", c.in, got, c.want)
                }
        }
}
