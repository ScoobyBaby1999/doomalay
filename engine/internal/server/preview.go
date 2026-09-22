package server

// preview.go — v0.23 the COMPLEX-FILE VIEWERS.
//
// User spec: "our editor currently cannot view complex files like word docs
// or zip files' contents — let's have it be able to view these files and
// contents of zips." The Go engine does the parsing (the WebView can't
// unzip a docx on its own), the frontend renders the JSON:
//
//      GET  /api/sessions/{id}/artifacts/{aid}/preview
//           → {kind:"docx", blocks:[…styled paragraphs…]}
//           → {kind:"xlsx", sheets:[{name, rows:[[…]]}]}
//           → {kind:"archive", format:"zip|7z|rar|tar…", entries:[…]}
//           → {kind:"text", text} (fallback for text-ish files)
//           → {kind:"binary"} (images/media stay download-only)
//      GET  /api/sessions/{id}/artifacts/{aid}/entry?name=<member>
//           → {name, size, text?, truncated?} — one archive member (the
//             in-app viewer for files INSIDE archives; text-capped 256 KB)
//      POST /api/sessions/{id}/artifacts/{aid}/extract
//           → {extracted: n} — every member re-saved as its own artifact
//
// Formats shared with the model tools: internal/archive (zip, 7z, rar4/5,
// tar, tar.gz/bz2/xz/zst, single-file gz/bz2/xz/zst) — sniffed from bytes.

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/archive"
)

const (
	previewMaxDocxBlocks = 800
	previewMaxRows       = 200
	previewMaxCols       = 40
	previewMaxEntryText  = 256 << 10 // 256 KB per member inline
)

// handleArtifactPreview parses an artifact into viewer-ready JSON.
func (s *Server) handleArtifactPreview(w http.ResponseWriter, r *http.Request) {
	data, m, ok := s.readArtifactBytes(w, r)
	if !ok {
		return
	}

	// docx / xlsx = zip containers with well-known parts
	if archive.Sniff(data) == "zip" {
		if kind, payload := previewOffice(data); kind != "" {
			writeJSON(w, 200, mergePreview(kind, m.Name, m.Size, payload))
			return
		}
	}

	// archives of every flavor
	if format := archive.Sniff(data); format != "" {
		_, entries, err := archive.List(data)
		if err == nil {
			writeJSON(w, 200, mergePreview("archive", m.Name, m.Size, map[string]any{
				"format":  format,
				"entries": entries,
			}))
			return
		}
	}

	// text-ish → let the viewer show it
	if isProbablyText(data) {
		writeJSON(w, 200, mergePreview("text", m.Name, m.Size, map[string]any{
			"text": clampStr(string(data), 512<<10),
		}))
		return
	}

	writeJSON(w, 200, mergePreview("binary", m.Name, m.Size, nil))
}

// handleArtifactEntry returns one member of an archive artifact.
func (s *Server) handleArtifactEntry(w http.ResponseWriter, r *http.Request) {
	data, _, ok := s.readArtifactBytes(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, 400, "missing name")
		return
	}
	content, err := archive.Read(data, name)
	if err != nil {
		writeError(w, 404, "member not found: "+err.Error())
		return
	}
	resp := map[string]any{
		"name": path.Base(name),
		"size": len(content),
	}
	if isProbablyText(content) && len(content) <= previewMaxEntryText {
		resp["text"] = string(content)
	} else if isProbablyText(content) {
		resp["text"] = string(content[:previewMaxEntryText])
		resp["truncated"] = true
	} else {
		resp["binary"] = true
	}
	writeJSON(w, 200, resp)
}

// handleArtifactExtract unpacks every member as its own artifact.
func (s *Server) handleArtifactExtract(w http.ResponseWriter, r *http.Request) {
	data, m, ok := s.readArtifactBytes(w, r)
	if !ok {
		return
	}
	sessionID := r.PathValue("id")
	n, err := archive.ExtractAll(data, func(name string, content []byte) error {
		base := path.Base(name)
		if base == "" || base == "." {
			return fmt.Errorf("skip")
		}
		_, err := s.saveArtifactBytes(sessionID, base, content, "extracted", "utf8")
		return err
	})
	if err != nil {
		writeError(w, 400, "not a readable archive: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"extracted": n, "from": m.Name})
}

// readArtifactBytes is the shared guard: load meta + bytes or write the
// HTTP error.
func (s *Server) readArtifactBytes(w http.ResponseWriter, r *http.Request) ([]byte, *ArtifactMeta, bool) {
	id := r.PathValue("id")
	aid := r.PathValue("aid")
	dir := s.artifactDir(id)
	if !artifactIDRe.MatchString(aid) {
		writeError(w, 400, "bad artifact id")
		return nil, nil, false
	}
	m, err := readArtifactMeta(dir, aid)
	if err != nil {
		writeError(w, 404, "artifact not found")
		return nil, nil, false
	}
	raw, err := os.ReadFile(filepath.Join(dir, aid))
	if err != nil {
		writeError(w, 500, "read: "+err.Error())
		return nil, nil, false
	}
	return raw, m, true
}

func mergePreview(kind, name string, size int64, payload map[string]any) map[string]any {
	out := map[string]any{"kind": kind, "name": name, "size": size}
	for k, v := range payload {
		out[k] = v
	}
	return out
}

func clampStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n… (truncated)"
}

// ── docx preview ─────────────────────────────────────────────────────────────

type viewRun struct {
	Text      string `json:"text"`
	Bold      bool   `json:"bold,omitempty"`
	Italic    bool   `json:"italic,omitempty"`
	Underline bool   `json:"underline,omitempty"`
	Strike    bool   `json:"strike,omitempty"`
	Color     string `json:"color,omitempty"`
	Size      int    `json:"size,omitempty"` // half-points, like OOXML
	Font      string `json:"font,omitempty"`
}

type viewBlock struct {
	Type  string    `json:"type"` // title|heading|subheading|paragraph|bullet|number|quote
	Text  string    `json:"text"`
	Runs  []viewRun `json:"runs,omitempty"`
	Align string    `json:"align,omitempty"`
}

// previewOffice returns ("docx"|"xlsx", payload) or ("", nil) when the zip
// isn't an Office document.
func previewOffice(data []byte) (string, map[string]any) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", nil
	}
	parts := map[string][]byte{}
	for _, f := range zr.File {
		if len(parts) >= 24 {
			break
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(rc, 4<<20))
		rc.Close()
		if err != nil {
			continue
		}
		parts[f.Name] = b
	}
	if doc, ok := parts["word/document.xml"]; ok {
		return "docx", map[string]any{"blocks": parseDocxBlocks(doc)}
	}
	if wb, ok := parts["xl/workbook.xml"]; ok {
		return "xlsx", map[string]any{"sheets": parseXlsxSheets(wb, parts)}
	}
	return "", nil
}

// parseDocxBlocks walks word/document.xml into styled blocks. Token-based
// (not struct-unmarshal) so slightly-off documents from other producers
// still preview.
func parseDocxBlocks(doc []byte) []viewBlock {
	dec := xml.NewDecoder(bytes.NewReader(doc))
	var blocks []viewBlock
	var cur *viewBlock
	var curRun *viewRun
	var inT bool // inside w:t

	style := ""
	numID := ""
	align := ""

	flushBlock := func() {
		if cur != nil && (len(cur.Runs) > 0 || cur.Text != "") {
			blocks = append(blocks, *cur)
		}
		cur = nil
		curRun = nil
	}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				flushBlock()
				cur = &viewBlock{Type: "paragraph"}
				style, numID, align = "", "", ""
			case "pStyle":
				if v := attrVal(t, "val"); v != "" {
					style = v
				}
			case "jc":
				if v := attrVal(t, "val"); v != "" {
					align = v
				}
			case "numPr":
				numID = "1" // any numbering = list item
			case "r":
				if cur != nil {
					// append FIRST, then point at the slice element — a
					// value copy here loses every later mutation (observed
					// live: runs came back empty + colorless).
					cur.Runs = append(cur.Runs, viewRun{})
					curRun = &cur.Runs[len(cur.Runs)-1]
				}
			case "b":
				markRun(curRun, func(r *viewRun) { r.Bold = true })
			case "i":
				markRun(curRun, func(r *viewRun) { r.Italic = true })
			case "u":
				markRun(curRun, func(r *viewRun) { r.Underline = true })
			case "strike":
				markRun(curRun, func(r *viewRun) { r.Strike = true })
			case "color":
				if v := attrVal(t, "val"); v != "" && v != "auto" {
					markRun(curRun, func(r *viewRun) { r.Color = strings.ToUpper(v) })
				}
			case "sz":
				if v := attrVal(t, "val"); v != "" {
					if n, err := strconv.Atoi(v); err == nil {
						markRun(curRun, func(r *viewRun) { r.Size = n })
					}
				}
			case "rFonts":
				if v := attrVal(t, "ascii"); v != "" {
					markRun(curRun, func(r *viewRun) { r.Font = v })
				}
			case "t":
				inT = true
			}
		case xml.CharData:
			if inT && cur != nil {
				s := string(t)
				if curRun != nil {
					curRun.Text += s
				}
				cur.Text += s
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "p":
				if cur != nil {
					// map the style to the viewer's block type
					switch strings.ToLower(style) {
					case "title":
						cur.Type = "title"
					case "heading1", "heading 1":
						cur.Type = "heading"
					case "heading2", "heading 2", "heading3", "heading 3":
						cur.Type = "subheading"
					case "quote":
						cur.Type = "quote"
					}
					if numID != "" && cur.Type == "paragraph" {
						cur.Type = "bullet" // numbering details live in numbering.xml; bullet is close enough for a read-only view
					}
					if align == "center" || align == "right" || align == "both" {
						cur.Align = align
					}
				}
				flushBlock()
			}
		}
	}
	flushBlock()
	if len(blocks) > previewMaxDocxBlocks {
		blocks = blocks[:previewMaxDocxBlocks]
	}
	return blocks
}

func markRun(r *viewRun, f func(*viewRun)) {
	if r != nil {
		f(r)
	}
}

func attrVal(se xml.StartElement, key string) string {
	for _, a := range se.Attr {
		if a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}

// ── xlsx preview ─────────────────────────────────────────────────────────────

// parseXlsxSheets: workbook.xml sheet names + rels → worksheet parts →
// inline strings, shared strings, numbers, booleans.
func parseXlsxSheets(workbook []byte, parts map[string][]byte) []map[string]any {
	type sheetRef struct {
		name string
		rid  string
	}
	var refs []sheetRef
	dec := xml.NewDecoder(bytes.NewReader(workbook))
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "sheet" {
			n, rid := "", ""
			for _, a := range se.Attr {
				switch a.Name.Local {
				case "name":
					n = a.Value
				case "id": // r:id
					rid = a.Value
				}
			}
			refs = append(refs, sheetRef{name: n, rid: rid})
		}
	}

	// rId → target path from the workbook rels
	targets := map[string]string{}
	if rels, ok := parts["xl/_rels/workbook.xml.rels"]; ok {
		rd := xml.NewDecoder(bytes.NewReader(rels))
		for {
			tok, err := rd.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
			if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "Relationship" {
				id, target := "", ""
				for _, a := range se.Attr {
					switch a.Name.Local {
					case "Id":
						id = a.Value
					case "Target":
						target = a.Value
					}
				}
				if id != "" && target != "" {
					targets[id] = "xl/" + strings.TrimPrefix(target, "/")
				}
			}
		}
	}

	// shared strings (older producers use them instead of inlineStr)
	shared := []string{}
	if ss, ok := parts["xl/sharedStrings.xml"]; ok {
		sd := xml.NewDecoder(bytes.NewReader(ss))
		inSi, inT := false, false
		var cur strings.Builder
		for {
			tok, err := sd.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "si" {
					inSi = true
					cur.Reset()
				}
				if t.Name.Local == "t" && inSi {
					inT = true
				}
			case xml.CharData:
				if inT && inSi {
					cur.Write(t)
				}
			case xml.EndElement:
				if t.Name.Local == "t" {
					inT = false
				}
				if t.Name.Local == "si" {
					inSi = false
					shared = append(shared, cur.String())
				}
			}
		}
	}

	sheets := []map[string]any{}
	for _, ref := range refs {
		partKey := targets[ref.rid]
		if partKey == "" {
			// fall back to positional sheets
			partKey = fmt.Sprintf("xl/worksheets/sheet%d.xml", len(sheets)+1)
		}
		ws, ok := parts[partKey]
		if !ok {
			continue
		}
		rows := parseWorksheetRows(ws, shared)
		sheets = append(sheets, map[string]any{"name": ref.name, "rows": rows})
	}
	return sheets
}

// parseWorksheetRows extracts rows as string matrices (viewer-friendly).
func parseWorksheetRows(ws []byte, shared []string) [][]string {
	dec := xml.NewDecoder(bytes.NewReader(ws))
	var rows [][]string
	var row []string
	var cell strings.Builder
	var cellType string
	var inV, inIs, inT, cellActive bool

	flushCell := func() {
		if !cellActive {
			return
		}
		v := cell.String()
		if cellType == "s" && v != "" {
			if idx, err := strconv.Atoi(v); err == nil && idx >= 0 && idx < len(shared) {
				v = shared[idx]
			}
		} else if cellType == "b" && v != "" {
			if v == "1" {
				v = "TRUE"
			} else {
				v = "FALSE"
			}
		}
		row = append(row, v)
		cell.Reset()
		cellType = ""
		cellActive = false
	}
	flushRow := func() {
		if len(row) > 0 {
			rows = append(rows, row)
		}
		row = nil
	}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				flushCell()
				flushRow()
			case "c":
				flushCell()
				cellType = attrVal(t, "t")
				cellActive = true
			case "v":
				inV = true
			case "is":
				inIs = true
			case "t":
				if inIs {
					inT = true
				}
			}
		case xml.CharData:
			if inV || inT {
				cell.Write(t)
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "t":
				inT = false
			case "is":
				inIs = false
			case "c":
				flushCell()
			case "row":
				flushCell()
				flushRow()
			}
		}
	}
	flushCell()
	flushRow()

	// caps for the viewer
	if len(rows) > previewMaxRows {
		rows = rows[:previewMaxRows]
	}
	for i, r := range rows {
		if len(r) > previewMaxCols {
			rows[i] = r[:previewMaxCols]
		}
	}
	return rows
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
