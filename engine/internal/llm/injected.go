package llm

import "strings"

// injected.go — v1.64.2 THE LOUD INJECTION (PLAN-V164 §2).
//
// THE USER'S LAW (verbatim): "Anytime our system automatically injects a
// prompt into a turn… We should render this in the UI, try and reuse the
// message box that appears when a model hiccups but add another state to
// it for when the system injects a prompt, displaying the prompt that we
// injected. Every Injected prompt should adhere to this. The system
// should never inject a prompt without making it clear for both the
// frontend and the chat transcript."
//
// The corpus (every synthetic user-role prompt the engine appends to a
// live turn's history) — EVERY site routes through EmitInjected with the
// EXACT text it appends:
//
//   · the seam nudge        (chat.go + nativetools.go — the mid-reply cut)
//   · the proceed injection (nativetools.go — the announcement push; the
//     text is DYNAMIC: the announcement's tail rides for context)
//   · the answer-force nudge(nativetools.go — reasoning without a reply)
//   · the budget line       (nativetools.go — the tool budget verdict)
//   · the continue nudge    (server chat.go — the seam-continue path;
//     emitted server-side through the same event type)
//
// The anti-degradation warnings after arg hiccups ride TOOL RESULTS (the
// pill already renders them 1:1) — their texts are made DYNAMIC by
// RetryDirectiveFor (argrepair.go): the call VERBATIM rides the order.
//
// WIRE: ChatChunk{Type: "injected", Text: prompt} → the server's chunk
// loop stamps {message, code:"injected"} → forwardEvents persists the
// row exactly like a notice → the PWA renders it through the hiccup
// box's machinery (the SAME .msg-bubble.msg-notice container) with the
// NEW injected state (data-code="injected" — the accent tone + the ⌁
// glyph + a "system injected:" lead) → the exports carry the row. The
// model-history fold NEVER carries injected rows (an injection speaks
// its own turn only — compact.go's type filter excludes them).

// EmitInjected speaks ONE system-injected prompt: the row the frontend
// renders + the transcript keeps. The history append stays the CALLER's
// (each site knows its own slice); this is the LOUD half of the law —
// the site passes the EXACT text it appends, so the box never lies about
// what the model was told. Non-blocking (FlagToolFault's discipline): a
// full channel never stalls a turn on its own telemetry.
func EmitInjected(ch chan<- ChatChunk, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	select {
	case ch <- ChatChunk{Type: "injected", Text: text}:
	default:
	}
}

// ProceedInjectionText — the DYNAMIC proceed nudge (the user's ask: "For
// the proceed and output the command we can change that to proceed and
// print the tail of the message for context or use another placeholder.
// Basically let's make the injection messages either very generic and
// simple, or have dynamic text to give the model as much insight and
// help as possible deterministically and programmatically"). The
// model's own announcement tail rides verbatim — deterministic,
// programmatic, dynamic: the model sees exactly what it just said and
// executes THAT.
func ProceedInjectionText(announcement string) string {
	tail := strings.TrimSpace(announcement)
	if len(tail) > 220 {
		tail = tail[len(tail)-220:]
	}
	if tail == "" {
		return "(proceed — execute the announced plan with your tools now)"
	}
	return "(proceed — execute the plan you just announced, with your tools, now. Your announcement's tail, for context: \"" + tail + "\")"
}
