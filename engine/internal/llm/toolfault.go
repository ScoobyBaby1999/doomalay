// toolfault.go — v1.56.0 THE HICCUP FLAG.
//
// THE USER'S LAW: "Every single hiccup you encounter while running tool
// calls flag and tell me." A tool that returns a truncated result, a
// skipped file, a partial answer or a fault is a HICCUP — and the
// engine must SAY SO, loudly, instead of letting the model believe a
// partial answer is the whole truth.
//
// THE DETECTOR: the observation text is scanned for the honest markers
// the tool layer already writes:
//
//	[truncated: first N of M bytes shown]      the observation clamp
//	[termux: output truncated at 100KB …]        Termux's result cap
//	[termux: output truncated at the engine's 8MB buffer …]  the engine's own stream memory
//	… (truncated, N chars)                       the brain-side cuts
//	[tool_result truncated]                      the MCP layer's cut
//	REFUSED —                                    a refusal (the blocklist/jail)
//	error:                                       a failed call
//	no matches for the pattern                   an empty search (not a fault)
//
// The result rides the turn as a NOTICE — the user sees it, the model
// sees it, and the trace keeps it (obs.ToolFault). Nothing is swallowed.
package llm

import (
	"context"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

// faultMarker is one detectable hiccup class.
type faultMarker struct {
	needle string
	// label: what to call it in the notice.
	label string
}

// faultMarkers are the honest markers the tool layer writes. The order
// matters: the first match wins (the most specific first).
var faultMarkers = []faultMarker{
	{"[truncated:", "the observation was truncated"},
	{"[tool_result truncated]", "the tool result was truncated"},
	{"[termux: output truncated at 100KB", "the device output hit Termux's 100KB result cap"},
	{"[termux: output truncated at the engine's 8MB buffer", "the device output hit the engine's 8MB stream buffer"},
	{"… (truncated", "the tool output was truncated"},
	{"(truncated,", "the tool output was truncated"},
	{"truncated —", "the tool output was truncated"},
	{"REFUSED —", "the call was refused (it never ran)"},
	{"JAIL REFUSED", "the call was refused by the path jail (it never ran)"},
	{"error:", "the call failed"},
	{"failed internally", "the call failed internally"},
	{"bus failed to execute", "the tool bus failed to execute the call"},
}

// FaultReport is the detection result for ONE tool observation.
type FaultReport struct {
	// Faulted: true when a hiccup marker was found.
	Faulted bool
	// Label: the class ("the observation was truncated", …).
	Label string
	// Detail: the offending line (trimmed) — the evidence.
	Detail string
}

// DetectToolFault scans a tool observation for a hiccup marker.
//
// The scan is deliberately narrow: it looks for the EXACT honest markers
// the tool layer writes, so a normal result that merely contains the
// word "error" inside a code sample is not flagged. The "error:" marker
// only fires on a line that STARTS with it (an error line, not prose).
func DetectToolFault(observation string) FaultReport {
	text := strings.TrimPrefix(observation, "OBSERVATION:\n")
	lines := strings.Split(text, "\n")
	for _, marker := range faultMarkers {
		for _, line := range lines {
			if marker.needle == "error:" {
				// an error LINE (not prose that happens to mention it)
				if !strings.HasPrefix(strings.TrimSpace(line), "error:") {
					continue
				}
			} else {
				if !strings.Contains(line, marker.needle) {
					continue
				}
			}
			detail := strings.TrimSpace(line)
			if len(detail) > 200 {
				detail = detail[:200] + "…"
			}
			return FaultReport{Faulted: true, Label: marker.label, Detail: detail}
		}
	}
	return FaultReport{}
}

// FlagToolFault reports a hiccup to the turn: the notice chunk (the user
// sees it, the model sees it) + the trace event (the ledger keeps it).
//
// It returns the report so the caller can decide (the native-tools loop
// records it; the direct dispatch just speaks it).
func FlagToolFault(ctx context.Context, ch chan<- ChatChunk, toolName, observation string) FaultReport {
	rep := DetectToolFault(observation)
	if !rep.Faulted {
		return rep
	}
	obs.EmitS(ctx, obs.ToolFault, "name", toolName, "label", rep.Label, "detail", rep.Detail)
	text := "tool hiccup — " + toolName + ": " + rep.Label + ": " + rep.Detail
	select {
	case ch <- ChatChunk{Type: "notice", Text: text}:
	default:
		// never block the turn on a notice
	}
	return rep
}
