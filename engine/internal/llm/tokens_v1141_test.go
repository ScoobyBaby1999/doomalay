package llm

// tokens_v1141_test.go — v1.14.1 THE LEDGER: the embedded offline BPE
// counter. The expectations are EXACT cl100k_base counts (verified against
// tiktoken-go's own EncodeOrdinary, probed before pinning).

import "testing"

func TestV1141_CountTokens_ExactCl100k(t *testing.T) {
        cases := map[string]int{
                "":                                     0,
                "hello world":                          2,
                "Hello, world!":                        4,
                "你好，世界":                                6,
                "function foo(bar) { return bar ?? 1; }": 12,
                "a\n\nb":                                3,
        }
        for in, want := range cases {
                if got := CountTokens(in); got != want {
                        t.Errorf("CountTokens(%q) = %d, want %d", in, got, want)
                }
        }
}

// The counter must beat the old chars/3.8 heuristic where it was most
// wrong: punctuation-dense and CJK text. (Not a strict inequality test —
// the exact numbers above already pin it — this one guards the REGRESSION
// shape: someone reintroducing EstimateTokensN inside EstimateTokens.)
func TestV1141_EstimateTokens_IsRealBPE(t *testing.T) {
        // 18 bytes of CJK: heuristic says 5, the BPE says 6.
        if EstimateTokens("你好，世界") != 6 {
                t.Fatalf("EstimateTokens must route through the real BPE (got %d, want 6)", EstimateTokens("你好，世界"))
        }
        // The byte-count form stays heuristic BY CONTRACT (sizes, not text):
        // 15 bytes → 15*10/38+1 = 4.
        if EstimateTokensN(len("你好，世界")) != 4 {
                t.Fatalf("EstimateTokensN is the byte-count form — heuristic by contract (got %d, want 4)", EstimateTokensN(len("你好，世界")))
        }
}

func TestV1141_ParseEmbeddedBpe(t *testing.T) {
        ranks, err := parseEmbeddedBpe(cl100kBpeGZ)
        if err != nil {
                t.Fatalf("embedded BPE parse: %v", err)
        }
        if len(ranks) < 100000 {
                t.Fatalf("cl100k_base ranks: got %d, want ≥100000", len(ranks))
        }
        // "IQ==" is base64 for "!" — rank 0, the file's first line.
        if ranks["!"] != 0 {
                t.Fatalf(`ranks["!"] = %d, want 0`, ranks["!"])
        }
}

// The framing constants: 3 priming + 4 per message + 3 per system prompt.
// Components use CountTokens so the test pins the FRAMING, not the BPE.
func TestV1141_countMessagesTokens_Framing(t *testing.T) {
        msgs := []Message{
                {Role: "user", Content: "hello world"},
                {Role: "assistant", Content: "Hello, world!"},
        }
        want := 3 + (4 + 2) + (4 + 4) // priming + per-message framing + BPE
        if got := countMessagesTokens(msgs, ""); got != want {
                t.Errorf("countMessagesTokens(2 msgs) = %d, want %d", got, want)
        }
        // system adds its BPE count + the 3-token system framing on TOP of the
        // message total (the priming 3 is already inside `want`).
        withSys := want + 3 + CountTokens("be brief")
        if got := countMessagesTokens(msgs, "be brief"); got != withSys {
                t.Errorf("countMessagesTokens(+system) = %d, want %d", got, withSys)
        }
}
