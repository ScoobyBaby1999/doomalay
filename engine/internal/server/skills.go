// skills.go — the PM bridge's superpowers tools (v0.60 pt C.13).
//
// PrivateMode chats run in the WebView through pmsdk.js's browser-side
// ReAct loop (remote attestation + E2E encryption in WASM — the Go engine
// cannot speak that protocol), so the lib pill's skill discipline needs
// a same-origin tool path: this file serves it.
//
//   GET /api/tools/skills?action=bootstrap          the full using-superpowers
//                                                    body (verbatim upstream,
//                                                    frontmatter stripped) + the
//                                                    PM harness tool map — the
//                                                    porting guide's Part 3
//                                                    bootstrap, PM flavor.
//          action=list                              the skill index (name +
//                                                    description — progressive
//                                                    disclosure, trigger-only)
//          action=search&q=                         ranked index hits
//          action=load&skill=                       the SKILL LOADED envelope
//          action=files&skill=                      companion file list
//          action=read&skill=&path=                  one companion file
//
//   GET /api/tools/hublib?action=libraries|search|get|download — the bot-side
//          hub browse (mirrors the brain's dt_hublib): search across the
//          template/skill/script/doc libraries, item detail with payload
//          head, download (the SAME hub.Download the ⤓ button makes —
//          the item lands in the engine's hub_items rows and the payload
//          rides back so the model can follow the methodology at once).
//
// GATES (v0.60 pt C.9 semantics, server-side second line of defense —
// the client only arms the protocol when the pill is on):
//   · bootstrap + load need the session's lib gate ON (the ?session=
//     param → LibAuto || TemplateAuto || SkillsAuto).
//   · hublib download additionally honors the per-chat tweaks Bot Library
//     switch (botLib; absent = enabled — the same on-the-fly re-read
//     dt_hublib does, so a mid-chat flip takes effect on the next call).
//   · list/search/browse stay open when the gate is off: the model may
//     still browse and RECOMMEND, it just cannot load/download.

package server

import (
        "encoding/json"
        "net/http"
        "os"
        "path/filepath"
        "sort"
        "strconv"
        "strings"
        "sync"
        "unicode"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/buildinfo"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/hfzero"
)

// Output caps — mirror the brain's dt_skills so both halves of the port
// speak the same sizes (a skill body that fits one must fit the other).
const (
        skillsReadMax     = 8000  // browsing (companion files)
        skillsLoadMax     = 40000 // injection (the largest real skill is ~33k)
        skillsSearchTop   = 8
        hublibOutMax      = 6000 // dt_spec rule 9 — a few screens max
        hublibPayloadHead = 3000
        hublibListMax     = 12
)

// skillsEntry is one indexed skill (flat frontmatter per agentskills.io).
type skillsEntry struct {
        Name        string `json:"name"`
        Description string `json:"description"`
        Dir         string `json:"-"`
        HasFiles    bool   `json:"has_files"`
}

var (
        skillsIdxMu    sync.Mutex
        skillsIdxCache []skillsEntry
        skillsIdxSig   string
)

// skillsDir resolves brain/agent_skills. The config default is CWD-relative
// (../brain / ./brain — repo root runs); when the engine runs from a
// different working directory (the e2e harness, installed layouts) the
// executable's own sibling layout is the fallback: Android/installs ship
// the brain NEXT TO the engine binary.
//
// v0.69 — THE EMBEDDED LIBRARY: the APK and the desktop binaries ship the
// engine WITHOUT any brain directory (only the HF Space image copies
// brain/), so the skills tool 400'd with "skills library unavailable:
// Stat brain/agent_skills: no such file or directory" the moment the Bot
// Library was enabled. The engine already EMBEDS the whole brain for the
// HF-space deployer (hfzero, build-synced by make sync-hfzero) — when no
// on-disk library is found, the embedded agent_skills subtree is extracted
// ONCE per engine build into <DataDir>/brain/agent_skills (stamped with
// the engine version; a stamp mismatch re-extracts) and served like a real
// directory. Everything downstream (the mtime-cached index, list/load/
// files/read) works unchanged on the extracted copy.
func (s *Server) skillsDir() string {
        d := s.cfg.BrainDir
        if d == "" {
                d = "./brain"
        }
        if fi, err := os.Stat(filepath.Join(d, "agent_skills")); err == nil && fi.IsDir() {
                return filepath.Join(d, "agent_skills")
        }
        if exe, err := os.Executable(); err == nil {
                for _, cand := range []string{"../brain/agent_skills", "brain/agent_skills"} {
                        p := filepath.Join(filepath.Dir(exe), cand)
                        if fi, err := os.Stat(p); err == nil && fi.IsDir() {
                                return p
                        }
                }
        }
        if p := s.ensureEmbeddedSkills(); p != "" {
                return p
        }
        return filepath.Join(d, "agent_skills")
}

// skillsStamp is the extracted-library marker file: the engine version that
// wrote the tree. A different running engine (upgrade) re-extracts.
const skillsStampName = ".engine-skills-stamp"

// ensureEmbeddedSkills extracts the embedded agent_skills library into
// <DataDir>/brain/agent_skills when missing or stale, returning its path
// ("" when unavailable — the caller falls back to the legacy path and the
// honest Stat error surfaces exactly as before).
func (s *Server) ensureEmbeddedSkills() string {
        files, err := hfzero.AgentSkillFiles()
        if err != nil || len(files) == 0 {
                return "" // nothing embedded (shouldn't happen — sync-hfzero)
        }
        base := s.cfg.DataDir
        if base == "" {
                return "" // no writable data dir configured — don't guess
        }
        root := filepath.Join(base, "brain", "agent_skills")
        stamp := filepath.Join(filepath.Dir(root), skillsStampName)
        want := buildinfo.Version
        if want == "" {
                want = "dev"
        }
        if b, err := os.ReadFile(stamp); err == nil && string(b) == want {
                if fi, err := os.Stat(root); err == nil && fi.IsDir() {
                        return root // fresh for this build
                }
        }
        // (re)extract: tmp dir first, then swap — a half-written tree can
        // never be mistaken for a complete one (the stamp is the judge).
        // The embedded paths are rooted "agent_skills/…" — strip that head
        // so the files land DIRECTLY under the tmp root (no double nesting).
        tmp := root + ".tmp"
        _ = os.RemoveAll(tmp)
        for _, f := range files {
                rel := strings.TrimPrefix(f.Path, "agent_skills/")
                if rel == "" || rel == f.Path && !strings.HasPrefix(f.Path, "agent_skills/") {
                        continue // anything outside the subtree — skip
                }
                dst := filepath.Join(tmp, filepath.FromSlash(rel))
                if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
                        return ""
                }
                if err := os.WriteFile(dst, f.Content, 0o644); err != nil {
                        return ""
                }
        }
        _ = os.RemoveAll(root)
        if err := os.Rename(tmp, root); err != nil {
                _ = os.RemoveAll(tmp)
                return ""
        }
        _ = os.WriteFile(stamp, []byte(want), 0o644)
        return root
}

// parseFrontmatterFlat parses the leading `---` block of a SKILL.md — the
// flat key:value subset + indented wrapped continuations (a yaml-free port
// of dt_skills.parse_frontmatter; malformed blocks degrade to {}).
func parseFrontmatterFlat(text string) map[string]string {
        lines := strings.SplitN(strings.ReplaceAll(text, "\r\n", "\n"), "\n", -1)
        if len(lines) < 2 || strings.TrimSpace(lines[0]) != "---" {
                return map[string]string{}
        }
        out := map[string]string{}
        cur := ""
        for i := 1; i < len(lines); i++ {
                l := lines[i]
                if strings.TrimSpace(l) == "---" {
                        break // closing fence (or EOF — tolerable)
                }
                if strings.TrimSpace(l) == "" {
                        cur = "" // blank line ends a wrapped value
                        continue
                }
                if idx := strings.Index(l, ":"); idx > 0 && !unicode.IsSpace(rune(l[0])) {
                        key := strings.TrimSpace(l[:idx])
                        val := strings.TrimSpace(l[idx+1:])
                        if len(val) >= 2 && val[0] == val[len(val)-1] && (val[0] == '\'' || val[0] == '"') {
                                val = val[1 : len(val)-1]
                        }
                        out[key] = val
                        cur = key
                } else if (strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t")) && cur != "" {
                        out[cur] = strings.TrimSpace(out[cur] + " " + strings.TrimSpace(l))
                }
        }
        return out
}

// stripFrontmatter returns the body after the leading --- block.
func stripFrontmatter(text string) string {
        t := strings.ReplaceAll(text, "\r\n", "\n")
        if !strings.HasPrefix(t, "---") {
                return strings.TrimSpace(t)
        }
        if end := strings.Index(t[3:], "\n---"); end >= 0 {
                return strings.TrimSpace(t[3+end+4:])
        }
        return strings.TrimSpace(t)
}

// skillsIndex lists agent_skills/<dir>/SKILL.md entries (mtime-cached).
func (s *Server) skillsIndex() ([]skillsEntry, error) {
        root := s.skillsDir()
        // signature: cheap dir mtime — good enough to avoid rewalks.
        fi, err := os.Stat(root)
        if err != nil {
                return nil, err
        }
        sig := fi.ModTime().String()
        skillsIdxMu.Lock()
        defer skillsIdxMu.Unlock()
        if skillsIdxCache != nil && skillsIdxSig == sig {
                return skillsIdxCache, nil
        }
        entries := []skillsEntry{}
        dirs, err := os.ReadDir(root)
        if err != nil {
                return nil, err
        }
        for _, d := range dirs {
                if !d.IsDir() {
                        continue
                }
                p := filepath.Join(root, d.Name(), "SKILL.md")
                b, err := os.ReadFile(p)
                if err != nil {
                        continue
                }
                fm := parseFrontmatterFlat(string(b))
                name := fm["name"]
                if name == "" {
                        name = strings.TrimPrefix(d.Name(), "superpowers-")
                }
                // companion files present?
                hasFiles := false
                if kids, err := os.ReadDir(filepath.Join(root, d.Name())); err == nil {
                        for _, k := range kids {
                                if !k.IsDir() && k.Name() != "SKILL.md" {
                                        hasFiles = true
                                        break
                                }
                        }
                }
                entries = append(entries, skillsEntry{
                        Name: name, Description: fm["description"],
                        Dir: d.Name(), HasFiles: hasFiles,
                })
        }
        sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
        skillsIdxCache, skillsIdxSig = entries, sig
        return entries, nil
}

// resolveSkill finds an entry by exact name, skill dir name, or
// superpowers-prefixed name (mirrors dt_skills' resolution ladder).
func resolveSkill(entries []skillsEntry, ref string) *skillsEntry {
        ref = strings.TrimSpace(strings.ToLower(ref))
        if ref == "" {
                return nil
        }
        for i := range entries {
                if strings.ToLower(entries[i].Name) == ref {
                        return &entries[i]
                }
        }
        for i := range entries {
                if strings.ToLower(entries[i].Dir) == ref {
                        return &entries[i]
                }
        }
        for i := range entries {
                if strings.ToLower(entries[i].Name) == "superpowers-"+ref {
                        return &entries[i]
                }
        }
        for i := range entries {
                if strings.Contains(strings.ToLower(entries[i].Name), ref) {
                        return &entries[i]
                }
        }
        return nil
}

// sessionLibOn — the effective lib-pill state for a session id.
func (s *Server) sessionLibOn(sessID string) bool {
        if sessID == "" {
                return false
        }
        sess, err := s.db.GetSession(sessID)
        if err != nil || sess == nil {
                return false
        }
        return sess.LibAuto || sess.TemplateAuto || sess.SkillsAuto
}

// tweaksBotLibOn — the per-chat tweaks Bot Library switch (absent = on).
func (s *Server) tweaksBotLibOn(sessID string) bool {
        if sessID == "" || s.db == nil {
                return true
        }
        raw, err := s.db.GetSetting(chatTweaksKey(sessID))
        if err != nil || strings.TrimSpace(raw) == "" {
                return true
        }
        var blob map[string]any
        if err := json.Unmarshal([]byte(raw), &blob); err != nil {
                return true
        }
        v, ok := blob["botLib"]
        if !ok {
                return true
        }
        on, _ := v.(bool)
        return on
}

// tweaksBotDLOn — v0.68: the per-chat tweaks CAN DOWNLOAD BUNDLES switch
// (absent = on). ON: the bot may download new bundles and use them; OFF:
// only what's already downloaded ("Yours") — downloads refuse with the
// exact switch path. Enforced AFTER tweaksBotLibOn (botLib off already
// blocks every download; botDL only narrows further when botLib is on).
// Same live re-read on every call — a mid-chat flip applies next turn.
func (s *Server) tweaksBotDLOn(sessID string) bool {
        if sessID == "" || s.db == nil {
                return true
        }
        raw, err := s.db.GetSetting(chatTweaksKey(sessID))
        if err != nil || strings.TrimSpace(raw) == "" {
                return true
        }
        var blob map[string]any
        if err := json.Unmarshal([]byte(raw), &blob); err != nil {
                return true
        }
        v, ok := blob["botDL"]
        if !ok {
                return true
        }
        on, _ := v.(bool)
        return on
}

// handleToolsSkills is GET /api/tools/skills — the PM bridge's skills
// half. `result` is the OBSERVATION-ready text (pmsdk wraps it).
func (s *Server) handleToolsSkills(w http.ResponseWriter, r *http.Request) {
        action := r.URL.Query().Get("action")
        session := r.URL.Query().Get("session")
        entries, err := s.skillsIndex()
        if err != nil {
                writeJSON(w, http.StatusOK, map[string]any{
                        "tool": "skills", "error": "skills library unavailable: " + err.Error()})
                return
        }
        switch action {
        case "bootstrap":
                if !s.sessionLibOn(session) {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                                "error": "the chat's Bot Library is OFF — flip the \U0001F6E0 lib pill (or ✦ tweaks → Bot Library) back on first"})
                        return
                }
                body, err := os.ReadFile(filepath.Join(s.skillsDir(),
                        "superpowers-using-superpowers", "SKILL.md"))
                if err != nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                                "error": "bootstrap skill missing: " + err.Error()})
                        return
                }
                text := "SUPERPOWERS — THE SKILL DISCIPLINE (injected, active):\n\n" +
                        stripFrontmatter(string(body)) +
                        "\n\nHARNESS TOOL MAP (this harness's real tools):\n" +
                        "- *invoke a skill* → ACTION: skills {\"action\": \"load\", \"skill\": \"<name>\"}\n" +
                        "- *list/search skills* → ACTION: skills {\"action\": \"list\"} or {\"action\": \"search\", \"q\": \"…\"}\n" +
                        "- *read a skill's companion files* → ACTION: skills {\"action\": \"files\"/\"read\", \"skill\": \"…\", \"path\": \"…\"}\n" +
                        "- *browse the public hub* → ACTION: hublib {\"action\": \"search\", \"q\": \"…\", \"type\": \"skill|doc|script|template\"}\n" +
                        "- *download a hub item* → ACTION: hublib {\"action\": \"download\", \"type\": \"…\", \"repo\": \"…\", \"id\": \"…\"}\n" +
                        "- *dispatch a subagent* → ACTION: delegate {\"prompt\": \"…\"}\n" +
                        "- *create/update todos* → the timemgr equivalents: ACTION: json_tool / text_stats (plain notes)\n" +
                        " — load a skill BEFORE starting any work it covers."
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "result": text})
        case "list":
                var b strings.Builder
                b.WriteString("SKILLS LIBRARY (load one with ACTION: skills {\"action\":\"load\",\"skill\":\"<name>\"}):\n")
                for i, e := range entries {
                        if i > 40 {
                                b.WriteString("… (use search for more)\n")
                                break
                        }
                        b.WriteString("- " + e.Name + " — " + oneLine(e.Description, 120) + "\n")
                }
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "result": clip(b.String(), hublibOutMax)})
        case "search":
                q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
                if q == "" {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                                "error": "empty query. Usage: ACTION: skills {\"action\": \"search\", \"q\": \"brainstorm\"}"})
                        return
                }
                type hit struct {
                        e skillsEntry
                        s int
                }
                var hits []hit
                for _, e := range entries {
                        score := 0
                        nl, dl := strings.ToLower(e.Name), strings.ToLower(e.Description)
                        for _, term := range strings.Fields(q) {
                                if strings.Contains(nl, term) {
                                        score += 3
                                }
                                if strings.Contains(dl, term) {
                                        score++
                                }
                        }
                        if score > 0 {
                                hits = append(hits, hit{e, score})
                        }
                }
                sort.Slice(hits, func(i, j int) bool { return hits[i].s > hits[j].s })
                top := skillsSearchTop
                if len(hits) < top {
                        top = len(hits)
                }
                var b strings.Builder
                if top == 0 {
                        b.WriteString("no skill matched " + q + " — ACTION: skills {\"action\":\"list\"} shows everything")
                } else {
                        b.WriteString("SKILL SEARCH HITS (best first):\n")
                        for i := 0; i < top; i++ {
                                b.WriteString("- " + hits[i].e.Name + " — " + oneLine(hits[i].e.Description, 140) + "\n")
                        }
                }
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "result": clip(b.String(), hublibOutMax)})
        case "load":
                if !s.sessionLibOn(session) {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                                "error": "the chat's Bot Library is OFF — you can browse and recommend, but loads are refused until the user flips the \U0001F6E0 lib pill (or ✦ tweaks → Bot Library) back on"})
                        return
                }
                ref := r.URL.Query().Get("skill")
                e := resolveSkill(entries, ref)
                if e == nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                                "error": "no skill named " + oneLine(ref, 60) + " — ACTION: skills {\"action\":\"list\"} shows the library"})
                        return
                }
                body, err := os.ReadFile(filepath.Join(s.skillsDir(), e.Dir, "SKILL.md"))
                if err != nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "read failed: " + err.Error()})
                        return
                }
                text := "SKILL LOADED — " + e.Name + ". Follow this methodology now.\n\n" +
                        clip(stripFrontmatter(string(body)), skillsLoadMax, "\n…(body clipped — ACTION: skills {\"action\":\"read\",\"skill\":\""+e.Name+"\",\"path\":\"SKILL.md\"} for the tail)")
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "result": text})
        case "files":
                e := resolveSkill(entries, r.URL.Query().Get("skill"))
                if e == nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "no such skill"})
                        return
                }
                kids, err := os.ReadDir(filepath.Join(s.skillsDir(), e.Dir))
                if err != nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "read failed: " + err.Error()})
                        return
                }
                var b strings.Builder
                b.WriteString("COMPANION FILES of " + e.Name + " (read with ACTION: skills {\"action\":\"read\",\"skill\":\"" + e.Name + "\",\"path\":\"…\"}):\n")
                for _, k := range kids {
                        if k.Name() == "SKILL.md" {
                                continue
                        }
                        b.WriteString("- " + k.Name() + "\n")
                }
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "result": clip(b.String(), hublibOutMax)})
        case "read":
                e := resolveSkill(entries, r.URL.Query().Get("skill"))
                if e == nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "no such skill"})
                        return
                }
                p := r.URL.Query().Get("path")
                clean := filepath.Clean("/" + p) // traversal-proof
                if strings.Contains(clean, "..") {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "bad path"})
                        return
                }
                b, err := os.ReadFile(filepath.Join(s.skillsDir(), e.Dir, clean))
                if err != nil {
                        writeJSON(w, http.StatusOK, map[string]any{"tool": "skills", "error": "read failed: " + err.Error()})
                        return
                }
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                        "result": clip(string(b), skillsReadMax, "\n…(clipped — the full file rides the load envelope)")})
        default:
                writeJSON(w, http.StatusOK, map[string]any{"tool": "skills",
                        "error": "unknown action " + oneLine(action, 30) + ". Valid: bootstrap, list, search, load, files, read."})
        }
}

// handleToolsHublib is GET /api/tools/hublib — the PM bridge's bot-side
// hub browse (the pmsdk twin of the brain's dt_hublib).
func (s *Server) handleToolsHublib(w http.ResponseWriter, r *http.Request) {
        q := r.URL.Query()
        res, errStr := s.hublibDispatch(q.Get("action"), q.Get, q.Get("session"))
        if errStr != "" {
                writeJSON(w, http.StatusOK, map[string]any{"tool": "hublib", "error": errStr})
                return
        }
        writeJSON(w, http.StatusOK, map[string]any{"tool": "hublib", "result": res})
}

// hublibDispatch (v0.67.2, extracted) — the shared hub-lib action core:
// the HTTP handler (the PM bridge) AND the direct-path ACTION runner
// (runHublibAction, wired into llm.Chat via ChatRequest.HublibToolFn)
// both land here. get(k) resolves an argument by key. The per-chat Bot
// Library switch gates downloads only (browse/get always answer) —
// exactly the dt_hublib semantics.
func (s *Server) hublibDispatch(action string, get func(string) string, session string) (string, string) {
        switch action {
        case "search", "": // empty action → the search default (bare "ACTION: hublib {}")
                typ := get("type")
                if typ == "" {
                        typ = "skill"
                }
                if !hublibPMTypes[typ] {
                        return "", "type must be one of template, skill, script, doc"
                }
                items, err := s.hub.Items(typ, get("q"), "relevant", "", false)
                if err != nil {
                        return "", "hub: " + err.Error()
                }
                var b strings.Builder
                n := len(items)
                if n > hublibListMax {
                        n = hublibListMax
                }
                b.WriteString("HUB " + strings.ToUpper(typ) + "S (download with ACTION: hublib {\"action\":\"download\",\"type\":\"" + typ + "\",\"repo\":\"…\",\"id\":\"…\"}):\n")
                for i := 0; i < n; i++ {
                        it := items[i]
                        b.WriteString("- " + oneLine(it.Name, 60) +
                                " | repo: " + it.Repo + " | id: " + it.ID +
                                " | " + oneLine(it.Description, 100) + "\n")
                }
                if len(items) > n {
                        b.WriteString("… " + strconv.Itoa(len(items)-n) + " more — narrow the query\n")
                }
                if n == 0 {
                        b.WriteString("(no items matched — try another query or type)")
                }
                return clip(b.String(), hublibOutMax), ""
        case "get":
                typ := get("type")
                if !hublibPMTypes[typ] {
                        return "", "type must be one of template, skill, script, doc"
                }
                item, payload, err := s.hub.ItemDetail(typ, get("repo"), get("id"))
                if err != nil {
                        return "", "hub: " + err.Error()
                }
                text := "HUB ITEM — " + item.Name + " (" + typ + ", repo " + item.Repo + ", id " + item.ID + ")\n" +
                        oneLine(item.Description, 200) + "\n\nPAYLOAD HEAD:\n" +
                        clip(payload, hublibPayloadHead, "\n…(clipped — download it to use)")
                return clip(text, hublibOutMax), ""
        case "download":
                if !s.sessionLibOn(session) {
                        return "", "the chat's Bot Library is OFF — you can browse and recommend, but downloads are refused until the user flips ✦ tweaks → Bot Library back on"
                }
                if !s.tweaksBotLibOn(session) {
                        return "", "the chat's Bot Library switch is OFF — flip ✦ tweaks → Bot Library back on to download"
                }
                // v0.68: CAN DOWNLOAD BUNDLES — OFF means the bot works
                // with what's already in the user's library only. (Merged
                // into the extracted dispatch so BOTH the PM bridge and the
                // direct-path ACTION runner carry the gate.)
                if !s.tweaksBotDLOn(session) {
                        return "", "the chat's Can download bundles switch is OFF — only already-downloaded bundles are usable; flip ✦ tweaks → Bot Library → Can download bundles back on to download new ones"
                }
                typ := get("type")
                if !hublibPMTypes[typ] {
                        return "", "type must be one of template, skill, script, doc"
                }
                item, payload, err := s.hub.Download(typ, get("repo"), get("id"))
                if err != nil {
                        return "", "hub: " + err.Error()
                }
                text := "DOWNLOADED — " + item.Name + " (" + typ + "). It is now in the user's library. PAYLOAD:\n" +
                        clip(payload, skillsLoadMax, "\n…(payload clipped — ACTION: hublib {\"action\":\"get\"} re-reads the head)")
                return clip(text, skillsLoadMax+400), ""
        default:
                return "", "unknown action " + oneLine(action, 30) + ". Valid: search, get, download."
        }
}

// runHublibAction (v0.67.2) — the DIRECT-PATH library ACTION runner: the
// quick chats' "ACTION: hublib {…}" lines land here (via
// llm.ChatRequest.HublibToolFn), parse their JSON args, and ride the
// same hublibDispatch as the PM bridge. Returns OBSERVATION-ready text.
func (s *Server) runHublibAction(sessionID, argJSON string) string {
        var args map[string]any
        if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
                // tolerate a bare string arg ("ACTION: hublib brainstorming") —
                // treat it as the search query.
                trimmed := strings.TrimSpace(strings.Trim(argJSON, "\""))
                if trimmed != "" && !strings.HasPrefix(argJSON, "{") {
                        args = map[string]any{"action": "search", "q": trimmed}
                } else {
                        return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
                }
        }
        action, _ := args["action"].(string)
        if action == "" {
                action = "search"
        }
        get := func(k string) string {
                v, _ := args[k].(string)
                return v
        }
        res, errStr := s.hublibDispatch(action, get, sessionID)
        if errStr != "" {
                return "OBSERVATION:\nerror: " + errStr
        }
        return "OBSERVATION:\n" + res
}

// hublibPMTypes — the libraries the bot-side hub serves (personas excluded,
// same policy as dt_hublib).
var hublibPMTypes = map[string]bool{
        "template": true, "skill": true, "script": true, "doc": true,
}

// oneLine flattens + clips to n chars.
func oneLine(s string, n int) string {
        s = strings.Join(strings.Fields(s), " ")
        if len(s) > n {
                return s[:n] + "…"
        }
        return s
}

// clip trims s to max bytes appending tail when cut.
func clip(s string, max int, tail ...string) string {
        if len(s) <= max {
                return s
        }
        t := "\n…(clipped)"
        if len(tail) > 0 {
                t = tail[0]
        }
        return s[:max] + t
}
