// Package hub is the v0.31 modular library system: one library per item
// type (personas, templates, …), backed by per-user-per-type Hugging Face
// dataset repos discovered via dataset tags, with a local SQLite store for
// downloads + hearts.
//
// The registry (this file) is the ONLY place a library type is declared:
// registering a new library (e.g. "icons") is one Register call — zero
// changes anywhere else. Package init registers the built-ins.
package hub

import (
        "fmt"
        "sort"
        "sync"
)

// LibrarySpec declares one hub library (one item type).
type LibrarySpec struct {
        Type       string `json:"type"`        // "persona" | "template" | …
        Label      string `json:"label"`       // human label ("Persona Library")
        Tag        string `json:"tag"`         // HF dataset tag that marks repos of this type
        PayloadExt string `json:"payload_ext"` // payload file extension (".md", ".json")
        Desc       string `json:"desc"`        // one-line description for UIs
        // RepoSuffix overrides the repo-name pluralization ("" = the
        // Type+"s" default). v1.54: "canvas" would otherwise birth
        // "doomalay-canvass" (the double-s foot-gun) — canvases ride
        // "doomalay-canvases" instead.
        RepoSuffix string `json:"repo_suffix,omitempty"`
        // Hidden libraries never appear in the /api/hub/libraries response (no
        // browsable tab in the panel) but stay fully REGISTERED — bundle member
        // sections, one-press downloads, item serving and repo-file routes all
        // iterate All()/CollectionItems and keep working. v0.63 (user spec:
        // "docs are a hidden format we support to help users and the bot when
        // using a library — not a browsable, downloadable category").
        Hidden bool `json:"hidden,omitempty"`
}

// RepoName returns the per-user HF dataset repo name for this library
// ("<user>/doomalay-personas", "<user>/doomalay-templates", …).
func (s LibrarySpec) RepoName() string {
        suffix := s.RepoSuffix
        if suffix == "" {
                suffix = s.Type + "s"
        }
        return "doomalay-" + suffix
}

// Payload max bytes, ONE truth per payload class (v1.54 — the old
// server-side 64KB/24MB-theme special case moved here so the canvas and
// chat tiers live beside the registry, not in an HTTP handler's if-chain).
const (
        // payloadMaxDefault matches every text type (a persona .md, a
        // template .json — the historical 64KB cap).
        payloadMaxDefault = 64 << 10
        // payloadMaxTheme: a THEME payload is a full look bundle with photo
        // dataURLs (the v0.52 precedent — lookio.js: 24MB).
        payloadMaxTheme = 24 << 20
        // payloadMaxCanvas: a .doomcanvas rides the SAME ceiling the import
        // ladder enforces (canvasbundle.js TOTAL_MAX = 96MB) — PLAN-V142
        // §3.6: "total ≤ 96 MB via LFS".
        payloadMaxCanvas = 96 << 20
        // payloadMaxChat: a .doomchat is one session (history folds at 8MB)
        // + its assets (≤24MB) + the manifest — 40MB with headroom.
        payloadMaxChat = 40 << 20
)

// PayloadMaxBytes returns the publish/download payload cap for a library.
func (s LibrarySpec) PayloadMaxBytes() int {
        switch s.Type {
        case "theme":
                return payloadMaxTheme
        case "canvas":
                return payloadMaxCanvas
        case "chat":
                return payloadMaxChat
        }
        return payloadMaxDefault
}

// BigPayload reports whether this library's payloads ride the binary
// transport (multipart publish + the streaming payload route + the
// payload-bypass local store). v1.54: canvas and chat — theme keeps the
// base64-in-JSON path it has always ridden (its payloads are look-JSON
// text with embedded dataURLs, published through the plain form).
func (s LibrarySpec) BigPayload() bool {
        return s.Type == "canvas" || s.Type == "chat"
}

// LFSExts lists the payload extensions this library's repo must track via
// Git LFS (HF rejects non-LFS files >10MB; custom extensions like
// .doomcanvas are NOT in HF's default .gitattributes patterns — the repo
// needs an explicit `*<ext> filter=lfs` line or a large payload commit
// dies at the 10MB wall). ensureRepo seeds these on first big publish.
func LFSExts() []string { return []string{".doomcanvas", ".doomchat", ".doomtheme"} }

// registry is the process-wide library table.
var registry = struct {
        sync.Mutex
        byType map[string]LibrarySpec
}{byType: map[string]LibrarySpec{}}

// Register adds a library type (idempotent: a later registration for an
// existing type wins, which keeps tests hermetic).
func Register(spec LibrarySpec) {
        registry.Lock()
        defer registry.Unlock()
        registry.byType[spec.Type] = spec
}

// All returns every registered library, sorted by type for stable output.
func All() []LibrarySpec {
        registry.Lock()
        defer registry.Unlock()
        out := make([]LibrarySpec, 0, len(registry.byType))
        for _, spec := range registry.byType {
                out = append(out, spec)
        }
        sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
        return out
}

// Get returns the spec for a library type, or an error naming the valid ones.
func Get(typ string) (LibrarySpec, error) {
        registry.Lock()
        defer registry.Unlock()
        if spec, ok := registry.byType[typ]; ok {
                return spec, nil
        }
        valids := make([]string, 0, len(registry.byType))
        for t := range registry.byType {
                valids = append(valids, t)
        }
        sort.Strings(valids)
        return LibrarySpec{}, fmt.Errorf("unknown hub library %q (registered: %v)", typ, valids)
}

func init() {
        // The built-in libraries. Adding "icons" later is one more line here.
        Register(LibrarySpec{
                Type:       "persona",
                Label:      "Persona Library",
                Tag:        "doomalay-persona",
                PayloadExt: ".md",
                Desc:       "Personas shared through Hugging Face datasets",
        })
        Register(LibrarySpec{
                Type:       "template",
                Label:      "Template Library",
                Tag:        "doomalay-template",
                PayloadExt: ".json",
                Desc:       "Prompt templates shared through Hugging Face datasets",
        })
        // v0.48: the superpowers corpus (and any agentskills.io-style
        // dataset) carries SKILL.md methodologies alongside its templates —
        // they get their own library so both show up in the hub.
        Register(LibrarySpec{
                Type:       "skill",
                Label:      "Skill Library",
                Tag:        "doomalay-skill",
                PayloadExt: ".md",
                Desc:       "Agent skills shared through Hugging Face datasets",
        })
        // v0.52: THEMES — full look bundles (.doomtheme, the lookio.js
        // format). A global bundle repaints the whole app on download;
        // a chat bundle lands in the open chatbot. Payloads carry photos
        // + bump maps as dataURLs, so the publish caps are type-raised
        // (see server/hub.go).
        Register(LibrarySpec{
                Type:       "theme",
                Label:      "Theme Library",
                Tag:        "doomalay-theme",
                PayloadExt: ".doomtheme",
                Desc:       "Full look bundles — global themes and single-chat looks",
        })
        // v0.60 pt C.5: SCRIPTS + DOCS — the superpowers port's repo
        // companions. A script is a runnable .sh payload (browsed, read,
        // bundled — invoked through interpreters per the porting guide);
        // a doc is a markdown payload (the port's guides/journals —
        // bundled inside collections, no standalone browsing semantics
        // beyond the detail view's markdown render).
        Register(LibrarySpec{
                Type:       "script",
                Label:      "Script Library",
                Tag:        "doomalay-script",
                PayloadExt: ".sh",
                Desc:       "Runnable shell scripts shared through Hugging Face datasets",
        })
        Register(LibrarySpec{
                Type:       "doc",
                Label:      "Doc Library",
                Tag:        "doomalay-doc",
                PayloadExt: ".md",
                Desc:       "Markdown guides and journals shared through Hugging Face datasets",
                Hidden:     true, // v0.63: bundled + bot-served only — never a browsable tab
        })
        // v0.91.3: PYTHON — runnable Python scripts as a FIRST-CLASS library
        // category (user spec: "if it helps to add python scripts as a
        // category in the library let's do so. We want even the weakest
        // models to be able to reliably run the scripts and use the Kronos
        // bundle 100% of the time"). The Kronos bundle's runnable entry
        // points (prediction, data fetch, backtest, finetune, webui) publish
        // here as browsable, bot-downloadable .py payloads — a weak model
        // gets a clean catalog instead of digging through skill companions.
        // Zero Kronos strings here (the ONE LAW) — the type is generic.
        Register(LibrarySpec{
                Type:       "python",
                Label:      "Python Library",
                Tag:        "doomalay-python",
                PayloadExt: ".py",
                Desc:       "Runnable Python scripts shared through Hugging Face datasets",
        })
        // v1.22.0 THE MIRROR: PREAMBLES — the persona-metadata block (the
        // app briefing: identity line + the machinery slots, written in
        // {placeholders}). A portable .md file with frontmatter (name +
        // description + placeholders) + a body; the persona editor's
        // Preamble panel publishes/downloads them. One Register call —
        // the routes, tabs and bundles come free (the registry idiom).
        Register(LibrarySpec{
                Type:       "preamble",
                Label:      "Preamble Library",
                Tag:        "doomalay-preamble",
                PayloadExt: ".md",
                Desc:       "Persona preambles — the app briefing blocks, shared through Hugging Face datasets",
        })
        // v1.54 THE LIBRARY SHIP (PLAN-V142 §3.6, the wave's final phase):
        // CANVAS — a whole world as a .doomcanvas bundle (the v1.42.8
        // vessel format: layout + chats + assets + portals + child
        // worlds). Publish rides the worlds manager's publish sheet; a
        // download lands as a NEW world via CanvasBundle.importBundle.
        // Payloads ride the binary transport (BigPayload) + LFS.
        Register(LibrarySpec{
                Type:       "canvas",
                Label:      "Canvas Library",
                Tag:        "doomalay-canvas",
                PayloadExt: ".doomcanvas",
                RepoSuffix: "canvases", // "doomalay-canvases", never "doomalay-canvass"
                Desc:       "Whole worlds — canvases with their chats, looks and portals, shared as .doomcanvas bundles",
        })
        // v1.54 THE LIBRARY SHIP: CHAT — one conversation as a .doomchat
        // bundle (session + tweaks + optional folded history + chat
        // assets). "Chats are a whole lib section themselves" (the REV 2
        // ask). A download materializes a new chat icon on the current
        // canvas, bound to the reborn session (personas land INACTIVE,
        // auto-tools OFF — the R7 no-auto-activation law).
        Register(LibrarySpec{
                Type:       "chat",
                Label:      "Chat Library",
                Tag:        "doomalay-chat",
                PayloadExt: ".doomchat",
                Desc:       "Single chats — a conversation with its look and assets, shared as .doomchat bundles",
        })
}
