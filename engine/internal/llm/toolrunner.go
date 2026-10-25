// toolrunner.go — v1.74 THE UNBOUNDED HAND + v1.75.1 THE PHANTOM LANE LAW.
//
// Each tool call runs in its OWN goroutine with a progress channel.
// The turn goroutine NEVER blocks on tool execution — it streams
// progress events to the obs bus and the UI while waiting for Done.
// NO timeouts (user directive: unbounded). Cancel only on ctx (Stop).
// v1.75.1 THE PHANTOM LANE LAW: the ToolRunner does NOT register a jobmgr
// job. jobmgr lanes are born ONLY at the grace window (withGrace's Begin —
// the ticket is the model's one honest handle). The v1.74 integration
// double-registered every call: a bus call rode the server middleware's
// wrap INSIDE this runner's fn, so when the middleware ticketed, the runner
// settled its own phantom job with the TICKET TEXT (the v1730 rig's live
// conviction: the "job" row carried "JOB_STARTED — job … is running in its
// own lane" + the window duration instead of the honest ≥12s result), and
// every plain fast call settled a phantom too — a garbage "job" row per
// tool call through the sink, phantom job_list entries, and capacity counts
// that saw two lanes where the model fired one.

package llm

import (
	"context"
	"fmt"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

// ToolProgress is one progress update from a running tool.
// Percent = nil means unknown; Phase = dynamic marker ("downloading",
// "compiling", "writing", etc.). Detail = human-readable line.
type ToolProgress struct {
	Percent    *float64 `json:"percent,omitempty"`
	Phase      string   `json:"phase,omitempty"`
	Detail     string   `json:"detail,omitempty"`
	ElapsedMs  int64    `json:"elapsed_ms,omitempty"`
}

// ToolResult is the terminal result of a tool run.
type ToolResult struct {
	Observation string
	Err         error
	Phases      []string // all phase markers seen (for debug timeline)
	DurationMs  int64
}

// ToolRunner runs ONE tool call in isolation.
//
// Usage:
//   tr := NewToolRunner(ctx, sessionID, round, "termux")
//   go tr.RunWithContext(func(ctx) (string, error) { ... })
//   for p := range tr.Progress { emitToolProgress(p) }
//   result := <-tr.Done
type ToolRunner struct {
	Name      string
	SessionID string
	Round     int
	
	Progress  chan ToolProgress
	Done      chan ToolResult
	Cancel    context.CancelFunc
	
	startedAt time.Time
	phases    []string
	ctx       context.Context
}

// NewToolRunner creates a runner with its own cancellable context.
// v1.75.1: NO jobmgr registration — lanes are born only at the grace
// window's ticket (the phantom lane law; see the header).
func NewToolRunner(parentCtx context.Context, sessionID string, round int, name string) *ToolRunner {
	ctx, cancel := context.WithCancel(parentCtx)
	return &ToolRunner{
		Name:      name,
		SessionID: sessionID,
		Round:     round,
		Progress:  make(chan ToolProgress, 32),
		Done:      make(chan ToolResult, 1),
		Cancel:    cancel,
		startedAt: time.Now(),
		phases:    make([]string, 0, 8),
		ctx:       ctx,
	}
}

// RunWithContext runs the tool function in a goroutine.
// The fn receives the tool's context (cancelled on Stop).
func (tr *ToolRunner) RunWithContext(fn func(ctx context.Context) (string, error)) {
	go func() {
		defer close(tr.Progress)
		defer close(tr.Done)
		// Recover panics and convert to tool error
		defer func() {
			if r := recover(); r != nil {
				elapsed := time.Since(tr.startedAt).Milliseconds()
				err := fmt.Errorf("engine recovered from panic: %v", r)
				tr.Done <- ToolResult{
					Err:         err,
					Phases:      tr.phases,
					DurationMs:  elapsed,
				}
			}
		}()

		obs.EmitS(tr.ctx, obs.ToolStart, "round", tr.Round, "name", tr.Name, "phase", "starting")
		tr.phases = append(tr.phases, "starting")
		elapsed := time.Since(tr.startedAt).Milliseconds()
		tr.Progress <- ToolProgress{Phase: "starting", ElapsedMs: elapsed}

		observation, err := fn(tr.ctx)

		elapsed = time.Since(tr.startedAt).Milliseconds()
		if err != nil {
			obs.EmitS(tr.ctx, obs.ToolEnd, "round", tr.Round, "name", tr.Name,
				"error", err.Error(), "duration_ms", elapsed, "phases", tr.phases)
			tr.Done <- ToolResult{Err: err, Phases: tr.phases, DurationMs: elapsed}
			return
		}

		tr.phases = append(tr.phases, "finishing")
		obs.EmitS(tr.ctx, obs.ToolEnd, "round", tr.Round, "name", tr.Name,
			"duration_ms", elapsed, "obs_bytes", len(observation), "phases", tr.phases)
		tr.Done <- ToolResult{Observation: observation, Phases: tr.phases, DurationMs: elapsed}
	}()
}

// EmitProgress emits a phase marker progress update.
func (tr *ToolRunner) EmitProgress(phase, detail string) {
	elapsed := time.Since(tr.startedAt).Milliseconds()
	tr.phases = append(tr.phases, phase)
	tr.Progress <- ToolProgress{
		Phase:     phase,
		Detail:    detail,
		ElapsedMs: elapsed,
	}
	obs.EmitS(tr.ctx, obs.ToolProgress, "round", tr.Round, "name", tr.Name,
		"phase", phase, "detail", detail, "elapsed_ms", elapsed)
}

// EmitPercent emits a percentage progress (0-100).
func (tr *ToolRunner) EmitPercent(pct float64, detail string) {
	elapsed := time.Since(tr.startedAt).Milliseconds()
	tr.Progress <- ToolProgress{
		Percent:   &pct,
		Detail:    detail,
		ElapsedMs: elapsed,
	}
	obs.EmitS(tr.ctx, obs.ToolProgress, "round", tr.Round, "name", tr.Name,
		"percent", pct, "detail", detail, "elapsed_ms", elapsed)
}

// Stop cancels the tool's context (user pressed Stop).
func (tr *ToolRunner) Stop() {
	if tr.Cancel != nil {
		tr.Cancel()
	}
}
