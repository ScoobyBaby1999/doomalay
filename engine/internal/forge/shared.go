// shared.go — helpers every adapter uses (range slicing, caps, clipping).
package forge

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf8"
)

// clampLimit bounds a per_page (models/users may pass 0 or 5000).
func clampLimit(n, def int) int {
	if n <= 0 {
		return def
	}
	if n > 100 {
		return 100 // GitHub/Gitea per_page hard ceiling
	}
	return n
}

// clip trims a string to n chars (list bodies stay readable).
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// firstLine: commit subjects only.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// buildFileContent turns raw bytes + the forge's blob sha into the
// FileContent the REST/brain surfaces share, applying the range spec:
//
//	""        whole file (utf8 when valid, else base64)
//	"head:N"  first N lines   "tail:N" last N lines
//	"lines:A-B" 1-based inclusive slice
//
// Range slicing happens ON raw text BEFORE the binary sniff so a huge file
// with a head:50 spec costs 50 lines of payload, not 4MB.
func buildFileContent(path, sha string, raw []byte, rangeSpec string) *FileContent {
	fc := &FileContent{Path: path, SHA: sha, Size: int64(len(raw))}
	isText := utf8.Valid(raw) && !strings.ContainsRune(string(raw[:min(len(raw), 4000)]), 0)
	if !isText {
		fc.Binary = true
		fc.Encoding = "base64"
		fc.Content = base64.StdEncoding.EncodeToString(raw)
		if rangeSpec != "" {
			fc.Content = "" // binary + range = meaningless; caller shows a note
			fc.Truncated = true
		}
		return fc
	}
	fc.Encoding = "utf8"
	text := string(raw)
	switch {
	case strings.HasPrefix(rangeSpec, "head:"):
		var n int
		fmt.Sscanf(rangeSpec, "head:%d", &n)
		if n > 0 {
			lines := strings.Split(text, "\n")
			if n < len(lines) {
				text = strings.Join(lines[:n], "\n")
				fc.Truncated = true
			}
		}
	case strings.HasPrefix(rangeSpec, "tail:"):
		var n int
		fmt.Sscanf(rangeSpec, "tail:%d", &n)
		if n > 0 {
			lines := strings.Split(text, "\n")
			if n < len(lines) {
				text = strings.Join(lines[len(lines)-n:], "\n")
				fc.Truncated = true
			}
		}
	case strings.HasPrefix(rangeSpec, "lines:"):
		var a, b int
		if strings.Contains(rangeSpec, "-") {
			fmt.Sscanf(rangeSpec, "lines:%d-%d", &a, &b)
		} else {
			fmt.Sscanf(rangeSpec, "lines:%d", &a)
			b = a
		}
		if a > 0 {
			lines := strings.Split(text, "\n")
			if b < a {
				b = a
			}
			if b >= len(lines) {
				b = len(lines)
			}
			text = strings.Join(lines[a-1:b], "\n")
			fc.Truncated = true
		}
	}
	fc.Content = text
	return fc
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
