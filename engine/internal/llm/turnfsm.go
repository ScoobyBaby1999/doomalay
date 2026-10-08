package llm

// turnfsm.go — v1.14.6 THE SOLID STREAM: the per-bot terminal-state machine.
//
// THE ISOLATION LAW (the user's directive: "one bot per convo … completely
// separate"): ONE FSM INSTANCE per turn, owned by the turn's goroutine,
// carried in the turn's context. NO package-level mutable state — the
// v1.14.6 cross-bot leak came from exactly one such shared map (the per-key
// opencode session id); the FSM is the anti-pattern's opposite.
//
// THE JOB: every stream path must exit through a TERMINAL VERDICT. The
// wire's finish_reason ("stop" / "length" / "tool_calls") is the truth;
// a stream that ends clean (HTTP 200, body closed) without one is NOT a
// completion — it is the silent-stop class (the user's "streams stop"):
//
//      verdict      meaning
//      ─────────────────────────────────────────────────────────────────
//      stop         the model finished (wire truth)
//      length       the provider cut at its output cap (output_cut)
//      tool_calls   the wire asked for tools (mid-chain verdict)
//      error        the turn failed (err != nil, ctx alive)
//      aborted      the user stopped the turn (ctx cancelled)
//      silent-stop  deltas streamed, no finish_reason ever landed
//      empty        200 opened, zero deltas, no finish_reason
//      no-stream    the turn never opened a stream (dispatch died early)
//
// Every verdict flows to the same places the LEDGER already persists
// (Usage.FinishReason → the status event → the event log → the usage
// endpoints) and onto the obs bus (TurnEnd carries it) — recorded via the
// existing plumbing, zero new stores. The plain path HEALS "empty" with
// one announced retry (the generalized answer-force net; nothing was
// rendered, so a retry can never double-stream).
//
// Phases are strictly forward; every observation is nil-safe (paths without
// an FSM — probes, CompleteSync — no-op silently).

import (
        "context"
        "errors"
        "sync"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
)

type turnPhase int32

const (
        phaseNew turnPhase = iota
        phaseDispatched
        phaseStreamOpen
        phaseStreaming
        phaseToolRounds
        phaseTerminal
)

var phaseNames = [...]string{"new", "dispatched", "stream_open", "streaming", "tool_rounds", "terminal"}

func (p turnPhase) String() string {
        if int(p) < len(phaseNames) {
                return phaseNames[p]
        }
        return "unknown"
}

type turnFSM struct {
        mu        sync.Mutex
        ctx       context.Context // the turn's ctx — "aborted" reads it
        sessionID string
        provider  string
        model     string
        path      string // the dispatch path ("native_tools", "plain", …)
        phase     turnPhase
        rounds    int // highest tool round seen (+1)
        opened    bool // a 200 landed (StreamOpen)
        sawDeltas bool // ≥1 real reasoning/content/tool_call delta
        wire      string // last per-completion finish_reason on the wire
        outputCut bool
        verdict   string // the TURN verdict (sealed once)
        completed bool
        started   time.Time
}

func newTurnFSM(ctx context.Context, req ChatRequest) *turnFSM {
        return &turnFSM{ctx: ctx, sessionID: req.SessionID, provider: req.Provider, model: req.Model, started: time.Now()}
}

// ── observations (nil-safe; forward-only phases) ─────────────────────────

func (f *turnFSM) dispatched(path string) {
        if f == nil {
                return
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        f.path = path
        f.adv(phaseDispatched)
}

func (f *turnFSM) markOpen() {
        if f == nil {
                return
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        f.opened = true
        f.adv(phaseStreamOpen)
}

func (f *turnFSM) streamed() {
        if f == nil {
                return
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        f.sawDeltas = true
        f.adv(phaseStreaming)
}

func (f *turnFSM) roundStart(n int) {
        if f == nil {
                return
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        if n+1 > f.rounds {
                f.rounds = n + 1
        }
        f.adv(phaseToolRounds)
}

// noteWire records the per-completion wire verdict (scanSSECollect's exit).
func (f *turnFSM) noteWire(u *Usage) {
        if f == nil || u == nil {
                return
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        if u.FinishReason != "" {
                f.wire = u.FinishReason
                f.outputCut = u.FinishReason == "length"
        }
}

// seal computes the TURN verdict from the CURRENT state (every seal
// recomputes — a later, better state overwrites an earlier one: the
// plain-path retry turns "empty" into the retry's wire truth; a runner
// recursion's last exit wins), optionally patches the merged usage so the
// final status chunk carries the verdict through the LEDGER plumbing, and
// returns the verdict.
func (f *turnFSM) seal(err error, u *Usage) string {
        if f == nil {
                return ""
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        f.verdict = f.compute(err)
        f.completed = true
        f.adv(phaseTerminal)
        if u != nil && u.FinishReason == "" {
                u.FinishReason = f.verdict
                if f.verdict == "length" {
                        u.OutputCut = true
                }
        }
        return f.verdict
}

// report is Chat's defer-side read: the sealed verdict, or an on-demand
// computation for exits that never sealed (panics, unhandled error shapes).
func (f *turnFSM) report() (verdict string, rounds int, path string, ms int) {
        if f == nil {
                return "", 0, "", 0
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        if !f.completed {
                f.verdict = f.compute(nil)
                f.completed = true
                f.adv(phaseTerminal)
        }
        return f.verdict, f.rounds, f.path, int(time.Since(f.started).Milliseconds())
}

// compute is pure: verdict from state (+ err), no mutation.
// Caller holds f.mu.
func (f *turnFSM) compute(err error) string {
        if err != nil {
                if errors.Is(err, context.Canceled) {
                        return "aborted"
                }
                return "error"
        }
        if f.ctx != nil && f.ctx.Err() != nil {
                return "aborted" // the stop path returns nil err + a dead ctx
        }
        if f.wire != "" {
                return f.wire
        }
        if f.sawDeltas {
                return "silent-stop"
        }
        if f.opened {
                return "empty"
        }
        return "no-stream"
}

// adv moves the phase strictly forward. Caller holds f.mu.
func (f *turnFSM) adv(p turnPhase) {
        if p > f.phase {
                f.phase = p
        }
}

// ── context plumbing ─────────────────────────────────────────────────────

type fsmCtxKey struct{}

func withFSM(ctx context.Context, f *turnFSM) context.Context {
        return context.WithValue(ctx, fsmCtxKey{}, f)
}

// fsmFrom returns the turn's FSM, or nil on paths without one (probes,
// sync completions) — every method above is nil-safe by design.
func fsmFrom(ctx context.Context) *turnFSM {
        if ctx == nil {
                return nil
        }
        f, _ := ctx.Value(fsmCtxKey{}).(*turnFSM)
        return f
}

// verifyTerminal is the stream-side integration: scanSSECollect reports
// the lifecycle moments (open, first delta, wire verdict) and the FSM
// rides along on the turn ctx. One call site each, next to the existing
// obs emissions.
func fsmOpened(ctx context.Context)      { fsmFrom(ctx).markOpen() }
func fsmStreamed(ctx context.Context)    { fsmFrom(ctx).streamed() }
func fsmWire(ctx context.Context, u *Usage) { fsmFrom(ctx).noteWire(u) }

// sealTurn is the runner-side exit helper: compute + patch + announce.
// The obs Notice fires only for the non-wire verdicts (the wire verdicts
// already have their Finish event from scanSSECollect).
func sealTurn(ctx context.Context, ch chan<- ChatChunk, err error, u *Usage) string {
        f := fsmFrom(ctx)
        v := f.seal(err, u)
        if f != nil && err == nil && v != "stop" && v != "length" && v != "tool_calls" {
                obs.EmitS(ctx, obs.Notice, "where", "turnfsm", "verdict", v,
                        "rounds", f.rounds, "text", "turn ended without a wire verdict — recorded as "+v)
        }
        return v
}
