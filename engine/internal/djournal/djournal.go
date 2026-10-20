// Package djournal — v1.47.1 THE JOURNAL HAND (PLAN-V147 §1).
//
// The authentic Go port of brain/tools/dt_journal.py (the doomalay
// journal, "d" for doomalay): moods, tags, daily highlights, gratitude,
// energy, streaks, retrospective summaries, and rotating journaling
// prompts — the rich journal the old app had, NOT the bare-bones
// text-file-with-a-datestamp. The Python core is the spec: every plain
// function ports function-by-function with the same grammar, the same
// edge-case laws, and the same reply shapes, so a user who journaled
// through the brain sees the same soul on the engine.
//
// THE PARITY LAWS (researched + pinned by test):
//   - Python round() is BANKER'S ROUNDING (half-to-even); Go's
//     math.Round is half-away-from-zero. pyRound below is the Python
//     law — the moods timeline's per-day average and the review's mood
//     distribution bar use it, or glyphs/blocks silently diverge on
//     exact .5 ties (avg 2.5 → Python 2 "low", Go 3 "ok").
//   - Python's modulo is non-negative for negative inputs; the prompt
//     rotation normalizes so a hand-rolled day-of-year can't crash.
//   - Python's .date() takes the timestamp's OWN-zone date part (never
//     the UTC-shifted one) — parseDateOrNone keeps the same law.
//   - Corrupt JSONL lines are SKIPPED, never fatal (an append-only log
//     must survive a kill mid-append — a truncated tail costs one entry,
//     not the journal).
//
// State: <DataDir>/journal/entries.jsonl — append-only, one JSON entry
// per line. ONE journal per install: a diary is not per-chat. The
// dedup key is (date, created): an exact replay is an idempotent no-op,
// a fresh write on an already-written date appends with a "#2" id so
// multi-entry days stay addressable everywhere.
package djournal

import (
        "encoding/json"
        "fmt"
        "math"
        "os"
        "path/filepath"
        "regexp"
        "sort"
        "strconv"
        "strings"
        "time"
)

// State file name (append-only log: one JSON entry per line).
const StateFile = "entries.jsonl"

// dt_spec rule 9: model-facing replies stay bounded; per-entry text cap
// in `read`; per-line cap in `search` context output; `moods` timeline
// day cap.
const (
        MaxOut      = 6000
        textSnip    = 700
        lineSnip    = 160
        timelineCap = 60
)

// ── the mood scale ──────────────────────────────────────────────────────────
//
// The old journal let people type anything — "4", "😀", "good", "Ok" —
// and stored the mess verbatim, which made aggregation impossible.
// Every input normalizes to ONE int 1..5 (nil = unusable) so review
// math, mood filters, and timelines never see strings. Order matters:
// numbers beat words beat emoji; the first emoji in a mixed string
// wins; bools are rejected explicitly (never guess: a silently-wrong
// mood poisons every average built on it).

var moodWords = map[string]int{
        // 5 — top of the scale
        "great": 5, "amazing": 5, "awesome": 5, "excellent": 5, "wonderful": 5,
        "best": 5, "perfect": 5,
        // 4
        "good": 4, "fine": 4, "happy": 4, "nice": 4, "solid": 4, "better": 4,
        // 3
        "ok": 3, "okay": 3, "meh": 3, "average": 3, "neutral": 3, "soso": 3,
        "so-so": 3, "alright": 3,
        // 2
        "low": 2, "down": 2, "sad": 2, "tired": 2, "sluggish": 2, "rough": 2,
        "mehh": 2, "under": 2,
        // 1
        "awful": 1, "terrible": 1, "horrible": 1, "bad": 1, "worst": 1,
        "drained": 1, "miserable": 1,
}

var moodEmoji = map[string]int{
        "🤩": 5, "😍": 5, "🥳": 5, "😄": 5, "😀": 5, "😁": 5, "🔥": 5, "✨": 5,
        "🙂": 4, "😊": 4, "👍": 4, "😌": 4, "😃": 4, "😅": 4,
        "😐": 3, "😑": 3, "🤔": 3, "😬": 3,
        "🙁": 2, "😕": 2, "😔": 2, "😪": 2, "😞": 2, "🙃": 2,
        "😢": 1, "😭": 1, "😩": 1, "😫": 1, "🥲": 1, "☹": 1, "💔": 1,
}

var moodLabels = map[int]string{5: "great", 4: "good", 3: "ok", 2: "low", 1: "awful"}
var moodGlyphs = map[int]string{5: "😀", 4: "🙂", 3: "😐", 2: "🙁", 1: "😢"}

// Unicode block bar for the review's mood distribution: index 0 renders
// a ZERO count (blank), 1..5 are ▁▂▃▄▅ scaled to the max bucket. RUNES,
// not bytes — the glyphs are multi-byte UTF-8.
var blockRunes = []rune(" ▁▂▃▄▅")

// 'last 7' / 'last 7 days' / 'last 7 day' — one grammar shared by
// read/moods/export ranges and review periods.
var lastRe = regexp.MustCompile(`(?i)^last\s+(\d+)\s*(days?)?$`)

// pyRound is Python's round() — banker's rounding (half to even) —
// because the core's spec IS the Python. math.Round is half-AWAY-from-
// zero and diverges on exact .5 ties.
func pyRound(v float64) int {
        if math.IsNaN(v) || math.IsInf(v, 0) {
                return 0
        }
        f := math.Floor(v)
        diff := v - f
        switch {
        case diff > 0.5:
                return int(f) + 1
        case diff < 0.5:
                return int(f)
        default: // the exact tie: to even
                if int(f)%2 == 0 {
                        return int(f)
                }
                return int(f) + 1
        }
}

// moodScale normalizes any user-supplied mood to an int 1..5, else nil.
// Python: numbers beat words beat emoji; out-of-range numbers are nil —
// clamping would invent data the user never gave.
func moodScale(mood any) *int {
        if mood == nil {
                return nil
        }
        if _, isBool := mood.(bool); isBool {
                return nil // Python: bools are rejected explicitly
        }
        if f, ok := toFloat(mood); ok {
                return clampMood(pyRound(f))
        }
        s, isStr := mood.(string)
        if !isStr {
                s = fmt.Sprintf("%v", mood)
        }
        s = strings.TrimSpace(s)
        if s == "" {
                return nil
        }
        if f, err := strconv.ParseFloat(s, 64); err == nil {
                return clampMood(pyRound(f))
        }
        low := strings.ToLower(s)
        if v, ok := moodWords[low]; ok {
                return &v
        }
        if v, ok := moodEmoji[s]; ok {
                return &v
        }
        for _, r := range s { // first emoji anywhere in the string
                if v, ok := moodEmoji[string(r)]; ok {
                        return &v
                }
        }
        return nil
}

// toFloat accepts JSON numbers in every encoding shape.
func toFloat(v any) (float64, bool) {
        switch n := v.(type) {
        case float64:
                return n, true
        case float32:
                return float64(n), true
        case int:
                return float64(n), true
        case int64:
                return float64(n), true
        case json.Number:
                f, err := n.Float64()
                return f, err == nil
        }
        return 0, false
}

func clampMood(v int) *int {
        if v < 1 || v > 5 {
                return nil
        }
        return &v
}

func moodStr(v *int) string {
        if v == nil {
                return "—"
        }
        g := "?"
        if s, ok := moodGlyphs[*v]; ok {
                g = s
        }
        l := "?"
        if s, ok := moodLabels[*v]; ok {
                l = s
        }
        return fmt.Sprintf("%s %s %d/5", g, l, *v)
}

// splitWords is Python's text.split() (arbitrary whitespace, no empties).
func splitWords(s string) []string { return strings.Fields(s) }

// ── the entry ───────────────────────────────────────────────────────────────

// Entry is one journal entry. The JSON field order matches the Python
// original's dict so a brain-written entries.jsonl and an engine-written
// one read identically; Mood/Energy are pointers so null round-trips;
// the three lists normalize to [] (never null) so the Python's
// json.dumps shape holds byte-for-byte on the wire.
type Entry struct {
        ID         string   `json:"id"`
        Date       string   `json:"date"`
        Created    string   `json:"created"`
        Text       string   `json:"text"`
        Mood       *int     `json:"mood"`
        Tags       []string `json:"tags"`
        Highlights []string `json:"highlights"`
        Gratitude  []string `json:"gratitude"`
        Energy     *int     `json:"energy"`
        WordCount  int      `json:"word_count"`
}

// normalize fixes nils after an unmarshal (a hand-edited or foreign
// line may omit keys — the Python shape always emits the three lists).
func (e Entry) normalize() Entry {
        if e.Tags == nil {
                e.Tags = []string{}
        }
        if e.Highlights == nil {
                e.Highlights = []string{}
        }
        if e.Gratitude == nil {
                e.Gratitude = []string{}
        }
        return e
}

// asList mirrors _as_list: comma/newline/semicolon-separated strings
// become lists; real lists pass through; leading '#' is stripped so
// "#work" and "work" are the same tag.
func asList(v any) []string {
        out := []string{}
        add := func(raw any) {
                it := strings.TrimSpace(fmt.Sprintf("%v", raw))
                it = strings.TrimPrefix(it, "#")
                it = strings.TrimSpace(it)
                if it != "" {
                        out = append(out, it)
                }
        }
        switch items := v.(type) {
        case nil:
                return out
        case []string:
                for _, it := range items {
                        add(it)
                }
        case []any:
                for _, it := range items {
                        add(it)
                }
        default:
                for _, it := range splitAny(fmt.Sprintf("%v", v)) {
                        add(it)
                }
        }
        return out
}

// splitAny splits on Python's re.split(r"[,;\n]").
func splitAny(s string) []string {
        return strings.FieldsFunc(s, func(r rune) bool {
                return r == ',' || r == ';' || r == '\n'
        })
}

// ── write: addEntry (the one mutation in the core) ─────────────────────────

// addEntry validates + appends one journal entry to an in-memory slice.
// created=false means the exact (date, created) key already existed — a
// replayed write — and the EXISTING entry returns with the slice
// untouched (idempotent retries per the state contract). A same-date
// write with a FRESH created stamp is not a dup: it appends, and its id
// gets the suffix marker ("2026-06-15#2") so a day with several entries
// stays addressable.
func addEntry(entries []Entry, f map[string]any, now time.Time) (Entry, bool, error) {
        text := strings.TrimSpace(strOr(f, "text"))
        if text == "" {
                return Entry{}, false, fmt.Errorf("text is required — a journal entry needs words")
        }

        var day time.Time
        rawDate := strOr(f, "date")
        if rawDate == "" {
                day = utcDay(now)
        } else {
                d := parseDateOrNone(rawDate)
                if d == nil {
                        return Entry{}, false, fmt.Errorf("date '%s' is not an ISO date (YYYY-MM-DD)", rawDate)
                }
                day = *d
        }

        var created time.Time
        rawCreated := strOr(f, "created")
        if rawCreated == "" {
                created = now.UTC()
        } else {
                c := parseISODT(rawCreated)
                if c == nil {
                        return Entry{}, false, fmt.Errorf("created '%s' is not an ISO datetime", rawCreated)
                }
                created = *c
        }

        dateS := day.Format("2006-01-02")
        createdS := created.Format("2006-01-02T15:04:05.000000-07:00") // the Python isoformat shape
        for _, e := range entries { // exact (date, created) replay → no-op
                if e.Date == dateS && e.Created == createdS {
                        return e, false, nil
                }
        }

        sameDay := 0
        for _, e := range entries {
                if e.Date == dateS {
                        sameDay++
                }
        }
        id := dateS
        if sameDay > 0 {
                id = fmt.Sprintf("%s#%d", dateS, sameDay+1)
        }
        entry := Entry{
                ID:         id,
                Date:       dateS,
                Created:    createdS,
                Text:       text,
                Mood:       moodScale(f["mood"]),
                Tags:       asList(f["tags"]),
                Highlights: asList(f["highlights"]),
                Gratitude:  asList(f["gratitude"]),
                Energy:     moodScale(f["energy"]),
                WordCount:  len(splitWords(text)),
        }
        return entry, true, nil
}

func strOr(m map[string]any, key string) string {
        v, ok := m[key]
        if !ok || v == nil {
                return ""
        }
        if s, ok := v.(string); ok {
                return s
        }
        return fmt.Sprintf("%v", v)
}

// utcDay truncates to the UTC calendar day (Python's now.date()).
func utcDay(t time.Time) time.Time {
        return t.UTC().Truncate(24 * time.Hour)
}

// ── streaks (global history, not period-scoped) ─────────────────────────────

// streaks returns (current, longest) writing streaks, in days. current
// counts the consecutive-day run ending today — or ending YESTERDAY
// (grace: an unwritten *today* mid-evening must not zero a streak the
// user is about to extend) — else 0. Multiple entries on one day count
// once: it is a DAY streak. Unparseable stored dates break runs
// instead of crashing.
func streaks(entries []Entry, now time.Time) (int, int) {
        seen := map[string]bool{}
        days := []string{}
        for _, e := range entries {
                if e.Date != "" && !seen[e.Date] {
                        seen[e.Date] = true
                        days = append(days, e.Date)
                }
        }
        if len(days) == 0 {
                return 0, 0
        }
        sort.Strings(days) // ISO strings sort chronologically
        longest, run := 1, 1
        for i := 1; i < len(days); i++ {
                if dayGap(days[i-1], days[i]) == 1 {
                        run++
                } else {
                        run = 1
                }
                if run > longest {
                        longest = run
                }
        }
        today := utcDay(now)
        if seen[today.Format("2006-01-02")] {
                // anchor = today
        } else if seen[today.AddDate(0, 0, -1).Format("2006-01-02")] {
                today = today.AddDate(0, 0, -1)
        } else {
                return 0, longest
        }
        current := 0
        for seen[today.Format("2006-01-02")] {
                current++
                today = today.AddDate(0, 0, -1)
        }
        return current, longest
}

// dayGap is the whole-day distance a→b; 999 = unparseable (breaks runs).
func dayGap(a, b string) int {
        da, db := parseDateOrNone(a), parseDateOrNone(b)
        if da == nil || db == nil {
                return 999
        }
        return int(db.Sub(*da).Hours() / 24)
}

// daysSinceLast is whole days from the newest entry to now (nil =
// journal empty). Clamped at 0 so a future-dated entry reports '0d ago'.
func daysSinceLast(entries []Entry, now time.Time) *int {
        newest := ""
        for _, e := range entries {
                if e.Date != "" && e.Date > newest {
                        newest = e.Date
                }
        }
        if newest == "" {
                return nil
        }
        d := parseDateOrNone(newest)
        if d == nil {
                return nil
        }
        days := int(utcDay(now).Sub(*d).Hours() / 24)
        if days < 0 {
                days = 0
        }
        return &days
}

// ── time helpers ────────────────────────────────────────────────────────────

// parseISODT is a best-effort ISO-8601 datetime parse ('Z' tolerated) →
// nil on garbage. Never errors: stored/typed timestamps are untrusted.
func parseISODT(s string) *time.Time {
        s = strings.TrimSpace(s)
        if s == "" {
                return nil
        }
        if s[len(s)-1] == 'Z' || s[len(s)-1] == 'z' {
                s = s[:len(s)-1] + "+00:00"
        }
        for _, layout := range []string{
                "2006-01-02T15:04:05.999999999-07:00",
                "2006-01-02T15:04:05.999999999Z07:00",
                "2006-01-02T15:04:05-07:00",
                "2006-01-02T15:04:05Z07:00",
                "2006-01-02T15:04:05.999999999",
                "2006-01-02T15:04:05",
                "2006-01-02 15:04:05",
        } {
                if t, err := time.Parse(layout, s); err == nil {
                        return &t
                }
        }
        return nil
}

// parseDateOrNone takes an ISO date (or a full datetime — the date part
// in the timestamp's OWN zone, Python's .date() law, never the
// UTC-shifted one).
func parseDateOrNone(s string) *time.Time {
        s = strings.TrimSpace(s)
        if t, err := time.Parse("2006-01-02", s); err == nil {
                return &t
        }
        if t := parseISODT(s); t != nil {
                if d, err := time.Parse("2006-01-02", t.Format("2006-01-02")); err == nil {
                        return &d
                }
        }
        return nil
}

// ── range parsing (read / moods / export / search filter) ───────────────────

type dateRange struct {
        start, end time.Time
}

// parseRange parses a date spec into an INCLUSIVE (start, end) window,
// or ok=false. Accepts: 'today', 'yesterday', an ISO date, 'A..B'
// ('...' tolerated, reversed bounds swapped), 'last N', 'week'/'month'
// (rolling 7/30 — the same window a review shows).
func parseRange(spec string, now time.Time) (dateRange, bool) {
        s := strings.TrimSpace(spec)
        if s == "" {
                return dateRange{}, false
        }
        low := strings.ToLower(s)
        today := utcDay(now)
        switch low {
        case "today":
                return dateRange{today, today}, true
        case "yesterday":
                y := today.AddDate(0, 0, -1)
                return dateRange{y, y}, true
        case "week", "this week":
                return dateRange{today.AddDate(0, 0, -6), today}, true
        case "month", "this month":
                return dateRange{today.AddDate(0, 0, -29), today}, true
        }
        if m := lastRe.FindStringSubmatch(low); m != nil {
                n, _ := strconv.Atoi(m[1])
                if n < 1 {
                        n = 1
                }
                return dateRange{today.AddDate(0, 0, -(n - 1)), today}, true
        }
        if strings.Contains(s, "..") {
                parts := strings.SplitN(s, "..", 2)
                b := strings.TrimLeft(parts[1], ".") // tolerate 'A...B'
                da := parseDateOrNone(strings.TrimSpace(parts[0]))
                db := parseDateOrNone(strings.TrimSpace(b))
                if da != nil && db != nil {
                        if da.After(*db) {
                                da, db = db, da
                        }
                        return dateRange{*da, *db}, true
                }
                return dateRange{}, false
        }
        if d := parseDateOrNone(s); d != nil {
                return dateRange{*d, *d}, true
        }
        return dateRange{}, false
}

// parsePeriod is review's period grammar → (start, end, label).
// 'week' | 'month' | 'last N days' | bare 'N'. Rolling windows ending
// today, labelled for the header line.
func parsePeriod(period string, now time.Time) (dateRange, string, bool) {
        s := strings.ToLower(strings.TrimSpace(period))
        var days int
        var label string
        switch s {
        case "", "week", "weekly", "this week":
                days, label = 7, "week"
        case "month", "monthly", "this month":
                days, label = 30, "month"
        default:
                if m := lastRe.FindStringSubmatch(s); m != nil {
                        days, _ = strconv.Atoi(m[1])
                        if days < 1 {
                                days = 1
                        }
                        label = fmt.Sprintf("last %d days", days)
                } else if n, err := strconv.Atoi(s); err == nil {
                        if n < 1 {
                                n = 1
                        }
                        days = n
                        label = fmt.Sprintf("last %d days", days)
                } else {
                        return dateRange{}, "", false
                }
        }
        end := utcDay(now)
        return dateRange{end.AddDate(0, 0, -(days - 1)), end}, label, true
}

func entriesInRange(entries []Entry, start, end time.Time) []Entry {
        var out []Entry
        for _, e := range entries {
                d := parseDateOrNone(e.Date)
                if d != nil && !d.Before(start) && !d.After(end) {
                        out = append(out, e)
                }
        }
        return out
}

// ── read ────────────────────────────────────────────────────────────────────

// windowSorted: entries inside an inclusive window, oldest-first,
// sorted by (date, created) so same-day entries read in write order
// (#1 before #2 — a hand-edited log might not be chronological).
func windowSorted(entries []Entry, rng dateRange) []Entry {
        window := entriesInRange(entries, rng.start, rng.end)
        sort.SliceStable(window, func(i, j int) bool {
                if window[i].Date != window[j].Date {
                        return window[i].Date < window[j].Date
                }
                return window[i].Created < window[j].Created
        })
        return window
}

// fmtEntry renders one entry as a compact card. Long text is snipped
// per-entry with a pointer at entries.jsonl — the file is the source of
// truth, the chat is a preview.
func fmtEntry(e Entry) string {
        d := e.Date
        if d == "" {
                d = "?"
        }
        when := ""
        if dd := parseDateOrNone(d); dd != nil {
                when = dd.Format("Mon")
        }
        if cd := parseISODT(e.Created); cd != nil {
                tm := cd.UTC().Format("15:04")
                if when != "" {
                        when += " " + tm
                } else {
                        when = tm
                }
        }
        var b strings.Builder
        head := fmt.Sprintf("── %s", d)
        if e.ID != "" {
                head = fmt.Sprintf("── %s", e.ID)
        }
        if when != "" {
                head += " · " + when
        }
        b.WriteString(head + " ──\n")
        en := "—"
        if e.Energy != nil {
                en = fmt.Sprintf("%d/5", *e.Energy)
        }
        wc := e.WordCount
        if wc == 0 {
                wc = len(splitWords(e.Text))
        }
        b.WriteString(fmt.Sprintf("mood %s · energy %s · %d words\n", moodStr(e.Mood), en, wc))
        text := e.Text
        if len(text) > textSnip {
                text = text[:textSnip] + " …(snipped — full text in entries.jsonl)"
        }
        b.WriteString(text)
        if len(e.Tags) > 0 {
                tags := make([]string, len(e.Tags))
                for i, t := range e.Tags {
                        tags[i] = "#" + t
                }
                b.WriteString("\ntags: " + strings.Join(tags, " "))
        }
        if len(e.Highlights) > 0 {
                b.WriteString("\nhighlights: " + strings.Join(e.Highlights, " · "))
        }
        if len(e.Gratitude) > 0 {
                b.WriteString("\ngratitude: " + strings.Join(e.Gratitude, " · "))
        }
        return b.String()
}

func plural(n int, one, many string) string {
        if n == 1 {
                return fmt.Sprintf("%d %s", n, one)
        }
        return fmt.Sprintf("%d %s", n, many)
}

func renderWindow(window []Entry, rng dateRange, spec string) string {
        n := len(window)
        span := rng.start.Format("2006-01-02")
        if !rng.start.Equal(rng.end) {
                span = rng.start.Format("2006-01-02") + ".." + rng.end.Format("2006-01-02")
        }
        head := fmt.Sprintf("%s · %s", plural(n, "entry", "entries"), span)
        if spec != "" && spec != span {
                head += " · " + spec
        }
        lines := []string{head}
        for _, e := range window {
                lines = append(lines, "", fmtEntry(e))
        }
        return strings.Join(lines, "\n")
}

func readEntries(entries []Entry, target string, now time.Time) string {
        spec := strings.TrimSpace(target)
        if spec == "" {
                spec = "today" // 'what did I write' → today
        }
        rng, ok := parseRange(spec, now)
        if !ok {
                return "djournal: couldn't parse date/range '" + spec + "'. Try a date (2026-06-15), today, yesterday, '2026-06-01..2026-06-30', or 'last 7'."
        }
        window := windowSorted(entries, rng)
        if len(window) == 0 {
                return "no entries for " + spec + " (" + rng.start.Format("2006-01-02") + ".." + rng.end.Format("2006-01-02") + "). Write one: djournal(action='write', text='...', mood='...')"
        }
        return renderWindow(window, rng, spec)
}

// ── search ──────────────────────────────────────────────────────────────────

// textContext: grep-style context lines — the matching line plus one
// neighbour each side, the hit itself prefixed '>>'. Merged
// neighbourhoods collapse so a dense cluster doesn't repeat lines.
func textContext(text, ql string) []string {
        lines := splitLines(text)
        if len(lines) == 0 {
                lines = []string{text}
        }
        shown := map[int]string{}
        hitIdx := []int{}
        for i, ln := range lines {
                if strings.Contains(strings.ToLower(ln), ql) {
                        hitIdx = append(hitIdx, i)
                }
        }
        for _, i := range hitIdx {
                lo, hi := i-1, i+1
                if lo < 0 {
                        lo = 0
                }
                if hi > len(lines)-1 {
                        hi = len(lines) - 1
                }
                for j := lo; j <= hi; j++ {
                        if _, ok := shown[j]; !ok {
                                prefix := "   "
                                if j == i {
                                        prefix = ">> "
                                }
                                shown[j] = prefix + snip(strings.TrimSpace(lines[j]), lineSnip)
                        }
                }
        }
        if len(shown) == 0 { // single-line text fallback
                return []string{">> " + snip(text, lineSnip)}
        }
        keys := make([]int, 0, len(shown))
        for k := range shown {
                keys = append(keys, k)
        }
        sort.Ints(keys)
        out := make([]string, 0, len(keys))
        for _, k := range keys {
                out = append(out, shown[k])
        }
        return out
}

func splitLines(s string) []string {
        if s == "" {
                return nil
        }
        return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}

func snip(s string, n int) string {
        if len(s) <= n {
                return s
        }
        return s[:n]
}

type fieldMatch struct {
        text       []string
        tags       []string
        highlights []string
        gratitude  []string
}

// matchEntry: which parts of an entry match; 'all' unions the four
// searchable fields (gratitude included — it's real journal content the
// old app's search skipped).
func matchEntry(e Entry, ql, field string) fieldMatch {
        var m fieldMatch
        which := []string{field}
        if field == "all" {
                which = []string{"text", "tags", "highlights", "gratitude"}
        }
        for _, f := range which {
                switch f {
                case "text":
                        if strings.Contains(strings.ToLower(e.Text), ql) {
                                m.text = textContext(e.Text, ql)
                        }
                case "tags":
                        for _, x := range e.Tags {
                                if strings.Contains(strings.ToLower(x), ql) {
                                        m.tags = append(m.tags, x)
                                }
                        }
                case "highlights":
                        for _, x := range e.Highlights {
                                if strings.Contains(strings.ToLower(x), ql) {
                                        m.highlights = append(m.highlights, x)
                                }
                        }
                case "gratitude":
                        for _, x := range e.Gratitude {
                                if strings.Contains(strings.ToLower(x), ql) {
                                        m.gratitude = append(m.gratitude, x)
                                }
                        }
                }
        }
        return m
}

// searchEntries: case-insensitive substring matching with context lines,
// optional mood filter and date window. Bad field names and
// unparseable moods produce a warning line instead of silently narrowing
// (a filter the model THINKS applied but didn't is worse than a warning).
func searchEntries(entries []Entry, query, inField string, mood any, dateRangeSpec string, now time.Time) string {
        q := strings.TrimSpace(query)
        if q == "" {
                return "djournal: search needs a query (searches text, tags, highlights, and gratitude)."
        }
        fieldMap := map[string]string{
                "": "all", "all": "all", "any": "all",
                "text": "text", "body": "text",
                "tags": "tags", "tag": "tags",
                "highlights": "highlights", "highlight": "highlights",
                "gratitude": "gratitude", "grateful": "gratitude",
        }
        field, ok := fieldMap[strings.ToLower(strings.TrimSpace(inField))]
        if !ok {
                return "djournal: in_field must be text|tags|highlights|gratitude|all, got '" + inField + "'."
        }
        var wantMood *int
        moodWarn := ""
        if mood != nil {
                if s, isStr := mood.(string); !isStr || strings.TrimSpace(s) != "" {
                        wantMood = moodScale(mood)
                        if wantMood == nil {
                                moodWarn = "\n(mood '" + toRawString(mood) + "' not recognized — filter skipped; use 1-5, great/good/ok/low/awful, or an emoji)"
                        }
                }
        }
        var rng *dateRange
        if s := strings.TrimSpace(dateRangeSpec); s != "" {
                r, okR := parseRange(s, now)
                if !okR {
                        return "djournal: couldn't parse date_range '" + dateRangeSpec + "'. Try '2026-06-01..2026-06-30' or 'last 7'."
                }
                rng = &r
        }
        ql := strings.ToLower(q)
        type hit struct {
                e Entry
                m fieldMatch
        }
        var blocks []hit
        for _, e := range entries {
                if rng != nil {
                        d := parseDateOrNone(e.Date)
                        if d == nil || d.Before(rng.start) || d.After(rng.end) {
                                continue
                        }
                }
                if wantMood != nil {
                        if e.Mood == nil || *e.Mood != *wantMood {
                                continue
                        }
                }
                m := matchEntry(e, ql, field)
                if len(m.text)+len(m.tags)+len(m.highlights)+len(m.gratitude) > 0 {
                        blocks = append(blocks, hit{e, m})
                }
        }
        if len(blocks) == 0 {
                return "no matching entries for '" + q + "' in " + field + " (" +
                        plural(len(entries), "entry", "entries") + " searched)" + moodWarn
        }
        body := []string{fmt.Sprintf("%s for '%s' in %s · %d searched",
                plural(len(blocks), "matching entry", "matching entries"), q, field, len(entries))}
        if moodWarn != "" {
                body = append(body, strings.TrimSpace(moodWarn))
        }
        for _, b := range blocks {
                id := b.e.ID
                if id == "" {
                        id = b.e.Date
                        if id == "" {
                                id = "?"
                        }
                }
                body = append(body, "", fmt.Sprintf("── %s (%s) ──", id, moodStr(b.e.Mood)))
                if len(b.m.text) > 0 {
                        body = append(body, b.m.text...)
                }
                if len(b.m.tags) > 0 {
                        prefixed := make([]string, len(b.m.tags))
                        for i, x := range b.m.tags {
                                prefixed[i] = "#" + x
                        }
                        body = append(body, "tags: "+strings.Join(prefixed, ", "))
                }
                if len(b.m.highlights) > 0 {
                        body = append(body, "highlights: "+strings.Join(b.m.highlights, ", "))
                }
                if len(b.m.gratitude) > 0 {
                        body = append(body, "gratitude: "+strings.Join(b.m.gratitude, ", "))
                }
        }
        return strings.Join(body, "\n")
}

// ── review ──────────────────────────────────────────────────────────────────

// bar renders the mood distribution as 5 unicode block columns (levels
// 1..5), heights scaled to the busiest level; zero counts render blank.
// len == 5 always. The scaling uses pyRound — Python's round — so the
// bar matches the brain's on ties.
func bar(counts []int) string {
        mx := 0
        for _, c := range counts {
                if c > mx {
                        mx = c
                }
        }
        if mx == 0 {
                mx = 1
        }
        out := make([]rune, 0, 5)
        for _, c := range counts {
                out = append(out, blockRunes[pyRound(float64(c)/float64(mx)*5)])
        }
        return string(out)
}

// reviewSummary: the computed weekly/monthly retrospective.
// avg mood is per-ENTRY (mood is felt per entry); the trend compares
// against the previous EQUAL-LENGTH window (±0.2 dead zone); streaks +
// days-since-last are computed over the WHOLE history — a weekly review
// that reset the streak would lie; top highlights pull from the
// best-mood entries first.
func reviewSummary(entries []Entry, period string, now time.Time) string {
        rng, label, ok := parsePeriod(period, now)
        if !ok {
                return "djournal: couldn't parse period '" + period + "'. Use week, month, or 'last N days'."
        }
        window := entriesInRange(entries, rng.start, rng.end)
        words := 0
        for _, e := range window {
                words += e.WordCount
        }
        lines := []string{fmt.Sprintf("Journal review — %s (%s..%s)", label, rng.start.Format("2006-01-02"), rng.end.Format("2006-01-02"))}
        lines = append(lines, fmt.Sprintf("entries: %d · words: %s", len(window), commatize(words)))

        var moods []int
        for _, e := range window {
                if e.Mood != nil {
                        moods = append(moods, *e.Mood)
                }
        }
        if len(moods) > 0 {
                sum := 0
                for _, m := range moods {
                        sum += m
                }
                avg := float64(sum) / float64(len(moods))
                prevEnd := rng.start.AddDate(0, 0, -1)
                spanDays := int(rng.end.Sub(rng.start).Hours()/24) + 1
                prevStart := prevEnd.AddDate(0, 0, -(spanDays - 1))
                var prevMoods []int
                for _, e := range entriesInRange(entries, prevStart, prevEnd) {
                        if e.Mood != nil {
                                prevMoods = append(prevMoods, *e.Mood)
                        }
                }
                trend := ""
                if len(prevMoods) > 0 {
                        psum := 0
                        for _, m := range prevMoods {
                                psum += m
                        }
                        pavg := float64(psum) / float64(len(prevMoods))
                        diff := avg - pavg
                        arrow := "→"
                        if diff >= 0.2 {
                                arrow = "↑"
                        } else if diff <= -0.2 {
                                arrow = "↓"
                        }
                        trend = fmt.Sprintf("%s vs previous period (%.1f)", arrow, pavg)
                } else {
                        trend = "— no earlier entries to compare"
                }
                lines = append(lines, fmt.Sprintf("avg mood: %.1f/5 %s", avg, trend))
                counts := make([]int, 5)
                for _, m := range moods {
                        counts[m-1]++
                }
                legend := make([]string, 5)
                for lv := 1; lv <= 5; lv++ {
                        legend[lv-1] = fmt.Sprintf("%d:%d", lv, counts[lv-1])
                }
                lines = append(lines, fmt.Sprintf("mood distribution: %s  (%s)", bar(counts), strings.Join(legend, " ")))
        } else {
                lines = append(lines, "avg mood: — (no moods recorded this period)")
        }

        tagCounts := map[string]int{}
        var tagOrder []string
        for _, e := range window {
                for _, t := range e.Tags {
                        if _, seen := tagCounts[t]; !seen {
                                tagOrder = append(tagOrder, t)
                        }
                        tagCounts[t]++
                }
        }
        if len(tagCounts) > 0 {
                // most_common(5): count desc, ties in first-encountered order
                sort.SliceStable(tagOrder, func(i, j int) bool { return tagCounts[tagOrder[i]] > tagCounts[tagOrder[j]] })
                top := []string{}
                for i, t := range tagOrder {
                        if i >= 5 {
                                break
                        }
                        top = append(top, fmt.Sprintf("#%s×%d", t, tagCounts[t]))
                }
                lines = append(lines, "top tags: "+strings.Join(top, ", "))
        }

        highlights := []string{}
        sortedByMood := make([]Entry, len(window))
        copy(sortedByMood, window)
        sort.SliceStable(sortedByMood, func(i, j int) bool {
                mi, mj := 0, 0
                if sortedByMood[i].Mood != nil {
                        mi = *sortedByMood[i].Mood
                }
                if sortedByMood[j].Mood != nil {
                        mj = *sortedByMood[j].Mood
                }
                return mi > mj
        })
outer:
        for _, e := range sortedByMood {
                for _, h := range e.Highlights {
                        highlights = append(highlights, fmt.Sprintf("  • %s  (%s)", h, e.Date))
                        if len(highlights) >= 3 {
                                break outer
                        }
                }
        }
        if len(highlights) > 0 {
                lines = append(lines, "top highlights:")
                lines = append(lines, highlights...)
        }

        grat := 0
        for _, e := range window {
                grat += len(e.Gratitude)
        }
        lines = append(lines, fmt.Sprintf("gratitude items: %d", grat))

        dayMoods := map[string][]int{}
        var dayOrder []string
        for _, e := range window {
                if e.Mood != nil {
                        if _, seen := dayMoods[e.Date]; !seen {
                                dayOrder = append(dayOrder, e.Date)
                        }
                        dayMoods[e.Date] = append(dayMoods[e.Date], *e.Mood)
                }
        }
        if len(dayMoods) > 0 {
                sort.Strings(dayOrder) // earliest day wins ties → deterministic
                avgs := map[string]float64{}
                for _, d := range dayOrder {
                        v := dayMoods[d]
                        s := 0
                        for _, m := range v {
                                s += m
                        }
                        avgs[d] = float64(s) / float64(len(v))
                }
                best, worst := dayOrder[0], dayOrder[0]
                for _, d := range dayOrder {
                        if avgs[d] > avgs[best] {
                                best = d
                        }
                        if avgs[d] < avgs[worst] {
                                worst = d
                        }
                }
                lines = append(lines, fmt.Sprintf("best day: %s (%.1f/5) · worst day: %s (%.1f/5)", best, avgs[best], worst, avgs[worst]))
        }

        cur, longest := streaks(entries, now)
        var dslS string
        if dsl := daysSinceLast(entries, now); dsl == nil {
                dslS = "never"
        } else {
                dslS = fmt.Sprintf("%dd ago", *dsl)
        }
        lines = append(lines, fmt.Sprintf("streak: %dd (longest %dd) · last entry: %s", cur, longest, dslS))
        if len(window) == 0 {
                lines = append(lines, "no entries in this period — write one: djournal(action='write', text='...', mood='...')")
        }
        return strings.Join(lines, "\n")
}

// ── moods (compact timeline) ────────────────────────────────────────────────

// moodTimeline: one line per day — date, mood glyph, one-word trend.
// Trend words compare each day's (rounded) average mood to the previous
// day IN THE TIMELINE, so gaps don't fake drops. Days without any mood
// still show (as '·') because knowing you WROTE is half the timeline.
func moodTimeline(entries []Entry, target string, now time.Time) string {
        spec := strings.TrimSpace(target)
        if spec == "" {
                spec = "last 14" // two weeks fits a phone
        }
        rng, ok := parseRange(spec, now)
        if !ok {
                return "djournal: couldn't parse range '" + target + "'. Try '2026-06-01..2026-06-30' or 'last 30'."
        }
        window := windowSorted(entries, rng)
        if len(window) == 0 {
                return "no entries " + rng.start.Format("2006-01-02") + ".." + rng.end.Format("2006-01-02") + " — nothing to chart"
        }
        perDay := map[string][]int{}
        var dayOrder []string
        for _, e := range window {
                if _, seen := perDay[e.Date]; !seen {
                        dayOrder = append(dayOrder, e.Date)
                }
                if e.Mood != nil {
                        perDay[e.Date] = append(perDay[e.Date], *e.Mood)
                }
        }
        sort.Strings(dayOrder)
        lines := []string{fmt.Sprintf("mood timeline %s..%s (%s with entries)",
                rng.start.Format("2006-01-02"), rng.end.Format("2006-01-02"),
                plural(len(dayOrder), "day", "days"))}
        prev := -1
        shown := 0
        for _, d := range dayOrder {
                if shown >= timelineCap {
                        lines = append(lines, fmt.Sprintf("…(%d older days trimmed)", len(dayOrder)-timelineCap))
                        break
                }
                shown++
                ms := perDay[d]
                if len(ms) == 0 {
                        lines = append(lines, d+"  ·  no mood")
                        continue
                }
                sum := 0
                for _, m := range ms {
                        sum += m
                }
                avg := pyRound(float64(sum) / float64(len(ms)))
                word := "new"
                if prev >= 0 {
                        switch {
                        case avg > prev:
                                word = "up"
                        case avg < prev:
                                word = "down"
                        default:
                                word = "flat"
                        }
                }
                prev = avg
                extra := ""
                if len(ms) > 1 {
                        extra = fmt.Sprintf("  avg %.1f over %d", float64(sum)/float64(len(ms)), len(ms))
                }
                glyph := "·"
                if g, ok := moodGlyphs[avg]; ok {
                        glyph = g
                }
                lines = append(lines, fmt.Sprintf("%s  %s  %s%s", d, glyph, word, extra))
        }
        return strings.Join(lines, "\n")
}

// ── prompt (deterministic daily rotation) ────────────────────────────────────
//
// 45 prompts, 9 per category, five categories. Rotation is day-of-year
// modulo the list: the SAME calendar day always offers the same prompt,
// while each prompt recurs ~8× a year. Determinism is the feature.
var prompts = [][2]string{
        // reflection
        {"reflection", "What did today teach you that yesterday didn't?"},
        {"reflection", "Which hour of today would you relive exactly as it happened — and why that one?"},
        {"reflection", "What did you avoid today, and what did the avoidance cost?"},
        {"reflection", "Where did your attention actually go today? Is that where you wanted it?"},
        {"reflection", "What felt heavier than it needed to today?"},
        {"reflection", "Describe today in one honest sentence, then explain the sentence."},
        {"reflection", "What small thing worked today that you'd never notice on a loud day?"},
        {"reflection", "When did you feel most like yourself today?"},
        {"reflection", "What assumption of yours did today quietly test?"},
        // gratitude
        {"gratitude", "Name three things that went right today — including one nobody else noticed."},
        {"gratitude", "Who made your day easier without knowing it?"},
        {"gratitude", "What part of your body quietly carried you through today?"},
        {"gratitude", "Which ordinary comfort did you enjoy today that millions would call a luxury?"},
        {"gratitude", "What went wrong today that you can still be grateful beside (not for)?"},
        {"gratitude", "Name something you're grateful you said no to this week."},
        {"gratitude", "What did you learn recently that you're glad waited until now?"},
        {"gratitude", "Which place are you glad exists? Describe it small."},
        {"gratitude", "What about today's weather, light, or air would you miss if it changed?"},
        // future-self
        {"future-self", "Write a note to yourself one year from tonight. What should they not forget?"},
        {"future-self", "If next month's you sent one warning back, what would it say?"},
        {"future-self", "What are you building right now that your future self will thank you for?"},
        {"future-self", "Ten years from now, what about today will seem small — and what will matter?"},
        {"future-self", "What habit is your future self currently hoping you start?"},
        {"future-self", "Describe the person you're becoming in three verbs."},
        {"future-self", "What would make tomorrow's you feel genuinely proud of tonight?"},
        {"future-self", "If you could keep only one thing from this month, what would you carry forward?"},
        {"future-self", "What question do you want to be able to answer a year from now?"},
        // challenge
        {"challenge", "What's the hardest conversation you're not having? Write its first sentence."},
        {"challenge", "Where are you tolerating 'fine' when you could have 'good'?"},
        {"challenge", "What would you attempt this week if failure were just data?"},
        {"challenge", "Name one thing you're pretending not to know."},
        {"challenge", "What scared you today — and how much of that fear was borrowed?"},
        {"challenge", "If the obstacle in front of you were a teacher, what's the lesson?"},
        {"challenge", "What's one system in your life that silently broke this month?"},
        {"challenge", "Which comfort is starting to cost more than it gives?"},
        {"challenge", "What would 'doing it scared' look like tomorrow?"},
        // relationships
        {"relationships", "Who did you feel understood by lately? What did they actually do?"},
        {"relationships", "Which relationship deserves more honesty and less politeness?"},
        {"relationships", "Who would call you first with good news — and why them?"},
        {"relationships", "What do people consistently get wrong about you — and is any of it your fault?"},
        {"relationships", "Whose company recharged you this week, and whose drained you? What's the difference?"},
        {"relationships", "Write a two-line thank-you you'll actually send."},
        {"relationships", "Where did you hold a boundary well recently? Where did you leak one?"},
        {"relationships", "What do you miss about someone you still see often?"},
        {"relationships", "Who in your life needs a version of you that's easier to be?"},
}

// pickPrompt is pure + deterministic (same day → same prompt). Python's
// modulo is non-negative even for negative inputs, so a hand-rolled doy
// can't index-crash — the Go twin normalizes.
func pickPrompt(dayOfYear int) string {
        n := len(prompts)
        i := dayOfYear % n
        if i < 0 {
                i += n
        }
        p := prompts[i]
        return fmt.Sprintf("[%s] %s", p[0], p[1])
}

// ── export ──────────────────────────────────────────────────────────────────

// exportEntries: the whole (or ranged) journal as markdown or JSON.
// JSON is a faithful round-trip (unmarshal(export) == the filtered entry
// list) so a user can move their journal between installs; markdown is
// for humans and the artifacts drawer.
func exportEntries(entries []Entry, format, target string, now time.Time) string {
        f := strings.ToLower(strings.TrimSpace(format))
        if f == "" {
                f = "md"
        }
        if f != "md" && f != "markdown" && f != "json" {
                return "djournal: export format must be md or json."
        }
        var window []Entry
        if s := strings.TrimSpace(target); s != "" {
                rng, ok := parseRange(s, now)
                if !ok {
                        return "djournal: couldn't parse range '" + target + "'. Try '2026-06-01..2026-06-30' or 'last 30'."
                }
                window = windowSorted(entries, rng)
        } else {
                window = make([]Entry, len(entries))
                copy(window, entries)
                sort.SliceStable(window, func(i, j int) bool {
                        if window[i].Date != window[j].Date {
                                return window[i].Date < window[j].Date
                        }
                        return window[i].Created < window[j].Created
                })
        }
        if f == "json" {
                b, err := json.MarshalIndent(window, "", "  ")
                if err != nil {
                        return "djournal: export failed: " + err.Error()
                }
                return string(b)
        }
        lines := []string{
                fmt.Sprintf("# doomalay journal export — %d entries", len(window)),
                fmt.Sprintf("generated %s · djournal", utcDay(now).Format("2006-01-02")),
                "",
        }
        for _, e := range window {
                d := e.Date
                if d == "" {
                        d = "?"
                }
                tm := ""
                if cd := parseISODT(e.Created); cd != nil {
                        tm = cd.UTC().Format("Mon 15:04")
                }
                head := fmt.Sprintf("## %s", e.ID)
                if e.ID == "" {
                        head = fmt.Sprintf("## %s", d)
                }
                if tm != "" {
                        head += " · " + tm
                }
                lines = append(lines, head)
                en := "—"
                if e.Energy != nil {
                        en = fmt.Sprintf("%d/5", *e.Energy)
                }
                wc := e.WordCount
                if wc == 0 {
                        wc = len(splitWords(e.Text))
                }
                lines = append(lines, fmt.Sprintf("mood: %s · energy: %s · %d words", moodStr(e.Mood), en, wc))
                lines = append(lines, "text:")
                ls := splitLines(e.Text)
                if len(ls) == 0 {
                        lines = append(lines, "  ")
                } else {
                        for _, ln := range ls {
                                lines = append(lines, "  "+ln)
                        }
                }
                if len(e.Tags) > 0 {
                        tags := make([]string, len(e.Tags))
                        for i, t := range e.Tags {
                                tags[i] = "#" + t
                        }
                        lines = append(lines, "tags: "+strings.Join(tags, ", "))
                }
                if len(e.Highlights) > 0 {
                        lines = append(lines, "highlights: "+strings.Join(e.Highlights, " · "))
                }
                if len(e.Gratitude) > 0 {
                        lines = append(lines, "gratitude: "+strings.Join(e.Gratitude, " · "))
                }
                lines = append(lines, "")
        }
        return strings.Join(lines, "\n")
}

// ── JSONL state IO (the only impure seam) ───────────────────────────────────

// LoadEntries reads the append-only JSONL log. Corrupt or blank lines
// are SKIPPED, never fatal. Order is file order = write order.
func LoadEntries(entriesPath string) []Entry {
        entries := []Entry{}
        raw, err := os.ReadFile(entriesPath)
        if err != nil {
                return entries
        }
        for _, line := range strings.Split(string(raw), "\n") {
                line = strings.TrimSpace(line)
                if line == "" {
                        continue
                }
                var e Entry
                if json.Unmarshal([]byte(line), &e) == nil {
                        entries = append(entries, e.normalize())
                }
        }
        return entries
}

// indexEntries: date → entries for that date, in write order. Built on
// every load (cheap: one pass) — a years-long journal shouldn't
// linear-scan for 'show me June 3rd'.
func indexEntries(entries []Entry) map[string][]Entry {
        idx := map[string][]Entry{}
        for _, e := range entries {
                k := e.Date
                if k == "" {
                        k = "?"
                }
                idx[k] = append(idx[k], e)
        }
        return idx
}

// AppendEntry appends one entry as a single JSON line (append-only). One
// Write call per line keeps a kill mid-append from corrupting more than
// the tail line, which LoadEntries then skips. No rewrites ever happen —
// history is immutable by design.
func AppendEntry(entriesPath string, entry Entry) error {
        if err := os.MkdirAll(filepath.Dir(entriesPath), 0o755); err != nil {
                return err
        }
        line, err := json.Marshal(entry)
        if err != nil {
                return err
        }
        f, err := os.OpenFile(entriesPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
        if err != nil {
                return err
        }
        defer f.Close()
        _, err = f.Write(append(line, '\n'))
        return err
}

// atomicWrite: tmp file + rename so export files can't be torn.
func atomicWrite(path, text string) error {
        if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
                return err
        }
        tmp := path + ".tmp"
        if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
                return err
        }
        return os.Rename(tmp, path)
}

// capText bounds the reply at MaxOut with the honest pointer at the
// on-disk source of truth (dt_spec rule 9).
func capText(text string, where string) string {
        if len(text) <= MaxOut {
                return text
        }
        note := fmt.Sprintf("\n…(trimmed at %d chars — full data: %s)", MaxOut, where)
        return text[:MaxOut-len(note)] + note
}

// ── the write confirmation ──────────────────────────────────────────────────

// confirm: human-facing receipt — what got saved + the live streak.
// Mood/energy warnings go HERE, on the RAW input (a deduped replay
// returns an OLDER entry whose fields may differ, and comparing against
// it would blame a perfectly valid mood the replay never stored).
func confirm(entry Entry, created bool, entries []Entry, now time.Time, rawMood, rawEnergy string) string {
        cur, longest := streaks(entries, now)
        var bits []string
        if entry.Mood != nil {
                bits = append(bits, "mood "+moodStr(entry.Mood))
        }
        if entry.Energy != nil {
                bits = append(bits, fmt.Sprintf("energy %d/5", *entry.Energy))
        }
        if len(entry.Tags) > 0 {
                joined := make([]string, len(entry.Tags))
                for i, t := range entry.Tags {
                        joined[i] = "#" + t
                }
                bits = append(bits, strings.Join(joined, " "))
        }
        id := entry.ID
        if id == "" {
                id = entry.Date
        }
        verb := "Saved"
        if !created {
                verb = "Already saved"
        }
        line := fmt.Sprintf("%s journal entry %s · %d words", verb, id, entry.WordCount)
        if len(bits) > 0 {
                line += " · " + strings.Join(bits, " · ")
        }
        lines := []string{line}
        if !created {
                lines = append(lines, "(replay of the same write — (date, created) key exists, nothing appended)")
        }
        lines = append(lines, fmt.Sprintf("streak: %dd (longest %dd)", cur, longest))
        for _, w := range []struct{ raw, what string }{{rawMood, "mood"}, {rawEnergy, "energy"}} {
                if strings.TrimSpace(w.raw) != "" && moodScale(w.raw) == nil {
                        lines = append(lines, fmt.Sprintf("note: %s '%s' not recognized — saved without it (use 1-5, great/good/ok/low/awful, or an emoji)", w.what, w.raw))
                }
        }
        return strings.Join(lines, "\n")
}

// ── help ────────────────────────────────────────────────────────────────────

const helpText = `djournal — the rich doomalay journal (write, read, search, review, moods, prompt, export, help)

write   text (required), mood?, date?, tags?, highlights?, gratitude?, energy?
        → appends an entry (default date: today); same-date repeats get #2, #3 ids
read    target: date | today | yesterday | "2026-01-01..2026-01-31" | "last N"
search  query, in_field? (text|tags|highlights|gratitude|all), mood?, date_range?
review  period? (week | month | "last N days") → entry count, avg mood + trend
        arrow, mood distribution bar, top tags, top highlights, gratitude count,
        best/worst day, streaks, days since last entry
moods   date_range? → compact timeline: one line per day (date, glyph, up/down/flat)
prompt  → today's journaling prompt (45 prompts, rotates by day-of-year)
export  format? (md|json), date_range? → the full journal; also saved to state

mood syntax: 1-5, words (great/good/ok/low/awful), or emoji (😀🙂😐🙁😢).
tags/highlights/gratitude: comma- or newline-separated lists.
state: <data-dir>/journal/entries.jsonl (append-only JSONL).`

// ── the IO-wired dispatcher ─────────────────────────────────────────────────

// Args is the full djournal argument surface (the Python tool's schema,
// the engine's Def mirrors it).
type Args struct {
        Action     string
        Text       string
        Date       string
        Mood       any
        Tags       any
        Highlights any
        Gratitude  any
        Energy     any
        Query      string
        InField    string
        DateRange  string
        Period     string
        Target     string
        Format     string
        Now        time.Time
}

// ExportPaths carries what an export produced: the state-dir file the
// Python law writes + the artifact body for the drawer (the docx/xlsx
// pattern — the engine addition rides the existing ArtifactSink).
type ExportPaths struct {
        FileName string // e.g. "export.md" — the artifact drawer's name
        Content  string // the export text
        IsJSON   bool
        Wrote    bool   // the state-dir write succeeded
        Path     string // the state-dir path
}

// Result is one djournal action's outcome: the reply text + (exports
// only) the artifact body.
type Result struct {
        Text   string
        Export *ExportPaths
}

// RunAction runs one djournal action against the JSONL state file.
// This is the seam between the pure core and the disk: load (skipping
// corrupt lines), dispatch, append ONLY genuinely new writes, cap the
// reply at MaxOut. Every failure mode returns a string; nothing here
// errors to the model.
func RunAction(entriesPath string, args Args) Result {
        now := args.Now
        if now.IsZero() {
                now = time.Now().UTC()
        }
        act := strings.ToLower(strings.TrimSpace(args.Action))
        entries := LoadEntries(entriesPath)

        switch {
        case act == "write" || act == "add" || act == "log" || act == "new":
                entry, created, err := addEntry(entries, map[string]any{
                        "text": args.Text, "date": args.Date,
                        "mood": args.Mood, "tags": args.Tags,
                        "highlights": args.Highlights, "gratitude": args.Gratitude,
                        "energy": args.Energy,
                }, now)
                if err != nil {
                        return Result{Text: "djournal: " + err.Error()}
                }
                if created {
                        if err := AppendEntry(entriesPath, entry); err != nil {
                                return Result{Text: "djournal: could not save the entry: " + err.Error()}
                        }
                        entries = append(entries, entry)
                }
                return Result{Text: capText(confirm(entry, created, entries, now,
                        toRawString(args.Mood), toRawString(args.Energy)), entriesPath)}

        case act == "read" || act == "show" || act == "get" || act == "list":
                spec := strings.TrimSpace(args.Target)
                if spec == "" {
                        spec = strings.TrimSpace(args.Date)
                }
                if spec == "" {
                        spec = "today"
                }
                var out string
                if rng, ok := parseRange(spec, now); ok && rng.start.Equal(rng.end) {
                        // single-date fast path: the load-time index answers
                        // without scanning the whole journal
                        idx := indexEntries(entries)
                        window := idx[rng.start.Format("2006-01-02")]
                        sort.SliceStable(window, func(i, j int) bool { return window[i].Created < window[j].Created })
                        if len(window) > 0 {
                                out = renderWindow(window, rng, spec)
                        } else {
                                out = readEntries(entries, spec, now)
                        }
                } else {
                        out = readEntries(entries, spec, now)
                }
                return Result{Text: capText(out, entriesPath)}

        case act == "search":
                return Result{Text: capText(searchEntries(entries, args.Query, args.InField,
                        args.Mood, args.DateRange, now), entriesPath)}

        case act == "review" || act == "stats" || act == "summary":
                period := strings.TrimSpace(args.Period)
                if period == "" {
                        period = strings.TrimSpace(args.Target)
                }
                if period == "" {
                        period = "week"
                }
                return Result{Text: capText(reviewSummary(entries, period, now), entriesPath)}

        case act == "moods" || act == "timeline" || act == "mood":
                spec := strings.TrimSpace(args.DateRange)
                if spec == "" {
                        spec = strings.TrimSpace(args.Target)
                }
                if spec == "" {
                        spec = "last 14"
                }
                return Result{Text: capText(moodTimeline(entries, spec, now), entriesPath)}

        case act == "prompt" || act == "idea" || act == "spark":
                p := pickPrompt(now.UTC().YearDay())
                return Result{Text: p + "\nwrite your answer with djournal(action='write', text='...', mood='...') — one prompt per day, 45 in rotation."}

        case act == "export" || act == "dump" || act == "backup":
                target := strings.TrimSpace(args.DateRange)
                if target == "" {
                        target = strings.TrimSpace(args.Target)
                }
                out := exportEntries(entries, args.Format, target, now)
                if strings.HasPrefix(out, "djournal:") { // parse error — nothing to persist
                        return Result{Text: out}
                }
                isJSON := strings.HasPrefix(strings.ToLower(strings.TrimSpace(args.Format)), "json")
                fileName := "export.md"
                if isJSON {
                        fileName = "export.json"
                }
                path := filepath.Join(filepath.Dir(entriesPath), fileName)
                wrote := atomicWrite(path, out) == nil
                var res string
                if wrote {
                        res = capText(out+"\n\n(export saved to "+path+")", path)
                } else {
                        res = capText(out+"\n(warning: could not write "+path+")", path)
                }
                return Result{Text: res, Export: &ExportPaths{
                        FileName: fileName, Content: out, IsJSON: isJSON, Wrote: wrote, Path: path,
                }}

        case act == "help" || act == "?" || act == "":
                return Result{Text: helpText}
        }
        return Result{Text: "djournal: unknown action '" + args.Action + "'.\n\n" + helpText}
}

// toRawString renders an any-typed arg for the raw-input warnings.
func toRawString(v any) string {
        if v == nil {
                return ""
        }
        if s, ok := v.(string); ok {
                return s
        }
        return fmt.Sprintf("%v", v)
}

// commatize renders 1234567 as "1,234,567" (Python's f"{n:,}").
func commatize(n int) string {
        s := strconv.Itoa(n)
        if len(s) <= 3 {
                return s
        }
        var parts []string
        for len(s) > 3 {
                parts = append([]string{s[len(s)-3:]}, parts...)
                s = s[:len(s)-3]
        }
        parts = append([]string{s}, parts...)
        return strings.Join(parts, ",")
}
