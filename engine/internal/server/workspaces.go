// workspaces.go — the v0.44 workspaces REST surface (user spec #3+#4).
//
// WHAT THE USER SEES: a "+workspace" pill in the chat header opens a list
// of the chat's connected cloud repos + a "connect workspace" flow (URL
// [+ token]) and a create-repo form. Connected repos appear in the
// artifacts drawer as lazy cloud trees. Quick chat can then explore/edit
// them per access level.
//
// REST (all engine-side; tokens never leave the engine):
//
//      POST   /api/workspaces/connect          {url, token?, session_id?}
//      GET    /api/workspaces                  list
//      GET    /api/workspaces/{id}             meta (+bound chats)
//      DELETE /api/workspaces/{id}
//      POST   /api/workspaces/{id}/bind        {session_id}
//      DELETE /api/workspaces/{id}/bind?session_id=
//      POST   /api/workspaces/{id}/token       {token}  (attach/replace key)
//      GET    /api/workspaces/{id}/tree?path=&ref=
//      GET    /api/workspaces/{id}/file?path=&ref=&range=head:80|tail:|lines:
//      GET    /api/workspaces/{id}/readme?ref=
//      GET    /api/workspaces/{id}/grep?q=&ref=&limit=&resume=
//      GET    /api/workspaces/{id}/view/{what} issues|pulls|releases|workflows|
//                   runs|commits|branches|discussions ?state=&path=&limit=
//      PUT    /api/workspaces/{id}/file        {path, content, message, branch, sha?}
//      POST   /api/workspaces/{id}/fork
//      POST   /api/workspaces/{id}/clone       local blobless clone → sandbox
//      POST   /api/workspaces/create-repo      {kind, name, description,
//                   license, gitignore, private, token?, session_id?}
//      GET    /api/workspaces/licenses?kind=
//      GET    /api/workspaces/gitignores?kind=
//      GET    /api/workspaces/discover?kind=&token=   my repos
//      GET    /api/workspaces/resolve?url=     ephemeral (explore tool)
//      GET/POST /api/sessions/{id}/workspaces  bound list / bind {workspace_id}
//      DELETE /api/sessions/{id}/workspaces/{wid}
//
// v0.46 additions (edits A7/A8/A10/A11/A12):
//      GET/POST/DELETE /api/workspaces/accounts   global forge sign-in
//                   (list never returns secrets; POST verifies + stores)
//      POST   /api/workspaces/device              device-storage row
//      POST   /api/workspaces/{id}/branches       {branches[], primary}
//      GET    /api/workspaces/oauth/github/status     (+ redirect_uri hint)
//      POST   /api/workspaces/oauth/github/config     {client_id, secret}
//      GET    /api/workspaces/oauth/github/start      → 302 GitHub authorize
//      GET    /api/workspaces/oauth/github/callback   code→token→vault
//
// SECURITY: connect/resolve run forge.Recognize + forge.ProbeHost +
// forge.GuardURL (SSRF); tokens ride the vault (WORKSPACE_<id>), never the
// DB; every response is JSON with the access level attached.
package server

import (
        "context"
        "crypto/rand"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/url"
        "os"
        "os/exec"
        "path/filepath"
        "regexp"
        "strings"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// wsIDRe mirrors the artifact id grammar (12 lowercase hex).
var wsIDRe = regexp.MustCompile(`^[a-f0-9]{12}$`)

// ── token resolution ──────────────────────────────────────────────────────

// wsToken returns the token for a workspace: its OWN vault key first, then
// the kind's global vault key (GITHUB_PAT / GITEA_TOKEN), then "".
func (s *Server) wsToken(w *store.Workspace) string {
        if s.vault == nil {
                return ""
        }
        if w.TokenEnv != "" {
                if key, _, err := s.vault.Get(w.TokenEnv); err == nil && key != "" {
                        return key
                }
        }
        if k := s.vault.AsEnv(); k != nil {
                switch w.Kind {
                case "github":
                        return firstNonEmpty(s.githubToken(), k["GITHUB_TOKEN"])
                case "gitea":
                        return k["GITEA_TOKEN"]
                }
        }
        return ""
}

func firstNonEmpty(ss ...string) string {
        for _, s := range ss {
                if s != "" {
                        return s
                }
        }
        return ""
}

// wsClient builds the forge client for a stored workspace.
func (s *Server) wsClient(w *store.Workspace) *forge.Client {
        return forge.NewClient(forge.HostInfo{
                Kind: w.Kind, Host: w.Host, WebBase: "https://" + w.Host,
                APIBase: apiBaseFor(w.Kind, w.Host), Owner: w.Owner, Repo: w.Repo,
                ProjectPath: w.Owner + "/" + w.Repo,
        })
}

func apiBaseFor(kind, host string) string {
        switch kind {
        case "github":
                return "https://api.github.com"
        case "gitea":
                return "https://" + host + "/api/v1"
        case "gitlab":
                return "https://" + host + "/api/v4"
        case "sourcehut":
                return "https://git.sr.ht"
        }
        return "https://" + host
}

// wsJSON writes a workspace with live access + meta decoded.
func (s *Server) wsJSON(w http.ResponseWriter, status int, ws *store.Workspace, extra map[string]any) {
        out := s.wsShape(ws)
        for k, v := range extra {
                out[k] = v
        }
        writeJSON(w, status, out)
}

// wsShape is the wire form of one workspace — meta DECODED (the v0.46 UI
// reads meta.branches / meta.device / meta.display_path from list
// responses; the raw string blob double-encodes and broke the picker's
// branch badges + the drawer's branch switcher).
func (s *Server) wsShape(ws *store.Workspace) map[string]any {
        out := map[string]any{
                "id": ws.ID, "name": ws.Name, "kind": ws.Kind, "host": ws.Host,
                "owner": ws.Owner, "repo": ws.Repo, "repo_url": ws.RepoURL,
                "branch": ws.Branch, "default_branch": ws.DefaultBranch,
                "access": ws.Access, "token_env": ws.TokenEnv,
                "sandbox_path": ws.SandboxPath, "created_at": ws.CreatedAt,
                "updated_at": ws.UpdatedAt,
        }
        if m := ws.MetaJSON(); m != nil {
                out["meta"] = m
        }
        return out
}

// loadWS fetches the workspace or writes the 404 itself.
func (s *Server) loadWS(w http.ResponseWriter, r *http.Request) *store.Workspace {
        id := r.PathValue("id")
        if id == "" {
                writeError(w, 400, "workspace id (path) or ?url= is required")
                return nil
        }
        if !wsIDRe.MatchString(id) {
                writeError(w, 400, "bad workspace id (12 hex chars)")
                return nil
        }
        ws, err := s.db.GetWorkspace(id)
        if err != nil {
                writeError(w, 500, "store: "+err.Error())
                return nil
        }
        if ws == nil {
                writeError(w, 404, "workspace not found")
                return nil
        }
        return ws
}

// wsTarget: EITHER a stored workspace (by {id}) OR an ephemeral URL
// (?url=… — the explore tool's raw-repo path). Returns (workspace, client,
// ok); on failure it has already written the error response. Ephemeral
// targets carry no vault token — global kind tokens still apply.
func (s *Server) wsTarget(w http.ResponseWriter, r *http.Request) (*store.Workspace, *forge.Client, bool) {
        if raw := strings.TrimSpace(r.URL.Query().Get("url")); raw != "" {
                hi, err := forge.Recognize(raw)
                if err != nil {
                        writeError(w, 400, err.Error())
                        return nil, nil, false
                }
                if hi.Kind == "unknown" {
                        if err := forge.GuardURL(r.Context(), hi.WebBase); err != nil {
                                writeError(w, 400, err.Error())
                                return nil, nil, false
                        }
                        hi, err = forge.ProbeHost(r.Context(), hi)
                        if err != nil {
                                writeError(w, 400, err.Error())
                                return nil, nil, false
                        }
                }
                if hi.Kind == "generic" {
                        writeError(w, 400, "generic git hosts need a local clone — connect the repo as a workspace first")
                        return nil, nil, false
                }
                // an ephemeral "workspace" shell: no id, no vault key, read tier
                ws := &store.Workspace{Kind: hi.Kind, Host: hi.Host, Owner: hi.Owner,
                        Repo: hi.Repo, Branch: "", Access: forge.AccessRead}
                if meta, err := forge.NewClient(hi).RepoInfo(r.Context(), s.globalToken(hi.Kind)); err == nil {
                        ws.Name, ws.DefaultBranch, ws.Branch = meta.FullName, meta.DefaultBranch, meta.DefaultBranch
                        if s.globalToken(hi.Kind) != "" {
                                ws.Access = meta.Access(true)
                        }
                }
                return ws, forge.NewClient(hi), true
        }
        ws := s.loadWS(w, r)
        if ws == nil {
                return nil, nil, false
        }
        return ws, s.wsClient(ws), true
}

// ── connect / list / get / delete ────────────────────────────────────────

func (s *Server) handleWorkspacesConnect(w http.ResponseWriter, r *http.Request) {
        var req struct {
                URL       string `json:"url"`
                Token     string `json:"token"`
                SessionID string `json:"session_id"`
                Name      string `json:"name"`
                Branch    string `json:"branch"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if strings.TrimSpace(req.URL) == "" {
                writeError(w, 400, "url is required")
                return
        }

        hi, err := forge.Recognize(req.URL)
        if err != nil {
                writeError(w, 400, err.Error())
                return
        }
        if hi.Kind == "unknown" {
                // SSRF guard BEFORE the probe dials the user-chosen host
                if err := forge.GuardURL(r.Context(), hi.WebBase); err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
                hi, err = forge.ProbeHost(r.Context(), hi)
                if err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
        }

        // Duplicate connect? Rebind + refresh instead of a second row.
        for _, existing := range s.mustListWorkspaces() {
                if existing.Kind == hi.Kind && strings.EqualFold(existing.Owner, hi.Owner) &&
                        strings.EqualFold(existing.Repo, hi.Repo) && existing.Host == hi.Host {
                        if req.SessionID != "" {
                                _ = s.db.BindWorkspace(req.SessionID, existing.ID)
                        }
                        // a NEW token on connect upgrades access — re-probe below
                        if strings.TrimSpace(req.Token) == "" {
                                s.wsJSON(w, 200, existing, map[string]any{"already_connected": true})
                                return
                        }
                        // fall through with the existing row to upgrade its token
                        s.connectRepo(w, r, hi, req, existing)
                        return
                }
        }
        s.connectRepo(w, r, hi, req, nil)
}

// connectRepo probes the repo, stores the row (+token), binds the chat.
func (s *Server) connectRepo(w http.ResponseWriter, r *http.Request, hi forge.HostInfo,
        req struct {
                URL       string `json:"url"`
                Token     string `json:"token"`
                SessionID string `json:"session_id"`
                Name      string `json:"name"`
                Branch    string `json:"branch"`
        }, existing *store.Workspace) {
        token := strings.TrimSpace(req.Token)

        ws := &store.Workspace{
                Kind: hi.Kind, Host: hi.Host, Owner: hi.Owner, Repo: hi.Repo,
                RepoURL: strings.TrimSpace(req.URL), Branch: strings.TrimSpace(req.Branch),
                SandboxPath: "", Access: forge.AccessRead,
        }
        if existing != nil {
                ws = existing
                ws.RepoURL = strings.TrimSpace(req.URL)
                if req.Branch != "" {
                        ws.Branch = strings.TrimSpace(req.Branch)
                }
        }

        // a per-workspace token rides the vault under WORKSPACE_<id>
        if token != "" {
                if ws.ID == "" {
                        // mint the id early so the vault key matches the row
                        ws.ID = mintWSID()
                }
                ws.TokenEnv = "WORKSPACE_" + ws.ID
                if s.vault != nil {
                        if err := s.vault.Set(ws.TokenEnv, hi.Kind, token, ""); err != nil {
                                writeError(w, 500, "vault: "+err.Error())
                                return
                        }
                }
        }

        // probe: repo meta (+ permissions → access level)
        client := forge.NewClient(hi)
        meta, err := client.RepoInfo(r.Context(), s.tokenFor(client, token, hi.Kind))
        if err != nil {
                if forge.IsUnauthorized(err) {
                        writeError(w, 401, "token rejected by "+hi.Host)
                        return
                }
                if forge.IsNotFound(err) {
                        writeError(w, 404, "repo not found (private? attach a token with access)")
                        return
                }
                writeError(w, 502, err.Error())
                return
        }
        ws.Name = meta.FullName
        ws.DefaultBranch = meta.DefaultBranch
        if ws.Branch == "" {
                ws.Branch = meta.DefaultBranch
        }
        ws.Access = meta.Access(token != "" || s.hasGlobalToken(hi.Kind))
        metaJSON, _ := json.Marshal(meta)
        ws.Meta = string(metaJSON)

        if existing != nil {
                if err := s.db.UpdateWorkspace(ws); err != nil {
                        writeError(w, 500, "store: "+err.Error())
                        return
                }
        } else {
                if err := s.db.CreateWorkspace(ws); err != nil {
                        writeError(w, 500, "store: "+err.Error())
                        return
                }
        }
        if req.SessionID != "" {
                if err := s.db.BindWorkspace(req.SessionID, ws.ID); err != nil {
                        writeError(w, 500, "store: "+err.Error())
                        return
                }
        }
        s.wsJSON(w, 200, ws, map[string]any{"connected": true})
}

// tokenFor: explicit token > workspace vault key > kind global key.
func (s *Server) tokenFor(c *forge.Client, explicit, kind string) string {
        if strings.TrimSpace(explicit) != "" {
                return strings.TrimSpace(explicit)
        }
        return s.globalToken(kind)
}

func (s *Server) globalToken(kind string) string {
        if s.vault == nil {
                return ""
        }
        switch kind {
        case "github":
                // v0.46: the OAuth path may need a refresh_token round-trip before
                // the access token is usable — githubToken handles it (and falls
                // back to a plain stored PAT with no expiry metadata).
                return firstNonEmpty(s.githubToken(), s.vault.AsEnv()["GITHUB_TOKEN"])
        case "gitea":
                return s.vault.AsEnv()["GITEA_TOKEN"]
        }
        return ""
}

func (s *Server) hasGlobalToken(kind string) bool { return s.globalToken(kind) != "" }

func mintWSID() string {
        // store.newWorkspaceID is unexported; mirror the grammar locally
        b := make([]byte, 6)
        for i := range b {
                b[i] = byte(time.Now().UnixNano() >> (uint(i) * 8))
        }
        return fmt.Sprintf("%x", b)[:12]
}

func (s *Server) mustListWorkspaces() []*store.Workspace {
        ws, err := s.db.ListWorkspaces()
        if err != nil {
                return nil
        }
        return ws
}

func (s *Server) handleWorkspacesList(w http.ResponseWriter, r *http.Request) {
        list := s.mustListWorkspaces()
        if list == nil {
                list = []*store.Workspace{}
        }
        // v0.46: decode meta per row (the UI reads meta.branches etc.)
        shapes := make([]map[string]any, 0, len(list))
        for _, ws := range list {
                shapes = append(shapes, s.wsShape(ws))
        }
        writeJSON(w, 200, map[string]any{"workspaces": shapes})
}

func (s *Server) handleWorkspaceGet(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        sessions, _ := s.db.ListWorkspaceSessions(ws.ID)
        if sessions == nil {
                sessions = []string{}
        }
        s.wsJSON(w, 200, ws, map[string]any{"bound_sessions": sessions})
}

func (s *Server) handleWorkspaceDelete(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        if err := s.db.DeleteWorkspace(ws.ID); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        if s.vault != nil && ws.TokenEnv != "" {
                _ = s.vault.Delete(ws.TokenEnv)
        }
        writeJSON(w, 200, map[string]any{"deleted": true})
}

// ── bindings ──────────────────────────────────────────────────────────────

func (s *Server) handleWorkspaceBind(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        var req struct {
                SessionID string `json:"session_id"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SessionID == "" {
                writeError(w, 400, "session_id is required")
                return
        }
        if err := s.db.BindWorkspace(req.SessionID, ws.ID); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"bound": true})
}

func (s *Server) handleWorkspaceUnbind(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        sid := r.URL.Query().Get("session_id")
        if sid == "" {
                writeError(w, 400, "session_id is required")
                return
        }
        if err := s.db.UnbindWorkspace(sid, ws.ID); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"unbound": true})
}

func (s *Server) handleSessionWorkspacesList(w http.ResponseWriter, r *http.Request) {
        sid := r.PathValue("id")
        list, err := s.db.ListSessionWorkspaces(sid)
        if err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        if list == nil {
                list = []*store.Workspace{}
        }
        // v0.46: decode meta per row (the drawer's branch switcher reads
        // meta.branches from THIS response)
        shapes := make([]map[string]any, 0, len(list))
        for _, ws := range list {
                shapes = append(shapes, s.wsShape(ws))
        }
        writeJSON(w, 200, map[string]any{"workspaces": shapes})
}

func (s *Server) handleSessionWorkspaceBind(w http.ResponseWriter, r *http.Request) {
        sid := r.PathValue("id")
        var req struct {
                WorkspaceID string `json:"workspace_id"`
                URL         string `json:"url"` // convenience: connect + bind in one
                Token       string `json:"token"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if req.WorkspaceID == "" && req.URL == "" {
                writeError(w, 400, "workspace_id or url is required")
                return
        }
        wid := req.WorkspaceID
        if wid == "" {
                // connect inline then bind
                hi, err := forge.Recognize(req.URL)
                if err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
                if hi.Kind == "unknown" {
                        if err := forge.GuardURL(r.Context(), hi.WebBase); err != nil {
                                writeError(w, 400, err.Error())
                                return
                        }
                        hi, err = forge.ProbeHost(r.Context(), hi)
                        if err != nil {
                                writeError(w, 400, err.Error())
                                return
                        }
                }
                ws := &store.Workspace{Kind: hi.Kind, Host: hi.Host, Owner: hi.Owner,
                        Repo: hi.Repo, RepoURL: req.URL, Access: forge.AccessRead}
                token := strings.TrimSpace(req.Token)
                if token != "" {
                        ws.ID = mintWSID()
                        ws.TokenEnv = "WORKSPACE_" + ws.ID
                        if s.vault != nil {
                                _ = s.vault.Set(ws.TokenEnv, hi.Kind, token, "")
                        }
                }
                client := forge.NewClient(hi)
                meta, err := client.RepoInfo(r.Context(), s.tokenFor(client, token, hi.Kind))
                if err != nil {
                        writeError(w, 502, err.Error())
                        return
                }
                ws.Name, ws.DefaultBranch, ws.Branch = meta.FullName, meta.DefaultBranch, meta.DefaultBranch
                ws.Access = meta.Access(token != "" || s.hasGlobalToken(hi.Kind))
                metaJSON, _ := json.Marshal(meta)
                ws.Meta = string(metaJSON)
                if err := s.db.CreateWorkspace(ws); err != nil {
                        writeError(w, 500, "store: "+err.Error())
                        return
                }
                wid = ws.ID
        }
        if err := s.db.BindWorkspace(sid, wid); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        ws, _ := s.db.GetWorkspace(wid)
        s.wsJSON(w, 200, ws, map[string]any{"bound": true})
}

func (s *Server) handleSessionWorkspaceUnbind(w http.ResponseWriter, r *http.Request) {
        sid := r.PathValue("id")
        wid := r.PathValue("wid")
        if err := s.db.UnbindWorkspace(sid, wid); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"unbound": true})
}

// ── token attach ──────────────────────────────────────────────────────────

func (s *Server) handleWorkspaceToken(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        var req struct {
                Token      string `json:"token"`
                UseAccount bool   `json:"use_account"` // v0.46: reuse the saved global sign-in
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if s.vault == nil {
                writeError(w, 500, "vault not initialized")
                return
        }
        token := strings.TrimSpace(req.Token)
        if token == "" && req.UseAccount {
                // the global account token for this workspace's forge kind
                token = s.globalToken(ws.Kind)
                if token == "" {
                        writeError(w, 400, "no saved "+ws.Kind+" account — sign in or paste a token")
                        return
                }
        }
        if token == "" {
                writeError(w, 400, "token is required")
                return
        }
        if ws.TokenEnv == "" {
                ws.TokenEnv = "WORKSPACE_" + ws.ID
        }
        if err := s.vault.Set(ws.TokenEnv, ws.Kind, token, ""); err != nil {
                writeError(w, 500, "vault: "+err.Error())
                return
        }
        // re-probe access with the new token
        client := s.wsClient(ws)
        if meta, err := client.RepoInfo(r.Context(), s.wsToken(ws)); err == nil {
                ws.Access = meta.Access(true)
                _ = s.db.UpdateWorkspace(ws)
        }
        writeJSON(w, 200, map[string]any{"token_set": true, "access": ws.Access})
}

// ── repo surface (tree/file/readme/grep/view) ────────────────────────────

func (s *Server) handleWorkspaceTree(w http.ResponseWriter, r *http.Request) {
        ws, c, ok := s.wsTarget(w, r)
        if !ok {
                return
        }
        q := r.URL.Query()
        entries, truncated, err := c.Tree(r.Context(),
                strings.Trim(q.Get("path"), "/"), refOrWS(q.Get("ref"), ws), s.tokenForTarget(ws, c))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        if entries == nil {
                entries = []forge.TreeEntry{}
        }
        writeJSON(w, 200, map[string]any{"entries": entries, "truncated": truncated})
}

// tokenForTarget: stored workspace → its vault token; ephemeral → the
// kind's global token (an explicit token never rides a GET query).
func (s *Server) tokenForTarget(ws *store.Workspace, _ *forge.Client) string {
        if ws.ID != "" {
                return s.wsToken(ws)
        }
        return s.globalToken(ws.Kind)
}

func (s *Server) handleWorkspaceFile(w http.ResponseWriter, r *http.Request) {
        ws, c, ok := s.wsTarget(w, r)
        if !ok {
                return
        }
        q := r.URL.Query()
        path := strings.Trim(q.Get("path"), "/")
        if path == "" {
                writeError(w, 400, "path is required")
                return
        }
        if strings.Contains(path, "..") {
                writeError(w, 400, "path traversal refused")
                return
        }
        fc, err := c.File(r.Context(), path, refOrWS(q.Get("ref"), ws),
                q.Get("range"), s.tokenForTarget(ws, c))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, fc)
}

// handleExploreFiles — the BATCH read (user spec #4: "exploring 50+ files
// at one go"): ?url= + comma-separated paths= + head_lines=, fetched
// 8-wide in parallel engine-side (one brain call, N forge calls — the
// politeness width matches grep.go's). Response: {files:[{path,content…}]}.
func (s *Server) handleExploreFiles(w http.ResponseWriter, r *http.Request) {
        raw := strings.TrimSpace(r.URL.Query().Get("url"))
        if raw == "" {
                writeError(w, 400, "url is required")
                return
        }
        pathsParam := r.URL.Query().Get("paths")
        var plist []string
        for _, p := range strings.Split(pathsParam, ",") {
                p = strings.TrimSpace(p)
                if p != "" && !strings.Contains(p, "..") {
                        plist = append(plist, p)
                }
        }
        if len(plist) == 0 {
                writeError(w, 400, "paths is required (comma-separated)")
                return
        }
        if len(plist) > 200 {
                writeError(w, 400, "max 200 paths per batch — split the request")
                return
        }
        head := atoiDefault(r.URL.Query().Get("head_lines"), 40)
        if head < 1 || head > 400 {
                head = 40
        }
        hi, err := forge.Recognize(raw)
        if err != nil {
                writeError(w, 400, err.Error())
                return
        }
        if hi.Kind == "unknown" {
                if err := forge.GuardURL(r.Context(), hi.WebBase); err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
                hi, err = forge.ProbeHost(r.Context(), hi)
                if err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
        }
        if hi.Kind == "generic" {
                writeError(w, 400, "generic git hosts need a local clone — connect the repo first")
                return
        }
        c := forge.NewClient(hi)
        tok := s.globalToken(hi.Kind)
        ref := r.URL.Query().Get("ref")
        rng := fmt.Sprintf("head:%d", head)

        type res struct {
                FC  *forge.FileContent
                Err string
        }
        results := make([]res, len(plist))
        var wg sync.WaitGroup
        sem := make(chan struct{}, 8) // politeness width (grep.go parity)
        for i, p := range plist {
                wg.Add(1)
                go func(i int, p string) {
                        defer wg.Done()
                        sem <- struct{}{}
                        defer func() { <-sem }()
                        fc, err := c.File(r.Context(), p, ref, rng, tok)
                        if err != nil {
                                results[i] = res{Err: err.Error()}
                                return
                        }
                        results[i] = res{FC: fc}
                }(i, p)
        }
        wg.Wait()
        out := make([]map[string]any, 0, len(plist))
        for i, rr := range results {
                if rr.Err != "" {
                        out = append(out, map[string]any{"path": plist[i], "error": rr.Err})
                        continue
                }
                out = append(out, map[string]any{
                        "path": rr.FC.Path, "size": rr.FC.Size, "binary": rr.FC.Binary,
                        "content": rr.FC.Content, "truncated": rr.FC.Truncated,
                })
        }
        writeJSON(w, 200, map[string]any{"files": out, "asked": len(plist)})
}

func (s *Server) handleWorkspaceReadme(w http.ResponseWriter, r *http.Request) {
        ws, c, ok := s.wsTarget(w, r)
        if !ok {
                return
        }
        q := r.URL.Query()
        fc, err := c.Readme(r.Context(), refOrWS(q.Get("ref"), ws), s.tokenForTarget(ws, c))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, fc)
}

func (s *Server) handleWorkspaceGrep(w http.ResponseWriter, r *http.Request) {
        ws, c, ok := s.wsTarget(w, r)
        if !ok {
                return
        }
        q := r.URL.Query()
        query := strings.TrimSpace(q.Get("q"))
        if query == "" {
                writeError(w, 400, "q is required")
                return
        }
        tok := s.tokenForTarget(ws, c)
        var (
                res *forge.GrepResult
                err error
        )
        if rem := q.Get("resume"); rem != "" {
                res, err = forge.GrepResume(r.Context(), c, query,
                        refOrWS(q.Get("ref"), ws), tok, atoiDefault(q.Get("limit"), 50), rem)
        } else {
                var hits []forge.SearchHit
                hits, err = forge.Grep(r.Context(), c, query,
                        refOrWS(q.Get("ref"), ws), tok, atoiDefault(q.Get("limit"), 50))
                if err == nil {
                        res = &forge.GrepResult{Hits: hits, Complete: true, Scanned: len(hits)}
                }
        }
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, res)
}

// handleWorkspaceView — the "everything about a repo" surface the explore
// tool + UI ride: /view/{what} for issues|pulls|releases|workflows|runs|
// commits|branches|discussions.
func (s *Server) handleWorkspaceView(w http.ResponseWriter, r *http.Request) {
        ws, c, ok := s.wsTarget(w, r)
        if !ok {
                return
        }
        q := r.URL.Query()
        what := r.PathValue("what")
        state := q.Get("state")
        limit := atoiDefault(q.Get("limit"), 30)
        tok := s.tokenForTarget(ws, c)
        ref := refOrWS(q.Get("ref"), ws)

        var out any
        var err error
        switch what {
        case "issues":
                out, err = c.Issues(r.Context(), state, tok, limit)
        case "pulls":
                out, err = c.Pulls(r.Context(), state, tok, limit)
        case "releases":
                out, err = c.Releases(r.Context(), tok, limit)
        case "workflows":
                out, err = c.Workflows(r.Context(), tok)
        case "runs":
                out, err = c.WorkflowRuns(r.Context(), tok, limit)
        case "commits":
                out, err = c.Commits(r.Context(), strings.Trim(q.Get("path"), "/"), ref, tok, limit)
        case "branches":
                out, err = c.Branches(r.Context(), tok)
        case "discussions":
                out, err = c.Discussions(r.Context(), tok, limit)
        default:
                writeError(w, 400, "unknown view "+what+" (issues|pulls|releases|workflows|runs|commits|branches|discussions)")
                return
        }
        if err != nil {
                s.wsErr(w, err)
                return
        }
        if out == nil {
                out = []any{}
        }
        writeJSON(w, 200, map[string]any{"view": what, "items": out})
}

// ── write paths (PUT file / fork / clone / create-repo) ─────────────────

func (s *Server) handleWorkspacePutFile(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        if ws.Access == forge.AccessRead {
                writeError(w, 403, "this workspace is read-only — attach a token (or fork) to write")
                return
        }
        var req struct {
                Path    string `json:"path"`
                Content string `json:"content"`
                Message string `json:"message"`
                Branch  string `json:"branch"`
                SHA     string `json:"sha"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        req.Path = strings.Trim(req.Path, "/")
        if req.Path == "" || strings.Contains(req.Path, "..") {
                writeError(w, 400, "valid path is required")
                return
        }
        if req.Message == "" {
                req.Message = "doomalay: update " + req.Path
        }
        if req.Branch == "" {
                req.Branch = ws.Branch
        }
        // UPDATE-CREATE trap: GitHub 422s an update whose CURRENT blob sha is
        // missing. Callers that skip the sha (raw REST, the drawer's first
        // save) get it fetched here — a 404 means it's a create (sha stays "").
        if req.SHA == "" {
                if cur, err := s.wsClient(ws).File(r.Context(), req.Path, req.Branch, "", s.wsToken(ws)); err == nil && cur.SHA != "" {
                        req.SHA = cur.SHA
                }
        }
        url, err := s.wsClient(ws).PutFile(r.Context(), req.Path, req.Branch,
                req.Message, req.Content, req.SHA, s.wsToken(ws))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{"committed": true, "path": req.Path,
                "branch": req.Branch, "commit_url": url})
}

func (s *Server) handleWorkspaceFork(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        full, err := s.wsClient(ws).Fork(r.Context(), s.wsToken(ws))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{"forked": true, "full_name": full,
                "hint": "connect the fork to work with write access"})
}

func (s *Server) handleWorkspaceClone(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        if _, err := exec.LookPath("git"); err != nil {
                writeError(w, 501, "no git binary on this device — the API-edit path still works for full-access repos")
                return
        }
        root := filepath.Join(s.cfg.DataDir, "workspaces")
        dir := filepath.Join(root, ws.Host, ws.Owner+"-"+ws.Repo)
        if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
                writeError(w, 500, "mkdir: "+err.Error())
                return
        }
        if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
                // token stays OUT of the clone URL argv (ps-visible): env instead
                cloneURL := "https://" + ws.Host + "/" + ws.Owner + "/" + ws.Repo + ".git"
                cmd := exec.Command("git", "clone", "--filter=blob:none", "--depth=50", cloneURL, dir)
                cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
                if tok := s.wsToken(ws); tok != "" {
                        // in-URL auth is the only https credential channel without a
                        // helper; keep it in the CHILD env via a temporary askpass
                        askpass := filepath.Join(root, ".askpass-"+ws.ID)
                        if err := os.WriteFile(askpass, []byte("#!/bin/sh\necho "+shellQuote(tok)), 0o700); err == nil {
                                defer os.Remove(askpass)
                                cmd.Env = append(cmd.Env, "GIT_ASKPASS="+askpass)
                        }
                }
                out, err := cmd.CombinedOutput()
                if err != nil {
                        _ = os.RemoveAll(dir)
                        writeError(w, 502, "git clone: "+string(out))
                        return
                }
        }
        ws.SandboxPath = dir
        // a local clone with push rights = full access by definition
        if ws.Access == forge.AccessRead && s.wsToken(ws) != "" {
                ws.Access = forge.AccessPartial
        }
        if err := s.db.UpdateWorkspace(ws); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"cloned": true, "sandbox_path": dir})
}

func shellQuote(s string) string {
        return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (s *Server) handleWorkspaceCreateRepo(w http.ResponseWriter, r *http.Request) {
        var req struct {
                Kind        string `json:"kind"` // github|gitea|gitlab
                Host        string `json:"host"` // self-host override
                Name        string `json:"name"`
                Description string `json:"description"`
                License     string `json:"license"`
                Gitignore   string `json:"gitignore"`
                Private     bool   `json:"private"`
                Token       string `json:"token"`
                SessionID   string `json:"session_id"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        req.Name = strings.TrimSpace(req.Name)
        if req.Name == "" {
                writeError(w, 400, "name is required")
                return
        }
        if req.Kind == "" {
                req.Kind = "github"
        }
        host := req.Host
        if host == "" {
                host = map[string]string{"github": "github.com", "gitea": "gitea.com", "gitlab": "gitlab.com"}[req.Kind]
                if host == "" {
                        writeError(w, 400, "kind must be github|gitea|gitlab")
                        return
                }
        }
        token := firstNonEmpty(strings.TrimSpace(req.Token), s.globalToken(req.Kind))
        if token == "" {
                writeError(w, 401, "creating a repo needs a "+req.Kind+" token")
                return
        }
        hi := forge.HostInfo{Kind: req.Kind, Host: host, WebBase: "https://" + host,
                APIBase: apiBaseFor(req.Kind, host), Repo: req.Name}
        c := forge.NewClient(hi)
        meta, err := c.CreateRepo(r.Context(), req.Name, req.Description, req.License,
                req.Gitignore, req.Private, token)
        if err != nil {
                s.wsErr(w, err)
                return
        }
        // connect the fresh repo (full access by construction — we made it)
        ws := &store.Workspace{Kind: req.Kind, Host: host, Owner: ownerOf(meta.FullName),
                Repo: repoOf(meta.FullName), RepoURL: meta.WebURL,
                Branch: meta.DefaultBranch, DefaultBranch: meta.DefaultBranch,
                Access: forge.AccessFull}
        if strings.TrimSpace(req.Token) != "" {
                ws.ID = mintWSID()
                ws.TokenEnv = "WORKSPACE_" + ws.ID
                if s.vault != nil {
                        _ = s.vault.Set(ws.TokenEnv, req.Kind, strings.TrimSpace(req.Token), "")
                }
        }
        if ws.Name == "" {
                ws.Name = meta.FullName
        }
        metaJSON, _ := json.Marshal(meta)
        ws.Meta = string(metaJSON)
        if err := s.db.CreateWorkspace(ws); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        if req.SessionID != "" {
                _ = s.db.BindWorkspace(req.SessionID, ws.ID)
        }
        s.wsJSON(w, 200, ws, map[string]any{"created": true})
}

func ownerOf(full string) string {
        if i := strings.Index(full, "/"); i >= 0 {
                return full[:i]
        }
        return full
}

func repoOf(full string) string {
        if i := strings.Index(full, "/"); i >= 0 {
                return full[i+1:]
        }
        return full
}

// ── form data (licenses/gitignores) + discover + resolve ─────────────────

func (s *Server) handleWorkspaceLicenses(w http.ResponseWriter, r *http.Request) {
        kind := r.URL.Query().Get("kind")
        if kind == "" {
                kind = "github"
        }
        host := r.URL.Query().Get("host")
        c := forge.NewClient(forge.HostInfo{Kind: kind, Host: host,
                WebBase: "https://" + host, APIBase: apiBaseFor(kind, host)})
        list, err := c.Licenses(r.Context(), s.globalToken(kind))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{"licenses": list})
}

func (s *Server) handleWorkspaceGitignores(w http.ResponseWriter, r *http.Request) {
        kind := r.URL.Query().Get("kind")
        if kind == "" {
                kind = "github"
        }
        host := r.URL.Query().Get("host")
        c := forge.NewClient(forge.HostInfo{Kind: kind, Host: host,
                WebBase: "https://" + host, APIBase: apiBaseFor(kind, host)})
        list, err := c.Gitignores(r.Context(), s.globalToken(kind))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{"gitignores": list})
}

func (s *Server) handleWorkspaceDiscover(w http.ResponseWriter, r *http.Request) {
        q := r.URL.Query()
        kind := q.Get("kind")
        if kind == "" {
                kind = "github"
        }
        host := q.Get("host")
        token := firstNonEmpty(strings.TrimSpace(q.Get("token")), s.globalToken(kind))
        if token == "" {
                writeError(w, 401, "discovering your repos needs a "+kind+" token")
                return
        }
        c := forge.NewClient(forge.HostInfo{Kind: kind, Host: host,
                WebBase: "https://" + host, APIBase: apiBaseFor(kind, host)})
        repos, err := c.ListUserRepos(r.Context(), token, atoiDefault(q.Get("limit"), 50))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{"repos": repos})
}

// handleWorkspaceResolve — ephemeral (no row): the explore tool's entry
// for RAW URLs (works without connecting anything).
func (s *Server) handleWorkspaceResolve(w http.ResponseWriter, r *http.Request) {
        raw := strings.TrimSpace(r.URL.Query().Get("url"))
        if raw == "" {
                writeError(w, 400, "url is required")
                return
        }
        token := strings.TrimSpace(r.URL.Query().Get("token"))
        hi, err := forge.Recognize(raw)
        if err != nil {
                writeError(w, 400, err.Error())
                return
        }
        if hi.Kind == "unknown" {
                if err := forge.GuardURL(r.Context(), hi.WebBase); err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
                hi, err = forge.ProbeHost(r.Context(), hi)
                if err != nil {
                        writeError(w, 400, err.Error())
                        return
                }
        }
        c := forge.NewClient(hi)
        meta, err := c.RepoInfo(r.Context(), firstNonEmpty(token, s.globalToken(hi.Kind)))
        if err != nil {
                s.wsErr(w, err)
                return
        }
        writeJSON(w, 200, map[string]any{
                "host_info": hi,
                "meta":      meta,
                "access":    meta.Access(token != "" || s.hasGlobalToken(hi.Kind)),
        })
}

// ── helpers ───────────────────────────────────────────────────────────────

// refOrWS: explicit ref > workspace branch > "" (adapter defaults).
func refOrWS(ref string, ws *store.Workspace) string {
        if strings.TrimSpace(ref) != "" {
                return strings.TrimSpace(ref)
        }
        return ws.Branch
}

func atoiDefault(s string, def int) int {
        n := 0
        for _, ch := range s {
                if ch < '0' || ch > '9' {
                        return def
                }
                n = n*10 + int(ch-'0')
                if n > 100000 {
                        return def
                }
        }
        if n == 0 {
                return def
        }
        return n
}

// wsErr maps forge errors to honest status codes.
func (s *Server) wsErr(w http.ResponseWriter, err error) {
        if err == nil {
                return
        }
        if forge.IsNotFound(err) {
                writeError(w, 404, err.Error())
                return
        }
        if forge.IsUnauthorized(err) {
                writeError(w, 401, err.Error())
                return
        }
        if forge.IsForbidden(err) {
                writeError(w, 403, err.Error())
                return
        }
        if err == forge.ErrUnsupported {
                writeError(w, 400, err.Error())
                return
        }
        writeError(w, 502, err.Error())
}

// ═══════════════════════════════════════════════════════════════════════
// v0.46 — GLOBAL FORGE ACCOUNTS + GITHUB APP OAUTH + DEVICE WORKSPACES
//
// User spec (edits A7/A8/A11/A12): paste a token ONCE (or "Sign in with
// GitHub" and never paste anything) — it is encrypted into the vault
// instantly and every form reuses it. The GitHub App web flow exchanges
// code→token engine-side; expiring tokens (recommended setting) refresh
// themselves via refresh_token. Device-storage workspaces are PWA-owned
// (FileSystemHandle in IndexedDB) — the engine only tracks the row so it
// appears in the global list and binds per chat.
// ═══════════════════════════════════════════════════════════════════════

// accountExtra is the JSON blob riding a vault entry's EXTRA field (also
// encrypted at rest — see vault.Entry).
type accountExtra struct {
        Login        string `json:"login,omitempty"`
        RefreshToken string `json:"refresh_token,omitempty"`
        ExpiresAt    int64  `json:"expires_at,omitempty"` // unix seconds
}

func accountEnv(kind string) string {
        switch kind {
        case "github":
                return "GITHUB_PAT"
        case "gitea":
                return "GITEA_TOKEN"
        }
        return ""
}

// accountInfo: (login, signedIn) for a forge kind — never the secret.
func (s *Server) accountInfo(kind string) (string, bool) {
        env := accountEnv(kind)
        if env == "" || s.vault == nil {
                return "", false
        }
        _, extra, err := s.vault.Get(env)
        if err != nil {
                return "", false
        }
        var ae accountExtra
        _ = json.Unmarshal([]byte(extra), &ae)
        return ae.Login, true
}

// handleWorkspaceAccountsList — which forges have a saved sign-in.
func (s *Server) handleWorkspaceAccountsList(w http.ResponseWriter, r *http.Request) {
        id, secret := s.ghOAuthCreds()
        out := []map[string]any{}
        for _, kind := range []string{"github", "gitea"} {
                login, signed := s.accountInfo(kind)
                row := map[string]any{"kind": kind, "signed_in": signed, "login": login}
                if kind == "github" {
                        row["oauth_configured"] = id != "" && secret != ""
                }
                out = append(out, row)
        }
        writeJSON(w, 200, map[string]any{"accounts": out})
}

// handleWorkspaceAccountSet — save (or replace) a forge token ONCE. The
// token is verified against the forge, then stored encrypted with the
// account login in the extra blob. It is NEVER returned by any API.
func (s *Server) handleWorkspaceAccountSet(w http.ResponseWriter, r *http.Request) {
        var req struct {
                Kind  string `json:"kind"`
                Token string `json:"token"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        req.Kind = strings.TrimSpace(req.Kind)
        req.Token = strings.TrimSpace(req.Token)
        env := accountEnv(req.Kind)
        if env == "" {
                writeError(w, 400, "kind must be github or gitea")
                return
        }
        if req.Token == "" {
                writeError(w, 400, "token is required")
                return
        }
        if s.vault == nil {
                writeError(w, 500, "vault not initialized")
                return
        }
        login, err := forgeLoginFor(req.Kind, req.Token)
        if err != nil {
                writeError(w, 401, "token rejected: "+err.Error())
                return
        }
        extra, _ := json.Marshal(accountExtra{Login: login})
        if err := s.vault.Set(env, req.Kind, req.Token, string(extra)); err != nil {
                writeError(w, 500, "vault: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"saved": true, "kind": req.Kind, "login": login})
}

// handleWorkspaceAccountDelete — sign out of a forge (removes the vault key).
func (s *Server) handleWorkspaceAccountDelete(w http.ResponseWriter, r *http.Request) {
        env := accountEnv(r.URL.Query().Get("kind"))
        if env == "" {
                writeError(w, 400, "kind must be github or gitea")
                return
        }
        if s.vault != nil {
                _ = s.vault.Delete(env)
        }
        writeJSON(w, 200, map[string]any{"deleted": true})
}

// forgeLoginFor verifies a token by fetching the forge's /user.
// v0.52: rides the netx transport — the pure-Go resolver on Android dies
// on broken /etc/resolv.conf entries (::1 etc.); netx falls back to
// DNS-over-HTTPS so verification works where the default client can't.
func forgeLoginFor(kind, token string) (string, error) {
        var endpoint string
        switch kind {
        case "github":
                endpoint = forgeAPIBase + "/user"
        case "gitea":
                endpoint = "https://gitea.com/api/v1/user"
        default:
                return "", fmt.Errorf("unsupported kind %s", kind)
        }
        ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
        defer cancel()
        req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
        req.Header.Set("Authorization", "Bearer "+token)
        req.Header.Set("Accept", "application/json")
        req.Header.Set("User-Agent", "doomalay-engine")
        resp, err := oauthHTTP.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        if resp.StatusCode == 401 || resp.StatusCode == 403 {
                return "", fmt.Errorf("unauthorized (HTTP %d)", resp.StatusCode)
        }
        if resp.StatusCode != 200 {
                return "", fmt.Errorf("HTTP %d", resp.StatusCode)
        }
        var u struct {
                Login string `json:"login"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&u); err != nil {
                return "", err
        }
        if u.Login == "" {
                return "", fmt.Errorf("forge returned no login")
        }
        return u.Login, nil
}

// ── GitHub App OAuth (web flow) ──────────────────────────────────────────

var oauthStates = struct {
        sync.Mutex
        m map[string]oauthPending
}{m: map[string]oauthPending{}}

type oauthPending struct {
        Redirect string
        Expires  time.Time
}

// ghOAuthCreds: env override first (headless installs), then the vault,
// then the BUILT-IN default (v0.47 task 10/11: the user's "Doomalay
// Workspaces" GitHub App client id — the secret is still vault/env only,
// the user generates it on the app's settings page).
const ghOAuthDefaultClientID = "Iv23liDzVTw7zphxo5Hv"

// v0.52 OAuth egress plumbing: every OAuth/token-exchange call rides the
// netx transport (system resolver → DNS-over-HTTPS fallback). The live
// bug: hfExchangeCode/ghTokenExchange used bare http.Clients, so on
// devices whose /etc/resolv.conf points at a dead local resolver
// ("nameserver ::1" — observed on the user's device) the exchange died
// with `lookup huggingface.co on [::1]:53: connection refused` while
// everything routed through netx kept working. Base URLs are vars so
// tests can point them at a local httptest server.
var (
        forgeAPIBase    = "https://api.github.com"
        ghTokenEndpoint = "https://github.com/login/oauth/access_token"

        // oauthHTTP: netx-dialed, no global timeout (per-request contexts
        // carry the deadlines).
        oauthHTTP = &http.Client{Transport: netx.Transport()}
)

func (s *Server) ghOAuthCreds() (id, secret string) {
        if id = strings.TrimSpace(os.Getenv("DOOMALAY_GH_CLIENT_ID")); id != "" {
                return id, strings.TrimSpace(os.Getenv("DOOMALAY_GH_CLIENT_SECRET"))
        }
        if s.vault != nil {
                if v, _, err := s.vault.Get("GITHUB_OAUTH_CLIENT_ID"); err == nil {
                        id = strings.TrimSpace(v)
                }
                if v, _, err := s.vault.Get("GITHUB_OAUTH_CLIENT_SECRET"); err == nil {
                        secret = strings.TrimSpace(v)
                }
        }
        if id == "" {
                id = ghOAuthDefaultClientID // no secret — start works, exchange can't
        }
        return id, secret
}

// oauthRedirectURI derives the callback from the request origin — works on
// localhost (GitHub allows http for loopback), cloudflare tunnels (HTTPS,
// X-Forwarded-Proto), and any LAN/origin the PWA is served from.
func oauthRedirectURI(r *http.Request) string {
        scheme := ""
        if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
                scheme = strings.TrimSpace(strings.Split(proto, ",")[0])
        }
        if scheme == "" {
                if r.TLS != nil {
                        scheme = "https"
                } else if strings.HasPrefix(r.Host, "127.0.0.1") ||
                        strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "[::1]") {
                        scheme = "http"
                } else {
                        scheme = "http"
                }
        }
        return scheme + "://" + r.Host + "/api/github/oauth/callback"
}

// handleGHOAuthStatus — is "Sign in with GitHub" wired up? (+ who's signed in)
// v0.47: exposes client_id + has_secret separately — the client id ships
// built-in (the user's GitHub App), but the SECRET is vault/env-only, so
// the UI can offer "paste the secret once" before the sign-in button can
// complete its token exchange.
func (s *Server) handleGHOAuthStatus(w http.ResponseWriter, r *http.Request) {
        id, secret := s.ghOAuthCreds()
        login, signed := s.accountInfo("github")
        writeJSON(w, 200, map[string]any{
                "configured":   id != "" && secret != "",
                "client_id":    id,
                "has_secret":   secret != "",
                "signed_in":    signed,
                "login":        login,
                // the URI to register in the GitHub App settings for THIS origin
                "redirect_uri": oauthRedirectURI(r),
        })
}

// handleGHOAuthConfig — store the GitHub App client pair (encrypted).
// v0.52: client_id may be empty → the built-in default (the shipped app id)
// or the previously saved one is kept; only the secret is REQUIRED. That
// makes the one-time setup box a pure secret paste for the common case
// (the id ships with the app — it is public, the secret is not).
func (s *Server) handleGHOAuthConfig(w http.ResponseWriter, r *http.Request) {
        var req struct {
                ClientID     string `json:"client_id"`
                ClientSecret string `json:"client_secret"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        req.ClientID = strings.TrimSpace(req.ClientID)
        req.ClientSecret = strings.TrimSpace(req.ClientSecret)
        if req.ClientSecret == "" {
                writeError(w, 400, "client_secret is required (client_id is optional — the app's built-in id is used)")
                return
        }
        if req.ClientID == "" {
                // keep the saved id when there is one, else the built-in
                if s.vault != nil {
                        if v, _, err := s.vault.Get("GITHUB_OAUTH_CLIENT_ID"); err == nil && strings.TrimSpace(v) != "" {
                                req.ClientID = strings.TrimSpace(v)
                        }
                }
                if req.ClientID == "" {
                        req.ClientID = ghOAuthDefaultClientID
                }
        }
        if s.vault == nil {
                writeError(w, 500, "vault not initialized")
                return
        }
        if err := s.vault.Set("GITHUB_OAUTH_CLIENT_ID", "github", req.ClientID, ""); err != nil {
                writeError(w, 500, "vault: "+err.Error())
                return
        }
        if err := s.vault.Set("GITHUB_OAUTH_CLIENT_SECRET", "github", req.ClientSecret, ""); err != nil {
                writeError(w, 500, "vault: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"configured": true,
                "redirect_uri": oauthRedirectURI(r)})
}

func randHex(n int) string {
        b := make([]byte, n)
        _, _ = rand.Read(b)
        return hex.EncodeToString(b)
}

// handleGHOAuthStart — redirect the user to GitHub's authorize page.
func (s *Server) handleGHOAuthStart(w http.ResponseWriter, r *http.Request) {
        id, secret := s.ghOAuthCreds()
        if id == "" || secret == "" {
                // v0.52: name the exact fix — the one-time OAuth setup box in
                // the GitHub connect panel (or env DOOMALAY_GH_CLIENT_SECRET
                // on headless installs). The old message read like a bug; it
                // is the deliberate secretless-by-default state.
                writeError(w, 400, "GitHub sign-in needs its one-time setup: open the GitHub connect panel and paste the GitHub App client secret into the yellow \"one-time OAuth setup\" box (it is stored encrypted on this device, never in the app) — or paste a token as the manual method")
                return
        }
        redirect := r.URL.Query().Get("redirect")
        // same-origin paths only — never let the flow bounce elsewhere
        if redirect == "" || !strings.HasPrefix(redirect, "/") || strings.HasPrefix(redirect, "//") {
                redirect = "/"
        }
        state := randHex(16)
        oauthStates.Lock()
        now := time.Now()
        for k, v := range oauthStates.m {
                if now.After(v.Expires) {
                        delete(oauthStates.m, k)
                }
        }
        oauthStates.m[state] = oauthPending{Redirect: redirect, Expires: now.Add(10 * time.Minute)}
        oauthStates.Unlock()
        u := "https://github.com/login/oauth/authorize?client_id=" + url.QueryEscape(id) +
                "&redirect_uri=" + url.QueryEscape(oauthRedirectURI(r)) +
                "&state=" + url.QueryEscape(state)
        http.Redirect(w, r, u, http.StatusFound)
}

func popOAuthState(state string) (oauthPending, bool) {
        oauthStates.Lock()
        defer oauthStates.Unlock()
        p, ok := oauthStates.m[state]
        if ok {
                delete(oauthStates.m, state)
        }
        if !ok || time.Now().After(p.Expires) {
                return oauthPending{}, false
        }
        return p, true
}

// ghTokenExchange — the code→token (or refresh→token) POST.
// v0.52: netx transport (see oauthHTTP above) — the Android pure-Go
// resolver could not reach github.com on devices with a dead local
// nameserver; the DoH fallback now carries the exchange.
func ghTokenExchange(ctx context.Context, form url.Values) (access, refresh string, expiresIn int64, err error) {
        req, _ := http.NewRequestWithContext(ctx, "POST",
                ghTokenEndpoint, strings.NewReader(form.Encode()))
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
        req.Header.Set("Accept", "application/json")
        req.Header.Set("User-Agent", "doomalay-engine")
        resp, err := oauthHTTP.Do(req)
        if err != nil {
                return "", "", 0, err
        }
        defer resp.Body.Close()
        var out struct {
                AccessToken      string `json:"access_token"`
                RefreshToken     string `json:"refresh_token"`
                ExpiresIn        int64  `json:"expires_in"`
                Error            string `json:"error"`
                ErrorDescription string `json:"error_description"`
        }
        if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
                return "", "", 0, err
        }
        if out.Error != "" {
                if out.ErrorDescription != "" {
                        return "", "", 0, fmt.Errorf("%s", out.ErrorDescription)
                }
                return "", "", 0, fmt.Errorf("%s", out.Error)
        }
        if out.AccessToken == "" {
                return "", "", 0, fmt.Errorf("github returned no access token")
        }
        return out.AccessToken, out.RefreshToken, out.ExpiresIn, nil
}

// handleGHOAuthCallback — GitHub bounces here with ?code&state; exchange,
// store encrypted, and send the user back to the PWA.
func (s *Server) handleGHOAuthCallback(w http.ResponseWriter, r *http.Request) {
        q := r.URL.Query()
        backTo := func(suffix string) {
                http.Redirect(w, r, "/?"+suffix, http.StatusFound)
        }
        if e := q.Get("error"); e != "" {
                backTo("gh_error=" + url.QueryEscape(e))
                return
        }
        pending, ok := popOAuthState(q.Get("state"))
        if !ok {
                writeError(w, 400, "stale or unknown sign-in state — start the sign-in again")
                return
        }
        if q.Get("code") == "" {
                backTo("gh_error=" + url.QueryEscape("missing code"))
                return
        }
        id, secret := s.ghOAuthCreds()
        if id == "" || secret == "" {
                writeError(w, 400, "GitHub sign-in isn't configured")
                return
        }
        if s.vault == nil {
                writeError(w, 500, "vault not initialized")
                return
        }
        ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
        defer cancel()
        form := url.Values{
                "client_id":     {id},
                "client_secret": {secret},
                "code":          {q.Get("code")},
                "redirect_uri":  {oauthRedirectURI(r)},
        }
        access, refresh, expiresIn, err := ghTokenExchange(ctx, form)
        if err != nil {
                backTo("gh_error=" + url.QueryEscape(err.Error()))
                return
        }
        ae := accountExtra{RefreshToken: refresh}
        if expiresIn > 0 {
                ae.ExpiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Unix()
        }
        // who signed in? (best-effort — a /user hiccup must not fail the flow)
        if login, err := forgeLoginFor("github", access); err == nil {
                ae.Login = login
        }
        extra, _ := json.Marshal(ae)
        if err := s.vault.Set("GITHUB_PAT", "github", access, string(extra)); err != nil {
                writeError(w, 500, "vault: "+err.Error())
                return
        }
        suffix := "gh_connected=1"
        if ae.Login != "" {
                suffix += "&gh_login=" + url.QueryEscape(ae.Login)
        }
        // v0.52 FIX (found by TestGHOAuthFullRoundTrip): the suffix used to
        // be appended RAW to the redirect path — "/" + "gh_connected=1" =
        // "/gh_connected=1", a PATH with no query, so the PWA's landing
        // listener (URLSearchParams) never matched and the browser sat on
        // a bogus URL instead of the app with the success toast. Glue the
        // query on properly (HF's callback already did this).
        sep := "?"
        if strings.Contains(pending.Redirect, "?") {
                sep = "&"
        }
        http.Redirect(w, r, pending.Redirect+sep+suffix, http.StatusFound)
}

// ghRefreshMu serializes refresh exchanges (a swarm of parallel forge calls
// could otherwise stampede the token endpoint).
var ghRefreshMu sync.Mutex

// githubToken — GITHUB_PAT with automatic refresh when the OAuth minted
// token is near/past expiry and a refresh_token exists.
func (s *Server) githubToken() string {
        if s.vault == nil {
                return ""
        }
        tok, extra, err := s.vault.Get("GITHUB_PAT")
        if err != nil || tok == "" {
                return ""
        }
        var ae accountExtra
        _ = json.Unmarshal([]byte(extra), &ae)
        if ae.ExpiresAt == 0 || ae.RefreshToken == "" ||
                time.Now().Unix() < ae.ExpiresAt-60 {
                return tok // plain PAT or still fresh
        }
        ghRefreshMu.Lock()
        defer ghRefreshMu.Unlock()
        // re-read — another goroutine may have refreshed while we waited
        if tok2, extra2, err2 := s.vault.Get("GITHUB_PAT"); err2 == nil {
                tok, extra = tok2, extra2
        }
        _ = json.Unmarshal([]byte(extra), &ae)
        if ae.ExpiresAt == 0 || ae.RefreshToken == "" ||
                time.Now().Unix() < ae.ExpiresAt-60 {
                return tok
        }
        id, secret := s.ghOAuthCreds()
        if id == "" || secret == "" {
                return tok // can't refresh without the app pair
        }
        ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
        defer cancel()
        form := url.Values{
                "client_id":     {id},
                "client_secret": {secret},
                "grant_type":    {"refresh_token"},
                "refresh_token": {ae.RefreshToken},
        }
        access, refresh, expiresIn, err := ghTokenExchange(ctx, form)
        if err != nil {
                return tok // stale-but-maybe-working beats nothing
        }
        ae.RefreshToken = firstNonEmpty(refresh, ae.RefreshToken)
        if expiresIn > 0 {
                ae.ExpiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Unix()
        }
        newExtra, _ := json.Marshal(ae)
        if err := s.vault.Set("GITHUB_PAT", "github", access, string(newExtra)); err == nil {
                return access
        }
        return tok
}

// ── device-storage workspaces (item 11) ─────────────────────────────────

var deviceNameRe = regexp.MustCompile(`[^a-z0-9_-]+`)

// handleWorkspaceDevice — register a device-storage workspace. The PWA owns
// the FileSystemHandle (IndexedDB, keyed by the returned id); the engine
// tracks the row so it lists globally and binds per chatbot.
func (s *Server) handleWorkspaceDevice(w http.ResponseWriter, r *http.Request) {
        var req struct {
                Name      string `json:"name"`
                Path      string `json:"path"` // display path (informational)
                SessionID string `json:"session_id"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        req.Name = strings.TrimSpace(req.Name)
        if req.Name == "" {
                writeError(w, 400, "name is required")
                return
        }
        slug := deviceNameRe.ReplaceAllString(strings.ToLower(req.Name), "-")
        slug = strings.Trim(slug, "-")
        if slug == "" {
                slug = "device"
        }
        meta, _ := json.Marshal(map[string]any{
                "device": true, "display_path": strings.TrimSpace(req.Path),
        })
        ws := &store.Workspace{
                Kind: "device", Host: "device", Owner: "this device",
                Repo: slug, Name: req.Name, Access: forge.AccessFull,
                Meta: string(meta),
        }
        if err := s.db.CreateWorkspace(ws); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        if req.SessionID != "" {
                if err := s.db.BindWorkspace(req.SessionID, ws.ID); err != nil {
                        writeError(w, 500, "store: "+err.Error())
                        return
                }
        }
        s.wsJSON(w, 200, ws, map[string]any{"device": true})
}

// handleWorkspaceBranches — persist the branch selection for a connected
// repo (the my-repos flow): primary rides ws.Branch, the full set rides
// meta.branches (the agent + drawer's branch switcher read both).
func (s *Server) handleWorkspaceBranches(w http.ResponseWriter, r *http.Request) {
        ws := s.loadWS(w, r)
        if ws == nil {
                return
        }
        var req struct {
                Branches []string `json:"branches"`
                Primary  string   `json:"primary"`
        }
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if len(req.Branches) == 0 {
                writeError(w, 400, "branches (at least one) is required")
                return
        }
        if len(req.Branches) > 20 {
                writeError(w, 400, "max 20 branches per workspace")
                return
        }
        seen := map[string]bool{}
        clean := make([]string, 0, len(req.Branches))
        for _, b := range req.Branches {
                b = strings.TrimSpace(b)
                if b == "" || seen[b] || strings.Contains(b, "..") || strings.ContainsAny(b, " \t~^:") {
                        continue
                }
                seen[b] = true
                clean = append(clean, b)
        }
        if len(clean) == 0 {
                writeError(w, 400, "no valid branch names")
                return
        }
        primary := strings.TrimSpace(req.Primary)
        if primary == "" || !seen[primary] {
                primary = clean[0]
        }
        meta := ws.MetaJSON()
        if meta == nil {
                meta = map[string]any{}
        }
        meta["branches"] = clean
        metaJSON, _ := json.Marshal(meta)
        ws.Meta = string(metaJSON)
        ws.Branch = primary
        if err := s.db.UpdateWorkspace(ws); err != nil {
                writeError(w, 500, "store: "+err.Error())
                return
        }
        s.wsJSON(w, 200, ws, map[string]any{"branches": clean, "primary": primary})
}
