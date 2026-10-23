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

// failedObservation reports whether a tool observation means THE CALL DID
// NOT SUCCEED (v1.70.1 THE UNDEUPED RETRY): an error line, a refusal, a
// timeout, or the bus's own failure. The native-tools repeat-cache refuses
// to cache these — an identical re-fire after a failure must RE-EXECUTE,
// never serve the stale failure back (the campaign's mkdir conviction).
// Narrow on purpose: a truncated-but-successful result is still a success
// (a re-run would truncate identically); prose that merely contains the
// word "error" inside output text does not count — only the honest marker
// shapes the tool layer writes.
func failedObservation(observation string) bool {
	text := strings.TrimPrefix(observation, "OBSERVATION:\n")
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "error:") ||
			strings.HasPrefix(line, "REFUSED —") ||
			strings.HasPrefix(line, "JAIL REFUSED") ||
			strings.HasPrefix(line, "TIMEOUT —") ||
			strings.HasPrefix(line, "exec rate cap") ||
			strings.Contains(line, "failed internally") ||
			strings.Contains(line, "bus failed to execute") {
			return true
		}
	}
	return false
}

// mutableReadTools are the census verbs whose answer reflects MUTABLE
// state (v1.70.4 THE STALE CENSUS): a re-fire after any other successful
// call must re-execute, never serve the cached pre-mutation answer.
var mutableReadTools = map[string]bool{
	"persona_list":  true, // persona_set/activate mutate the roster
	"persona_set":   true, // its own output (the list tail) mutates with state
	"fleet":         true, // sibling chats change state constantly
	"djournal":      true, // entries append mid-turn
	"skills":        true, // load/bootstrap change the armed set
	"hublib":        true, // downloads land mid-turn
	"workspace":     true, // list/tree reflect commits + the session binds
	"template_list": true,
	"termux":        true, // session_list/ls reflect the filesystem + sessions
}

// evictMutableReads drops every cached census-verb entry so the next
// identical read re-executes against the CURRENT state (called after any
// successful tool call — the conservative law: a mutation may have landed).
func evictMutableReads(seen map[string]string) {
	for k := range seen {
		if i := strings.IndexByte(k, 0); i >= 0 && mutableReadTools[k[:i]] {
			delete(seen, k)
		}
	}
}
