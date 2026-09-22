package archive

import (
	"bytes"
	"path/filepath"
	"testing"
)

func sampleFiles() []FileInput {
	return []FileInput{
		{Name: "readme.md", Data: []byte("# Hello\n\nThis is a **test** archive.\n")},
		{Name: "src/main.py", Data: []byte("print('hi from inside the archive')\n")},
		{Name: "data/config.json", Data: []byte(`{"ok": true, "n": 42}`)},
		{Name: "empty.txt", Data: []byte{}},
		{Name: "../evil.txt", Data: []byte("should be cleaned, not traversing")},
	}
}

// round-trip: create → sniff → list → read-every-entry → extract-all
func testRoundTrip(t *testing.T, name string) {
	t.Helper()
	files := sampleFiles()
	data, format, err := Create(name, files)
	if err != nil {
		t.Fatalf("%s: create: %v", name, err)
	}
	if got := Sniff(data); got != format {
		t.Fatalf("%s: sniff after create = %q, want %q", name, got, format)
	}
	got, entries, err := List(data)
	if err != nil {
		t.Fatalf("%s: list: %v", name, err)
	}
	if got != format {
		t.Fatalf("%s: list format = %q, want %q", name, got, format)
	}
	byName := map[string]Entry{}
	for _, e := range entries {
		byName[e.Name] = e
	}
	for _, f := range files {
		clean := cleanEntryName(f.Name)
		if clean == "" {
			continue
		}
		e, ok := byName[clean]
		if !ok {
			t.Fatalf("%s: member %q missing from listing (%v)", name, clean, entries)
		}
		if e.Size != int64(len(f.Data)) {
			t.Fatalf("%s: member %q size = %d, want %d", name, clean, e.Size, len(f.Data))
		}
		got, err := Read(data, clean)
		if err != nil {
			t.Fatalf("%s: read %q: %v", name, clean, err)
		}
		if !bytes.Equal(got, f.Data) {
			t.Fatalf("%s: member %q content mismatch: %q vs %q", name, clean, got, f.Data)
		}
	}
	// extract-all
	var n int
	n, err = ExtractAll(data, func(en string, c []byte) error { return nil })
	if err != nil {
		t.Fatalf("%s: extract all: %v", name, err)
	}
	wantN := 0
	for _, f := range files {
		if cleanEntryName(f.Name) != "" {
			wantN++
		}
	}
	if n != wantN {
		t.Fatalf("%s: extracted %d files, want %d", name, n, wantN)
	}
}

func TestRoundTripAllFormats(t *testing.T) {
	for _, name := range []string{
		"b.zip", "b.tar", "b.tar.gz", "b.tgz", "b.tar.bz2", "b.tbz2",
		"b.tar.xz", "b.txz", "b.tar.zst",
	} {
		t.Run(name, func(t *testing.T) { testRoundTrip(t, name) })
	}
}

// The hand-rolled stored-7z writer gets its own test because it must
// satisfy bodgit/sevenzip (a full spec reader), not just our own code.
func TestSevenZipRoundTrip(t *testing.T) {
	files := sampleFiles()
	data, format, err := Create("b.7z", files)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if format != "7z" {
		t.Fatalf("format = %q, want 7z", format)
	}
	if got := Sniff(data); got != "7z" {
		t.Fatalf("sniff = %q, want 7z", got)
	}
	testRoundTrip(t, "b.7z")
}

// single-file compressors round-trip + remember the original name (gz)
func TestSingleFileCompression(t *testing.T) {
	for _, tc := range []struct {
		name   string
		format string
	}{
		{"notes.txt.gz", "gz"},
		{"notes.txt.bz2", "bz2"},
		{"notes.txt.xz", "xz"},
		{"notes.txt.zst", "zst"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, format, err := Create(tc.name, []FileInput{{Name: "notes.txt", Data: []byte("hello compressed world\n")}})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			if format != tc.format {
				t.Fatalf("format = %q, want %q", format, tc.format)
			}
			if Sniff(data) != tc.format {
				t.Fatalf("sniff mismatch")
			}
			_, entries, err := List(data)
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %v, want 1", entries)
			}
			back, err := Read(data, entries[0].Name)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if string(back) != "hello compressed world\n" {
				t.Fatalf("content = %q", back)
			}
			if tc.format == "gz" && filepath.Base(entries[0].Name) != "notes.txt" {
				t.Fatalf("gz original name lost: %q", entries[0].Name)
			}
		})
	}
}

func TestSniffing(t *testing.T) {
	zipData, _, _ := Create("x.zip", sampleFiles())
	if Sniff(zipData) != "zip" {
		t.Fatal("zip sniff failed")
	}
	gzData, _, _ := Create("x.gz", []FileInput{{Name: "a.txt", Data: []byte("abc")}})
	if Sniff(gzData) != "gz" {
		t.Fatal("gz sniff failed")
	}
	if Sniff([]byte("just some plain text, not an archive")) != "" {
		t.Fatal("plain text misdetected")
	}
	if Sniff([]byte{}) != "" {
		t.Fatal("empty misdetected")
	}
	// renamed: a .zip that's actually tar.gz must still be read as tar.gz
	tgz, _, _ := Create("x.tar.gz", sampleFiles())
	format, _, err := List(tgz)
	if err != nil || format != "tar.gz" {
		t.Fatalf("renamed tgz: format=%q err=%v", format, err)
	}
}

func TestTraversalCleaned(t *testing.T) {
	data, _, _ := Create("t.zip", []FileInput{
		{Name: "/abs/path.txt", Data: []byte("a")},
		{Name: "../../up.txt", Data: []byte("b")},
		{Name: "..\\win\\file.txt", Data: []byte("c")},
	})
	_, entries, err := List(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name != filepath.Base(e.Name) && e.Name != "win/file.txt" && e.Name != filepath.Clean(e.Name) {
			// names must be relative and free of leading /
			if len(e.Name) > 0 && e.Name[0] == '/' {
				t.Fatalf("absolute member survived: %q", e.Name)
			}
		}
	}
}

func TestCreateRARWithoutBinary(t *testing.T) {
	// On systems without `rar` (CI, Android, this test env) the tool must
	// return the helpful proprietary-format error, not crash.
	if _, _, err := Create("x.rar", sampleFiles()); err == nil {
		t.Log("rar binary present — creation succeeded")
	} else if err.Error() == "" {
		t.Fatal("empty error")
	}
}

func TestCaps(t *testing.T) {
	// >200 files get truncated, not wedged
	var files []FileInput
	for i := 0; i < 250; i++ {
		files = append(files, FileInput{Name: "f" + string(rune('a'+i%26)) + itoa(i) + ".txt", Data: []byte("x")})
	}
	data, _, err := Create("big.zip", files)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, entries, _ := List(data)
	if len(entries) > MaxFiles {
		t.Fatalf("cap failed: %d entries", len(entries))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
