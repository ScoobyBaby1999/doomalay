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
        "net/http"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
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
                "{tools}\n\n{repo_access}\n\n{artifacts}\n\n{library}\n\n{controls}\n\n{session}"
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
//
// v1.36.4 THE HONEST BLOCKS (PLAN-V137 §4): two per-chat truths ride the
// session now —
//   · PhBlocksOff: the five block TOKENS are excluded entirely (removed,
//     gaps collapsed; the live facts {model} {date} … still expand — they
//     substitute in the earlier pass). The user's toggle in the
//     placeholders screen owns it.
//   · BlockOverrides: {blockKey: text} — an edited truth that replaces
//     that block's live expansion (the CodeMirror editor's save; ↺ reset
//     clears it). The {artifacts} yield rule (personaTeachesArtifact)
//     applies FIRST — the no-duplication law survives overrides.
func (s *Server) expandPromptBlocks(text string, sess *store.Session, bundleName string, personaTeachesArtifact bool, serveMode, mcpBound bool) string {
        if !strings.Contains(text, "{") {
                return text
        }
        // THE TOGGLE: excluded — the blocks leave the prompt, the blank
        // gaps collapse (the empty-{artifacts} law's own collapse). The
        // FACTS still expand ({date}'s twin here rides after the strip —
        // the earlier substituteAllVars pass owns the facts; this direct-
        // call twin stands for the composed shape).
        if sess != nil && sess.PhBlocksOff {
                for _, k := range placeholderBlocks {
                        text = strings.ReplaceAll(text, "{"+k+"}", "")
                }
                if strings.Contains(text, "{date}") {
                        text = strings.ReplaceAll(text, "{date}", time.Now().Format("Monday, 2 January 2006"))
                }
                for strings.Contains(text, "\n\n\n") {
                        text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
                }
                return text
        }
        var ov map[string]string
        if sess != nil {
                ov = parseBlockOverrides(sess.BlockOverrides)
        }
        yield := func(key, live string) string {
                if v, ok := ov[key]; ok {
                        return v   // the edited truth wins
                }
                return live
        }
        out := text
        if strings.Contains(out, "{tools}") {
                // v1.58.2 THE WIDE SHELF — the {tools} MIRROR block (the simple
                // placeholder the persona system already speaks): the live tool
                // truth for THIS session. Serve chats carry the merged catalog
                // (opencode's own toolset + the app's tools via the doomalay MCP
                // server, built LIVE from the mcpbus registry — never a static
                // list); an UNBOUND serve chat carries the honest native-only note
                // (the model never hallucinates tools it does not have); native
                // chats carry "" (the ACTION grammar rides its own blocks; the
                // collapse law eats the gap — zero native-prompt change).
                out = strings.ReplaceAll(out, "{tools}", yield("tools", s.toolsBlockFor(sess, serveMode, mcpBound)))
        }
        if strings.Contains(out, "{repo_access}") {
                out = strings.ReplaceAll(out, "{repo_access}", yield("repo_access", s.workspaceManifestFor(sess.ID)))
        }
        if strings.Contains(out, "{artifacts}") {
                art := ""
                if !personaTeachesArtifact {
                        // v1.58.2 note: the ```artifact fence protocol is REPLY-TEXT
                        // grammar the PWA formatter extracts for EVERY provider — the serve
                        // path included (live-verified in the research: the fence is not the
                        // ACTION tool-call prose). One protocol everywhere; the MCP artifact
                        // tools (docx_create & friends) complement it through the {tools}
                        // block's catalog.
                        art = artifactSystemPrompt
                }
                out = strings.ReplaceAll(out, "{artifacts}", yield("artifacts", art))
        }
        if strings.Contains(out, "{library}") {
                out = strings.ReplaceAll(out, "{library}", yield("library", libraryPreamble(sess)+s.libStateLine(sess)))
        }
        if strings.Contains(out, "{controls}") {
                out = strings.ReplaceAll(out, "{controls}", yield("controls", s.chatMetadataPreamble(sess, bundleName)))
        }
        if strings.Contains(out, "{session}") {
                out = strings.ReplaceAll(out, "{session}", yield("session", s.sessionContextPreamble(sess)))
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

// ── v1.36.4: the overrides helpers ──────────────────────────────────

// blockOverrideMax caps one override entry (an edited block is a briefing,
// not a novel — 32KB is ~16× the largest live block).
const blockOverrideMax = 32 * 1024

// parseBlockOverrides decodes the session's {blockKey: text} map.
// Malformed / empty → nil (no overrides — the live truth rides).
func parseBlockOverrides(raw string) map[string]string {
        trimmed := strings.TrimSpace(raw)
        if trimmed == "" {
                return nil
        }
        m := map[string]string{}
        if err := json.Unmarshal([]byte(trimmed), &m); err != nil {
                return nil
        }
        return m
}

// sanitizeBlockOverrides (the PATCH door): only REAL block keys survive,
// each entry capped; a non-map or all-foreign map stores "" (none). The
// hard-refuse law's sibling — reserved/unknown keys never ride.
func sanitizeBlockOverrides(raw string) string {
        m := parseBlockOverrides(raw)
        if m == nil {
                return ""
        }
        allowed := map[string]bool{}
        for _, k := range placeholderBlocks {
                allowed[k] = true
        }
        out := map[string]string{}
        for k, v := range m {
                if !allowed[k] {
                        continue
                }
                if len(v) > blockOverrideMax {
                        v = v[:blockOverrideMax]
                }
                out[k] = v
        }
        b, err := json.Marshal(out)
        if err != nil {
                return ""
        }
        return string(b)
}

// ── v1.27.1 THE FULL LEXICON: the blocks preview endpoint ───────────
//
//   GET /api/sessions/{id}/blocks
//
// Decision §5-B of PLAN-V126 (the user approved the endpoint): every
// MIRROR block row in the placeholders screen can show its CURRENT
// expansion — rendered by the SAME builders the turn path uses
// (expandPromptBlocks's five), one source of truth. Each preview is
// capped (this is a glance, not the whole prompt) and reports its full
// size; {artifacts} reports collapsed:true + empty text when the chat's
// active persona already teaches the protocol (the no-duplication rule,
// evaluated identically to systemPromptForMetrics).

const blockPreviewCap = 2000

// blockFullCap — v1.36.4: ?full=1 (the placeholder editor's screen)
// raises the per-block cap: the editor shows the WHOLE block, scrollable
// (a glance is 2000; a document is 64KB).
const blockFullCap = 64 * 1024

func (s *Server) handleSessionBlocks(w http.ResponseWriter, r *http.Request) {
        sess, err := s.db.GetSession(r.PathValue("id"))
        if err != nil || sess == nil {
                writeError(w, 404, "session not found")
                return
        }
        // v1.36.4: the editor's full-text view (?full=1) + the session's
        // own truths (the toggle + the overrides) ride the same payload —
        // the placeholders screen renders what actually rides the turn.
        full := r.URL.Query().Get("full") == "1"
        capFor := blockPreviewCap
        if full {
                capFor = blockFullCap
        }
        ov := parseBlockOverrides(sess.BlockOverrides)
        // the {artifacts} yield rule — the same teachesArtifact test the
        // turn composition runs (active persona text mentions artifacts).
        personaRaw := ""
        if spec := s.resolveActivePersonaMerged(parsePersonas(sess), sess, personaMetrics{}); spec != nil {
                personaRaw = spec.Text
        } else if strings.TrimSpace(sess.Persona) != "" {
                personaRaw = sess.Persona
        }
        if personaRaw == "" {
                personaRaw = defaultPersonaFor(sess)
        }
        teachesArtifact := strings.Contains(strings.ToLower(personaRaw), "artifact")

        blocks := map[string]map[string]any{}
        emit := func(key, text string) {
                // v1.36.4: the override (the edited truth) rides the emitted
                // text — the preview AND the editor show what the turn sends;
                // the live default rides its own field (the ↺ reset target).
                if v, ok := ov[key]; ok {
                        live := text
                        runes := []rune(live)
                        if len(runes) > capFor {
                                live = string(runes[:capFor])
                        }
                        blocks[key] = map[string]any{
                                "text": v, "chars": len([]rune(v)),
                                "truncated": false, "collapsed": false,
                                "override": true, "live": live,
                        }
                        return
                }
                chars := len([]rune(text))
                if chars > capFor {
                        runes := []rune(text)
                        text = string(runes[:capFor])
                }
                blocks[key] = map[string]any{
                        "text":      text,
                        "chars":     chars,
                        "truncated": chars > capFor,
                        "collapsed": false,
                }
        }
        emit("repo_access", s.workspaceManifestFor(sess.ID))
        // v1.58.2: the {tools} block's preview rides the same serve gate the
        // turn path uses — an opencode-provider chat on a free model slot
        // composes through the serve bridge (the merged catalog); every
        // other chat collapses the block empty (the native truth).
        serveChat := sess.Provider == "opencode" && llm.IsOpenCodeFreeModelSlot(sess.Model)
        if teachesArtifact {
                if _, ok := ov["artifacts"]; ok {
                        emit("artifacts", artifactSystemPrompt)   // the override rides (emit swaps it in)
                } else {
                        blocks["artifacts"] = map[string]any{
                                "text": "", "chars": 0, "truncated": false, "collapsed": true,
                        }
                }
        } else {
                emit("artifacts", artifactSystemPrompt)
        }
        emit("library", libraryPreamble(sess)+s.libStateLine(sess))
        emit("controls", s.chatMetadataPreamble(sess, ""))
        emit("session", s.sessionContextPreamble(sess))
        emit("tools", s.toolsBlockFor(sess, serveChat, serveChat))
        writeJSON(w, 200, map[string]any{"blocks": blocks,
                "ph_blocks_off": sess.PhBlocksOff})
}
