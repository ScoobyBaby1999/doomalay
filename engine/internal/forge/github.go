// github.go — the GitHub adapter (REST v3 + GraphQL for discussions).
//
// Endpoint shapes verified against docs.github.com REST reference 2026-09:
//
//	GET  /repos/{o}/{r}                       → meta incl. permissions{...}
//	GET  /repos/{o}/{r}/git/trees/{ref}?recursive=1   → whole tree (1 call;
//	       truncated:true past 100k entries / 7MB — fall back per-dir)
//	GET  /repos/{o}/{r}/contents/{path}?ref=  → file (base64) | dir listing
//	GET  /repos/{o}/{r}/readme                 → readme blob
//	GET  /repos/{o}/{r}/branches?per_page=100  → branches
//	GET  /repos/{o}/{r}/commits?path=&sha=&per_page=
//	GET  /repos/{o}/{r}/issues?state=&per_page= (includes PRs: "pull_request" key)
//	GET  /repos/{o}/{r}/pulls?state=&per_page=
//	GET  /repos/{o}/{r}/releases?per_page=
//	GET  /repos/{o}/{r}/actions/workflows     → workflows
//	GET  /repos/{o}/{r}/actions/runs?per_page=→ runs (incl. in_progress)
//	GET  /search/code?q=repo:{o}/{r}+<term>   → code search (AUTH required)
//	PUT  /repos/{o}/{r}/contents/{path}       → create/update file = commit
//	POST /repos/{o}/{r}/forks                 → fork into token account
//	POST /user/repos                          → create repo
//	GET  /user/repos?sort=updated&per_page=   → my repos
//	GET  /licenses                            → license list (key names)
//	GET  /gitignore/templates                 → gitignore list
//	GQL  graphql.github.com  discussions(first:n) — the ONLY discussions
//	       surface (REST has none; token required)
package forge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// GitHubAPIBase is the GitHub REST root (v0.76.5: an exported seam so
// tests can point the whole github forge at a local httptest server,
// the same override pattern the server package uses for its OAuth
// endpoints. Production: https://api.github.com.
var GitHubAPIBase = "https://api.github.com"

func (c *Client) ghRepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
	var m struct {
		FullName      string `json:"full_name"`
		Description   string `json:"description"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
		Stars         int    `json:"stargazers_count"`
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
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo, token, &m, maxListBody); err != nil {
		return nil, err
	}
	out := &RepoMeta{
		FullName: m.FullName, Description: m.Description,
		DefaultBranch: m.DefaultBranch, Private: m.Private,
		Stars: m.Stars, Forks: m.Forks, OpenIssues: m.OpenIssues,
		UpdatedAt: m.UpdatedAt, CloneURL: m.CloneURL, WebURL: m.HTMLURL,
	}
	if m.Permissions != nil {
		out.Admin, out.Push, out.Pull = m.Permissions.Admin, m.Permissions.Push, m.Permissions.Pull
	}
	return out, nil
}

// ghTree: recursive tree in ONE call; path filtering engine-side. When
// GitHub flags truncation we return truncated=true and the caller narrows.
func (c *Client) ghTree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
	if ref == "" {
		ref = "HEAD"
	}
	var t struct {
		Truncated bool `json:"truncated"`
		Tree      []struct {
			Path string `json:"path"`
			Mode string `json:"mode"`
			Type string `json:"type"`
			Size int64  `json:"size"`
			SHA  string `json:"sha"`
		} `json:"tree"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/git/trees/" + url.PathEscape(ref) + "?recursive=1"
	if err := c.ghGetJSON(ctx, p, token, &t, maxTreeBody); err != nil {
		// 404 on a SHA-ish ref is usually "ref not found" — try the
		// contents listing (branch dirs) before giving up.
		if IsNotFound(err) && path != "" {
			return c.ghDirListing(ctx, path, ref, token)
		}
		return nil, false, err
	}
	out := make([]TreeEntry, 0, len(t.Tree))
	prefix := strings.Trim(path, "/")
	for _, e := range t.Tree {
		typ := e.Type
		if typ == "" && e.Mode == "040000" {
			typ = "tree"
		}
		if prefix != "" {
			// EVERY entry must live under the prefix — a recursive tree
			// also returns the repo's other roots and they must not leak
			// into a subdirectory listing.
			if !strings.HasPrefix(e.Path, prefix+"/") {
				continue
			}
			if typ == "tree" {
				// keep only the DIRECT children of the prefix (a full
				// recursive dump of a subtree is noise in the drawer)
				rel := strings.TrimPrefix(e.Path, prefix+"/")
				if rel == "" || strings.Contains(rel, "/") {
					continue
				}
			}
		}
		out = append(out, TreeEntry{Path: e.Path, Type: typ, Size: e.Size, SHA: e.SHA})
	}
	if t.Truncated {
		// fall back to per-directory listings for the requested path —
		// honest data beats a truncated mega-tree
		if path != "" {
			return c.ghDirListing(ctx, path, ref, token)
		}
		return out, true, nil
	}
	return out, false, nil
}

// ghDirListing: GET contents/{path} (one directory, ≤1000 files per the
// API doc) — the non-recursive fallback.
func (c *Client) ghDirListing(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
	var list []struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"` // file|dir
		Size int64  `json:"size"`
		SHA  string `json:"sha"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.TrimPrefix(strings.Trim(path, "/"), "")
	if ref != "" {
		p += "?ref=" + url.QueryEscape(ref)
	}
	if err := c.ghGetJSON(ctx, p, token, &list, maxTreeBody); err != nil {
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

// ghFile: contents API returns base64 + sha; range slicing engine-side.
func (c *Client) ghFile(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
	var f struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		SHA         string `json:"sha"`
		Size        int64  `json:"size"`
		Encoding    string `json:"encoding"`
		Content     string `json:"content"`
		DownloadURL string `json:"download_url"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.TrimPrefix(path, "/")
	if ref != "" {
		p += "?ref=" + url.QueryEscape(ref)
	}
	if err := c.ghGetJSON(ctx, p, token, &f, maxFileBody); err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.NewReplacer("\n", "", "\r", "").Replace(f.Content))
	if err != nil {
		// contents of >1MB come back with content:"" and a download_url —
		// fetch raw via that URL (guarded: it's a codeload/github URL)
		if f.DownloadURL != "" {
			data, derr := c.do(ctx, "GET", f.DownloadURL, token, nil, "", maxFileBody)
			if derr != nil {
				return nil, derr
			}
			return buildFileContent(f.Path, f.SHA, data, rangeSpec), nil
		}
		return nil, fmt.Errorf("file %s: undecodable content (%v)", path, err)
	}
	return buildFileContent(f.Path, f.SHA, raw, rangeSpec), nil
}

func (c *Client) ghBranches(ctx context.Context, token string) ([]string, error) {
	var list []struct {
		Name string `json:"name"`
	}
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/branches?per_page=100", token, &list, maxListBody); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list))
	for _, b := range list {
		out = append(out, b.Name)
	}
	return out, nil
}

// ghCreateBranch — POST /git/refs (v0.76.5: the put-to-a-new-branch
// prerequisite; the contents API can only commit to an EXISTING ref, so
// the bot's "commit to a feature branch, then PR it" flow needs this).
// from="" = the repo's default branch (resolved via the repo card).
func (c *Client) ghCreateBranch(ctx context.Context, name, from, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("creating a branch needs a GitHub token")
	}
	if from == "" {
		meta, err := c.ghRepoInfo(ctx, token)
		if err != nil {
			return "", err
		}
		from = meta.DefaultBranch
	}
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	// "Get a reference": /git/ref/heads/<branch> (NOT /git/HEAD — that
	// endpoint 404s; observed live in the v0.76.5 red team).
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/git/ref/heads/"+url.PathEscape(from), token, &ref, maxListBody); err != nil {
		return "", fmt.Errorf("resolving branch %s: %w", from, err)
	}
	b, _ := json.Marshal(map[string]any{
		"ref": "refs/heads/" + name, "sha": ref.Object.SHA,
	})
	var out struct {
		Ref string `json:"ref"`
	}
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/git/refs",
		token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.Ref, nil
}

func (c *Client) ghCommits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
	limit = clampLimit(limit, 30)
	var rows []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Name string `json:"name"`
				Date string `json:"date"`
			} `json:"author"`
		} `json:"commit"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/commits?per_page=" + fmt.Sprint(limit)
	if path != "" {
		p += "&path=" + url.QueryEscape(path)
	}
	if ref != "" {
		p += "&sha=" + url.QueryEscape(ref)
	}
	if err := c.ghGetJSON(ctx, p, token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Commit, 0, len(rows))
	for _, r := range rows {
		out = append(out, Commit{SHA: r.SHA, Message: firstLine(r.Commit.Message),
			Author: r.Commit.Author.Name, Date: r.Commit.Author.Date})
	}
	return out, nil
}

func (c *Client) ghIssues(ctx context.Context, state, token string, limit int) ([]Issue, error) {
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
			URL string `json:"url"`
		} `json:"pull_request"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/issues?state=" + url.QueryEscape(state) + "&per_page=" + fmt.Sprint(limit)
	if err := c.ghGetJSON(ctx, p, token, &rows, maxListBody); err != nil {
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

func (c *Client) ghPulls(ctx context.Context, state, token string, limit int) ([]PullRequest, error) {
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
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/pulls?state=" + url.QueryEscape(state) + "&per_page=" + fmt.Sprint(limit)
	if err := c.ghGetJSON(ctx, p, token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]PullRequest, 0, len(rows))
	for _, r := range rows {
		out = append(out, PullRequest{Number: r.Number, Title: r.Title, State: r.State,
			Author: r.User.Login, Branch: r.Head.Ref, UpdatedAt: r.UpdatedAt, URL: r.HTMLURL})
	}
	return out, nil
}

func (c *Client) ghReleases(ctx context.Context, token string, limit int) ([]Release, error) {
	limit = clampLimit(limit, 20)
	var rows []struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		PublishedAt string `json:"published_at"`
		Body        string `json:"body"`
		HTMLURL     string `json:"html_url"`
		Prerelease  bool   `json:"prerelease"`
		Assets      []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/releases?per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Release, 0, len(rows))
	for _, r := range rows {
		out = append(out, Release{Tag: r.TagName, Name: r.Name, PublishedAt: r.PublishedAt,
			Notes: clip(r.Body, 600), URL: r.HTMLURL, Assets: len(r.Assets), PreRelease: r.Prerelease})
	}
	return out, nil
}

func (c *Client) ghWorkflows(ctx context.Context, token string) ([]Workflow, error) {
	var v struct {
		Workflows []struct {
			ID    int64  `json:"id"`
			Name  string `json:"name"`
			Path  string `json:"path"`
			State string `json:"state"`
		} `json:"workflows"`
	}
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/actions/workflows", token, &v, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Workflow, 0, len(v.Workflows))
	for _, w := range v.Workflows {
		out = append(out, Workflow{ID: w.ID, Name: w.Name, Path: w.Path, State: w.State})
	}
	return out, nil
}

func (c *Client) ghWorkflowRuns(ctx context.Context, token string, limit int) ([]WorkflowRun, error) {
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
	if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/actions/runs?per_page="+fmt.Sprint(limit), token, &v, maxListBody); err != nil {
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

// ghDiscussions — GraphQL (REST has no discussions endpoint).
func (c *Client) ghDiscussions(ctx context.Context, token string, limit int) ([]Discussion, error) {
	if token == "" {
		return nil, fmt.Errorf("discussions need a GitHub token (GraphQL API)")
	}
	limit = clampLimit(limit, 25)
	q := fmt.Sprintf(`query($owner:String!,$repo:String!,$n:Int!){` +
		`repository(owner:$owner,name:$repo){` +
		`discussions(first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){` +
		`nodes{number title updatedAt url category{name} author{login}}}}}`)
	vars := map[string]any{"owner": c.host.Owner, "repo": c.host.Repo, "n": limit}
	body, _ := json.Marshal(map[string]any{"query": q, "variables": vars})
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/graphql", token, body, "application/json", maxListBody)
	if err != nil {
		return nil, err
	}
	var v struct {
		Data struct {
			Repository struct {
				Discussions struct {
					Nodes []struct {
						Number    int    `json:"number"`
						Title     string `json:"title"`
						UpdatedAt string `json:"updatedAt"`
						URL       string `json:"url"`
						Category  struct {
							Name string `json:"name"`
						} `json:"category"`
						Author struct {
							Login string `json:"login"`
						} `json:"author"`
					} `json:"nodes"`
				} `json:"discussions"`
			} `json:"repository"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	if len(v.Errors) > 0 {
		return nil, fmt.Errorf("graphql: %s", v.Errors[0].Message)
	}
	out := make([]Discussion, 0, len(v.Data.Repository.Discussions.Nodes))
	for _, d := range v.Data.Repository.Discussions.Nodes {
		out = append(out, Discussion{Number: d.Number, Title: d.Title,
			Author: d.Author.Login, Category: d.Category.Name,
			UpdatedAt: d.UpdatedAt, URL: d.URL})
	}
	return out, nil
}

// ghSearch — code search (auth required by GitHub since 2023).
func (c *Client) ghSearch(ctx context.Context, query, ref, token string, limit int) ([]SearchHit, error) {
	if token == "" {
		// unauthenticated code search is a 401 — fall back to grep
		return Grep(ctx, c, query, ref, token, limit)
	}
	limit = clampLimit(limit, 30)
	var v struct {
		Items []struct {
			Name        string `json:"name"`
			Path        string `json:"path"`
			TextMatches []struct {
				Fragment string `json:"fragment"`
			} `json:"text_matches"`
		} `json:"items"`
	}
	q := url.QueryEscape(fmt.Sprintf("repo:%s/%s %s", c.host.Owner, c.host.Repo, query))
	if err := c.ghGetJSON(ctx, "/search/code?q="+q+"&per_page="+fmt.Sprint(limit)+
		"&media=text-match", token, &v, maxListBody); err != nil {
		// search needs the special media type header — do() sets Accept:
		// application/json; GitHub accepts it for code search anyway since
		// the text-match header is optional. A 401/422 → grep fallback.
		return Grep(ctx, c, query, ref, token, limit)
	}
	out := make([]SearchHit, 0, len(v.Items))
	for _, it := range v.Items {
		snip := ""
		if len(it.TextMatches) > 0 {
			snip = clip(strings.Join(strings.Fields(it.TextMatches[0].Fragment), " "), 160)
		}
		out = append(out, SearchHit{Path: it.Path, Snippet: snip})
	}
	return out, nil
}

// ghPutFile — create/update via the contents API (a commit, no clone).
func (c *Client) ghPutFile(ctx context.Context, path, branch, message, content, sha, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("writing to GitHub needs a token with repo/contents write access")
	}
	body := map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
	}
	if branch != "" {
		body["branch"] = branch
	}
	if sha != "" {
		body["sha"] = sha // the CURRENT blob sha — required for updates
	}
	b, _ := json.Marshal(body)
	var out struct {
		Commit struct {
			HTMLURL string `json:"html_url"`
			SHA     string `json:"sha"`
		} `json:"commit"`
	}
	p := "/repos/" + c.host.Owner + "/" + c.host.Repo + "/contents/" + strings.TrimPrefix(path, "/")
	data, err := c.do(ctx, "PUT", GitHubAPIBase+p, token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.Commit.HTMLURL, nil
}

func (c *Client) ghFork(ctx context.Context, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("forking needs a GitHub token")
	}
	var out struct {
		FullName string `json:"full_name"`
	}
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/forks",
		token, nil, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.FullName, nil
}

// ghCreatePull — open a pull request (v0.76.5: the missing write verb —
// "the bot can actually push, PR" — same-repo branch PRs or fork→upstream
// PRs via head "user:branch"). Returns the PR number + html url.
func (c *Client) ghCreatePull(ctx context.Context, title, body, head, base, token string) (PullRequest, error) {
	if token == "" {
		return PullRequest{}, fmt.Errorf("opening a GitHub PR needs a token")
	}
	if strings.TrimSpace(head) == "" {
		return PullRequest{}, fmt.Errorf("pr needs a head branch (where the changes are)")
	}
	if strings.TrimSpace(base) == "" {
		return PullRequest{}, fmt.Errorf("pr needs a base branch (where the changes go)")
	}
	b, _ := json.Marshal(map[string]any{
		"title": title,
		"body":  body,
		"head":  head, // "branch" (same repo) or "owner:branch" (fork)
		"base":  base,
	})
	var m struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			Ref string `json:"ref"`
		} `json:"head"`
	}
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/pulls",
		token, b, "application/json", maxListBody)
	if err != nil {
		return PullRequest{}, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return PullRequest{}, err
	}
	return PullRequest{Number: m.Number, Title: title, State: m.State,
		Author: m.User.Login, Branch: m.Head.Ref, URL: m.HTMLURL}, nil
}

func (c *Client) ghCreateRepo(ctx context.Context, name, desc, license, gitignore string, private bool, token string) (*RepoMeta, error) {
	if token == "" {
		return nil, fmt.Errorf("creating a GitHub repo needs a token")
	}
	body := map[string]any{"name": name, "description": desc, "private": private,
		"auto_init": true} // auto_init so the repo has a HEAD to commit onto
	if license != "" {
		body["license_template"] = license
	}
	if gitignore != "" {
		body["gitignore_template"] = gitignore
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
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/user/repos", token, b, "application/json", maxListBody)
	if err != nil {
		// v0.59: the GitHub App ships with REPO-ONLY permissions by design
		// (the user asked for the smallest possible grant) — repo creation
		// needs the OPTIONAL "Administration" permission, which is off by
		// default. Name it instead of surfacing a bare 403.
		if IsForbidden(err) {
			return nil, fmt.Errorf("creating repos needs the optional Administration permission, which the Doomalay GitHub App leaves OFF by default (repo-only access) — enable it in the app's settings on GitHub (Developer settings → GitHub Apps → permissions → Repository permissions → Administration: Read and write), or create the repo directly on github.com and add it as a workspace: %w", err)
		}
		return nil, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &RepoMeta{FullName: m.FullName, Description: m.Description,
		DefaultBranch: m.DefaultBranch, Private: m.Private,
		CloneURL: m.CloneURL, WebURL: m.HTMLURL}, nil
}

func (c *Client) ghListUserRepos(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
	limit = clampLimit(limit, 50)
	var rows []struct {
		FullName      string `json:"full_name"`
		Description   string `json:"description"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
		CloneURL      string `json:"clone_url"`
		HTMLURL       string `json:"html_url"`
		UpdatedAt     string `json:"updated_at"`
		Language      string `json:"language"`
		Stars         int    `json:"stargazers_count"`
		// v0.62: the token's permissions per repo (the access pills
		// in the workspaces picker glow off these).
		Permissions struct {
			Admin bool `json:"admin"`
			Push  bool `json:"push"`
			Pull  bool `json:"pull"`
		} `json:"permissions"`
	}
	if err := c.ghGetJSON(ctx, "/user/repos?sort=updated&per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]RepoMeta, 0, len(rows))
	for _, r := range rows {
		out = append(out, RepoMeta{FullName: r.FullName, Description: r.Description,
			DefaultBranch: r.DefaultBranch, Private: r.Private,
			CloneURL: r.CloneURL, WebURL: r.HTMLURL, UpdatedAt: r.UpdatedAt,
			Stars: r.Stars, Language: r.Language,
			Admin: r.Permissions.Admin, Push: r.Permissions.Push, Pull: r.Permissions.Pull})
	}
	return out, nil
}

func (c *Client) ghLicenses(ctx context.Context, token string) ([]string, error) {
	var rows []struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	if err := c.ghGetJSON(ctx, "/licenses", token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Key)
	}
	return out, nil
}

func (c *Client) ghGitignores(ctx context.Context, token string) ([]string, error) {
	var v struct {
		Names []string `json:"names"` // newer API shape…
	}
	if err := c.ghGetJSON(ctx, "/gitignore/templates", token, &v, maxListBody); err != nil {
		return nil, err
	}
	if len(v.Names) > 0 {
		return v.Names, nil
	}
	// …older shape: bare array of strings
	var arr []string
	if err := c.ghGetJSON(ctx, "/gitignore/templates", token, &arr, maxListBody); err != nil {
		return nil, err
	}
	return arr, nil
}

// ghGetJSON — GET + decode into out.
func (c *Client) ghGetJSON(ctx context.Context, path, token string, out any, limit int64) error {
	data, err := c.do(ctx, "GET", GitHubAPIBase+path, token, nil, "", limit)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// ── v0.81.6 THE FULL REPO HAND — the missing write/review verbs ──────────
// (user spec: "the bot should be able to have full access to a repo, grep,
// ls, read, explore, push, pr, code review, issues, discussions, workflows,
// everything. Let's implement it all.") GitHub implementations; other
// forges answer ErrUnsupported from the client.go dispatch — an honest
// "not supported for {kind} yet" beats a silently-wrong API call.
// Endpoint shapes verified against the GitHub REST/GraphQL docs
// (issues POST/PATCH, pulls reviews/merge/diff, actions dispatches,
// releases, contents DELETE, discussions createDiscussion mutation).

// ghCreateIssue — POST /repos/{o}/{r}/issues (title required; body and
// labels optional). Returns the created issue's number + URL.
func (c *Client) ghCreateIssue(ctx context.Context, title, body string, labels []string, token string) (Issue, error) {
	if token == "" {
		return Issue{}, fmt.Errorf("creating a GitHub issue needs a token")
	}
	if strings.TrimSpace(title) == "" {
		return Issue{}, fmt.Errorf("issue needs a title")
	}
	payload := map[string]any{"title": title, "body": body}
	if len(labels) > 0 {
		payload["labels"] = labels
	}
	b, _ := json.Marshal(payload)
	var m struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	}
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/issues",
		token, b, "application/json", maxListBody)
	if err != nil {
		return Issue{}, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return Issue{}, err
	}
	return Issue{Number: m.Number, Title: title, State: m.State,
		Author: m.User.Login, URL: m.HTMLURL}, nil
}

// ghIssueComment — POST /repos/{o}/{r}/issues/{n}/comments. The SAME
// endpoint serves PR conversation comments (GitHub treats a PR's
// conversation as its issue thread) — the PR-comment verb rides this.
func (c *Client) ghIssueComment(ctx context.Context, number int, body, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("commenting needs a GitHub token")
	}
	if strings.TrimSpace(body) == "" {
		return "", fmt.Errorf("comment needs a body")
	}
	b, _ := json.Marshal(map[string]any{"body": body})
	var m struct {
		HTMLURL string `json:"html_url"`
	}
	data, err := c.do(ctx, "POST", fmt.Sprintf("%s/repos/%s/%s/issues/%d/comments",
		GitHubAPIBase, c.host.Owner, c.host.Repo, number), token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}
	return m.HTMLURL, nil
}

// ghSetIssueState — PATCH /repos/{o}/{r}/issues/{n} (state open|closed —
// the close/reopen twin).
func (c *Client) ghSetIssueState(ctx context.Context, number int, state, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("changing an issue's state needs a GitHub token")
	}
	if state != "open" && state != "closed" {
		return "", fmt.Errorf("state must be \"open\" or \"closed\"")
	}
	b, _ := json.Marshal(map[string]any{"state": state})
	var m struct {
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
	}
	data, err := c.do(ctx, "PATCH", fmt.Sprintf("%s/repos/%s/%s/issues/%d",
		GitHubAPIBase, c.host.Owner, c.host.Repo, number), token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}
	return m.HTMLURL + " (state: " + m.State + ")", nil
}

// ghPRDiff — GET /repos/{o}/{r}/pulls/{n} with Accept:
// application/vnd.github.diff → the raw unified diff (the CODE REVIEW
// read: the model reviews exactly what the PR changes).
func (c *Client) ghPRDiff(ctx context.Context, number int, token string) (string, error) {
	data, err := c.doAccept(ctx, "GET",
		fmt.Sprintf("%s/repos/%s/%s/pulls/%d", GitHubAPIBase, c.host.Owner, c.host.Repo, number),
		token, nil, "", "application/vnd.github.diff", maxDiffBody)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ghPRReview — POST /repos/{o}/{r}/pulls/{n}/reviews {body, event} —
// submits a review (APPROVE | REQUEST_CHANGES | COMMENT). The CODE
// REVIEW write: the model reads pr_diff, then submits its review here.
func (c *Client) ghPRReview(ctx context.Context, number int, body, event, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("submitting a review needs a GitHub token")
	}
	switch strings.ToUpper(event) {
	case "APPROVE", "REQUEST_CHANGES", "REQUEST CHANGES", "COMMENT", "":
		event = strings.ToUpper(strings.ReplaceAll(event, " ", "_"))
		if event == "" {
			event = "COMMENT"
		}
	default:
		return "", fmt.Errorf("review event must be approve, request_changes or comment")
	}
	payload := map[string]any{"event": event}
	if strings.TrimSpace(body) != "" {
		payload["body"] = body
	}
	b, _ := json.Marshal(payload)
	var m struct {
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
	}
	data, err := c.do(ctx, "POST", fmt.Sprintf("%s/repos/%s/%s/pulls/%d/reviews",
		GitHubAPIBase, c.host.Owner, c.host.Repo, number), token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}
	return m.HTMLURL + " (" + m.State + ")", nil
}

// ghMergePR — PUT /repos/{o}/{r}/pulls/{n}/merge {merge_method}. The
// strong write — the tool layer gates it behind FULL access.
func (c *Client) ghMergePR(ctx context.Context, number int, title, msg, method, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("merging needs a GitHub token")
	}
	switch method {
	case "", "merge", "squash", "rebase":
	default:
		return "", fmt.Errorf("merge_method must be merge, squash or rebase")
	}
	payload := map[string]any{}
	if method != "" {
		payload["merge_method"] = method
	}
	if strings.TrimSpace(title) != "" {
		payload["commit_title"] = title
	}
	if strings.TrimSpace(msg) != "" {
		payload["commit_message"] = msg
	}
	b, _ := json.Marshal(payload)
	var m struct {
		Merged  bool   `json:"merged"`
		Message string `json:"message"`
		SHA     string `json:"sha"`
	}
	data, err := c.do(ctx, "PUT", fmt.Sprintf("%s/repos/%s/%s/pulls/%d/merge",
		GitHubAPIBase, c.host.Owner, c.host.Repo, number), token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}
	if !m.Merged {
		return "", fmt.Errorf("not merged: %s", m.Message)
	}
	return "merged (" + method + ") — merge commit " + m.SHA, nil
}

// ghDiscussionPost — GraphQL createDiscussion (the REST API has no
// discussions-write surface). Resolves repositoryId + the categoryId
// (by name when given, else the first category), then posts.
func (c *Client) ghDiscussionPost(ctx context.Context, title, body, category, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("posting a discussion needs a GitHub token (GraphQL API)")
	}
	if strings.TrimSpace(title) == "" {
		return "", fmt.Errorf("discussion needs a title")
	}
	// 1. repository id + categories
	q := `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){` +
		`id discussionCategories(first:20){nodes{id name}}}}`
	vars := map[string]any{"owner": c.host.Owner, "repo": c.host.Repo}
	qb, _ := json.Marshal(map[string]any{"query": q, "variables": vars})
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/graphql", token, qb, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	var v struct {
		Data struct {
			Repository struct {
				ID         string `json:"id"`
				Categories struct {
					Nodes []struct {
						ID   string `json:"id"`
						Name string `json:"name"`
					} `json:"nodes"`
				} `json:"discussionCategories"`
			} `json:"repository"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return "", err
	}
	if len(v.Errors) > 0 {
		return "", fmt.Errorf("graphql: %s", v.Errors[0].Message)
	}
	if v.Data.Repository.ID == "" || len(v.Data.Repository.Categories.Nodes) == 0 {
		return "", fmt.Errorf("discussions are not enabled on this repository")
	}
	catID := v.Data.Repository.Categories.Nodes[0].ID
	catName := v.Data.Repository.Categories.Nodes[0].Name
	if category != "" {
		found := false
		for _, cat := range v.Data.Repository.Categories.Nodes {
			if strings.EqualFold(cat.Name, category) {
				catID, catName = cat.ID, cat.Name
				found = true
				break
			}
		}
		if !found {
			var names []string
			for _, cat := range v.Data.Repository.Categories.Nodes {
				names = append(names, cat.Name)
			}
			return "", fmt.Errorf("no discussion category %q — available: %s", category, strings.Join(names, ", "))
		}
	}
	// 2. the mutation
	mq := `mutation($input:CreateDiscussionInput!){createDiscussion(input:$input){discussion{number url title}}}`
	minput := map[string]any{
		"repositoryId": v.Data.Repository.ID,
		"categoryId":   catID,
		"title":        title,
		"body":         body,
	}
	mb, _ := json.Marshal(map[string]any{"query": mq, "variables": map[string]any{"input": minput}})
	data2, err := c.do(ctx, "POST", GitHubAPIBase+"/graphql", token, mb, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	var v2 struct {
		Data struct {
			CreateDiscussion struct {
				Discussion struct {
					Number int    `json:"number"`
					URL    string `json:"url"`
					Title  string `json:"title"`
				} `json:"discussion"`
			} `json:"createDiscussion"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data2, &v2); err != nil {
		return "", err
	}
	if len(v2.Errors) > 0 {
		return "", fmt.Errorf("graphql: %s", v2.Errors[0].Message)
	}
	return fmt.Sprintf("#%d %q in %s — %s", v2.Data.CreateDiscussion.Discussion.Number,
		v2.Data.CreateDiscussion.Discussion.Title, catName, v2.Data.CreateDiscussion.Discussion.URL), nil
}

// ghDispatchWorkflow — POST /repos/{o}/{r}/actions/workflows/{id|file}/dispatches
// {ref, inputs} → 204 No Content. workflow is the file name (e.g.
// "ci.yml") or its numeric id; ref defaults to the repo's branch.
func (c *Client) ghDispatchWorkflow(ctx context.Context, workflow, ref string, inputs map[string]string, token string) error {
	if token == "" {
		return fmt.Errorf("dispatching a workflow needs a GitHub token")
	}
	if strings.TrimSpace(workflow) == "" {
		return fmt.Errorf("dispatch needs the workflow file name (e.g. \"ci.yml\") or its id")
	}
	payload := map[string]any{}
	if ref != "" {
		payload["ref"] = ref
	}
	if len(inputs) > 0 {
		payload["inputs"] = inputs
	}
	b, _ := json.Marshal(payload)
	_, err := c.do(ctx, "POST",
		fmt.Sprintf("%s/repos/%s/%s/actions/workflows/%s/dispatches",
			GitHubAPIBase, c.host.Owner, c.host.Repo, strings.Trim(workflow, "/")),
		token, b, "application/json", maxListBody)
	return err
}

// ghDeleteFile — DELETE /repos/{o}/{r}/contents/{path} {message, sha,
// branch} (the sha of the blob being removed — the tool layer fetches
// it when the model doesn't supply one).
func (c *Client) ghDeleteFile(ctx context.Context, path, branch, message, sha, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("deleting a file needs a GitHub token")
	}
	if strings.TrimSpace(sha) == "" {
		return "", fmt.Errorf("delete needs the file's blob sha (read the file first)")
	}
	payload := map[string]any{"message": message, "sha": sha}
	if branch != "" {
		payload["branch"] = branch
	}
	b, _ := json.Marshal(payload)
	var out struct {
		Commit struct {
			HTMLURL string `json:"html_url"`
		} `json:"commit"`
	}
	data, err := c.do(ctx, "DELETE",
		GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/contents/"+strings.TrimPrefix(path, "/"),
		token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.Commit.HTMLURL, nil
}

// ghCreateRelease — POST /repos/{o}/{r}/releases {tag_name, name, body,
// target_commitish}. The tag is created on the fly by GitHub when it
// doesn't exist yet.
func (c *Client) ghCreateRelease(ctx context.Context, tag, name, body, target, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("creating a release needs a GitHub token")
	}
	if strings.TrimSpace(tag) == "" {
		return "", fmt.Errorf("release needs a tag (\"v1.2.0\")")
	}
	payload := map[string]any{"tag_name": tag, "name": name, "body": body}
	if target != "" {
		payload["target_commitish"] = target
	}
	b, _ := json.Marshal(payload)
	var m struct {
		HTMLURL string `json:"html_url"`
	}
	data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/releases",
		token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", err
	}
	return m.HTMLURL, nil
}
