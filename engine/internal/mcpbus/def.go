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

// defs is the full tool registry — 29 tools, ported VERBATIM from
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
	{Name: "regex_extract", Desc: "Extract regex matches from text.", Props: []PropDef{
		str("pattern", "The regular expression.", true),
		str("text", "The text to search.", true),
		prop("group", "Capture group to return (0 = whole match).", PropNumber, false),
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
	{Name: "template_list", Desc: "List the app's method-template library (ids, names, stage counts).", Props: nil},
	{Name: "template_show", Desc: "Show one method template's full methodology (stages with instructions, or the markdown discipline).", Props: []PropDef{
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
		Desc: "Act on this chat's CONNECTED cloud repos (the CONNECTED CLOUD WORKSPACES block lists them): browse (tree/ls/read/grep/readme), inspect history/issues/PRs/discussions/releases/Actions (view), WRITE (put = an API commit, full access; pr opens a pull request; fork), create a repo, or discover the account's repos. Use it whenever the user asks about their connected repo — its code, history, issues, PRs, or wants a change pushed.",
		Props: []PropDef{
			prop("action", "'list' (the connected repos), 'info', 'tree', 'ls', 'read', 'readme', 'grep', 'view', 'put', 'pr', 'fork', 'create' or 'discover'.", PropString, true, "list", "info", "tree", "ls", "read", "readme", "grep", "view", "put", "pr", "fork", "create", "discover"),
			str("ws", "The repo: id, owner/repo or the bare repo name (from the CONNECTED block or list).", false),
			str("path", "File/subdirectory path (tree/ls/read/put).", false),
			str("ref", "Branch/tag/sha override (defaults to the repo branch).", false),
			str("range", "Read slice: head:80 | tail:40 | lines:10-60.", false),
			str("query", "Grep search text.", false),
			prop("what", "View subject (view only).", PropString, false, "issues", "pulls", "commits", "branches", "releases", "workflows", "runs", "discussions"),
			prop("state", "Filter state for issues/pulls (view only).", PropString, false, "open", "closed", "all"),
			str("content", "Full new file text (put only).", false),
			str("message", "Commit message (put only; default auto).", false),
			str("branch", "Target branch (put; a NEW branch is created from HEAD — then pr it).", false),
			str("head", "PR source branch (pr only; owner:branch for forks).", false),
			str("base", "PR target branch (pr only; default the repo branch).", false),
			str("title", "PR title (pr only).", false),
			str("body", "PR description (pr only).", false),
			str("name", "New repo name (create only).", false),
			prop("kind", "Forge (create/discover only).", PropString, false, "github", "gitea", "gitlab"),
			prop("private", "Create private (create only).", PropBoolean, false),
		}},
	// ── the Termux hand (gated on the Termux closure) ────────────────
	// v1.20.3 THE ARM (PLAN-V120 §v1.20.3): a real Termux Linux shell on
	// the user's device, jailed to the chat's bound device folders — the
	// one-tool/verb-map shape the workspace tool proved.
	{Name: "termux", Gate: GateTermux,
		Desc: "A real Termux Linux shell on the user's device. Actions: exec (run a shell command), ls, read, write, append, rm, mkdir, grep, find, pkg (install/update/remove packages), session_start/session_list/session_log/session_kill (create and kill background processes, e.g. python servers, with tailable logs) and help. Jailed to this chat's bound device (termux) workspace folders — paths outside them are refused, never executed. Output is FULL; the only cap is Termux's own 100KB result bundle, honestly reported when hit. Use it whenever the user asks about their device's files or wants something run, installed or served on the phone.",
		Props: []PropDef{
			prop("action", "'exec' (run a shell command), 'ls', 'read', 'write', 'append', 'rm', 'mkdir', 'grep', 'find', 'pkg' (install|update|remove), 'session_start', 'session_list', 'session_log', 'session_kill' or 'help'.", PropString, true, "exec", "ls", "read", "write", "append", "rm", "mkdir", "grep", "find", "pkg", "session_start", "session_list", "session_log", "session_kill", "help"),
			str("args", `JSON object of the action's arguments, e.g. {"path":"notes.txt","command":"python -V","content":"…","pattern":"TODO","name":"myserver","op":"install","packages":["python"]}.`, true),
		}},
	// ── the swarm delegate (gated on the Delegate closure) ──────────
	{Name: "delegate", Gate: GateDelegate,
		Desc: "Consult up to 3 other models in parallel and get their answers.",
		Props: []PropDef{
			str("prompt", "The question to ask the other models.", true),
			prop("models", "Optional provider/model ids to consult.", PropArray, false),
		}},
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
