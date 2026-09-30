// workspacetool.go — v0.76.5 THE QUICK-CHAT WORKSPACE HAND.
//
// USER SPEC (the ultimate verification wave): "ensure a user can connect
// cloud workspaces like github and ensure the workspace actually connects
// and the bot can actually push, pr, check history, issues, discussions,
// the code itself, fork… for both quick chat and HF chat."
//
// THE GAP this closes: the brain path has dt_workspace.py (the strands
// bridge to the engine REST surface) but the DIRECT path — the quick
// chats on the APK build, and the brain-down fallback — had NO workspace
// tool at all. The model could not even SEE the chat's connected repos.
// This file is the direct path's runner: "ACTION: workspace {…}" lines
// (the ReAct ACTION protocol) land here via llm.ChatRequest.
// WorkspaceToolFn, and execute the SAME forge.Client operations the REST
// handlers serve (one source of truth — s.wsClient/s.wsToken/refOrWS).
//
// VERBS (kept twin-identical to dt_workspace.py's so both chat paths
// speak the same language):
//   help, list, info, tree, ls, read, readme, grep, view,
//   put, pr, fork, create, discover
//
// ACCESS MODEL (the user's read/partial/full tiers):
//   read    → tree/ls/read/readme/grep/view only
//   partial → + fork, pr, clone-style write-to-own-copy flows
//   full    → + put (direct file writes = API commits)
//   fork: allowed at ANY tier when a token exists (the fork lands in the
//   user's OWN account — it is not a write to this repo; the read-tier
//   write path is exactly fork → write → PR).
//
// `ws` resolution mirrors the brain's workspace_by_ref: workspace id,
// owner/repo, bare repo name, or name suffix — case-insensitive.
//
// OBSERVATION heads are deterministic marker lines (COMMITTED / PR
// OPENED / FORKED — …) so future pill work can match them the way
// "SKILL LOADED —" does (turnBundleOf).
package server

import (
        "context"
        "encoding/json"
        "fmt"
        "sort"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

const wsToolListCap = 60 // rows shown before the "+N more" fold (the brain twin's cap)
const wsToolBodyCap = 6000 // dt_spec rule 9: model-facing text ≤ ~6000 chars

// workspaceVerbs is the canonical verb list (help + unknown-action teach).
const workspaceVerbs = "help, list, info, tree, ls, read, readme, grep, view, put, pr, fork, create, discover"

// runWorkspaceAction executes an "ACTION: workspace {json}" call for the
// direct path. Returns OBSERVATION-ready text (the ReAct loop feeds it
// back to the model as the user message).
func (s *Server) runWorkspaceAction(ctx context.Context, sessionID, argJSON string) string {
        var args map[string]any
        if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
                return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
        }
        get := func(k string) string {
                v, _ := args[k].(string)
                return strings.TrimSpace(v)
        }
        action := get("action")
        if action == "" {
                // Ergonomics (the model-thrash lesson from v0.76.4): a bare
                // "workspace {…}" with no action means the model wants the map.
                action = "help"
        }

        // bound rows for THIS chat (device-storage rows are PWA-only — skip,
        // same as brainReq["workspaces"])
        bound := s.sessionCloudWorkspaces(sessionID)

        switch action {
        case "help":
                return "OBSERVATION:\n" + workspaceHelpText(len(bound))
        case "list":
                if len(bound) == 0 {
                        return "OBSERVATION:\nno cloud workspace is connected to this chat yet. The user connects one from the chat header's +workspace pill (GitHub/Gitea/GitLab/sourcehut URL + sign-in, or any public repo read-only). Use action \"discover\" once one is connected, or answer from context." + workspaceHelpTail()
                }
                var sb strings.Builder
                fmt.Fprintf(&sb, "%d connected workspace(s):\n", len(bound))
                for _, ws := range bound {
                        fmt.Fprintf(&sb, "- %s [id=%s] %s access=%s branch=%s\n",
                                ws.Name, ws.ID, ws.Kind, ws.Access, wsBranchOr(ws, "(default)"))
                }
                return "OBSERVATION:\n" + sb.String()
        case "info":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                c := s.wsClient(ws)
                meta, err := c.RepoInfo(ctx, s.wsToken(ws))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                var sb strings.Builder
                fmt.Fprintf(&sb, "%s [%s] access=%s\n", ws.Name, ws.Kind, ws.Access)
                if meta.Description != "" {
                        fmt.Fprintf(&sb, "%s\n", meta.Description)
                }
                fmt.Fprintf(&sb, "default branch: %s", meta.DefaultBranch)
                if meta.Private {
                        sb.WriteString(" (private)")
                }
                sb.WriteString("\n")
                if meta.Stars > 0 || meta.Language != "" {
                        fmt.Fprintf(&sb, "stars: %d · language: %s\n", meta.Stars, meta.Language)
                }
                fmt.Fprintf(&sb, "url: %s\n", meta.WebURL)
                return "OBSERVATION:\n" + sb.String()
        case "tree", "ls":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                path := strings.Trim(get("path"), "/")
                ref := refOrWS(get("ref"), ws)
                c := s.wsClient(ws)
                var entries []forge.TreeEntry
                var truncated bool
                var err error
                if action == "tree" {
                        entries, truncated, err = c.Tree(ctx, path, ref, s.wsToken(ws))
                } else {
                        entries, truncated, err = c.Tree(ctx, path, ref, s.wsToken(ws))
                        entries = onlyDirsAndTopLevel(entries, path)
                }
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                return "OBSERVATION:\n" + wsTreeText(ws, path, ref, entries, truncated)
        case "read":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                path := strings.Trim(get("path"), "/")
                if path == "" {
                        return "OBSERVATION:\nerror: read needs {\"ws\":…, \"path\":\"the/file\"} — range: head:80 | tail:40 | lines:10-60"
                }
                fc, err := s.wsClient(ws).File(ctx, path, refOrWS(get("ref"), ws), get("range"), s.wsToken(ws))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                if fc.Binary {
                        return "OBSERVATION:\n" + path + " is a binary file (" + fmt.Sprint(fc.Size) + " bytes) — no text to read"
                }
                body := fc.Content
                if len(body) > wsToolBodyCap {
                        body = body[:wsToolBodyCap] + "\n… (truncated at " + fmt.Sprint(wsToolBodyCap) + " chars — use range lines:A-B for a slice)"
                }
                return "OBSERVATION:\n" + path + " (" + fmt.Sprint(fc.Size) + " bytes, blob sha " + fc.SHA + ")\n" + body
        case "readme":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                fc, err := s.wsClient(ws).Readme(ctx, refOrWS(get("ref"), ws), s.wsToken(ws))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                body := fc.Content
                if len(body) > wsToolBodyCap {
                        body = body[:wsToolBodyCap] + "\n… (truncated)"
                }
                return "OBSERVATION:\nREADME of " + ws.Name + ":\n" + body
        case "grep":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                q := get("query")
                if q == "" {
                        return "OBSERVATION:\nerror: grep needs {\"ws\":…, \"query\":\"text\"}"
                }
                limit := wsArgInt(args, "limit", 30)
                hits, err := s.wsClient(ws).Search(ctx, q, refOrWS(get("ref"), ws), s.wsToken(ws), limit)
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                var sb strings.Builder
                fmt.Fprintf(&sb, "%d hit(s) for %q in %s:\n", len(hits), q, ws.Name)
                for i, h := range hits {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more (narrow the query or raise limit)\n", len(hits)-i)
                                break
                        }
                        line := fmt.Sprintf("- %s:%d", h.Path, h.Line)
                        if h.Snippet != "" {
                                line += "  " + strings.TrimSpace(h.Snippet)
                        }
                        sb.WriteString(wsClip(line, 160) + "\n")
                }
                return "OBSERVATION:\n" + sb.String()
        case "view":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                what := get("what")
                if what == "" {
                        what = get("view") // tolerate the alternate key
                }
                state := get("state")
                if state == "" {
                        state = "open"
                }
                limit := wsArgInt(args, "limit", 20)
                return "OBSERVATION:\n" + s.wsViewText(ctx, ws, what, state, limit)
        case "put":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                if ws.Access != forge.AccessFull {
                        return "OBSERVATION:\nerror: workspace " + ws.Name + " is access=" + ws.Access + " — direct file writes need FULL access. The partial path: fork (this tool) → write to the fork → pr. The user can attach a write token via the workspace's ⚙ (POST /api/workspaces/{id}/token)."
                }
                path := strings.Trim(get("path"), "/")
                if path == "" {
                        return "OBSERVATION:\nerror: put needs {\"ws\":…, \"path\":\"file\", \"content\":\"…\", \"message\":\"commit msg\", \"branch\":\"…\"}"
                }
                if strings.Contains(path, "..") {
                        return "OBSERVATION:\nerror: path traversal refused"
                }
                message := get("message")
                if message == "" {
                        message = "doomalay: update " + path
                }
                branch := get("branch")
                if branch == "" {
                        branch = ws.Branch
                }
                c := s.wsClient(ws)
                tok := s.wsToken(ws)
                // v0.76.5 FEATURE-BRANCH FLOW: the contents API only commits to an
                // EXISTING ref — a put aimed at a branch that doesn't exist yet
                // creates it from HEAD first (the "commit to a branch, then PR it"
                // path a real user means by "push this on a branch").
                branchCreated := false
                if branch != "" {
                        if names, err := c.Branches(ctx, tok); err == nil {
                                found := false
                                for _, b := range names {
                                        if b == branch {
                                                found = true
                                                break
                                        }
                                }
                                if !found {
                                        if _, err := c.CreateBranch(ctx, branch, "", tok); err != nil {
                                                return "OBSERVATION:\nerror: branch " + branch + " does not exist and could not be created: " + err.Error()
                                        }
                                        branchCreated = true
                                }
                        }
                }
                // UPDATE-CREATE trap (mirror handleWorkspacePutFile): GitHub 422s
                // an update whose CURRENT blob sha is missing; fetch it first.
                sha := ""
                if fc, err := c.File(ctx, path, branch, "", tok); err == nil && fc != nil {
                        sha = fc.SHA
                }
                url, err := c.PutFile(ctx, path, branch, message, get("content"), sha, tok)
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                out := "COMMITTED — " + path + " @ " + branch
                if branchCreated {
                        out += " (branch created)"
                }
                return "OBSERVATION:\n" + out + "\ncommit: " + url +
                        "\nnext: ACTION: workspace {\"action\":\"pr\",\"ws\":\"" + ws.Name + "\",\"head\":\"" + branch + "\",\"base\":\"" + wsBranchOr(ws, "main") + "\"} opens the pull request."
        case "pr":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                if ws.Access == forge.AccessRead {
                        return "OBSERVATION:\nerror: workspace " + ws.Name + " is read-only — fork it first (action \"fork\"), connect the fork, then open the PR from the fork branch (head \"owner:branch\" on GitHub)."
                }
                head := get("head")
                if head == "" {
                        return "OBSERVATION:\nerror: pr needs {\"ws\":…, \"head\":\"branch\" (owner:branch for a fork), \"base\":\"branch\", \"title\":\"…\", \"body\":\"…\"}"
                }
                base := get("base")
                if base == "" {
                        base = wsBranchOr(ws, "")
                }
                title := get("title")
                if title == "" {
                        title = "doomalay PR: " + head + " → " + base
                }
                pr, err := s.wsClient(ws).CreatePullRequest(ctx, title, get("body"), head, base, s.wsToken(ws))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                return "OBSERVATION:\nPR OPENED — #" + fmt.Sprint(pr.Number) + " " + pr.Title + " (" + head + " → " + base + ")\nurl: " + pr.URL
        case "fork":
                ws := resolveWSToolRef(bound, get("ws"))
                if ws == nil {
                        return wsNotFound(bound, get("ws"))
                }
                if s.wsToken(ws) == "" {
                        return "OBSERVATION:\nerror: forking needs a forge token — the user attaches one via the workspace's ⚙ or the connect flow (GitHub sign-in)"
                }
                full, err := s.wsClient(ws).Fork(ctx, s.wsToken(ws))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                return "OBSERVATION:\nFORKED — " + full + "\nthe fork lives in the user's own account: connecting it (the +workspace pill with the fork's URL + write token) gives write access, then action \"pr\" with head \"owner:branch\" opens the PR back to " + ws.Name
        case "create":
                kind := get("kind")
                if kind == "" {
                        kind = "github"
                }
                name := get("name")
                if name == "" {
                        return "OBSERVATION:\nerror: create needs {\"kind\":\"github\", \"name\":\"repo-name\", \"description\":\"…\", \"license\":\"mit\"|\"\", \"gitignore\":\"…\"|\"\", \"private\":false}"
                }
                ws, err := s.createWorkspaceRepo(ctx, kind, name, get("description"), get("license"), get("gitignore"), wsArgBool(args, "private"))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                return "OBSERVATION:\nCREATED — " + ws.Name + " (access=" + ws.Access + ", id=" + ws.ID + ") — it is now connected; bind it to this chat with the +workspace pill or ask the user to pick it."
        case "discover":
                kind := get("kind")
                if kind == "" {
                        kind = "github"
                }
                tok := s.globalToken(kind)
                if tok == "" {
                        return "OBSERVATION:\nerror: discover needs the account's " + kind + " token — the user signs in via the connect page (or attaches a token). Tell them: connect GitHub from the +workspace pill, then retry."
                }
                repos, err := forge.NewClient(forge.HostInfo{Kind: kind, Host: hostOfKind(kind),
                        WebBase: "https://" + hostOfKind(kind), APIBase: apiBaseFor(kind, hostOfKind(kind))}).
                        ListUserRepos(ctx, tok, wsArgInt(args, "limit", 30))
                if err != nil {
                        return "OBSERVATION:\nerror: " + err.Error()
                }
                var sb strings.Builder
                fmt.Fprintf(&sb, "%d repo(s) in the connected %s account:\n", len(repos), kind)
                for i, m := range repos {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(repos)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- %s — %s\n", m.FullName, wsClip(m.Description, 80))
                }
                return "OBSERVATION:\n" + sb.String()
        }
        return "OBSERVATION:\nerror: unknown workspace action \"" + action + "\". Valid: " + workspaceVerbs + "." + workspaceHelpTail()
}

// wsViewText renders a view/{what} listing (issues/pulls/commits/…).
func (s *Server) wsViewText(ctx context.Context, ws *store.Workspace, what, state string, limit int) string {
        c := s.wsClient(ws)
        tok := s.wsToken(ws)
        var sb strings.Builder
        switch what {
        case "issues":
                rows, err := c.Issues(ctx, state, tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d issue(s) in %s (state=%s):\n", len(rows), ws.Name, state)
                for i, it := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        tag := "issue"
                        if it.IsPR {
                                tag = "PR"
                        }
                        fmt.Fprintf(&sb, "- #%d [%s] %s (%s, by %s)\n", it.Number, tag, wsClip(it.Title, 90), it.State, it.Author)
                }
        case "pulls", "prs":
                rows, err := c.Pulls(ctx, state, tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d pull request(s) in %s (state=%s):\n", len(rows), ws.Name, state)
                for i, p := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- #%d %s (%s, %s → base, by %s)\n", p.Number, wsClip(p.Title, 90), p.State, p.Branch, p.Author)
                }
        case "commits", "history":
                rows, err := c.Commits(ctx, "", refOrWS("", ws), tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "last %d commit(s) in %s:\n", len(rows), ws.Name)
                for i, cm := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        sha := cm.SHA
                        if len(sha) > 9 {
                                sha = sha[:9]
                        }
                        fmt.Fprintf(&sb, "- %s %s (%s, %s)\n", sha, wsClip(cm.Message, 90), cm.Author, cm.Date)
                }
        case "branches":
                rows, err := c.Branches(ctx, tok)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d branch(es) in %s:\n", len(rows), ws.Name)
                for i, b := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        mark := ""
                        if b == wsBranchOr(ws, "\x00") || (ws.Branch == "" && i == 0) {
                                mark = "  (tracked)"
                        }
                        sb.WriteString("- " + b + mark + "\n")
                }
        case "releases":
                rows, err := c.Releases(ctx, tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d release(s) in %s:\n", len(rows), ws.Name)
                for i, rel := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- %s — %s (%s)\n", rel.Tag, wsClip(rel.Name, 70), rel.PublishedAt)
                }
        case "workflows":
                rows, err := c.Workflows(ctx, tok)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d workflow(s) in %s:\n", len(rows), ws.Name)
                for i, wf := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- %s (%s, %s)\n", wf.Name, wf.State, wf.Path)
                }
        case "runs":
                rows, err := c.WorkflowRuns(ctx, tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "last %d Actions run(s) in %s:\n", len(rows), ws.Name)
                for i, run := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- %s: %s (%s, %s, %s)\n", run.Name, run.Conclusion, run.Status, run.Branch, run.StartedAt)
                }
        case "discussions":
                rows, err := c.Discussions(ctx, tok, limit)
                if err != nil {
                        return "error: " + err.Error()
                }
                fmt.Fprintf(&sb, "%d discussion(s) in %s:\n", len(rows), ws.Name)
                for i, d := range rows {
                        if i >= wsToolListCap {
                                fmt.Fprintf(&sb, "… +%d more\n", len(rows)-i)
                                break
                        }
                        fmt.Fprintf(&sb, "- %s (%s, %s)\n", wsClip(d.Title, 90), d.Author, d.UpdatedAt)
                }
        default:
                return "error: unknown view \"" + what + "\" (issues|pulls|commits|branches|releases|workflows|runs|discussions)"
        }
        return sb.String()
}

// sessionCloudWorkspaces lists this chat's bound non-device workspaces.
func (s *Server) sessionCloudWorkspaces(sessionID string) []*store.Workspace {
        if s.db == nil || sessionID == "" {
                return nil
        }
        bound, err := s.db.ListSessionWorkspaces(sessionID)
        if err != nil {
                return nil
        }
        out := make([]*store.Workspace, 0, len(bound))
        for _, ws := range bound {
                if ws.Kind == "device" {
                        continue
                }
                out = append(out, ws)
        }
        // stable order for deterministic prompts
        sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
        return out
}

// workspaceManifestFor composes the CONNECTED CLOUD WORKSPACES block for
// the direct path's turn system (the brain twin's _build_system_prompt
// shape: rows with access tiers + the tier semantics). "" when the chat
// has no bound cloud repos (the tool stays armed — action "list" answers
// with the honest teach).
func (s *Server) workspaceManifestFor(sessionID string) string {
        bound := s.sessionCloudWorkspaces(sessionID)
        if len(bound) == 0 {
                return ""
        }
        var sb strings.Builder
        sb.WriteString("CONNECTED CLOUD WORKSPACES (this chat's repos — act on them with the workspace tool):\n")
        for _, ws := range bound {
                fmt.Fprintf(&sb, "- %s [%s] access=%s (workspace ref: %s or '%s/%s')",
                        ws.Name, ws.Kind, ws.Access, ws.ID, ws.Owner, ws.Repo)
                if b := wsBranchOr(ws, ""); b != "" {
                        sb.WriteString(" branch=" + b)
                }
                sb.WriteString("\n")
        }
        sb.WriteString("access=read → browse/tree/read/grep/view only; partial → fork+PR flows; full → direct file writes (API commits). The tool routes through the engine, which holds the credentials.")
        return sb.String()
}

// resolveWSToolRef mirrors the brain's workspace_by_ref: id, owner/repo,
// bare repo name, or name suffix — case-insensitive.
func resolveWSToolRef(bound []*store.Workspace, ref string) *store.Workspace {
        ref = strings.ToLower(strings.TrimSpace(ref))
        if ref == "" {
                if len(bound) == 1 {
                        return bound[0] // the single-workspace fast path
                }
                return nil
        }
        for _, ws := range bound {
                if strings.EqualFold(ws.ID, ref) ||
                        strings.EqualFold(ws.Name, ref) ||
                        strings.EqualFold(ws.Owner+"/"+ws.Repo, ref) ||
                        strings.EqualFold(ws.Repo, ref) {
                        return ws
                }
        }
        // suffix match: "doomalay" hits "scoobybaby1999/doomalay"
        for _, ws := range bound {
                if strings.HasSuffix(strings.ToLower(ws.Name), "/"+ref) {
                        return ws
                }
        }
        return nil
}

// wsNotFound teaches the model which workspaces DO exist (the anti-thrash
// discipline: never error bare).
func wsNotFound(bound []*store.Workspace, ref string) string {
        if len(bound) == 0 {
                return "OBSERVATION:\nno cloud workspace is connected to this chat yet. The user connects one from the chat header's +workspace pill. Until then repo questions need the user to connect (or you answer from context)." + workspaceHelpTail()
        }
        var sb strings.Builder
        fmt.Fprintf(&sb, "error: no connected workspace matches %q. This chat's workspaces:\n", ref)
        for _, ws := range bound {
                fmt.Fprintf(&sb, "- %s (id=%s, access=%s)\n", ws.Name, ws.ID, ws.Access)
        }
        return "OBSERVATION:\n" + sb.String()
}

func workspaceHelpText(n int) string {
        var sb strings.Builder
        sb.WriteString("workspace tool — act on this chat's CONNECTED cloud repos (GitHub/Gitea/GitLab/sourcehut).\n")
        fmt.Fprintf(&sb, "%d workspace(s) bound to this chat (action \"list\").\n", n)
        sb.WriteString(`Actions (one JSON object per ACTION line):
  {"action":"list"}                        the chat's bound workspaces
  {"action":"info","ws":"owner/repo"}      repo card (branches, default)
  {"action":"tree","ws":"…","path":"src"}  full tree at path
  {"action":"ls","ws":"…","path":"src"}    one directory level
  {"action":"read","ws":"…","path":"f.go","range":"head:80|tail:40|lines:10-60"}
  {"action":"readme","ws":"…"}
  {"action":"grep","ws":"…","query":"text","limit":30}
  {"action":"view","ws":"…","what":"issues|pulls|commits|branches|releases|workflows|runs|discussions","state":"open"}
  {"action":"put","ws":"…","path":"f.txt","content":"…","message":"…","branch":"…"}  FULL access — an API commit
  {"action":"pr","ws":"…","head":"branch","base":"main","title":"…","body":"…"}       partial+ — head "owner:branch" for forks
  {"action":"fork","ws":"…"}                fork into the user's account (needs a token)
  {"action":"create","kind":"github","name":"new-repo","description":"…","license":"mit","private":false}
  {"action":"discover","kind":"github"}     the token account's repos
"ws" accepts the id, owner/repo, or the repo name.`)
        return sb.String()
}

func workspaceHelpTail() string {
        return "\n(workspace actions: " + workspaceVerbs + ")"
}

// ── text helpers (the brain twin's shapes) ────────────────────────────────

func wsTreeText(ws *store.Workspace, path, ref string, entries []forge.TreeEntry, truncated bool) string {
        var sb strings.Builder
        at := path
        if at == "" {
                at = "/"
        }
        fmt.Fprintf(&sb, "%s at %s", ws.Name, at)
        if ref != "" {
                sb.WriteString(" @" + ref)
        }
        fmt.Fprintf(&sb, " — %d entries", len(entries))
        if truncated {
                sb.WriteString(" (truncated — narrow the path)")
        }
        sb.WriteString(":\n")
        for i, e := range entries {
                if i >= wsToolListCap {
                        fmt.Fprintf(&sb, "… +%d more\n", len(entries)-i)
                        break
                }
                if e.Type == "tree" {
                        fmt.Fprintf(&sb, "- %s/ (dir)\n", e.Path)
                } else {
                        fmt.Fprintf(&sb, "- %s (%s)\n", e.Path, humanBytes(e.Size))
                }
        }
        return sb.String()
}

func onlyDirsAndTopLevel(entries []forge.TreeEntry, path string) []forge.TreeEntry {
        // "ls" = the immediate children only: for the flat per-path listing the
        // forge returns, keep entries whose parent IS the path.
        prefix := strings.Trim(path, "/")
        var out []forge.TreeEntry
        for _, e := range entries {
                p := strings.Trim(e.Path, "/")
                if prefix != "" {
                        if !strings.HasPrefix(p, prefix+"/") {
                                continue
                        }
                        rest := strings.TrimPrefix(p, prefix+"/")
                        if strings.Contains(rest, "/") && e.Type != "tree" {
                                continue
                        }
                }
                out = append(out, e)
        }
        return out
}

func wsBranchOr(ws *store.Workspace, def string) string {
        if ws.Branch != "" {
                return ws.Branch
        }
        if ws.DefaultBranch != "" {
                return ws.DefaultBranch
        }
        return def
}

func wsClip(s string, n int) string {
        s = strings.TrimSpace(s)
        if len(s) > n {
                return s[:n] + "…"
        }
        return s
}

func wsArgInt(args map[string]any, k string, def int) int {
        if v, ok := args[k].(float64); ok && v > 0 && v < 500 {
                return int(v)
        }
        return def
}

func wsArgBool(args map[string]any, k string) bool {
        v, _ := args[k].(bool)
        return v
}

func hostOfKind(kind string) string {
        switch kind {
        case "github":
                return "github.com"
        case "gitea":
                return "gitea.com"
        case "gitlab":
                return "gitlab.com"
        }
        return "github.com"
}

func humanBytes(n int64) string {
        switch {
        case n >= 1<<20:
                return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
        case n >= 1<<10:
                return fmt.Sprintf("%.1fKB", float64(n)/(1<<10))
        default:
                return fmt.Sprintf("%dB", n)
        }
}

// createWorkspaceRepo is the ACTION-tool reuse of handleWorkspaceCreateRepo's
// core (kind-account token → forge CreateRepo → a stored FULL-access
// workspace row). Returns the stored workspace for the observation.
func (s *Server) createWorkspaceRepo(ctx context.Context, kind, name, desc, license, gitignore string, private bool) (*store.Workspace, error) {
        tok := s.globalToken(kind)
        if tok == "" {
                return nil, fmt.Errorf("creating a %s repo needs the account's token — the user signs in via the connect page (or attaches a token)", kind)
        }
        host := hostOfKind(kind)
        c := forge.NewClient(forge.HostInfo{Kind: kind, Host: host,
                WebBase: "https://" + host, APIBase: apiBaseFor(kind, host)})
        meta, err := c.CreateRepo(ctx, name, desc, license, gitignore, private, tok)
        if err != nil {
                return nil, err
        }
        owner := ownerOf(meta.FullName)
        repo := repoOf(meta.FullName)
        ws := &store.Workspace{
                ID: mintWSID(), Name: meta.FullName, Kind: kind, Host: host,
                Owner: owner, Repo: repo, RepoURL: meta.WebURL,
                Branch: meta.DefaultBranch, DefaultBranch: meta.DefaultBranch,
                Access: forge.AccessFull, TokenEnv: accountEnv(kind),
        }
        if err := s.db.CreateWorkspace(ws); err != nil {
                return nil, err
        }
        return ws, nil
}
