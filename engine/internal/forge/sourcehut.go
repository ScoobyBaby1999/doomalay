// sourcehut.go + probe + generic — the remaining adapters.
//
// SOURCEHUT (git.sr.ht API, verified against man.sr.ht/git.sr.ht 2026-09):
//
//      GET /api/~<user>/<repo>            → repo meta
//      GET /api/~<user>/<repo>/refs       → branches/tags (results[])
//      GET /api/~<user>/<repo>/tree/<ref> → tree entries (single level)
//      GET /api/~<user>/<repo>/blob/<ref>/<path>?  → file (raw)
//      GET /api/~<user>/<repo>/log        → commits
//
// No issues/releases/actions API on git.sr.ht itself (todo.sr.ht is a
// separate service) → those ops return ErrUnsupported.
//
// PROBE (self-hosted hosts): /api/v1/version answers on Gitea;
// /api/v4/version answers on GitLab; info/refs?service=git-upload-pack
// answers on ANY git host (the smart-HTTP handshake). First hit wins.
//
// GENERIC: browse via local blobless clone (git binary required —
// desktop/HF Space/Termux). The clone lives under the engine's data dir
// (workspaces.go owns the path); this adapter shells out read-only.
package forge

import (
        "context"
        "encoding/json"
        "fmt"
        "net/url"
        "os/exec"
        "path/filepath"
        "strings"
)

// ── sourcehut ─────────────────────────────────────────────────────────────

func (c *Client) shPath() string {
        return "/api/" + c.host.Owner + "/" + c.host.Repo
}

func (c *Client) shRepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
        var m struct {
                Name        string `json:"name"`
                Description string `json:"description"`
                Visibility  string `json:"visibility"`
                Updated     string `json:"updated"`
        }
        // sourcehut wants a token even for public reads (OAuth2/personal)
        if err := c.shGetJSON(ctx, c.shPath(), token, &m, maxListBody); err != nil {
                return nil, err
        }
        full := strings.TrimPrefix(c.host.Owner, "~") + "/" + c.host.Repo
        return &RepoMeta{FullName: full, Description: m.Description,
                DefaultBranch: "main", Private: m.Visibility != "public",
                UpdatedAt: m.Updated,
                WebURL: "https://git.sr.ht/" + c.host.Owner + "/" + c.host.Repo,
                CloneURL: "https://git.sr.ht/" + c.host.Owner + "/" + c.host.Repo + ".git"}, nil
}

func (c *Client) shTree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
        if ref == "" {
                ref = "HEAD"
        }
        var v struct {
                Entries []struct {
                        Name string `json:"name"`
                        Type string `json:"type"` // blob|tree
                        Size int64  `json:"size"`
                } `json:"entries"`
        }
        p := c.shPath() + "/tree/" + url.PathEscape(ref) + "/" + strings.Trim(path, "/")
        if err := c.shGetJSON(ctx, p, token, &v, maxTreeBody); err != nil {
                return nil, false, err
        }
        out := make([]TreeEntry, 0, len(v.Entries))
        prefix := strings.Trim(path, "/")
        for _, e := range v.Entries {
                p2 := e.Name
                if prefix != "" {
                        p2 = prefix + "/" + e.Name
                }
                typ := "blob"
                if e.Type == "tree" || e.Type == "directory" {
                        typ = "tree"
                }
                out = append(out, TreeEntry{Path: p2, Type: typ, Size: e.Size})
        }
        return out, false, nil
}

func (c *Client) shFile(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
        if ref == "" {
                ref = "HEAD"
        }
        p := c.shPath() + "/blob/" + url.PathEscape(ref) + "/" + strings.TrimPrefix(path, "/")
        data, err := c.do(ctx, "GET", srhtAPI()+p, token, nil, "", maxFileBody)
        if err != nil {
                return nil, err
        }
        return buildFileContent(path, "", data, rangeSpec), nil
}

func (c *Client) shBranches(ctx context.Context, token string) ([]string, error) {
        var v struct {
                Results []struct {
                        Name string `json:"name"`
                } `json:"results"`
        }
        if err := c.shGetJSON(ctx, c.shPath()+"/refs", token, &v, maxListBody); err != nil {
                return nil, err
        }
        out := make([]string, 0, len(v.Results))
        for _, r := range v.Results {
                out = append(out, r.Name)
        }
        return out, nil
}

func (c *Client) shCommits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
        limit = clampLimit(limit, 30)
        var v struct {
                Results []struct {
                        ID      string `json:"id"`
                        Message string `json:"message"` // subject\n\nbody
                        Author  struct {
                                Name string `json:"name"`
                        } `json:"author"`
                        Timestamp string `json:"timestamp"`
                } `json:"results"`
        }
        if err := c.shGetJSON(ctx, c.shPath()+"/log", token, &v, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Commit, 0, len(v.Results))
        for i, r := range v.Results {
                if i >= limit {
                        break
                }
                out = append(out, Commit{SHA: r.ID, Message: firstLine(r.Message),
                        Author: r.Author.Name, Date: r.Timestamp})
        }
        return out, nil
}

func (c *Client) shGetJSON(ctx context.Context, path, token string, out any, limit int64) error {
        data, err := c.do(ctx, "GET", srhtAPI()+path, token, nil, "", limit)
        if err != nil {
                return err
        }
        return json.Unmarshal(data, out)
}

// ── host probe (self-hosted forges) ──────────────────────────────────────

// ProbeHost decides the kind of an "unknown" HostInfo by probing the
// host's API surfaces (all GuardURL'd). Order: Gitea /api/v1/version →
// GitLab /api/v4/version → info/refs (any git). A Gitea answer also
// carries the API base; GitLab likewise; generic keeps the web base.
func ProbeHost(ctx context.Context, hi HostInfo) (HostInfo, error) {
        if hi.Kind != "unknown" {
                return hi, nil
        }
        // 1) Gitea/Forgejo
        var ver struct {
                Version string `json:"version"`
        }
        c := NewClient(HostInfo{Kind: "gitea", Host: hi.Host, WebBase: hi.WebBase,
                APIBase: hi.WebBase + "/api/v1"})
        if err := c.gtGetJSON(ctx, "/version", "", &ver, maxProbeBody); err == nil && ver.Version != "" {
                hi.Kind = "gitea"
                hi.APIBase = hi.WebBase + "/api/v1"
                return hi, nil
        }
        // 2) GitLab
        var glVer struct {
                Version  string `json:"version"`
                Revision string `json:"revision"`
        }
        glc := NewClient(HostInfo{Kind: "gitlab", Host: hi.Host, WebBase: hi.WebBase,
                APIBase: hi.WebBase + "/api/v4"})
        if err := glc.glGetJSON(ctx, "/version", "", &glVer, maxProbeBody); err == nil && glVer.Version != "" {
                hi.Kind = "gitlab"
                hi.APIBase = hi.WebBase + "/api/v4"
                return hi, nil
        }
        // 3) any git host (info/refs — the universal smart-HTTP handshake)
        probeURL := strings.TrimSuffix(hi.WebBase, "/") + "/" +
                strings.Trim(hi.ProjectPath, "/") + "/info/refs?service=git-upload-pack"
        if _, err := c.do(ctx, "GET", probeURL, "", nil, "", maxProbeBody); err == nil {
                hi.Kind = "generic"
                hi.APIBase = hi.WebBase
                return hi, nil
        }
        return hi, fmt.Errorf("host %s is neither a Gitea/Forgejo/GitLab instance nor a git repo", hi.Host)
}

// ── generic git (local blobless clone browse) ────────────────────────────

// genGitDir is where workspaces.go points the clone; the adapter reads it.
// Set once by the server at connect/clone time via SetGenericCloneDir.
var genericCloneRoot string

// SetGenericCloneDir wires the directory generic-git adapters clone into.
func SetGenericCloneDir(dir string) { genericCloneRoot = dir }

func (c *Client) genDir() string {
        if genericCloneRoot == "" {
                return ""
        }
        return filepath.Join(genericCloneRoot, c.host.Host,
                strings.TrimPrefix(c.host.ProjectPath, "/"))
}

// gitOut runs one git command in the clone (read-only surface).
func (c *Client) gitOut(args ...string) (string, error) {
        dir := c.genDir()
        if dir == "" {
                return "", fmt.Errorf("no local clone configured for this generic workspace")
        }
        cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
        out, err := cmd.Output()
        if err != nil {
                if ee, ok := err.(*exec.ExitError); ok {
                        return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(string(ee.Stderr)))
                }
                return "", err
        }
        return string(out), nil
}

func (c *Client) genTree(ctx context.Context, path, ref, _ string) ([]TreeEntry, bool, error) {
        prefix := strings.Trim(path, "/")
        out, err := c.gitOut("ls-tree", "--long", "-z", "HEAD", "--", prefix)
        if err != nil {
                return nil, false, err
        }
        var entries []TreeEntry
        for _, rec := range strings.Split(strings.TrimRight(out, "\x00"), "\x00") {
                if rec == "" {
                        continue
                }
                // <mode> <type> <sha> <size>\t<path>
                tab := strings.IndexByte(rec, '\t')
                if tab < 0 {
                        continue
                }
                meta, p := rec[:tab], rec[tab+1:]
                f := strings.Fields(meta)
                if len(f) < 4 {
                        continue
                }
                typ := "blob"
                if f[1] == "tree" {
                        typ = "tree"
                }
                var size int64
                fmt.Sscanf(f[3], "%d", &size)
                entries = append(entries, TreeEntry{Path: p, Type: typ, Size: size, SHA: f[2]})
        }
        return entries, false, nil
}

func (c *Client) genFile(ctx context.Context, path, ref, rangeSpec, _ string) (*FileContent, error) {
        out, err := c.gitOut("show", "HEAD:"+strings.TrimPrefix(path, "/"))
        if err != nil {
                return nil, err
        }
        return buildFileContent(path, "", []byte(out), rangeSpec), nil
}

func (c *Client) genBranches(ctx context.Context, _ string) ([]string, error) {
        out, err := c.gitOut("branch", "--format=%(refname:short)")
        if err != nil {
                return nil, err
        }
        var names []string
        for _, l := range strings.Split(out, "\n") {
                if l = strings.TrimSpace(l); l != "" {
                        names = append(names, l)
                }
        }
        return names, nil
}

func (c *Client) genCommits(ctx context.Context, path, ref, _ string, limit int) ([]Commit, error) {
        limit = clampLimit(limit, 30)
        args := []string{"log", "-n", fmt.Sprint(limit), "--pretty=%H%x1f%s%x1f%an%x1f%aI"}
        if path != "" {
                args = append(args, "--", path)
        }
        out, err := c.gitOut(args...)
        if err != nil {
                return nil, err
        }
        var rows []Commit
        for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
                f := strings.Split(l, "\x1f")
                if len(f) < 4 {
                        continue
                }
                rows = append(rows, Commit{SHA: f[0], Message: f[1], Author: f[2], Date: f[3]})
        }
        return rows, nil
}
