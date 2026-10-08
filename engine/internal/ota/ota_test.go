package ota

// ota_test.go — v1.17.4 THE LIVE UPDATE: the ota package pins.
//
//   - manifest parse: good JSON round-trips; bad JSON / missing version /
//     oversize / non-200 / dead URL all error honestly.
//   - ComputePlan: all-changed, none-changed, mixed — against a fake
//     liveHash (pure function, no I/O).
//   - DownloadFile (httptest): correct hash → the file lands + the .tmp
//     is gone; wrong hash → error + no file; oversize → error; a
//     connection dropped mid-stream → error + no leftover .tmp.
//   - FileURL: the github.com release shape maps to the raw tree; the
//     raw shape maps to the raw tree at the ref; everything else
//     resolves against the manifest's own directory (the stub/mirror
//     contract the server tests rely on).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ── FetchManifest ──────────────────────────────────────────────────────

func TestV1174_FetchManifest_GoodJSON(t *testing.T) {
	body := `{"version":"v1.17.4","ref":"v1.17.4","min_engine":"v1.17.4","files":[{"path":"engine/internal/server/web/ota.js","sha256":"abc","size":123}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	m, err := FetchManifest(context.Background(), srv.URL+"/patch-manifest.json")
	if err != nil {
		t.Fatalf("good manifest must parse: %v", err)
	}
	if m.Version != "v1.17.4" || m.Ref != "v1.17.4" || m.MinEngine != "v1.17.4" {
		t.Fatalf("version/ref/min_engine must round-trip: %+v", m)
	}
	if len(m.Files) != 1 || m.Files[0].Path != "engine/internal/server/web/ota.js" || m.Files[0].Size != 123 {
		t.Fatalf("files must round-trip: %+v", m.Files)
	}
}

func TestV1174_FetchManifest_BadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"v1.17.4","files":[BROKEN`))
	}))
	defer srv.Close()
	if _, err := FetchManifest(context.Background(), srv.URL+"/patch-manifest.json"); err == nil {
		t.Fatal("broken JSON must error")
	}
}

func TestV1174_FetchManifest_MissingVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ref":"v1.17.4","files":[]}`))
	}))
	defer srv.Close()
	if _, err := FetchManifest(context.Background(), srv.URL+"/patch-manifest.json"); err == nil {
		t.Fatal("a manifest without a version is not a manifest — must error")
	}
}

func TestV1174_FetchManifest_OversizeCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		big := make([]byte, ManifestMaxBytes+128)
		_, _ = w.Write(big)
	}))
	defer srv.Close()
	_, err := FetchManifest(context.Background(), srv.URL+"/patch-manifest.json")
	if err == nil || !strings.Contains(err.Error(), "cap") {
		t.Fatalf("an over-cap manifest must error with the cap reason, got %v", err)
	}
}

func TestV1174_FetchManifest_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()
	if _, err := FetchManifest(context.Background(), srv.URL+"/patch-manifest.json"); err == nil {
		t.Fatal("HTTP 404 must error")
	}
}

func TestV1174_FetchManifest_DeadURL(t *testing.T) {
	// port 1 on loopback: nothing listens there — connection refused.
	if _, err := FetchManifest(context.Background(), "http://127.0.0.1:1/patch-manifest.json"); err == nil {
		t.Fatal("a dead URL must error (the unreachable state's source)")
	}
}

func TestV1174_FetchManifest_RedirectsFollowed(t *testing.T) {
	// The GitHub "releases/latest/download/…" shape 302s to the real asset
	// — redirects must be followed.
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"v1.17.4","files":[]}`))
	}))
	defer final.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL+"/real-manifest.json", http.StatusFound)
	}))
	defer srv.Close()
	m, err := FetchManifest(context.Background(), srv.URL+"/latest/download/patch-manifest.json")
	if err != nil {
		t.Fatalf("redirects must be followed: %v", err)
	}
	if m.Version != "v1.17.4" {
		t.Fatalf("the redirected manifest must parse: %+v", m)
	}
}

// ── ComputePlan ────────────────────────────────────────────────────────

func TestV1174_ComputePlan_AllChanged(t *testing.T) {
	m := &Manifest{Version: "v", Files: []FileEntry{
		{Path: "a.js", SHA256: "aa", Size: 10},
		{Path: "b.js", SHA256: "bb", Size: 20},
	}}
	// liveHash says nothing exists live → everything is changed.
	p := ComputePlan(m, func(string) (string, bool) { return "", false })
	if len(p.Changed) != 2 || p.Unchanged != 0 || p.TotalBytes != 30 {
		t.Fatalf("all-changed: %+v", p)
	}
}

func TestV1174_ComputePlan_NoneChanged(t *testing.T) {
	m := &Manifest{Version: "v", Files: []FileEntry{
		{Path: "a.js", SHA256: "AA", Size: 10},
		{Path: "b.js", SHA256: "bb", Size: 20},
	}}
	// live hashes match (a.js case-insensitively — hex is hex).
	live := map[string]string{"a.js": "aa", "b.js": "bb"}
	p := ComputePlan(m, func(path string) (string, bool) { h, ok := live[path]; return h, ok })
	if len(p.Changed) != 0 || p.Unchanged != 2 || p.TotalBytes != 0 {
		t.Fatalf("none-changed: %+v", p)
	}
}

func TestV1174_ComputePlan_Mixed(t *testing.T) {
	m := &Manifest{Version: "v", Files: []FileEntry{
		{Path: "same.js", SHA256: "s1", Size: 10},
		{Path: "diff.js", SHA256: "d2", Size: 20},
		{Path: "new.js", SHA256: "n3", Size: 30},
	}}
	live := map[string]string{"same.js": "s1", "diff.js": "d1"}
	p := ComputePlan(m, func(path string) (string, bool) { h, ok := live[path]; return h, ok })
	if len(p.Changed) != 2 {
		t.Fatalf("mixed: changed must be diff+new, got %+v", p.Changed)
	}
	if p.Unchanged != 1 {
		t.Fatalf("mixed: unchanged must be 1, got %d", p.Unchanged)
	}
	if p.TotalBytes != 50 {
		t.Fatalf("mixed: TotalBytes must count only the changed (50), got %d", p.TotalBytes)
	}
	if p.Changed[0].Path != "diff.js" || p.Changed[1].Path != "new.js" {
		t.Fatalf("mixed: changed order must follow the manifest: %+v", p.Changed)
	}
}

func TestV1174_ComputePlan_NilManifest(t *testing.T) {
	p := ComputePlan(nil, func(string) (string, bool) { return "", false })
	if len(p.Changed) != 0 || p.Unchanged != 0 || p.TotalBytes != 0 {
		t.Fatalf("nil manifest → empty plan: %+v", p)
	}
}

// ── DownloadFile ───────────────────────────────────────────────────────

func TestV1174_DownloadFile_CorrectHashLands(t *testing.T) {
	content := []byte("// the patched bytes\nconsole.log('v1.17.4');\n")
	want := hashBytes(content)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		_, _ = w.Write(content)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "engine", "internal", "server", "web", "ota.js")
	if err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, want, 0); err != nil {
		t.Fatalf("correct hash must land: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(content) {
		t.Fatalf("the file must carry the downloaded bytes: %v %q", err, got)
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("the .tmp must be gone after the rename (got err %v)", err)
	}
}

func TestV1174_DownloadFile_WrongHashRefused(t *testing.T) {
	content := []byte("malicious or corrupt bytes")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "evil.js")
	err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, strings.Repeat("0", 64), 0)
	if err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("a wrong hash must refuse with the mismatch reason, got %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("no file may land on a hash mismatch (corrupt = gone)")
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("no .tmp may survive a hash mismatch")
	}
}

func TestV1174_DownloadFile_NoHashRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("x"))
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "x.js")
	if err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, "", 0); err == nil {
		t.Fatal("a download without a sha256 to verify must be refused (verify EVERY byte)")
	}
}

func TestV1174_DownloadFile_OversizeRefused(t *testing.T) {
	big := bytesOf(4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(big)
	}))
	defer srv.Close()
	dir := t.TempDir()
	dest := filepath.Join(dir, "big.js")
	err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, hashBytes(big), 1024)
	if err == nil || !strings.Contains(err.Error(), "cap") {
		t.Fatalf("an over-cap download must refuse with the cap reason, got %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("an oversize file must not land")
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("an oversize download must not leave a .tmp")
	}
}

func TestV1174_DownloadFile_MidStreamDrop(t *testing.T) {
	// The server declares 4096 bytes but writes 100, then drops the
	// connection (panic in a handler closes the conn — the client sees
	// an unexpected EOF mid-stream).
	full := bytesOf(4096)
	want := hashBytes(full)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "4096")
		_, _ = w.Write(full[:100])
		panic("simulated connection drop mid-stream")
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "dropped.js")
	err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, want, 0)
	if err == nil {
		t.Fatal("a dropped stream must error (the bytes never finished — honest failure)")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("a dropped download must not land a file")
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("a dropped download must leave no .tmp leftover")
	}
}

func TestV1174_DownloadFile_HashesWhileStreaming(t *testing.T) {
	// The deferred cleanup is the real pin: a stream that trips the size
	// cap AFTER writing 100 clean bytes still deletes the .tmp (the
	// hash-while-streaming path exercises MultiWriter + LimitReader).
	content := bytesOf(2048)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// no Content-Length — the cap only trips mid-stream
		_, _ = w.Write(content)
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "over.js")
	err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, hashBytes(content), 1024)
	if err == nil || !strings.Contains(err.Error(), "cap") {
		t.Fatalf("mid-stream oversize must refuse, got %v", err)
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("the half-written .tmp must be deleted")
	}
}

func TestV1174_DownloadFile_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "f.js")
	err := DownloadFile(context.Background(), srv.URL+"/f.js", dest, strings.Repeat("a", 64), 0)
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("HTTP 404 must refuse honestly, got %v", err)
	}
}

// ── FileURL ────────────────────────────────────────────────────────────

func TestV1174_FileURL(t *testing.T) {
	cases := []struct {
		manifest, ref, file, want string
	}{
		{
			// The default: the GitHub release "latest" asset → the raw tree at the ref.
			manifest: "https://github.com/ScoobyBaby1999/doomalay/releases/latest/download/patch-manifest.json",
			ref:      "v1.17.4", file: "engine/internal/server/web/ota.js",
			want: "https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/v1.17.4/engine/internal/server/web/ota.js",
		},
		{
			// A raw manifest → the raw tree at the ref.
			manifest: "https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/patch-manifest.json",
			ref:      "main", file: "engine/internal/server/web/index.html",
			want: "https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/engine/internal/server/web/index.html",
		},
		{
			// A local stub / mirror: the manifest's own directory.
			manifest: "http://127.0.0.1:9/patch-manifest.json",
			ref:      "vX", file: "engine/internal/server/web/atoms.js",
			want:     "http://127.0.0.1:9/engine/internal/server/web/atoms.js",
		},
		{
			// No ref → main (the raw tree needs SOME ref).
			manifest: "https://github.com/ScoobyBaby1999/doomalay/releases/latest/download/patch-manifest.json",
			ref:      "", file: "a.js",
			want: "https://raw.githubusercontent.com/ScoobyBaby1999/doomalay/main/a.js",
		},
	}
	for i, c := range cases {
		if got := FileURL(c.manifest, c.ref, c.file); got != c.want {
			t.Errorf("case %d: FileURL = %q, want %q", i, got, c.want)
		}
	}
}

// ── JSON shape (the CI generator's contract) ───────────────────────────

func TestV1174_ManifestJSONKeys(t *testing.T) {
	// The exact JSON the generator emits must unmarshal into Manifest —
	// key drift between generator and engine would silently produce a
	// manifest with zero files.
	raw := `{
	  "version": "v1.17.4",
	  "ref": "v1.17.4",
	  "min_engine": "v1.17.4",
	  "files": [
	    {"path": "engine/internal/server/web/ota.js", "sha256": "` + strings.Repeat("ab", 32) + `", "size": 4321}
	  ]
	}`
	var m Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("generator shape must parse: %v", err)
	}
	if m.Version != "v1.17.4" || m.Ref != "v1.17.4" || m.MinEngine != "v1.17.4" || len(m.Files) != 1 {
		t.Fatalf("round-trip: %+v", m)
	}
	if m.Files[0].SHA256 != strings.Repeat("ab", 32) {
		t.Fatalf("sha256 must round-trip: %q", m.Files[0].SHA256)
	}
}

func bytesOf(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte('a' + i%26)
	}
	return b
}
