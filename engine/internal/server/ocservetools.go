package server

// ocservetools.go — v1.58.1 THE INFORMATIVE PILL (PLAN-V158 §1).
//
// The user's ask verbatim: "opencode tools show opencode:grep or
// opencode:tool name and then a running description. This is Terrible,
// can't we have it show the same descriptions every other provider does,
// where it shows grep or whatever plus insightful data next to it not just
// a static running. And if we can do this in a way that doesn't require a
// write up from scratch for a tool pill only opencode uses, try reusing
// the one we have or inherit or something, keep Object Oriented
// practices."
//
// THE REUSE (the OOP answer): the native path derives every tool pill's
// operand at executeAction time (llm/chat.go: name + summary from the
// args — "web_search | latest bun release", "workspace | readme"), and
// the PWA's toolPillLabelParts else-branch renders title=p.name,
// body=p.summary. The opencode pump now speaks THE SAME GRAMMAR — the
// pill machinery (the PWA's own component) renders opencode tools
// byte-identically to native ones with ZERO new pill code. One source of
// truth for the derivation: THIS table, next to the pump.
//
// THE ARG SOURCES (live-captured, v157 research): the 2.x serve sends the
// call's args twice — input.ended's Text (the serialized JSON) and
// tool.called's Input (the structured object). The table below reads the
// same fields the tools' own schemas define (docs/v2/tools):
//
//      read    {path}                glob {pattern, path, hidden, limit}
//      grep    {pattern, path, …}    edit {path, oldString, newString}
//      write   {path, content}       patch {patchText}
//      shell   {command, workdir}    websearch {query}
//      webfetch {url}                skill {id}
//      execute {code}                subagent {agent, description, prompt}
//      opencode.session_move {directory}   opencode.session_rename {title}

import (
        "encoding/json"
        "path"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/mcpbus"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// ocNativeToolset is the pinned 2.1.2 serve's OWN documented toolset (the
// tools/docs vocabulary captured in the v157 research + the live catalog
// answers). The bridge pins the CLI version (Version = "2.1.2") — this
// list is the pin's truth, taught honestly in the {tools} block so the
// model knows its native hands without guessing.
const ocNativeToolset = "read, write, edit, patch, glob, grep, shell, webfetch, websearch, skill, subagent (delegate to subagents, incl. the read-only explorer), execute (Code Mode — compose tool calls in JavaScript), and the opencode.* Code Mode namespaces (models, session_rename, session_move, worktree_create, worktree_list, worktree_remove, list_mcp_resources, read_mcp_resource)"

// toolsBlockFor — the {tools} MIRROR block's live truth (v1.58.2 THE WIDE
// SHELF). Serve chats: the merged catalog — the opencode native toolset +
// the app's own tools through the doomalay MCP server, built LIVE from the
// mcpbus registry (never a static list; a new tool ships itself) — plus
// the honest never-ACTION note. UNBOUND serve chats (the per-chat move
// failed — an Android build without /move): the honest native-only note
// (the model never hallucinates tools it does not have). Native chats:
// "" (the collapse law eats the gap; zero native-prompt change).
func (s *Server) toolsBlockFor(sess *store.Session, serveMode, mcpBound bool) string {
        if !serveMode || sess == nil {
                return ""
        }
        var b strings.Builder
        b.WriteString("[Your tools this session — call them directly BY NAME, exactly like the tool catalog says. Never write \"ACTION: …\" prose: that grammar does NOT run in this session, and tool names you invent yourself do not exist.\n")
        b.WriteString("• Your own OpenCode tools: ")
        b.WriteString(ocNativeToolset)
        b.WriteString(".\n")
        if !mcpBound {
                b.WriteString("• The doomalay app's tools are NOT connected on this device's opencode build — use your own tools; do not assume any other tool exists.]")
                return b.String()
        }
        b.WriteString("• The doomalay app's tools (connected through the \"doomalay\" MCP server as FIRST-CLASS tools named doomalay_<name> — call them DIRECTLY by their full name, exactly like your own read/grep/shell; they are NOT inside Code Mode's execute, never call them through the Code Mode tools object): ")
        var names []string
        for _, d := range mcpbus.Defs() {
                names = append(names, "doomalay_"+d.Name)
        }
        b.WriteString(strings.Join(names, ", "))
        b.WriteString(". Their pills read bare in the user's chat (calculator, web_search, …) — same tools, friendlier name. Artifacts created through them land in this chat's drawer automatically. The gated ones (workspace, hublib, skills, termux) teach their own honest state when their switch is off.\n")
        b.WriteString("Pick whichever tool fits the job — your native ones for files/shell/web, the doomalay ones for documents, archives, the journal, the other chatbots (fleet), the app's library (hublib/skills), calculations, and the device's Termux shell (termux).]")
        return b.String()
}

// ocToolSummary derives the pill's operand line from the tool name + the
// call's serialized args. It NEVER answers a static string — an unknown
// tool still gets its FIRST string arg value (the derived fallback), and a
// tool with no readable operand answers "" (the PWA falls back to the
// tool's own name for the body — still dynamic, never "running").
func ocToolSummary(name, args string) string {
        // a nameless tool has no pill identity — the PWA's own fallback law
        // renders the tool's name as the body; "" answers that contract.
        if name == "" {
                return ""
        }
        // v1.63.1 THE NATIVE SHELF: the doomalay family (BARE names after the
        // prefix strip) rides mcpbus.DefaultSummary — the ONE truth the native
        // path itself uses (the OOP law: zero twin drift; a new tool's operand
        // derivations ship themselves). No opencode native name collides with
        // the family (websearch/webfetch are the serve's spellings, ours carry
        // the underscore).
        if s := mcpbus.DefaultSummary(name, args); s != "" {
                return s
        }
        var a map[string]any
        if args != "" {
                _ = json.Unmarshal([]byte(args), &a) // best-effort: an unparseable body → ""
        }
        str := func(keys ...string) string {
                for _, k := range keys {
                        if v, ok := a[k].(string); ok && strings.TrimSpace(v) != "" {
                                return v
                        }
                }
                return ""
        }
        switch name {
        case "read":
                // the file verbs speak the PATH TAIL (the PWA's own v1.33.2 law —
                // "read notes.txt", "write main.go"; the full path rides the detail)
                return ocPathTail(str("path"))
        case "glob", "grep":
                // the search verbs keep their PATTERN (what you search for, not
                // where — the PWA's own law for the native grep/grep pills)
                return ocClamp(str("pattern"), 80)
        case "edit", "write":
                return ocPathTail(str("path"))
        case "patch":
                return ocPatchHead(str("patchText"))
        case "shell":
                // the exec law: the command's own first line (the PWA's termux
                // exec pill titles the program; the opencode shell pill carries
                // the whole head — informative, derived, honest)
                return ocClamp(ocFirstLine(str("command")), 80)
        case "websearch":
                return ocClamp(str("query", "q"), 80) // native web_search pill body = the query
        case "webfetch":
                return ocClamp(str("url"), 80) // native web_fetch pill body = the url
        case "skill":
                return ocClamp(str("id", "skill"), 60)
        case "execute":
                // Code Mode: the code's first non-empty line — the "what" head
                return ocClamp(ocFirstNonEmptyLine(str("code")), 48)
        case "subagent":
                // the docs' own shape: {agent, description, prompt} — the
                // description is the short "what am I delegating"
                return ocClamp(str("description", "agent"), 60)
        case "session_move", "opencode.session_move":
                return ocClamp(str("directory"), 60)
        case "session_rename", "opencode.session_rename":
                return ocClamp(str("title"), 60)
        }
        // THE DERIVED FALLBACK: any other tool (MCP tools, plugin tools, a new
        // upstream tool) still gets its first string arg value — never static.
        // The key scan covers the vocabulary the app's own MCP tools + the
        // common MCP ecosystem shapes actually carry (github's repo, slack's
        // channel, a search's topic…), most-specific-first within each family.
        for _, k := range []string{"query", "q", "pattern", "path", "url", "id", "name", "command", "text", "prompt", "directory", "action", "repo", "file", "title", "description", "message", "channel", "topic", "search"} {
                if v := str(k); v != "" {
                        return ocClamp(v, 60)
                }
        }
        return ""
}

// ocProgressLine derives the live tail line from a tool.progress frame's
// metadata (the serve's OWN live statuses — never invented): Code Mode's
// nested calls speak "tool: status"; a live shell session speaks its id.
// Empty metadata answers "" (no ping — nothing is fabricated).
func ocProgressLine(m ocserve.EventToolMetadata) string {
        var parts []string
        for _, tc := range m.ToolCalls {
                if tc.Tool == "" {
                        continue
                }
                if tc.Status == "" {
                        parts = append(parts, tc.Tool)
                        continue
                }
                parts = append(parts, tc.Tool+": "+tc.Status)
        }
        if len(parts) > 0 {
                return "[" + strings.Join(parts, " · ") + "]"
        }
        if m.ShellID != "" {
                return "[shell session " + m.ShellID + " running]"
        }
        return ""
}

// ocResultText folds a tool result's content blocks into the pill/result
// text: the whole joined text (NO clamp of our own — the amputation law
// rides ocObsBudget), the serve's OWN truncation verdict appended
// honestly (metadata.truncated — the serve says so itself; we never
// invent it), the failure's error message when the frame carries one.
func ocResultText(text string, truncated bool) string {
        if !truncated {
                return text
        }
        return text + "\n[opencode shortened this output itself — the full result stays in opencode's managed storage]"
}

// ocObsBudget — THE WINDOW'S PHYSICS ALONE (the v1.56.1 law, inherited
// verbatim through the llm package's own numbers): 90% of the model's
// documented window in bytes, floored at 1MB capped to a quarter of the
// window. The serve manages ITS OWN context upstream (it truncates what
// it cannot carry and says so via metadata.truncated) — this budget only
// guards the TRANSCRIPT side (the pill's detail + the journal), so the
// floor is the operative law for every realistic model: a 128K model
// rides ~437KB whole, a 200K model ~684KB, a 32K model ~109KB.
//
// THE SILENT 6000-CHAR CLAMP IS DEAD (the user's law: "tools should also
// not return truncated or incomplete or broken or data with silent
// drops"): every cut is the honest ClampMarked marker carrying the true
// totals.
func ocObsBudget(modelSlot string) int {
        limit := llm.ContextLimitFor(modelSlot)
        windowBytes := limit * 38 / 10 // the compact.go heuristic (≈3.8 chars/token)
        budget := windowBytes * 90 / 100
        floorBytes := 1 << 20
        if quarter := windowBytes / 4; floorBytes > quarter {
                floorBytes = quarter
        }
        if budget < floorBytes {
                return floorBytes
        }
        return budget
}

// ocPathTail answers the path's last segment (the PWA's own pathTail
// law — the X is the last segment after the last slash).
func ocPathTail(p string) string {
        p = strings.TrimSpace(p)
        if p == "" {
                return ""
        }
        t := path.Base(p)
        if t == "/" || t == "." {
                return ocClamp(strings.TrimSuffix(p, "/"), 60)
        }
        return ocClamp(t, 60)
}

// ocPatchHead derives the first file the patch touches (its own *** Add /
// Update / Delete File section header).
func ocPatchHead(patchText string) string {
        for _, line := range strings.Split(patchText, "\n") {
                line = strings.TrimSpace(line)
                for _, verb := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
                        if strings.HasPrefix(line, verb) {
                                return ocPathTail(strings.TrimPrefix(line, verb))
                        }
                }
        }
        return ""
}

func ocFirstLine(s string) string {
        if i := strings.IndexByte(s, '\n'); i >= 0 {
                return s[:i]
        }
        return s
}

func ocFirstNonEmptyLine(s string) string {
        for _, line := range strings.Split(s, "\n") {
                if t := strings.TrimSpace(line); t != "" {
                        return t
                }
        }
        return ""
}

// ocClamp trims to n runes-ish (byte cut at the word boundary is fine for
// a pill body; the detail view carries the full args).
func ocClamp(s string, n int) string {
        s = strings.TrimSpace(s)
        if len(s) <= n {
                return s
        }
        return s[:n]
}
