package server

// hub_v1540_test.go — v1.54 THE LIBRARY SHIP route tests: the libraries
// list carrying canvas/chat, the MULTIPART publish route (binary payloads,
// per-type caps), and the payload STREAM route (gated on the download).

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
)

// hubPathExtMock is the server mock's own path.Ext.
func hubPathExtMock(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 && i > strings.LastIndexByte(p, '/') {
		return p[i:]
	}
	return ""
}

// hubMultipartReq builds a multipart/form-data request (meta JSON part +
// raw payload part) and fires it at the real mux.
func hubMultipartReq(t *testing.T, s *Server, path string, meta any, payload []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}
	if err := mw.WriteField("meta", string(metaJSON)); err != nil {
		t.Fatalf("meta part: %v", err)
	}
	pw, err := mw.CreateFormFile("payload", "bundle.bin")
	if err != nil {
		t.Fatalf("payload part: %v", err)
	}
	if _, err := pw.Write(payload); err != nil {
		t.Fatalf("payload write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	s.mux.ServeHTTP(rec, req)
	return rec
}

func TestV1540_LibrariesIncludeCanvasChat(t *testing.T) {
	m := newMockHubHF(t)
	s := newHubTestServer(t, m)
	rec := hubReq(t, s, "GET", "/api/hub/libraries", nil)
	if rec.Code != 200 {
		t.Fatalf("libraries = %d", rec.Code)
	}
	var out struct {
		Libraries []hub.LibrarySpec `json:"libraries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	have := map[string]hub.LibrarySpec{}
	for _, l := range out.Libraries {
		have[l.Type] = l
	}
	cv, ok := have["canvas"]
	if !ok {
		t.Fatalf("canvas missing from /api/hub/libraries: %v", out.Libraries)
	}
	if cv.PayloadExt != ".doomcanvas" {
		t.Fatalf("canvas payload_ext = %q", cv.PayloadExt)
	}
	if _, ok := have["chat"]; !ok {
		t.Fatalf("chat missing from /api/hub/libraries")
	}
	// doc stays hidden — the law holds
	for _, l := range out.Libraries {
		if l.Type == "doc" {
			t.Fatalf("doc must stay hidden")
		}
	}
}

func TestV1540_MultipartPublishAndPayloadRoute(t *testing.T) {
	m := newMockHubHF(t)
	seedHubRouteFixtures(t, m)
	s := newHubTestServer(t, m)

	// not connected → 401 (the multipart path carries the same gate)
	zipBytes := []byte("PK\x03\x04 multipart route test bundle body!!")
	rec := hubMultipartReq(t, s, "/api/hub/canvas/publish", map[string]any{
		"name":        "Route World",
		"description": "published through the multipart route",
	}, zipBytes)
	if rec.Code != 401 {
		t.Fatalf("multipart publish without token = %d %s", rec.Code, rec.Body.String())
	}

	if rec := hubReq(t, s, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect: %d", rec.Code)
	}

	// a multipart publish on a SMALL type is rejected honestly
	if rec := hubMultipartReq(t, s, "/api/hub/persona/publish", map[string]any{"name": "X"}, []byte("hello")); rec.Code != 400 {
		t.Fatalf("multipart on persona = %d, want 400", rec.Code)
	}

	rec = hubMultipartReq(t, s, "/api/hub/canvas/publish", map[string]any{
		"name":        "Route World",
		"description": "published through the multipart route",
	}, zipBytes)
	if rec.Code != 200 {
		t.Fatalf("multipart publish = %d %s", rec.Code, rec.Body.String())
	}
	var pub struct {
		Item hub.Item `json:"item"`
		Repo string   `json:"repo"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &pub); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if pub.Item.Repo != "mockuser/doomalay-canvases" {
		t.Fatalf("repo = %q", pub.Item.Repo)
	}
	if pub.Item.Size != int64(len(zipBytes)) {
		t.Fatalf("item.Size = %d", pub.Item.Size)
	}

	// the .gitattributes seed + the payload (through the mock's LFS path)
	attrs, ok := m.file(pub.Repo, ".gitattributes")
	if !ok || !strings.Contains(string(attrs), "*.doomcanvas filter=lfs") {
		t.Fatalf("LFS seed missing: %q ok=%v", attrs, ok)
	}
	if b, ok := m.file(pub.Repo, pub.Item.File); !ok || !bytes.Equal(b, zipBytes) {
		t.Fatalf("payload did not round-trip through LFS on the route")
	}

	// the payload route: gated on the download. The PUBLISHER's own row is
	// downloaded by definition (publishing = having it), so the gate is
	// proven on a SECOND device — a fresh server + db against the same HF.
	b := newHubTestServer(t, m)
	if rec := hubReq(t, b, "POST", "/api/hub/auth/connect", map[string]string{"token": "goodtoken"}); rec.Code != 200 {
		t.Fatalf("connect B: %d", rec.Code)
	}
	repoEsc := escRepo(pub.Repo)
	payloadPath := "/api/hub/canvas/payload/" + repoEsc + "/" + pub.Item.ID
	rec = hubReq(t, b, "GET", payloadPath, nil)
	if rec.Code != 400 {
		t.Fatalf("payload stream before download = %d, want 400 (the gate)", rec.Code)
	}

	// download (meta-only) → then the stream serves the exact bytes
	rec = hubReq(t, b, "POST", "/api/hub/canvas/download", map[string]string{"repo": pub.Repo, "id": pub.Item.ID})
	if rec.Code != 200 {
		t.Fatalf("download = %d %s", rec.Code, rec.Body.String())
	}
	var dl struct {
		Item    hub.Item `json:"item"`
		Payload string   `json:"payload"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &dl); err != nil {
		t.Fatalf("decode download: %v", err)
	}
	if dl.Payload != "" {
		t.Fatalf("canvas download payload = %d bytes, want EMPTY (bypass)", len(dl.Payload))
	}

	rec = hubReq(t, b, "GET", payloadPath, nil)
	if rec.Code != 200 {
		t.Fatalf("payload stream = %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("stream content-type = %q", rec.Header().Get("Content-Type"))
	}
	if !bytes.Equal(rec.Body.Bytes(), zipBytes) {
		t.Fatalf("streamed bytes differ (%d vs %d)", rec.Body.Len(), len(zipBytes))
	}

	// the detail view never drags the zip either
	rec = hubReq(t, s, "GET", "/api/hub/canvas/item/"+repoEsc+"/"+pub.Item.ID, nil)
	if rec.Code != 200 {
		t.Fatalf("detail = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "multipart route test bundle") {
		t.Fatalf("detail leaked the payload bytes")
	}

	// the over-cap payload → 413 (the cap law at the route)
	big := bytes.Repeat([]byte{0x50}, 96<<20+2)
	rec = hubMultipartReq(t, s, "/api/hub/canvas/publish", map[string]any{"name": "Too Big"}, big)
	if rec.Code != 413 {
		t.Fatalf("over-cap multipart = %d, want 413", rec.Code)
	}
}
