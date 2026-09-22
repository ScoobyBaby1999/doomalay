package llm

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

// TestCalcEval exercises the calculator parser (v0.20) — the model trusts
// these results, so the arithmetic must be exactly right.
func TestCalcEval(t *testing.T) {
	cases := []struct {
		expr string
		want string
	}{
		{"2+2*10", "22"},
		{"(2+2)*10", "40"},
		{"2^10", "1024"},
		{"2+3*4-6/2", "11"},
		{"sqrt(144)", "12"},
		{"sqrt(2)^2", "2.0000000000000004"}, // float reality — the model sees this
		{"abs(-5)", "5"},
		{"round(2.5)", "3"},
		{"floor(2.9)", "2"},
		{"ceil(2.1)", "3"},
		{"ln(e)", "1"},
		{"log(1000)", "3"},
		{"pi", "3.141592653589793"},
		{"min(3,1,2)", "1"},
		{"max(3,1,2)", "3"},
		{"10 % 3", "1"},
		{"-4+10", "6"},
		{"--4", "4"},
		{"2^-1", "0.5"},
		{"((1+2)*(3+4))", "21"},
		{"", "error: expr is required"},
		{"2+", "error: unexpected"},
		{"1/0", "error: division by zero"},
		{"bogus(1)", "error: unknown function"},
		{"hello", "error: unknown identifier"},
	}
	for _, c := range cases {
		got := calcEval(c.expr)
		if !strings.HasPrefix(got, c.want) && got != c.want {
			t.Errorf("calcEval(%q) = %q, want prefix %q", c.expr, got, c.want)
		}
	}
}

// TestRunLocalTool checks each local tool's happy path + arg safety.
func TestRunLocalTool(t *testing.T) {
	// calculator via the dispatcher
	if got := RunLocalTool("calculator", `{"expr":"6*7"}`, nil); !strings.Contains(got, "42") {
		t.Errorf("calculator 6*7 = %q", got)
	}
	// uuid
	u := RunLocalTool("uuid", `{"count":2}`, nil)
	if !strings.Contains(u, "\n") {
		t.Errorf("uuid count=2 should return 2 lines: %q", u)
	}
	// base64 round-trip
	enc := RunLocalTool("base64", `{"mode":"encode","text":"doomalay"}`, nil)
	dec := RunLocalTool("base64", `{"mode":"decode","text":"`+strings.TrimSpace(strings.TrimPrefix(enc, "OBSERVATION:\n"))+`"}`, nil)
	if !strings.Contains(dec, "doomalay") {
		t.Errorf("base64 round-trip failed: %q → %q", enc, dec)
	}
	// hash — deterministic, verified value
	if got := RunLocalTool("hash", `{"algo":"sha256","text":"abc"}`, nil); !strings.Contains(got, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
		t.Errorf("sha256(abc) wrong: %q", got)
	}
	// json
	if got := RunLocalTool("json_tool", `{"mode":"validate","text":"{\"a\":1}"}`, nil); !strings.Contains(got, "valid JSON") {
		t.Errorf("json validate = %q", got)
	}
	// text_stats
	if got := RunLocalTool("text_stats", `{"text":"one two three"}`, nil); !strings.Contains(got, "words: 3") {
		t.Errorf("text_stats = %q", got)
	}
	// url round-trip
	if got := RunLocalTool("url_encode", `{"mode":"encode","text":"a b&c"}`, nil); !strings.Contains(got, "a+b%26c") {
		t.Errorf("url_encode = %q", got)
	}
	// regex
	if got := RunLocalTool("regex_extract", `{"pattern":"\\d+","text":"a1 b22 c333"}`, nil); !strings.Contains(got, "3 matches") {
		t.Errorf("regex_extract = %q", got)
	}
	// random bounds
	r := RunLocalTool("random", `{"min":1,"max":5,"count":10,"unique":true}`, nil)
	if strings.Contains(r, "error") {
		t.Errorf("random = %q", r)
	}
	// time
	if got := RunLocalTool("time_now", `{"tz":"UTC"}`, nil); !strings.Contains(got, "[UTC]") && !strings.Contains(got, "UTC") {
		t.Errorf("time_now = %q", got)
	}
	// bad args → a usable OBSERVATION error, not a panic
	if got := RunLocalTool("calculator", "not json", nil); !strings.Contains(got, "error") {
		t.Errorf("bad args should error: %q", got)
	}
	if got := RunLocalTool("nope", "{}", nil); !strings.Contains(got, "unknown local tool") {
		t.Errorf("unknown tool: %q", got)
	}
}

// TestParseActionAnyTool verifies the generalized ACTION regex.
func TestParseActionAnyTool(t *testing.T) {
	for _, c := range []struct {
		in   string
		tool string
		ok   bool
	}{
		{"ACTION: calculator {\"expr\": \"1+1\"}", "calculator", true},
		{"ACTION: web_search {\"query\": \"cats\"}", "web_search", true},
		{"ACTION: time_now {}", "time_now", true},
		{"ACTION: uuid", "uuid", true},
		{"Let me compute.\nACTION: calculator {\"expr\":\"2\"}", "calculator", true},
		{"Just a normal answer.", "", false},
	} {
		action, _, ok := parseAction(c.in)
		if ok != c.ok || (ok && action != c.tool) {
			t.Errorf("parseAction(%q) = (%q,%v), want (%q,%v)", c.in, action, ok, c.tool, c.ok)
		}
	}
}

// ── v0.22 file tools ─────────────────────────────────────────────────────

// memSink collects saved artifacts in memory (tests the sink contract).
type memSink struct{ saved map[string][]byte }

func (m *memSink) SaveArtifact(name string, data []byte, _ string) (string, int64, error) {
	if m.saved == nil {
		m.saved = map[string][]byte{}
	}
	m.saved[name] = data
	return "testid000001", int64(len(data)), nil
}

func (m *memSink) ReadArtifact(name string) ([]byte, error) {
	if d, ok := m.saved[name]; ok {
		return d, nil
	}
	return nil, os.ErrNotExist
}

// TestZipRoundTrip: zip_create → real archive → zip_extract reads it back.
func TestZipRoundTrip(t *testing.T) {
	sink := &memSink{}
	obs := RunLocalTool("zip_create", `{"name":"t.zip","files":[{"name":"a.txt","content":"hello"},{"name":"d/b.txt","content":"world"}]}`, sink)
	if !strings.Contains(obs, "Created") || !strings.Contains(obs, "a.txt") {
		t.Fatalf("zip_create observation: %q", obs)
	}
	zipBytes, ok := sink.saved["t.zip"]
	if !ok {
		t.Fatal("zip_create did not save t.zip")
	}
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("saved artifact is not a valid zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("want 2 files in zip, got %d", len(zr.File))
	}
	// extract from the same bytes
	extract := RunLocalTool("zip_extract", `{"b64":"`+base64.StdEncoding.EncodeToString(zipBytes)+`"}`, sink)
	if !strings.Contains(extract, "a.txt") || !strings.Contains(extract, "b.txt") {
		t.Fatalf("zip_extract observation: %q", extract)
	}
	if !strings.Contains(extract, "hello") || !strings.Contains(extract, "world") {
		t.Fatal("zip_extract should inline small text contents")
	}
	// engine-path by-name resolution (zip_extract {"artifact": ...})
	byName := RunLocalTool("zip_extract", `{"artifact":"t.zip"}`, sink)
	if !strings.Contains(byName, "a.txt") || !strings.Contains(byName, "world") {
		t.Fatalf("zip_extract by artifact name: %q", byName)
	}
	// path traversal is stripped
	bad := RunLocalTool("zip_create", `{"name":"evil.zip","files":[{"name":"../../etc/passwd","content":"x"}]}`, sink)
	if strings.Contains(bad, "../../") {
		t.Fatalf("path traversal not sanitized: %q", bad)
	}
}

// TestDocxCreate: the .docx must be a real zip with valid OOXML parts.
func TestDocxCreate(t *testing.T) {
	sink := &memSink{}
	obs := RunLocalTool("docx_create", `{"name":"hello.docx","blocks":[
		{"type":"title","text":"Hello World"},
		{"type":"heading","text":"Sub"},
		{"type":"paragraph","runs":[{"text":"red ","color":"FF0000","bold":true},{"text":"blue","color":"0000FF"}]},
		{"type":"bullet","text":"b1"},{"type":"quote","text":"q"}]}`, sink)
	if !strings.Contains(obs, "Created a real Word document") {
		t.Fatalf("docx_create observation: %q", obs)
	}
	data, ok := sink.saved["hello.docx"]
	if !ok {
		t.Fatal("docx_create did not save hello.docx")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("docx is not a valid zip: %v", err)
	}
	want := map[string]bool{"[Content_Types].xml": false, "_rels/.rels": false, "word/document.xml": false, "word/styles.xml": false}
	for _, f := range zr.File {
		if seen, ok := want[f.Name]; ok {
			_ = seen
			want[f.Name] = true
		}
	}
	for name, seen := range want {
		if !seen {
			t.Errorf("docx missing part %s", name)
		}
	}
	// document.xml must carry the styled runs
	var docRC io.ReadCloser
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			docRC, _ = f.Open()
		}
	}
	if docRC == nil {
		t.Fatal("no word/document.xml in the docx")
	}
	raw, _ := io.ReadAll(docRC)
	doc := string(raw)
	for _, frag := range []string{"Hello World", "FF0000", "0000FF", "<w:b/>", "Heading1", "Quote"} {
		if !strings.Contains(doc, frag) {
			t.Errorf("document.xml missing %q", frag)
		}
	}
	if err := xml.Unmarshal([]byte(doc), new(any)); err != nil {
		t.Errorf("document.xml is not well-formed XML: %v", err)
	}
}

// TestXlsxCreate: the .xlsx must be a valid workbook zip.
func TestXlsxCreate(t *testing.T) {
	sink := &memSink{}
	obs := RunLocalTool("xlsx_create", `{"name":"data.xlsx","sheets":[
		{"name":"Numbers","bold_header":true,"rows":[["a","b"],[1,2],["x",true]]}]}`, sink)
	if !strings.Contains(obs, "Created a real Excel workbook") {
		t.Fatalf("xlsx_create observation: %q", obs)
	}
	data, ok := sink.saved["data.xlsx"]
	if !ok {
		t.Fatal("xlsx_create did not save data.xlsx")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("xlsx is not a valid zip: %v", err)
	}
	parts := map[string]bool{}
	for _, f := range zr.File {
		parts[f.Name] = true
	}
	for _, need := range []string{"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/_rels/workbook.xml.rels"} {
		if !parts[need] {
			t.Errorf("xlsx missing part %s", need)
		}
	}
	var shRC, wbRC io.ReadCloser
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			shRC, _ = f.Open()
		}
		if f.Name == "xl/workbook.xml" {
			wbRC, _ = f.Open()
		}
	}
	if shRC == nil {
		t.Fatal("no sheet1.xml in the xlsx")
	}
	if wbRC == nil {
		t.Fatal("no workbook.xml in the xlsx")
	}
	raw, _ := io.ReadAll(shRC)
	sheet := string(raw)
	wb, _ := io.ReadAll(wbRC)
	if !strings.Contains(string(wb), "Numbers") {
		t.Error("workbook.xml missing sheet name Numbers")
	}
	for _, frag := range []string{"inlineStr", "<v>1</v>", "t=\"b\""} {
		if !strings.Contains(sheet, frag) {
			t.Errorf("sheet1.xml missing %q", frag)
		}
	}
	if err := xml.Unmarshal([]byte(sheet), new(any)); err != nil {
		t.Errorf("sheet1.xml is not well-formed XML: %v", err)
	}
}

// TestParseActionPreamble: prose-prefixed ACTION lines must parse (the
// "chain gets interrupted" root cause — v0.22).
func TestParseActionPreamble(t *testing.T) {
	cases := []struct {
		in   string
		tool string
		arg  string
	}{
		{"I'm going to run a long toolchain demo, hitting all the local tools.\n\nACTION: time_now {\"tz\": \"UTC\"}", "time_now", `{"tz":"UTC"}`},
		{"**Step 1/12** Get the time.\nACTION: time_now{\"tz\":\"UTC\"}", "time_now", `{"tz":"UTC"}`},
		{"Sure.\nACTION: calculator {\"expr\": \"2+2\"}\n", "calculator", `{"expr":"2+2"}`},
		{"ACTION: web_search cat diapers", "web_search", `{"query":"cat diapers"}`},
		{"first\nACTION: uuid {\"count\":1}\nlater text ignored", "uuid", `{"count":1}`},
	}
	for _, c := range cases {
		action, arg, ok := parseAction(c.in)
		if !ok || action != c.tool {
			t.Errorf("parseAction(%q) = (%q,%v), want (%q,true)", c.in, action, ok, c.tool)
			continue
		}
		var got, want map[string]any
		_ = json.Unmarshal([]byte(arg), &got)
		_ = json.Unmarshal([]byte(c.arg), &want)
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("parseAction(%q) arg = %v, want %v", c.in, got, want)
		}
	}
}

// TestBalancedJSON: brace/quote balance for pretty-printed extension.
func TestBalancedJSON(t *testing.T) {
	if balancedJSON(`{"a": 1`) {
		t.Error("unbalanced object reported balanced")
	}
	if !balancedJSON(`{"a": 1}`) {
		t.Error("balanced object reported unbalanced")
	}
	if balancedJSON(`{"a": "x`) {
		t.Error("open string reported balanced")
	}
}

// TestArchiveToolsMultiFormat (v0.23): archive_create/archive_extract work
// for every packable format through the SAME tool entry the model uses,
// and zip_create/zip_extract remain as aliases.
func TestArchiveToolsMultiFormat(t *testing.T) {
	for _, name := range []string{"b.zip", "b.tar", "b.tar.gz", "b.tgz", "b.tar.bz2", "b.tar.xz", "b.tar.zst", "b.7z"} {
		t.Run(name, func(t *testing.T) {
			sink := &memSink{}
			obs := RunLocalTool("archive_create", fmt.Sprintf(`{"name":%q,"files":[{"name":"a.txt","content":"hello"},{"name":"d/b.txt","content":"world"}]}`, name), sink)
			if !strings.Contains(obs, "Created") {
				t.Fatalf("%s observation: %q", name, obs)
			}
			if _, ok := sink.saved[name]; !ok {
				t.Fatalf("%s not saved as artifact (saved: %v)", name, sink.saved)
			}
			// round-trip through the extractor: members come back as artifacts
			obs2 := RunLocalTool("archive_extract", fmt.Sprintf(`{"artifact":%q}`, name), sink)
			if !strings.Contains(obs2, "a.txt") || !strings.Contains(obs2, "b.txt") {
				t.Fatalf("%s extract observation: %q", name, obs2)
			}
			if string(sink.saved["a.txt"]) != "hello" {
				t.Fatalf("%s member content wrong: %q", name, sink.saved["a.txt"])
			}
		})
	}
	// aliases still work
	if obs := RunLocalTool("zip_create", `{"name":"z.zip","files":[{"name":"q.txt","content":"x"}]}`, &memSink{}); !strings.Contains(obs, "Created") {
		t.Fatalf("zip_create alias broken: %q", obs)
	}
	// rar creation without a rar binary → the helpful licensing error
	if obs := RunLocalTool("archive_create", `{"name":"r.rar","files":[{"name":"q.txt","content":"x"}]}`, &memSink{}); strings.Contains(obs, "Created") {
		t.Logf("system has a rar binary (created fine)")
	} else if !strings.Contains(obs, "error") {
		t.Fatalf("rar create unexpected observation: %q", obs)
	}
}
