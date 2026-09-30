// hf.go — the huggingface.co adapter (v0.78.2 THE HF FORGE).
//
// User spec: "Hugging Face repos still can't use bash or grep or shell or
// ls" — because the forge layer had no huggingface.co kind, no HF URL could
// even connect as a workspace. This adapter makes HF repos (models,
// datasets and Spaces) first-class: connect, ls/tree, grep (the engine-side
// universal grep just works — recursive tree + file fetch), read (with the
// head:/tail:/lines: ranges), branches, commits, discussions (HF unifies
// issues/PRs/discussions into one endpoint), write (the NDJSON commit API —
// text files; binaries need the LFS dance and refuse with a clean error),
// create-repo and the user's own repo listing for the discover picker.
//
// VERIFIED AGAINST THE LIVE HUB (2026-09-30, token probes):
//
//      GET  /api/{models|datasets|spaces}/{repo}              repo card
//      GET  /api/{type}/{repo}/tree/{rev}[/{dir}]?recursive=  tree listing
//      GET  {web}/[{datasets|spaces}/]{repo}/resolve/{rev}/{path}  file
//      GET  /api/{type}/{repo}/refs                            {branches,tags}
//      GET  /api/{type}/{repo}/commits/{rev}                  [{id,title,…}]
//      GET  /api/{type}/{repo}/discussions                    {discussions:[…]}
//      POST /api/{type}/{repo}/commit/{rev}                   NDJSON commit
//      POST /api/repos/create                                  {type,name,…}
//      GET  /api/{models|datasets|spaces}?author={u}&limit=N  own repos
//      GET  /api/whoami-v2                                     {name}
//
// ACCESS MODEL (honest, no invented permissions): HF exposes no per-repo
// permission probe, so — with a token: the token's whoami name == repo
// owner ⇒ full (your repo); anything readable-with-token ⇒ partial;
// public without token ⇒ read. Push failures surface the hub's own 403.
//
// The repo TYPE (model/dataset/space) rides HostInfo.HFType, parsed from
// the URL by Recognize (bare /owner/repo = model; /datasets/… and
// /spaces/… prefixed) and re-derived from the stored RepoURL by wsClient —
// plus a meta.hf_type copy for the UI at connect time.
package forge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// hfBase is the Hub's web base — a var so the offline tests can point the
// adapter at a fake hub (httptest) while production stays pinned.
var hfBase = "https://huggingface.co"

// hfType returns the repo type segment ("models"|"datasets"|"spaces").
func (c *Client) hfType() string {
	switch c.host.HFType {
	case "datasets", "spaces":
		return c.host.HFType
	default:
		return "models"
	}
}

// hfPath builds an /api/… URL for this repo (type-prefixed) + a suffix.
func (c *Client) hfPath(suffix string) string {
	return hfBase + "/api/" + c.hfType() + "/" + c.host.Owner + "/" + c.host.Repo + suffix
}

// hfResolve builds the file-download URL (resolve follows redirects to the
// CDN for LFS objects — the plain Go client follows, same as GitHub's
// codeload/media hops).
func (c *Client) hfResolve(ref, path string) string {
	prefix := ""
	if t := c.hfType(); t != "models" {
		prefix = t + "/"
	}
	if ref == "" {
		ref = "main"
	}
	return hfBase + "/" + prefix + c.host.Owner + "/" + c.host.Repo + "/resolve/" + url.PathEscape(ref) + "/" + strings.TrimPrefix(path, "/")
}

// hfGitURL is the git-over-HTTPS clone URL (spaces/datasets carry the type
// prefix; models are bare).
func (c *Client) hfGitURL() string {
	prefix := ""
	if t := c.hfType(); t != "models" {
		prefix = t + "/"
	}
	return hfBase + "/" + prefix + c.host.Owner + "/" + c.host.Repo + ".git"
}

// hfWhoami resolves (and caches per Client) the token's login.
func (c *Client) hfWhoami(ctx context.Context, token string) string {
	if c.hfUserDone || token == "" {
		return c.hfUser
	}
	c.hfUserDone = true
	body, err := c.do(ctx, "GET", hfBase+"/api/whoami-v2", token, nil, "", 64<<10)
	if err != nil {
		return ""
	}
	var w struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(body, &w) == nil {
		c.hfUser = w.Name
	}
	return c.hfUser
}

// ── repo surface ──────────────────────────────────────────────────────────

func (c *Client) hfRepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
	body, err := c.do(ctx, "GET", c.hfPath(""), token, nil, "", maxTreeBody)
	if err != nil {
		return nil, err
	}
	var card struct {
		ID           string `json:"id"`
		Private      bool   `json:"private"`
		Downloads    int    `json:"downloads"`
		Likes        int    `json:"likes"`
		LastModified string `json:"lastModified"`
		SDK          string `json:"sdk"`
		CardData     *struct {
			Summary   string `json:"summary"`
			Language  any    `json:"language"`
			License   any    `json:"license"`
			BaseModel string `json:"base_model"`
		} `json:"cardData"`
	}
	if err := json.Unmarshal(body, &card); err != nil {
		return nil, fmt.Errorf("hf: repo card: %w", err)
	}
	desc := card.SDK
	if card.CardData != nil && card.CardData.Summary != "" {
		desc = card.CardData.Summary
	} else if card.CardData != nil && card.CardData.BaseModel != "" {
		desc = "base model " + card.CardData.BaseModel
	}
	m := &RepoMeta{
		FullName:      card.ID,
		Description:   desc,
		DefaultBranch: "main",
		Private:       card.Private,
		Stars:         card.Likes,
		Forks:         0,
		OpenIssues:    0,
		UpdatedAt:     card.LastModified,
		CloneURL:      c.hfGitURL(),
		WebURL:        strings.TrimSuffix(c.hfGitURL(), ".git"),
	}
	if token != "" {
		// honest access: no per-repo permission probe exists on the hub —
		// your own repo (whoami == owner) is full; readable-with-token is
		// partial; everything else reads.
		m.Pull = true
		if owner := c.hfWhoami(ctx, token); owner != "" && owner == c.host.Owner {
			m.Push = true
		}
	}
	return m, nil
}

// hfTree: path "" → the WHOLE tree (recursive=true — the engine's universal
// grep depends on this contract, same as github/gitea); a path → that one
// directory's entries. HF pages at 1000 entries — an exactly-full page is
// reported truncated so callers fall back to per-directory walks.
func (c *Client) hfTree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
	if ref == "" {
		ref = "main"
	}
	u := c.hfPath("/tree/" + url.PathEscape(ref))
	if p := strings.Trim(path, "/"); p != "" {
		u += "/" + p
	} else {
		u += "?recursive=true"
	}
	body, err := c.do(ctx, "GET", u, token, nil, "", maxTreeBody)
	if err != nil {
		return nil, false, err
	}
	var entries []struct {
		Type string `json:"type"` // file|directory
		OID  string `json:"oid"`
		Size int64  `json:"size"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, false, fmt.Errorf("hf: tree: %w", err)
	}
	out := make([]TreeEntry, 0, len(entries))
	for _, e := range entries {
		typ := "tree"
		if e.Type == "file" {
			typ = "blob"
		}
		out = append(out, TreeEntry{Path: e.Path, Type: typ, Size: e.Size, SHA: e.OID})
	}
	return out, len(out) == 1000, nil
}

func (c *Client) hfFile(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
	data, err := c.do(ctx, "GET", c.hfResolve(ref, path), token, nil, "", maxFileBody)
	if err != nil {
		return nil, err
	}
	return buildFileContent(strings.TrimPrefix(path, "/"), "", data, rangeSpec), nil
}

func (c *Client) hfBranches(ctx context.Context, token string) ([]string, error) {
	body, err := c.do(ctx, "GET", c.hfPath("/refs"), token, nil, "", maxListBody)
	if err != nil {
		return nil, err
	}
	var refs struct {
		Branches []struct {
			Name string `json:"name"`
		} `json:"branches"`
	}
	if err := json.Unmarshal(body, &refs); err != nil {
		return nil, fmt.Errorf("hf: refs: %w", err)
	}
	out := make([]string, 0, len(refs.Branches))
	for _, b := range refs.Branches {
		out = append(out, b.Name)
	}
	return out, nil
}

func (c *Client) hfCommits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
	if ref == "" {
		ref = "main"
	}
	limit = clampLimit(limit, 30)
	body, err := c.do(ctx, "GET", c.hfPath("/commits/"+url.PathEscape(ref)+"?limit="+strconv.Itoa(limit)), token, nil, "", maxListBody)
	if err != nil {
		return nil, err
	}
	var list []struct {
		ID      string `json:"id"`
		Title   string `json:"title"`
		Message string `json:"message"`
		Authors []struct {
			User string `json:"user"`
			Name string `json:"name"`
		} `json:"authors"`
		Date string `json:"date"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("hf: commits: %w", err)
	}
	out := make([]Commit, 0, len(list))
	for _, cm := range list {
		msg := cm.Title
		if msg == "" {
			msg = cm.Message
		}
		author := ""
		if len(cm.Authors) > 0 {
			author = cm.Authors[0].User
			if author == "" {
				author = cm.Authors[0].Name
			}
		}
		out = append(out, Commit{SHA: cm.ID, Message: msg, Author: author, Date: cm.Date})
	}
	return out, nil
}

// ── discussions (HF unifies issues / pull requests / discussions) ──────────

func (c *Client) hfDiscussions(ctx context.Context, token string, want string, limit int) ([]map[string]any, error) {
	limit = clampLimit(limit, 30)
	body, err := c.do(ctx, "GET", c.hfPath("/discussions?limit="+strconv.Itoa(limit)), token, nil, "", maxListBody)
	if err != nil {
		return nil, err
	}
	var page struct {
		Discussions []struct {
			Number int    `json:"number"`
			Title  string `json:"title"`
			Status string `json:"status"`
			Type   string `json:"type"`
			Author struct {
				Name string `json:"name"`
			} `json:"author"`
			CreatedAt any `json:"createdAt"`
			URL        any `json:"url"`
		} `json:"discussions"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, fmt.Errorf("hf: discussions: %w", err)
	}
	out := []map[string]any{}
	for _, d := range page.Discussions {
		if want != "" && d.Type != want {
			continue
		}
		u, _ := d.URL.(string)
		if u == "" {
			u = strings.TrimSuffix(c.hfGitURL(), ".git") + "/discussions/" + fmt.Sprint(d.Number)
		}
		out = append(out, map[string]any{
			"number": d.Number, "title": d.Title, "state": d.Status,
			"author": d.Author.Name, "url": u,
		})
	}
	return out, nil
}

func (c *Client) hfIssues(ctx context.Context, state, token string, limit int) ([]Issue, error) {
	rows, err := c.hfDiscussions(ctx, token, "issue", limit)
	if err != nil {
		return nil, err
	}
	out := make([]Issue, 0, len(rows))
	for _, r := range rows {
		out = append(out, Issue{
			Number: toInt(r["number"]), Title: str(r["title"]), State: str(r["state"]),
			Author: str(r["author"]), URL: str(r["url"]),
		})
	}
	return out, nil
}

func (c *Client) hfPulls(ctx context.Context, state, token string, limit int) ([]PullRequest, error) {
	rows, err := c.hfDiscussions(ctx, token, "pull-request", limit)
	if err != nil {
		return nil, err
	}
	out := make([]PullRequest, 0, len(rows))
	for _, r := range rows {
		out = append(out, PullRequest{
			Number: toInt(r["number"]), Title: str(r["title"]), State: str(r["state"]),
			Author: str(r["author"]), URL: str(r["url"]),
		})
	}
	return out, nil
}

func (c *Client) hfDiscussionList(ctx context.Context, token string, limit int) ([]Discussion, error) {
	rows, err := c.hfDiscussions(ctx, token, "discussion", limit)
	if err != nil {
		return nil, err
	}
	out := make([]Discussion, 0, len(rows))
	for _, r := range rows {
		out = append(out, Discussion{
			Number: toInt(r["number"]), Title: str(r["title"]), Author: str(r["author"]),
			Category: "discussion", URL: str(r["url"]),
		})
	}
	return out, nil
}

// ── write path: the NDJSON commit API (text files only) ───────────────────

func (c *Client) hfPutFile(ctx context.Context, path, branch, message, content, sha, token string) (string, error) {
	if !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return "", fmt.Errorf("hf: binary content isn't supported via the API commit path yet (text only)")
	}
	if branch == "" {
		branch = "main"
	}
	if strings.TrimSpace(message) == "" {
		message = "Update " + path
	}
	headerLine, _ := json.Marshal(map[string]any{
		"key":   "header",
		"value": map[string]string{"summary": message, "description": ""},
	})
	fileLine, _ := json.Marshal(map[string]any{
		"key": "file",
		"value": map[string]any{
			"path":     strings.TrimPrefix(path, "/"),
			"content":  base64.StdEncoding.EncodeToString([]byte(content)),
			"encoding": "base64",
		},
	})
	body := append(headerLine, '\n')
	body = append(body, fileLine...)
	body = append(body, '\n')
	resp, err := c.do(ctx, "POST", c.hfPath("/commit/"+url.PathEscape(branch)), token, body, "application/x-ndjson", maxListBody)
	if err != nil {
		return "", err
	}
	var out struct {
		CommitID string `json:"commitId"`
		Oid      string `json:"oid"`
	}
	_ = json.Unmarshal(resp, &out)
	if out.CommitID != "" {
		return out.CommitID, nil
	}
	return out.Oid, nil
}

// ── create + discover ──────────────────────────────────────────────────────

func (c *Client) hfCreateRepo(ctx context.Context, name, desc, license, gitignore string, private bool, token string) (*RepoMeta, error) {
	typ := c.hfType()
	singular := map[string]string{"models": "model", "datasets": "dataset", "spaces": "space"}[typ]
	payload, _ := json.Marshal(map[string]any{
		"type":  singular,
		"name":  name,
		"private": private,
	})
	if _, err := c.do(ctx, "POST", hfBase+"/api/repos/create", token, payload, "application/json", maxListBody); err != nil {
		var se *StatusError
		if ok := asStatus(err, &se); ok && se.Status == http.StatusConflict {
			// exists — fine (same contract as the hub client)
		} else {
			return nil, err
		}
	}
	owner := c.hfWhoami(ctx, token)
	full := name
	if owner != "" {
		full = owner + "/" + name
	}
	return &RepoMeta{
		FullName: full, Description: desc, DefaultBranch: "main", Private: private,
		CloneURL: hfBase + "/" + map[string]string{"models": "", "datasets": "datasets/", "spaces": "spaces/"}[typ] + full + ".git",
		WebURL:   hfBase + "/" + map[string]string{"models": "", "datasets": "datasets/", "spaces": "spaces/"}[typ] + full,
	}, nil
}

func (c *Client) hfListUserRepos(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
	user := c.hfWhoami(ctx, token)
	if user == "" {
		return nil, fmt.Errorf("hf: no signed-in token — sign in to Hugging Face first to list your repos")
	}
	limit = clampLimit(limit, 50)
	out := []RepoMeta{}
	for _, typ := range []string{"models", "datasets", "spaces"} {
		if len(out) >= limit {
			break
		}
		u := hfBase + "/api/" + typ + "?author=" + url.QueryEscape(user) +
			"&limit=" + fmt.Sprint(limit) + "&sort=lastModified&direction=-1"
		body, err := c.do(ctx, "GET", u, token, nil, "", maxListBody)
		if err != nil {
			continue // one type failing (e.g. gated) never kills the picker
		}
		var list []struct {
			ID           string `json:"id"`
			Private      bool   `json:"private"`
			Likes        int    `json:"likes"`
			LastModified string `json:"lastModified"`
		}
		if json.Unmarshal(body, &list) != nil {
			continue
		}
		prefix := map[string]string{"models": "", "datasets": "datasets/", "spaces": "spaces/"}[typ]
		for _, r := range list {
			if len(out) >= limit {
				break
			}
			out = append(out, RepoMeta{
				FullName: r.ID, DefaultBranch: "main", Private: r.Private,
				Stars: r.Likes, UpdatedAt: r.LastModified,
				CloneURL: hfBase + "/" + prefix + r.ID + ".git",
				WebURL:   hfBase + "/" + prefix + r.ID,
			})
		}
	}
	return out, nil
}

// asStatus is errors.As without the import dance in call sites.
func asStatus(err error, target **StatusError) bool {
	if se, ok := err.(*StatusError); ok {
		*target = se
		return true
	}
	return false
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
