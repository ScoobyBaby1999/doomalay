package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// TestPreviewDocx: the docx the model's tool builds must parse back into
// styled viewer blocks.
func TestPreviewDocx(t *testing.T) {
	sink := &memSink2{}
	obs := llm.RunLocalTool("docx_create", `{"name":"p.docx","blocks":[
		{"type":"title","text":"Quarterly Report"},
		{"type":"heading","text":"Revenue"},
		{"type":"paragraph","runs":[{"text":"Growth of ","bold":true},{"text":"42%","color":"00FF00","bold":true}]},
		{"type":"bullet","text":"EMEA up"},
		{"type":"quote","text":"Forward-looking."}
	]}`, sink)
	if !strings.Contains(obs, "Created") {
		t.Fatalf("docx_create: %q", obs)
	}
	data := sink.saved["p.docx"]
	kind, payload := previewOffice(data)
	if kind != "docx" {
		t.Fatalf("previewOffice kind = %q", kind)
	}
	bb, _ := payload["blocks"]
	raw, _ := json.Marshal(bb)
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
		Runs []struct {
			Text  string `json:"text"`
			Bold  bool   `json:"bold"`
			Color string `json:"color"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 5 {
		t.Fatalf("blocks = %d, want 5 (%s)", len(blocks), raw)
	}
	if blocks[0].Type != "title" || blocks[0].Text != "Quarterly Report" {
		t.Fatalf("title block wrong: %+v", blocks[0])
	}
	if blocks[1].Type != "heading" {
		t.Fatalf("heading block wrong: %+v", blocks[1])
	}
	if blocks[2].Text != "Growth of 42%" {
		t.Fatalf("runs text wrong: %+v", blocks[2])
	}
	// v0.23b: run-level text + formatting must survive the parse (the
	// value-copy bug shipped runs empty + colorless)
	if len(blocks[2].Runs) != 2 {
		t.Fatalf("paragraph runs = %d, want 2 (%s)", len(blocks[2].Runs), raw)
	}
	if blocks[2].Runs[0].Text != "Growth of " || !blocks[2].Runs[0].Bold {
		t.Fatalf("run 0 wrong: %+v", blocks[2].Runs[0])
	}
	if blocks[2].Runs[1].Text != "42%" || blocks[2].Runs[1].Color != "00FF00" || !blocks[2].Runs[1].Bold {
		t.Fatalf("run 1 wrong: %+v", blocks[2].Runs[1])
	}
	if blocks[3].Type != "bullet" {
		t.Fatalf("bullet block wrong: %+v", blocks[3])
	}
	if blocks[4].Type != "quote" {
		t.Fatalf("quote block wrong: %+v", blocks[4])
	}
}

// TestPreviewXlsx: multi-sheet workbooks with inline strings + numbers.
func TestPreviewXlsx(t *testing.T) {
	sink := &memSink2{}
	obs := llm.RunLocalTool("xlsx_create", `{"name":"p.xlsx","sheets":[
		{"name":"Revenue","bold_header":true,"rows":[["Item","USD"],["Subs",1250],["Ads",870]]},
		{"name":"Costs","rows":[["Cloud",99.5]]}
	]}`, sink)
	if !strings.Contains(obs, "Created") {
		t.Fatalf("xlsx_create: %q", obs)
	}
	data := sink.saved["p.xlsx"]
	kind, payload := previewOffice(data)
	if kind != "xlsx" {
		t.Fatalf("previewOffice kind = %q", kind)
	}
	ss, _ := payload["sheets"]
	raw, _ := json.Marshal(ss)
	var sheets []struct {
		Name string     `json:"name"`
		Rows [][]string `json:"rows"`
	}
	if err := json.Unmarshal(raw, &sheets); err != nil {
		t.Fatal(err)
	}
	if len(sheets) != 2 || sheets[0].Name != "Revenue" || sheets[1].Name != "Costs" {
		t.Fatalf("sheets wrong: %s", raw)
	}
	if len(sheets[0].Rows) != 3 || sheets[0].Rows[0][0] != "Item" || sheets[0].Rows[1][1] != "1250" {
		t.Fatalf("sheet rows wrong: %s", raw)
	}
}

// TestPreviewXlsxSharedStrings: sharedStrings-based workbooks (the kind
// LibreOffice/Excel emit) must preview identically to inlineStr ones.
func TestPreviewXlsxSharedStrings(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string]string{
		"[Content_Types].xml":        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="a"/><Default Extension="xml" ContentType="b"/><Override PartName="/xl/workbook.xml" ContentType="c"/></Types>`,
		"_rels/.rels":                `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
		"xl/workbook.xml":            `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>alpha</t></si><si><t>beta</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>7</v></c></row></sheetData></worksheet>`,
	}
	for k, v := range files {
		w, _ := zw.Create(k)
		w.Write([]byte(v))
	}
	zw.Close()

	kind, payload := previewOffice(buf.Bytes())
	if kind != "xlsx" {
		t.Fatalf("kind = %q", kind)
	}
	ss, _ := json.Marshal(payload["sheets"])
	var sheets []struct {
		Name string     `json:"name"`
		Rows [][]string `json:"rows"`
	}
	if err := json.Unmarshal(ss, &sheets); err != nil {
		t.Fatal(err)
	}
	if len(sheets) != 1 || sheets[0].Rows[0][0] != "alpha" || sheets[0].Rows[0][1] != "beta" || sheets[0].Rows[1][0] != "7" {
		t.Fatalf("shared strings rows wrong: %s", ss)
	}
}

type memSink2 struct {
	saved map[string][]byte
}

func (m *memSink2) SaveArtifact(name string, data []byte, _ string) (string, int64, error) {
	if m.saved == nil {
		m.saved = map[string][]byte{}
	}
	m.saved[name] = data
	return "testid", int64(len(data)), nil
}

func (m *memSink2) ReadArtifact(name string) ([]byte, error) {
	if d, ok := m.saved[name]; ok {
		return d, nil
	}
	return nil, errNotExist
}

var errNotExist = &notFoundErr{}

type notFoundErr struct{}

func (e *notFoundErr) Error() string { return "not found" }
