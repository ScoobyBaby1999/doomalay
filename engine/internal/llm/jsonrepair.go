package llm

// jsonrepair.go — v1.74.4 THE DEEP PARSE (PLAN-V174 §4, the user's
// bullet 1: "we rely too much on JSON and text parsing when models
// don't seem like they want to do that, causing tool hiccups").
//
// THE PORT: the jsonrepair library's (ISC, josdejong) high-value subset
// ported in-house — no new dependency, no cgo, android-safe. It runs as
// the DEEPEST rung of the argrepair ladder (after tags, quote-reopen,
// closers and the lenient pass have all failed) and repairs what JSON
// hand-writers actually get wrong:
//
//   - ```json code fences around the whole document
//   - // line comments and /* block comments */ outside strings
//   - trailing commas before } and ]
//   - unquoted keys           {command: "x"}     → {"command": "x"}
//   - unquoted bare values    {op: install}      → {"op": "install"}
//   - Python literals          None/True/False   → null/true/false
//   - bare NaN/Infinity        → null
//   - string concatenation     "a" + "b"         → "ab"
//   - missing closers          appended
//
// THE HONESTY LINE SURVIVES: jsonrepair never invents content — a
// document that ends still inside a string is the CUT verdict and the
// caller refuses it (never execute half a command). The function
// returns stillIn for exactly that.
//
// Single-quote strings and smart quotes are already the lenient pass's
// job; this rung tolerates them again (they can survive mixed).

import (
	"strings"
)

// jsonRepairDeep repairs a malformed JSON document (the jsonrepair
// subset). Returns the repaired text and whether it ends still inside a
// string (the cut verdict — the caller refuses).
func jsonRepairDeep(s string) (string, bool) {
	s = strings.TrimSpace(s)
	// strip ```json fences around the whole document
	if strings.HasPrefix(s, "```") {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		} else {
			s = strings.TrimPrefix(s, "```json")
		}
		s = strings.TrimSpace(s)
	}
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSpace(strings.TrimSuffix(s, "```"))
	}

	var b strings.Builder
	runes := []rune(s)
	n := len(runes)
	i := 0
	inStr := false     // inside the (double-quoted) string being emitted
	inSingle := false  // inside a single-quoted string (repaired to double)
	esc := false
	// lastSig: the last significant byte emitted (for the trailing-comma
	// law and the key/value position test).
	lastSig := byte(0)
	// the container stack ('{' = object, '[' = array) drives the
	// key-position test: a bare word is a KEY when the top container is
	// an object and we sit right after '{' or ',' (a comma at array
	// depth does NOT make the next word a key).
	var stack []byte
	expectKey := false

	emit := func(str string) {
		b.WriteString(str)
		for k := 0; k < len(str); k++ {
			if c := str[k]; c != ' ' && c != '\t' && c != '\n' && c != '\r' {
				lastSig = c
			}
		}
	}
	dropTrailingComma := func() {
		t := b.String()
		trimmed := strings.TrimRight(t, " \t\n\r")
		if strings.HasSuffix(trimmed, ",") {
			b.Reset()
			b.WriteString(strings.TrimSuffix(trimmed, ","))
		}
	}

	for i < n {
		r := runes[i]

		// ── inside a string ─────────────────────────────────────────
		if inStr || inSingle {
			quote := '"'
			if inSingle {
				quote = '\''
			}
			if esc {
				esc = false
				// an escaped single quote inside a single-quoted string
				// becomes an escaped double quote
				if inSingle && r == '\'' {
					emit("\\\"")
				} else if inSingle && r == '"' {
					emit("\\\"")
				} else {
					emit(string(r))
				}
				i++
				continue
			}
			switch r {
			case '\\':
				esc = true
				emit("\\")
				i++
				continue
			case quote:
				// close — but a string CONCAT may follow ("a" + "b"):
				// peek past spaces for '+' then a quote → keep going.
				j := i + 1
				for j < n && (runes[j] == ' ' || runes[j] == '\t') {
					j++
				}
				if j < n && runes[j] == '+' {
					k := j + 1
					for k < n && (runes[k] == ' ' || runes[k] == '\t') {
						k++
					}
					if k < n && (runes[k] == '"' || runes[k] == '\'') {
						// concat: skip the + and the quote, stay in the
						// string (switching to double-quote mode)
						i = k + 1
						inStr, inSingle = true, false
						continue
					}
				}
				inStr, inSingle = false, false
				if quote == '\'' {
					emit("\"")
				} else {
					emit("\"")
				}
				i++
				continue
			case '"':
				if inSingle {
					// a raw double quote inside a single-quoted string
					emit("\\\"")
					i++
					continue
				}
				emit("\"")
				i++
				continue
			case '\n':
				emit("\\n")
				i++
				continue
			case '\r':
				emit("\\r")
				i++
				continue
			case '\t':
				emit("\\t")
				i++
				continue
			}
			emit(string(r))
			i++
			continue
		}

		// ── outside strings ─────────────────────────────────────────
		switch {
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			emit(string(r))
			i++
			continue
		case r == '"':
			inStr = true
			emit("\"")
			i++
			continue
		case r == '\'':
			inSingle = true
			emit("\"")
			i++
			continue
		case r == '{':
			stack = append(stack, '{')
			expectKey = true
			emit("{")
			i++
			continue
		case r == '[':
			stack = append(stack, '[')
			expectKey = false
			emit("[")
			i++
			continue
		case r == '}' || r == ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			expectKey = false
			dropTrailingComma()
			emit(string(r))
			i++
			continue
		case r == ',':
			expectKey = len(stack) > 0 && stack[len(stack)-1] == '{'
			emit(",")
			i++
			continue
		case r == ':':
			expectKey = false
			emit(":")
			i++
			continue
		case r == '/' && i+1 < n && runes[i+1] == '/':
			// line comment → EOL
			for i < n && runes[i] != '\n' {
				i++
			}
			continue
		case r == '/' && i+1 < n && runes[i+1] == '*':
			// block comment → */
			i += 2
			for i+1 < n && !(runes[i] == '*' && runes[i+1] == '/') {
				i++
			}
			i += 2
			if i > n {
				i = n
			}
			continue
		}

		// bare word: a key (unquoted) or a value (Python literal / bare
		// token) — read the whole word.
		j := i
		for j < n {
			c := runes[j]
			if c == ':' || c == ',' || c == '}' || c == ']' || c == ' ' ||
				c == '\t' || c == '\n' || c == '\r' || c == '{' || c == '[' ||
				c == '"' || c == '\'' {
				break
			}
			j++
		}
		if j == i { // not a word char after all — emit and move on
			emit(string(r))
			i++
			continue
		}
		word := string(runes[i:j])
		// the word may be immediately followed by ':' → it was a KEY
		k := j
		for k < n && (runes[k] == ' ' || runes[k] == '\t') {
			k++
		}
		isKey := k < n && runes[k] == ':'
		// key POSITION: top container is an object and we sit right after
		// '{' or ',' (the missing-colon law: {command "x"} gains the colon)
		inKeyPos := expectKey || (len(stack) > 0 && stack[len(stack)-1] == '{' &&
			(lastSig == '{' || lastSig == ','))
		switch {
		case isKey:
			emit("\"" + word + "\"") // the unquoted key
		case inKeyPos && (k < n && (runes[k] == '"' || runes[k] == '\'' || runes[k] == '{' || runes[k] == '[')):
			emit("\"" + word + "\":") // a key with a MISSING colon
		case inKeyPos:
			emit("\"" + word + "\"") // a key-shaped word (a trailing value follows)
		case isJSONNumber1744(word):
			emit(word) // a bare numeric value stays bare (jsonrepair's law)
		case word == "None", word == "NaN", word == "Infinity",
			word == "-Infinity", word == "nan", word == "inf":
			emit("null")
		case word == "True", word == "true":
			emit("true")
		case word == "False", word == "false":
			emit("false")
		default:
			// a bare value → quote it (jsonrepair's own law)
			emit("\"" + word + "\"")
		}
		expectKey = false
		i = j
	}

	// a still-open string is the CUT verdict — the caller refuses
	if inStr || inSingle {
		return b.String(), true
	}
	// append the missing closers (the stack is derivable from depth, but
	// the SHAPE matters: track what we opened)
	out := b.String()
	out += missingClosersFor(out)
	return out, false
}

// missingClosersFor derives the closer suffix from the open-bracket
// balance (the shallow repair the earlier rungs already own; kept here
// so the deep rung is self-sufficient).
func missingClosersFor(s string) string {
	var stack []byte
	inStr, esc := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	if inStr || len(stack) == 0 {
		return ""
	}
	var sb strings.Builder
	for i := len(stack) - 1; i >= 0; i-- {
		sb.WriteByte(stack[i])
	}
	return sb.String()
}


// isJSONNumber1744 reports whether the bare word is a JSON number
// (kept bare — only non-numeric bare values get quoted).
func isJSONNumber1744(w string) bool {
	if w == "" {
		return false
	}
	// strconv.ParseFloat accepts hex/inf forms JSON does not; the strict
	// shape check is cheap and honest.
	i := 0
	if w[0] == '-' {
		i++
	}
	digits, dot, exp := false, false, false
	for ; i < len(w); i++ {
		c := w[i]
		switch {
		case c >= '0' && c <= '9':
			digits = true
		case c == '.' && !dot && !exp:
			dot = true
		case (c == 'e' || c == 'E') && digits && !exp:
			exp = true
			if i+1 < len(w) && (w[i+1] == '+' || w[i+1] == '-') {
				i++
			}
		default:
			return false
		}
	}
	return digits
}
