package server

// artifacts.go — v0.17 per-chat ARTIFACTS.
//
// The user spec: "cloud models are known to be able to produce code or any
// generation on the fly and we should allow for the model to be able to
// produce artifacts of hopefully any type… an artifact drawer pill… the
// user may download the artifact and have it save to their storage… may
// also permanently delete and rename… click any artifact row to open the
// file… a text editor panel that recognizes most file types, allows
// editing, and saving changes."
//
// DESIGN: files on disk (not SQLite) — artifacts can be tens of KB of text
// or megabytes of decoded base64 and don't belong in the event log:
//
//   <DataDir>/artifacts/<sessionID>/<artifactID>          the raw bytes
//   <DataDir>/artifacts/<sessionID>/<artifactID>.meta.json  {name, mime, size, …}
//
// ROUTES (all scoped to a session — the drawer is per-chat):
//   GET    /api/sessions/{id}/artifacts                  list (name, size, dates)
//   POST   /api/sessions/{id}/artifacts                  create {name, content, encoding}
//   GET    /api/sessions/{id}/artifacts/{aid}            meta + full content
//   PUT    /api/sessions/{id}/artifacts/{aid}            rename and/or replace content
//   DELETE /api/sessions/{id}/artifacts/{aid}            remove permanently
//   GET    /api/sessions/{id}/artifacts/{aid}/download   Content-Disposition: attachment
//
// encoding: "utf8" (default, plain text in JSON) or "base64" (binary
// artifacts — docx/zip/… — the client decodes nothing; download serves
// the raw bytes). IDs are 12 hex chars — the regex check doubles as the
// path-traversal guard.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var artifactIDRe = regexp.MustCompile(`^[a-f0-9]{12}$`)

// ArtifactMeta is the persisted metadata record.
type ArtifactMeta struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Mime      string  `json:"mime"`
	Encoding  string  `json:"encoding"`         // utf8 | base64
	Size      int64   `json:"size"`             // bytes of the STORED payload
	Source    string  `json:"source,omitempty"` // model | user
	CreatedAt float64 `json:"created_at"`
	UpdatedAt float64 `json:"updated_at"`
}

func (s *Server) artifactDir(sessionID string) string {
	return filepath.Join(s.cfg.DataDir, "artifacts", sessionID)
}

// doubleDocExtRe matches a bogus double document extension — the live
// bug report: a "Hello_Word.docx.doc" (the model glued a second extension
// onto the file it named). The FIRST extension is the intended one.
var doubleDocExtRe = regexp.MustCompile(`(?i)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)\.(docx?|xlsx?|pptx?|pdf|rtf|txt|csv|json|md|html?|zip)$`)

func sanitizeArtifactName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "artifact.txt"
	}
	// strip path separators + control chars; keep it a single filename
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r < 32 {
			return -1
		}
		return r
	}, name)
	if len(name) > 120 {
		name = name[:120]
	}
	// v0.26: collapse "file.docx.doc" → "file.docx" (the model sometimes
	// names its own output with a glued-on second extension).
	for doubleDocExtRe.MatchString(name) {
		name = doubleDocExtRe.ReplaceAllString(name, ".$1")
	}
	return name
}

func newArtifactID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func readArtifactMeta(dir, aid string) (*ArtifactMeta, error) {
	raw, err := os.ReadFile(filepath.Join(dir, aid+".meta.json"))
	if err != nil {
		return nil, err
	}
	var m ArtifactMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func writeArtifactMeta(dir string, m *ArtifactMeta) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, m.ID+".meta.json"), raw, 0o600)
}

func guessMime(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".txt", ".text", ".log", "":
		return "text/plain; charset=utf-8"
	case ".md", ".markdown", ".mdown":
		return "text/markdown; charset=utf-8"
	case ".json", ".jsonl", ".ndjson", ".geojson", ".jsonc":
		return "application/json"
	case ".csv", ".tsv":
		return "text/csv"
	case ".xml", ".svg", ".xsl", ".plist", ".rss", ".atom":
		return "application/xml"
	case ".yaml", ".yml":
		return "application/yaml"
	case ".toml":
		return "application/toml"
	case ".html", ".htm":
		return "text/html"
	case ".css":
		return "text/css"
	case ".js", ".mjs", ".cjs":
		return "text/javascript"
	case ".ts", ".tsx", ".jsx":
		return "text/typescript"
	case ".py":
		return "text/x-python"
	case ".go":
		return "text/x-go"
	case ".rs":
		return "text/x-rust"
	case ".java":
		return "text/x-java"
	case ".c", ".h":
		return "text/x-c"
	case ".cpp", ".cc", ".hpp":
		return "text/x-c++"
	case ".sh", ".bash", ".zsh":
		return "text/x-shellscript"
	case ".sql":
		return "application/sql"
	case ".pdf":
		return "application/pdf"
	case ".doc", ".docx":
		return "application/msword"
	case ".xls", ".xlsx":
		return "application/vnd.ms-excel"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".zip":
		return "application/zip"
	default:
		return "application/octet-stream"
	}
}

// ── LIST ─────────────────────────────────────────────────────────
func (s *Server) handleArtifactsList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if sess, err := s.db.GetSession(id); err != nil || sess == nil {
		writeError(w, 404, "session not found")
		return
	}
	dir := s.artifactDir(id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, 200, map[string]any{"artifacts": []ArtifactMeta{}})
		return
	}
	out := []ArtifactMeta{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		aid := strings.TrimSuffix(e.Name(), ".meta.json")
		if !artifactIDRe.MatchString(aid) {
			continue
		}
		m, err := readArtifactMeta(dir, aid)
		if err != nil {
			continue
		}
		out = append(out, *m)
	}
	writeJSON(w, 200, map[string]any{"artifacts": out})
}

// ── CREATE ───────────────────────────────────────────────────────
// saveArtifactBytes is the shared write path (v0.22): the HTTP handler
// AND the llm file-tools' ArtifactSink both persist through it.
func (s *Server) saveArtifactBytes(sessionID, name string, data []byte, source, encoding string) (*ArtifactMeta, error) {
	name = sanitizeArtifactName(name)
	if encoding != "base64" {
		encoding = "utf8"
	}
	dir := s.artifactDir(sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	now := float64(time.Now().UnixMilli()) / 1000.0
	m := &ArtifactMeta{
		ID:        newArtifactID(),
		Name:      name,
		Mime:      guessMime(name),
		Encoding:  encoding,
		Size:      int64(len(data)),
		Source:    source,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := os.WriteFile(filepath.Join(dir, m.ID), data, 0o600); err != nil {
		return nil, err
	}
	if err := writeArtifactMeta(dir, m); err != nil {
		return nil, err
	}
	return m, nil
}

// findArtifactByName resolves a model-referenced filename to its artifact
// (zip_extract reads zips the user or an earlier tool call saved).
func (s *Server) findArtifactByName(sessionID, name string) (*ArtifactMeta, error) {
	dir := s.artifactDir(sessionID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		aid := strings.TrimSuffix(e.Name(), ".meta.json")
		if !artifactIDRe.MatchString(aid) {
			continue
		}
		m, err := readArtifactMeta(dir, aid)
		if err == nil && m.Name == name {
			return m, nil
		}
	}
	return nil, os.ErrNotExist
}

// sessionArtifactSink adapts the server's artifact store to the llm
// package's ArtifactSink interface (v0.22 file tools).
type sessionArtifactSink struct {
	s      *Server
	sessID string
}

func (k *sessionArtifactSink) SaveArtifact(name string, data []byte, source string) (string, int64, error) {
	m, err := k.s.saveArtifactBytes(k.sessID, name, data, source, "base64")
	if err != nil {
		return "", 0, err
	}
	return m.ID, m.Size, nil
}

// ReadArtifact loads a session artifact by its (model-supplied) filename —
// the engine-path zip_extract uses it.
func (k *sessionArtifactSink) ReadArtifact(name string) ([]byte, error) {
	m, err := k.s.findArtifactByName(k.sessID, name)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(k.s.artifactDir(k.sessID), m.ID))
}

func (s *Server) handleArtifactsCreate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if sess, err := s.db.GetSession(id); err != nil || sess == nil {
		writeError(w, 404, "session not found")
		return
	}
	var body struct {
		Name     string `json:"name"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"` // utf8 | base64
		Source   string `json:"source"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&body); err != nil {
		writeError(w, 400, "bad json: "+err.Error())
		return
	}
	name := sanitizeArtifactName(body.Name)
	encoding := strings.ToLower(strings.TrimSpace(body.Encoding))
	if encoding != "base64" {
		encoding = "utf8"
	}

	var payload []byte
	var size int64
	if encoding == "base64" {
		decoded, err := base64Decode(body.Content)
		if err != nil {
			writeError(w, 400, "bad base64: "+err.Error())
			return
		}
		payload = decoded
	} else {
		payload = []byte(body.Content)
	}
	size = int64(len(payload))

	dir := s.artifactDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeError(w, 500, "mkdir: "+err.Error())
		return
	}

	m := &ArtifactMeta{
		ID:        newArtifactID(),
		Name:      name,
		Mime:      guessMime(name),
		Encoding:  encoding,
		Size:      size,
		Source:    body.Source,
		CreatedAt: float64(time.Now().UnixMilli()) / 1000.0,
		UpdatedAt: float64(time.Now().UnixMilli()) / 1000.0,
	}
	if err := os.WriteFile(filepath.Join(dir, m.ID), payload, 0o600); err != nil {
		writeError(w, 500, "write: "+err.Error())
		return
	}
	if err := writeArtifactMeta(dir, m); err != nil {
		writeError(w, 500, "meta: "+err.Error())
		return
	}
	writeJSON(w, 201, m)
}

// ── GET (meta + content) ─────────────────────────────────────────
func (s *Server) handleArtifactGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	aid := r.PathValue("aid")
	dir := s.artifactDir(id)
	if !artifactIDRe.MatchString(aid) {
		writeError(w, 400, "bad artifact id")
		return
	}
	m, err := readArtifactMeta(dir, aid)
	if err != nil {
		writeError(w, 404, "artifact not found")
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, aid))
	if err != nil {
		writeError(w, 500, "read: "+err.Error())
		return
	}
	content := ""
	if m.Encoding == "base64" {
		content = base64Encode(raw)
	} else {
		content = string(raw)
	}
	writeJSON(w, 200, map[string]any{
		"id": m.ID, "name": m.Name, "mime": m.Mime, "encoding": m.Encoding,
		"size": m.Size, "source": m.Source, "created_at": m.CreatedAt,
		"updated_at": m.UpdatedAt, "content": content,
	})
}

// ── UPDATE (rename / replace content) ────────────────────────────
func (s *Server) handleArtifactUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	aid := r.PathValue("aid")
	dir := s.artifactDir(id)
	if !artifactIDRe.MatchString(aid) {
		writeError(w, 400, "bad artifact id")
		return
	}
	m, err := readArtifactMeta(dir, aid)
	if err != nil {
		writeError(w, 404, "artifact not found")
		return
	}
	var body struct {
		Name    *string `json:"name"`
		Content *string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&body); err != nil {
		writeError(w, 400, "bad json: "+err.Error())
		return
	}
	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		m.Name = sanitizeArtifactName(*body.Name)
		m.Mime = guessMime(m.Name)
	}
	if body.Content != nil {
		if m.Encoding == "base64" {
			decoded, err := base64Decode(*body.Content)
			if err != nil {
				writeError(w, 400, "bad base64: "+err.Error())
				return
			}
			if err := os.WriteFile(filepath.Join(dir, aid), decoded, 0o600); err != nil {
				writeError(w, 500, "write: "+err.Error())
				return
			}
			m.Size = int64(len(decoded))
		} else {
			if err := os.WriteFile(filepath.Join(dir, aid), []byte(*body.Content), 0o600); err != nil {
				writeError(w, 500, "write: "+err.Error())
				return
			}
			m.Size = int64(len(*body.Content))
		}
	}
	m.UpdatedAt = float64(time.Now().UnixMilli()) / 1000.0
	if err := writeArtifactMeta(dir, m); err != nil {
		writeError(w, 500, "meta: "+err.Error())
		return
	}
	writeJSON(w, 200, m)
}

// ── DELETE ───────────────────────────────────────────────────────
func (s *Server) handleArtifactDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	aid := r.PathValue("aid")
	dir := s.artifactDir(id)
	if !artifactIDRe.MatchString(aid) {
		writeError(w, 400, "bad artifact id")
		return
	}
	if _, err := readArtifactMeta(dir, aid); err != nil {
		writeError(w, 404, "artifact not found")
		return
	}
	err1 := os.Remove(filepath.Join(dir, aid))
	err2 := os.Remove(filepath.Join(dir, aid+".meta.json"))
	if err1 != nil && err2 != nil {
		writeError(w, 500, "delete failed")
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": true})
}

// ── DOWNLOAD ─────────────────────────────────────────────────────
func (s *Server) handleArtifactDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	aid := r.PathValue("aid")
	dir := s.artifactDir(id)
	if !artifactIDRe.MatchString(aid) {
		writeError(w, 400, "bad artifact id")
		return
	}
	m, err := readArtifactMeta(dir, aid)
	if err != nil {
		writeError(w, 404, "artifact not found")
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, aid))
	if err != nil {
		writeError(w, 500, "read: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", m.Mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", m.Name))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(raw)))
	_, _ = w.Write(raw)
}

// base64 helpers (std encoding, tolerant of newlines).
func base64Decode(s string) ([]byte, error) {
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	return base64.StdEncoding.DecodeString(clean)
}

func base64Encode(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}
