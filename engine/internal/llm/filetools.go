// filetools.go — v0.22 FILE TOOLS: real binary artifacts, zero setup.
//
// The user spec: "have it generate 10 files that are complex (word, SQL,
// ext) have it be able to extract zip contents and create zip contents
// too." Models can hand-write text formats (csv/sql/md/…) but CANNOT
// hand-craft binaries (docx/xlsx/zip are ZIP containers with checksums —
// observed live: the model fell back to an .rtf because a genuine .docx
// "would almost certainly produce a corrupted file"). These tools build
// REAL OOXML/zip binaries in Go:
//
//	zip_create  {"name": "b.zip", "files": [{"name","content","encoding"}]}
//	zip_extract {"artifact": "b.zip"} or {"b64": "..."} — lists + extracts
//	docx_create {"name": "h.docx", "blocks": [...styled paragraphs...]}
//	xlsx_create {"name": "d.xlsx", "sheets": [{"name","rows"}]}
//
// Artifacts are saved through the ArtifactSink interface (compartment
// boundary: the llm package never touches sessions/disk — the server
// implements the sink; the PM bridge reaches the same code via
// GET /api/tools/local?session=…).
package llm

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/archive"
)

// ArtifactSink is where file tools persist the binaries they build.
// Implemented by the server (session artifacts dir); nil = the tool
// still works but only returns the bytes summary (no saved file).
type ArtifactSink interface {
	SaveArtifact(name string, data []byte, source string) (id string, size int64, err error)
	// ReadArtifact resolves a file saved earlier in the same chat
	// (zip_extract {"artifact": "bundle.zip"} on the ENGINE path — the
	// HTTP bridge path resolves via ?session=, this serves the Go loop).
	ReadArtifact(name string) ([]byte, error)
}

// savedArtifactNote is the OBSERVATION tail every file tool appends when
// the sink saved the result — one consistent user-facing contract.
func savedArtifactNote(name string, size int64) string {
	return fmt.Sprintf("\nSaved as artifact %q (%s) — the user can open/download it from the chat's artifact drawer. Tell the user the file is ready.", name, humanBytes(size))
}

func humanBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
	}
}

// capFilespec keeps a tool call bounded (also the freeze guard — a model
// asking for a 5000-file zip can't wedge the loop).
const (
	maxZipFiles     = 200
	maxZipUnpacked  = 32 << 20 // 32 MB total uncompressed input
	maxExtractFiles = 60
	maxExtractSize  = 400_000 // per text file inlined into the observation
)

// ── zip_create / archive_create ─────────────────────────────────────────────
//
// v0.23: both zip_create AND archive_create run through internal/archive —
// same file spec, the format picked from the NAME's extension:
// .zip .tar .tar.gz/.tgz .tar.bz2/.tbz2 .tar.xz/.txz .tar.zst .7z .gz .bz2
// .xz .zst (single-file for the last four). .rar without a system `rar`
// binary returns the honest licensing error (extraction still works).

func toolZipCreate(args map[string]any, sink ArtifactSink) string {
	name := sanitizeArchiveName(strArg(args, "name", ""), "bundle.zip")
	rawFiles, _ := args["files"].([]any)
	if len(rawFiles) == 0 {
		return "OBSERVATION:\nerror: files is required — usage: archive_create {\"name\": \"out.zip\", \"files\": [{\"name\": \"a.txt\", \"content\": \"...\"}]}"
	}
	inputs, err := fileInputsFromArgs(rawFiles)
	if err != nil {
		return "OBSERVATION:\nerror: " + err.Error()
	}

	out, format, err := archive.Create(name, inputs)
	if err != nil {
		return "OBSERVATION:\nerror: " + err.Error()
	}

	var written []string
	for _, f := range inputs {
		written = append(written, fmt.Sprintf("  %s (%s)", f.Name, humanBytes(int64(len(f.Data)))))
	}
	obs := fmt.Sprintf("OBSERVATION:\nCreated %q (%s, %d files, %s):\n%s",
		name, format, len(written), humanBytes(int64(len(out))), strings.Join(written, "\n"))
	if sink != nil {
		if id, size, err := sink.SaveArtifact(name, out, "model"); err == nil {
			obs += savedArtifactNote(name, size)
			_ = id
		}
	}
	return obs
}

// fileInputsFromArgs converts the tool's files:[{name,content,encoding}]
// spec into archive.FileInput (with the shared caps + base64 decoding).
func fileInputsFromArgs(rawFiles []any) ([]archive.FileInput, error) {
	var inputs []archive.FileInput
	var total int64
	for _, rf := range rawFiles {
		if len(inputs) >= archive.MaxFiles {
			break
		}
		f, ok := rf.(map[string]any)
		if !ok {
			continue
		}
		fname := path.Clean("/" + strArg(f, "name", ""))[1:] // strip traversal
		if fname == "" || fname == "." {
			continue
		}
		content := strArg(f, "content", "")
		enc := strings.ToLower(strArg(f, "encoding", ""))
		var data []byte
		if enc == "base64" {
			var err error
			data, err = base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
				if r == '\n' || r == '\r' || r == ' ' {
					return -1
				}
				return r
			}, content))
			if err != nil {
				return nil, fmt.Errorf("file %q has invalid base64 content — %v", fname, err)
			}
		} else {
			data = []byte(content)
		}
		total += int64(len(data))
		if total > maxZipUnpacked {
			return nil, fmt.Errorf("archive contents exceed the %s cap — split into multiple archives", humanBytes(maxZipUnpacked))
		}
		inputs = append(inputs, archive.FileInput{Name: fname, Data: data})
	}
	if len(inputs) == 0 {
		return nil, fmt.Errorf("no usable files in the files list")
	}
	return inputs, nil
}

// ── zip_extract / archive_extract ───────────────────────────────────────────
//
// v0.23: ANY format — zip, 7z, rar (4 + 5), tar, tar.gz/bz2/xz/zst, and
// single-file gz/bz2/xz/zst. The format is SNIFFED from the bytes, never
// trusted from the filename, so "extract this .zip that's really a .rar"
// just works. Every text member is re-saved as an artifact; small text
// members also inline into the observation so the model can read them
// without another round-trip.

func toolZipExtract(args map[string]any, sink ArtifactSink) string {
	var data []byte
	if artName := strArg(args, "artifact", ""); artName != "" && sink != nil {
		raw, err := sink.ReadArtifact(artName)
		if err != nil {
			return "OBSERVATION:\nerror: no saved artifact named \"" + artName + "\" — create it first (archive_create) or pass {\"b64\": ...}"
		}
		data = raw
	} else if b64 := strArg(args, "b64", ""); b64 != "" {
		var err error
		data, err = base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, b64))
		if err != nil {
			return "OBSERVATION:\nerror: not valid base64 — " + err.Error()
		}
	} else if src := strArg(args, "text", ""); src != "" {
		data = []byte(src)
	} else {
		return "OBSERVATION:\nerror: pass the archive as {\"b64\": \"...\"} or {\"artifact\": \"name.zip\"} (from a file you created with archive_create)"
	}

	format, entries, err := archive.List(data)
	if err != nil {
		return "OBSERVATION:\nerror: not a readable archive — " + err.Error()
	}

	var lines []string
	var extracted int
	shown := 0
	for _, e := range entries {
		if e.IsDir {
			continue
		}
		if shown >= maxExtractFiles {
			lines = append(lines, "  … (more files truncated)")
			break
		}
		shown++
		content, rerr := archive.Read(data, e.Name)
		if rerr != nil {
			lines = append(lines, fmt.Sprintf("  %s (unreadable: %v)", e.Name, rerr))
			continue
		}
		lines = append(lines, fmt.Sprintf("  %s (%s)", e.Name, humanBytes(int64(len(content)))))
		// re-save every entry as its own artifact so the user can use them
		if sink != nil && len(content) > 0 {
			base := path.Base(e.Name)
			if _, _, err := sink.SaveArtifact(base, content, "model"); err == nil {
				extracted++
				lines = append(lines, fmt.Sprintf("    ↳ extracted as artifact %q", base))
			}
		}
		if len(content) <= maxExtractSize && isProbablyText(content) {
			// small text files also inline into the observation (the model
			// can read them without another round-trip)
			if len(content) <= 4000 {
				lines = append(lines, "    ┌─ contents:")
				for _, ln := range strings.Split(strings.TrimRight(string(content), "\n"), "\n") {
					lines = append(lines, "    │ "+ln)
				}
				lines = append(lines, "    └─")
			}
		}
	}
	obs := fmt.Sprintf("OBSERVATION:\n%s archive contents (%d files):\n%s", format, len(entries), strings.Join(lines, "\n"))
	if sink != nil && extracted > 0 {
		obs += fmt.Sprintf("\n%d files extracted to artifacts.", extracted)
	}
	return obs
}

func isProbablyText(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	nul := 0
	for _, c := range b {
		if c == 0 {
			nul++
		}
	}
	return nul*100/len(b) < 1
}

// ── docx_create ────────────────────────────────────────────────────────────
//
// A real .docx is a zip of OOXML parts. The minimal set Word/Google Docs/
// LibreOffice accept:
//
//      [Content_Types].xml  — part registry
//      _rels/.rels           — package rels (points at word/document.xml)
//      word/document.xml     — the body
//      word/styles.xml       — Title/Heading1/Heading2/Quote styles
//
// Block spec (all optional props; text is the only required one):
//
//      {"type":"title"|"heading"|"subheading"|"paragraph"|"bullet"|"number"|"quote",
//       "text":"...", "bold":true, "italic":true, "underline":true, "strike":true,
//       "color":"FFD700", "size":28, "font":"Times New Roman", "align":"center",
//       "runs":[{"text":"...","bold":true,"color":"0","size":48}, ...]}

type docxRun struct {
	Text      string `json:"text"`
	Bold      bool   `json:"bold"`
	Italic    bool   `json:"italic"`
	Underline bool   `json:"underline"`
	Strike    bool   `json:"strike"`
	Color     string `json:"color"`
	Size      int    `json:"size"`
	Font      string `json:"font"`
}

type docxBlock struct {
	Type    string    `json:"type"`
	Text    string    `json:"text"`
	Runs    []docxRun `json:"runs"`
	Bold    bool      `json:"bold"`
	Italic  bool      `json:"italic"`
	Color   string    `json:"color"`
	Size    int       `json:"size"`
	Font    string    `json:"font"`
	Align   string    `json:"align"`
	Spacing int       `json:"spacing"`
}

func toolDocxCreate(args map[string]any, sink ArtifactSink) string {
	name := sanitizeFileToolName(strArg(args, "name", ""), "document.docx", ".docx")
	rawBlocks, _ := args["blocks"].([]any)
	if len(rawBlocks) == 0 {
		return "OBSERVATION:\nerror: blocks is required — usage: docx_create {\"name\": \"f.docx\", \"blocks\": [{\"type\": \"title\", \"text\": \"Hello\"}, {\"type\": \"paragraph\", \"runs\": [{\"text\": \"red \", \"color\": \"FF0000\"}, {\"text\": \"blue\", \"color\": \"0000FF\", \"bold\": true}]}]}"
	}
	var blocks []docxBlock
	for _, rb := range rawBlocks {
		b, err := remarshalBlock(rb)
		if err != nil {
			continue
		}
		if b.Type == "" {
			b.Type = "paragraph"
		}
		blocks = append(blocks, b)
	}
	if len(blocks) == 0 {
		return "OBSERVATION:\nerror: no usable blocks"
	}

	var body strings.Builder
	for _, b := range blocks {
		body.WriteString(docxParagraphXML(b))
	}

	doc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + body.String() + `
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body>
</w:document>`

	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

	rels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	styles := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="220" w:after="110"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="567"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`

	data, err := buildZipMem(map[string]string{
		"[Content_Types].xml": contentTypes,
		"_rels/.rels":         rels,
		"word/document.xml":   doc,
		"word/styles.xml":     styles,
	})
	if err != nil {
		return "OBSERVATION:\nerror: " + err.Error()
	}

	obs := fmt.Sprintf("OBSERVATION:\nCreated a real Word document %q — %d blocks (%s).",
		name, len(blocks), humanBytes(int64(len(data))))
	if sink != nil {
		if _, size, err := sink.SaveArtifact(name, data, "model"); err == nil {
			obs += savedArtifactNote(name, size)
		}
	}
	return obs
}

// docxParagraphXML renders one block as w:p, using the style for
// title/headings/quote and inline run properties otherwise.
func docxParagraphXML(b docxBlock) string {
	style := ""
	defaultBold, defaultSize := b.Bold, b.Size
	switch b.Type {
	case "title":
		style = `<w:pStyle w:val="Title"/>`
		defaultBold = true
		if defaultSize == 0 {
			defaultSize = 56
		}
	case "heading", "heading1", "h1":
		style = `<w:pStyle w:val="Heading1"/>`
		defaultBold = true
		if defaultSize == 0 {
			defaultSize = 40
		}
	case "subheading", "heading2", "h2":
		style = `<w:pStyle w:val="Heading2"/>`
		defaultBold = true
		if defaultSize == 0 {
			defaultSize = 32
		}
	case "quote":
		style = `<w:pStyle w:val="Quote"/>`
	case "bullet":
		style = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`
	case "number", "numbered":
		style = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`
	}

	var pPr strings.Builder
	pPr.WriteString("<w:pPr>")
	pPr.WriteString(style)
	if b.Align != "" {
		if jc := docxAlign(b.Align); jc != "" {
			pPr.WriteString(`<w:jc w:val="` + jc + `"/>`)
		}
	} else if b.Type == "title" {
		pPr.WriteString(`<w:jc w:val="center"/>`)
	}
	if b.Spacing > 0 {
		pPr.WriteString(fmt.Sprintf(`<w:spacing w:before="%d" w:after="%d"/>`, b.Spacing*20, b.Spacing*20))
	}
	if b.Color != "" || b.Size != 0 || b.Font != "" || defaultBold || b.Italic {
		pPr.WriteString("<w:rPr>")
		pPr.WriteString(docxRunProps(b.Bold || defaultBold, b.Italic, false, false, b.Color, sizeOr(b.Size, defaultSize), b.Font))
		pPr.WriteString("</w:rPr>")
	}
	pPr.WriteString("</w:pPr>")

	var runs strings.Builder
	if len(b.Runs) > 0 {
		for _, r := range b.Runs {
			runs.WriteString("<w:r>" + docxRunPropsXML(r) + xmlText(r.Text) + "</w:r>")
		}
	} else {
		props := docxRunPropsXML(docxRun{Bold: b.Bold || defaultBold, Italic: b.Italic, Color: b.Color, Size: sizeOr(b.Size, defaultSize), Font: b.Font})
		runs.WriteString("<w:r>" + props + xmlText(b.Text) + "</w:r>")
	}
	return "<w:p>" + pPr.String() + runs.String() + "</w:p>"
}

func docxRunPropsXML(r docxRun) string {
	return "<w:rPr>" + docxRunProps(r.Bold, r.Italic, r.Underline, r.Strike, r.Color, r.Size, r.Font) + "</w:rPr>"
}

func docxRunProps(bold, italic, underline, strike bool, color string, size int, font string) string {
	var p strings.Builder
	if bold {
		p.WriteString("<w:b/>")
	}
	if italic {
		p.WriteString("<w:i/>")
	}
	if underline {
		p.WriteString("<w:u w:val=\"single\"/>")
	}
	if strike {
		p.WriteString("<w:strike/>")
	}
	if font != "" {
		p.WriteString(`<w:rFonts w:ascii="` + xmlAttr(font) + `" w:hAnsi="` + xmlAttr(font) + `"/>`)
	}
	if color != "" {
		p.WriteString(`<w:color w:val="` + xmlAttr(strings.ToUpper(color)) + `"/>`)
	}
	if size > 0 {
		p.WriteString(fmt.Sprintf(`<w:sz w:val="%d"/>`, size)) // half-points
	}
	return p.String()
}

func docxAlign(a string) string {
	switch strings.ToLower(a) {
	case "center":
		return "center"
	case "right":
		return "right"
	case "justify", "justified":
		return "both"
	case "left":
		return "left"
	}
	return ""
}

func sizeOr(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return "<w:t xml:space=\"preserve\">" + b.String() + "</w:t>"
}

func xmlAttr(s string) string {
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, "&", "&amp;")
	return s
}

// ── xlsx_create ─────────────────────────────────────────────────────────────
//
// {"name":"d.xlsx","sheets":[{"name":"Sheet1","rows":[["h1","h2"],[1,"x"]]}]}
// Minimal workbook: inline strings (no sharedStrings part needed), one
// bold-font style for header rows.

func toolXlsxCreate(args map[string]any, sink ArtifactSink) string {
	name := sanitizeFileToolName(strArg(args, "name", ""), "sheet.xlsx", ".xlsx")
	rawSheets, _ := args["sheets"].([]any)
	if len(rawSheets) == 0 {
		return "OBSERVATION:\nerror: sheets is required — usage: xlsx_create {\"name\": \"f.xlsx\", \"sheets\": [{\"name\": \"Data\", \"rows\": [[\"a\", 1], [\"b\", 2]]}]}"
	}

	type sheetSpec struct {
		name       string
		rows       [][]any
		boldHeader bool
	}
	var sheets []sheetSpec
	for _, rs := range rawSheets {
		sm, ok := rs.(map[string]any)
		if !ok {
			continue
		}
		sp := sheetSpec{name: sanitizeSheetName(strArg(sm, "name", "Sheet1")), boldHeader: truthy(sm["bold_header"])}
		rawRows, _ := sm["rows"].([]any)
		for _, rr := range rawRows {
			if cells, ok := rr.([]any); ok {
				sp.rows = append(sp.rows, cells)
			}
		}
		if len(sp.rows) > 0 {
			sheets = append(sheets, sp)
		}
	}
	if len(sheets) == 0 {
		return "OBSERVATION:\nerror: no sheets with rows"
	}

	// sheets xml
	var sheetsXML strings.Builder
	sheetRels := ""
	var worksheets []string
	for i, sh := range sheets {
		sheetName := fmt.Sprintf("Sheet%d", i+1)
		if sh.name != "" {
			sheetName = sh.name
		}
		sheetsXML.WriteString(fmt.Sprintf(`<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlAttr(sheetName), i+1, i+1))
		var ws strings.Builder
		ws.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>`)
		for ri, row := range sh.rows {
			if ri >= 2000 {
				break // cap: 2000 rows/sheet through the tool
			}
			ws.WriteString(fmt.Sprintf(`<row r="%d">`, ri+1))
			for ci, cell := range row {
				if ci >= 256 {
					break
				}
				ref := fmt.Sprintf("%s%d", xlsxCol(ci), ri+1)
				switch v := cell.(type) {
				case float64:
					ws.WriteString(fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, ref, numString(v)))
				case int:
					ws.WriteString(fmt.Sprintf(`<c r="%s"><v>%d</v></c>`, ref, v))
				case bool:
					ws.WriteString(fmt.Sprintf(`<c r="%s" t="b"><v>%d</v></c>`, ref, b2i(v)))
				default:
					s := fmt.Sprintf("%v", cell)
					if s == "" {
						continue
					}
					var esc bytes.Buffer
					_ = xml.EscapeText(&esc, []byte(s))
					styleAttr := ""
					if ri == 0 && sh.boldHeader {
						styleAttr = ` s="1"`
					}
					ws.WriteString(fmt.Sprintf(`<c r="%s" t="inlineStr"%s><is><t>%s</t></is></c>`,
						ref, styleAttr, esc.String()))
				}
			}
			ws.WriteString(`</row>`)
		}
		ws.WriteString(`</sheetData></worksheet>`)
		worksheets = append(worksheets, ws.String())
	}

	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
	for i := range worksheets {
		contentTypes += fmt.Sprintf("\n<Override PartName=\"/xl/worksheets/sheet%d.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>", i+1)
	}
	contentTypes += "\n</Types>"

	workbook := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` + sheetsXML.String() + `</sheets></workbook>`

	wbRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
	for i := range worksheets {
		wbRels += fmt.Sprintf("\n<Relationship Id=\"rId%d\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet%d.xml\"/>", i+1, i+1)
	}
	wbRels += "\n</Relationships>"
	_ = sheetRels

	files := map[string]string{
		"[Content_Types].xml": contentTypes,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
		"xl/workbook.xml":            workbook,
		"xl/_rels/workbook.xml.rels": wbRels,
	}
	for i, ws := range worksheets {
		files[fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1)] = ws
	}

	data, err := buildZipMem(files)
	if err != nil {
		return "OBSERVATION:\nerror: " + err.Error()
	}

	obs := fmt.Sprintf("OBSERVATION:\nCreated a real Excel workbook %q — %d sheet(s).",
		name, len(sheets))
	if sink != nil {
		if _, size, err := sink.SaveArtifact(name, data, "model"); err == nil {
			obs += savedArtifactNote(name, size)
		}
	}
	return obs
}

func xlsxCol(i int) string {
	// 0 → A, 25 → Z, 26 → AA …
	s := ""
	for n := i; n >= 0; n = n/26 - 1 {
		s = string(rune('A'+n%26)) + s
	}
	return s
}

func numString(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%v", f)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── shared helpers ─────────────────────────────────────────────────────────

func strArg(m map[string]any, k, def string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return def
}

// remarshalBlock converts the raw JSON-decoded map into a docxBlock via
// round-trip (tolerant: ignores bad fields).
func remarshalBlock(raw any) (docxBlock, error) {
	b, err := json.Marshal(raw)
	if err != nil {
		return docxBlock{}, err
	}
	var blk docxBlock
	err = json.Unmarshal(b, &blk)
	return blk, err
}

func buildZipMem(files map[string]string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// deterministic order: [Content_Types].xml first, then the rest
	order := make([]string, 0, len(files))
	if _, ok := files["[Content_Types].xml"]; ok {
		order = append(order, "[Content_Types].xml")
	}
	for k := range files {
		if k != "[Content_Types].xml" {
			order = append(order, k)
		}
	}
	for _, k := range order {
		w, err := zw.Create(k)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(files[k])); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// sanitizeFileToolName cleans a model-supplied filename and forces the
// right extension for binary formats (a "file.docx" that isn't a zip
// would confuse every office app).
func sanitizeFileToolName(name, def, wantExt string) string {
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 32 {
			return -1
		}
		return r
	}, name)
	if len(name) > 120 {
		name = name[:120]
	}
	if name == "" {
		return def
	}
	// v0.26: collapse a glued-on second document extension first —
	// "Hello_Word.docx.doc" + wantExt ".docx" would otherwise pass through
	// as-is ("already ends with .docx" is FALSE for ".doc" tails... and a
	// "f.doc.docx" would have grown ".docx.doc.docx").
	for doubleDocExtRe.MatchString(name) {
		name = doubleDocExtRe.ReplaceAllString(name, ".$1")
	}
	if !strings.HasSuffix(strings.ToLower(name), wantExt) {
		name += wantExt
	}
	return name
}

// doubleDocExtRe — the bogus double document extension (see the artifacts
// sanitizer; "Hello_Word.docx.doc" from the live bug report).
var doubleDocExtRe = regexp.MustCompile(`(?i)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)$`)

// sanitizeArchiveName is sanitizeFileToolName for EVERY archive format:
// it only appends the default (.zip) when the name doesn't already carry a
// known archive extension — "project.tar.gz" must NOT become
// "project.tar.gz.zip".
func sanitizeArchiveName(name, def string) string {
	// clean WITHOUT appending any extension yet
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 32 {
			return -1
		}
		return r
	}, name)
	if len(name) > 120 {
		name = name[:120]
	}
	if name == "" {
		return def
	}
	if archive.FormatFromName(name) != "" {
		return name // already carries a real archive extension
	}
	if !strings.HasSuffix(strings.ToLower(name), ".zip") {
		name += ".zip" // default container
	}
	return name
}

func sanitizeSheetName(s string) string {
	for _, bad := range []string{":", "\\", "/", "?", "*", "[", "]"} {
		s = strings.ReplaceAll(s, bad, "")
	}
	if len(s) > 28 {
		s = s[:28]
	}
	return s
}
