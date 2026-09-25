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
}

// RepoName returns the per-user HF dataset repo name for this library
// ("<user>/doomalay-personas", "<user>/doomalay-templates", …).
func (s LibrarySpec) RepoName() string { return "doomalay-" + s.Type + "s" }

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
        })
}
