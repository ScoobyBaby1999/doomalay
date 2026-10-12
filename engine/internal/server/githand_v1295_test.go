package server

// githand_v1295_test.go — v1.29.5 THE GITHUB HAND (PLAN-V130 §5):
// git_setup arms the vault's GitHub token inside Termux through the
// EXTRA_STDIN bridge lane (the token never rides a command string, the
// persisted args, or the observation), and the persistence redaction
// kills the pasted-PAT hazard.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1295_GitSetup_ArmsTheToken — the vault carries a GITHUB_PAT; the
// verb writes ~/.git-credentials (0600, credential.helper=store, the
// identity) inside the fake bridge's REAL bash + temp HOME; the token
// rides ONLY the bridge body's stdin field.
func TestV1295_GitSetup_ArmsTheToken(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "gitarm", root)

	tok := "ghp_testtoken1234567890abcdef"
	if s.vault == nil {
		t.Fatalf("the test server needs a vault")
	}
	if err := s.vault.Set("GITHUB_PAT", "github", tok, ""); err != nil {
		t.Fatalf("vault set: %v", err)
	}

	out := tool(s, "gitarm", "git_setup", `{}`)
	if !strings.Contains(out, "GIT ARMED") {
		t.Fatalf("the armed observation, got:\n%s", out)
	}
	if !strings.Contains(out, "credential.helper: store") {
		t.Fatalf("the script's honest report, got:\n%s", out)
	}
	// the observation NEVER carries the token
	if strings.Contains(out, tok) || strings.Contains(out, "ghp_") {
		t.Fatalf("THE TOKEN LEAKED into the observation:\n%s", out)
	}

	// the bridge body: the token rode STDIN, never the command string
	fb.mu.Lock()
	body := fb.lastBody
	fb.mu.Unlock()
	cmd, _ := body["command"].(string)
	stdin, _ := body["stdin"].(string)
	if strings.Contains(cmd, tok) {
		t.Fatalf("THE TOKEN LEAKED into the command string (persisted as tool_use args)")
	}
	if !strings.Contains(stdin, tok+"@github.com") {
		t.Fatalf("the credential line must ride stdin, got: %q", stdin)
	}

	// the REAL file landed in the fake HOME with the law (0600 + the line)
	credPath := filepath.Join(fb.home, ".git-credentials")
	raw, err := os.ReadFile(credPath)
	if err != nil {
		t.Fatalf("the credentials file never landed: %v", err)
	}
	if !strings.Contains(string(raw), tok+"@github.com") {
		t.Fatalf("the credentials line, got: %q", string(raw))
	}
	st, _ := os.Stat(credPath)
	if st.Mode().Perm() != 0600 {
		t.Fatalf("the credentials file must be 0600, got %v", st.Mode().Perm())
	}

	// the identity + helper landed in the same HOME
	cfg, err := os.ReadFile(filepath.Join(fb.home, ".gitconfig"))
	if err != nil {
		t.Fatalf("the git config never landed: %v", err)
	}
	if !strings.Contains(string(cfg), "credential") || !strings.Contains(string(cfg), "helper = store") {
		t.Fatalf("the credential.helper config, got: %q", string(cfg))
	}
}

// TestV1295_GitSetup_NoTokenRefusal — no vault token → the honest
// refusal naming the connect flow; the bridge is never touched.
func TestV1295_GitSetup_NoTokenRefusal(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "gitref", root)

	out := tool(s, "gitref", "git_setup", `{}`)
	if !strings.Contains(out, "no GitHub token in the vault") {
		t.Fatalf("the honest refusal, got:\n%s", out)
	}
	if fb.runCount() != 0 {
		t.Fatalf("a token-less git_setup must never touch the bridge (runs=%d)", fb.runCount())
	}
}

// TestV1295_Redaction_UserAndToolEventsPersistRedacted — the pasted-PAT
// hazard dies at the persistence boundary (the Doobie transcript's last
// line: "Here is a GitHub pat to make pushing easier: ghp_…").
func TestV1295_Redaction_UserAndToolEventsPersistRedacted(t *testing.T) {
	s := newTermuxTestServer(t, "")
	s.db.CreateSession(&store.Session{ID: "red1", Title: "t"})

	// the user event (emit path)
	s.emit(nil, "red1", "user", "Here is a GitHub pat to make pushing easier: " + testToken() + "", "")
	evs, _ := s.db.ListEvents("red1", 0)
	if len(evs) == 0 {
		t.Fatalf("the user event never persisted")
	}
	if strings.Contains(evs[0].Content, testToken()[:11]) {
		t.Fatalf("THE PAT SURVIVED the user-event persistence: %q", evs[0].Content)
	}
	if !strings.Contains(evs[0].Content, "‹redacted:key›") {
		t.Fatalf("the redaction marker should ride: %q", evs[0].Content)
	}

	// the tool event (forwardEvents' persist switch) — a tool_use whose
	// args embed a token
	s.db.CreateSession(&store.Session{ID: "red2", Title: "t"})
	s.emit(nil, "red2", "tool_use", `{"name":"termux","args":"{\"command\":\"git push https://user:" + testToken() + "@github.com/o/r\"}"}`, "")
	evs, _ = s.db.ListEvents("red2", 0)
	if len(evs) == 0 || strings.Contains(evs[0].Content, testToken()[:11]) {
		t.Fatalf("THE PAT SURVIVED the tool-event persistence: %q", evs[0].Content)
	}

	// the tool_result with an echoed token
	s.emit(nil, "red2", "tool_result", `{"name":"termux","text":"pushed with " + testToken() + " ok"}`, "")
	evs, _ = s.db.ListEvents("red2", 0)
	for _, ev := range evs {
		if strings.Contains(ev.Content, testToken()[:11]) {
			t.Fatalf("THE PAT SURVIVED somewhere in the tool events: %q", ev.Content)
		}
	}
}

// TestV1295_GitSetup_TaughtEverywhere — the help text + the verbs
// registry teach git_setup (the model discovers the verb).
func TestV1295_GitSetup_TaughtEverywhere(t *testing.T) {
	fb := newFakeArmBridge(t)
	s := newArmServer(t, fb)
	root := t.TempDir()
	armTermuxChat(t, s, "taught", root)

	out := tool(s, "taught", "help", `{}`)
	if !strings.Contains(out, "git_setup") {
		t.Fatalf("the help must teach git_setup:\n%s", out)
	}
	if !strings.Contains(termuxVerbs, "git_setup") {
		t.Fatalf("the verbs registry must carry git_setup")
	}
}

// TestV1295_WorkspaceTags_HonestRefusal — HF/sourcehut carry no tag API:
// ErrUnsupported surfaces honestly through the view + the verb.
func TestV1295_WorkspaceTags_HonestRefusal(t *testing.T) {
	s := newTermuxTestServer(t, "")
	s.db.CreateSession(&store.Session{ID: "tgh", Title: "t"})
	// an HF workspace bound to the chat
	ws := &store.Workspace{Kind: "hf", Host: "huggingface.co", Owner: "o", Repo: "r", Name: "o/r", Access: "full"}
	if err := s.db.CreateWorkspace(ws); err != nil {
		t.Fatalf("ws: %v", err)
	}
	s.db.BindWorkspace("tgh", ws.ID)

	out := s.runWorkspaceAction(context.Background(), "tgh", `{"action":"view","ws":"o/r","what":"tags"}`)
	if !strings.Contains(out, "error:") && !strings.Contains(out, "unsupported") {
		t.Fatalf("HF must refuse tags honestly, got:\n%s", out)
	}
}
