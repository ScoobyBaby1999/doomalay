// gitlab.go — the GitLab adapter (API v4).
//
// Endpoint shapes verified against docs.gitlab.com 2026-09:
//
//	projects are addressed by urlencoded full path:
//	  /api/v4/projects/{urlencoded group%2Fsub%2Frepo}
//	GET  /projects/{id}                      → meta incl. permissions
//	GET  /projects/{id}/repository/tree?path=&ref=&recursive=true&pagination=keyset
//	GET  /projects/{id}/repository/files/{urlencoded path}/raw?ref=
//	GET  /projects/{id}/repository/branches  → branches
//	GET  /projects/{id}/repository/commits?path=&ref_name=&per_page=
//	GET  /projects/{id}/issues?state=&per_page=
//	GET  /projects/{id}/merge_requests?state=&per_page=
//	GET  /projects/{id}/releases?per_page=
//	PUT  /projects/{id}/repository/files/{path}  {branch,content,commit_message,encoding,sha?}
//	POST /projects/{id}/fork
//	POST /projects  {name,path,namespace_id?,initialize_with_readme,license,default_branch}
//	GET  /projects?membership=true&owned=true  → my repos
//
// No Actions workflows surface in common use → Workflows/WorkflowRuns/
// Discussions return ErrUnsupported (clean message, not a 500).
package forge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// glID: the urlencoded full project path gitlab addresses projects by.
func (c *Client) glID() string {
	return url.PathEscape(c.host.ProjectPath)
}

func (c *Client) glRepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
	var m struct {
		PathWithNamespace string `json:"path_with_namespace"`
		Description       string `json:"description"`
		DefaultBranch     string `json:"default_branch"`
		Visibility        string `json:"visibility"` // private|internal|public
		StarCount         int    `json:"star_count"`
		ForksCount        int    `json:"forks_count"`
		OpenIssuesCount   int    `json:"open_issues_count"`
		LastActivityAt    string `json:"last_activity_at"`
		HTTPURLToRepo     string `json:"http_url_to_repo"`
		WebURL            string `json:"web_url"`
		Permissions       *struct {
			ProjectAccess *struct {
				AccessLevel int `json:"access_level"`
			} `json:"project_access"`
			GroupAccess *struct {
				AccessLevel int `json:"access_level"`
			} `json:"group_access"`
		} `json:"permissions"`
	}
	if err := c.glGetJSON(ctx, "/projects/"+c.glID(), token, &m, maxListBody); err != nil {
		return nil, err
	}
	out := &RepoMeta{FullName: m.PathWithNamespace, Description: m.Description,
		DefaultBranch: m.DefaultBranch, Private: m.Visibility == "private",
		Stars: m.StarCount, Forks: m.ForksCount, OpenIssues: m.OpenIssuesCount,
		UpdatedAt: m.LastActivityAt, CloneURL: m.HTTPURLToRepo, WebURL: m.WebURL}
	if m.Permissions != nil {
		lvl := 0
		if m.Permissions.ProjectAccess != nil {
			lvl = m.Permissions.ProjectAccess.AccessLevel
		} else if m.Permissions.GroupAccess != nil {
			lvl = m.Permissions.GroupAccess.AccessLevel
		}
		out.Pull = lvl >= 10 // Guest
		out.Push = lvl >= 30 // Developer
		out.Admin = lvl >= 40
	}
	return out, nil
}

func (c *Client) glTree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
	if ref == "" {
		ref = "HEAD"
	}
	var list []struct {
		Path string `json:"path"`
		Type string `json:"type"` // blob|tree
		Mode string `json:"mode"`
	}
	p := "/projects/" + c.glID() + "/repository/tree?ref=" + url.QueryEscape(ref) +
		"&pagination=keyset&per_page=100&recursive=true"
	if path != "" {
		p += "&path=" + url.QueryEscape(strings.Trim(path, "/"))
	}
	if err := c.glGetJSON(ctx, p, token, &list, maxTreeBody); err != nil {
		return nil, false, err
	}
	out := make([]TreeEntry, 0, len(list))
	for _, e := range list {
		typ := e.Type
		if typ == "" && strings.HasPrefix(e.Mode, "04") {
			typ = "tree"
		}
		out = append(out, TreeEntry{Path: e.Path, Type: typ})
	}
	return out, false, nil
}

func (c *Client) glFile(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
	if ref == "" {
		ref = "HEAD"
	}
	p := "/projects/" + c.glID() + "/repository/files/" + url.PathEscape(strings.TrimPrefix(path, "/")) +
		"/raw?ref=" + url.QueryEscape(ref)
	data, err := c.do(ctx, "GET", c.host.APIBase+p, token, nil, "", maxFileBody)
	if err != nil {
		return nil, err
	}
	sha := ""
	if rangeSpec == "" {
		var f struct {
			SHA string `json:"content_sha256"` // raw endpoint gives no sha;
		}
		_ = f // blob sha isn't exposed on the raw route; PUT takes last_commit_id optionally — omitted
	}
	return buildFileContent(path, sha, data, rangeSpec), nil
}

func (c *Client) glBranches(ctx context.Context, token string) ([]string, error) {
	var list []struct {
		Name string `json:"name"`
	}
	if err := c.glGetJSON(ctx, "/projects/"+c.glID()+"/repository/branches?per_page=100", token, &list, maxListBody); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list))
	for _, b := range list {
		out = append(out, b.Name)
	}
	return out, nil
}

func (c *Client) glCommits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
	limit = clampLimit(limit, 30)
	var rows []struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		AuthorName string `json:"author_name"`
		CreatedAt string `json:"created_at"`
	}
	p := "/projects/" + c.glID() + "/repository/commits?per_page=" + fmt.Sprint(limit)
	if path != "" {
		p += "&path=" + url.QueryEscape(path)
	}
	if ref != "" {
		p += "&ref_name=" + url.QueryEscape(ref)
	}
	if err := c.glGetJSON(ctx, p, token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Commit, 0, len(rows))
	for _, r := range rows {
		out = append(out, Commit{SHA: r.ID, Message: firstLine(r.Title),
			Author: r.AuthorName, Date: r.CreatedAt})
	}
	return out, nil
}

func (c *Client) glIssues(ctx context.Context, state, token string, limit int) ([]Issue, error) {
	limit = clampLimit(limit, 30)
	if state == "" {
		state = "all"
	}
	var rows []struct {
		IID       int    `json:"iid"`
		Title     string `json:"title"`
		State     string `json:"state"`
		UpdatedAt string `json:"updated_at"`
		WebURL    string `json:"web_url"`
		Description string `json:"description"`
		Author    struct {
			Username string `json:"username"`
		} `json:"author"`
	}
	if err := c.glGetJSON(ctx, "/projects/"+c.glID()+"/issues?state="+
		url.QueryEscape(state)+"&per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Issue, 0, len(rows))
	for _, r := range rows {
		out = append(out, Issue{Number: r.IID, Title: r.Title, State: r.State,
			Author: r.Author.Username, UpdatedAt: r.UpdatedAt,
			Body: clip(r.Description, 400), URL: r.WebURL})
	}
	return out, nil
}

func (c *Client) glPulls(ctx context.Context, state, token string, limit int) ([]PullRequest, error) {
	limit = clampLimit(limit, 30)
	if state == "" {
		state = "opened"
	}
	var rows []struct {
		IID       int    `json:"iid"`
		Title     string `json:"title"`
		State     string `json:"state"`
		UpdatedAt string `json:"updated_at"`
		WebURL    string `json:"web_url"`
		Author    struct {
			Username string `json:"username"`
		} `json:"author"`
		SourceBranch string `json:"source_branch"`
	}
	if err := c.glGetJSON(ctx, "/projects/"+c.glID()+"/merge_requests?state="+
		url.QueryEscape(state)+"&per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]PullRequest, 0, len(rows))
	for _, r := range rows {
		out = append(out, PullRequest{Number: r.IID, Title: r.Title, State: r.State,
			Author: r.Author.Username, Branch: r.SourceBranch,
			UpdatedAt: r.UpdatedAt, URL: r.WebURL})
	}
	return out, nil
}

func (c *Client) glReleases(ctx context.Context, token string, limit int) ([]Release, error) {
	limit = clampLimit(limit, 20)
	var rows []struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		ReleasedAt  string `json:"released_at"`
		Description string `json:"description"`
		Assets      struct {
			Links []struct {
				Name string `json:"name"`
			} `json:"links"`
		} `json:"assets"`
		Commit struct {
			WebURL string `json:"web_url"`
		} `json:"commit"`
	}
	if err := c.glGetJSON(ctx, "/projects/"+c.glID()+"/releases?per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]Release, 0, len(rows))
	for _, r := range rows {
		out = append(out, Release{Tag: r.TagName, Name: r.Name, PublishedAt: r.ReleasedAt,
			Notes: clip(r.Description, 600), URL: r.Commit.WebURL,
			Assets: len(r.Assets.Links)})
	}
	return out, nil
}

func (c *Client) glPutFile(ctx context.Context, path, branch, message, content, sha, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("writing to GitLab needs a token")
	}
	body := map[string]any{
		"branch":         branch,
		"content":        base64.StdEncoding.EncodeToString([]byte(content)),
		"commit_message": message,
		"encoding":       "base64",
	}
	if sha != "" {
		body["last_commit_id"] = sha
	}
	b, _ := json.Marshal(body)
	p := "/projects/" + c.glID() + "/repository/files/" + url.PathEscape(strings.TrimPrefix(path, "/"))
	data, err := c.do(ctx, "PUT", c.host.APIBase+p, token, b, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	var out struct {
		WebURL string `json:"web_url"`
	}
	_ = json.Unmarshal(data, &out)
	return out.WebURL, nil
}

func (c *Client) glFork(ctx context.Context, token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("forking needs a GitLab token")
	}
	var out struct {
		PathWithNamespace string `json:"path_with_namespace"`
	}
	data, err := c.do(ctx, "POST", c.host.APIBase+"/projects/"+c.glID()+"/fork",
		token, nil, "application/json", maxListBody)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	return out.PathWithNamespace, nil
}

func (c *Client) glCreateRepo(ctx context.Context, name, desc, license, gitignore string, private bool, token string) (*RepoMeta, error) {
	if token == "" {
		return nil, fmt.Errorf("creating a GitLab repo needs a token")
	}
	body := map[string]any{"name": name, "path": name, "description": desc,
		"visibility": map[bool]string{true: "private", false: "public"}[private],
		"initialize_with_readme": true}
	if license != "" {
		body["license"] = license
	}
	b, _ := json.Marshal(body)
	var m struct {
		PathWithNamespace string `json:"path_with_namespace"`
		Description       string `json:"description"`
		DefaultBranch     string `json:"default_branch"`
		HTTPURLToRepo     string `json:"http_url_to_repo"`
		WebURL            string `json:"web_url"`
	}
	data, err := c.do(ctx, "POST", c.host.APIBase+"/projects", token, b, "application/json", maxListBody)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &RepoMeta{FullName: m.PathWithNamespace, Description: m.Description,
		DefaultBranch: m.DefaultBranch, Private: private,
		CloneURL: m.HTTPURLToRepo, WebURL: m.WebURL}, nil
}

func (c *Client) glListUserRepos(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
	limit = clampLimit(limit, 50)
	var rows []struct {
		PathWithNamespace string `json:"path_with_namespace"`
		Description       string `json:"description"`
		DefaultBranch     string `json:"default_branch"`
		Visibility        string `json:"visibility"`
		HTTPURLToRepo     string `json:"http_url_to_repo"`
		WebURL            string `json:"web_url"`
		LastActivityAt    string `json:"last_activity_at"`
	}
	if err := c.glGetJSON(ctx, "/projects?membership=true&owned=true&order_by=last_activity_at&per_page="+
		fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
		return nil, err
	}
	out := make([]RepoMeta, 0, len(rows))
	for _, r := range rows {
		out = append(out, RepoMeta{FullName: r.PathWithNamespace,
			Description: r.Description, DefaultBranch: r.DefaultBranch,
			Private: r.Visibility == "private", CloneURL: r.HTTPURLToRepo,
			WebURL: r.WebURL, UpdatedAt: r.LastActivityAt})
	}
	return out, nil
}

func (c *Client) glGetJSON(ctx context.Context, path, token string, out any, limit int64) error {
	data, err := c.do(ctx, "GET", c.host.APIBase+path, token, nil, "", limit)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}
