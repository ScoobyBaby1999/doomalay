package llm

// reasoning_v1146_test.go — v1.14.6 THE SOLID STREAM: the reasoning
// normalization table. Pins the inline <think>/<thinking> extraction
// (split-tag safe, unclosed-tag flush, literal-angle-bracket prose) and
// the end-to-end canonical channel over a real SSE stub.

import (
        "context"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
)

func TestV1146_ThinkFilterBasics(t *testing.T) {
        t.Run("no-tags-passthrough", func(t *testing.T) {
                f := newThinkFilter()
                th, vis := f.feed("plain answer text")
                if th != "" || vis != "plain answer text" {
                        t.Fatalf("th=%q vis=%q", th, vis)
                }
                th, vis = f.flush()
                if th != "" || vis != "" {
                        t.Fatalf("flush: th=%q vis=%q", th, vis)
                }
        })
        t.Run("closed-block-single-fragment", func(t *testing.T) {
                f := newThinkFilter()
                th, vis := f.feed("<think>secret plan</think>visible answer")
                if th != "secret plan" || vis != "visible answer" {
                        t.Fatalf("th=%q vis=%q", th, vis)
                }
        })
        t.Run("thinking-variant", func(t *testing.T) {
                f := newThinkFilter()
                th, vis := f.feed("<thinking>plan</thinking>answer")
                if th != "plan" || vis != "answer" {
                        t.Fatalf("th=%q vis=%q", th, vis)
                }
        })
        t.Run("split-across-fragments", func(t *testing.T) {
                // the wire truth: tags arrive split mid-tag across SSE fragments
                f := newThinkFilter()
                var th, vis, allTh, allVis string
                for _, frag := range []string{"<th", "ink>reason", "ing is ", "long</th", "ink>the ans", "wer"} {
                        th, vis = f.feed(frag)
                        allTh += th
                        allVis += vis
                }
                ft, fv := f.flush()
                if allTh+ft != "reasoning is long" {
                        t.Fatalf("thinking = %q + %q", allTh, ft)
                }
                if allVis+fv != "the answer" {
                        t.Fatalf("visible = %q + %q", allVis, fv)
                }
        })
        t.Run("unclosed-think-flushes-as-reasoning", func(t *testing.T) {
                // the finish_reason=length class: the cap ate the closer.
                // Thinking streams LIVE (each feed releases what it can); the
                // flush only releases the final holdback — nothing here.
                f := newThinkFilter()
                th, vis := f.feed("<think>cut off mid-rea")
                if th != "cut off mid-rea" || vis != "" {
                        t.Fatalf("feed: th=%q vis=%q", th, vis)
                }
                ft, fv := f.flush()
                if ft != "" || fv != "" {
                        t.Fatalf("flush: th=%q vis=%q", ft, fv)
                }
        })
        t.Run("literal-angle-brackets-survive", func(t *testing.T) {
                f := newThinkFilter()
                var allVis string
                for _, frag := range []string{"a < b and ", "5<6 but 7>", "6 <not a tag", " x"} {
                        _, vis := f.feed(frag)
                        allVis += vis
                }
                ft, fv := f.flush()
                if got := allVis + fv; got != "a < b and 5<6 but 7>6 <not a tag x" {
                        t.Fatalf("visible = %q", got)
                }
                _ = ft
        })
        t.Run("case-insensitive-tags", func(t *testing.T) {
                f := newThinkFilter()
                th, vis := f.feed("<THINK>loud</THINK>calm")
                if th != "loud" || vis != "calm" {
                        t.Fatalf("th=%q vis=%q", th, vis)
                }
        })
        t.Run("visible-text-before-opener", func(t *testing.T) {
                f := newThinkFilter()
                th, vis := f.feed("Sure! <think>plan</think>Here you go.")
                if vis != "Sure! Here you go." || th != "plan" {
                        t.Fatalf("th=%q vis=%q", th, vis)
                }
        })
        t.Run("reasoning-never-leaks-into-visible", func(t *testing.T) {
                // the property the whole table exists for, over a random-ish mix
                f := newThinkFilter()
                stream := []string{"<think>a", "b</think>c", "<think>d</think>", "e"}
                visAll, thAll := "", ""
                for _, s := range stream {
                        th, vis := f.feed(s)
                        visAll += vis
                        thAll += th
                }
                ft, fv := f.flush()
                visAll += fv
                thAll += ft
                if strings.Contains(visAll, "think") || strings.Contains(visAll, "secret") {
                        t.Fatalf("leak: visible=%q thinking=%q", visAll, thAll)
                }
                if visAll != "ce" || thAll != "abd" {
                        t.Fatalf("vis=%q th=%q", visAll, thAll)
                }
        })
}

func TestV1146_ThinkExtractionEndToEnd(t *testing.T) {
        // over the real scanner: the inline shape lands in the canonical
        // reasoning channel; the visible transcript never carries it.
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "text/event-stream")
                w.WriteHeader(200)
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"<think>hidden plan\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\" more plan</think>the answer\"}}]}\n\n"))
                _, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"))
                _, _ = w.Write([]byte("data: [DONE]\n\n"))
        }))
        defer srv.Close()

        var gotReasoning, gotContent strings.Builder
        ch := make(chan ChatChunk, 64)
        req := ChatRequest{Model: "qwq-ish", Provider: "stubprov3", SessionID: "sess-think",
                BaseURL: srv.URL, Messages: []Message{{Role: "user", Content: "go"}}}
        usage, _, err := scanSSECollect(context.Background(), req, nil, ch, func(reasoning, content string) {
                gotReasoning.WriteString(reasoning)
                gotContent.WriteString(content)
        })
        close(ch)
        if err != nil {
                t.Fatalf("scanSSECollect: %v", err)
        }
        if gotReasoning.String() != "hidden plan more plan" {
                t.Fatalf("canonical reasoning = %q", gotReasoning.String())
        }
        if gotContent.String() != "the answer" {
                t.Fatalf("visible content = %q — the think block leaked", gotContent.String())
        }
        if usage.FinishReason != "stop" {
                t.Fatalf("finish = %q", usage.FinishReason)
        }
}
