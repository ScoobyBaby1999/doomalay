package llm

// tokens.go — v1.14.1 THE LEDGER: real token counting via pkoukk/tiktoken-go
// with the cl100k_base BPE ranks EMBEDDED in the binary.
//
// Why embedded: tiktoken-go's default loader fetches the BPE file from
// OpenAI's blob storage at first use — a network fetch inside the first
// chat turn, on an Android device, over a possibly-metered connection,
// behind no user-visible consent. Forbidden. The 757KB gzipped rank file
// ships inside the engine instead and loads offline in ~100ms, once,
// lazily on the first count.
//
// Why cl100k_base and not o200k_base: cl100k is the closest published
// tokenizer for the open-weights families this engine actually serves
// (llama/qwen/mistral/nemotron/deepseek publish no official tokenizers on
// the wire; their hosts tokenize server-side). The counts are ESTIMATES of
// the provider's real count — but estimates with a real BPE beat the old
// chars/3.8 heuristic by a wide margin on code, CJK, and punctuation-dense
// text. Where the provider reports exact usage (it does, in the final
// chunk), the exact number wins downstream — this module only fills the
// gaps (the context guard, compaction triggers, pre-first-turn ring).

import (
	"bufio"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/base64"
	"log"
	"strconv"
	"strings"
	"sync"

	tiktoken "github.com/pkoukk/tiktoken-go"
)

//go:embed catalog/cl100k_base.tiktoken.gz
var cl100kBpeGZ []byte

// offlineLoader serves the embedded ranks regardless of the URL tiktoken-go
// passes (its encoding table hands us OpenAI blob URLs; we never fetch).
type offlineLoader struct{}

func (offlineLoader) LoadTiktokenBpe(_ string) (map[string]int, error) {
	return parseEmbeddedBpe(cl100kBpeGZ)
}

// parseEmbeddedBpe gunzips and parses the `base64(token) rank` line format
// (verified against tiktoken-go's own load.go parser).
func parseEmbeddedBpe(gz []byte) (map[string]int, error) {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	ranks := make(map[string]int, 100256)
	sc := bufio.NewScanner(zr)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		sp := strings.LastIndexByte(line, ' ')
		if sp <= 0 {
			continue
		}
		tok, err := base64.StdEncoding.DecodeString(line[:sp])
		if err != nil {
			continue
		}
		rank, err := strconv.Atoi(line[sp+1:])
		if err != nil {
			continue
		}
		ranks[string(tok)] = rank
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return ranks, nil
}

var (
	tiktokenOnce sync.Once
	tiktokenEnc  *tiktoken.Tiktoken
)

// cl100k returns the process-wide cl100k_base encoding, installing the
// offline loader before the first GetEncoding call. nil ⇒ the embed was
// unreadable (never observed) — callers fall back to the heuristic.
func cl100k() *tiktoken.Tiktoken {
	tiktokenOnce.Do(func() {
		tiktoken.SetBpeLoader(offlineLoader{})
		enc, err := tiktoken.GetEncoding(tiktoken.MODEL_CL100K_BASE)
		if err != nil {
			log.Printf("ledger: tiktoken cl100k_base unavailable (%v) — the chars-per-token heuristic stays on guard duty", err)
			return
		}
		tiktokenEnc = enc
	})
	return tiktokenEnc
}

// CountTokens counts tokens with the real cl100k_base BPE. EncodeOrdinary
// (not Encode): ordinary never treats special-token strings — an assistant
// quoting "<|endofprompt|>" in prose — as anything but text, so it can
// never panic on user content. Any failure degrades to EstimateTokens.
func CountTokens(s string) int {
	if s == "" {
		return 0
	}
	if enc := cl100k(); enc != nil {
		return len(enc.EncodeOrdinary(s))
	}
	return EstimateTokens(s)
}

// countMessagesTokens estimates the wire cost of a message list: the real
// BPE count of role+content plus a flat per-message overhead (the OpenAI
// chat-format framing convention: role, delimiters, ~3-4 tokens). Good
// enough for the guard; the provider's usage chunk remains the exact word.
func countMessagesTokens(messages []Message, system string) int {
	total := 3 // <|start|> assistant reply priming
	if system != "" {
		total += CountTokens(system) + 3
	}
	for _, m := range messages {
		total += 4 // per-message framing
		if m.Content != "" {
			total += CountTokens(m.Content)
		}
		total += CountTokens(m.Name)
		if len(m.ToolCalls) > 0 {
			// tool_calls ride as JSON — count the raw JSON text
			total += CountTokens(string(m.ToolCalls)) + 3
		}
		if m.ToolCallID != "" {
			total += CountTokens(m.ToolCallID)
		}
	}
	return total
}
