// client.go — the forge Client: one entry point, per-kind dispatch.
//
// The Server (workspaces.go handlers) only ever sees this type. Adapters
// live in github.go / gitea.go / gitlab.go / sourcehut.go / generic.go and
// are selected by HostInfo.Kind. An adapter that lacks an op returns
// ErrUnsupported — surfaced as a clean "this forge can't do that" message,
// never a 500.
package forge

import (
        "bytes"
        "context"
        "errors"
        "fmt"
        "io"
        "net/http"
        "strings"
        "time"
)

// ErrUnsupported: the forge kind has no such capability.
var ErrUnsupported = errors.New("this forge does not support that operation")

// ErrNotFound / ErrUnauthorized: branchable like hub.IsNotFound.
type StatusError struct {
        Status int
        Path   string
        Body   string
}

func (e *StatusError) Error() string {
        // The trimmed body carries the forge's own diagnosis (rate limit,
        // "Not Found" on private repos, bad credentials) — without it a 403
        // is undiagnosable from the UI.
        if e.Body != "" {
                b := e.Body
                if len(b) > 180 {
                        b = b[:180]
                }
                return fmt.Sprintf("forge: HTTP %d from %s: %s", e.Status, e.Path, b)
        }
        return fmt.Sprintf("forge: HTTP %d from %s", e.Status, e.Path)
}

func IsNotFound(err error) bool {
        var se *StatusError
        return errors.As(err, &se) && se.Status == http.StatusNotFound
}

func IsUnauthorized(err error) bool {
        var se *StatusError
        return errors.As(err, &se) && se.Status == http.StatusUnauthorized
}

func IsForbidden(err error) bool {
        var se *StatusError
        return errors.As(err, &se) && se.Status == http.StatusForbidden
}

// Client talks to ONE repo on ONE forge.
type Client struct {
        host HostInfo
        // guarded: true when the API base itself is user-chosen (self-hosted
        // gitea/gitlab/generic) and every dial must pass GuardURL. github.com
        // and gitlab.com use hardcoded API bases → plain client.
        guarded bool
        hc      *http.Client
        // hf: the token's whoami login, cached per Client (hfWhoami).
        hfUser     string
        hfUserDone bool
}

// NewClient builds the client for a resolved HostInfo.
func NewClient(hi HostInfo) *Client {
        guarded := hi.Kind == "gitea" || hi.Kind == "gitlab" || hi.Kind == "generic" ||
                hi.Kind == "unknown" || hi.Kind == "sourcehut"
        var hc *http.Client
        if guarded {
                hc = guardedClient(20 * time.Second)
        } else {
                hc = plainClient(20 * time.Second)
        }
        return &Client{host: hi, guarded: guarded, hc: hc}
}

// Host returns the (possibly probed) HostInfo.
func (c *Client) Host() HostInfo { return c.host }

// redactPath strips scheme/host/query — tokens ride queries on some forges
// (legacy gitlab ?private_token=), so logs must only ever see the path.
func redactPath(u string) string {
        if i := strings.Index(u, "://"); i >= 0 {
                u = u[i+3:]
        }
        if i := strings.Index(u, "/"); i >= 0 {
                u = u[i:]
        } else {
                u = "/"
        }
        if i := strings.Index(u, "?"); i >= 0 {
                u = u[:i]
        }
        return u
}

// do runs one JSON request: method, full URL, optional bearer token,
// optional body. Non-2xx → *StatusError. Guarded clients verify the URL
// before the dial (belt: GuardURL at connect; braces: CheckRedirect).
func (c *Client) do(ctx context.Context, method, fullURL, token string, body []byte, contentType string, limit int64) ([]byte, error) {
        return c.doAccept(ctx, method, fullURL, token, body, contentType, "application/json", limit)
}

// doAccept — do() with a custom Accept header (v0.81.6: the PR diff
// fetch needs application/vnd.github.diff; everything else stays JSON).
func (c *Client) doAccept(ctx context.Context, method, fullURL, token string, body []byte, contentType, accept string, limit int64) ([]byte, error) {
        if c.guarded {
                if err := GuardURL(ctx, fullURL); err != nil {
                        return nil, err
                }
        }
        var rdr io.Reader
        if body != nil {
                rdr = bytes.NewReader(body)
        }
        req, err := http.NewRequestWithContext(ctx, method, fullURL, rdr)
        if err != nil {
                return nil, err
        }
        req.Header.Set("User-Agent", forgeUA)
        req.Header.Set("Accept", accept)
        if contentType != "" {
                req.Header.Set("Content-Type", contentType)
        }
        if token != "" {
                req.Header.Set("Authorization", "Bearer "+token)
        }
        resp, err := c.hc.Do(req)
        if err != nil {
                return nil, fmt.Errorf("%s %s: %w", method, redactPath(fullURL), err)
        }
        data, rerr := httpMaxBody(resp, limit)
        if resp.StatusCode >= 400 {
                msg := string(data)
                if len(msg) > 300 {
                        msg = msg[:300]
                }
                return nil, &StatusError{Status: resp.StatusCode, Path: redactPath(fullURL), Body: msg}
        }
        if rerr != nil && !errors.Is(rerr, errBodyTooBig) {
                return nil, rerr
        }
        return data, nil
}

// ── dispatch: repo surface ────────────────────────────────────────────────

func (c *Client) RepoInfo(ctx context.Context, token string) (*RepoMeta, error) {
        switch c.host.Kind {
        case "github":
                return c.ghRepoInfo(ctx, token)
        case "gitea":
                return c.gtRepoInfo(ctx, token)
        case "gitlab":
                return c.glRepoInfo(ctx, token)
        case "sourcehut":
                return c.shRepoInfo(ctx, token)
        case "hf":
                return c.hfRepoInfo(ctx, token)
        }
        return nil, ErrUnsupported
}

// Tree lists one directory (path, ref). Returns entries + whether the
// forge flagged the listing truncated (GitHub's recursive tree caps at
// 100k entries / 7MB — the flag tells the caller to fall back to
// per-directory walks).
func (c *Client) Tree(ctx context.Context, path, ref, token string) ([]TreeEntry, bool, error) {
        // v0.82.4 THE DOT PATH: canonicalize ONCE, centrally — models pass
        // "." / "./" / "/./" and GitHub's tree filter matched nothing for a
        // literal "." prefix ("0 entries" on a repo full of files, the user's
        // live repro). Every forge + every caller (drawer, REST, tools, grep)
        // rides this.
        path = NormalizeTreePath(path)
        switch c.host.Kind {
        case "github":
                return c.ghTree(ctx, path, ref, token)
        case "gitea":
                return c.gtTree(ctx, path, ref, token)
        case "gitlab":
                return c.glTree(ctx, path, ref, token)
        case "sourcehut":
                return c.shTree(ctx, path, ref, token)
        case "generic":
                return c.genTree(ctx, path, ref, token)
        case "hf":
                return c.hfTree(ctx, path, ref, token)
        }
        return nil, false, ErrUnsupported
}

// File fetches one file's content. rangeSpec: "" (whole), "head:N",
// "tail:N", "lines:A-B" — applied engine-side so huge files never cross
// the wire twice (the forge serves the blob; we slice).
func (c *Client) File(ctx context.Context, path, ref, rangeSpec, token string) (*FileContent, error) {
        // v0.82.4: the dot-path twin — a read of "./README.md" 404s the
        // same way a tree of "." empties; canonicalize centrally.
        path = NormalizeTreePath(path)
        switch c.host.Kind {
        case "github":
                return c.ghFile(ctx, path, ref, rangeSpec, token)
        case "gitea":
                return c.gtFile(ctx, path, ref, rangeSpec, token)
        case "gitlab":
                return c.glFile(ctx, path, ref, rangeSpec, token)
        case "sourcehut":
                return c.shFile(ctx, path, ref, rangeSpec, token)
        case "generic":
                return c.genFile(ctx, path, ref, rangeSpec, token)
        case "hf":
                return c.hfFile(ctx, path, ref, rangeSpec, token)
        }
        return nil, ErrUnsupported
}

// Readme fetches the repo's readme, trying the common casings/spellings.
func (c *Client) Readme(ctx context.Context, ref, token string) (*FileContent, error) {
        var lastErr error
        for _, name := range readmeCandidates {
                fc, err := c.File(ctx, name, ref, "", token)
                if err == nil {
                        return fc, nil
                }
                lastErr = err
                if !IsNotFound(err) {
                        return nil, err // network/auth error — don't hammer 5 variants
                }
        }
        return nil, lastErr
}

// readmeName: the first candidate tried (README.md); File's adapters
// fall back through the alternates when the primary 404s.
const readmeName = "README.md"

var readmeCandidates = []string{"README.md", "README.rst", "README.txt", "README", "readme.md"}

func (c *Client) Branches(ctx context.Context, token string) ([]string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghBranches(ctx, token)
        case "gitea":
                return c.gtBranches(ctx, token)
        case "gitlab":
                return c.glBranches(ctx, token)
        case "sourcehut":
                return c.shBranches(ctx, token)
        case "generic":
                return c.genBranches(ctx, token)
        case "hf":
                return c.hfBranches(ctx, token)
        }
        return nil, ErrUnsupported
}

func (c *Client) Commits(ctx context.Context, path, ref, token string, limit int) ([]Commit, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCommits(ctx, path, ref, token, limit)
        case "gitea":
                return c.gtCommits(ctx, path, ref, token, limit)
        case "gitlab":
                return c.glCommits(ctx, path, ref, token, limit)
        case "sourcehut":
                return c.shCommits(ctx, path, ref, token, limit)
        case "generic":
                return c.genCommits(ctx, path, ref, token, limit)
        case "hf":
                return c.hfCommits(ctx, path, ref, token, limit)
        }
        return nil, ErrUnsupported
}

// ── dispatch: forge extras (best-effort per kind) ─────────────────────────

func (c *Client) Issues(ctx context.Context, state, token string, limit int) ([]Issue, error) {
        switch c.host.Kind {
        case "github":
                return c.ghIssues(ctx, state, token, limit)
        case "gitea":
                return c.gtIssues(ctx, state, token, limit)
        case "gitlab":
                return c.glIssues(ctx, state, token, limit)
        case "hf":
                return c.hfIssues(ctx, state, token, limit)
        }
        return nil, ErrUnsupported
}

func (c *Client) Pulls(ctx context.Context, state, token string, limit int) ([]PullRequest, error) {
        switch c.host.Kind {
        case "github":
                return c.ghPulls(ctx, state, token, limit)
        case "gitea":
                return c.gtPulls(ctx, state, token, limit)
        case "gitlab":
                return c.glPulls(ctx, state, token, limit)
        case "hf":
                return c.hfPulls(ctx, state, token, limit)
        }
        return nil, ErrUnsupported
}

func (c *Client) Releases(ctx context.Context, token string, limit int) ([]Release, error) {
        switch c.host.Kind {
        case "github":
                return c.ghReleases(ctx, token, limit)
        case "gitea":
                return c.gtReleases(ctx, token, limit)
        case "gitlab":
                return c.glReleases(ctx, token, limit)
        }
        return nil, ErrUnsupported
}

func (c *Client) Workflows(ctx context.Context, token string) ([]Workflow, error) {
        switch c.host.Kind {
        case "github":
                return c.ghWorkflows(ctx, token)
        case "gitea":
                return c.gtWorkflows(ctx, token)
        }
        return nil, ErrUnsupported
}

func (c *Client) WorkflowRuns(ctx context.Context, token string, limit int) ([]WorkflowRun, error) {
        switch c.host.Kind {
        case "github":
                return c.ghWorkflowRuns(ctx, token, limit)
        case "gitea":
                return c.gtWorkflowRuns(ctx, token, limit)
        }
        return nil, ErrUnsupported
}

// Discussions: GitHub GraphQL + HF (type "discussion" rows).
func (c *Client) Discussions(ctx context.Context, token string, limit int) ([]Discussion, error) {
        if c.host.Kind == "github" {
                return c.ghDiscussions(ctx, token, limit)
        }
        if c.host.Kind == "hf" {
                return c.hfDiscussionList(ctx, token, limit)
        }
        return nil, ErrUnsupported
}

// Search: code search. GitHub needs a token; every kind falls back to the
// engine-side filtered grep (grep.go) when the forge search is missing.
func (c *Client) Search(ctx context.Context, query, ref, token string, limit int) ([]SearchHit, error) {
        switch c.host.Kind {
        case "github":
                return c.ghSearch(ctx, query, ref, token, limit)
        }
        return Grep(ctx, c, query, ref, token, limit)
}

// PutFile commits one file (create or update; sha = current blob sha for
// updates, "" for creates) via the forge API — no local clone needed.
// This is the full/partial-access EDIT path that works on devices with
// no git binary (the Android APK).
func (c *Client) PutFile(ctx context.Context, path, branch, message, content, sha, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghPutFile(ctx, path, branch, message, content, sha, token)
        case "gitea":
                return c.gtPutFile(ctx, path, branch, message, content, sha, token)
        case "gitlab":
                return c.glPutFile(ctx, path, branch, message, content, sha, token)
        case "hf":
                return c.hfPutFile(ctx, path, branch, message, content, sha, token)
        }
        return "", ErrUnsupported
}

// Fork forks the repo into the token's account (the read→write upgrade
// path from the user spec). Returns the new owner/repo.
func (c *Client) Fork(ctx context.Context, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghFork(ctx, token)
        case "gitea":
                return c.gtFork(ctx, token)
        case "gitlab":
                return c.glFork(ctx, token)
        }
        return "", ErrUnsupported
}

// CreateBranch makes a new branch (v0.76.5: the put-to-a-feature-branch
// prerequisite — the contents API only commits to existing refs, so the
// bot's "commit to a branch, then PR it" flow creates the ref first).
// from="" = the repo's HEAD/default.
func (c *Client) CreateBranch(ctx context.Context, name, from, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCreateBranch(ctx, name, from, token)
        case "gitea":
                return c.gtCreateBranch(ctx, name, from, token)
        case "gitlab":
                return c.glCreateBranch(ctx, name, from, token)
        }
        return "", ErrUnsupported
}

// CreatePullRequest opens a PR/MR (v0.76.5: the missing write verb —
// "the bot can actually push, PR"). head/base are branch names; on
// GitHub a fork PR's head is "owner:branch". Partial-access friendly:
// creating a PR from a fork is the partial tier's write path.
func (c *Client) CreatePullRequest(ctx context.Context, title, body, head, base, token string) (PullRequest, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCreatePull(ctx, title, body, head, base, token)
        case "gitea":
                return c.gtCreatePull(ctx, title, body, head, base, token)
        case "gitlab":
                return c.glCreatePull(ctx, title, body, head, base, token)
        }
        return PullRequest{}, ErrUnsupported
}

// CreateRepo makes a fresh repo (name/license/gitignore/private — the
// create-from-scratch flow ported from the HF space workspaces).
func (c *Client) CreateRepo(ctx context.Context, name, desc, license, gitignore string, private bool, token string) (*RepoMeta, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCreateRepo(ctx, name, desc, license, gitignore, private, token)
        case "gitea":
                return c.gtCreateRepo(ctx, name, desc, license, gitignore, private, token)
        case "gitlab":
                return c.glCreateRepo(ctx, name, desc, license, gitignore, private, token)
        case "hf":
                return c.hfCreateRepo(ctx, name, desc, license, gitignore, private, token)
        }
        return nil, ErrUnsupported
}

// CreateRepoTyped — v0.93.5: the TYPE-FIRST create (HF's redesign: the
// user picks WHAT to create). HF-only today: typ = model|dataset|space
// (+ sdk for spaces, default static = free everywhere). Other forges
// answer ErrUnsupported — their create carries no type dimension.
func (c *Client) CreateRepoTyped(ctx context.Context, name, desc, typ, sdk, licenseKey string, private bool, token string) (*RepoMeta, error) {
        if c.host.Kind != "hf" {
                return nil, ErrUnsupported
        }
        return c.hfCreateRepoTyped(ctx, name, desc, typ, sdk, licenseKey, private, token)
}

// BucketCreate — v0.93.5: HF Storage Buckets (Xet-backed S3-like object
// storage, a distinct repo type with its own API — NOT /api/repos/create).
func (c *Client) BucketCreate(ctx context.Context, name string, private bool, token string) (*RepoMeta, error) {
        if c.host.Kind != "hf" {
                return nil, ErrUnsupported
        }
        return c.hfBucketCreate(ctx, name, private, token)
}

// BucketList — the token account's own storage buckets.
func (c *Client) BucketList(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
        if c.host.Kind != "hf" {
                return nil, ErrUnsupported
        }
        return c.hfBucketList(ctx, token, limit)
}

// ListUserRepos lists the token account's own repos (the "clone and get
// to working in your own repos" picker).
func (c *Client) ListUserRepos(ctx context.Context, token string, limit int) ([]RepoMeta, error) {
        switch c.host.Kind {
        case "github":
                return c.ghListUserRepos(ctx, token, limit)
        case "gitea":
                return c.gtListUserRepos(ctx, token, limit)
        case "gitlab":
                return c.glListUserRepos(ctx, token, limit)
        case "hf":
                return c.hfListUserRepos(ctx, token, limit)
        }
        return nil, ErrUnsupported
}

// Licenses lists the forge's known licenses (create-repo form data).
func (c *Client) Licenses(ctx context.Context, token string) ([]string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghLicenses(ctx, token)
        case "gitea":
                return c.gtLicenses(ctx, token)
        }
        return nil, ErrUnsupported
}

// LicensesRich — v0.93.5: key + display name for the create form (the
// user's "license stays none, no names" report). HF answers the hub's
// real 83-key create enum (spec-sourced); gitignore has no HF equivalent
// and stays GitHub/Gitea-only.
func (c *Client) LicensesRich(ctx context.Context, token string) ([]LicenseInfo, error) {
        switch c.host.Kind {
        case "github":
                return c.ghLicensesRich(ctx, token)
        case "hf":
                return c.hfLicensesRich(ctx, token)
        }
        return nil, ErrUnsupported
}

// Gitignores lists the forge's gitignore templates (create-repo form).
func (c *Client) Gitignores(ctx context.Context, token string) ([]string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghGitignores(ctx, token)
        case "gitea":
                return c.gtGitignores(ctx, token)
        }
        return nil, ErrUnsupported
}

// ── v0.81.6 THE FULL REPO HAND — dispatch for the new write/review verbs.
// GitHub carries the implementations; the other forges answer
// ErrUnsupported (an honest "not supported for {kind} yet" from the verb
// layer, not a silently-wrong API call). Gitea twins can follow the same
// switch shape when its actions/discussions surfaces are needed.

// CreateIssue files a new issue (title required; body + labels optional).
func (c *Client) CreateIssue(ctx context.Context, title, body string, labels []string, token string) (Issue, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCreateIssue(ctx, title, body, labels, token)
        }
        return Issue{}, ErrUnsupported
}

// IssueComment posts a comment on an issue OR a PR's conversation thread
// (GitHub serves both from the issues/{n}/comments endpoint).
func (c *Client) IssueComment(ctx context.Context, number int, body, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghIssueComment(ctx, number, body, token)
        }
        return "", ErrUnsupported
}

// SetIssueState closes or reopens an issue (state: open|closed).
func (c *Client) SetIssueState(ctx context.Context, number int, state, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghSetIssueState(ctx, number, state, token)
        }
        return "", ErrUnsupported
}

// PRDiff returns a PR's raw unified diff (the CODE REVIEW read).
func (c *Client) PRDiff(ctx context.Context, number int, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghPRDiff(ctx, number, token)
        }
        return "", ErrUnsupported
}

// CreatePRReview submits a PR review (event: approve|request_changes|
// comment — the CODE REVIEW write).
func (c *Client) CreatePRReview(ctx context.Context, number int, body, event, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghPRReview(ctx, number, body, event, token)
        }
        return "", ErrUnsupported
}

// MergePullRequest merges a PR (method: merge|squash|rebase — the
// STRONG write; the tool layer gates it behind FULL access).
func (c *Client) MergePullRequest(ctx context.Context, number int, title, msg, method, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghMergePR(ctx, number, title, msg, method, token)
        }
        return "", ErrUnsupported
}

// DiscussionPost opens a discussion (title + body; category optional —
// the first category when unnamed).
func (c *Client) DiscussionPost(ctx context.Context, title, body, category, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghDiscussionPost(ctx, title, body, category, token)
        }
        return "", ErrUnsupported
}

// DispatchWorkflow triggers a workflow run (workflow: file name or id;
// ref + inputs optional).
func (c *Client) DispatchWorkflow(ctx context.Context, workflow, ref string, inputs map[string]string, token string) error {
        switch c.host.Kind {
        case "github":
                return c.ghDispatchWorkflow(ctx, workflow, ref, inputs, token)
        }
        return ErrUnsupported
}

// DeleteFile removes a file via the contents API (an API commit; sha is
// the CURRENT blob sha — the tool layer fetches it when omitted).
func (c *Client) DeleteFile(ctx context.Context, path, branch, message, sha, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghDeleteFile(ctx, path, branch, message, sha, token)
        case "hf":
                // v0.93.5: the hub's NDJSON `deletedFile` op — the sha is
                // the GitHub contents API's requirement, unused here.
                return c.hfDeleteFile(ctx, path, branch, message, sha, token)
        }
        return "", ErrUnsupported
}

// CreateRelease publishes a release for a tag (created on the fly).
func (c *Client) CreateRelease(ctx context.Context, tag, name, body, target, token string) (string, error) {
        switch c.host.Kind {
        case "github":
                return c.ghCreateRelease(ctx, tag, name, body, target, token)
        }
        return "", ErrUnsupported
}
