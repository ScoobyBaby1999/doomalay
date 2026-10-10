package server

// preambles.go — v1.22.0 THE MIRROR (PLAN-V122 §3): the Preamble system.
//
// The system prompt splits in two, both user-visible and user-editable:
//   PERSONA  — the voice: identity, style, rules (the existing persona
//              system, untouched).
//   PREAMBLE — the machinery: the identity line, the repo-access manifest,
//              the artifact protocol, the library briefing, the controls
//              ledger, the live session dashboard. An OPTIONAL persona
//              metadata block ("preamble"): 'default' (the app composes
//              it live, always in sync), a saved custom (a portable
//              markdown file with frontmatter + a body of placeholders),
//              or 'off' (the lean prompt — the persona IS the prompt).
//
// The placeholder vocabulary (expanded at turn time, engine + PM twin):
//   {model} {provider} {name} {skills} {custom keys} — the existing
//                                                      substituteAllVars set
//   {date}        — "Saturday, 10 October 2026"
//   {repo_access} — the workspace manifest (PUBLIC REPO ACCESS / the
//                   CONNECTED CLOUD WORKSPACES rows)
//   {artifacts}   — the artifact protocol ("" when the active persona
//                   already teaches it — the old no-duplication rule)
//   {library}     — the Doomalay Library section + the [Live library state]
//   {controls}    — "## This chat's controls" (the pill ledger)
//   {session}     — "## Your session (live)" (the dashboard)
//
// Unknown {keys} stay literal (portability: a foreign app strips or
// substitutes them — the AGENTS.md / Agent-Flavored-Markdown idiom).

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// PreambleSpec is one saved preamble: {id, name, text} — the persona row's
// shape minus modes (a chat selects ONE preamble; there is nothing to
// trigger on). Stored as a JSON array in chat_sessions.preambles; the
// selection lives in chat_sessions.preamble_sel ('' default | 'off' | id).
type PreambleSpec struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Text string `json:"text"`
}

const (
	// PreambleSelOff — the explicit OFF marker for chat_sessions.preamble_sel.
	PreambleSelOff = "off"
	// preambleMaxText / preambleMaxCount — the storage sanity caps (the
	// personas machinery has no caps, but preambles embed live blocks;
	// 64KB of template is far beyond any honest use).
	preambleMaxText  = 64 * 1024
	preambleMaxCount = 50
)

// parsePreambles decodes the session's preambles JSON (defensive — a
// corrupt blob parses as empty; the default preamble still composes).
func parsePreambles(raw string) []PreambleSpec {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var specs []PreambleSpec
	if err := json.Unmarshal([]byte(raw), &specs); err != nil {
		return nil
	}
	out := specs[:0]
	for _, p := range specs {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		if len(p.Text) > preambleMaxText {
			p.Text = p.Text[:preambleMaxText]
		}
		if p.ID == "" || strings.EqualFold(p.ID, "default") || strings.EqualFold(p.ID, PreambleSelOff) {
			continue // the default/off states are NOT storable rows
		}
		out = append(out, p)
	}
	return out
}

// sanitizePreambles caps the list (the PATCH path's write guard).
func sanitizePreambles(raw string) string {
	specs := parsePreambles(raw)
	if len(specs) > preambleMaxCount {
		specs = specs[:preambleMaxCount]
	}
	b, err := json.Marshal(specs)
	if err != nil {
		return ""
	}
	return string(b)
}

// sanitizePreambleSel normalizes the selection: 'default'/'' → '', 'off'
// → 'off', an id that exists in the chat's list stays, an id that doesn't
// falls back to '' (the default — a deleted preamble can't wedge a chat).
func sanitizePreambleSel(sel, preamblesRaw string) string {
	sel = strings.TrimSpace(strings.ToLower(sel))
	switch sel {
	case "", "default":
		return ""
	case PreambleSelOff:
		return PreambleSelOff
	}
	for _, p := range parsePreambles(preamblesRaw) {
		if strings.EqualFold(p.ID, sel) {
			return p.ID
		}
	}
	return ""
}

// defaultPreambleFor — the app default preamble TEMPLATE (not stored —
// composed live so it always matches the app). The PM twin carries the
// same text (persona.js DEFAULT_PREAMBLE_QUICK/HF).
func defaultPreambleFor(sess *store.Session) string {
	where := ", chatting inside the Doomalay app on the user's own device. "
	if sess != nil && sess.Sandbox == "hf" {
		where = ", chatting inside the Doomalay app from your Hugging Face Space. "
	}
	return "You are {model}, hosted via {provider}" + where + "Today is {date}.\n\n" +
		"{repo_access}\n\n{artifacts}\n\n{library}\n\n{controls}\n\n{session}"
}

// preambleTextFor resolves the chat's preamble RAW TEMPLATE:
// ''/'default' → the live app default · 'off' → "" · '<id>' → the saved
// custom (a missing id falls back to the default — a deleted preamble
// never wedges a chat).
func preambleTextFor(sess *store.Session) string {
	if sess == nil {
		return ""
	}
	switch sanitizePreambleSel(sess.PreambleSel, sess.Preambles) {
	case PreambleSelOff:
		return ""
	case "":
		return defaultPreambleFor(sess)
	}
	sel := strings.TrimSpace(sess.PreambleSel)
	for _, p := range parsePreambles(sess.Preambles) {
		if strings.EqualFold(p.ID, sel) && strings.TrimSpace(p.Text) != "" {
			return p.Text
		}
	}
	return defaultPreambleFor(sess)
}

// expandPromptBlocks expands the MIRROR placeholder vocabulary across the
// composed prompt (preamble AND persona — a custom persona may use the
// same placeholders). personaTeachesArtifact keeps the old rule: a persona
// that already carries the artifact protocol doesn't get {artifacts} twice.
func (s *Server) expandPromptBlocks(text string, sess *store.Session, bundleName string, personaTeachesArtifact bool) string {
	if !strings.Contains(text, "{") {
		return text
	}
	out := text
	if strings.Contains(out, "{repo_access}") {
		out = strings.ReplaceAll(out, "{repo_access}", s.workspaceManifestFor(sess.ID))
	}
	if strings.Contains(out, "{artifacts}") {
		art := ""
		if !personaTeachesArtifact {
			art = artifactSystemPrompt
		}
		out = strings.ReplaceAll(out, "{artifacts}", art)
	}
	if strings.Contains(out, "{library}") {
		out = strings.ReplaceAll(out, "{library}", libraryPreamble(sess)+s.libStateLine(sess))
	}
	if strings.Contains(out, "{controls}") {
		out = strings.ReplaceAll(out, "{controls}", s.chatMetadataPreamble(sess, bundleName))
	}
	if strings.Contains(out, "{session}") {
		out = strings.ReplaceAll(out, "{session}", s.sessionContextPreamble(sess))
	}
	if strings.Contains(out, "{date}") {
		out = strings.ReplaceAll(out, "{date}", time.Now().Format("Monday, 2 January 2006"))
	}
	// the empty blocks ({artifacts} skipped) leave blank gaps — collapse
	for strings.Contains(out, "\n\n\n") {
		out = strings.ReplaceAll(out, "\n\n\n", "\n\n")
	}
	return out
}
