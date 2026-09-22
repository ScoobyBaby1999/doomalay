// gitea.go — the Gitea / Forgejo / Codeberg adapter (API v1).
//
// Endpoint shapes verified against docs.gitea.com 2026-09:
//
//      GET  /repos/{o}/{r}                        → meta (permissions{...})
//      GET  /repos/{o}/{r}/git/trees/{ref}?recursive=true → whole tree
//      GET  /repos/{o}/{r}/raw/{path}?ref=        → raw file bytes
//      GET  /repos/{o}/{r}/contents/{path}?ref=   → file (base64) | dir
//      GET  /repos/{o}/{r}/branches               → branches
//      GET  /repos/{o}/{r}/commits?path=&sha=&limit=
//      GET  /repos/{o}/{r}/issues?state=&limit=   (PRs have pull_request set)
//      GET  /repos/{o}/{r}/pulls?state=&limit=
//      GET  /repos/{o}/{r}/releases?limit=
//      GET  /repos/{o}/{r}/actions/workflows      (Forgejo Actions)
//      GET  /repos/{o}/{r}/actions/runs?limit=
//      POST /repos/{o}/{r}/forks                  → fork (full_name)
//      POST /user/repos                           → create (auto_init,
//             license, gitignores — note the PLURAL key)
//      GET  /user/repos?limit=                    → my repos
//      GET  /licenses                             → license list (Forgejo)
//      GET  /gitignore/templates                  → names
//      PUT  /repos/{o}/{r}/contents/{path}        → create/update file
//
// File WRITES on Gitea use the same contents PUT shape as GitHub (sha
// optional — Gitea tolerates a missing sha on update when content is the
// whole truth, but sending it is still safer).
//
// Self-hosted hardening: the API base is user-chosen → every dial passes
// GuardURL (client.go do()).
package forge

import (
        "context"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "net/url"
        "strings"
)

func (c *Client) gtAPI() string { return c.host.APIBase }

func (c *Client) gtRepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
        var m struct {
                FullName      string `json:"full_name"`
                Description   string `json:"description"`
                DefaultBranch string `json:"default_branch"`
                Private       bool   `json:"private"`
                Stars         int    `json:"stars_count"`
                Forks         int    `json:"forks_count"`
                OpenIssues    int    `json:"open_issues_count"`
                UpdatedAt     string `json:"updated_at"`
                CloneURL      string `json:"clone_url"`
                HTMLURL       string `json:"html_url"`
                Permissions   *struct {
                        Admin bool `json:"admin"`
                        Push  bool `json:"push"`
                        Pull  bool `json:"pull"`
                } `json:"permissions"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo, token, &m, maxListBody); err != nil {
                return nil, err
        }
        out := &RepoMeta{FullName: m.FullName, Description: m.Description,
                DefaultBranch: m.DefaultBranch, Private: m.Private,
                Stars: m.Stars, Forks: m.Forks, OpenIssues: m.OpenIssues,
                UpdatedAt: m.UpdatedAt, CloneURL: m.CloneURL, WebURL: m.HTMLURL}
        if m.Permissions != nil {
                out.Admin, out.Push, out.Pull = m.Permissions.Admin, m.Permissions.Push, m.Permissions.Pull
        }
        return out, nil
}

func (c *Client) gtTree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
        if ref == "" {
                ref = "HEAD"
        }
        // Gitea's recursive tree endpoint returns {entries:[…]} (1.19+);
        // older instances 404 → fall back to the contents listing.
        var t struct {
                Entries []struct {
                        Path   string `json:"path"`
                        Type   string `json:"type"` // file|dir (Gitea's own naming)
                        Size   int64  `json:"size"`
                        SHA    string `json:"sha"`
                } `json:"entries"`
        }
        p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/git/trees/" + url.PathEscape(ref) + "?recursive=true"
        err := c.gtGetJSON(ctx, p, token, &t, maxTreeBody)
        if err != nil {
                if IsNotFound(err) {
                        return c.gtDirListing(ctx, path, ref, token)
                }
                return nil, false, err
        }
        out := make([]TreeEntry, 0, len(t.Entries))
        prefix := strings.Trim(path, "/")
        for _, e := range t.Entries {
                typ := "blob"
                if e.Type == "dir" || e.Type == "tree" {
                        typ = "tree"
                }
                if prefix != "" {
                        // every entry must live under the prefix (see ghTree's note)
                        if !strings.HasPrefix(e.Path, prefix+"/") {
                                continue
                        }
                        if typ == "tree" {
                                rel := strings.TrimPrefix(e.Path, prefix+"/")
                                if rel == "" || strings.Contains(rel, "/") {
                                        continue
                                }
                        }
                }
                out = append(out, TreeEntry{Path: e.Path, Type: typ, Size: e.Size, SHA: e.SHA})
        }
        return out, false, nil
}

func (c *Client) gtDirListing(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
        var list []struct {
                Name string `json:"name"`
                Path string `json:"path"`
                Type string `json:"type"`
                Size int64  `json:"size"`
                SHA  string `json:"sha"`
        }
        p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.Trim(path, "/")
        if ref != "" && ref != "HEAD" {
                p += "?ref=" + url.QueryEscape(ref)
        }
        if err := c.gtGetJSON(ctx, p, token, &list, maxTreeBody); err != nil {
                return nil, false, err
        }
        out := make([]TreeEntry, 0, len(list))
        for _, e := range list {
                typ := "blob"
                if e.Type == "dir" {
                        typ = "tree"
                }
                out = append(out, TreeEntry{Path: e.Path, Type: typ, Size: e.Size, SHA: e.SHA})
        }
        return out, false, nil
}

// gtFile: raw endpoint first (simplest, no size cap at 1MB like contents).
func (c *Client) gtFile(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
        p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/raw/" + strings.TrimPrefix(path, "/")
        if ref != "" {
                p += "?ref=" + url.QueryEscape(ref)
        }
        data, err := c.do(ctx, "GET", c.gtAPI()+p, token, nil, "", maxFileBody)
        if err != nil {
                return nil, err
        }
        sha := ""
        // best-effort blob sha via the contents endpoint (only when no range —
        // PUT-file needs the sha and PUTs never carry ranges)
        if rangeSpec == "" {
                var f struct {
                        SHA string `json:"sha"`
                }
                cp := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.TrimPrefix(path, "/")
                if ref != "" {
                        cp += "?ref=" + url.QueryEscape(ref)
                }
                if err := c.gtGetJSON(ctx, cp, token, &f, maxFileBody); err == nil {
                        sha = f.SHA
                }
        }
        return buildFileContent(path, sha, data, rangeSpec), nil
}

func (c *Client) gtBranches(ctx context.Context, token string) ([]string, error) {
        var list []struct {
                Name string `json:"name"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/branches?limit=100", token, &list, maxListBody); err != nil {
                return nil, err
        }
        out := make([]string, 0, len(list))
        for _, b := range list {
                out = append(out, b.Name)
        }
        return out, nil
}

func (c *Client) gtCommits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
        limit = clampLimit(limit, 30)
        var v struct {
                Commits []struct {
                        SHA    string `json:"sha"`
                        Commit struct {
                                Message string `json:"message"`
                                Author  struct {
                                        Name string `json:"name"`
                                        Date string `json:"date"`
                                } `json:"author"`
                        } `json:"commit"`
                } `json:"commits"`
        }
        p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/commits?limit=" + fmt.Sprint(limit)
        if path != "" {
                p += "&path=" + url.QueryEscape(path)
        }
        if ref != "" {
                p += "&sha=" + url.QueryEscape(ref)
        }
        if err := c.gtGetJSON(ctx, p, token, &v, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Commit, 0, len(v.Commits))
        for _, r := range v.Commits {
                out = append(out, Commit{SHA: r.SHA, Message: firstLine(r.Commit.Message),
                        Author: r.Commit.Author.Name, Date: r.Commit.Author.Date})
        }
        return out, nil
}

func (c *Client) gtIssues(ctx context.Context, state, token string, limit int) ([]Issue, error) {
        limit = clampLimit(limit, 30)
        if state == "" {
                state = "all"
        }
        var rows []struct {
                Number    int    `json:"number"`
                Title     string `json:"title"`
                State     string `json:"state"`
                UpdatedAt string `json:"updated_at"`
                HTMLURL   string `json:"html_url"`
                Body      string `json:"body"`
                User      struct {
                        Login string `json:"login"`
                } `json:"user"`
                PullRequest *struct {
                        Merged bool `json:"merged"`
                } `json:"pull_request"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/issues?state="+
                url.QueryEscape(state)+"&limit="+fmt.Sprint(limit)+"&type=issues", token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Issue, 0, len(rows))
        for _, r := range rows {
                out = append(out, Issue{Number: r.Number, Title: r.Title, State: r.State,
                        Author: r.User.Login, UpdatedAt: r.UpdatedAt, IsPR: r.PullRequest != nil,
                        Body: clip(r.Body, 400), URL: r.HTMLURL})
        }
        return out, nil
}

func (c *Client) gtPulls(ctx context.Context, state, token string, limit int) ([]PullRequest, error) {
        limit = clampLimit(limit, 30)
        if state == "" {
                state = "open"
        }
        var rows []struct {
                Number    int    `json:"number"`
                Title     string `json:"title"`
                State     string `json:"state"`
                UpdatedAt string `json:"updated_at"`
                HTMLURL   string `json:"html_url"`
                User      struct {
                        Login string `json:"login"`
                } `json:"user"`
                Head struct {
                        Ref string `json:"ref"`
                } `json:"head"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/pulls?state="+
                url.QueryEscape(state)+"&limit="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]PullRequest, 0, len(rows))
        for _, r := range rows {
                out = append(out, PullRequest{Number: r.Number, Title: r.Title, State: r.State,
                        Author: r.User.Login, Branch: r.Head.Ref, UpdatedAt: r.UpdatedAt, URL: r.HTMLURL})
        }
        return out, nil
}

func (c *Client) gtReleases(ctx context.Context, token string, limit int) ([]Release, error) {
        limit = clampLimit(limit, 20)
        var rows []struct {
                TagName     string `json:"tag_name"`
                Name        string `json:"name"`
                PublishedAt string `json:"published_at"`
                Body        string `json:"body"`
                HTMLURL     string `json:"html_url"`
                Draft       bool   `json:"draft"`
                Prerelease  bool   `json:"prerelease"`
                Assets      []struct {
                        Name string `json:"name"`
                } `json:"assets"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/releases?limit="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Release, 0, len(rows))
        for _, r := range rows {
                out = append(out, Release{Tag: r.TagName, Name: r.Name, PublishedAt: r.PublishedAt,
                        Notes: clip(r.Body, 600), URL: r.HTMLURL, Assets: len(r.Assets), PreRelease: r.Prerelease})
        }
        return out, nil
}

func (c *Client) gtWorkflows(ctx context.Context, token string) ([]Workflow, error) {
        var v struct {
                WorkflowEntries []struct {
                        ID    int64  `json:"id"`
                        Name  string `json:"name"`
                        Path  string `json:"path"`
                        State string `json:"state"`
                } `json:"workflow_entries"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/actions/workflows", token, &v, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Workflow, 0, len(v.WorkflowEntries))
        for _, w := range v.WorkflowEntries {
                out = append(out, Workflow{ID: w.ID, Name: w.Name, Path: w.Path, State: w.State})
        }
        return out, nil
}

func (c *Client) gtWorkflowRuns(ctx context.Context, token string, limit int) ([]WorkflowRun, error) {
        limit = clampLimit(limit, 30)
        var v struct {
                WorkflowRuns []struct {
                        ID         int64  `json:"id"`
                        Name       string `json:"name"`
                        Status     string `json:"status"`
                        Conclusion string `json:"conclusion"`
                        Event      string `json:"event"`
                        HeadBranch string `json:"head_branch"`
                        CreatedAt  string `json:"created_at"`
                        HTMLURL    string `json:"html_url"`
                } `json:"workflow_runs"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/actions/runs?limit="+fmt.Sprint(limit), token, &v, maxListBody); err != nil {
                return nil, err
        }
        out := make([]WorkflowRun, 0, len(v.WorkflowRuns))
        for _, r := range v.WorkflowRuns {
                out = append(out, WorkflowRun{ID: r.ID, Name: r.Name, Status: r.Status,
                        Conclusion: r.Conclusion, Event: r.Event, Branch: r.HeadBranch,
                        StartedAt: r.CreatedAt, URL: r.HTMLURL})
        }
        return out, nil
}

func (c *Client) gtPutFile(ctx context.Context, path, branch, message, content, sha, token string) (string, error) {
        if token == "" {
                return "", fmt.Errorf("writing to this Gitea forge needs a token")
        }
        body := map[string]any{
                "message": message,
                "content": base64.StdEncoding.EncodeToString([]byte(content)),
        }
        if branch != "" {
                body["branch"] = branch
        }
        if sha != "" {
                body["sha"] = sha
        }
        b, _ := json.Marshal(body)
        var out struct {
                Commit struct {
                        HTMLURL string `json:"html_url"`
                } `json:"commit"`
        }
        p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.TrimPrefix(path, "/")
        data, err := c.do(ctx, "PUT", c.gtAPI()+p, token, b, "application/json", maxListBody)
        if err != nil {
                return "", err
        }
        _ = json.Unmarshal(data, &out)
        return out.Commit.HTMLURL, nil
}

func (c *Client) gtFork(ctx context.Context, token string) (string, error) {
        if token == "" {
                return "", fmt.Errorf("forking needs a token on this forge")
        }
        var out struct {
                FullName string `json:"full_name"`
        }
        data, err := c.do(ctx, "POST", c.gtAPI()+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/forks",
                token, nil, "application/json", maxListBody)
        if err != nil {
                return "", err
        }
        if err := json.Unmarshal(data, &out); err != nil {
                return "", err
        }
        return out.FullName, nil
}

func (c *Client) gtCreateRepo(ctx context.Context, name, desc, license, gitignore string, private bool, token string) (*RepoMeta, error) {
        if token == "" {
                return nil, fmt.Errorf("creating a repo on this forge needs a token")
        }
        body := map[string]any{"name": name, "description": desc, "private": private,
                "auto_init": true}
        if license != "" {
                body["license"] = license
        }
        if gitignore != "" {
                body["gitignores"] = gitignore // PLURAL on Gitea (docs verified)
        }
        b, _ := json.Marshal(body)
        var m struct {
                FullName      string `json:"full_name"`
                Description   string `json:"description"`
                DefaultBranch string `json:"default_branch"`
                Private       bool   `json:"private"`
                CloneURL      string `json:"clone_url"`
                HTMLURL       string `json:"html_url"`
        }
        data, err := c.do(ctx, "POST", c.gtAPI()+"/user/repos", token, b, "application/json", maxListBody)
        if err != nil {
                return nil, err
        }
        if err := json.Unmarshal(data, &m); err != nil {
                return nil, err
        }
        return &RepoMeta{FullName: m.FullName, Description: m.Description,
                DefaultBranch: m.DefaultBranch, Private: m.Private,
                CloneURL: m.CloneURL, WebURL: m.HTMLURL}, nil
}

func (c *Client) gtListUserRepos(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
        limit = clampLimit(limit, 50)
        var rows []struct {
                FullName      string `json:"full_name"`
                Description   string `json:"description"`
                DefaultBranch string `json:"default_branch"`
                Private       bool   `json:"private"`
                CloneURL      string `json:"clone_url"`
                HTMLURL       string `json:"html_url"`
                UpdatedAt     string `json:"updated_at"`
        }
        if err := c.gtGetJSON(ctx, "/user/repos?limit="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]RepoMeta, 0, len(rows))
        for _, r := range rows {
                out = append(out, RepoMeta{FullName: r.FullName, Description: r.Description,
                        DefaultBranch: r.DefaultBranch, Private: r.Private,
                        CloneURL: r.CloneURL, WebURL: r.HTMLURL, UpdatedAt: r.UpdatedAt})
        }
        return out, nil
}

func (c *Client) gtLicenses(ctx context.Context, token string) ([]string, error) {
        var rows []struct {
                Key string `json:"key"`
        }
        if err := c.gtGetJSON(ctx, "/licenses", token, &rows, maxListBody); err != nil {
                // stock Gitea lacks the license list — a sensible static fallback
                return []string{"mit", "apache-2.0", "gpl-3.0", "agpl-3.0", "mpl-2.0",
                        "bsd-2-clause", "bsd-3-clause", "unlicense", "cc0-1.0"}, nil
        }
        out := make([]string, 0, len(rows))
        for _, r := range rows {
                out = append(out, r.Key)
        }
        return out, nil
}

func (c *Client) gtGitignores(ctx context.Context, token string) ([]string, error) {
        var v struct {
                Names []string `json:"names"` // {"Go","Python",…} title-case on Gitea
        }
        if err := c.gtGetJSON(ctx, "/gitignore/templates", token, &v, maxListBody); err != nil {
                return nil, err
        }
        return v.Names, nil
}

func (c *Client) gtGetJSON(ctx context.Context, path, token string, out any, limit int64) error {
        data, err := c.do(ctx, "GET", c.gtAPI()+path, token, nil, "", limit)
        if err != nil {
                return err
        }
        return json.Unmarshal(data, out)
}
