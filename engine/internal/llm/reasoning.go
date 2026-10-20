package llm

// reasoning.go — v1.14.6 THE SOLID STREAM: the reasoning normalization
// table. Providers emit model thinking in three wire shapes; the engine
// normalizes ALL of them into ONE canonical reasoning channel so every
// provider's reasoning streams identically (the "thinking" chunks) and
// never leaks into the visible transcript:
//
//      ┌──────────────────────┬───────────────────────────┬─────────────────────────────┐
//      │ shape                │ wire                      │ normalization               │
//      ├──────────────────────┼───────────────────────────┼─────────────────────────────┤
//      │ DeepSeek-style       │ delta.reasoning_content   │ direct (wire-native)        │
//      │ OpenRouter-style     │ delta.reasoning           │ direct (wire-native)        │
//      │ ALIAS PAIR (v1.46.1 —│ reasoning + reasoning_    │ ONE copy — the SAME         │
//      │ PM's vllm-0.31 shim) │ content, byte-equal, in   │ channel in two spellings    │
//      │                      │ one delta                 │ (mergeWireReasoning)        │
//      │ inline think tags    │ <think>…</think> inside   │ extracted → thinking;       │
//      │ (QwQ, R1-distills,   │ delta.content             │ stripped from content       │
//      │ Mistral-old:         │                           │                             │
//      │ <thinking>…)         │                           │                             │
//      └──────────────────────┴───────────────────────────┴─────────────────────────────┘
//
// The two wire-native shapes merge at the scanSSECollect onDelta site
// through mergeWireReasoning — the v1.14.6 assumption ("only one is ever
// non-empty per chunk") was convicted live on PrivateMode (2026-10-20, probe:
// glm-5.3 + gpt-oss-120b, plain + tool rounds, streaming + non-streaming):
// the PM gateway (vllm-0.31.0) serves EVERY reasoning delta in BOTH spellings
// byte-equal for client compatibility (vLLM renamed the channel
// reasoning_content → reasoning; the deployment answers to both names).
// Concatenating both — the old merge — doubled every word of PM reasoning
// (the user's "every word appears twice" report). The alias law: a byte-equal
// pair is ONE channel seen twice → one copy. This file implements the
// third: a stateful, fragment-safe filter — tags arrive SPLIT across SSE
// fragments ("<th", "ink>…"), so matching works on a holdback buffer and
// every held byte is released at flush (an unclosed <think> — the
// finish_reason=length class — delivers its whole tail as reasoning).

const thinkTagMax = len("</thinking>") // 11 — the longest tag we match

// mergeWireReasoning merges the two wire-native reasoning spellings of ONE
// delta into the canonical channel. They are DOCUMENTED ALIASES (vLLM:
// "reasoning used to be called reasoning_content"), so a byte-equal pair is
// ONE channel seen twice — return one copy. Senders that populate exactly
// one (OpenRouter: reasoning; NIM/DeepSeek-style: reasoning_content) are
// untouched; a both-non-empty-and-different delta (no known sender) keeps
// the historical concatenation so no wire byte is ever dropped.
//
// Live conviction (2026-10-20, probe): PrivateMode's gateway (vllm-0.31.0)
// emits {"reasoning":"The","reasoning_content":"The"} on EVERY reasoning
// delta — the old Reasoning+ReasoningOR merge doubled every word (the
// user's "every word appears twice in its reasoning" report).
func mergeWireReasoning(reasoningContent, reasoning string) string {
        switch {
        case reasoningContent == "":
                return reasoning
        case reasoning == "":
                return reasoningContent
        case reasoningContent == reasoning:
                // The alias pair: one channel, two spellings — ONE copy.
                return reasoningContent
        default:
                // Different texts in both spellings: keep every byte (the
                // pre-v1.46.1 behavior — never drop wire text on an unobserved shape).
                return reasoningContent + reasoning
        }
}

type thinkFilter struct {
        inThink bool
        buf     []byte // working buffer (unmatched tail only — never grows unbounded)
        visible []byte // visible text accumulated within THIS feed call
        think   []byte // thinking text extracted within THIS feed call
}

func newThinkFilter() *thinkFilter { return &thinkFilter{} }

// feed consumes one content fragment and returns (extractedThinking,
// visibleContent) for it. Split across fragments is the normal case.
func (f *thinkFilter) feed(s string) (thinking, visible string) {
        f.buf = append(f.buf, s...)
        f.visible = f.visible[:0]
        f.think = f.think[:0]
        f.scan()
        vis := string(f.visible)
        thk := string(f.think)
        f.visible = nil
        f.think = nil
        return thk, vis
}

// flush releases the holdback at end-of-stream: a trailing partial tag is
// literal prose; an unclosed <think> delivers its whole tail as reasoning.
// The returned visible still needs the caller's downstream filter (DSML).
func (f *thinkFilter) flush() (thinking, visible string) {
        vis, thk := string(f.buf), ""
        if f.inThink {
                vis, thk = "", string(f.buf)
        }
        f.buf = nil
        f.inThink = false
        return thk, vis
}

// scan drains the buffer as far as it safely can.
func (f *thinkFilter) scan() {
        for {
                if !f.inThink {
                        idx, tag := findTag(f.buf, thinkOpeners)
                        if idx < 0 {
                                // no full opener — hold back a possible split tag prefix
                                keep := suffixTagPrefix(f.buf, thinkOpeners)
                                f.visible = append(f.visible, f.buf[:len(f.buf)-keep]...)
                                f.buf = f.buf[len(f.buf)-keep:]
                                return
                        }
                        f.visible = append(f.visible, f.buf[:idx]...)
                        f.buf = f.buf[idx+len(tag):]
                        f.inThink = true
                        continue
                }
                idx, tag := findTag(f.buf, thinkClosers)
                if idx < 0 {
                        keep := suffixTagPrefix(f.buf, thinkClosers)
                        f.think = append(f.think, f.buf[:len(f.buf)-keep]...)
                        f.buf = f.buf[len(f.buf)-keep:]
                        return
                }
                f.think = append(f.think, f.buf[:idx]...)
                f.buf = f.buf[idx+len(tag):]
                f.inThink = false
        }
}

var thinkOpeners = []string{"<think>", "<thinking>"}
var thinkClosers = []string{"</think>", "</thinking>"}

// findTag returns the earliest (index, tag) match in b (case-insensitive),
// longest tag preferred at the same index; (-1, "") when none.
func findTag(b []byte, tags []string) (int, string) {
        bestIdx, bestTag := -1, ""
        for _, tag := range tags {
                idx := indexFoldBytes(b, tag)
                if idx < 0 {
                        continue
                }
                if bestIdx < 0 || idx < bestIdx || (idx == bestIdx && len(tag) > len(bestTag)) {
                        bestIdx, bestTag = idx, tag
                }
        }
        return bestIdx, bestTag
}

// suffixTagPrefix returns the length of the longest proper suffix of b that
// is a prefix of some tag (the split-tag holdback), capped below the full
// tag length (a full match would have been found above).
func suffixTagPrefix(b []byte, tags []string) int {
        max := thinkTagMax - 1
        if len(b) < max {
                max = len(b)
        }
        for k := max; k > 0; k-- {
                tail := b[len(b)-k:]
                for _, tag := range tags {
                        if len(tag) > k && startsWithFold(tag, tail) {
                                return k
                        }
                }
        }
        return 0
}

// indexFoldBytes is bytes.Index with case-insensitive ASCII matching
// (the tags are ASCII; CJK passes through untouched — only A-Z folds).
func indexFoldBytes(b []byte, s string) int {
        if len(s) == 0 || len(b) < len(s) {
                return -1
        }
        for i := 0; i+len(s) <= len(b); i++ {
                if prefixFold(s, b[i:i+len(s)]) {
                        return i
                }
        }
        return -1
}

func prefixFold(s string, b []byte) bool {
        if len(s) != len(b) {
                return false
        }
        return startsWithFold(s, b)
}

// startsWithFold reports whether s starts with the byte slice b,
// case-insensitively for ASCII (only A-Z folds).
func startsWithFold(s string, b []byte) bool {
        if len(s) < len(b) {
                return false
        }
        for i := 0; i < len(b); i++ {
                a, c := s[i], b[i]
                if a >= 'A' && a <= 'Z' {
                        a += 32
                }
                if c >= 'A' && c <= 'Z' {
                        c += 32
                }
                if a != c {
                        return false
                }
        }
        return true
}
