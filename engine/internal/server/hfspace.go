// hfspace.go — v0.46: the HF-chat sandbox manager (THE ZEROGPU PAYWALL HACK).
//
// USER SPEC: "make the HF chat option functional instead of just quick chat,
// using our previously developed HF space — upgraded to function better.
// If HF space docker repo cloning is gated by a paywall we must find a hack
// to allow users to create and clone our setup — either one per chat or
// specific chats share the same space, user can choose."
//
// THE HACK (researched + verified live 2026-09-22 on a FREE account):
//   - POST /api/spaces/{repo}/duplicate            → PRO-gated (Docker SDK)
//   - POST /api/repos/create sdk=docker|gradio     → PRO-gated on cpu-basic
//   - POST /api/repos/create sdk=gradio hardware=zero-a10g → FREE ✓
//   - ZeroGPU runtime demands "a @spaces.GPU function detected during
//     startup" — satisfied by the template's noop + manual
//     spaces.zero.client.startup_report() (see engine/internal/hfzero).
//   - The ZeroGPU container is a full dev sandbox (uid 0, Debian 12,
//     Python 3.10, Node 20 + npm, gcc/g++/make/cmake, git) — verified live.
//
// FLOW (own space):
//   1. User connects HF (token paste in the Hub panel / OAuth when a client
//      id is configured) → vault DOOMALAY_HF_TOKEN.
//   2. POST /api/hf/space/create {name?} → create gradio+zero-a10g Space
//      (private) → commit the embedded template (app.py + requirements +
//      README + brain/) → set the DOOMALAY_SPACE_TOKEN secret → vault.
//   3. The Space builds (pip deps, ~3-6 min) — poll /api/hf/space/status.
//   4. Chats with sandbox=hf + sandbox_repo=<repo> stream through the
//      RemoteBrain (brain/remote.go) — same /chat SSE protocol as the
//      local brain, with X-Space-Token auth.
//
// SHARED MODE (no setup at all): chats with sandbox=hf and no repo use the
// shared community Space (default ScoobyBaby1999/doomalaysocreate — the
// upgraded original). Auth = the user's own HF token (X-HF-Token) so only
// real HF users can drive it.
package server

import (
        "bytes"
        "crypto/rand"
        "crypto/sha256"
        "context"
        "encoding/base64"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "os"
        "sort"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/hfzero"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// hfOAuthClientID is the OAuth app's client_id.
//
// v0.47 (task 3): the default is a CIMD — a Client ID Metadata Document
// (https://huggingface.co/docs/hub/oauth#automated-oauth-app-creation) —
// served from OUR GitHub Pages. HF fetches the doc on first use and
// auto-registers the "Doomalay" OAuth app; the flow is public (PKCE, no
// client secret), and the doc registers port-less loopback redirect URIs
// which match ANY local port (RFC 8252 §7.3) — exactly what an on-device
// engine needs. Live-verified 2026-09-22: /oauth/authorize accepts this
// client_id and serves the login page.
// The user's own app (registered at huggingface.co/settings/clients, secret
// 3894128e-…) has an UNKNOWN client_id — the CIMD replaces the need for it.
// Override with DOOMALAY_HF_OAUTH_CLIENT_ID (a UUID-style client_id or
// another CIMD URL both work).
var hfOAuthClientID = getenvDefault("DOOMALAY_HF_OAUTH_CLIENT_ID",
        "https://scoobybaby1999.github.io/doomalaysocreate/.well-known/oauth-cimd")

var hfRedirectURI = getenvDefault("DOOMALAY_HF_OAUTH_REDIRECT", "")

// sharedSpaceRepo is the community sandbox every app install may use via the
// user's own HF token (configurable: DOOMALAY_HF_SHARED_SPACE / --hf-shared).
var sharedSpaceRepo = getenvDefault("DOOMALAY_HF_SHARED_SPACE", "ScoobyBaby1999/doomalaysocreate")

// sharedSpaceURLOverride lets tests (and self-hosters) point the shared
// client at an arbitrary base URL instead of the computed hf.space subdomain.
var sharedSpaceURLOverride = getenvDefault("DOOMALAY_HF_SHARED_URL", "")

// sharedSpaceBaseURL is the shared sandbox's engine-facing base URL.
func sharedSpaceBaseURL() string {
        if sharedSpaceURLOverride != "" {
                return strings.TrimSuffix(sharedSpaceURLOverride, "/")
        }
        return hfzero.SpaceURL(sharedSpaceRepo)
}

// spaceTokenEnvVar is the vault key for a space's auth token.
func spaceTokenEnvVar(repo string) string {
        return "HF_SPACE_" + strings.ToUpper(strings.ReplaceAll(repo, "/", "_"))
}

// pkceStore holds in-flight PKCE verifiers (keyed by state, one-shot, 10min).
var pkceStore = struct {
        sync.Mutex
        m map[string]*pkceEntry
}{m: map[string]*pkceEntry{}}

type pkceEntry struct {
        verifier  string
        created   time.Time
        onSuccess string
}

func init() {
        go func() {
                for range time.Tick(5 * time.Minute) {
                        purgeExpiredPKCE()
                }
        }()
}

func purgeExpiredPKCE() {
        pkceStore.Lock()
        defer pkceStore.Unlock()
        now := time.Now()
        for k, v := range pkceStore.m {
                if now.Sub(v.created) > 10*time.Minute {
                        delete(pkceStore.m, k)
                }
        }
}

func getenvDefault(key, def string) string {
        if v := os.Getenv(key); v != "" {
                return v
        }
        return def
}

// ── account ────────────────────────────────────────────────────────────────

// handleHFAccount is GET /api/hf/account — connection state + shared info.
func (s *Server) handleHFAccount(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        user := ""
        tokenKind := ""
        if token != "" {
                // The hub service stores the verified username as the vault
                // extra at connect time — read it FIRST (no network, always
                // available) and only hit whoami to refresh (v0.47 task 8:
                // "connected as" showed empty whenever whoami failed — e.g.
                // an expired OAuth token or a network blip).
                if s.hub != nil {
                        user = s.hub.Username()
                }
                hfCli := s.hfClient()
                if u, err := hfCli.WhoAmI(token); err == nil && u != "" {
                        user = u
                }
                // hf_oauth_* tokens (the CIMD sign-in path) expire after 8h
                // with no refresh — flag them so the UI can offer reconnect.
                if strings.HasPrefix(token, "hf_oauth") {
                        tokenKind = "oauth"
                } else {
                        tokenKind = "token"
                }
        }
        writeJSON(w, http.StatusOK, map[string]any{
                "connected":   token != "",
                "user":        user,
                "auth":        tokenKind,
                "shared_repo": sharedSpaceRepo,
                "shared_url":  sharedSpaceBaseURL(),
                "oauth":       hfOAuthClientID != "",
        })
}

// ── space create (THE HACK) ────────────────────────────────────────────────

// handleHFSpaceCreate is POST /api/hf/space/create {name?}
// Creates a PRIVATE gradio Space on zero-a10g hardware (free tier — the
// verified loophole), uploads the embedded template + brain, sets the space
// token secret. Returns {repo, url, stage, files, bytes}.
func (s *Server) handleHFSpaceCreate(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to Hugging Face — connect in the Hub panel (token) or via the HF connect overlay")
                return
        }
        var req struct {
                Name string `json:"name"`
        }
        _ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)

        name := hfzero.SanitizeSpaceName(req.Name)
        if name == "" {
                name = "doomalay-" + randomState(6)
        }

        hfCli := s.hfClient()
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "HF token rejected: "+err.Error())
                return
        }
        repoID := user + "/" + name

        // 1. Create the Space — gradio SDK on ZeroGPU hardware (the free path).
        //    A 402-style PRO error here means HF closed the loophole; surface it
        //    honestly with the shared-space fallback hint.
        createBody := map[string]any{
                "type":     "space",
                "name":     name,
                "sdk":      "gradio",
                "hardware": "zero-a10g",
                // PUBLIC — deliberately. Private spaces are NOT served at their
                // public *.hf.space URL (live-verified: engine→space got HF's 404
                // page), and the RemoteBrain has no cookie auth. The X-Space-Token
                // gate in the template IS the security: every stateful route 401s
                // without the secret minted at create time (vault-held). The brain
                // code is public in the repo anyway.
                "private": false,
        }
        bodyBytes, _ := json.Marshal(createBody)
        if _, err := hfCli.DoRaw("POST", "/api/repos/create", token, bodyBytes, "application/json"); err != nil {
                msg := err.Error()
                // v0.46: ADOPT an existing space — creation is idempotent. The owner
                // retrying (or a half-finished earlier run) just gets the files
                // re-committed + the secret re-set below.
                if !strings.Contains(msg, "already exists") && !strings.Contains(msg, "already created") {
                        // v0.46 quota reality (live-verified): free accounts get TWO
                        // ZeroGPU spaces. Point the user at reuse + shared instead.
                        if strings.Contains(msg, "ZeroGPU Spaces") || strings.Contains(msg, "limited to 2") {
                                writeError(w, http.StatusPaymentRequired,
                                        "Free HF accounts can host 2 ZeroGPU sandboxes — you've used both. "+
                                                "Reuse one of your spaces (Pick an existing space) or use the community workspace. "+
                                                "(PRO raises the cap to 10.)")
                                return
                        }
                        if strings.Contains(msg, "PRO") || strings.Contains(msg, "subscription") {
                                writeError(w, http.StatusPaymentRequired,
                                        "HF now requires PRO for this creation path (loophole closed): "+msg+
                                                " — use the community workspace instead, or connect a PRO account")
                                return
                        }
                        writeError(w, http.StatusBadGateway, "create space: "+msg)
                        return
                }
        }

        // 2. Upload the template (app.py + requirements + README + brain/).
        files, err := hfzero.Files()
        if err != nil {
                writeError(w, http.StatusInternalServerError, "template: "+err.Error())
                return
        }
        commitFiles := make([]hub.CommitFile, 0, len(files))
        total := 0
        for _, f := range files {
                commitFiles = append(commitFiles, hub.CommitFile{Path: f.Path, Content: f.Content})
                total += len(f.Content)
        }
        if err := hfCli.CommitFilesSpace(token, repoID, "doomalay: sandbox v0.46 (ZeroGPU template + brain)", commitFiles); err != nil {
                writeError(w, http.StatusBadGateway, "upload files: "+err.Error())
                return
        }

        // 3. Space token: random secret on the Space + a copy in our vault.
        spaceToken := randomState(32)
        secretBody, _ := json.Marshal(map[string]string{"key": "DOOMALAY_SPACE_TOKEN", "value": spaceToken})
        if _, err := hfCli.DoRaw("POST", "/api/spaces/"+repoID+"/secrets", token, secretBody, "application/json"); err != nil {
                writeError(w, http.StatusBadGateway, "set space secret: "+err.Error())
                return
        }
        if err := s.vault.Set(spaceTokenEnvVar(repoID), "hf-space", spaceToken, repoID); err != nil {
                writeError(w, http.StatusInternalServerError, "vault: "+err.Error())
                return
        }

        s.writeSpaceInfo(w, token, repoID, fmt.Sprintf("created (%d files, %d KB)", len(files), total/1024))
}

// ── the DOCKER sandbox (v0.47 task 9) ──────────────────────────────────────

// handleHFSpaceDockerCreate is POST /api/hf/space/docker-create {name?, fork?}
//
// The "HF Docker sandbox" — the engine builds the user's own full-toolchain
// Space brick by brick, as if they had made it themselves:
//  1. (optional, default on) fork the doomalay template repo into the user's
//     GitHub — their own persistent copy of the source + the CI that can
//     re-push the Space (GitHub Actions workflow_dispatch with their token
//     as a repo secret).
//  2. POST /api/repos/create {type: space, sdk: STATIC} — the Vite-blank
//     trick (live-verified 2026-09-23): STATIC creation is free on every
//     account, while direct docker/gradio creation is PRO-gated (402).
//  3. Commit the embedded Docker template — README(sdk: docker) + the
//     full-toolchain Dockerfile + token-gated app + the brain tree — ONE
//     NDJSON commit whose README flip converts the Space to the docker SDK
//     (HF honors the README sdk field on push; verified live).
//  4. Set the DOOMALAY_SPACE_TOKEN secret (vault-held copy).
//  5. Wake attempt + honest runtime state. Since Jul-2026 HF gates cpu-basic
//     RUNTIME behind PRO too ("This includes converting an existing Static
//     Space…", HF staff 2026-09-21): free accounts end paused_quota — the
//     Space is built and ready, and runs the moment the account has a slot
//     (PRO, or pause another of its spaces — HF's own suggested remedy).
func (s *Server) handleHFSpaceDockerCreate(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to Hugging Face — connect first (Sign in with Hugging Face)")
                return
        }
        var req struct {
                Name string `json:"name"`
                Fork *bool  `json:"fork"` // nil → fork when GitHub is connected
        }
        _ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)

        hfCli := s.hfClient()
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "HF token rejected: "+err.Error())
                return
        }

        // 1. The GitHub fork (best-effort, skippable): their own copy of the
        //    source + a CI path to re-push the space from GitHub Actions.
        forkNote := ""
        wantFork := req.Fork == nil || *req.Fork
        gh := s.githubToken()
        if wantFork && gh != "" {
                forked, ferr := githubForkRepo(gh, "ScoobyBaby1999", "doomalay")
                if ferr != nil {
                        forkNote = "fork skipped: " + ferr.Error()
                } else {
                        forkNote = "forked doomalay → " + forked
                }
        } else if wantFork {
                forkNote = "fork skipped: not signed in to GitHub"
        }

        name := hfzero.SanitizeSpaceName(req.Name)
        if name == "" {
                name = "doomalay-" + randomState(6)
        }
        repoID := user + "/" + name

        // 2. Create the space as STATIC (the Vite-blank trick): creation is
        //    free on every account; the step-3 commit flips the SDK.
        createBody := map[string]any{
                "type": "space",
                "name": name,
                "sdk":  "static",
                // PUBLIC deliberately (same reasoning as the ZeroGPU flavor):
                // private spaces are not served at their public *.hf.space
                // URL; the X-Space-Token gate is the security.
                "private": false,
        }
        bodyBytes, _ := json.Marshal(createBody)
        if _, err := hfCli.DoRaw("POST", "/api/repos/create", token, bodyBytes, "application/json"); err != nil {
                msg := err.Error()
                if !strings.Contains(msg, "already exists") && !strings.Contains(msg, "already created") {
                        writeError(w, http.StatusBadGateway, "create space: "+msg)
                        return
                }
        }

        // 3. Brick by brick: the full-toolchain Dockerfile + app + brain.
        files, err := hfzero.DockerFiles()
        if err != nil {
                writeError(w, http.StatusInternalServerError, "template: "+err.Error())
                return
        }
        commitFiles := make([]hub.CommitFile, 0, len(files))
        total := 0
        for _, f := range files {
                commitFiles = append(commitFiles, hub.CommitFile{Path: f.Path, Content: f.Content})
                total += len(f.Content)
        }
        if err := hfCli.CommitFilesSpace(token, repoID, "doomalay: docker sandbox v0.48 (static→docker + full toolchain + brain)", commitFiles); err != nil {
                writeError(w, http.StatusBadGateway, "upload files: "+err.Error())
                return
        }

        // 4. Space token: random secret on the Space + a copy in our vault.
        spaceToken := randomState(32)
        secretBody, _ := json.Marshal(map[string]string{"key": "DOOMALAY_SPACE_TOKEN", "value": spaceToken})
        if _, err := hfCli.DoRaw("POST", "/api/spaces/"+repoID+"/secrets", token, secretBody, "application/json"); err != nil {
                writeError(w, http.StatusBadGateway, "set space secret: "+err.Error())
                return
        }
        if err := s.vault.Set(spaceTokenEnvVar(repoID), "hf-space", spaceToken, repoID); err != nil {
                writeError(w, http.StatusInternalServerError, "vault: "+err.Error())
                return
        }

        // 5. Wake it (best-effort) and report the honest runtime state.
        _ = hfRestartSpace(hfCli, token, repoID)
        state := "unknown"
        status, serr := hfSpaceStatus(hfCli, token, repoID)
        if serr == nil {
                switch {
                case boolField(status, "quota_paused"):
                        state = "paused_quota"
                case boolField(status, "running"):
                        state = "running"
                case boolField(status, "building"):
                        state = "building"
                case boolField(status, "error"):
                        state = "error"
                default:
                        state = strings.ToLower(stringField(status, "stage"))
                }
        }

        note := fmt.Sprintf("provisioned docker sandbox (%d files, %d KB) — sdk flipped static→docker", len(files), total/1024)
        switch state {
        case "paused_quota":
                note += "; BUILT and READY, but HF gates cpu-basic runtime behind PRO on free accounts (Jul-2026 policy). " +
                        "The quota slot is bound — pausing other spaces does not free it (live-verified 2026-09-23). " +
                        "It wakes on PRO upgrade; meanwhile use the ZeroGPU sandbox (free) or the community workspace"
        case "running":
                note += "; booting — ready in ~5-10 min"
        default:
                note += "; build starting — first build ~5-10 min"
        }
        if forkNote != "" {
                note += "; " + forkNote
        }
        resp := map[string]any{
                "repo":  repoID,
                "url":   hfzero.SpaceURL(repoID),
                "note":  note,
                "state": state,
        }
        if serr == nil {
                for k, v := range status {
                        resp[k] = v
                }
        } else {
                resp["stage"] = "UNKNOWN"
        }
        writeJSON(w, http.StatusOK, resp)
}

// boolField/stringField: safe map[string]any getters.
func boolField(m map[string]any, k string) bool {
        v, _ := m[k].(bool)
        return v
}

func stringField(m map[string]any, k string) string {
        v, _ := m[k].(string)
        return v
}

// githubForkRepo forks owner/repo as the token's user. Returns the fork's
// full name. Idempotent: GitHub returns 202 with the EXISTING fork when one
// is already there.
func githubForkRepo(token, owner, repo string) (string, error) {
        body, err := ghREST(token, "POST", "/repos/"+owner+"/"+repo+"/forks", nil)
        if err != nil {
                return "", err
        }
        var out struct {
                FullName string `json:"full_name"`
        }
        _ = json.Unmarshal(body, &out)
        if out.FullName == "" {
                return owner + "/" + repo + " (fork status unknown)", nil
        }
        return out.FullName, nil
}

// ghREST is a minimal GitHub REST helper (netx transport, browser UA —
// same house rules as the hub's HF client).
func ghREST(token, method, path string, body []byte) ([]byte, error) {
        var rdr io.Reader
        if body != nil {
                rdr = bytes.NewReader(body)
        }
        req, err := http.NewRequest(method, "https://api.github.com"+path, rdr)
        if err != nil {
                return nil, err
        }
        req.Header.Set("Authorization", "Bearer "+token)
        req.Header.Set("Accept", "application/vnd.github+json")
        req.Header.Set("User-Agent", "doomalay-engine/0.47")
        resp, err := (&http.Client{Timeout: 20 * time.Second, Transport: netx.Transport()}).Do(req)
        if err != nil {
                return nil, err
        }
        defer resp.Body.Close()
        out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        if resp.StatusCode >= 300 {
                msg := string(out)
                if len(msg) > 200 {
                        msg = msg[:200]
                }
                return nil, fmt.Errorf("github: HTTP %d: %s", resp.StatusCode, msg)
        }
        return out, nil
}

// handleGHAccount is GET /api/gh/account — the GitHub connection state
// (v0.47 task 11: the connect-GitHub panel mirrors the HF one).
func (s *Server) handleGHAccount(w http.ResponseWriter, r *http.Request) {
        id, secret := s.ghOAuthCreds()
        login, signed := s.accountInfo("github")
        writeJSON(w, http.StatusOK, map[string]any{
                "connected":    signed,
                "user":         login,
                "oauth":        id != "",
                "client_id":    id,
                "has_secret":   secret != "",
                "device_flow":  id != "", // v0.55: secretless device-code path
                "redirect_uri": oauthRedirectURI(r),
                // v0.60.2: the space broker (one-click, repo-scoped). The
                // panel probes <broker_url>/gh/oauth/config (CORS-open) and
                // offers the popup flow when the space holds the secret.
                "broker_url": ghBrokerBaseURL(),
        })
}

// writeSpaceInfo responds with a space's repo/url/stage snapshot.
func (s *Server) writeSpaceInfo(w http.ResponseWriter, token, repoID, note string) {
        hfCli := s.hfClient()
        status, serr := hfSpaceStatus(hfCli, token, repoID)
        resp := map[string]any{
                "repo": repoID,
                "url":  hfzero.SpaceURL(repoID),
                "note": note,
        }
        if serr == nil {
                for k, v := range status {
                        resp[k] = v
                }
        } else {
                resp["stage"] = "UNKNOWN"
        }
        writeJSON(w, http.StatusOK, resp)
}

// handleHFSpaceEnsure is POST /api/hf/space/ensure {} — find the user's most
// recent doomalay space (any stage) or create a fresh one. The chat picker's
// "your own space" fast path.
func (s *Server) handleHFSpaceEnsure(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to Hugging Face")
                return
        }
        hfCli := s.hfClient()
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "HF token rejected: "+err.Error())
                return
        }
        list, err := hfListUserSpaces(hfCli, token, user)
        if err != nil {
                writeError(w, http.StatusBadGateway, "list spaces: "+err.Error())
                return
        }
        // Prefer a space we hold a token for, newest first (id desc = created desc).
        sort.Slice(list, func(i, j int) bool { return list[i].Repo > list[j].Repo })
        for _, sp := range list {
                if _, _, terr := s.vault.Get(spaceTokenEnvVar(sp.Repo)); terr == nil {
                        s.writeSpaceInfo(w, token, sp.Repo, "reused")
                        return
                }
        }
        // No managed space — create one (reuse the create handler logic).
        r2 := r.Clone(r.Context())
        r2.Body = io.NopCloser(strings.NewReader("{}"))
        r2.ContentLength = 2
        s.handleHFSpaceCreate(w, r2)
}

// handleHFSpacesList is GET /api/hf/spaces — the user's doomalay spaces with
// live stages + which ones this engine holds tokens for.
func (s *Server) handleHFSpacesList(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to Hugging Face")
                return
        }
        hfCli := s.hfClient()
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                writeError(w, http.StatusUnauthorized, "HF token rejected: "+err.Error())
                return
        }
        list, err := hfListUserSpaces(hfCli, token, user)
        if err != nil {
                writeError(w, http.StatusBadGateway, "list: "+err.Error())
                return
        }
        out := make([]map[string]any, 0, len(list))
        for _, sp := range list {
                row := map[string]any{
                        "repo":     sp.Repo,
                        "url":      hfzero.SpaceURL(sp.Repo),
                        "sdk":      sp.SDK,
                        "managed":  false,
                        "stage":    sp.Stage,
                        "running":  strings.HasPrefix(sp.Stage, "RUNNING"),
                        "building": strings.HasPrefix(sp.Stage, "BUILDING") || strings.Contains(sp.Stage, "APP_STARTING"),
                        "error":    strings.Contains(sp.Stage, "ERROR"),
                        "sleeping": sp.Stage == "PAUSED" || sp.Stage == "STOPPED",
                }
                if _, _, terr := s.vault.Get(spaceTokenEnvVar(sp.Repo)); terr == nil {
                        row["managed"] = true
                }
                out = append(out, row)
        }
        writeJSON(w, http.StatusOK, map[string]any{"spaces": out, "user": user})
}

// hfSpaceListItem is one row of the user's space list.
type hfSpaceListItem struct {
        Repo  string
        SDK   string
        Stage string
}

// hfListUserSpaces lists the author's spaces, filtered to doomalay-ish names,
// each annotated with its live stage (one status call each — bounded by how
// many spaces a user realistically has).
func hfListUserSpaces(hf *hub.HFClient, token, user string) ([]hfSpaceListItem, error) {
        body, err := hf.DoRaw("GET", "/api/spaces?author="+user+"&limit=100", token, nil, "")
        if err != nil {
                return nil, err
        }
        var raw []struct {
                ID  string `json:"id"`
                SDK string `json:"sdk"`
        }
        if err := json.Unmarshal(body, &raw); err != nil {
                return nil, err
        }
        out := make([]hfSpaceListItem, 0, len(raw))
        for _, sp := range raw {
                parts := strings.SplitN(sp.ID, "/", 2)
                if len(parts) != 2 || !hfzero.IsDoomalaySpaceName(parts[1]) {
                        continue
                }
                item := hfSpaceListItem{Repo: sp.ID, SDK: sp.SDK, Stage: "UNKNOWN"}
                if st, err := hfSpaceStatus(hf, token, sp.ID); err == nil {
                        if v, ok := st["stage"].(string); ok {
                                item.Stage = v
                        }
                }
                out = append(out, item)
        }
        return out, nil
}

// ── shared space ───────────────────────────────────────────────────────────

// handleHFShared is GET /api/hf/shared — the community sandbox info + live stage.
func (s *Server) handleHFShared(w http.ResponseWriter, r *http.Request) {
        resp := map[string]any{
                "repo": sharedSpaceRepo,
                "url":  sharedSpaceBaseURL(),
                "auth": "hf-token",
        }
        token := s.hfToken()
        if token != "" {
                hfCli := s.hfClient()
                if st, err := hfSpaceStatus(hfCli, token, sharedSpaceRepo); err == nil {
                        for k, v := range st {
                                resp[k] = v
                        }
                }
        }
        writeJSON(w, http.StatusOK, resp)
}

// ── status / logs / restart (v0.45, kept) ──────────────────────────────────

// handleHFSpaceStatus is GET /api/hf/space/status?repo=user/name
func (s *Server) handleHFSpaceStatus(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        if repo == "" {
                writeError(w, http.StatusBadRequest, "missing repo")
                return
        }
        hfCli := s.hfClient()
        status, err := hfSpaceStatus(hfCli, token, repo)
        if err != nil {
                writeError(w, http.StatusBadGateway, err.Error())
                return
        }
        writeJSON(w, http.StatusOK, status)
}

// handleHFSpaceLogs is GET /api/hf/space/logs?repo=user/name&type=run&tail=50
func (s *Server) handleHFSpaceLogs(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        logType := r.URL.Query().Get("type")
        if logType == "" {
                logType = "run"
        }
        tail := r.URL.Query().Get("tail")
        if tail == "" {
                tail = "50"
        }
        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")
        flusher, ok := w.(http.Flusher)
        if !ok {
                writeError(w, http.StatusInternalServerError, "streaming unsupported")
                return
        }
        path := "/api/spaces/" + repo + "/logs/" + logType + "?tail=" + tail
        req, err := http.NewRequest("GET", "https://huggingface.co"+path, nil)
        if err != nil {
                return
        }
        req.Header.Set("Authorization", "Bearer "+token)
        req.Header.Set("User-Agent", "doomalay-engine/0.46")
        // v0.52: netx transport — the logs proxy is an outbound call too
        // (the bare client died on devices with a broken local resolver).
        cli := &http.Client{Timeout: 0, Transport: netx.Transport()}
        resp, err := cli.Do(req)
        if err != nil {
                fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
                flusher.Flush()
                return
        }
        defer resp.Body.Close()
        buf := make([]byte, 4096)
        for {
                n, err := resp.Body.Read(buf)
                if n > 0 {
                        w.Write(buf[:n])
                        flusher.Flush()
                }
                if err != nil {
                        break
                }
        }
}

// handleHFSpaceRestart is POST /api/hf/space/restart?repo=user/name
// (also wakes a sleeping Space).
func (s *Server) handleHFSpaceRestart(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        hfCli := s.hfClient()
        if err := hfRestartSpace(hfCli, token, repo); err != nil {
                writeError(w, http.StatusBadGateway, err.Error())
                return
        }
        writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repo": repo})
}

// handleHFSpacePause is POST /api/hf/space/pause?repo=user/name — pause a
// Space. NOTE (live-verified 2026-09-23): pausing does NOT free a cpu-basic
// slot on free accounts (the quota is bound) — this stays for explicit user
// control (and PRO accounts, where slots are real).
func (s *Server) handleHFSpacePause(w http.ResponseWriter, r *http.Request) {
        token := s.hfToken()
        if token == "" {
                writeError(w, http.StatusUnauthorized, "not connected to HF")
                return
        }
        repo := r.URL.Query().Get("repo")
        if repo == "" {
                writeError(w, http.StatusBadRequest, "missing repo")
                return
        }
        hfCli := s.hfClient()
        if _, err := hfCli.DoRaw("POST", "/api/spaces/"+repo+"/pause", token, nil, ""); err != nil {
                writeError(w, http.StatusBadGateway, "pause: "+err.Error())
                return
        }
        writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repo": repo, "paused": true})
}

// ── OAuth PKCE (v0.45, kept — active only when a client_id is configured) ──

// handleHFOAuthStart is GET /api/hf/oauth/start?redirect=<app-path>
func (s *Server) handleHFOAuthStart(w http.ResponseWriter, r *http.Request) {
        if hfOAuthClientID == "" {
                writeError(w, http.StatusServiceUnavailable, "HF OAuth not configured (set DOOMALAY_HF_OAUTH_CLIENT_ID) — paste a token in the Hub panel instead")
                return
        }
        verifier, err := randomPKCEVerifier(64)
        if err != nil {
                writeError(w, http.StatusInternalServerError, "PKCE verifier: "+err.Error())
                return
        }
        challenge := pkceS256Challenge(verifier)
        state := randomState(24)
        redirect := r.URL.Query().Get("redirect")
        if redirect == "" {
                redirect = "/"
        }
        pkceStore.Lock()
        pkceStore.m[state] = &pkceEntry{verifier: verifier, created: time.Now(), onSuccess: redirect}
        pkceStore.Unlock()

        redirectURI := hfRedirectURI
        if redirectURI == "" {
                redirectURI = schemeHost(r) + "/api/hf/oauth/callback"
        }
        q := url.Values{}
        q.Set("client_id", hfOAuthClientID)
        q.Set("redirect_uri", redirectURI)
        q.Set("response_type", "code")
        q.Set("scope", "openid profile write-repos manage-repos")
        q.Set("state", state)
        q.Set("code_challenge", challenge)
        q.Set("code_challenge_method", "S256")
        http.Redirect(w, r, "https://huggingface.co/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// handleHFOAuthCallback is GET /api/hf/oauth/callback?code=…&state=…
func (s *Server) handleHFOAuthCallback(w http.ResponseWriter, r *http.Request) {
        code := r.URL.Query().Get("code")
        state := r.URL.Query().Get("state")
        if code == "" || state == "" {
                writeError(w, http.StatusBadRequest, "missing code or state")
                return
        }
        pkceStore.Lock()
        entry, ok := pkceStore.m[state]
        if ok {
                delete(pkceStore.m, state)
        }
        pkceStore.Unlock()
        if !ok {
                writeError(w, http.StatusBadRequest, "unknown or expired state (retry)")
                return
        }
        token, err := hfExchangeCode(code, entry.verifier, schemeHost(r)+"/api/hf/oauth/callback")
        if err != nil {
                // v0.52: a resolver-shaped failure is confusing as a bare
                // Post error — name the egress path so the user (and the
                // logs) see the engine re-routed around the device DNS.
                msg := err.Error()
                if strings.Contains(msg, "lookup ") && strings.Contains(msg, ":53") {
                        msg += " (device DNS refused the engine — the DNS-over-HTTPS fallback will carry the retry)"
                }
                // v0.60: this lands in a BROWSER TAB (popup or external
                // browser) — serve the terminal page, not bare JSON.
                oauthDonePage(w, "Hugging Face", "", "token exchange failed: "+msg, "hf_error="+url.QueryEscape(msg))
                return
        }
        hfCli := s.hfClient()
        user, err := hfCli.WhoAmI(token)
        if err != nil {
                oauthDonePage(w, "Hugging Face", "", "token rejected by HF: "+err.Error(), "")
                return
        }
        if err := s.vault.Set(hub.TokenEnvVar, "huggingface", token, user); err != nil {
                oauthDonePage(w, "Hugging Face", "", "vault store: "+err.Error(), "")
                return
        }
        // v0.60: THE HOME-COMING. The old code 302'd to /?hf_connected=1 —
        // loading the whole app in the system browser (the "separate
        // instance" the user saw on the APK) or reloading the SPA at its
        // root (the "hardcoded screen"). The done page closes itself as a
        // popup / deep-links back to the real app / keeps the landing
        // query on its plain link — and the panel syncs via postMessage +
        // the focus/visibility refetch (hfconnect.js).
        dest := entry.onSuccess
        if !strings.HasPrefix(dest, "/") {
                dest = "/"
        }
        sep := "?"
        if strings.Contains(dest, "?") {
                sep = "&"
        }
        q := url.Values{}
        q.Set("hf_connected", "1")
        q.Set("hf_user", user)
        oauthDonePage(w, "Hugging Face", user, "", dest+sep+q.Encode())
}

// hfExchangeCode — the OAuth code→token POST. v0.52: rides the netx
// transport (system resolver → DNS-over-HTTPS fallback). THE live bug of
// v0.51: this was a bare http.Client, so on devices whose /etc/resolv.conf
// names a dead local resolver ([::1]:53 refused) the exchange failed with
// `token exchange failed: Post "https://huggingface.co/oauth/token": dial
// tcp: lookup huggingface.co on [::1]:53: … connection refused` even
// though the browser flow itself worked. hfTokenEndpoint is a var so tests
// can point it at a local httptest server.
var hfTokenEndpoint = "https://huggingface.co/oauth/token"

func hfExchangeCode(code, verifier, redirectURI string) (string, error) {
        body := url.Values{
                "grant_type":    {"authorization_code"},
                "code":          {code},
                "code_verifier": {verifier},
                "redirect_uri":  {redirectURI},
                "client_id":     {hfOAuthClientID},
        }.Encode()
        req, err := http.NewRequest("POST", hfTokenEndpoint, strings.NewReader(body))
        if err != nil {
                return "", err
        }
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
        req.Header.Set("User-Agent", "doomalay-engine/0.46")
        cli := &http.Client{Timeout: 15 * time.Second, Transport: netx.Transport()}
        resp, err := cli.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        if resp.StatusCode != 200 {
                return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(out))
        }
        var tok struct {
                AccessToken string `json:"access_token"`
        }
        if err := json.Unmarshal(out, &tok); err != nil {
                return "", err
        }
        if tok.AccessToken == "" {
                return "", fmt.Errorf("empty access_token in response")
        }
        return tok.AccessToken, nil
}


// ── OAuth device flow (v0.59) ──────────────────────────────────────────────
//
// THE GATEWAY BUG (live 2026-09-25): the redirect flow above sends the
// user's browser to redirect_uri = <engine origin>/api/hf/oauth/callback.
// When the app is served through a proxy/gateway that rewrites Host (the
// zai-web preview does), schemeHost(r) reconstructs http://localhost:8080 —
// and after authorizing, HF throws the browser at port 8080 on the USER'S
// machine, which is a DIFFERENT install ("a whole other instance, not my
// account"). HF's redirect rules (docs, verified live) make this worse:
// https redirect URIs must match EXACTLY (a gateway origin can't be
// pre-registered), and embedding the authorize page is impossible
// (x-frame-options: SAMEORIGIN — probed). HF's own docs offer the way out:
// a DEVICE-CODE grant needs no redirect URI and no browser on the device
// running the engine — the same shape as GitHub's device flow (v0.55).
// The UI picks per origin: loopback (localhost:*) → one-tap redirect, still
// the smoothest when the engine is directly reachable; anything else
// (gateway, LAN IP, tunnel) → this device flow.
//
// Live-verified 2026-09-25 against real HF with the CIMD client_id:
//   POST /oauth/device → {"device_code":"…","user_code":"Q0UK-PVSI",
//                         "verification_uri":"https://hf.co/oauth/device",
//                         "expires_in":300}          (no interval → RFC
//   default 5s); the token poll is secretless (public app + grant
//   urn:ietf:params:oauth:grant-type:device_code) and answers
//   {"error":"authorization_pending","error_description":"Device code
//   pending, not yet approved"} until the user confirms at hf.co.

var hfDeviceCodeEndpoint = "https://huggingface.co/oauth/device"

var hfDeviceStore = struct {
        sync.Mutex
        cur *hfDevicePending
}{}

type hfDevicePending struct {
        DeviceCode      string
        UserCode        string
        VerificationURI string
        Interval        time.Duration
        Deadline        time.Time
        Status          string // pending | connected | expired | error
        User            string
        Err             string
}

// handleHFDeviceStart is POST /api/hf/oauth/device/start.
func (s *Server) handleHFDeviceStart(w http.ResponseWriter, r *http.Request) {
        if hfOAuthClientID == "" {
                writeError(w, http.StatusServiceUnavailable, "HF OAuth not configured (set DOOMALAY_HF_OAUTH_CLIENT_ID) — paste a token in the Hub panel instead")
                return
        }
        ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
        defer cancel()
        form := url.Values{
                "client_id": {hfOAuthClientID},
                "scope":     {"openid profile write-repos manage-repos"},
        }
        req, _ := http.NewRequestWithContext(ctx, "POST", hfDeviceCodeEndpoint,
                strings.NewReader(form.Encode()))
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
        req.Header.Set("Accept", "application/json")
        req.Header.Set("User-Agent", "doomalay-engine")
        resp, err := oauthHTTP.Do(req)
        if err != nil {
                writeError(w, http.StatusBadGateway, "device flow start failed: "+err.Error())
                return
        }
        defer resp.Body.Close()
        var out struct {
                DeviceCode       string `json:"device_code"`
                UserCode         string `json:"user_code"`
                VerificationURI  string `json:"verification_uri"`
                ExpiresIn        int    `json:"expires_in"`
                Interval         int    `json:"interval"`
                Error            string `json:"error"`
                ErrorDescription string `json:"error_description"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
                writeError(w, http.StatusBadGateway, "device flow start: bad response: "+err.Error())
                return
        }
        if out.Error != "" {
                msg := out.Error
                if out.ErrorDescription != "" {
                        msg = out.ErrorDescription + " (" + out.Error + ")"
                }
                writeError(w, http.StatusBadGateway, msg)
                return
        }
        if out.DeviceCode == "" || out.UserCode == "" {
                writeError(w, http.StatusBadGateway, "device flow start: incomplete response")
                return
        }
        if out.VerificationURI == "" {
                out.VerificationURI = "https://hf.co/oauth/device"
        }
        // HF omits `interval` (probed) → the RFC 8628 default of 5s.
        interval := time.Duration(out.Interval) * time.Second
        if interval <= 0 {
                interval = 5 * time.Second
        }
        deadline := time.Now().Add(5 * time.Minute)
        if out.ExpiresIn > 0 {
                deadline = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
        }
        hfDeviceStore.Lock()
        p := &hfDevicePending{
                DeviceCode: out.DeviceCode, UserCode: out.UserCode,
                VerificationURI: out.VerificationURI, Interval: interval,
                Deadline: deadline, Status: "pending",
        }
        hfDeviceStore.cur = p
        hfDeviceStore.Unlock()

        go s.pollHFDevice(p, hfOAuthClientID)

        writeJSON(w, 200, map[string]any{
                "user_code":        p.UserCode,
                "verification_uri": p.VerificationURI,
                "expires_in":       out.ExpiresIn,
                "interval":         int(interval.Seconds()),
        })
}

// pollHFDevice — background poller for one HF device flow (mirrors
// pollGHDevice). No secret, no PKCE — the device_code is the one-shot
// bearer and it only ever lives engine-side. On success the token lands
// in the vault exactly like the redirect flow's (same TokenEnvVar shape)
// so hfToken() picks it up identically.
func (s *Server) pollHFDevice(p *hfDevicePending, clientID string) {
        t := time.NewTimer(p.Interval)
        defer t.Stop()
        for {
                <-t.C
                hfDeviceStore.Lock()
                replaced := hfDeviceStore.cur != p
                stale := time.Now().After(p.Deadline)
                hfDeviceStore.Unlock()
                if replaced {
                        return
                }
                if stale {
                        hfDeviceStore.Lock()
                        p.Status = "expired"
                        hfDeviceStore.Unlock()
                        return
                }
                ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
                access, err := hfDeviceExchange(ctx, p.DeviceCode, clientID)
                cancel()
                if err == nil {
                        user := ""
                        if u, uerr := s.hfClient().WhoAmI(access); uerr == nil {
                                user = u
                        }
                        if verr := s.vault.Set(hub.TokenEnvVar, "huggingface", access, user); verr != nil {
                                hfDeviceStore.Lock()
                                p.Status = "error"
                                p.Err = "vault: " + verr.Error()
                                hfDeviceStore.Unlock()
                                return
                        }
                        hfDeviceStore.Lock()
                        p.Status = "connected"
                        p.User = user
                        hfDeviceStore.Unlock()
                        return
                }
                msg := err.Error()
                switch {
                case strings.Contains(msg, "authorization_pending"):
                        t.Reset(p.Interval)
                case strings.Contains(msg, "slow_down"):
                        p.Interval += 5 * time.Second
                        t.Reset(p.Interval)
                case strings.Contains(msg, "expired_token"):
                        hfDeviceStore.Lock()
                        p.Status = "expired"
                        hfDeviceStore.Unlock()
                        return
                case strings.Contains(msg, "access_denied"):
                        hfDeviceStore.Lock()
                        p.Status = "error"
                        p.Err = "the request was denied on the HF page — start again if that wasn't you"
                        hfDeviceStore.Unlock()
                        return
                default:
                        hfDeviceStore.Lock()
                        p.Status = "error"
                        p.Err = msg
                        hfDeviceStore.Unlock()
                        return
                }
        }
}

// hfDeviceExchange polls the HF token endpoint with the device grant.
// Mirrors ghTokenExchange's parsing: the error rides the JSON body
// (authorization_pending et al. — HF answers 400, but a 200-with-error is
// parsed the same way), and the poller keys on the machine codes inside
// the message while humans get the description.
func hfDeviceExchange(ctx context.Context, deviceCode, clientID string) (string, error) {
        body := url.Values{
                "grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
                "device_code": {deviceCode},
                "client_id":   {clientID},
        }.Encode()
        req, err := http.NewRequestWithContext(ctx, "POST", hfTokenEndpoint, strings.NewReader(body))
        if err != nil {
                return "", err
        }
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
        req.Header.Set("User-Agent", "doomalay-engine")
        resp, err := oauthHTTP.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        var out struct {
                AccessToken      string `json:"access_token"`
                Error            string `json:"error"`
                ErrorDescription string `json:"error_description"`
        }
        raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
        if err := json.Unmarshal(raw, &out); err != nil {
                if resp.StatusCode != 200 {
                        return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(raw))
                }
                return "", err
        }
        if out.Error != "" {
                if out.ErrorDescription != "" {
                        return "", fmt.Errorf("%s (%s)", out.ErrorDescription, out.Error)
                }
                return "", fmt.Errorf("%s", out.Error)
        }
        if out.AccessToken == "" {
                return "", fmt.Errorf("HF returned no access token (HTTP %d)", resp.StatusCode)
        }
        return out.AccessToken, nil
}

// handleHFDeviceStatus is GET /api/hf/oauth/device/status — the UI polls
// this while the user enters the code at hf.co/oauth/device.
func (s *Server) handleHFDeviceStatus(w http.ResponseWriter, r *http.Request) {
        hfDeviceStore.Lock()
        defer hfDeviceStore.Unlock()
        if hfDeviceStore.cur == nil {
                writeJSON(w, 200, map[string]any{"status": "idle"})
                return
        }
        p := hfDeviceStore.cur
        writeJSON(w, 200, map[string]any{
                "status":           p.Status,
                "user_code":        p.UserCode,
                "verification_uri": p.VerificationURI,
                "user":             p.User,
                "error":            p.Err,
        })
}

// ── HF REST helpers ────────────────────────────────────────────────────────

// hfSpaceStatus GETs /api/spaces/{repo} → runtime stage snapshot. Since
// v0.48 it also parses runtime.errorMessage to distinguish a quota-paused
// space ("Quota exceeded for flavor cpu-basic…" — cannot run on this
// account without freeing a slot / PRO) from an ordinary sleeping space
// (48h inactivity — wakes fine).
func hfSpaceStatus(hf *hub.HFClient, token, repo string) (map[string]any, error) {
        body, err := hf.DoRaw("GET", "/api/spaces/"+repo, token, nil, "")
        if err != nil {
                return nil, err
        }
        var resp struct {
                ID      string `json:"id"`
                Runtime struct {
                        Stage        string `json:"stage"`
                        ErrorMessage string `json:"errorMessage"`
                        Hardware     struct {
                                Current string `json:"current"`
                        } `json:"hardware"`
                } `json:"runtime"`
        }
        if err := json.Unmarshal(body, &resp); err != nil {
                return nil, err
        }
        stage := resp.Runtime.Stage
        if stage == "" {
                stage = "NO_APP_FILE"
        }
        quota := strings.Contains(resp.Runtime.ErrorMessage, "Quota exceeded")
        out := map[string]any{
                "repo":         resp.ID,
                "stage":        stage,
                "hardware":     resp.Runtime.Hardware.Current,
                "running":      stage == "RUNNING" || stage == "RUNNING_BUILDING" || stage == "RUNNING_APP_STARTING",
                "sleeping":     stage == "PAUSED" || stage == "STOPPED",
                "building":     strings.HasPrefix(stage, "BUILDING") || strings.Contains(stage, "APP_STARTING"),
                "error":        strings.Contains(stage, "ERROR"),
                "quota_paused": quota,
        }
        if quota {
                out["quota_error"] = resp.Runtime.ErrorMessage
        }
        return out, nil
}

// hfRestartSpace POSTs /api/spaces/{repo}/restart?factory=false.
func hfRestartSpace(hf *hub.HFClient, token, repo string) error {
        _, err := hf.DoRaw("POST", "/api/spaces/"+repo+"/restart?factory=false", token, nil, "")
        return err
}

// hfClient builds an HF client on the CONFIGURED base (cfg.Hub.HFBase —
// huggingface.co in production, the test mock in tests). v0.48: the
// handlers used to hard-code NewHFClient("") which silently bypassed the
// test mock (the docker-create suite caught it).
func (s *Server) hfClient() *hub.HFClient {
        return hub.NewHFClient(s.cfg.Hub.HFBase)
}

// hfToken reads the HF token from the vault.
func (s *Server) hfToken() string {
        if s.vault == nil {
                return ""
        }
        key, _, err := s.vault.Get(hub.TokenEnvVar)
        if err != nil {
                return ""
        }
        return key
}

// schemeHost reconstructs the scheme://host of the incoming request.
func schemeHost(r *http.Request) string {
        scheme := "http"
        if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
                scheme = "https"
        }
        host := r.Host
        if h := r.Header.Get("X-Forwarded-Host"); h != "" {
                host = h
        }
        return scheme + "://" + host
}

// randomPKCEVerifier generates a URL-safe random string.
func randomPKCEVerifier(n int) (string, error) {
        b := make([]byte, n)
        if _, err := rand.Read(b); err != nil {
                return "", err
        }
        return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceS256Challenge(verifier string) string {
        h := sha256.Sum256([]byte(verifier))
        return base64.RawURLEncoding.EncodeToString(h[:])
}

// randomState returns a short URL-safe random string.
func randomState(n int) string {
        b := make([]byte, n)
        rand.Read(b)
        return hex.EncodeToString(b)[:n]
}

// fanOutRemoteEnv pushes the current vault keys to every live remote brain
// (own spaces + shared) so HF-chat turns carry fresh provider keys.
func (s *Server) fanOutRemoteEnv() {
        if s.vault == nil {
                return
        }
        env := s.vault.AsEnv()
        s.remoteMu.RLock()
        defer s.remoteMu.RUnlock()
        for _, rb := range s.remotes {
                rb.SetEnv(env)
        }
        if s.sharedBrain != nil {
                s.sharedBrain.SetEnv(env)
        }
}
