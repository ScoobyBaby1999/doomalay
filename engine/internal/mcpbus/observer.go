package mcpbus

// observer.go — v1.13.1 THE BUS: the hooks surface (PLAN-V113 §1).
//
// The Observer is the instrumentation point the ACTION path never had:
// every tool call reports start/end/progress with timing, artifacts and
// sources. The llm package implements it as ChatChunk emission
// (tool_use / tool_result / progress / sources events — the UI contract
// is byte-preserved), and the parallel OTel/tiktoken bot can stack
// another Observer without touching this package.

// ToolStart fires immediately before a tool executes.
type ToolStart struct {
	SessionID string
	Name      string
	Summary   string // short arg summary — the pill text (the old per-category logic, ported)
}

// ToolEnd fires immediately after a tool returns (success or error).
// Sources ride here so observers can emit the citation chunk between
// the tool_use pill and the tool_result text — the exact ordering the
// old executeAction produced.
type ToolEnd struct {
	SessionID  string
	Name       string
	Text       string // the full observation (OBSERVATION prefix stripped)
	IsError    bool
	Artifact   string // the saved artifact's file name (file tools), "" otherwise
	Sources    []Source
	DurationMS int64
}

// Progress fires mid-execution for long tools (the ephemeral status
// lines — "consulting other models…", "building bundle.zip · 12.4 KB…").
type Progress struct {
	SessionID string
	Text      string
}

// Observer receives tool-call lifecycle events. Implementations must
// be safe for concurrent use (turns run concurrently).
type Observer interface {
	OnToolStart(e ToolStart)
	OnToolEnd(e ToolEnd)
	OnProgress(e Progress)
}

// event markers for Bus.fire's single dispatcher.
func (ToolStart) event() {}
func (ToolEnd) event()   {}
func (Progress) event()  {}

// ObserverFuncs adapts plain functions into an Observer (nil funcs are
// skipped) — the lightweight way the OTel bot or tests can tap the bus.
type ObserverFuncs struct {
	Start func(e ToolStart)
	End   func(e ToolEnd)
	Prog  func(e Progress)
}

func (o ObserverFuncs) OnToolStart(e ToolStart) {
	if o.Start != nil {
		o.Start(e)
	}
}

func (o ObserverFuncs) OnToolEnd(e ToolEnd) {
	if o.End != nil {
		o.End(e)
	}
}

func (o ObserverFuncs) OnProgress(e Progress) {
	if o.Prog != nil {
		o.Prog(e)
	}
}
