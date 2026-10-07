package llm

// dsml.go — v0.95.4 THE DSML FILTER, v1.13.3 THE GUT edition.
//
// DeepSeek-family models emit their NATIVE tool-call markup as message
// content when they fall back to their own format — an industry-known class
// (llama.cpp: "The DSML separator belongs to the tool call block, not
// assistant content. it must not leak into content"; openclaw's
// "doubled-bar DSML tool calls are delivered as text and never executed";
// OMP's "DSML markup healer leaking orphan close tags into visible text").
// The live hit (the user's scooby export, nvidia/deepseek quick chat):
// `<｜DSML｜ calls>` blocks streamed into the VISIBLE transcript while the
// calls inside never executed.
//
// The filter is STATEFUL (the block streams across many SSE deltas) and
// does TWO jobs:
//   1. STRIP the markup from visible content (the garbage never reaches
//      the chat);
//   2. RESCUE the calls inside — a closed block's invoke/parameter pairs
//      are parsed into nativeCall values. With a tools array on the
//      request (takeNative) the calls feed the NATIVE loop's consumer
//      and execute through the mcpbus. (v1.13.3: the third ride —
//      re-rendering rescued calls as ACTION lines for the ReAct parser —
//      is deleted with the parser.)

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// The DSML delimiters (the fullwidth bar ｜ is U+FF5C — deepseek's own).
const (
	dsmlOpen  = "<｜DSML｜" // every DSML tag starts with this
	dsmlClose = "<｜DSML｜/calls>"
)

var (
	dsmlInvokeRe = regexp.MustCompile(`(?s)<｜DSML｜\s*invoke\s+name="([^"]*)"\s*>(.*?)(?:<｜DSML｜\s*/invoke>|$)`)
	dsmlParamRe  = regexp.MustCompile(`(?s)<｜DSML｜\s*parameter\s+name="([^"]*)"\s*>(.*?)(?:<｜DSML｜\s*/parameter>|$)`)
	dsmlCloseRe  = regexp.MustCompile(`<｜DSML｜\s*/calls>`)
)

// dsmlFilter is the stateful content splitter.
type dsmlFilter struct {
	takeNative  bool            // feed rescued calls to the native loop's consumer
	inBlock     bool            // currently inside a DSML block
	block       strings.Builder // the accumulating DSML block
	hold        string          // a possible PARTIAL opener at a clean-fragment tail
	calls       []nativeCall    // rescued calls awaiting take()
	pendingTail string          // visible content that followed a closed block
}

// dsmlSplit parses the invoke/parameter pairs out of one DSML block body.
func dsmlSplit(body string) []nativeCall {
	var calls []nativeCall
	for _, m := range dsmlInvokeRe.FindAllStringSubmatch(body, -1) {
		name := strings.TrimSpace(m[1])
		if name == "" {
			continue
		}
		args := map[string]string{}
		for _, p := range dsmlParamRe.FindAllStringSubmatch(m[2], -1) {
			args[strings.TrimSpace(p[1])] = p[2]
		}
		argsJSON, err := json.Marshal(args)
		if err != nil {
			argsJSON = []byte("{}")
		}
		calls = append(calls, nativeCall{
			ID:        fmt.Sprintf("dsml_%d", len(calls)+1),
			Name:      name,
			Arguments: string(argsJSON),
		})
	}
	return calls
}

// feed splits one content fragment: returns the VISIBLE text (markup
// stripped).
func (f *dsmlFilter) feed(content string) string {
	if content == "" {
		out := f.pendingTail
		f.pendingTail = ""
		return out
	}
	// Fast path: clean mode, nothing held, no '<' anywhere — the fragment
	// cannot carry (or complete) a DSML tag.
	if f.hold == "" && f.pendingTail == "" && !f.inBlock && !strings.ContainsRune(content, '<') {
		return content
	}
	out := f.pendingTail
	f.pendingTail = ""
	if f.inBlock {
		f.block.WriteString(content)
		f.maybeClose()
		return out
	}
	// Clean mode: a held partial opener from the previous fragment comes first.
	if f.hold != "" {
		content = f.hold + content
		f.hold = ""
	}
	i := strings.Index(content, dsmlOpen)
	if i < 0 {
		// No opener — but the tail might be a PARTIAL one ("<", "<｜", …).
		if n := partialDSMLOpenerSuffix(content); n > 0 {
			f.hold = content[len(content)-n:]
			content = content[:len(content)-n]
		}
		return out + content
	}
	// Opener found: everything before it is visible, the rest starts a block.
	out += content[:i]
	f.inBlock = true
	f.block.WriteString(content[i:])
	f.maybeClose()
	return out
}

// maybeClose consumes the accumulated block if its closer arrived.
func (f *dsmlFilter) maybeClose() {
	blk := f.block.String()
	loc := dsmlCloseRe.FindStringIndex(blk)
	if loc == nil {
		return
	}
	body, tail := blk[:loc[0]], blk[loc[1]:]
	f.inBlock = false
	f.block.Reset()
	if calls := dsmlSplit(body); len(calls) > 0 {
		f.calls = append(f.calls, calls...)
	}
	if tail != "" {
		f.pendingTail = f.feed(tail)
	}
}

// take returns the rescued calls so far (and clears them) — the native
// consumer's ride.
func (f *dsmlFilter) take() []nativeCall {
	c := f.calls
	f.calls = nil
	return c
}

// partialDSMLOpenerSuffix returns the length of the longest suffix of s
// that could extend into "<｜DSML｜" (a partial opener split across deltas).
func partialDSMLOpenerSuffix(s string) int {
	runes := []rune(s)
	opener := []rune(dsmlOpen)
	max := len(opener) - 1
	if max > len(runes) {
		max = len(runes)
	}
	for n := max; n > 0; n-- {
		if string(runes[len(runes)-n:]) == string(opener[:n]) {
			return len(string(runes[len(runes)-n:]))
		}
	}
	return 0
}

// flush ends the stream: an open block is salvaged (a provider cut off
// mid-call — parse what's there), a held partial opener is released as
// visible content, and the rescued calls come back with the final
// visible fragment.
func (f *dsmlFilter) flush() (calls []nativeCall, visible string) {
	if f.inBlock {
		body := f.block.String()
		f.inBlock = false
		f.block.Reset()
		if c := dsmlSplit(body); len(c) > 0 {
			f.calls = append(f.calls, c...)
		}
	}
	if f.hold != "" {
		visible += f.hold
		f.hold = ""
	}
	visible += f.pendingTail
	f.pendingTail = ""
	return f.take(), visible
}

// providerMaxTokensFloor — the v0.95.4 OUTPUT FLOOR table: hosts KNOWN to
// default max_tokens low when the field is absent (cutting long outputs
// mid-file — the ".MD artifact contents got cut off" class). Only these
// get an explicit floor; every other host keeps its server default.
func providerMaxTokensFloor(provider string) (int, bool) {
	switch provider {
	case "nvidia":
		// NIM defaults to a low output budget when max_tokens is absent
		// (the live .MD-artifact cutoff class). 16384 fits every current
		// NIM model's output headroom (kimi/deepseek/qwen all allow it).
		return 16384, true
	case "together":
		// Together's default output cap is similarly low.
		return 16384, true
	}
	return 0, false
}

// mentionsMaxTokens reports whether a 400 body names max_tokens (the
// strip-and-retry trigger for the output floor).
func mentionsMaxTokens(body string) bool {
	b := strings.ToLower(body)
	return strings.Contains(b, "max_tokens") || strings.Contains(b, "max completion tokens")
}
