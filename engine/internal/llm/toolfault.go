// toolfault.go — v1.56.0 THE HICCUP FLAG · v1.74.1 THE HONEST FAULT LINE.
//
// THE USER'S LAW: "Every single hiccup you encounter while running tool
// calls flag and tell me." A tool that returns a truncated result, a
// skipped file, a partial answer or a fault is a HICCUP — and the
// engine must SAY SO, loudly, instead of letting the model believe a
// partial answer is the whole truth.
//
// THE DETECTOR, v1.74.1: the live conviction (the user's bullet: "the
// model does a tool call, it fails, but executes successfully — and
// the model goes on as if it hadn't failed"): the old line-scan judged
// EVERY line of the observation, so a SUCCESSFUL read/grep/exec whose
// *content* echoed a line starting `error:` (a log file, a grep over
// source, a YAML block) produced the persisted notice "tool hiccup —
// the call failed" while the model's history carried only the success
// — display said failed, execution succeeded. THE HEAD-LINE LAW: the
// error/refusal classes judge ONLY the observation's head (the first
// non-empty line after the OBSERVATION: prefix — where the tool layer
// writes its failures) plus the exec shape's structured `exit_code:`
// line; CONTENT LINES NEVER COUNT. The structured truth wins where it
// exists: the bus result's IsError flag rides busExecute into the
// verdict (FlagToolFaultStructured). Truncation markers keep the full
// scan — ClampMarked and the termux layer APPEND them at the tail
// (engine-written, never content).
//
//      [truncated: first N of M bytes shown]      the observation clamp (tail)
//      [termux: output truncated at 100KB …]        Termux's result cap (tail)
//      [termux: output truncated at the engine's 8MB buffer …]  (tail)
//      … (truncated, N chars)                       the brain-side cuts
//      [tool_result truncated]                      the MCP layer's cut
//      REFUSED — / error: / TIMEOUT —               a refusal/failure (HEAD)
//      exit_code: N                                 the exec shape's truth (any line, engine-written)
//      no matches for the pattern                   an empty search (not a fault)
//
// The result rides the turn as a NOTICE — the user sees it, and the
// trace keeps it (obs.ToolFault). Nothing is swallowed.
package llm

import (
        "context"
        "strconv"
        "strings"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

// headClass is one head-line error/refusal class: the tools write these
// at the observation's HEAD, never inside content.
type headClass struct {
        prefix string
        label  string
}

// headClasses — the error/refusal markers, HEAD-LINE bound (v1.74.1).
var headClasses = []headClass{
        {"error:", "the call failed"},
        {"search error:", "the search call failed"},
        {"fetch error:", "the fetch call failed"},
        {"REFUSED —", "the call was refused (it never ran)"},
        {"JAIL REFUSED", "the call was refused by the path jail (it never ran)"},
        {"TIMEOUT —", "the call timed out"},
        {"exec rate cap", "the exec rate cap refused the call"},
}

// truncationMarkers are the honest engine-written truncation markers;
// ClampMarked and the termux layer APPEND them at the tail — the full
// scan stays (a content line can only false-positive on text that
// literally quotes the engine's own marker shapes — and a truncation
// notice on a successful call never says "failed").
var truncationMarkers = []faultMarker{
        {"[truncated:", "the observation was truncated"},
        {"[tool_result truncated]", "the tool result was truncated"},
        {"[termux: output truncated at 100KB", "the device output hit Termux's 100KB result cap"},
        {"[termux: output truncated at the engine's 8MB buffer", "the device output hit the engine's 8MB stream buffer"},
        {"… (truncated", "the tool output was truncated"},
        {"(truncated,", "the tool output was truncated"},
        {"truncated —", "the tool output was truncated"},
}

// faultMarker is one detectable hiccup class.
type faultMarker struct {
        needle string
        // label: what to call it in the notice.
        label string
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

// observationHead returns the first non-empty line after the
// OBSERVATION: prefix — where the tool layer writes its failures.
func observationHead(observation string) string {
        text := strings.TrimPrefix(observation, "OBSERVATION:\n")
        for _, line := range strings.Split(text, "\n") {
                if t := strings.TrimSpace(line); t != "" {
                        return t
                }
        }
        return ""
}

// headErrorClass matches a head line against the error/refusal classes.
func headErrorClass(head string) (label string, ok bool) {
        if head == "" {
                return "", false
        }
        for _, hc := range headClasses {
                if strings.HasPrefix(head, hc.prefix) {
                        return hc.label, true
                }
        }
        return "", false
}

// nonzeroExitCode reads the exec shape's structured exit_code line (the
// engine writes `exit_code: N` for every exec-class observation — the
// STREAM wrapper and the session verbs). A nonzero exit is a real
// failure regardless of what the stdout/stderr content says; a ZERO
// exit is a success even when stderr grumbles `error:` lines.
func nonzeroExitCode(observation string) bool {
        text := strings.TrimPrefix(observation, "OBSERVATION:\n")
        for _, line := range strings.Split(text, "\n") {
                line = strings.TrimSpace(line)
                if !strings.HasPrefix(line, "exit_code: ") {
                        continue
                }
                v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "exit_code: ")))
                if err == nil && v != 0 {
                        return true
                }
                return false // the first exit_code line is the verdict
        }
        return false
}

// DetectToolFault scans a tool observation for a hiccup marker — the
// legacy heuristic surface (the direct-dispatch path): the head-line
// law for the error/refusal classes, the structured exit_code law for
// the exec shape, the full scan for the tail-appended truncation
// markers. Content lines never count as failures.
func DetectToolFault(observation string) FaultReport {
        return detectToolFault(observation, nil)
}

// DetectToolFaultStructured is the structured-truth surface: the bus
// result's IsError flag (set by every mcp.NewToolResultError) is
// AUTHORITATIVE for the call-failed class — failed=true forces the
// notice, failed=false suppresses the error-class scan entirely (a
// success is a success, whatever its content echoes). Truncation
// markers still report (an honest hiccup on a successful call).
func DetectToolFaultStructured(observation string, failed bool) FaultReport {
        return detectToolFault(observation, &failed)
}

func detectToolFault(observation string, structuredFailed *bool) FaultReport {
        // THE ERROR/REFUSAL CLASS — structured truth first, then the head.
        if structuredFailed != nil {
                if *structuredFailed {
                        return FaultReport{Faulted: true, Label: "the call failed", Detail: clampDetail(observationHead(observation))}
                }
        } else if label, ok := headErrorClass(observationHead(observation)); ok {
                return FaultReport{Faulted: true, Label: label, Detail: clampDetail(observationHead(observation))}
        }
        // the exec shape's structured truth (a nonzero exit is a failure
        // even when the head is the EXEC DONE banner)
        if nonzeroExitCode(observation) {
                return FaultReport{Faulted: true, Label: "the command exited nonzero", Detail: clampDetail(observationHead(observation))}
        }
        // THE TRUNCATION CLASS — engine-written tail markers, full scan.
        text := strings.TrimPrefix(observation, "OBSERVATION:\n")
        lines := strings.Split(text, "\n")
        for _, marker := range truncationMarkers {
                for _, line := range lines {
                        if !strings.Contains(line, marker.needle) {
                                continue
                        }
                        return FaultReport{Faulted: true, Label: marker.label, Detail: clampDetail(strings.TrimSpace(line))}
                }
        }
        return FaultReport{}
}

func clampDetail(detail string) string {
        if len(detail) > 200 {
                return detail[:200] + "…"
        }
        return detail
}

// FlagToolFault reports a hiccup to the turn: the notice chunk (the user
// sees it) + the trace event (the ledger keeps it) — the heuristic
// surface (the direct-dispatch path).
func FlagToolFault(ctx context.Context, ch chan<- ChatChunk, toolName, observation string) FaultReport {
        rep := DetectToolFault(observation)
        return speakToolFault(ctx, ch, toolName, rep)
}

// FlagToolFaultStructured — v1.74.1: the bus path's surface; the
// structured IsError verdict rides in (see DetectToolFaultStructured).
func FlagToolFaultStructured(ctx context.Context, ch chan<- ChatChunk, toolName, observation string, failed bool) FaultReport {
        rep := DetectToolFaultStructured(observation, failed)
        return speakToolFault(ctx, ch, toolName, rep)
}

func speakToolFault(ctx context.Context, ch chan<- ChatChunk, toolName string, rep FaultReport) FaultReport {
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
// NOT SUCCEED (v1.70.1 THE UNDEUPED RETRY · v1.74.1 THE HEAD-LINE LAW):
// the native-tools repeat-cache refuses to cache these — an identical
// re-fire after a failure must RE-EXECUTE, never serve the stale failure
// back (the campaign's mkdir conviction). The structured truth (the bus
// result's IsError) wins where it exists; the heuristic judges ONLY the
// head line + the exec shape's exit_code — content lines never count, so
// a successful read of a log full of `error:` lines caches idempotently
// (the phantom-failure conviction: the old scan skipped the cache on
// content false-positives and every retry re-executed the side effects).
// A truncated-but-successful result is still a success (a re-run would
// truncate identically).
func failedObservation(observation string, structuredFailed bool) bool {
        if structuredFailed {
                return true
        }
        if _, ok := headErrorClass(observationHead(observation)); ok {
                return true
        }
        return nonzeroExitCode(observation)
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
