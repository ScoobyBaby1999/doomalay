package djournal

// djournal_test.go — v1.47.1 THE JOURNAL HAND (PLAN-V147 §1): the
// ported self-test battery (the Python's offline __main__ suite, the
// dt_spec rule 7 law: temp dirs, no network) + the GO/PYTHON PARITY
// pins (banker's rounding, the calendar-day law, the JSON shape).
//
// The pinned `now` mirrors the Python self-test: 2025-06-15T09:00Z.

import (
        "encoding/json"
        "os"
        "path/filepath"
        "strings"
        "testing"
        "time"
)

func testNow() time.Time {
        return time.Date(2025, 6, 15, 9, 0, 0, 0, time.UTC)
}

func tmpJournal(t *testing.T) string {
        t.Helper()
        return filepath.Join(t.TempDir(), StateFile)
}

// ── the parity pins ─────────────────────────────────────────────────────────

func TestPyRoundBankersTies(t *testing.T) {
        // Python: round(2.5) == 2, round(3.5) == 4 (half to even);
        // Go's math.Round would give 3 and 4 — the divergence the port pins.
        cases := []struct{ in float64; want int }{
                {2.5, 2}, {3.5, 4}, {0.5, 0}, {1.5, 2}, {4.5, 4}, {2.4, 2}, {2.6, 3}, {-0.5, 0},
        }
        for _, c := range cases {
                if got := pyRound(c.in); got != c.want {
                        t.Errorf("pyRound(%v) = %d, want %d (Python banker's law)", c.in, got, c.want)
                }
        }
}

func TestMoodScaleTies(t *testing.T) {
        // 2.5 → pyRound → 2 (banker's), never 3.
        if got := moodScale(2.5); got == nil || *got != 2 {
                t.Errorf("moodScale(2.5) = %v, want 2", got)
        }
}

func TestParseDateOwnZoneLaw(t *testing.T) {
        // Python's .date() takes the timestamp's OWN-zone date part:
        // 2025-06-15T23:00-05:00 is June 15 locally, June 16 in UTC —
        // the parse must keep the LOCAL part.
        d := parseDateOrNone("2025-06-15T23:00:00-05:00")
        if d == nil {
                t.Fatal("parseDateOrNone returned nil")
        }
        if got := d.Format("2006-01-02"); got != "2025-06-15" {
                t.Errorf("own-zone date = %s, want 2025-06-15 (never the UTC-shifted day)", got)
        }
}

func TestPromptRotationNonNegative(t *testing.T) {
        // Python's modulo is non-negative; a hand-rolled doy can't crash.
        if len(pickPrompt(-1)) == 0 || len(pickPrompt(-46)) == 0 {
                t.Error("negative day-of-year must rotate, not crash")
        }
        if pickPrompt(200) != pickPrompt(200) {
                t.Error("prompt rotation must be deterministic")
        }
        if pickPrompt(200) == pickPrompt(201) {
                t.Error("adjacent days must differ (45-prompt cycle)")
        }
        if len(prompts) != 45 {
                t.Errorf("prompt bank = %d, want 45 (9 per category × 5)", len(prompts))
        }
}

// ── the ported Python self-test battery ─────────────────────────────────────

func TestHelp(t *testing.T) {
        out := RunAction(tmpJournal(t), Args{Action: "help", Now: testNow()})
        for _, want := range []string{"write", "review", "export"} {
                if !strings.Contains(out.Text, want) {
                        t.Errorf("help missing %q", want)
                }
        }
}

func TestWriteConfirmAndStreak(t *testing.T) {
        path := tmpJournal(t)
        out := RunAction(path, Args{Action: "write", Text: "first entry, testing the waters",
                Mood: "good", Tags: "test, meta", Now: testNow()})
        for _, want := range []string{"words", "streak", "good", "🙂"} {
                if !strings.Contains(out.Text, want) {
                        t.Errorf("write confirm missing %q: %s", want, out.Text)
                }
        }
}

func TestSameDateSuffixAndReplayDedup(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()

        // first write
        RunAction(path, Args{Action: "write", Text: "first entry", Now: now})
        // a second write on the SAME date needs a distinct created stamp
        // (production stamps carry sub-second precision — same key+text
        // below proves the replay case)
        out := RunAction(path, Args{Action: "write", Text: "second entry, same day",
                Now: now.Add(time.Microsecond)})
        if !strings.Contains(out.Text, "#2") {
                t.Errorf("same-date write must carry the #2 suffix: %s", out.Text)
        }
        if got := len(LoadEntries(path)); got != 2 {
                t.Fatalf("entries after two writes = %d, want 2", got)
        }

        // exact (date, created) replay → idempotent no-op, log does not grow
        out = RunAction(path, Args{Action: "write", Text: "replayed write, same stamp", Now: now})
        if !strings.Contains(out.Text, "Already saved") {
                t.Errorf("replay must answer 'Already saved': %s", out.Text)
        }
        if got := len(LoadEntries(path)); got != 2 {
                t.Errorf("replay appended a line: %d entries, want 2", got)
        }
}

func TestReadFlows(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "first entry, testing the waters", Now: now})
        RunAction(path, Args{Action: "write", Text: "second entry, same day", Now: now.Add(time.Microsecond)})

        out := RunAction(path, Args{Action: "read", Target: "today", Now: now})
        if !strings.Contains(out.Text, "first entry") || !strings.Contains(out.Text, "second entry") {
                t.Errorf("read today must show both entries: %s", out.Text)
        }
        out = RunAction(path, Args{Action: "read", Target: "bananas", Now: now})
        if !strings.Contains(out.Text, "couldn't parse") {
                t.Errorf("unparseable target must answer the honest parse error: %s", out.Text)
        }
        // the empty-day message
        out = RunAction(path, Args{Action: "read", Target: "2020-01-01", Now: now})
        if !strings.Contains(out.Text, "no entries for 2020-01-01") {
                t.Errorf("empty day must answer the friendly write hint: %s", out.Text)
        }
}

func TestSearchFlows(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "first entry, testing the waters",
                Tags: "deep", Now: now})

        out := RunAction(path, Args{Action: "search", Query: "waters", Now: now})
        if !strings.Contains(out.Text, "waters") || !strings.Contains(out.Text, "1 matching entry") {
                t.Errorf("search must hit with the count head: %s", out.Text)
        }
        if !strings.Contains(out.Text, ">> ") {
                t.Errorf("search text hits carry the grep-style >> context: %s", out.Text)
        }
        out = RunAction(path, Args{Action: "search", Query: "deep", InField: "tags", Now: now})
        if !strings.Contains(out.Text, "tags: #deep") {
                t.Errorf("field-scoped search must list the tag hit: %s", out.Text)
        }
        out = RunAction(path, Args{Action: "search", Query: "nothere", Now: now})
        if !strings.Contains(out.Text, "no matching entries") {
                t.Errorf("no-match must be honest: %s", out.Text)
        }
        // unrecognized mood filter → the warning, never a silent narrowing
        out = RunAction(path, Args{Action: "search", Query: "waters", Mood: "banana", Now: now})
        if !strings.Contains(out.Text, "not recognized — filter skipped") {
                t.Errorf("bad mood filter must warn: %s", out.Text)
        }
}

func TestReviewSummary(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "rough one", Mood: "low",
                Highlights: "survived the deadline", Gratitude: "coffee", Tags: "work", Now: now.AddDate(0, 0, -3)})
        RunAction(path, Args{Action: "write", Text: "better day", Mood: "great",
                Highlights: "the demo landed", Gratitude: "tea,quiet", Tags: "work,ship", Now: now.AddDate(0, 0, -1)})
        RunAction(path, Args{Action: "write", Text: "steady", Mood: "ok", Now: now})

        out := RunAction(path, Args{Action: "review", Period: "week", Now: now})
        for _, want := range []string{
                "Journal review — week (",
                "entries: 3",
                "avg mood:",
                "mood distribution:",
                "top tags: #work",
                "top highlights:",
                "gratitude items: 3",
                "best day:",
                "worst day:",
                "streak: 2d (longest 2d)", // days -3, -1, 0: the 06-12→06-14 gap breaks the run
        } {
                if !strings.Contains(out.Text, want) {
                        t.Errorf("review missing %q:\n%s", want, out.Text)
                }
        }
        // per-ENTRY average: (2+5+3)/3 = 3.3…
        if !strings.Contains(out.Text, "avg mood: 3.3/5") {
                t.Errorf("per-entry avg must be 3.3: %s", out.Text)
        }
        // unparseable period → honest error
        out = RunAction(path, Args{Action: "review", Period: "century", Now: now})
        if !strings.Contains(out.Text, "couldn't parse period") {
                t.Errorf("bad period must be honest: %s", out.Text)
        }
}

func TestMoodsTimeline(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "low day", Mood: "low", Now: now.AddDate(0, 0, -2)})
        RunAction(path, Args{Action: "write", Text: "two moods one day", Mood: "low", Now: now.AddDate(0, 0, -1)})
        RunAction(path, Args{Action: "write", Text: "second same-day", Mood: "great", Now: now.AddDate(0, 0, -1).Add(time.Minute)})
        RunAction(path, Args{Action: "write", Text: "today, moodless", Now: now})

        out := RunAction(path, Args{Action: "moods", Now: now})
        if !strings.Contains(out.Text, "🙂") {
                t.Errorf("timeline must render the avg glyph: %s", out.Text)
        }
        if !strings.Contains(out.Text, "timeline") {
                t.Errorf("timeline header missing: %s", out.Text)
        }
        // the multi-entry day carries the avg note; the moodless day shows 'no mood'
        if !strings.Contains(out.Text, "avg 3.5 over 2") {
                t.Errorf("multi-entry day must show 'avg 3.5 over 2': %s", out.Text)
        }
        if !strings.Contains(out.Text, "no mood") {
                t.Errorf("moodless day must still show: %s", out.Text)
        }
}

func TestExportRoundTrip(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "first entry, testing the waters",
                Mood: "good", Tags: "test", Now: now})
        RunAction(path, Args{Action: "write", Text: "second entry", Now: now.Add(time.Microsecond)})

        out := RunAction(path, Args{Action: "export", Format: "json", Now: now})
        if out.Export == nil {
                t.Fatal("export must carry the ExportPaths body")
        }
        body := out.Text
        if i := strings.Index(body, "\n\n(export saved"); i >= 0 {
                body = body[:i]
        }
        var rt []Entry
        if err := json.Unmarshal([]byte(body), &rt); err != nil {
                t.Fatalf("export JSON must round-trip: %v", err)
        }
        if len(rt) != 2 {
                t.Fatalf("round-trip = %d entries, want 2", len(rt))
        }
        if !strings.HasPrefix(rt[0].Text, "first") {
                t.Errorf("round-trip order must be oldest-first: %v", rt[0].Text)
        }
        if len(rt[0].Tags) != 1 || rt[0].Tags[0] != "test" {
                t.Errorf("round-trip tags = %v, want [test]", rt[0].Tags)
        }
        if rt[1].Mood != nil {
                t.Errorf("round-trip mood nil must stay null, got %v", *rt[1].Mood)
        }
        // the state-dir file exists
        if _, err := os.Stat(filepath.Join(filepath.Dir(path), "export.json")); err != nil {
                t.Errorf("export must write the state-dir file: %v", err)
        }
        // md export
        out = RunAction(path, Args{Action: "export", Format: "md", Now: now})
        if !strings.Contains(out.Text, "# doomalay journal export — 2 entries") {
                t.Errorf("md export header: %s", out.Text[:80])
        }
        if !strings.Contains(out.Text, "mood: 🙂 good 4/5") {
                t.Errorf("md export mood line: %s", out.Text)
        }
        // bad format
        out = RunAction(path, Args{Action: "export", Format: "pdf", Now: now})
        if !strings.Contains(out.Text, "export format must be md or json") {
                t.Errorf("bad format must be honest: %s", out.Text)
        }
}

func TestUnknownActionAndEmptyText(t *testing.T) {
        path := tmpJournal(t)
        out := RunAction(path, Args{Action: "frobnicate", Now: testNow()})
        if !strings.Contains(out.Text, "unknown action") {
                t.Errorf("unknown action must be honest: %s", out.Text)
        }
        out = RunAction(path, Args{Action: "write", Text: "   ", Now: testNow()})
        if !strings.Contains(out.Text, "text is required") {
                t.Errorf("empty text must be refused: %s", out.Text)
        }
}

func TestMoodScaleTable(t *testing.T) {
        cases := []struct {
                in   any
                want int  // -1 = nil
        }{
                {"4", 4}, {4, 4}, {4.0, 4}, {"😀", 5}, {"good", 4}, {"Ok", 3}, {"SO-SO", 3},
                {"mood: 😀.", 5}, {"9", -1}, {0, -1}, {"banana", -1}, {"", -1}, {nil, -1}, {true, -1},
                {"awful", 1}, {"under", 2}, {"mehh", 2},
        }
        for _, c := range cases {
                got := moodScale(c.in)
                if c.want == -1 {
                        if got != nil {
                                t.Errorf("moodScale(%v) = %d, want nil", c.in, *got)
                        }
                } else if got == nil || *got != c.want {
                        t.Errorf("moodScale(%v) = %v, want %d", c.in, got, c.want)
                }
        }
}

func TestCorruptLineSkipped(t *testing.T) {
        path := tmpJournal(t)
        if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
                t.Fatal(err)
        }
        // one good line, one corrupt tail (the kill-mid-append shape), one blank
        good := `{"id":"2025-06-15","date":"2025-06-15","created":"2025-06-15T09:00:00.000000+00:00","text":"survivor","mood":4,"tags":["x"],"highlights":[],"gratitude":[],"energy":null,"word_count":1}`
        if err := os.WriteFile(path, []byte(good+"\n{this is not json\n\n"), 0o644); err != nil {
                t.Fatal(err)
        }
        entries := LoadEntries(path)
        if len(entries) != 1 || entries[0].Text != "survivor" {
                t.Fatalf("corrupt line must be skipped: %d entries", len(entries))
        }
}

func TestLoadAppendRoundTrip(t *testing.T) {
        path := tmpJournal(t)
        now := testNow()
        for i, text := range []string{"alpha", "beta", "gamma"} {
                out := RunAction(path, Args{Action: "write", Text: text,
                        Date: now.AddDate(0, 0, -i).Format("2006-01-02"), Now: now.Add(time.Duration(i) * time.Hour)})
                if !strings.Contains(out.Text, "Saved journal entry") {
                        t.Fatalf("write %d failed: %s", i, out.Text)
                }
        }
        entries := LoadEntries(path)
        if len(entries) != 3 {
                t.Fatalf("append/load round-trip = %d, want 3", len(entries))
        }
        // streak across three consecutive days ending today
        if cur, _ := streaks(entries, now); cur != 3 {
                t.Errorf("3-day streak = %d, want 3", cur)
        }
}

func TestReplayCapAndFilePointer(t *testing.T) {
        path := tmpJournal(t)
        long := strings.Repeat("word ", 4000) // ~20KB > MaxOut
        out := RunAction(path, Args{Action: "write", Text: long, Now: testNow()})
        if !strings.Contains(out.Text, "Saved journal entry") {
                t.Fatalf("the long write must save: %s", out.Text[:100])
        }
        out = RunAction(path, Args{Action: "read", Target: "today", Now: testNow()})
        if len(out.Text) > MaxOut {
                t.Errorf("read must cap at MaxOut: %d", len(out.Text))
        }
        if !strings.Contains(out.Text, "(snipped — full text in entries.jsonl)") {
                t.Errorf("the snip must point at the file: %s", out.Text[:200])
        }
}

func TestStreakYesterdayGrace(t *testing.T) {
        // an unwritten TODAY mid-evening must not zero a live streak that
        // ended yesterday (the user is about to extend it).
        path := tmpJournal(t)
        now := testNow()
        RunAction(path, Args{Action: "write", Text: "yesterday only", Now: now.AddDate(0, 0, -1)})
        entries := LoadEntries(path)
        if cur, longest := streaks(entries, now); cur != 1 || longest != 1 {
                t.Errorf("yesterday-grace streak = %d/%d, want 1/1", cur, longest)
        }
        // two days back without today/yesterday → 0 current, 2 longest
        path2 := tmpJournal(t)
        RunAction(path2, Args{Action: "write", Text: "two ago", Date: now.AddDate(0, 0, -2).Format("2006-01-02"), Now: now})
        RunAction(path2, Args{Action: "write", Text: "three ago", Date: now.AddDate(0, 0, -3).Format("2006-01-02"), Now: now})
        if cur, longest := streaks(LoadEntries(path2), now); cur != 0 || longest != 2 {
                t.Errorf("aged streak = %d/%d, want 0/2", cur, longest)
        }
}

func TestDaysSinceLastClamp(t *testing.T) {
        now := testNow()
        // future-dated entry (clock skew) reports 0d, never negative
        entries := []Entry{{Date: now.AddDate(0, 0, 2).Format("2006-01-02")}}
        d := daysSinceLast(entries, now)
        if d == nil || *d != 0 {
                t.Errorf("future-dated daysSinceLast = %v, want 0", d)
        }
        if daysSinceLast(nil, now) != nil {
                t.Error("empty journal daysSinceLast must be nil")
        }
}

func TestPromptAction(t *testing.T) {
        out := RunAction(tmpJournal(t), Args{Action: "prompt", Now: testNow()})
        if !strings.Contains(out.Text, "[") || !strings.Contains(out.Text, "45 in rotation") {
                t.Errorf("prompt action shape: %s", out.Text)
        }
}

func TestBarShape(t *testing.T) {
        // 5 glyph columns always; zero counts render blank; the scaling
        // honors banker's rounding (1 of mx 10 → 0.5 → Python round → 0 → blank)
        got := []rune(bar([]int{0, 1, 2, 3, 10}))
        if len(got) != 5 {
                t.Fatalf("bar columns = %d, want 5", len(got))
        }
        if got[0] != ' ' {
                t.Errorf("zero count must render blank, got %q", got[0])
        }
        if got[4] != '▅' {
                t.Errorf("the max bucket must render full height, got %q", got[4])
        }
        if got[1] != ' ' { // 1/10*5 = 0.5 → banker's → 0 → blank (Python parity)
                t.Errorf("the 0.5 tie must round to even (blank), got %q", got[1])
        }
}

func TestJSONShapeMatchesPython(t *testing.T) {
        // The marshaled entry must speak the Python dict's exact key order
        // and null/[] semantics — a brain-written file and an engine-written
        // one read identically.
        m := 4
        e := Entry{ID: "2025-06-15", Date: "2025-06-15", Created: "2025-06-15T09:00:00.000000+00:00",
                Text: "t", Mood: &m, Tags: []string{}, Highlights: []string{}, Gratitude: []string{},
                Energy: nil, WordCount: 1}
        b, _ := json.Marshal(e)
        want := `{"id":"2025-06-15","date":"2025-06-15","created":"2025-06-15T09:00:00.000000+00:00","text":"t","mood":4,"tags":[],"highlights":[],"gratitude":[],"energy":null,"word_count":1}`
        if string(b) != want {
                t.Errorf("JSON shape:\n got %s\nwant %s", b, want)
        }
}
