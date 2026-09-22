// forge.go — recognize any git-forge URL and talk to its API (v0.44
// workspaces wave; user spec #3: "recognizes just about any file storage
// system like GitHub").
//
// WHAT THIS PACKAGE DOES
//
// The PWA (and the brain, via the engine REST) never talks to a forge
// directly — every call is proxied engine-side, where the workspace token
// lives (vault rule, same as the HF hub). This package is that proxy
// layer: one Recognize() turns a user-pasted URL into a HostInfo (kind +
// API base + owner/repo), and Client exposes the repo surface every forge
// shares (tree, file, readme, branches, commits, issues, pulls, releases,
// actions, discussions, commit-file, fork, create-repo, user repos).
//
// SUPPORTED KINDS (verified against docs 2026-09, see docs comments in
// each adapter file):
//
//      github     github.com — REST v3; discussions via GraphQL (token only)
//      gitea      gitea.com, codeberg.org (Forgejo) + ANY self-host: when the
//                 URL isn't a known host we probe /api/v1/version — Gitea's
//                 API is GitHub-shaped enough to share the adapter
//      gitlab     gitlab.com + self-hosted gitlab (API /api/v4/projects/<id>,
//                 id = urlencoded full path)
//      sourcehut  git.sr.ht (own API shape, best-effort subset)
//      generic    anything that answers info/refs?service=git-upload-pack —
//                 the universal smart-HTTP git handshake. Browse without a
//                 clone is NOT possible on dumb hosts → read-only via a local
//                 blobless clone when the git binary exists (desktop, HF
//                 Space, Termux); on devices without git the caller surfaces
//                 an actionable message
//
// SECURITY (redteam-driven):
//   - SSRF: every dial to a user-controlled host passes GuardURL —
//     http(s) only, DNS resolved via netx and every resolved IP checked
//     against private/loopback/link-local/CGNAT ranges (a workspace URL
//     pointing at the engine itself, the LAN, or a cloud metadata endpoint
//     is refused before any TCP dial). Redirects capped at 3 and each hop
//     re-guarded.
//   - Tokens never appear in error strings or logs (redactPath strips
//     queries; auth headers are set, never printed).
//   - Response bodies capped (16MB tree / 4MB file / 2MB listing) so a
//     hostile "repo" can't OOM the engine.
package forge

import (
        "context"
        "fmt"
        "io"
        "net"
        "net/http"
        "net/url"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// forgeUA mirrors hub.hubUA (CDNs challenge the default Go UA).
const forgeUA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

// Body caps — generous for real repos, tight enough to bound memory.
const (
        maxTreeBody  = 16 << 20 // recursive trees can be multi-MB JSON
        maxFileBody  = 4 << 20  // single file content
        maxListBody  = 2 << 20  // issues/pulls/releases/commits lists
        maxProbeBody = 64 << 10 // version/info probes
)

// Access levels (user spec: "a difference between read only, partial
// access, and full access"). Determined from the repo's permissions block
// when a token is present, public otherwise.
const (
        AccessRead    = "read"    // browse only (public repo, or token w/o push)
        AccessPartial = "partial" // authenticated, no push on this repo → fork+PR path
        AccessFull    = "full"    // push permission → direct API commits / git push
)

// HostInfo is what Recognize() extracts from a user URL.
type HostInfo struct {
        Kind    string `json:"kind"`     // github|gitea|gitlab|sourcehut|generic
        Host    string `json:"host"`     // the web hostname (github.com)
        APIBase string `json:"api_base"` // https://api.github.com | …/api/v1 | ""
        WebBase string `json:"web_base"` // https://github.com
        Owner   string `json:"owner"`    // owner/org (sourcehut: with ~ prefix)
        Repo    string `json:"repo"`     // repo name (no .git)
        // ProjectPath: the FULL url path (gitlab nested groups: group/sub/repo).
        // gitlab's API ids are urlencoded full paths; the other forges only
        // ever use owner/repo.
        ProjectPath string `json:"project_path"`
}

// RepoMeta is the forge-agnostic repo card.
type RepoMeta struct {
        FullName      string `json:"full_name"`
        Description   string `json:"description"`
        DefaultBranch string `json:"default_branch"`
        Private       bool   `json:"private"`
        Stars         int    `json:"stars"`
        Forks         int    `json:"forks"`
        OpenIssues    int    `json:"open_issues"`
        UpdatedAt     string `json:"updated_at"`
        CloneURL      string `json:"clone_url"`
        WebURL        string `json:"web_url"`
        // Permissions from the token's point of view (false/false/false when
        // no token / unknown — Access() handles the mapping).
        Admin bool `json:"admin"`
        Push  bool `json:"push"`
        Pull  bool `json:"pull"`
}

// Access resolves the user spec's access level from a RepoMeta.
func (m *RepoMeta) Access(tokenPresent bool) string {
        if tokenPresent && m.Push {
                return AccessFull
        }
        if tokenPresent && m.Pull {
                return AccessPartial
        }
        return AccessRead
}

// TreeEntry is one row of a repo tree (GitHub/Gitea/GitLab shape).
type TreeEntry struct {
        Path string `json:"path"`
        Type string `json:"type"` // blob|tree
        Size int64  `json:"size"`
        SHA  string `json:"sha"`
}

// FileContent is one file's bytes + the SHA the API-commit path needs.
type FileContent struct {
        Path      string `json:"path"`
        Size      int64  `json:"size"`
        Encoding  string `json:"encoding"` // utf8|base64
        Content   string `json:"content"`
        Truncated bool   `json:"truncated"`
        SHA       string `json:"sha"` // blob sha (PUT-file fast path)
        Binary    bool   `json:"binary"`
}

// Commit is one log row.
type Commit struct {
        SHA     string `json:"sha"`
        Message string `json:"message"`
        Author  string `json:"author"`
        Date    string `json:"date"`
}

// Issue (GitHub's /issues includes PRs — IsPR keeps them distinguishable).
type Issue struct {
        Number    int    `json:"number"`
        Title     string `json:"title"`
        State     string `json:"state"`
        Author    string `json:"author"`
        UpdatedAt string `json:"updated_at"`
        IsPR      bool   `json:"is_pr"`
        Body      string `json:"body"`
        URL       string `json:"url"`
}

// PullRequest is one PR/MR row.
type PullRequest struct {
        Number    int    `json:"number"`
        Title     string `json:"title"`
        State     string `json:"state"`
        Author    string `json:"author"`
        Branch    string `json:"branch"`
        UpdatedAt string `json:"updated_at"`
        URL       string `json:"url"`
}

// Release is one release row.
type Release struct {
        Tag         string `json:"tag"`
        Name        string `json:"name"`
        PublishedAt string `json:"published_at"`
        Notes       string `json:"notes"`
        URL         string `json:"url"`
        Assets      int    `json:"assets"`
        PreRelease  bool   `json:"prerelease"`
}

// Workflow (GitHub Actions; Gitea actions share the shape best-effort).
type Workflow struct {
        ID    int64  `json:"id"`
        Name  string `json:"name"`
        Path  string `json:"path"`
        State string `json:"state"`
}

// WorkflowRun is one run of a workflow.
type WorkflowRun struct {
        ID         int64  `json:"id"`
        Name       string `json:"name"`
        Status     string `json:"status"`
        Conclusion string `json:"conclusion"`
        Event      string `json:"event"`
        Branch     string `json:"branch"`
        StartedAt  string `json:"started_at"`
        URL        string `json:"url"`
}

// Discussion (GitHub GraphQL; best-effort).
type Discussion struct {
        Number    int    `json:"number"`
        Title     string `json:"title"`
        Author    string `json:"author"`
        Category  string `json:"category"`
        UpdatedAt string `json:"updated_at"`
        URL       string `json:"url"`
}

// SearchHit is one code-search result (github: /search/code; others: the
// engine-side filtered grep).
type SearchHit struct {
        Path    string `json:"path"`
        Line    int    `json:"line"`
        Snippet string `json:"snippet"`
}

// ── URL recognition ───────────────────────────────────────────────────────

// knownHosts maps hostnames to kinds. Everything else probes.
var knownHosts = map[string]string{
        "github.com":       "github",
        "www.github.com":   "github",
        "gitlab.com":       "gitlab",
        "www.gitlab.com":   "gitlab",
        "gitea.com":        "gitea",
        "codeberg.org":     "gitea", // Forgejo speaks the Gitea API
        "git.sr.ht":        "sourcehut",
}

// Recognize parses a user URL into a HostInfo WITHOUT any network call.
// owner/repo extraction handles: /owner/repo, /owner/repo.git, trailing
// slashes/junk, sourcehut's /~user/repo, gitlab group/subgroup nesting
// (first two segments — the API resolves by full path anyway).
func Recognize(rawURL string) (HostInfo, error) {
        s := strings.TrimSpace(rawURL)
        // users paste bare "github.com/a/b" — default the scheme, but never
        // accept non-http(s) schemes (ftp:, file:, gopher:…)
        if !strings.Contains(s, "://") {
                s = "https://" + s
        }
        u, err := url.Parse(s)
        if err != nil {
                return HostInfo{}, fmt.Errorf("not a URL: %v", err)
        }
        if u.Scheme != "http" && u.Scheme != "https" {
                return HostInfo{}, fmt.Errorf("only http(s) workspace URLs are supported (got %q)", u.Scheme)
        }
        host := strings.ToLower(u.Hostname())
        kind, ok := knownHosts[host]
        if !ok {
                // Unknown host: candidate for self-hosted gitea/gitlab/generic —
                // the caller probes (ProbeHost) to decide. owner/repo parsed
                // optimistically so the probe result slots right in.
                kind = "unknown"
        }
        seg := nonEmpty(strings.Split(strings.Trim(u.Path, "/"), "/"))

        switch kind {
        case "github", "gitea", "gitlab":
                if len(seg) < 2 {
                        return HostInfo{}, fmt.Errorf("expected https://%s/<owner>/<repo>", host)
                }
                owner, repo := seg[0], strings.TrimSuffix(seg[1], ".git")
                projectPath := owner + "/" + repo
                if kind == "gitlab" && len(seg) > 2 {
                        // nested groups: group/sub/repo — repo is the LAST segment,
                        // the API id is the whole path
                        repo = strings.TrimSuffix(seg[len(seg)-1], ".git")
                        projectPath = strings.Join(seg[:len(seg)-1], "/") + "/" + repo
                }
                hi := HostInfo{Kind: kind, Host: host, WebBase: webBase(u),
                        Owner: owner, Repo: repo, ProjectPath: projectPath}
                switch kind {
                case "github":
                        hi.APIBase = "https://api.github.com"
                case "gitea":
                        hi.APIBase = hi.WebBase + "/api/v1"
                case "gitlab":
                        hi.APIBase = hi.WebBase + "/api/v4"
                }
                return hi, nil
        case "sourcehut":
                if len(seg) < 2 {
                        return HostInfo{}, fmt.Errorf("expected https://git.sr.ht/~<user>/<repo>")
                }
                owner := seg[0]
                if !strings.HasPrefix(owner, "~") {
                        owner = "~" + owner
                }
                return HostInfo{Kind: "sourcehut", Host: host, WebBase: webBase(u),
                        Owner: owner, Repo: strings.TrimSuffix(seg[1], ".git")}, nil
        }
        hi := HostInfo{Kind: "unknown", Host: host, WebBase: webBase(u), APIBase: ""}
        if len(seg) >= 2 {
                hi.Owner, hi.Repo = seg[0], strings.TrimSuffix(seg[1], ".git")
                hi.ProjectPath = hi.Owner + "/" + hi.Repo
        } else if len(seg) == 1 {
                hi.Repo = strings.TrimSuffix(seg[0], ".git")
                hi.ProjectPath = hi.Repo
        }
        return hi, nil
}

// srhtAPI is sourcehut's REST base (git.sr.ht/api — the /api prefix rides
// per-request because owner/repo path building differs).
func srhtAPI() string { return "https://git.sr.ht" }

func webBase(u *url.URL) string {
        return u.Scheme + "://" + u.Host
}

func nonEmpty(seg []string) []string {
        out := seg[:0]
        for _, s := range seg {
                if s != "" {
                        out = append(out, s)
                }
        }
        return out
}

// ── SSRF guard ────────────────────────────────────────────────────────────

// GuardURL verifies a user-controlled URL is safe to dial: http(s), the
// host resolves (via netx — the Android pure-Go-resolver path), and NO
// resolved IP is private/loopback/link-local/CGNAT/unspecified. This is
// the single chokepoint that stops a "workspace" pointing at the engine
// itself, the LAN, or a cloud metadata endpoint (169.254.169.254).
func GuardURL(ctx context.Context, rawURL string) error {
        u, err := url.Parse(strings.TrimSpace(rawURL))
        if err != nil {
                return fmt.Errorf("bad URL: %v", err)
        }
        if u.Scheme != "http" && u.Scheme != "https" {
                return fmt.Errorf("only http(s) URLs (got %q)", u.Scheme)
        }
        host := u.Hostname()
        if host == "" {
                return fmt.Errorf("URL has no host")
        }
        if net.ParseIP(host) != nil {
                if !ipIsPublic(net.ParseIP(host)) {
                        return fmt.Errorf("literal IP %s is private/reserved — blocked", host)
                }
                return nil
        }
        ips := netx.LookupIP(ctx, host)
        if len(ips) == 0 {
                return fmt.Errorf("host %s does not resolve", host)
        }
        for _, ip := range ips {
                if !ipIsPublic(ip) {
                        return fmt.Errorf("host %s resolves to a private/reserved address (%s) — blocked", host, ip)
                }
        }
        return nil
}

func ipIsPublic(ip net.IP) bool {
        if ip == nil {
                return false
        }
        if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
                ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
                return false
        }
        if v4 := ip.To4(); v4 != nil {
                // CGNAT 100.64.0.0/10 (carrier networks — not public internet)
                if v4[0] == 100 && v4[1]&0xC0 == 64 {
                        return false
                }
                return true
        }
        if b := ip.To16(); b != nil {
                // fc00::/7 unique-local (IsPrivate covers on modern Go; keep for
                // older toolchains where IsPrivate is IPv4-only)
                if b[0]&0xFE == 0xFC {
                        return false
                }
        }
        return true
}

// guardedClient builds an http.Client whose redirects re-run GuardURL on
// every hop (a public host can 302 to 127.0.0.1 — the classic SSRF bypass).
func guardedClient(timeout time.Duration) *http.Client {
        return &http.Client{
                Timeout:   timeout,
                Transport: netx.Transport(),
                CheckRedirect: func(req *http.Request, via []*http.Request) error {
                        if len(via) >= 3 {
                                return fmt.Errorf("too many redirects")
                        }
                        return GuardURL(req.Context(), req.URL.String())
                },
        }
}

// plainClient is the fixed-API-base client (api.github.com etc. — user
// input never picks the host, only the path).
func plainClient(timeout time.Duration) *http.Client {
        return &http.Client{Timeout: timeout, Transport: netx.Transport()}
}

// errBodyTooBig: an over-cap body — callers turn this into a truncation
// flag or a clean error, never a crash.
var errBodyTooBig = fmt.Errorf("response body exceeds the read cap")

// httpMaxBody reads at most limit bytes. Over-cap → errBodyTooBig.
func httpMaxBody(resp *http.Response, limit int64) ([]byte, error) {
        defer resp.Body.Close()
        buf := make([]byte, 0, 64<<10)
        tmp := make([]byte, 32<<10)
        for {
                n, rerr := resp.Body.Read(tmp)
                if n > 0 {
                        if int64(len(buf)+n) > limit {
                                return nil, errBodyTooBig
                        }
                        buf = append(buf, tmp[:n]...)
                }
                if rerr != nil {
                        if rerr == io.EOF || strings.Contains(rerr.Error(), "EOF") {
                                return buf, nil
                        }
                        if len(buf) > 0 {
                                return buf, nil // partial body is still useful
                        }
                        return nil, rerr
                }
        }
}
