// Package mcpbus — v1.13.1 THE BUS (PLAN-V113 §1).
//
// The mark3labs/mcp-go based tool bus that replaces the ACTION protocol
// as the engine's tool system. One MCPServer ("doomalay-tools") hosts
// every tool with a real JSON Schema; the chat loop executes tools
// through an in-process MCP client (client.NewInProcessClient — no
// network, no subprocess, Android-safe; the caller's ctx values flow
// straight into tool handlers).
//
// Layering (import direction, never a cycle):
//
//	llm ──calls──▶ mcpbus (schemas + MCP protocol + hooks + dispatch)
//	llm ◀─bridges── Turn closures (RunLocal / Search / Persona / …)
//
// mcpbus knows NOTHING about llm types: the Turn carries function
// fields the llm package wires per chat turn, and llm.ArtifactSink
// satisfies mcpbus.ArtifactSink structurally.
package mcpbus

// PropKind is the JSON type of one tool argument.
type PropKind string

const (
	PropString  PropKind = "string"
	PropNumber  PropKind = "number"
	PropBoolean PropKind = "boolean"
	PropArray   PropKind = "array"
	// PropObject — v1.74.2 THE SCHEMA HONESTY (PLAN-V174 §2): a prop
	// whose true shape is a JSON object (termux's args). Declaring it a
	// string invited schema-literal clients to hand-write the object as
	// escaped text — the exact fumble the argrepair ladder absorbed.
	PropObject PropKind = "object"
)

// Prop describes one tool argument.
type Prop struct {
	Kind     PropKind
	Desc     string
	Enum     []string
	Required bool
}

// Gate names the per-turn capability that arms a tool. "" = always on.
// The gate mirrors the ChatRequest closure the llm side wires into the
// Turn; Specs() filters the manifest exactly like the old
// nativeToolSpecs did.
type Gate string

const (
	GateNone      Gate = ""
	GateHublib    Gate = "hublib"
	GateSkills    Gate = "skills"
	GatePersona   Gate = "persona"
	GateWorkspace Gate = "workspace"
	GateTermux    Gate = "termux"
	GateDelegate  Gate = "delegate"
	// GateTemplate — v1.70.1 THE TRUTHFUL MANIFEST (the campaign's
	// conviction): template_list/template_show were ALWAYS advertised in
	// the manifest but the closure refused whenever the chat's template
	// pill was off — a tool the model can see and never use. The gate
	// arms them exactly when the pill is on; the closure's honest
	// refusal stays as the belt for calls remembered from earlier turns.
	GateTemplate Gate = "template"
)

// Def is the single source of truth for one tool: it builds BOTH the
// MCP registration (mcp.NewTool → JSON Schema → tools/list) and the
// OpenAI-style tools[] manifest entry (the wire shape twelve-plus
// providers already speak). This kills the dual manifest — protocol
// prose in composeTurnSystem + jsonSchemaProp maps in nativeToolSpecs —
// exactly the redundancy the ACTION wave accumulated.
type Def struct {
	Name  string
	Desc  string
	Props []PropDef
	Gate  Gate
}

// PropDef is one ordered (key, prop) pair.
type PropDef struct {
	Key  string
	Prop Prop
}

func prop(key, desc string, kind PropKind, required bool, enum ...string) PropDef {
	return PropDef{Key: key, Prop: Prop{Kind: kind, Desc: desc, Enum: enum, Required: required}}
}

func str(key, desc string, required bool) PropDef {
	return prop(key, desc, PropString, required)
}

// defs is the full tool registry — 31 tools: the 29 ported VERBATIM from
// nativeToolSpecs (descriptions + props + required + gating) so the
// model-visible manifest is byte-identical to the proven one (v1.20.3
// THE ARM adds the gated termux hand).
var defs = []Def{
	// ── local compute ───────────────────────────────────────────────
	{Name: "calculator", Desc: "Evaluate a math expression and return the result.", Props: []PropDef{
		str("expr", "The expression to evaluate, e.g. '2+2*10'.", true),
	}},
	{Name: "time_now", Desc: "Current date/time (optionally in a named IANA timezone).", Props: []PropDef{
		str("tz", "IANA timezone like 'UTC' or 'Asia/Beirut'. Empty = local.", false),
	}},
	{Name: "uuid", Desc: "Generate UUIDs.", Props: []PropDef{
		prop("count", "How many UUIDs (default 1).", PropNumber, false),
	}},
	{Name: "random", Desc: "Random integers.", Props: []PropDef{
		prop("min", "Inclusive minimum.", PropNumber, false),
		prop("max", "Inclusive maximum.", PropNumber, false),
		prop("count", "How many (default 1).", PropNumber, false),
		prop("unique", "Distinct values only.", PropBoolean, false),
	}},
	{Name: "base64", Desc: "Base64 encode/decode text.", Props: []PropDef{
		prop("mode", "'encode' or 'decode'.", PropString, false, "encode", "decode"),
		str("text", "The input text.", true),
	}},
	{Name: "url_encode", Desc: "URL percent-encode/decode text.", Props: []PropDef{
		prop("mode", "'encode' or 'decode'.", PropString, false, "encode", "decode"),
		str("text", "The input text.", true),
	}},
	{Name: "hash", Desc: "Hash text (md5, sha1, sha256, sha512).", Props: []PropDef{
		prop("algo", "Algorithm.", PropString, true, "md5", "sha1", "sha256", "sha512"),
		str("text", "The input text.", true),
	}},
	{Name: "json_tool", Desc: "Validate/pretty/minify JSON text.", Props: []PropDef{
		prop("mode", "'pretty', 'minify' or 'validate'.", PropString, false, "pretty", "minify", "validate"),
		str("text", "The JSON text.", true),
	}},
	{Name: "text_stats", Desc: "Statistics about text (words, chars, lines…).", Props: []PropDef{
		str("text", "The input text.", true),
	}},
	{Name: "regex_extract", Desc: "Extract regex matches from text — ALL matches by default (a limit is honest: the count says how many exist and how many were shown).", Props: []PropDef{
		str("pattern", "The regular expression.", true),
		str("text", "The text to search.", true),
		prop("group", "Capture group to return (0 = whole match).", PropNumber, false),
		prop("limit", "Max matches to show (0 = ALL — the default).", PropNumber, false),
	}},
	// ── file tools (the artifact producers) ─────────────────────────
	{Name: "docx_create", Desc: "Create a .docx document from structured blocks and save it as a downloadable artifact.", Props: []PropDef{
		str("name", "File name, e.g. 'report.docx'.", true),
		prop("blocks", "Ordered blocks: {\"type\":\"heading|paragraph|bullet\",\"text\":\"…\"}.", PropArray, true),
	}},
	{Name: "xlsx_create", Desc: "Create a .xlsx spreadsheet and save it as a downloadable artifact.", Props: []PropDef{
		str("name", "File name, e.g. 'data.xlsx'.", true),
		prop("sheets", "Sheets: {\"name\":\"…\",\"rows\":[[cell,…],…]}.", PropArray, true),
	}},
	{Name: "zip_create", Desc: "Create a .zip archive from files (each {name, content}) and save it as a downloadable artifact.", Props: []PropDef{
		str("name", "Archive file name, e.g. 'exercise.zip'.", true),
		prop("files", "Files: [{\"name\":\"path/file.txt\",\"content\":\"text content\"}]. Content is plain text (UTF-8).", PropArray, true),
	}},
	{Name: "zip_extract", Desc: "List or extract a .zip artifact (pass the artifact name).", Props: []PropDef{
		str("artifact", "Name of a saved .zip artifact to open.", false),
		str("b64", "OR base64 zip bytes directly.", false),
	}},
	{Name: "archive_create", Desc: "Create an archive (.zip/.tar.gz/.7z…) from files and save it as a downloadable artifact.", Props: []PropDef{
		str("name", "Archive file name with extension.", true),
		prop("files", "Files: [{\"name\":\"path\",\"content\":\"text\"}] or {\"name\":\"…\",\"b64\":\"…\"}.", PropArray, false),
	}},
	{Name: "archive_extract", Desc: "Extract any archive artifact (zip/7z/rar/tar/gz…).", Props: []PropDef{
		str("artifact", "Name of a saved archive artifact.", false),
		str("b64", "OR base64 archive bytes.", false),
	}},
	// ── web tools (always armed — the v0.44 self-enable spec) ───────
	{Name: "web_search", Desc: "Search the live web and return ranked results (titles, URLs, snippets).", Props: []PropDef{
		str("query", "The search query.", true),
	}},
	{Name: "web_fetch", Desc: "Fetch a web page and return its readable text content.", Props: []PropDef{
		str("url", "The absolute https:// URL.", true),
	}},
	// ── the method-template library ─────────────────────────────────
	{Name: "template_list", Gate: GateTemplate, Desc: "List the app's method-template library (ids, names, stage counts).", Props: nil},
	{Name: "template_show", Gate: GateTemplate, Desc: "Show one method template's full methodology (stages with instructions, or the markdown discipline).", Props: []PropDef{
		str("id", "The template id from template_list.", true),
	}},
	// ── the public hub library (gated on the Hublib closure) ────────
	{Name: "hublib", Gate: GateHublib,
		Desc: "Search/browse/download the PUBLIC HUB — the community library of templates, skills, scripts, docs, personas, themes (every single item is a bundle of one) AND BUNDLES (curated collections). Bundle detail lists every member's when-to-use description; browse before using, pick the member that fits, never the whole bundle at once.",
		Props: []PropDef{
			prop("action", "'bundles' (list collections, narrow with q/tag), 'bundle' (one bundle's members + when-to-use descriptions), 'download_bundle' (download every member), 'search' (browse items), 'get' (one item's detail + payload head) or 'download'.", PropString, true, "bundles", "bundle", "download_bundle", "search", "get", "download"),
			str("q", "Search query (search/bundles; empty = newest).", false),
			str("tag", "Badge tag filter (bundles only).", false),
			prop("type", "Library type.", PropString, false, "template", "skill", "script", "doc", "persona", "theme"),
			str("repo", "The item's repo (get/download, from a search result).", false),
			str("id", "The item's or bundle's id (get/download/download_bundle/bundle, from a result).", false),
		}},
	// ── the installed skills library (gated on the Skills closure) ──
	{Name: "skills", Gate: GateSkills,
		Desc: "The installed SKILLS LIBRARY — downloadable methodologies (e.g. superpowers). bootstrap loads the selection discipline; load arms one skill's full methodology to FOLLOW for the work it covers; descriptions state when each fires.",
		Props: []PropDef{
			prop("action", "'bootstrap' (the skill discipline), 'list', 'search', 'load' (arm + follow a skill), 'files' or 'read'.", PropString, true, "bootstrap", "list", "search", "load", "files", "read"),
			str("skill", "The skill name (load/files/read; from list/search).", false),
			str("q", "Search query (search only).", false),
			str("path", "Companion file path (files/read only).", false),
		}},
	// ── the persona hand (gated on the Persona closure) ─────────────
	{Name: "persona_list", Gate: GatePersona,
		Desc: "List YOUR personas and placeholders in this chat (id, name, mode, preview) — includes the hub personas you could import.", Props: nil},
	{Name: "persona_set", Gate: GatePersona,
		Desc: "Create, edit or import a persona. Omit id to create; {\"from\": \"<hub persona name>\", \"activate\": true} imports a DOWNLOADED library persona and makes it the active one (you become it); activate:true makes any target the one always-active persona.",
		Props: []PropDef{
			str("id", "An existing persona id (edit).", false),
			str("name", "The persona's name.", false),
			str("text", "The persona's system-prompt text.", false),
			str("from", "Import a hub persona you downloaded (its name or id) instead of inline text.", false),
			prop("activate", "Make it the always-active persona.", PropBoolean, false),
		}},
	{Name: "persona_activate", Gate: GatePersona,
		Desc: "Become a listed persona (deactivates the previous one); {\"id\": \"\"} deactivates all (back to the app default).",
		Props: []PropDef{
			str("id", "The persona id from persona_list (empty deactivates all).", false),
		}},
	{Name: "placeholder_set", Gate: GatePersona,
		Desc: "Set a {placeholder} usable in personas and triggers.",
		Props: []PropDef{
			str("key", "The placeholder name.", true),
			str("value", "The placeholder value.", true),
		}},
	// ── the workspace hand (gated on the Workspace closure) ─────────
	{Name: "workspace", Gate: GateWorkspace,
		Desc: "Act on this chat's CONNECTED cloud repos (the CONNECTED CLOUD WORKSPACES block lists them): browse (tree/ls/read/grep/readme), inspect history/issues/PRs/discussions/releases/Tags/Actions (view), WRITE (put = an API commit, full access; pr opens a pull request; tag_create cuts a tag; fork), create a repo, or discover the account's repos. Use it whenever the user asks about their connected repo — its code, history, issues, PRs, or wants a change pushed. THE GREP IS A REAL GREP: the pattern is a REGEX by default ('foo|bar', 'func\\(\\w+'), EVERY hit in every file is reported (not one per file), and it takes include/exclude globs, context lines (context/before/after), case_sensitive, word, invert, count and files_only. Nothing is truncated silently — when a ceiling bites, the result says so.",
		Props: []PropDef{
			// v1.61.1 THE SCHEMA TRUTH (PLAN-V161 Class E): the enum teaches ALL
			// THIRTY verbs (the old 14-verb list starved the models that read
			// the manifest literally — patch/commit/sync/branch/issue*/pr_*/
			// discussion/workflow/file_delete/release never existed to them).
			prop("action", "The verb: 'help', 'list' (the connected repos), 'info', 'tree', 'ls', 'read', 'readme', 'grep', 'view' (issues/pulls/commits/branches/releases/tags/workflows/runs/discussions), 'put' (an API commit of a full file), 'patch' (SURGICAL search/replace edits on one file), 'commit' (MULTIPLE files in ONE atomic commit), 'sync' (check whether the branch is behind), 'pr', 'pr_diff', 'pr_comment', 'pr_review', 'pr_merge', 'branch', 'issue_create', 'issue_comment', 'issue_close', 'discussion_post', 'workflow_dispatch', 'file_delete', 'tag_create', 'release_create', 'fork', 'create' or 'discover'.", PropString, true, "help", "list", "info", "tree", "ls", "read", "readme", "grep", "view", "put", "patch", "commit", "sync", "pr", "pr_diff", "pr_comment", "pr_review", "pr_merge", "branch", "issue_create", "issue_comment", "issue_close", "discussion_post", "workflow_dispatch", "file_delete", "tag_create", "release_create", "fork", "create", "discover"),
			str("ws", "The repo: id, owner/repo or the bare repo name (from the CONNECTED block or list).", false),
			str("path", "File/subdirectory path (tree/ls/read/put).", false),
			str("ref", "Branch/tag/sha override (defaults to the repo branch).", false),
			str("range", "Read slice: head:80 | tail:40 | lines:10-60 — the answer's head echoes exactly which lines you got.", false),
			prop("line_numbers", "Read: number the lines cat -n style (anchors for surgical edits; on by default for ranged reads).", PropBoolean, false),
			str("query", "Grep PATTERN (a REGEX by default — 'foo|bar', 'func\\(\\w+', 'TODO:').", false),
			prop("fixed", "Treat the grep pattern as a LITERAL (no regex).", PropBoolean, false),
			prop("case_sensitive", "Case-sensitive matching (default: case-insensitive).", PropBoolean, false),
			prop("word", "Whole-word match (\\b).", PropBoolean, false),
			prop("invert", "Report the NON-matching lines (grep -v).", PropBoolean, false),
			str("include", "Glob filter: '*.go', 'docs/**' (a JSON array or a comma-separated list).", false),
			str("exclude", "Glob to exclude: 'vendor/**', '*.lock'.", false),
			prop("context", "Context lines around each hit (-C).", PropNumber, false),
			prop("before", "Context lines before each hit (-B).", PropNumber, false),
			prop("after", "Context lines after each hit (-A).", PropNumber, false),
			prop("limit", "Max hits (0 = ALL hits — the default; no silent cap).", PropNumber, false),
			prop("max_per_file", "Max hits per file (0 = all).", PropNumber, false),
			prop("count", "Report the hit COUNT per file instead of the lines (grep -c).", PropBoolean, false),
			prop("files_only", "Report only the FILES that contain a hit (grep -l).", PropBoolean, false),
			prop("summary", "Tree only: the directory-summary shape instead of the full listing.", PropBoolean, false),
			prop("what", "View subject (view only).", PropString, false, "issues", "pulls", "commits", "branches", "releases", "tags", "workflows", "runs", "discussions"),
			prop("state", "Filter state for issues/pulls (view only).", PropString, false, "open", "closed", "all"),
			str("content", "Full new file text (put only).", false),
			str("message", "Commit message (put; tag_create: the annotation text).", false),
			str("sha", "Target commit sha (tag_create; from view commits or the branch head).", false),
			str("branch", "Target branch (put; a NEW branch is created from HEAD — then pr it).", false),
			str("head", "PR source branch (pr only; owner:branch for forks).", false),
			str("base", "PR target branch (pr only; default the repo branch).", false),
			str("title", "PR title (pr only).", false),
			str("body", "PR description (pr only).", false),
			str("name", "New repo name (create only).", false),
			// v1.61.1 THE SCHEMA TRUTH: the props the verbs actually read (the
			// old manifest omitted ~20 of them — the models guessed shapes the
			// verbs then rejected; the Def now teaches the same grammar the
			// verbs parse).
			// v1.74.2 THE SCHEMA HONESTY: edits IS an array (the old PropString
			// declaration made schema-literal MCP clients send a STRING and
			// eat a teach-retry on every patch — the audit's conviction 3).
			prop("edits", "patch: the surgical edit list — [{\"old\":\"exact text\",\"new\":\"replacement\",\"all\":false?,\"occurrence\":1?}] (also commit's per-file edits). The edits that match land; any that miss get the file's actual lines back — fix and re-send ONLY the failed ones.", PropArray, false),
			prop("files", "commit: the changeset — [{\"path\":\"a.go\",\"edits\":[…]} | {\"path\":\"new.txt\",\"content\":\"…\"} | {\"path\":\"old.go\",\"delete\":true} | {\"path\":\"moved.go\",\"rename_from\":\"old.go\"}].", PropArray, false),
			prop("dry_run", "patch: preview the diff without committing (true) or commit (false/omitted).", PropBoolean, false),
			prop("labels", "issue_create: label list (strings or a comma-separated list).", PropArray, false),
			prop("number", "The issue/PR number (issue_comment, issue_close, pr_diff, pr_comment, pr_review, pr_merge).", PropNumber, false),
			str("event", "pr_review verdict: 'approve' | 'request_changes' | 'comment'.", false),
			str("method", "pr_merge strategy: 'merge' | 'squash' | 'rebase'.", false),
			str("category", "discussion_post: the category (Q&A | ...).", false),
			str("workflow", "workflow_dispatch: the workflow file (ci.yml).", false),
			str("inputs", "workflow_dispatch: the dispatch inputs map as a JSON object string ({\"key\":\"value\"}).", false),
			str("target", "release_create: the commitish target (blank = the branch head).", false),
			str("description", "create: the repo description.", false),
			str("license", "create: 'mit' | 'apache-2.0' | '' ...", false),
			str("gitignore", "create: the gitignore template name or ''.", false),
			str("from", "branch: the base ref (blank = the repo's default).", false),
			prop("kind", "Forge (create/discover only).", PropString, false, "github", "gitea", "gitlab"),
			prop("private", "Create private (create only).", PropBoolean, false),
		}},
	// ── the Termux hand (gated on the Termux closure) ────────────────
	// v1.20.3 THE ARM (PLAN-V120 §v1.20.3): a real Termux Linux shell on
	// the user's device, jailed to the chat's bound device folders — the
	// one-tool/verb-map shape the workspace tool proved.
	// v1.21.1 THE ARMED HAND: the Desc teaches the whole-userland truth
	// (any command in $PATH + every pkg-installed package's commands) and
	// the cmds inventory — this text IS the manifest the PM browser loop
	// and every native-tools model sees.
	{Name: "termux", Gate: GateTermux,
		Desc: "A real Termux Linux shell on the user's device — the whole Linux userland: exec runs ANY command in $PATH (coreutils, findutils, grep/sed/awk, bash, python, git, ssh, curl…), pkg installs any package and its commands go live instantly, cmds inventories every available command, and git_setup arms the vault's GitHub token in Termux (one call: ~/.git-credentials + credential.helper=store — then git clone/push just work, no credentials in any command). Actions: exec (run ANY shell command), cmds (inventory all commands), git_setup, ls, read, write, append, rm, mkdir, grep, find, pkg (install/update/remove packages), session_start/session_list/session_log/session_kill (create and kill background processes, e.g. python servers, with tailable logs) and help. The FILE verbs (ls/read/write/append/rm/mkdir/grep/find) are jailed to this chat's bound device (termux) workspace folders — paths outside them are refused; exec runs any command from the first bound folder as workdir (cd $HOME works — that's where git repos live). exec budget: 10 minutes by default, 30 minutes max (pass timeout_ms); anything longer runs as a background session (session_start, no budget). Compiled binaries only execute from $HOME — the bound folders are FUSE noexec (cp the binary to $HOME and chmod 755 first). Output is FULL; the only cap is Termux's own 100KB result bundle, honestly reported when hit. Use it whenever the user asks about their device's files or wants anything run, installed, compiled or served on the phone.",
		Props: []PropDef{
			prop("action", "'exec' (run ANY shell command), 'cmds' (inventory every available command), 'git_setup' (arm the vault's GitHub token — git push works after one call), 'ls', 'read', 'write', 'append', 'patch' (SURGICAL search/replace edits on one local file: read a range first, then patch — no whole-file rewrite), 'rm', 'mkdir', 'grep', 'find', 'pkg' (install|update|remove), 'session_start', 'session_list', 'session_log', 'session_kill' or 'help'.", PropString, true, "exec", "cmds", "git_setup", "ls", "read", "write", "append", "patch", "rm", "mkdir", "grep", "find", "pkg", "session_start", "session_list", "session_log", "session_kill", "help"),
			// v1.74.2 THE SCHEMA HONESTY: args is an OBJECT (the old
			// string declaration invited the escaped-text fumble; the text
			// form stays accepted by the parser).
			prop("args", `JSON object of the action's arguments, e.g. {"path":"notes.txt","command":"python -V","content":"…","pattern":"TODO","range":"head:80","edits":[…],"name":"myserver","op":"install","packages":["python"]} — an object is the natural shape; the same object as TEXT is also accepted. read takes "range" (head:80 | tail:40 | lines:10-60) like the workspace read.`, PropObject, true),
		}},
	// ── the personal journal (always armed — the app-global diary) ──
	// v1.47.1 THE JOURNAL HAND (PLAN-V147 §1): the authentic port of
	// brain/tools/dt_journal.py — moods, tags, highlights, gratitude,
	// energy, streaks, reviews, rotating prompts. ONE journal per
	// install (<DataDir>/journal/entries.jsonl, append-only).
	{Name: "djournal",
		Desc: "Rich personal journal: moods, tags, daily highlights, gratitude, energy, streaks, and rotating journaling prompts. Use whenever the user wants to record or reflect on their day, search past entries, or review their week or month (mood trend, top tags, highlights). Actions: write, read, search, review, moods, prompt, export, help.",
		Props: []PropDef{
			prop("action", "The verb — call action='help' for the full cheat-sheet.", PropString, true, "write", "read", "search", "review", "moods", "prompt", "export", "help"),
			str("text", "Entry body (write; required).", false),
			str("date", "ISO date for the entry (write), or the day to read (read).", false),
			str("mood", "1-5, word (great/good/ok/low/awful), or emoji (write; search filter).", false),
			str("tags", "Comma- or newline-separated tags (write).", false),
			str("highlights", "Comma- or newline-separated wins of the day (write).", false),
			str("gratitude", "Comma- or newline-separated gratitude items (write).", false),
			str("energy", "1-5 energy level (write).", false),
			str("query", "The text to search for (search).", false),
			str("in_field", "text|tags|highlights|gratitude|all (search, default all).", false),
			str("date_range", "'2026-06-01..2026-06-30' or 'last 7' (search, moods, export).", false),
			str("period", "week|month|'last N days' (review, default week).", false),
			str("target", "date|today|yesterday|'A..B'|'last N' (read).", false),
			str("format", "md|json (export).", false),
		}},
	// ── the fleet roster (always armed — the engine's own truth) ────
	// v1.47.2 THE FLEET HAND (PLAN-V147 §2): check the OTHER chatbots —
	// the roster (name/model · canvas · live state · last activity) and
	// one bot's full detail (identity, capabilities, current actions,
	// progress). The A2A-agent-card grammar over the engine's tables.
	{Name: "fleet",
		Desc: "Check the OTHER chatbots on this engine — who is active, where they live (which canvas), what they are, and what they are doing right now. roster lists every chat: title, provider/model, canvas, live state (running/idle), last activity, turns; q filters by title/model/provider/canvas. detail expands ONE chat's full card: identity (persona, effort, mode, template), armed capabilities, the CURRENT action (the live events tail — what it is doing right now) and progress (turns, tokens, cost, last activity). Use it whenever the user asks about their other chats or wants a status board.",
		Props: []PropDef{
			prop("action", "'roster' (the list; default) or 'detail' (one bot's full card + current actions).", PropString, false, "roster", "detail", "help"),
			str("q", "Roster filter: case-insensitive substring on title/model/provider/canvas.", false),
			str("target", "The chat to detail: its id, or a title prefix (also matched case-insensitively).", false),
		}},
	// ── the swarm delegate (gated on the Delegate closure) ──────────
	{Name: "delegate", Gate: GateDelegate,
		Desc: "Consult up to 3 other models in parallel and get their answers.",
		Props: []PropDef{
			str("prompt", "The question to ask the other models.", true),
			prop("models", "Optional provider/model ids to consult.", PropArray, false),
		}},
	// ── v1.73.2 THE JOB LAYER (PLAN-V173 §v1.73.2): the lane trio ──
	// Always-on (GateNone) — the model's handle on its own background
	// lanes. These NEVER wrap in the grace window (self-reference).
	{Name: "job_status",
		Desc: "Check one background job (a tool call that outlived its grace window and moved to its own lane instead of blocking the chat). Returns RUNNING (with the honest elapsed) or the terminal result (completed/failed/cancelled). You do NOT need to poll — completions land in the chat automatically — but this checks on demand.",
		Props: []PropDef{
			str("id", "The job id from the JOB_STARTED ticket (j_…).", true),
		}},
	{Name: "job_kill",
		Desc: "Stop one background job. The stop is best-effort: it kills the lane's context (work that honors cancellation aborts), but work already in flight may still finish quietly — you will not hear from it again. A cancelled job stays cancelled.",
		Props: []PropDef{
			str("id", "The job id from the JOB_STARTED ticket (j_…).", true),
		}},
	{Name: "job_list",
		Desc:  "List this chat's background jobs — every lane, working or terminal, newest first (the ids for job_status/job_kill).",
		Props: []PropDef{}},
}

// Defs returns the registry (read-only by convention).
func Defs() []Def { return defs }

// defByName looks a Def up by exact tool name.
func defByName(name string) *Def {
	for i := range defs {
		if defs[i].Name == name {
			return &defs[i]
		}
	}
	return nil
}
