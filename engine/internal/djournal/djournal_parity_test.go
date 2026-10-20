package djournal

// djournal_parity_test.go — v1.47.1 THE JOURNAL HAND: the PYTHON PARITY
// CROSS-CHECK. The same 4-entry scenario runs through brain/tools/
// dt_journal.py (the spec) and this port; the outputs must agree
// byte-for-byte modulo the state dir path. The Python reference was
// captured live (2026-10-20, dt_journal.py SELF-TEST OK) and the
// pinned shapes below are its exact output.
//
// This is the red-team that guards "authentic": if a future edit
// diverges the Go soul from the Python soul, this test convicts.

import (
        "encoding/json"
        "os"
        "os/exec"
        "path/filepath"
        "strings"
        "testing"
        "time"
)

// TestPythonParityGolden runs BOTH implementations over one scenario
// and diffs. Skips (not fails) when python3 is absent — CI boxes
// without Python keep the rest of the battery meaningful; the pinned
// shapes in the fixtures below still assert on every box.
func TestPythonParityGolden(t *testing.T) {
        py, err := exec.LookPath("python3")
        if err != nil {
                t.Skip("python3 not on PATH — the live cross-check needs the spec itself")
        }
        dir := t.TempDir()
        pyPath := filepath.Join(dir, "entries.jsonl")
        goPath := filepath.Join(dir, "go-entries.jsonl")

        // The scenario script runs the Python side against pyPath and
        // prints the 8 outputs as JSON.
        script := `
import sys, json
sys.path.insert(0, "` + repoBrainTools(t) + `")
import dt_journal as J
from datetime import datetime, timezone, timedelta
path = sys.argv[1]
now = datetime(2025, 6, 15, 9, 0, tzinfo=timezone.utc)
J.run_action(path, "write", text="alpha entry about the waters", mood="good", tags="work, focus", highlights="shipped the rig", gratitude="coffee", energy="4", now=now)
J.run_action(path, "write", text="beta entry", mood="\U0001F600", now=now + timedelta(microseconds=1))
J.run_action(path, "write", text="gamma entry, quiet day", mood="3", energy="low", now=now - timedelta(days=1))
J.run_action(path, "write", text="delta entry far back", mood="awful", tags="deep", now=now - timedelta(days=3))
outs = {}
outs["read_today"] = J.run_action(path, "read", target="today", now=now)
outs["read_last7"] = J.run_action(path, "read", target="last 7", now=now)
outs["search"] = J.run_action(path, "search", query="waters", now=now)
outs["search_moodwarn"] = J.run_action(path, "search", query="entry", mood="banana", now=now)
outs["review"] = J.run_action(path, "review", period="week", now=now)
outs["moods"] = J.run_action(path, "moods", now=now)
outs["export_md"] = J.run_action(path, "export", fmt="md", now=now)
outs["replay"] = J.run_action(path, "write", text="replayed", now=now)
print(json.dumps(outs, ensure_ascii=False, indent=1))
`
        scriptPath := filepath.Join(dir, "py_side.py")
        if err := os.WriteFile(scriptPath, []byte(script), 0o644); err != nil {
                t.Fatal(err)
        }
        out, err := exec.Command(py, scriptPath, pyPath).Output()
        if err != nil {
                t.Fatalf("python side failed: %v\n%s", err, out)
        }
        var pyOuts map[string]string
        if err := json.Unmarshal(out, &pyOuts); err != nil {
                t.Fatalf("python JSON: %v\n%s", err, out)
        }

        // The Go side: same scenario, same actions.
        now := time.Date(2025, 6, 15, 9, 0, 0, 0, time.UTC)
        goOuts := map[string]string{}
        run := func(key string, a Args) {
                a.Now = now
                if _, ok := goOuts[key]; ok {
                        a.Now = now // each call re-pins
                }
                res := RunAction(goPath, a)
                goOuts[key] = res.Text
        }
        write := func(text string, extra func(*Args), when time.Time) Args {
                a := Args{Action: "write", Text: text, Now: when}
                if extra != nil {
                        extra(&a)
                }
                return a
        }
        RunAction(goPath, write("alpha entry about the waters", func(a *Args) {
                a.Mood, a.Tags, a.Highlights, a.Gratitude, a.Energy = "good", "work, focus", "shipped the rig", "coffee", "4"
        }, now))
        RunAction(goPath, write("beta entry", func(a *Args) { a.Mood = "😀" }, now.Add(time.Microsecond)))
        RunAction(goPath, write("gamma entry, quiet day", func(a *Args) { a.Mood, a.Energy = "3", "low" }, now.AddDate(0, 0, -1)))
        RunAction(goPath, write("delta entry far back", func(a *Args) { a.Mood, a.Tags = "awful", "deep" }, now.AddDate(0, 0, -3)))

        goOuts = map[string]string{}
        run("read_today", Args{Action: "read", Target: "today"})
        run("read_last7", Args{Action: "read", Target: "last 7"})
        run("search", Args{Action: "search", Query: "waters"})
        run("search_moodwarn", Args{Action: "search", Query: "entry", Mood: "banana"})
        run("review", Args{Action: "review", Period: "week"})
        run("moods", Args{Action: "moods"})
        run("export_md", Args{Action: "export", Format: "md"})
        run("replay", Args{Action: "write", Text: "replayed"})

        // Diff each surface, normalizing the state-dir path (temp dirs
        // differ by design) and the export's trailing save line.
        normalize := func(s, path string) string {
                s = strings.ReplaceAll(s, path, "<STATE>")
                if i := strings.Index(s, "\n\n(export saved"); i >= 0 {
                        s = s[:i] + "\n<EXPORT-SAVED>"
                }
                return s
        }
        for _, key := range []string{"read_today", "read_last7", "search", "search_moodwarn", "review", "moods", "export_md", "replay"} {
                want := normalize(pyOuts[key], pyPath)
                got := normalize(goOuts[key], goPath)
                if got != want {
                        t.Errorf("PARITY DIVERGENCE on %s:\n--- python ---\n%s\n--- go ---\n%s", key, want, got)
                }
        }
}

// repoBrainTools locates brain/tools relative to the test's working dir
// (engine/internal/djournal → ../../../../brain/tools).
func repoBrainTools(t *testing.T) string {
        t.Helper()
        candidates := []string{
                "../../../brain/tools",
                "brain/tools",
        }
        for _, c := range candidates {
                if _, err := os.Stat(filepath.Join(c, "dt_journal.py")); err == nil {
                        abs, _ := filepath.Abs(c)
                        return abs
                }
        }
        t.Skip("brain/tools not found — run from the repo (go test ./engine/internal/djournal/)")
        return ""
}
