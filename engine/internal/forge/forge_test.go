// forge_test.go — offline unit tests for the forge package.
//
// No network: Recognize/GuardURL-literal/buildFileContent are pure; the
// HTTP adapters are exercised in the live redteam round (workspaces
// handlers against real forges) — here we pin the URL grammar, the SSRF
// literal-IP rules and the range slicing the file endpoints ride on.
package forge

import (
	"strings"
	"testing"
)

func TestRecognize(t *testing.T) {
	cases := []struct {
		url    string
		kind   string
		owner  string
		repo   string
		api    string
	}{
		{"https://github.com/ScoobyBaby1999/doomalay", "github", "ScoobyBaby1999", "doomalay", "https://api.github.com"},
		{"https://www.github.com/a/b.git", "github", "a", "b", "https://api.github.com"},
		{"https://github.com/a/b/", "github", "a", "b", "https://api.github.com"},
		{"https://codeberg.org/forgejo/forgejo", "gitea", "forgejo", "forgejo", "https://codeberg.org/api/v1"},
		{"https://gitea.com/octo/doodles", "gitea", "octo", "doodles", "https://gitea.com/api/v1"},
		{"https://gitlab.com/gitlab-org/gitlab", "gitlab", "gitlab-org", "gitlab", "https://gitlab.com/api/v4"},
		{"https://gitlab.com/group/sub/repo", "gitlab", "group", "repo", "https://gitlab.com/api/v4"},
		{"https://git.sr.ht/~sircmpwn/scdoc", "sourcehut", "~sircmpwn", "scdoc", ""},
		{"https://git.sr.ht/sircmpwn/scdoc", "sourcehut", "~sircmpwn", "scdoc", ""},
		{"https://example.invalid/a/b", "unknown", "a", "b", ""},
		{"https://example.invalid/onlyrepo", "unknown", "", "onlyrepo", ""},
	}
	for _, c := range cases {
		hi, err := Recognize(c.url)
		if err != nil {
			t.Fatalf("Recognize(%q): %v", c.url, err)
		}
		if hi.Kind != c.kind || hi.Owner != c.owner || hi.Repo != c.repo {
			t.Errorf("Recognize(%q) = %+v (want kind=%s owner=%s repo=%s)", c.url, hi, c.kind, c.owner, c.repo)
		}
		if c.api != "" && hi.APIBase != c.api {
			t.Errorf("Recognize(%q).APIBase = %q (want %q)", c.url, hi.APIBase, c.api)
		}
	}
	// gitlab nested: project path keeps the whole chain
	hi, _ := Recognize("https://gitlab.com/group/sub/repo")
	if hi.ProjectPath != "group/sub/repo" {
		t.Errorf("gitlab ProjectPath = %q (want group/sub/repo)", hi.ProjectPath)
	}
	// scheme rejection
	if _, err := Recognize("ftp://github.com/a/b"); err == nil {
		t.Error("ftp scheme must be rejected")
	}
	if _, err := Recognize("github.com/a/b"); err != nil {
		t.Errorf("scheme-less URL should still parse (http default), got %v", err)
	}
	if _, err := Recognize("https://github.com/onlyowner"); err == nil {
		t.Error("owner-only github URL must be rejected")
	}
}

func TestGuardLiteralIPs(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1:8080/api/x",     // loopback
		"http://10.0.0.5/",                // private A
		"http://172.16.1.1/",              // private B
		"http://192.168.1.10/engine",      // private C
		"http://169.254.169.254/meta",     // cloud metadata
		"http://100.64.0.1/",              // CGNAT
		"http://[::1]:8080/",              // v6 loopback
		"http://0.0.0.0/",                 // unspecified
		"file:///etc/passwd",              // scheme
	}
	for _, u := range blocked {
		if err := GuardURL(t.Context(), u); err == nil {
			t.Errorf("GuardURL(%q) must block", u)
		}
	}
	public := []string{
		"http://1.1.1.1/", "https://8.8.8.8/", "http://93.184.216.34/",
	}
	for _, u := range public {
		if err := GuardURL(t.Context(), u); err != nil {
			t.Errorf("GuardURL(%q) must pass (%v)", u, err)
		}
	}
}

func TestBuildFileContentRanges(t *testing.T) {
	text := "l1\nl2\nl3\nl4\nl5"
	raw := []byte(text)

	fc := buildFileContent("a.txt", "sha1", raw, "")
	if fc.Encoding != "utf8" || fc.Content != text || fc.Binary || fc.Truncated {
		t.Errorf("whole file: %+v", fc)
	}
	fc = buildFileContent("a.txt", "sha1", raw, "head:2")
	if fc.Content != "l1\nl2" || !fc.Truncated {
		t.Errorf("head:2 = %q", fc.Content)
	}
	fc = buildFileContent("a.txt", "sha1", raw, "tail:2")
	if fc.Content != "l4\nl5" || !fc.Truncated {
		t.Errorf("tail:2 = %q", fc.Content)
	}
	fc = buildFileContent("a.txt", "sha1", raw, "lines:2-4")
	if fc.Content != "l2\nl3\nl4" || !fc.Truncated {
		t.Errorf("lines:2-4 = %q", fc.Content)
	}
	fc = buildFileContent("a.txt", "sha1", raw, "lines:3")
	if fc.Content != "l3" {
		t.Errorf("lines:3 = %q", fc.Content)
	}
	// range over range shorter than file → not truncated
	fc = buildFileContent("a.txt", "sha1", raw, "head:50")
	if fc.Truncated || fc.Content != text {
		t.Errorf("head:50 must be the whole file, truncated=%v", fc.Truncated)
	}
	// binary sniff → base64, range yields empty + truncated note
	bin := []byte{0x00, 0x01, 0x02, 0xff}
	fc = buildFileContent("b.bin", "", bin, "")
	if !fc.Binary || fc.Encoding != "base64" || fc.Content == "" {
		t.Errorf("binary whole: %+v", fc)
	}
	fc = buildFileContent("b.bin", "", bin, "head:2")
	if !fc.Binary || !fc.Truncated || fc.Content != "" {
		t.Errorf("binary range: %+v", fc)
	}
}

func TestClipAndLimits(t *testing.T) {
	if clip(strings.Repeat("x", 500), 100) != strings.Repeat("x", 100)+"…" {
		t.Error("clip must add the ellipsis")
	}
	if clampLimit(0, 30) != 30 || clampLimit(-5, 30) != 30 {
		t.Error("clamp lower bound")
	}
	if clampLimit(5000, 30) != 100 {
		t.Error("clamp upper bound")
	}
	if clampLimit(7, 30) != 7 {
		t.Error("clamp passthrough")
	}
	if firstLine("subject\n\nbody") != "subject" {
		t.Error("firstLine")
	}
}

func TestRepoMetaAccess(t *testing.T) {
	m := &RepoMeta{}
	if m.Access(false) != AccessRead || m.Access(true) != AccessRead {
		t.Error("no permissions → read")
	}
	m.Pull = true
	if m.Access(true) != AccessPartial {
		t.Error("pull only → partial")
	}
	if m.Access(false) != AccessRead {
		t.Error("token-less is always read")
	}
	m.Push = true
	if m.Access(true) != AccessFull {
		t.Error("push → full")
	}
}
