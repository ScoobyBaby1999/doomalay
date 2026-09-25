package server

// skills_test.go — v0.60 pt C.13: the PM bridge's superpowers tools.
// The skills half (bootstrap gate, index, search, load envelope, resolve
// ladder, companion reads, traversal guard) against a temp brain/ tree,
// plus the hublib half's gate semantics.

import (
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func newSkillsTestServer(t *testing.T) *Server {
        t.Helper()
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        // brain/agent_skills/<skill>/SKILL.md tree.
        skills := filepath.Join(dir, "brain", "agent_skills")
        mkSkill := func(dirName, fm, body string, files map[string]string) {
                p := filepath.Join(skills, dirName)
                if err := os.MkdirAll(p, 0o755); err != nil {
                        t.Fatalf("mkdir: %v", err)
                }
                md := "---\n" + fm + "\n---\n" + body
                if err := os.WriteFile(filepath.Join(p, "SKILL.md"), []byte(md), 0o644); err != nil {
                        t.Fatalf("write skill: %v", err)
                }
                for name, content := range files {
                        if err := os.WriteFile(filepath.Join(p, name), []byte(content), 0o644); err != nil {
                                t.Fatalf("write companion: %v", err)
                        }
                }
        }
        mkSkill("superpowers-using-superpowers",
                "name: using-superpowers\ndescription: the bootstrap discipline\n",
                "# THE DISCIPLINE\nLoad a skill before any work it covers.", nil)
        mkSkill("superpowers-brainstorming",
                "name: brainstorming\ndescription: Turn ideas into designs through questions.\n",
                "# Brainstorming\nAsk one question at a time.", map[string]string{
                        "references.md": "companion body",
                })
        mkSkill("conscious",
                "name: conscious\n\ndescription: wrapped\n  continuation line\n",
                "body", nil)
        cfg := &config.Config{DataDir: dir, BrainDir: filepath.Join(dir, "brain")}
        return New(cfg, db, nil)
}

func skillsGet(t *testing.T, s *Server, path string) (int, map[string]any) {
        t.Helper()
        req := httptest.NewRequest(http.MethodGet, path, nil)
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        var out map[string]any
        _ = json.Unmarshal(rec.Body.Bytes(), &out)
        return rec.Code, out
}

func mkLibSession(t *testing.T, s *Server, libOn bool) string {
        t.Helper()
        req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(
                `{"title":"t","model":"m","provider":"p","lib_auto":`+boolJSON(libOn)+`}`))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 201 && rec.Code != 200 {
                t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
        }
        var sess struct {
                ID string `json:"id"`
        }
        _ = json.Unmarshal(rec.Body.Bytes(), &sess)
        return sess.ID
}

func boolJSON(b bool) string {
        if b {
                return "true"
        }
        return "false"
}

// TestSkillsBootstrapGate — bootstrap needs the session's lib gate ON and
// carries the discipline + tool map; OFF gets the actionable refusal.
func TestSkillsBootstrapGate(t *testing.T) {
        s := newSkillsTestServer(t)
        on := mkLibSession(t, s, true)
        off := mkLibSession(t, s, false)

        code, out := skillsGet(t, s, "/api/tools/skills?action=bootstrap&session="+on)
        if code != 200 {
                t.Fatalf("status %d", code)
        }
        text, _ := out["result"].(string)
        if !strings.Contains(text, "SUPERPOWERS — THE SKILL DISCIPLINE") ||
                !strings.Contains(text, "Load a skill before any work") ||
                !strings.Contains(text, "ACTION: skills") {
                t.Fatalf("bootstrap text wrong: %.200s", text)
        }

        _, out2 := skillsGet(t, s, "/api/tools/skills?action=bootstrap&session="+off)
        if _, ok := out2["error"]; !ok {
                t.Fatalf("bootstrap with lib OFF must refuse, got %v", out2["result"])
        }
        // no session at all → also refused (the gate is server-side truth)
        _, out3 := skillsGet(t, s, "/api/tools/skills?action=bootstrap")
        if _, ok := out3["error"]; !ok {
                t.Fatalf("bootstrap without session must refuse")
        }
}

// TestSkillsListSearchLoad — index, ranked search, the load envelope, the
// resolve ladder (name / dir / superpowers- prefix / substring) and the
// load gate.
func TestSkillsListSearchLoad(t *testing.T) {
        s := newSkillsTestServer(t)
        on := mkLibSession(t, s, true)
        off := mkLibSession(t, s, false)

        _, list := skillsGet(t, s, "/api/tools/skills?action=list")
        text, _ := list["result"].(string)
        if !strings.Contains(text, "brainstorming") || !strings.Contains(text, "using-superpowers") {
                t.Fatalf("list missing entries: %.200s", text)
        }
        // frontmatter continuation lines unwrap into the description
        if !strings.Contains(text, "wrapped continuation line") {
                t.Fatalf("wrapped description lost: %.300s", text)
        }

        _, sr := skillsGet(t, s, "/api/tools/skills?action=search&q=brainstorm")
        stext, _ := sr["result"].(string)
        if !strings.Contains(stext, "brainstorming") {
                t.Fatalf("search missed: %.200s", stext)
        }

        // load by bare name with lib ON → envelope + body
        _, ld := skillsGet(t, s, "/api/tools/skills?action=load&skill=brainstorming&session="+on)
        ltext, _ := ld["result"].(string)
        if !strings.Contains(ltext, "SKILL LOADED — brainstorming") ||
                !strings.Contains(ltext, "Ask one question at a time.") {
                t.Fatalf("load envelope wrong: %.200s", ltext)
        }
        // resolve ladder: superpowers- prefix + substring
        _, ld2 := skillsGet(t, s, "/api/tools/skills?action=load&skill=superpowers-brainstorming&session="+on)
        if _, ok := ld2["error"]; ok {
                t.Fatalf("prefix resolve failed: %v", ld2["error"])
        }
        // lib OFF → refusal names the switch
        _, ld3 := skillsGet(t, s, "/api/tools/skills?action=load&skill=brainstorming&session="+off)
        if _, ok := ld3["error"]; !ok {
                t.Fatalf("load with lib OFF must refuse")
        }
}

// TestSkillsFilesRead — companion browse + the traversal guard.
func TestSkillsFilesRead(t *testing.T) {
        s := newSkillsTestServer(t)
        _, f := skillsGet(t, s, "/api/tools/skills?action=files&skill=brainstorming")
        ftext, _ := f["result"].(string)
        if !strings.Contains(ftext, "references.md") {
                t.Fatalf("files list wrong: %.200s", ftext)
        }
        _, r := skillsGet(t, s, "/api/tools/skills?action=read&skill=brainstorming&path=references.md")
        rtext, _ := r["result"].(string)
        if !strings.Contains(rtext, "companion body") {
            t.Fatalf("read wrong: %.200s", rtext)
        }
        // traversal must not escape the skill dir
        _, tr := skillsGet(t, s, "/api/tools/skills?action=read&skill=brainstorming&path=../../../../etc/passwd")
        if _, ok := tr["error"]; !ok {
                t.Fatalf("traversal read must fail: %.100s", tr["result"])
        }
}

// TestHublibGates — download honors BOTH the session lib pill and the
// tweaks Bot Library switch; browse stays open.
func TestHublibGates(t *testing.T) {
        s := newSkillsTestServer(t)
        on := mkLibSession(t, s, true)
        off := mkLibSession(t, s, false)

        // browse with the gate off is fine (degrades to an engine error at
        // most — never a gate refusal)
        _, bo := skillsGet(t, s, "/api/tools/hublib?action=search&type=skill&q=x&session="+off)
        if e, ok := bo["error"].(string); ok && strings.Contains(e, "Bot Library") {
                t.Fatalf("browse must stay open when lib is off, got %q", e)
        }
        // download with lib off → the gate refusal
        _, d := skillsGet(t, s, "/api/tools/hublib?action=download&type=skill&repo=r&id=i&session="+off)
        if e, ok := d["error"].(string); !ok || !strings.Contains(e, "Bot Library") {
                t.Fatalf("download with lib off must refuse with the switch path, got %v", d["result"])
        }
        // tweaks botLib=false also refuses downloads even with the pill ON
        req := httptest.NewRequest(http.MethodPut, "/api/sessions/"+on+"/tweaks",
                strings.NewReader(`{"botLib":false}`))
        rec := httptest.NewRecorder()
        s.mux.ServeHTTP(rec, req)
        if rec.Code != 200 {
                t.Fatalf("tweaks put: %d %s", rec.Code, rec.Body.String())
        }
        _, d2 := skillsGet(t, s, "/api/tools/hublib?action=download&type=skill&repo=r&id=i&session="+on)
        if e, ok := d2["error"].(string); !ok || !strings.Contains(e, "Bot Library") {
                t.Fatalf("download with botLib off must refuse, got %v", d2["result"])
        }
        // unknown action + bad type degrade to actionable errors
        _, ua := skillsGet(t, s, "/api/tools/hublib?action=wat")
        if _, ok := ua["error"]; !ok {
                t.Fatalf("unknown action must error")
        }
}
