// hf.go — the Hugging Face Hub REST client (engine-side; the PWA never
// talks to HF directly — vault rule + cross-origin).
//
// Endpoint shapes VERIFIED against huggingface_hub @ main (hf_api.py +
// _commit_api.py + lfs.py, fetched 2026-09) and the live
// huggingface.co/.well-known/openapi.json:
//
//	GET  /api/whoami-v2                          (Bearer; 401 bad token)
//	GET  /api/datasets?filter=<tag>&limit=100    (tag discovery)
//	GET  /api/datasets/<repo>                    (repo card; 404 missing)
//	GET  /datasets/<repo>/resolve/main/<path>     (307 → CDN; follow)
//	POST /api/repos/create                        {"type","name","organization","private"}
//	POST /api/datasets/<repo>/preupload/main      (per-file LFS vs regular)
//	POST /datasets/<repo>.git/info/lfs/objects/batch (LFS upload URLs)
//	POST /api/datasets/<repo>/commit/main         (NDJSON, see CommitFiles)
//	POST/DELETE /api/datasets/<repo>/like         (repo-level like)
//
// House rules (from llm/httpx.go): netx.Transport() for every dial (the
// Android pure-Go-resolver DoH fix), one browser UA, capped response reads,
// error URLs redacted to path-only.
package hub

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// hubUA mirrors llm.httpx's browser UA (CDNs challenge the default Go UA).
const hubUA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

// limits: hub items are ≤64KB payloads + ≤6MB PNGs; 8MB is the hard read cap.
const hubMaxBody = 8 << 20

// HFClient is the (stateless) REST client against one HF instance.
type HFClient struct {
	base   string
	client *http.Client
}

// NewHFClient builds a client for base ("https://huggingface.co" or a mock).
func NewHFClient(base string) *HFClient {
	if base == "" {
		base = "https://huggingface.co"
	}
	return &HFClient{
		base: strings.TrimSuffix(base, "/"),
		// 15s: discovery fans out over several repos (bounded 6-wide) and
		// resolve hops through a 307 to a CDN — 9s (the provider catalog's
		// budget) felt tight for that; still short enough to fail fast.
		client: &http.Client{Timeout: 15 * time.Second, Transport: netx.Transport()},
	}
}

// HFError carries a non-2xx response so callers can branch on the status
// (401 bad token, 404 missing repo, 409 already-exists, …).
type HFError struct {
	Status int
	Path   string // redacted (path only, no query)
	Body   string
}

func (e *HFError) Error() string {
	return fmt.Sprintf("hf: HTTP %d from %s", e.Status, e.Path)
}

// IsNotFound reports whether err is an HF 404.
func IsNotFound(err error) bool {
	var hfErr *HFError
	return errors.As(err, &hfErr) && hfErr.Status == http.StatusNotFound
}

// IsUnauthorized reports whether err is an HF 401 (bad/expired token).
func IsUnauthorized(err error) bool {
	var hfErr *HFError
	return errors.As(err, &hfErr) && hfErr.Status == http.StatusUnauthorized
}

// RepoCard is the subset of the dataset card the hub uses.
type RepoCard struct {
	ID           string   `json:"id"`
	Author       string   `json:"author"`
	Private      bool     `json:"private"`
	LastModified string   `json:"lastModified"`
	Likes        int      `json:"likes"`
	Downloads    int      `json:"downloads"`
	Tags         []string `json:"tags"`
}

// do runs one request (JSON in, raw out). A non-2xx returns *HFError.
func (c *HFClient) do(method, path, token string, body []byte, contentType string) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", hubUA)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("hf: %s %s: %w", method, redactPath(path), err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, hubMaxBody))
	if err != nil {
		return nil, fmt.Errorf("hf: %s %s: read: %w", method, redactPath(path), err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HFError{Status: resp.StatusCode, Path: redactPath(path), Body: string(out)}
	}
	return out, nil
}

func (c *HFClient) getJSON(path, token string) ([]byte, error) {
	return c.do("GET", path, token, nil, "")
}

func (c *HFClient) postJSON(path, token string, v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return c.do("POST", path, token, body, "application/json")
}

// redactPath strips the query (queries can carry filter values for logs).
func redactPath(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i]
	}
	return p
}

// WhoAmI verifies a token and returns the account name. Only user tokens are
// accepted (an org token cannot own the per-user dataset repos).
func (c *HFClient) WhoAmI(token string) (string, error) {
	body, err := c.getJSON("/api/whoami-v2", token)
	if err != nil {
		return "", err
	}
	var who struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &who); err != nil {
		return "", fmt.Errorf("hf: whoami: %w", err)
	}
	if who.Type != "user" || who.Name == "" {
		return "", fmt.Errorf("hf: whoami: token is not a user token")
	}
	return who.Name, nil
}

// ListReposByTag returns dataset repos carrying a tag (≤100 — one page,
// enough for v0.31 federated discovery).
func (c *HFClient) ListReposByTag(tag string) ([]RepoCard, error) {
	body, err := c.getJSON("/api/datasets?filter="+urlQueryEscape(tag)+"&limit=100", "")
	if err != nil {
		return nil, err
	}
	var cards []RepoCard
	if err := json.Unmarshal(body, &cards); err != nil {
		return nil, fmt.Errorf("hf: datasets by tag: %w", err)
	}
	return cards, nil
}

// escapeRepo URL-escapes a repo id ("user/name") so it survives as ONE path
// segment — Go's ServeMux and huggingface.co both decode %2F (the Python
// client quotes repo ids the same way).
func escapeRepo(repo string) string {
	return strings.ReplaceAll(repo, "/", "%2F")
}

// GetRepo fetches one dataset card; (nil, nil) when the repo is missing.
func (c *HFClient) GetRepo(repo string) (*RepoCard, error) {
	body, err := c.getJSON("/api/datasets/"+escapeRepo(repo), "")
	if err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	var card RepoCard
	if err := json.Unmarshal(body, &card); err != nil {
		return nil, fmt.Errorf("hf: repo card: %w", err)
	}
	return &card, nil
}

// FetchFile downloads one file from a repo's main branch (redirects to the
// CDN are followed by the Go client automatically).
func (c *HFClient) FetchFile(repo, path string) ([]byte, error) {
	return c.getJSON("/datasets/"+escapeRepo(repo)+"/resolve/main/"+path, "")
}

// TreeEntry is one repo tree listing entry (the index fallback).
type TreeEntry struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int    `json:"size"`
}

// ListTree lists a directory inside a repo's main branch (non-recursive).
func (c *HFClient) ListTree(repo, dir string) ([]TreeEntry, error) {
	body, err := c.getJSON("/api/datasets/"+escapeRepo(repo)+"/tree/main"+dir, "")
	if err != nil {
		return nil, err
	}
	var entries []TreeEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("hf: tree: %w", err)
	}
	return entries, nil
}

// CreateRepo creates a public dataset repo. namespace "" → the token
// owner's namespace. A 409 (already exists) is NOT an error.
func (c *HFClient) CreateRepo(token, namespace, name string) error {
	payload := map[string]any{
		"type":         "dataset",
		"name":         name,
		"organization": nil,
		"private":      false,
	}
	if namespace != "" {
		payload["organization"] = namespace
	}
	_, err := c.postJSON("/api/repos/create", token, payload)
	var hfErr *HFError
	if err != nil && errors.As(err, &hfErr) && hfErr.Status == http.StatusConflict {
		return nil // exists — fine
	}
	return err
}

// CommitFile is one file in a commit (content = raw bytes).
type CommitFile struct {
	Path    string
	Content []byte
}

// CommitFiles atomically writes files to a repo's main branch.
//
// VERIFIED SHAPE (huggingface_hub _commit_api._prepare_commit_payload +
// _send_commit): POST /api/datasets/<repo>/commit/main with
// Content-Type: application/x-ndjson and one JSON object per line:
//
//	{"key":"header","value":{"summary":"<msg>","description":""}}
//	{"key":"file","value":{"path":…,"content":<b64>,"encoding":"base64"}}
//	{"key":"lfsFile","value":{"path":…,"algo":"sha256","oid":<sha256>,"size":N}}
//
// Binary extensions (*.png — dataset repos' default .gitattributes routes
// them to LFS) MUST go through the LFS protocol first: preupload asks the
// server per-file, the LFS batch endpoint hands a presigned PUT URL, and the
// commit then references the uploaded object by oid+size.
func (c *HFClient) CommitFiles(token, repo, message string, files []CommitFile) error {
	if len(files) == 0 {
		return nil
	}
	modes, err := c.preupload(token, repo, files)
	if err != nil {
		return err
	}
	var lfsFiles []CommitFile
	for _, f := range files {
		if modes[f.Path] == "lfs" {
			lfsFiles = append(lfsFiles, f)
		}
	}
	if err := c.uploadLFS(token, repo, lfsFiles); err != nil {
		return err
	}

	var buf bytes.Buffer
	w := func(v any) {
		line, _ := json.Marshal(v)
		buf.Write(line)
		buf.WriteByte('\n')
	}
	w(map[string]any{"key": "header", "value": map[string]string{"summary": message, "description": ""}})
	for _, f := range files {
		if modes[f.Path] == "lfs" {
			sum := sha256.Sum256(f.Content)
			w(map[string]any{"key": "lfsFile", "value": map[string]any{
				"path": f.Path, "algo": "sha256",
				"oid": hex.EncodeToString(sum[:]), "size": len(f.Content),
			}})
			continue
		}
		w(map[string]any{"key": "file", "value": map[string]any{
			"path":     f.Path,
			"content":  base64.StdEncoding.EncodeToString(f.Content),
			"encoding": "base64",
		}})
	}
	_, err = c.do("POST", "/api/datasets/"+escapeRepo(repo)+"/commit/main", token, buf.Bytes(), "application/x-ndjson")
	return err
}

// preupload asks the server each file's upload mode ("regular" vs "lfs").
func (c *HFClient) preupload(token, repo string, files []CommitFile) (map[string]string, error) {
	type preFile struct {
		Path   string `json:"path"`
		Size   int    `json:"size"`
		Sample string `json:"sample"` // first ≤512 bytes, b64 (content sniffing)
	}
	payload := struct {
		Files []preFile `json:"files"`
	}{}
	for _, f := range files {
		sample := f.Content
		if len(sample) > 512 {
			sample = sample[:512]
		}
		payload.Files = append(payload.Files, preFile{
			Path:   f.Path,
			Size:   len(f.Content),
			Sample: base64.StdEncoding.EncodeToString(sample),
		})
	}
	body, err := c.postJSON("/api/datasets/"+escapeRepo(repo)+"/preupload/main", token, payload)
	if err != nil {
		return nil, err
	}
	var out struct {
		Files []struct {
			Path       string `json:"path"`
			UploadMode string `json:"uploadMode"`
		} `json:"files"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("hf: preupload: %w", err)
	}
	modes := map[string]string{}
	for _, f := range out.Files {
		modes[f.Path] = f.UploadMode
	}
	return modes, nil
}

// uploadLFS pushes objects via the git-lfs batch API ("basic" transfer):
// POST <base>/datasets/<repo>.git/info/lfs/objects/batch → presigned PUT.
func (c *HFClient) uploadLFS(token, repo string, files []CommitFile) error {
	if len(files) == 0 {
		return nil
	}
	type obj struct {
		Oid  string `json:"oid"`
		Size int    `json:"size"`
	}
	payload := struct {
		Operation string   `json:"operation"`
		Transfers []string `json:"transfers"`
		Objects   []obj    `json:"objects"`
		Ref       struct {
			Name string `json:"name"`
		} `json:"ref"`
	}{Operation: "upload", Transfers: []string{"basic"}}
	payload.Ref.Name = "refs/heads/main"
	content := map[string][]byte{}
	for _, f := range files {
		sum := sha256.Sum256(f.Content)
		oid := hex.EncodeToString(sum[:])
		payload.Objects = append(payload.Objects, obj{Oid: oid, Size: len(f.Content)})
		content[oid] = f.Content
	}
	body, err := c.do("POST", "/datasets/"+escapeRepo(repo)+".git/info/lfs/objects/batch", token,
		mustJSONBytes(payload), "application/vnd.git-lfs+json")
	if err != nil {
		return err
	}
	var batch struct {
		Objects []struct {
			Oid     string `json:"oid"`
			Actions struct {
				Upload struct {
					Href    string            `json:"href"`
					Headers map[string]string `json:"header"`
				} `json:"upload"`
			} `json:"actions"`
		} `json:"objects"`
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		return fmt.Errorf("hf: lfs batch: %w", err)
	}
	for _, o := range batch.Objects {
		data, ok := content[o.Oid]
		if !ok || o.Actions.Upload.Href == "" {
			continue
		}
		req, err := http.NewRequest("PUT", o.Actions.Upload.Href, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", hubUA)
		req.ContentLength = int64(len(data))
		for k, v := range o.Actions.Upload.Headers {
			req.Header.Set(k, v)
		}
		resp, err := c.client.Do(req)
		if err != nil {
			return fmt.Errorf("hf: lfs put: %w", err)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return &HFError{Status: resp.StatusCode, Path: "(lfs-storage)", Body: ""}
		}
	}
	return nil
}

// LikeRepo likes a dataset repo (repo-level — per-item hearts live in the
// metrics sidecars; the like is the publisher-facing signal).
func (c *HFClient) LikeRepo(token, repo string) error {
	_, err := c.do("POST", "/api/datasets/"+escapeRepo(repo)+"/like", token, nil, "")
	return err
}

// UnlikeRepo removes the like (404 = not liked — fine).
func (c *HFClient) UnlikeRepo(token, repo string) error {
	_, err := c.do("DELETE", "/api/datasets/"+escapeRepo(repo)+"/like", token, nil, "")
	var hfErr *HFError
	if err != nil && errors.As(err, &hfErr) && hfErr.Status == http.StatusNotFound {
		return nil
	}
	return err
}

// ── tiny helpers ─────────────────────────────────────────────────────────

// mustJSONBytes marshals without failing (POD payloads only).
func mustJSONBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// urlQueryEscape escapes a query value (tags are [a-z0-9-] so this is
// belt-and-braces for foreign bases in tests).
func urlQueryEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			b.WriteByte(ch)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", ch)
	}
	return b.String()
}
