// v1192_unbound_hand_test.go — v1.19.2 THE UNBOUND HAND pins (PLAN-V119 §2).
//
// The old gate: EVERY workspace verb refused without a bound workspace —
// even public reads ("no cloud workspace is connected to this chat yet",
// the user's live repro: three refusals on mark3labs/mcp-go). The new law:
// the gate moves from "a workspace is BOUND" to "the operation needs a
// token". Public reads run unbound; writes still teach the connection.
package server

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
)

func TestPublicWorkspaceRefMatrix(t *testing.T) {
	cases := []struct {
		ref    string
		want   string // "" = nil
		kind   string
		owner  string
		repo   string
	}{
		{"mark3labs/mcp-go", "public:mark3labs/mcp-go", "github", "mark3labs", "mcp-go"},
		{"https://github.com/ScoobyBaby1999/doomalay", "public:ScoobyBaby1999/doomalay", "github", "ScoobyBaby1999", "doomalay"},
		{"https://gitlab.com/group/sub/repo", "public:group/repo", "gitlab", "group", "repo"},
		{"https://git.sr.ht/~sircmpwn/scdoc", "public:~sircmpwn/scdoc", "sourcehut", "~sircmpwn", "scdoc"},
		// NOT repo refs — bound-row lookups and the teach text own these
		{"", "", "", "", ""},
		{"fullrepo", "", "", "", ""},               // a bare name = a bound-row ref
		{"https://example.invalid/a/b", "", "", "", ""}, // unknown forge
		{"docs/file.txt", "", "", "", ""},          // a path is not a repo
		{"o/r/s", "", "", "", ""},                  // three segments, no dot → not a URL, not owner/repo
	}
	for _, c := range cases {
		ws := publicWorkspaceRef(c.ref)
		if c.want == "" {
			if ws != nil {
				t.Errorf("publicWorkspaceRef(%q) = %+v, want nil", c.ref, ws)
			}
			continue
		}
		if ws == nil {
			t.Errorf("publicWorkspaceRef(%q) = nil, want %q", c.ref, c.want)
			continue
		}
		if ws.ID != c.want || ws.Kind != c.kind || ws.Owner != c.owner || ws.Repo != c.repo {
			t.Errorf("publicWorkspaceRef(%q) = id=%s kind=%s owner=%s repo=%s", c.ref, ws.ID, ws.Kind, ws.Owner, ws.Repo)
		}
		if ws.Access != forge.AccessRead {
			t.Errorf("publicWorkspaceRef(%q).Access = %q, want read", c.ref, ws.Access)
		}
		if !isPublicRefRow(ws) {
			t.Errorf("publicWorkspaceRef(%q) not flagged as a public row", c.ref)
		}
	}
}

func TestPublicReadVerbGate(t *testing.T) {
	for _, a := range []string{"info", "tree", "ls", "read", "readme", "grep", "view"} {
		if !publicReadVerb(a) {
			t.Errorf("publicReadVerb(%q) = false, want true", a)
		}
	}
	for _, a := range []string{"put", "pr", "fork", "create", "issue_create", "pr_merge", "release_create", "file_delete", "workflow_dispatch", "discover", "branch", "list", "help"} {
		if publicReadVerb(a) {
			t.Errorf("publicReadVerb(%q) = true, want false", a)
		}
	}
}

// TestUnboundPublicReadWorks: no bound workspaces at all — a public owner/repo
// read must go THROUGH (the user's exact repro shape).
func TestUnboundPublicReadWorks(t *testing.T) {
	s, _ := newV765Server(t) // fake GitHub under forge.GitHubAPIBase
	out := s.runWorkspaceVerb(context.Background(), nil, map[string]any{
		"action": "read", "ws": "me/fullrepo", "path": "README.md",
	})
	if strings.HasPrefix(out, "OBSERVATION:\nerror") {
		t.Fatalf("unbound public read refused — the unbound hand is broken:\n%s", out)
	}
	if !strings.Contains(out, "OBSERVATION:") {
		t.Fatalf("read lost the OBSERVATION shape:\n%s", out)
	}
}

// TestUnboundWriteRefused: writes on an unbound public ref teach the
// connection (the one gate that is the system's — a token is genuinely
// required) and NEVER reach the forge.
func TestUnboundWriteRefused(t *testing.T) {
	s, _ := newV765Server(t)
	for _, action := range []string{"put", "pr", "fork", "issue_create", "release_create"} {
		out := s.runWorkspaceVerb(context.Background(), nil, map[string]any{
			"action": action, "ws": "someone/elsewhere",
		})
		if !strings.Contains(out, "READ-ONLY") || !strings.Contains(out, "+workspace pill") {
			t.Fatalf("action %q on an unbound ref must teach the read-only gate, got:\n%s", action, out)
		}
	}
}

// TestUnboundListTeachesPublicHand: the zero-bound "list" answer must name
// the unbound public read capability (the model learns it exists).
func TestUnboundListTeachesPublicHand(t *testing.T) {
	s, _ := newV765Server(t)
	out := s.runWorkspaceVerb(context.Background(), nil, map[string]any{"action": "list"})
	if !strings.Contains(out, "PUBLIC repos still work unbound") || !strings.Contains(out, "owner/repo") {
		t.Fatalf("unbound list must teach the public hand, got:\n%s", out)
	}
}

// TestUnboundManifestTeachesPublicHand: the system prompt block for zero-bound
// chats teaches the public read verbs (so the model never hand-rolls fetches).
func TestUnboundManifestTeachesPublicHand(t *testing.T) {
	s := &Server{} // no db → zero bound workspaces
	m := s.workspaceManifestFor("any-session")
	if !strings.Contains(m, "PUBLIC REPO ACCESS") || !strings.Contains(m, "\"action\":\"read\"") {
		t.Fatalf("unbound manifest must teach the public hand, got:\n%s", m)
	}
}

// TestLiveUnboundPublicRead (DOOMALAY_LIVE=1): the user's EXACT repro —
// three calls against the real mark3labs/mcp-go with nothing bound.
func TestLiveUnboundPublicRead(t *testing.T) {
	if os.Getenv("DOOMALAY_LIVE") != "1" {
		t.Skip("live probe — set DOOMALAY_LIVE=1")
	}
	s := &Server{} // no db, no vault — the pure tokenless hand
	// readme/read ride the raw CDN (no API ceiling) — they must SUCCEED
	// tokenless, full content. tree/ls ride the API, whose anonymous 60 req/h
	// ceiling a shared CI IP may have burned — those may fail, but ONLY with
	// the honest rate-limit teach, never a bare 403.
	out := s.runWorkspaceVerb(context.Background(), nil, map[string]any{"action": "readme", "ws": "mark3labs/mcp-go"})
	if strings.HasPrefix(out, "OBSERVATION:\nerror") {
		t.Fatalf("live unbound readme failed:\n%s", out)
	}
	t.Logf("readme → %d bytes of observation (real GitHub, nothing bound)", len(out))
	out = s.runWorkspaceVerb(context.Background(), nil, map[string]any{"action": "read", "ws": "mark3labs/mcp-go", "path": "README.md"})
	if strings.HasPrefix(out, "OBSERVATION:\nerror") || !strings.Contains(out, "mcp-go") {
		t.Fatalf("live unbound read failed:\n%s", out)
	}
	t.Logf("read README.md → %d bytes", len(out))
	out = s.runWorkspaceVerb(context.Background(), nil, map[string]any{"action": "ls", "ws": "mark3labs/mcp-go"})
	if strings.Contains(out, "HTTP 403") && !strings.Contains(out, "rate-limited") {
		t.Fatalf("ls 403 must carry the honest rate-limit teach:\n%s", out)
	}
	t.Logf("ls → %d bytes (success or the honest teach)", len(out))
}
