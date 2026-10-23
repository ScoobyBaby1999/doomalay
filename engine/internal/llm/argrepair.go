package llm

import (
        "encoding/json"
        "strings"
)

// argrepair.go — v1.61.1 THE REPAIR HAND (PLAN-V161).
//
// THE UNFUMBLE LAW: a tool call that can be mechanically repaired IS
// repaired — the model never learns it failed. The live chatlogs
// (doomalay-kenny-6ada2fc9: 5 termux arg hiccups; doomalay-trippy:
// 6 workspace arg hiccups) convicted four real classes this module
// kills:
//
//   1. TAG-GRAMMAR LEAKAGE — models trained on a legacy XML-ish tag
//      grammar still emit its tags inside native tool-call arguments.
//      Convicted byte-exact from the kenny export (4 occurrences, the
//      hexdump): the pair "\u003c/arg_key\u003e\u003carg_value\u003e" —
//      i.e. the ASCII sequences spelled tagCloseKey + tagOpenValue
//      below. Kenny's two real shapes:
//        (a) inside the nested args string:  "args" + TAGS + "{command"…
//            — the tags spell the JSON `":` the model meant to write;
//        (b) inside the action field:        "exec" + TAGS + "{command"…
//            — the real action is the prefix, the payload follows the
//            tags (SplitTaggedAction rescues it).
//      TagsToJSON converts shape (a) mechanically; SplitTaggedAction
//      rescues shape (b). The sibling tags (open-key, close-value) are
//      handled too — the model that leaks one leaks the family.
//
//   2. RAW NEWLINES + UNESCAPED QUOTES inside a nested JSON-string
//      (the args-as-string prop shape): repairJSON escapes raw \n\r\t
//      INSIDE strings, but a string that "closes" early on an
//      unescaped quote (kenny's `python3 -c "` + newline + script)
//      dies between tokens. RepairJSONQuotes reopens a string when
//      the byte after the would-be close is not JSON structure —
//      the json_repair library's proven heuristic.
//
//   3. RECURSIVE ARGS ENVELOPES — `{"args":"{\"args\":\"{…}\"}"}` —
//      the model wraps the whole action object inside the args key,
//      recursively. UnwrapArgsEnvelope peels the layers.
//
//   4. TRUNCATION — repairJSON already appends missing closers; the
//      honesty line (cut MID-STRING = refuse, tell the model to
//      re-send — never execute half a command) is preserved on every
//      rung: a repaired string that ends still-open carries the cut
//      verdict and the chain refuses it.
//
// The chain is applied OUTSIDE-IN at three layers: the native gate
// (nativetools.go, before the bus), the tools' own nested-args parse
// (termuxtool/workspacetool), and the action-field split. Only the
// truly impossible speaks — and it speaks the fix plus the
// anti-simplification order (see RetrySameCallDirective).

// RetrySameCallDirective — v1.61.1 THE ANTI-SIMPLIFICATION LAW. The
// live chatlogs show the failure cascade: a model that fumbles an
// arg shape does not retry the same call — it "simplifies" (kenny's
// own thinking: "Let me try a simpler approach", 4×; trippy abandoned
// a whole investigation after two arg errors). Every arg-validation
// error and every malformed-args verdict carries this suffix so the
// model's cheapest path is the retry, never the downgrade.
const RetrySameCallDirective = "Retry the SAME call with this fix — do not simplify, downgrade, or switch strategy."

// RetryDirectiveFor — v1.64.2 THE VERBATIM LAW (PLAN-V164 §2, the user's
// ask: "Instead of don't downgrade or simplify we can keep that and add
// the tool it did verbatim back to it"): the anti-simplification order
// carries the call VERBATIM — the model sees exactly what it sent and
// retries THAT, never a downgraded cousin. The verbatim echo clamps at
// 480 bytes with the honest marker (a truncated 50KB call must not
// flood the observation — the model's own call rides its context
// anyway). The const stays as the order's tail (the pins' anchor).
func RetryDirectiveFor(name, rawArgs string) string {
        call := strings.TrimSpace(name)
        if a := strings.TrimSpace(rawArgs); a != "" {
                if call == "" {
                        call = a
                } else {
                        call += " " + a
                }
        }
        if len(call) > 480 {
                call = call[:480] + " …[your full call rides this conversation]"
        }
        if call == "" {
                return RetrySameCallDirective
        }
        return "Retry the SAME call — verbatim, as you sent it: " + call + " — with this fix. " + RetrySameCallDirective
}

// The legacy XML-ish tag grammar, convicted byte-exact from the kenny
// export (the hexdump): the ASCII pair "\u003c/arg_key\u003e" +
// "\u003carg_value\u003e" appears 4× — always immediately after a key
// (`"args` or `exec`) and always before an object value (`{`). They
// are mechanical spellings of JSON punctuation:
//
//      tagCloseKey  = `\u003c/arg_key\u003e`    → `":`  — the key's own
//           opening quote is usually already there; the tag closes it and
//           supplies the colon (bare-key forms rely on the lenient pass
//           to add the missing opening quote).
//      tagOpenValue = `\u003carg_value\u003e`    → `"` when the value is a
//           string (dropped when the value is an object/array — the
//           kenny-evidenced case: `}"}"`... simply `":`).
//      tagOpenKey   = `\u003carg_key\u003e`      → `"` (a key opener).
//      tagCloseVal  = `\u003c/arg_value\u003e`   → `"` (a string closer).
//
// The constants are written with \u003c/\u003e escapes deliberately:
// they compile to the exact ASCII bytes AND no raw angle-bracket
// literal rides in the source text (writer pipelines mangle those).
const (
        tagOpenKey   = "\u003carg_key\u003e"
        tagCloseKey  = "\u003c/arg_key\u003e"
        tagOpenValue = "\u003carg_value\u003e"
        tagCloseVal  = "\u003c/arg_value\u003e"
)

// hasLegacyTags reports whether the text carries any legacy tag (the
// cheap pre-test — the conversion is only run when true).
func hasLegacyTags(s string) bool {
        return strings.Contains(s, tagCloseKey) || strings.Contains(s, tagOpenValue) ||
                strings.Contains(s, tagOpenKey) || strings.Contains(s, tagCloseVal)
}

// TagsToJSON converts the legacy tag grammar into JSON punctuation.
// Position-aware (the kenny shapes proved the rules):
//
//      "args" + closeKey + openValue + "{…   →  "args":{…   (object/array value)
//      "args" + closeKey + openValue + `"…`   →  "args":"…    (the model quoted the
//                                               string value itself — the tag pair
//                                               opens it, the redundant quote drops)
//      "args" + closeKey + openValue + bare   →  "args":"bare  (a bare string value:
//                                               the pair opens it; closeVal/repair
//                                               closes it)
//      bare-key + closeKey + …                →  handled by the enclosing lenient
//                                               pass (bare keys get quoted there).
//
// The conversion is purely textual; the normal repair chain parses
// the result afterwards.
func TagsToJSON(s string) string {
        if !hasLegacyTags(s) {
                return s
        }
        var b strings.Builder
        i := 0
        for i < len(s) {
                // closeKey followed by openValue (the canonical evidenced pair)
                if strings.HasPrefix(s[i:], tagCloseKey) {
                        rest := i + len(tagCloseKey)
                        if strings.HasPrefix(s[rest:], tagOpenValue) {
                                rest += len(tagOpenValue)
                                rest = skipWS(s, rest)
                                switch {
                                case rest < len(s) && (s[rest] == '{' || s[rest] == '['):
                                        // object/array value: close the key, colon, value as-is
                                        b.WriteString(`":`)
                                        i = rest
                                case rest < len(s) && s[rest] == '"':
                                        // the model quoted the string value itself
                                        b.WriteString(`":"`)
                                        i = rest + 1
                                default:
                                        // bare string value: open it (closeVal/repair closes it later)
                                        b.WriteString(`":"`)
                                        i = rest
                                }
                                continue
                        }
                        // standalone closeKey (no openValue after)
                        rest = skipWS(s, rest)
                        switch {
                        case rest < len(s) && (s[rest] == '{' || s[rest] == '['):
                                b.WriteString(`":`)
                                i = rest
                        case rest < len(s) && s[rest] == '"':
                                b.WriteString(`":`)
                                i = rest + 1 // drop the redundant quote
                        default:
                                b.WriteString(`":"`)
                                i = rest
                        }
                        continue
                }
                if strings.HasPrefix(s[i:], tagOpenValue) {
                        rest := skipWS(s, i+len(tagOpenValue))
                        switch {
                        case rest < len(s) && (s[rest] == '{' || s[rest] == '['):
                                i = rest // object value: the tag is pure noise
                        case rest < len(s) && s[rest] == '"':
                                b.WriteString(`"`)
                                i = rest + 1
                        default:
                                b.WriteString(`"`) // open a bare string value
                                i = rest
                        }
                        continue
                }
                switch {
                case strings.HasPrefix(s[i:], tagCloseVal):
                        b.WriteString(`"`)
                        i += len(tagCloseVal)
                case strings.HasPrefix(s[i:], tagOpenKey):
                        b.WriteString(`"`)
                        i += len(tagOpenKey)
                default:
                        b.WriteByte(s[i])
                        i++
                }
        }
        return b.String()
}

func skipWS(s string, i int) int {
        for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
                i++
        }
        return i
}

// RepairJSONQuotes reopens strings that close early on an unescaped
// quote when the byte after the would-be close is NOT JSON structure
// (`,` `:` `}` `]`). The kenny shape: {"command": "python3 -c "
// + RAW NEWLINE + "import json…"} — the command string "closed" at
// the quote after -c, the script text fell outside any string and the
// parse died mid-object. Reopened, the whole script is ONE command
// value and the in-string pass escapes the raw newlines.
//
// The walk SUBSUMES the old repairJSON pass (raw \n\r\t escaped inside
// strings, missing closers appended at the end) — one walk, one
// truth. Returns the fixed text, whether it STILL ends inside a
// string (the TRUE cut verdict, judged on the reopened text — the
// old walk misjudged early-close shapes as cut), and whether any
// reopen fired (the notes distinction: "quotes" vs "closers").
func RepairJSONQuotes(s string) (fixed string, stillInStr bool, reopened bool) {
        var b strings.Builder
        var stack []byte
        inStr, esc := false, false
        quotesInValue := 0 // v1.61.1: the quote-debt counter (per open string)
        i := 0
        for i < len(s) {
                c := s[i]
                switch {
                case inStr && esc:
                        esc = false
                        b.WriteByte(c)
                        i++
                case inStr && c == '\\':
                        esc = true
                        b.WriteByte(c)
                        i++
                case inStr && c == '"':
                        // would-be close: peek the next structurally-meaningful byte
                        j := i + 1
                        for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
                                j++
                        }
                        if j >= len(s) || s[j] == ',' || s[j] == ':' || s[j] == '}' || s[j] == ']' {
                                // v1.61.1 THE QUOTE DEBT: a reopened string whose value holds an
                                // ODD quote count owes one back — the kenny conviction: the
                                // model's closing quote (the -c argument's end) was BOTH the
                                // JSON close AND the command's content; the close eats it and
                                // bash dies on the unbalanced command. Repay: escape one more
                                // quote INTO the value before the JSON close.
                                if quotesInValue%2 == 1 {
                                        b.WriteString(`\"`)
                                }
                                inStr = false
                                b.WriteByte(c)
                        } else {
                                // not structure → an unescaped quote INSIDE the value
                                reopened = true
                                quotesInValue++
                                b.WriteString(`\"`)
                        }
                        i++
                case inStr:
                        switch c {
                        case '\n':
                                b.WriteString(`\n`)
                        case '\r':
                                b.WriteString(`\r`)
                        case '\t':
                                b.WriteString(`\t`)
                        default:
                                b.WriteByte(c)
                        }
                        i++
                case c == '"':
                        inStr = true
                        quotesInValue = 0
                        b.WriteByte(c)
                        i++
                case c == '{':
                        stack = append(stack, '}')
                        b.WriteByte(c)
                        i++
                case c == '[':
                        stack = append(stack, ']')
                        b.WriteByte(c)
                        i++
                case (c == '}' || c == ']') && len(stack) > 0:
                        stack = stack[:len(stack)-1]
                        b.WriteByte(c)
                        i++
                default:
                        b.WriteByte(c)
                        i++
                }
        }
        out := b.String()
        if inStr {
                out += `"`
        }
        for k := len(stack) - 1; k >= 0; k-- {
                out += string(stack[k])
        }
        return out, inStr, reopened
}

// RepairNote names the rung that saved a call (the honest teach —
// the observation carries it so the model learns the shape without
// ever seeing a failure).
type RepairNote struct {
        Kind string // "tags" | "quotes" | "envelope" | "closers" | "lenient"
        Desc string
}

// ParseToolArgs — the full repair chain for ONE raw args string (the
// native gate's outer JSON, a tool's nested args-string, an action
// payload). Order: parse → TagsToJSON → quote-reopen+closers →
// lenientJSON → refuse. The TRUE cut verdict (mid-string truncation)
// is judged on the REOPENED text — the naive walk misjudges
// early-close quotes as truncation (the v1611 pin conviction). notes
// names what ran (nil when the raw text parsed clean).
func ParseToolArgs(raw string) (m map[string]any, notes []RepairNote, ok bool) {
        s := strings.TrimSpace(raw)
        if s == "" {
                return map[string]any{}, nil, true
        }
        tryParse := func(t string) (map[string]any, bool) {
                var mm map[string]any
                if json.Unmarshal([]byte(t), &mm) == nil {
                        return mm, true
                }
                return nil, false
        }
        if mm, good := tryParse(s); good {
                return mm, nil, true
        }
        // rung 1: legacy tags → JSON (the full pass below then runs on
        // the converted text — kenny's shapes can stack tags + quotes)
        base, tagNotes := s, []RepairNote(nil)
        if hasLegacyTags(s) {
                base = TagsToJSON(s)
                tagNotes = []RepairNote{{Kind: "tags", Desc: "legacy tag grammar converted to JSON"}}
                if mm, good := tryParse(base); good {
                        return mm, tagNotes, true
                }
        }
        // rung 2: quote-reopen + closers — ONE walk (raw \n\r\t escaped
        // inside strings, early-close quotes reopened, missing closers
        // appended) that SUBSUMES the old repairJSON pass. stillInStr on
        // the REOPENED text is the TRUE cut verdict: the naive walk
        // misjudges early-close shapes as truncation (the v1611 pin
        // conviction), and a genuinely truncated string still ends
        // inStr after the reopen — the honesty line survives intact.
        t3, stillIn, reopened := RepairJSONQuotes(base)
        if !stillIn {
                kind, desc := "closers", "raw line breaks escaped / missing brackets closed"
                if reopened {
                        kind, desc = "quotes", "unescaped quotes inside a string value escaped"
                }
                if mm, good := tryParse(t3); good {
                        return mm, appendNotes(tagNotes, kind, desc), true
                }
                if t4 := lenientJSON(t3); json.Valid([]byte(t4)) {
                        if mm, good := tryParse(t4); good {
                                return mm, appendNotes(appendNotes(tagNotes, kind, desc), "lenient", "quote/key syntax relaxed"), true
                        }
                }
        }
        // stillIn → genuinely cut mid-string: the honesty line refuses
        // — never execute half a command (the caller speaks the fix +
        // the anti-simplification order).
        return nil, nil, false
}

// appendNotes appends one RepairNote to a (possibly nil) slice.
func appendNotes(base []RepairNote, kind, desc string) []RepairNote {
        if base == nil {
                return []RepairNote{{Kind: kind, Desc: desc}}
        }
        return append(base, RepairNote{Kind: kind, Desc: desc})
}

// UnwrapArgsEnvelope peels the recursive args envelope — the model
// wrapped the whole action object inside the "args" key:
//
//      {"args": "{\"args\": \"{\\\"action\\\":…}\"}"}   (kenny's class)
//
// A layer unwraps when the map holds ONLY an "args" value (string or
// object; an empty action key is tolerated) whose content parses to a
// map that itself carries action/args keys. Bounded (maxLayers=4);
// top-level explicit keys always win. Returns the (possibly same)
// map + true when at least one layer peeled.
func UnwrapArgsEnvelope(m map[string]any, maxLayers int) (map[string]any, bool) {
        peeled := false
        for depth := 0; depth < maxLayers; depth++ {
                if m == nil {
                        return m, peeled
                }
                var inner any
                hasArgs := false
                other := false
                for k, v := range m {
                        switch k {
                        case "args":
                                hasArgs = true
                                inner = v
                        case "action":
                                if s, isStr := v.(string); !isStr || strings.TrimSpace(s) != "" {
                                        other = true // a real action rides at this layer
                                }
                        default:
                                other = true // a real key rides at this layer
                        }
                }
                if !hasArgs || other {
                        return m, peeled
                }
                switch v := inner.(type) {
                case string:
                        if strings.TrimSpace(v) == "" {
                                return m, peeled
                        }
                        parsed, _, ok := ParseToolArgs(v)
                        if !ok || parsed == nil || len(parsed) == 0 {
                                return m, peeled
                        }
                        m = parsed
                        peeled = true
                case map[string]any:
                        if len(v) == 0 {
                                return m, peeled
                        }
                        m = v
                        peeled = true
                default:
                        return m, peeled
                }
        }
        return m, peeled
}

// SplitTaggedAction rescues an action field that carries the legacy
// tag grammar (kenny's unknown-action class: the action value held
// "exec" + TAGS + "{\"command\":…}"). The real action is the text
// before the first tag; the payload after the tags is parsed through
// the repair chain and merged (existing keys win — the payload only
// fills gaps).
func SplitTaggedAction(action string) (real string, payload map[string]any, found bool) {
        i := strings.Index(action, tagCloseKey)
        if i < 0 {
                if j := strings.Index(action, tagOpenValue); j >= 0 {
                        i = j
                }
        }
        if i < 0 {
                return action, nil, false
        }
        real = strings.TrimSpace(action[:i])
        rest := action[i:]
        // hop the closeKey then the openValue if present
        if strings.HasPrefix(rest, tagCloseKey) {
                rest = rest[len(tagCloseKey):]
        }
        rest = strings.TrimPrefix(rest, tagOpenValue)
        // strip trailing tag/quote noise (closeVal first, then a stray closeKey)
        rest = strings.TrimSpace(rest)
        for _, suf := range []string{tagCloseVal, tagCloseKey} {
                rest = strings.TrimSuffix(strings.TrimSpace(rest), suf)
        }
        rest = strings.TrimSpace(rest)
        rest = strings.TrimSuffix(rest, `"`)
        payload, _, ok := ParseToolArgs(rest)
        if !ok {
                payload = nil
        }
        if real == "" {
                return action, nil, false
        }
        return real, payload, true
}

// RepairNotesLine renders the honest teach head for an observation
// whose args were auto-repaired (nil-safe; "" when nothing ran).
// The phrasing is deliberate (the anti-simplification law): the call
// SUCCEEDED — the model's cheapest path is to keep calling, not to
// simplify its approach.
func RepairNotesLine(notes []RepairNote) string {
        if len(notes) == 0 {
                return ""
        }
        var parts []string
        for _, n := range notes {
                parts = append(parts, n.Desc)
        }
        return "note: arguments auto-repaired (" + strings.Join(parts, "; ") + ") — the call executed as intended; keep using the same call shape."
}
