// localtools.go — v0.20 the LOCAL TOOL SET (ported from the HF space's
// zero-setup capabilities: calculator, time, text utilities).
//
// These tools run IN-PROCESS in Go: no network, no filesystem, no API
// keys — they are always available in EVERY quick-chat turn (the ReAct
// ACTION protocol describes them alongside the web tools). This is the
// first installment of the HF→quick-chat port: the HF judge/agent had a
// calculator + clock + text utilities with zero user setup; now the
// quick chat does too, plus uuid/base64/hash/json/url/regex/random —
// 10 local tools + web_search/web_fetch = a 12-tool chain with no
// configuration whatsoever.
//
// Safety: every implementation is a pure function with hard size caps
// (no eval, no shell, no FS; RE2 regexes can't backtrack-blow up;
// inputs clamped). The PM bridge reaches these through
// GET /api/tools/local?name=&args= — same code, one implementation.
package llm

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// LocalToolNames lists every local tool (order = protocol order).
var LocalToolNames = []string{
	"calculator", "time_now", "uuid", "random", "base64", "hash",
	"json_tool", "text_stats", "url_encode", "regex_extract",
	"docx_create", "xlsx_create", "zip_create", "zip_extract",
	"archive_create", "archive_extract",
}

// localToolsProtocol is the ACTION-protocol description of the local
// tools (composed into the full per-turn protocol in chat.go).
// v0.22: FILE TOOLS + auto-continue wording — the old "One tool per
// reply; chain tools across replies" made models believe each ACTION
// needed a fresh user turn (observed live: kimi refused mid-chain test
// turns with "I can only send one tool call per turn — that's a hard
// protocol rule"). The loop now says explicitly that OBSERVATIONs arrive
// automatically and the model must keep going.
const localToolsProtocol = `You have access to local tools (run instantly on the device):
ACTION: calculator {"expr": "2+2*10"} — arithmetic; + - * / % ^ ( ) and sqrt/ln/log/abs/round/floor/ceil/sin/cos/tan/exp, pi, e
ACTION: time_now {"tz": "UTC"} — current date+time (IANA zone, "+HH:MM" offset, or UTC)
ACTION: uuid {"count": 3} — generate UUIDv4 ids
ACTION: random {"min": 1, "max": 100, "count": 1, "unique": true} — random integers
ACTION: base64 {"mode": "encode|decode", "text": "..."} — base64 transform
ACTION: hash {"algo": "md5|sha1|sha256", "text": "..."} — hex digest
ACTION: json_tool {"mode": "format|validate|minify", "text": "..."} — JSON utilities
ACTION: text_stats {"text": "..."} — chars/words/lines/sentences/bytes + reading time
ACTION: url_encode {"mode": "encode|decode", "text": "..."} — percent encoding
ACTION: regex_extract {"pattern": "...", "text": "...", "group": 0} — regex matches
ACTION: docx_create {"name": "f.docx", "blocks": [{"type": "title|heading|subheading|paragraph|bullet|number|quote", "text": "...", "bold": true, "italic": true, "color": "FFD700", "size": 28, "font": "Times New Roman", "align": "center", "runs": [{"text": "...", "bold": true}]}]} — build a REAL Word .docx with styled headings, colored/bold/italic/underline/strikethrough runs, fonts, sizes, alignment, spacing. Saved as a downloadable artifact.
ACTION: xlsx_create {"name": "f.xlsx", "sheets": [{"name": "Data", "bold_header": true, "rows": [["h1", "h2"], [1, 2]]}]} — build a REAL Excel .xlsx (multi-sheet, numbers + text, bold headers). Saved as a downloadable artifact.
ACTION: zip_create {"name": "b.zip", "files": [{"name": "a.txt", "content": "..."}]} — build a real .zip archive from named text/base64 files. Saved as a downloadable artifact.
ACTION: zip_extract {"b64": "<zip bytes>"} — list a zip archive's contents and extract its files as artifacts.
ACTION: archive_create {"name": "b.tar.gz", "files": [{"name": "a.txt", "content": "..."}]} — pack files into ANY format: .zip .7z .tar .tar.gz .tgz .tar.bz2 .tar.xz .tar.zst .gz .bz2 .xz .zst. RAR cannot be created (proprietary) — use 7z or zip. Saved as a downloadable artifact.
ACTION: archive_extract {"artifact": "b.7z"} — unpack ANY archive (zip, 7z, rar, tar, tar.gz, tar.bz2, tar.xz, tar.zst, gz, bz2, xz, zst — detected from the bytes, not the name) and extract its files as artifacts.
ACTION: delegate {"prompt": "<question>", "models": ["nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "privatemodeai/kimi-k2.6"]} — consult up to 3 OTHER models in parallel and weigh their answers (multi-model swarm)
For REAL files (Word/Excel/zip) ALWAYS use docx_create/xlsx_create/zip_create instead of hand-writing base64 into the chat — the tools build valid binaries the user can download. After a file tool reports "Saved as artifact", do NOT also emit an artifact block for that same file — that would attach it twice.
Use a tool whenever it beats guessing (math, time, encodings, ids, validation, files).`

// IsLocalTool reports whether name is a local tool.
func IsLocalTool(name string) bool {
	for _, n := range LocalToolNames {
		if n == name {
			return true
		}
	}
	return false
}

// RunLocalTool executes a local tool by name with raw JSON args.
// v0.22: file tools (docx/xlsx/zip) get the ArtifactSink so the binaries
// they build land in the session's artifact drawer; compute tools ignore
// it (nil is fine — file tools then just report without saving).
// Returns the observation text. Errors are returned as observation
// strings too (the ReAct loop feeds them back to the model, which can
// correct its arguments — that IS the protocol).
func RunLocalTool(name, argJSON string, sink ArtifactSink) string {
	var args map[string]any
	if strings.TrimSpace(argJSON) != "" {
		if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
			return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	str := func(k, def string) string {
		if v, ok := args[k].(string); ok {
			return v
		}
		return def
	}
	num := func(k string, def float64) float64 {
		if v, ok := args[k].(float64); ok {
			return v
		}
		return def
	}
	text := func(k string) string {
		// accept "text" or "input"
		if v, ok := args["text"].(string); ok {
			return clampRunes(v, 200_000)
		}
		if v, ok := args["input"].(string); ok {
			return clampRunes(v, 200_000)
		}
		return ""
	}

	switch name {
	case "calculator":
		return "OBSERVATION:\n" + calcEval(clampRunes(str("expr", ""), 1000))
	case "time_now":
		return "OBSERVATION:\n" + toolTimeNow(str("tz", "UTC"))
	case "uuid":
		n := int(num("count", 1))
		if n < 1 {
			n = 1
		}
		if n > 50 {
			n = 50
		}
		var b strings.Builder
		for i := 0; i < n; i++ {
			b.WriteString(newUUIDv4() + "\n")
		}
		return "OBSERVATION:\n" + strings.TrimRight(b.String(), "\n")
	case "random":
		return "OBSERVATION:\n" + toolRandom(num("min", 1), num("max", 100), int(num("count", 1)), truthy(args["unique"]))
	case "base64":
		mode := strings.ToLower(str("mode", "encode"))
		in := text("text")
		switch mode {
		case "decode":
			dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(in))
			if err != nil {
				dec, err = base64.URLEncoding.DecodeString(strings.TrimSpace(in))
			}
			if err != nil {
				return "OBSERVATION:\nerror: not valid base64 — " + err.Error()
			}
			return "OBSERVATION:\n" + string(dec)
		default:
			return "OBSERVATION:\n" + base64.StdEncoding.EncodeToString([]byte(in))
		}
	case "hash":
		algo := strings.ToLower(str("algo", "sha256"))
		in := text("text")
		switch algo {
		case "md5":
			s := md5.Sum([]byte(in))
			return "OBSERVATION:\n" + hex.EncodeToString(s[:])
		case "sha1":
			s := sha1.Sum([]byte(in))
			return "OBSERVATION:\n" + hex.EncodeToString(s[:])
		case "sha256":
			s := sha256.Sum256([]byte(in))
			return "OBSERVATION:\n" + hex.EncodeToString(s[:])
		default:
			return "OBSERVATION:\nerror: algo must be md5, sha1 or sha256"
		}
	case "json_tool":
		mode := strings.ToLower(str("mode", "validate"))
		in := text("text")
		switch mode {
		case "minify":
			var buf bytes.Buffer
			if err := json.Compact(&buf, []byte(in)); err != nil {
				return "OBSERVATION:\nerror: invalid JSON — " + err.Error()
			}
			return "OBSERVATION:\n" + buf.String()
		case "format":
			var out bytes.Buffer
			if err := json.Indent(&out, []byte(in), "", "  "); err != nil {
				return "OBSERVATION:\nerror: invalid JSON — " + err.Error()
			}
			return "OBSERVATION:\n" + out.String()
		default:
			if json.Valid([]byte(in)) {
				return "OBSERVATION:\nvalid JSON"
			}
			return "OBSERVATION:\ninvalid JSON"
		}
	case "text_stats":
		return "OBSERVATION:\n" + toolTextStats(text("text"))
	case "url_encode":
		mode := strings.ToLower(str("mode", "encode"))
		in := text("text")
		if mode == "decode" {
			dec, err := url.QueryUnescape(in)
			if err != nil {
				return "OBSERVATION:\nerror: " + err.Error()
			}
			return "OBSERVATION:\n" + dec
		}
		return "OBSERVATION:\n" + url.QueryEscape(in)
	case "regex_extract":
		pattern := clampRunes(str("pattern", ""), 512)
		in := text("text")
		group := int(num("group", 0))
		if pattern == "" {
			return "OBSERVATION:\nerror: pattern is required"
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return "OBSERVATION:\nerror: bad pattern — " + err.Error()
		}
		idx := re.FindAllStringSubmatchIndex(in, 50)
		if len(idx) == 0 {
			return "OBSERVATION:\n(no matches)"
		}
		var b strings.Builder
		for i, m := range idx {
			g := group
			if g < 0 || 2*g+1 >= len(m) {
				g = 0
			}
			lo, hi := m[2*g], m[2*g+1]
			if lo < 0 || hi < 0 {
				fmt.Fprintf(&b, "[%d] (group not matched)\n", i+1)
				continue
			}
			fmt.Fprintf(&b, "[%d] %s\n", i+1, clampRunes(in[lo:hi], 400))
		}
		return "OBSERVATION:\n" + strings.TrimRight(b.String(), "\n") + fmt.Sprintf("\n(%d matches)", len(idx))
	default:
		// v0.22 FILE TOOLS (filetools.go) — real binaries via the sink.
		// v0.23: archive_create/archive_extract = the multi-format
		// pack/unpack (zip/7z/rar-read/tar*/gz/bz2/xz/zst).
		switch name {
		case "docx_create":
			return toolDocxCreate(args, sink)
		case "xlsx_create":
			return toolXlsxCreate(args, sink)
		case "zip_create", "archive_create":
			return toolZipCreate(args, sink)
		case "zip_extract", "archive_extract":
			return toolZipExtract(args, sink)
		}
		return "OBSERVATION:\nerror: unknown local tool " + name
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func clampRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max]) + "…(truncated)"
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "1"
	case float64:
		return t != 0
	}
	return false
}

func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is effectively impossible; fall back to time.
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func toolTimeNow(tz string) string {
	var t time.Time
	name := strings.TrimSpace(tz)
	if name == "" {
		name = "UTC"
	}
	if strings.HasPrefix(name, "+") || strings.HasPrefix(name, "-") {
		off, err := time.ParseDuration(name + "h") // "+5" / "-3" (also "+5h30m" works)
		if err == nil {
			t = time.Now().UTC().Add(off)
			return t.Format("Monday, 2 January 2006, 15:04:05 (UTC" + name + ")")
		}
	}
	if loc, err := time.LoadLocation(name); err == nil {
		t = time.Now().In(loc)
	} else {
		t = time.Now().UTC()
		name = "UTC (unknown tz, fell back)"
	}
	return t.Format("Monday, 2 January 2006, 15:04:05.000 -0700 MST") + " [" + name + "]"
}

func toolRandom(min, max float64, count int, unique bool) string {
	if count < 1 {
		count = 1
	}
	if count > 100 {
		count = 100
	}
	// integer range when both bounds are integral
	if min == math.Trunc(min) && max == math.Trunc(max) {
		lo, hi := int64(min), int64(max)
		if hi < lo {
			lo, hi = hi, lo
		}
		span := hi - lo + 1
		seen := map[int64]bool{}
		var b strings.Builder
		for i := 0; i < count; i++ {
			var v int64
			for tries := 0; tries < 64; tries++ {
				n, err := rand.Int(rand.Reader, big.NewInt(span))
				if err != nil {
					return "OBSERVATION:\nerror: entropy unavailable"
				}
				v = lo + n.Int64()
				if !unique || !seen[v] || span <= int64(count) {
					break
				}
			}
			seen[v] = true
			fmt.Fprintf(&b, "%d\n", v)
		}
		return "OBSERVATION:\n" + strings.TrimRight(b.String(), "\n")
	}
	if max < min {
		min, max = max, min
	}
	var b strings.Builder
	for i := 0; i < count; i++ {
		buf := make([]byte, 8)
		_, _ = rand.Read(buf)
		f := float64(uint64(buf[0]) | uint64(buf[1])<<8 | uint64(buf[2])<<16 | uint64(buf[3])<<24 |
			uint64(buf[4])<<32 | uint64(buf[5])<<40 | uint64(buf[6])<<48 | uint64(buf[7])<<56)
		u := f / 1.8446744073709552e19 // [0,1)
		fmt.Fprintf(&b, "%.6f\n", min+u*(max-min))
	}
	return "OBSERVATION:\n" + strings.TrimRight(b.String(), "\n")
}

func toolTextStats(s string) string {
	chars := utf8.RuneCountInString(s)
	words := len(strings.Fields(s))
	lines := strings.Count(s, "\n") + 1
	if s == "" {
		lines = 0
	}
	sentences := 0
	for _, sep := range []string{". ", "!", "?", ".\n", "!\n", "?\n"} {
		sentences += strings.Count(s, sep)
	}
	if strings.HasSuffix(strings.TrimSpace(s), ".") || strings.HasSuffix(strings.TrimSpace(s), "!") || strings.HasSuffix(strings.TrimSpace(s), "?") {
		sentences++
	}
	paragraphs := len(strings.FieldsFunc(s, func(r rune) bool { return r == '\n' }))
	readSec := int(math.Ceil(float64(words) / 3.667)) // ~220 wpm
	return fmt.Sprintf("chars: %d\nbytes: %d\nwords: %d\nlines: %d\nsentences: %d (approx)\nparagraphs: %d\nreading time: ~%d min %d s (at 220 wpm)",
		chars, len(s), words, lines, sentences, paragraphs, readSec/60, readSec%60)
}

// ── calculator (recursive descent — no eval, no shells) ─────────────────────

func calcEval(expr string) string {
	s := strings.TrimSpace(expr)
	if s == "" {
		return "error: expr is required (e.g. \"2+2*10\")"
	}
	p := &calcParser{src: []rune(s)}
	v, err := p.parseExpr()
	if err != nil {
		return "error: " + err.Error()
	}
	p.skipWS()
	if p.pos < len(p.src) {
		return fmt.Sprintf("error: unexpected %q at position %d", string(p.src[p.pos]), p.pos)
	}
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

type calcParser struct {
	src []rune
	pos int
}

func (p *calcParser) skipWS() {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t' || p.src[p.pos] == '\n') {
		p.pos++
	}
}

func (p *calcParser) peek() rune {
	if p.pos < len(p.src) {
		return p.src[p.pos]
	}
	return 0
}

// parseExpr: term (('+'|'-') term)*
func (p *calcParser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for {
		p.skipWS()
		switch p.peek() {
		case '+':
			p.pos++
			r, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v += r
		case '-':
			p.pos++
			r, err := p.parseTerm()
			if err != nil {
				return 0, err
			}
			v -= r
		default:
			return v, nil
		}
	}
}

// parseTerm: factor (('*'|'/'|'%') factor)*
func (p *calcParser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for {
		p.skipWS()
		switch p.peek() {
		case '*':
			p.pos++
			r, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			v *= r
		case '/':
			p.pos++
			r, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			if r == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			v /= r
		case '%':
			p.pos++
			r, err := p.parseFactor()
			if err != nil {
				return 0, err
			}
			v = math.Mod(v, r)
		default:
			return v, nil
		}
	}
}

// parseFactor: unary ('^' factor)?  (right associative)
func (p *calcParser) parseFactor() (float64, error) {
	v, err := p.parseUnary()
	if err != nil {
		return 0, err
	}
	p.skipWS()
	if p.peek() == '^' {
		p.pos++
		r, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		return math.Pow(v, r), nil
	}
	return v, nil
}

// parseUnary: '-'? primary
func (p *calcParser) parseUnary() (float64, error) {
	p.skipWS()
	if p.peek() == '-' {
		p.pos++
		v, err := p.parseUnary()
		return -v, err
	}
	if p.peek() == '+' {
		p.pos++
		return p.parseUnary()
	}
	return p.parsePrimary()
}

// parsePrimary: number | '(' expr ')' | const | func '(' args ')'
func (p *calcParser) parsePrimary() (float64, error) {
	p.skipWS()
	c := p.peek()
	switch {
	case c == '(':
		p.pos++
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipWS()
		if p.peek() != ')' {
			return 0, fmt.Errorf("missing )")
		}
		p.pos++
		return v, nil
	case c >= '0' && c <= '9', c == '.':
		start := p.pos
		for p.pos < len(p.src) && (p.src[p.pos] >= '0' && p.src[p.pos] <= '9' || p.src[p.pos] == '.') {
			p.pos++
		}
		f, err := strconv.ParseFloat(string(p.src[start:p.pos]), 64)
		if err != nil {
			return 0, fmt.Errorf("bad number %q", string(p.src[start:p.pos]))
		}
		return f, nil
	case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
		start := p.pos
		for p.pos < len(p.src) {
			r := p.src[p.pos]
			if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
				p.pos++
			} else {
				break
			}
		}
		word := strings.ToLower(string(p.src[start:p.pos]))
		switch word {
		case "pi":
			return math.Pi, nil
		case "e":
			return math.E, nil
		}
		// function call
		p.skipWS()
		if p.peek() != '(' {
			return 0, fmt.Errorf("unknown identifier %q", word)
		}
		p.pos++
		var args []float64
		p.skipWS()
		if p.peek() == ')' {
			p.pos++
		} else {
			for {
				a, err := p.parseExpr()
				if err != nil {
					return 0, err
				}
				args = append(args, a)
				p.skipWS()
				if p.peek() == ',' {
					p.pos++
					continue
				}
				if p.peek() == ')' {
					p.pos++
					break
				}
				return 0, fmt.Errorf("expected , or ) in %s(...)", word)
			}
		}
		return applyCalcFn(word, args)
	}
	return 0, fmt.Errorf("unexpected %q", string(c))
}

func applyCalcFn(name string, args []float64) (float64, error) {
	need := func(n int) error {
		if len(args) != n {
			return fmt.Errorf("%s takes %d argument(s), got %d", name, n, len(args))
		}
		return nil
	}
	switch name {
	case "sqrt":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] < 0 {
			return 0, fmt.Errorf("sqrt of negative")
		}
		return math.Sqrt(args[0]), nil
	case "abs":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Abs(args[0]), nil
	case "round":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Round(args[0]), nil
	case "floor":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Floor(args[0]), nil
	case "ceil":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Ceil(args[0]), nil
	case "ln":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] <= 0 {
			return 0, fmt.Errorf("ln domain")
		}
		return math.Log(args[0]), nil
	case "log":
		if err := need(1); err != nil {
			return 0, err
		}
		if args[0] <= 0 {
			return 0, fmt.Errorf("log domain")
		}
		return math.Log10(args[0]), nil
	case "exp":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Exp(args[0]), nil
	case "sin":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Sin(args[0]), nil
	case "cos":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Cos(args[0]), nil
	case "tan":
		if err := need(1); err != nil {
			return 0, err
		}
		return math.Tan(args[0]), nil
	case "min":
		if len(args) < 1 {
			return 0, fmt.Errorf("min needs at least 1 argument")
		}
		m := args[0]
		for _, a := range args[1:] {
			if a < m {
				m = a
			}
		}
		return m, nil
	case "max":
		if len(args) < 1 {
			return 0, fmt.Errorf("max needs at least 1 argument")
		}
		m := args[0]
		for _, a := range args[1:] {
			if a > m {
				m = a
			}
		}
		return m, nil
	}
	return 0, fmt.Errorf("unknown function %q", name)
}
