// Package archive — v0.23 the unified archive engine.
//
// User spec: "add a method to pack and unpack rar, 7zip, tar, and other
// compressed file formats", both ways. Everything here is PURE GO (the
// engine runs on Android inside the app sandbox — no external binaries):
//
//	CREATE   zip · tar · tar.gz/tgz · tar.bz2/tbz2 · tar.xz/txz · tar.zst
//	         gz · bz2 · xz · zst (single file) · 7z (stored entries — see
//	         write7z below) · rar (only when a real `rar` binary exists,
//	         because RAR *creation* is RARLAB-proprietary; extraction of
//	         rar4/rar5 is pure Go via nwaples/rardecode)
//	EXTRACT  all of the above — sniffed by MAGIC BYTES, not by filename
//	         (models + users mislabel archives all the time).
//
// One implementation, three consumers: the model-facing tools
// (archive_create / archive_extract in llm/filetools.go), the artifact
// VIEWER (server/preview.go), and the archive tests.
package archive

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"os/exec"
	"path"
	"strings"

	"github.com/bodgit/sevenzip"
	"github.com/dsnet/compress/bzip2" // stdlib bzip2 is read-only; this has the writer
	"github.com/klauspost/compress/zstd"
	"github.com/nwaples/rardecode"
	"github.com/ulikunitz/xz"
)

// Entry is one member of an archive (listings for the viewer + tool
// observations).
type Entry struct {
	Name           string `json:"name"`
	Size           int64  `json:"size"`
	CompressedSize int64  `json:"compressed,omitempty"`
	IsDir          bool   `json:"dir,omitempty"`
}

// FileInput is one file going INTO an archive.
type FileInput struct {
	Name string
	Data []byte
}

// Bounded: a model asking for a 5000-file archive can't wedge the loop
// (same caps the zip tools carried in v0.22).
const (
	MaxFiles     = 200
	MaxUnpacked  = 32 << 20 // 32 MB total input
	MaxExtractN  = 60
	MaxEntrySize = 8 << 20 // per-member read cap (8 MB)
)

// ── format sniffing ─────────────────────────────────────────────────────────

// Sniff names the archive format from magic bytes. "" = not an archive we
// know. Deliberately byte-first (never trust the extension — the file
// could be renamed, and tar has no magic at offset 0).
func Sniff(data []byte) string {
	switch {
	case hasMagic(data, "PK\x03\x04"), hasMagic(data, "PK\x05\x06"), hasMagic(data, "PK\x07\x08"):
		return "zip"
	case hasMagic(data, "7z\xbc\xaf\x27\x1c"):
		return "7z"
	case hasMagic(data, "Rar!\x1a\x07\x01\x00"): // rar5
		return "rar"
	case hasMagic(data, "Rar!\x1a\x07\x00"): // rar4
		return "rar"
	}
	// gzip/bz2/xz/zst wrap EITHER a single file or a .tar — peek inside
	// (bounded) to distinguish "notes.txt.gz" from "project.tar.gz".
	switch {
	case hasMagic(data, "\x1f\x8b"):
		if innerIsTar(data, "gz") {
			return "tar.gz"
		}
		return "gz"
	case hasMagic(data, "BZh"):
		if innerIsTar(data, "bz2") {
			return "tar.bz2"
		}
		return "bz2"
	case hasMagic(data, "\xfd7zXZ\x00"):
		if innerIsTar(data, "xz") {
			return "tar.xz"
		}
		return "xz"
	case hasMagic(data, "\x28\xb5\x2f\xfd"):
		if innerIsTar(data, "zst") {
			return "tar.zst"
		}
		return "zst"
	}
	// tar: "ustar" at offset 257 (POSIX / GNU)
	if len(data) > 262 && hasMagic(data[257:], "ustar") {
		return "tar"
	}
	if looksLikeTar(data) {
		return "tar"
	}
	return ""
}

// innerIsTar decompresses a bounded prefix and checks for the ustar magic
// at offset 257 (cheap: 600 bytes).
func innerIsTar(data []byte, format string) bool {
	defer func() { recover() }() // corrupt stream mid-header → not tar
	var r io.Reader = bytes.NewReader(data)
	var err error
	switch format {
	case "gz":
		zr, e := gzip.NewReader(r)
		if e != nil {
			return false
		}
		r = zr
	case "bz2":
		r, _ = bzip2.NewReader(r, nil)
	case "xz":
		xr, e := xz.NewReader(r)
		if e != nil {
			return false
		}
		r = xr
	case "zst":
		zr, e := zstd.NewReader(r)
		if e != nil {
			return false
		}
		defer zr.Close()
		r = zr.IOReadCloser()
	}
	buf := make([]byte, 600)
	n, err := io.ReadFull(r, buf)
	if err != nil && n < 600 && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false
	}
	return len(buf) > 262 && hasMagic(buf[257:], "ustar")
}

func hasMagic(data []byte, magic string) bool {
	return len(data) >= len(magic) && bytes.HasPrefix(data, []byte(magic))
}

func looksLikeTar(data []byte) bool {
	if len(data) < 512 {
		return false
	}
	// cheap authoritativeness check: archive/tar accepts a header?
	tr := tar.NewReader(bytes.NewReader(data))
	h, err := tr.Next()
	if err != nil {
		return false
	}
	return h != nil && h.Name != ""
}

// FormatFromName picks the CREATE format from a filename's extension
// (multi-dot aware: "a.tar.gz" → "tar.gz").
func FormatFromName(name string) string {
	n := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"):
		return "tar.gz"
	case strings.HasSuffix(n, ".tar.bz2"), strings.HasSuffix(n, ".tbz2"), strings.HasSuffix(n, ".tbz"):
		return "tar.bz2"
	case strings.HasSuffix(n, ".tar.xz"), strings.HasSuffix(n, ".txz"):
		return "tar.xz"
	case strings.HasSuffix(n, ".tar.zst"), strings.HasSuffix(n, ".tzst"):
		return "tar.zst"
	case strings.HasSuffix(n, ".tar"), strings.HasSuffix(n, ".tar.br"):
		return "tar"
	case strings.HasSuffix(n, ".zip"):
		return "zip"
	case strings.HasSuffix(n, ".7z"):
		return "7z"
	case strings.HasSuffix(n, ".rar"):
		return "rar"
	case strings.HasSuffix(n, ".gz"):
		return "gz"
	case strings.HasSuffix(n, ".bz2"):
		return "bz2"
	case strings.HasSuffix(n, ".xz"):
		return "xz"
	case strings.HasSuffix(n, ".zst"), strings.HasSuffix(n, ".zstd"):
		return "zst"
	}
	return ""
}

// ── create ──────────────────────────────────────────────────────────────────

// Create builds an archive named name containing files. The format is
// chosen from the filename (FormatFromName); zip is the default fallback.
func Create(name string, files []FileInput) ([]byte, string, error) {
	format := FormatFromName(name)
	if format == "" {
		format = "zip"
	}
	if len(files) > MaxFiles {
		files = files[:MaxFiles]
	}
	var total int64
	for _, f := range files {
		total += int64(len(f.Data))
	}
	if total > MaxUnpacked {
		return nil, format, fmt.Errorf("archive contents exceed the %d MB cap — split into multiple archives", MaxUnpacked>>20)
	}

	switch format {
	case "zip":
		return createZip(files), format, nil
	case "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst":
		return createTar(files, format), format, nil
	case "7z":
		return write7z(files), format, nil
	case "gz", "bz2", "xz", "zst":
		if len(files) != 1 {
			return nil, format, fmt.Errorf("%s compresses exactly ONE file (pass one file, or use tar.gz for many)", format)
		}
		return compressSingle(files[0], format), format, nil
	case "rar":
		return createRAR(files)
	}
	return nil, format, fmt.Errorf("unsupported format %q", format)
}

func createZip(files []FileInput) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		name := cleanEntryName(f.Name)
		if name == "" {
			continue
		}
		w, err := zw.Create(name)
		if err != nil {
			continue
		}
		_, _ = w.Write(f.Data)
	}
	_ = zw.Close()
	return buf.Bytes()
}

func createTar(files []FileInput, format string) []byte {
	var raw bytes.Buffer
	tw := tar.NewWriter(&raw)
	for _, f := range files {
		name := cleanEntryName(f.Name)
		if name == "" {
			continue
		}
		_ = tw.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o644,
			Size: int64(len(f.Data)),
		})
		_, _ = tw.Write(f.Data)
	}
	_ = tw.Close()

	switch format {
	case "tar.gz":
		var out bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&out, gzip.BestSpeed)
		_, _ = zw.Write(raw.Bytes())
		_ = zw.Close()
		return out.Bytes()
	case "tar.bz2":
		var out bytes.Buffer
		bw, _ := bzip2.NewWriter(&out, &bzip2.WriterConfig{Level: 6})
		_, _ = bw.Write(raw.Bytes())
		_ = bw.Close()
		return out.Bytes()
	case "tar.xz":
		var out bytes.Buffer
		xw, _ := xz.NewWriter(&out)
		_, _ = xw.Write(raw.Bytes())
		_ = xw.Close()
		return out.Bytes()
	case "tar.zst":
		var out bytes.Buffer
		zw, _ := zstd.NewWriter(&out, zstd.WithEncoderLevel(zstd.SpeedFastest))
		_, _ = zw.Write(raw.Bytes())
		_ = zw.Close()
		return out.Bytes()
	}
	return raw.Bytes()
}

func compressSingle(f FileInput, format string) []byte {
	switch format {
	case "gz":
		var out bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&out, gzip.BestSpeed)
		zw.Name = path.Base(f.Name) // gzip header carries the original name
		_, _ = zw.Write(f.Data)
		_ = zw.Close()
		return out.Bytes()
	case "bz2":
		var out bytes.Buffer
		bw, _ := bzip2.NewWriter(&out, &bzip2.WriterConfig{Level: 6})
		_, _ = bw.Write(f.Data)
		_ = bw.Close()
		return out.Bytes()
	case "xz":
		var out bytes.Buffer
		xw, _ := xz.NewWriter(&out)
		_, _ = xw.Write(f.Data)
		_ = xw.Close()
		return out.Bytes()
	case "zst":
		var out bytes.Buffer
		zw, _ := zstd.NewWriter(&out)
		_, _ = zw.Write(f.Data)
		_ = zw.Close()
		return out.Bytes()
	}
	return nil
}

// cleanEntryName strips traversal from a member name ("/" prefix, "..",
// backslashes from Windows-made zips).
func cleanEntryName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Clean("/" + name)[1:] // strip leading / + resolve ..
	if name == "." {
		return ""
	}
	return name
}

// ── create: 7z (stored entries) ────────────────────────────────────────────
//
// There is NO maintained pure-Go 7z WRITER (bodgit/sevenzip and every other
// Go lib are read-only). But the 7z format allows entries stored with the
// Copy (id 00) method — a perfectly valid archive, just uncompressed. This
// writer emits the minimal spec-correct stream:
//
//      [32B signature header][packed data…][plain (unencoded) header]
//
// and tags every file's CRC32 so real 7-Zip (and our reader) verifies
// integrity. Round-trip validated in archive_test.go via sevenzip itself.
// Text/model files compress poorly anyway; when users want real
// compression, zip/tar.gz/tar.zst are the recommended formats.

// write7z emits a stored-entry 7z archive. Layout verified byte-by-byte
// against bodgit/sevenzip's parser (types.go read* functions) — the
// structure follows the canonical form that parser assumes:
//
//	header:
//	  kHeader · kMainStreamsInfo
//	    kPackInfo   (pos=0, N pack streams, kSize pack sizes, end)
//	    kUnPackInfo (kFolder: N folders × [1 Copy coder], no bind pairs —
//	                 bodgit derives bindPairs = out-1 = 0 and skips packed
//	                 stream indices when packedStreams == 1 ·
//	                 kCodersUnPackSize: N sizes · end)
//	    kSubStreamsInfo (kCRC: allDefined + N CRC32s · end · end)
//	  kFilesInfo (files=N · kEmptyStream/kEmptyFile bits for zero-length
//	              files (they carry no stream) · kNames UTF-16LE)
//	  end
//
// Files in order, skipping no-stream (empty) ones, map 1:1 onto the N
// folders — readHeader's final loop depends on exactly that.
func write7z(files []FileInput) []byte {
	type f7z struct {
		name string
		data []byte
		crc  uint32
	}
	var fs []f7z
	for _, f := range files {
		name := cleanEntryName(f.Name)
		if name == "" {
			continue
		}
		fs = append(fs, f7z{name: name, data: f.Data, crc: crc32IEEE(f.Data)})
	}
	if len(fs) == 0 {
		fs = []f7z{{name: "empty.txt", data: nil, crc: 0}}
	}

	// streams (folders) exist only for files WITH content
	var streamFiles []f7z
	var emptyFlags []byte // per file (all files), MSB-first bit vector later
	for _, f := range fs {
		if len(f.data) > 0 {
			streamFiles = append(streamFiles, f)
			emptyFlags = append(emptyFlags, 0)
		} else {
			emptyFlags = append(emptyFlags, 1)
		}
	}

	var packed bytes.Buffer
	sizes := make([]uint64, len(streamFiles))
	for i, f := range streamFiles {
		sizes[i] = uint64(len(f.data))
		packed.Write(f.data)
	}

	var h bytes.Buffer
	h.WriteByte(0x01) // kHeader
	h.WriteByte(0x04) // kMainStreamsInfo

	// kPackInfo (0x06): PackPos=0, NumPackStreams=N, kSize, sizes, end
	h.WriteByte(0x06)
	write7zNum(&h, 0)
	write7zNum(&h, uint64(len(streamFiles)))
	h.WriteByte(0x09) // kSize
	for _, s := range sizes {
		write7zNum(&h, s)
	}
	h.WriteByte(0x00) // end PackInfo

	// kUnPackInfo (0x07)
	h.WriteByte(0x07)
	h.WriteByte(0x0B) // kFolder
	write7zNum(&h, uint64(len(streamFiles)))
	h.WriteByte(0x00) // external = no
	for range streamFiles {
		// one folder per file: NumCoders=1, then the coder:
		// flags 0x01 (idSize=1, simple, no attrs) + Copy codec id 0x00.
		// bindPairs = out-1 = 0 (none); packedStreams = in-0 = 1 (no indices).
		write7zNum(&h, 1)
		h.WriteByte(0x01)
		h.WriteByte(0x00)
	}
	h.WriteByte(0x0C) // kCodersUnPackSize
	for _, s := range sizes {
		write7zNum(&h, s)
	}
	h.WriteByte(0x00) // end kUnPackInfo

	// kSubStreamsInfo (0x08): one substream per folder (default), CRCs only
	h.WriteByte(0x08)
	h.WriteByte(0x0A) // kCRC
	h.WriteByte(0x01) // readOptionalBool: all defined
	for _, f := range streamFiles {
		_ = binary.Write(&h, binary.LittleEndian, f.crc)
	}
	h.WriteByte(0x00) // end kSubStreamsInfo
	h.WriteByte(0x00) // end kMainStreamsInfo

	// kFilesInfo (0x05)
	h.WriteByte(0x05)
	write7zNum(&h, uint64(len(fs)))
	if hasBit(emptyFlags) {
		write7zProp(&h, 0x0E, bitsFromFlags(emptyFlags))       // kEmptyStream (bits over ALL files)
		write7zProp(&h, 0x0F, allOnes(countFlags(emptyFlags))) // kEmptyFile (bits over EMPTY files: all files)
	}
	{
		var nb bytes.Buffer
		nb.WriteByte(0x00) // external = no
		for _, f := range fs {
			for _, r := range f.name {
				_ = binary.Write(&nb, binary.LittleEndian, uint16(r))
			}
			_ = binary.Write(&nb, binary.LittleEndian, uint16(0))
		}
		write7zProp(&h, 0x11, nb.Bytes()) // kNames
	}
	h.WriteByte(0x00) // end kFilesInfo
	h.WriteByte(0x00) // end header

	headerBytes := h.Bytes()

	// ── signature header (32 bytes) ──
	var out bytes.Buffer
	out.Write([]byte{'7', 'z', 0xbc, 0xaf, 0x27, 0x1c})
	out.Write([]byte{0x00, 0x04}) // version 0.4
	out.Write([]byte{0, 0, 0, 0}) // StartHeaderCRC placeholder (patched below)
	var tail bytes.Buffer
	_ = binary.Write(&tail, binary.LittleEndian, uint64(packed.Len()))     // NextHeaderOffset (from byte 32)
	_ = binary.Write(&tail, binary.LittleEndian, uint64(len(headerBytes))) // NextHeaderSize
	_ = binary.Write(&tail, binary.LittleEndian, crc32IEEE(headerBytes))   // NextHeaderCRC
	out.Write(tail.Bytes())
	// offset 8..12 = CRC32 of the following 20 bytes (the tail just written)
	binary.LittleEndian.PutUint32(out.Bytes()[8:12], crc32IEEE(tail.Bytes()))

	out.Write(packed.Bytes())
	out.Write(headerBytes)
	return out.Bytes()
}

func crc32IEEE(b []byte) uint32 { return crc32.ChecksumIEEE(b) }

func hasBit(flags []byte) bool {
	for _, f := range flags {
		if f != 0 {
			return true
		}
	}
	return false
}

func countFlags(flags []byte) int {
	n := 0
	for _, f := range flags {
		if f != 0 {
			n++
		}
	}
	return n
}

func allOnes(n int) []byte {
	b := make([]byte, (n+7)/8)
	for i := 0; i < n; i++ {
		b[i/8] |= 1 << (7 - i%8) // MSB-first, like readBool
	}
	return b
}

// bitsFromFlags packs a 0/1-per-item vector into the 7z bit-vector layout:
// MSB-first within each byte (bodgit's readBool starts its mask at 0x80).
func bitsFromFlags(flags []byte) []byte {
	bits := make([]byte, (len(flags)+7)/8)
	for i, f := range flags {
		if f != 0 {
			bits[i/8] |= 1 << (7 - i%8)
		}
	}
	return bits
}

// write7zNum encodes the 7z UINT64 scheme — first byte: l leading ONE bits
// announce l extra bytes, its remaining low bits are the value's TOP
// payload (shifted up 8*l); the extra bytes follow little-endian. 0xFF
// alone means 8 plain LE bytes.
func write7zNum(b *bytes.Buffer, n uint64) {
	if n < 0x80 {
		b.WriteByte(byte(n))
		return
	}
	for l := 1; l <= 7; l++ {
		// payload capacity: (7-l) bits at the top of the value
		if n>>(8*uint(l)) < (1 << uint(7-l)) {
			first := byte((0xFF << uint(8-l)) | byte(n>>(8*uint(l))))
			b.WriteByte(first)
			for i := 0; i < l; i++ {
				b.WriteByte(byte(n >> (8 * uint(i))))
			}
			return
		}
	}
	b.WriteByte(0xFF)
	for i := 0; i < 8; i++ {
		b.WriteByte(byte(n >> (8 * uint(i))))
	}
}

func write7zProp(h *bytes.Buffer, id byte, data []byte) {
	h.WriteByte(id)
	write7zNum(h, uint64(len(data)))
	h.Write(data)
}

// ── create: rar (proprietary; shell out when a real `rar` exists) ─────────

func createRAR(files []FileInput) ([]byte, string, error) {
	rarBin, err := exec.LookPath("rar")
	if err != nil {
		return nil, "rar", errors.New("RAR creation needs the proprietary `rar` tool (RARLAB license — no open-source creator exists). Use zip, 7z or tar.gz instead — they're free and extract everywhere. Unpacking .rar works fully.")
	}
	dir, err := os.MkdirTemp("", "doomalay-rar-*")
	if err != nil {
		return nil, "rar", err
	}
	defer os.RemoveAll(dir)
	var names []string
	for _, f := range files {
		name := cleanEntryName(f.Name)
		if name == "" {
			continue
		}
		full := path.Join(dir, name)
		_ = os.MkdirAll(path.Dir(full), 0o755)
		if err := os.WriteFile(full, f.Data, 0o644); err != nil {
			return nil, "rar", err
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, "rar", errors.New("no files to archive")
	}
	outPath := path.Join(dir, "out.rar")
	args := append([]string{"a", "-ep", outPath}, names...)
	cmd := exec.Command(rarBin, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, "rar", fmt.Errorf("rar failed: %v — %s", err, string(out))
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		return nil, "rar", err
	}
	return data, "rar", nil
}

// ── list ────────────────────────────────────────────────────────────────────

// List reads an archive's member table. The format returned is the sniffed
// one ("" + error when the data isn't an archive we can read).
func List(data []byte) (string, []Entry, error) {
	format := Sniff(data)
	switch format {
	case "zip":
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return format, nil, err
		}
		var out []Entry
		for _, f := range zr.File {
			out = append(out, Entry{Name: f.Name, Size: int64(f.UncompressedSize64), CompressedSize: int64(f.CompressedSize64), IsDir: f.FileInfo().IsDir()})
		}
		return format, out, nil
	case "7z":
		zr, err := sevenzip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return format, nil, err
		}
		var out []Entry
		for _, f := range zr.File {
			out = append(out, Entry{Name: f.Name, Size: int64(f.FileHeader.UncompressedSize), IsDir: f.FileInfo().IsDir()})
		}
		return format, out, nil
	case "rar":
		rr, err := rardecode.NewReader(bytes.NewReader(data), "")
		if err != nil {
			return format, nil, err
		}
		var out []Entry
		for {
			h, err := rr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return format, nil, err
			}
			if h == nil {
				break
			}
			out = append(out, Entry{Name: h.Name, Size: h.UnPackedSize, IsDir: h.IsDir})
			_, _ = io.Copy(io.Discard, rr) // advance
		}
		return format, out, nil
	case "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst":
		tr, err := TarReader(data)
		if err != nil {
			return format, nil, err
		}
		var out []Entry
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return format, nil, err
			}
			out = append(out, Entry{Name: h.Name, Size: h.Size, IsDir: h.Typeflag == tar.TypeDir})
		}
		return format, out, nil
	case "gz", "bz2", "xz", "zst":
		name, size, err := peekSingle(data, format)
		if err != nil {
			return format, nil, err
		}
		return format, []Entry{{Name: name, Size: size}}, nil
	}
	return "", nil, errors.New("not a recognized archive format (zip, 7z, rar, tar, tar.gz, tar.bz2, tar.xz, tar.zst, gz, bz2, xz, zst)")
}

// TarReader returns a tar reader over (possibly compressed) tar bytes. The
// compression layer is picked by sniffing, NOT by filename.
func TarReader(data []byte) (*tar.Reader, error) {
	var r io.Reader = bytes.NewReader(data)
	switch Sniff(data) {
	case "tar.gz":
		zr, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		zr.Multistream(true)
		r = zr
	case "tar.bz2":
		rc, err := bzip2.NewReader(r, nil)
		if err != nil {
			return nil, err
		}
		r = rc
	case "tar.xz":
		xr, err := xz.NewReader(r)
		if err != nil {
			return nil, err
		}
		r = xr
	case "tar.zst":
		zr, err := zstd.NewReader(r)
		if err != nil {
			return nil, err
		}
		// NOTE: no Close — the decoder must outlive this function (a defer
		// here would close it before the caller reads a single entry).
		r = zr.IOReadCloser()
	}
	return tar.NewReader(r), nil
}

func peekSingle(data []byte, format string) (string, int64, error) {
	var r io.Reader = bytes.NewReader(data)
	switch format {
	case "gz":
		zr, err := gzip.NewReader(r)
		if err != nil {
			return "", 0, err
		}
		name := zr.Name
		n, _ := io.Copy(io.Discard, zr)
		if name == "" {
			name = "decompressed.txt"
		}
		return name, n, nil
	case "bz2":
		r, _ = bzip2.NewReader(r, nil)
	case "xz":
		xr, err := xz.NewReader(r)
		if err != nil {
			return "", 0, err
		}
		r = xr
	case "zst":
		zr, err := zstd.NewReader(r)
		if err != nil {
			return "", 0, err
		}
		defer zr.Close()
		r = zr.IOReadCloser()
	}
	n, _ := io.Copy(io.Discard, r)
	return "decompressed.txt", n, nil
}

// ── read / extract ──────────────────────────────────────────────────────────

// Read returns one member's bytes (by exact or base name). For single-file
// formats (gz/bz2/xz/zst) any name matches the one inner file.
func Read(data []byte, name string) ([]byte, error) {
	format := Sniff(data)
	switch format {
	case "zip":
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if matchEntry(f.Name, name) && !f.FileInfo().IsDir() {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, MaxEntrySize))
			}
		}
		return nil, fmt.Errorf("no member named %q", name)
	case "7z":
		zr, err := sevenzip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if matchEntry(f.Name, name) && !f.FileInfo().IsDir() {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, MaxEntrySize))
			}
		}
		return nil, fmt.Errorf("no member named %q", name)
	case "rar":
		rr, err := rardecode.NewReader(bytes.NewReader(data), "")
		if err != nil {
			return nil, err
		}
		for {
			h, err := rr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if h != nil && matchEntry(h.Name, name) && !h.IsDir {
				return io.ReadAll(io.LimitReader(rr, MaxEntrySize))
			}
		}
		return nil, fmt.Errorf("no member named %q", name)
	case "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst":
		tr, err := TarReader(data)
		if err != nil {
			return nil, err
		}
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if matchEntry(h.Name, name) && h.Typeflag != tar.TypeDir {
				return io.ReadAll(io.LimitReader(tr, MaxEntrySize))
			}
		}
		return nil, fmt.Errorf("no member named %q", name)
	case "gz", "bz2", "xz", "zst":
		return DecompressSingle(data, format)
	}
	return nil, errors.New("not a recognized archive format")
}

// DecompressSingle expands a gz/bz2/xz/zst payload to its inner file.
func DecompressSingle(data []byte, format string) ([]byte, error) {
	var r io.Reader = bytes.NewReader(data)
	switch format {
	case "gz":
		zr, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		return io.ReadAll(io.LimitReader(zr, MaxEntrySize))
	case "bz2":
		r, _ = bzip2.NewReader(r, nil)
	case "xz":
		xr, err := xz.NewReader(r)
		if err != nil {
			return nil, err
		}
		r = xr
	case "zst":
		zr, err := zstd.NewReader(r)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr.IOReadCloser()
	}
	return io.ReadAll(io.LimitReader(r, MaxEntrySize))
}

// ExtractAll walks every member and hands it to save (name, bytes).
// Returns the number of files extracted. Empty names/dirs skipped, capped
// at MaxExtractN files.
func ExtractAll(data []byte, save func(name string, content []byte) error) (int, error) {
	_, entries, err := List(data)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if e.IsDir || e.Name == "" {
			continue
		}
		if n >= MaxExtractN {
			break
		}
		content, err := Read(data, e.Name)
		if err != nil {
			continue
		}
		if err := save(e.Name, content); err != nil {
			continue
		}
		n++
	}
	return n, nil
}

func matchEntry(entryName, want string) bool {
	if entryName == want {
		return true
	}
	return path.Base(entryName) == path.Base(want)
}
