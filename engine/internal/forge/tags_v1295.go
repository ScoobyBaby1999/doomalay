package forge

// tags_v1295.go — v1.29.5 THE GITHUB HAND (PLAN-V130 §5): the TAGS hand.
//
// The user: "us not having a tool for tags or generally a more
// permissible method for the model to manage repos causes hurdles and
// issues." The workspace tool's view enum had no `tags`; the only
// tag-producing verb was release_create (a tag as a side effect). The
// forge Client grows the pair every repo manager needs:
//
//   Tags(ctx, token, limit)       — list (name, sha, message when the
//                                   forge carries it)
//   CreateTag(ctx, tag, sha, message, token) — lightweight ref when no
//                                   message, annotated when one rides
//
// GitHub: GET /repos/{o}/{r}/tags · POST /git/refs (+ /git/tags for the
// annotated object). Gitea: the same REST shape. GitLab: the repository
// tags API (POST creates annotated-or-lightweight by message presence).
// HF + sourcehut: ErrUnsupported — the honest refusal.

import (
        "context"
        "encoding/json"
        "fmt"
        "strings"
)

// Tag — a repo tag row (v1.29.5).
type Tag struct {
        Name    string `json:"name"`
        SHA     string `json:"sha"`
        Message string `json:"message,omitempty"`
}

// tagRefLegal — a ref-segment sanity gate (the same law git enforces):
// no control chars, no ~^:?*[\, no leading -, no .. , no .lock tail.
func tagRefLegal(tag string) bool {
        if tag == "" || len(tag) > 200 {
                return false
        }
        if strings.HasPrefix(tag, "-") || strings.HasSuffix(tag, ".lock") ||
                strings.Contains(tag, "..") || strings.ContainsAny(tag, " ~^:?*[\\\x00") {
                return false
        }
        return true
}

// ── GitHub ────────────────────────────────────────────────────────────────

func (c *Client) ghTags(ctx context.Context, token string, limit int) ([]Tag, error) {
        limit = clampLimit(limit, 30)
        var rows []struct {
                Name   string `json:"name"`
                Commit struct {
                        SHA string `json:"sha"`
                } `json:"commit"`
        }
        if err := c.ghGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/tags?per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Tag, 0, len(rows))
        for _, r := range rows {
                out = append(out, Tag{Name: r.Name, SHA: r.Commit.SHA})
        }
        return out, nil
}

func (c *Client) ghCreateTag(ctx context.Context, tag, sha, message, token string) (string, error) {
        if token == "" {
                return "", fmt.Errorf("creating a tag needs a GitHub token")
        }
        if !tagRefLegal(tag) {
                return "", fmt.Errorf("tag name %q is not a legal ref segment", tag)
        }
        if strings.TrimSpace(sha) == "" {
                return "", fmt.Errorf("tag_create needs the target {\"sha\":\"…\"} — view commits (or the branch head) for it")
        }
        target := sha
        if strings.TrimSpace(message) != "" {
                // annotated: create the tag OBJECT at the commit, then ref the object
                payload, _ := json.Marshal(map[string]string{"tag": tag, "message": message, "object": sha, "type": "commit"})
                data, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/git/tags", token, payload, "application/json", maxListBody)
                if err != nil {
                        return "", err
                }
                var m struct {
                        SHA string `json:"sha"`
                }
                if err := json.Unmarshal(data, &m); err != nil || m.SHA == "" {
                        return "", fmt.Errorf("the annotated tag object came back without a sha")
                }
                target = m.SHA
        }
        payload, _ := json.Marshal(map[string]string{"ref": "refs/tags/" + tag, "sha": target})
        if _, err := c.do(ctx, "POST", GitHubAPIBase+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/git/refs", token, payload, "application/json", maxListBody); err != nil {
                return "", err
        }
        return "refs/tags/" + tag, nil
}

// ── Gitea (the GitHub REST shape) ─────────────────────────────────────────

func (c *Client) gtTags(ctx context.Context, token string, limit int) ([]Tag, error) {
        limit = clampLimit(limit, 30)
        var rows []struct {
                Name   string `json:"name"`
                Commit struct {
                        SHA string `json:"sha"`
                } `json:"commit"`
        }
        if err := c.gtGetJSON(ctx, "/repos/"+c.host.Owner+"/"+c.host.Repo+"/tags?limit="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Tag, 0, len(rows))
        for _, r := range rows {
                out = append(out, Tag{Name: r.Name, SHA: r.Commit.SHA})
        }
        return out, nil
}

func (c *Client) gtCreateTag(ctx context.Context, tag, sha, token string) (string, error) {
        if token == "" {
                return "", fmt.Errorf("creating a tag needs a token")
        }
        if !tagRefLegal(tag) {
                return "", fmt.Errorf("tag name %q is not a legal ref segment", tag)
        }
        if strings.TrimSpace(sha) == "" {
                return "", fmt.Errorf("tag_create needs the target {\"sha\":\"…\"}")
        }
        payload, _ := json.Marshal(map[string]string{"ref": "refs/tags/" + tag, "sha": sha})
        if _, err := c.do(ctx, "POST", c.gtAPI()+"/repos/"+c.host.Owner+"/"+c.host.Repo+"/git/refs", token, payload, "application/json", maxListBody); err != nil {
                return "", err
        }
        return "refs/tags/" + tag, nil
}

// ── GitLab (the repository tags API) ──────────────────────────────────────

func (c *Client) glTags(ctx context.Context, token string, limit int) ([]Tag, error) {
        limit = clampLimit(limit, 30)
        var rows []struct {
                Name    string `json:"name"`
                Message string `json:"message"`
                Commit  struct {
                        ID string `json:"id"`
                } `json:"commit"`
        }
        if err := c.glGetJSON(ctx, "/projects/"+c.glID()+"/repository/tags?per_page="+fmt.Sprint(limit), token, &rows, maxListBody); err != nil {
                return nil, err
        }
        out := make([]Tag, 0, len(rows))
        for _, r := range rows {
                out = append(out, Tag{Name: r.Name, SHA: r.Commit.ID, Message: firstLine(r.Message)})
        }
        return out, nil
}

func (c *Client) glCreateTag(ctx context.Context, tag, sha, message, token string) (string, error) {
        if token == "" {
                return "", fmt.Errorf("creating a tag needs a GitLab token")
        }
        if !tagRefLegal(tag) {
                return "", fmt.Errorf("tag name %q is not a legal ref segment", tag)
        }
        if strings.TrimSpace(sha) == "" {
                return "", fmt.Errorf("tag_create needs the target {\"sha\":\"…\"} (or the branch name)")
        }
        payload := map[string]string{"tag_name": tag, "ref": sha}
        if strings.TrimSpace(message) != "" {
                payload["message"] = message
        }
        b, _ := json.Marshal(payload)
        var out struct {
                Name string `json:"name"`
        }
        data, err := c.do(ctx, "POST", c.host.APIBase+"/projects/"+c.glID()+"/repository/tags", token, b, "application/json", maxListBody)
        if err != nil {
                return "", err
        }
        if err := json.Unmarshal(data, &out); err != nil {
                return "", err
        }
        return "refs/tags/" + tag, nil
}
