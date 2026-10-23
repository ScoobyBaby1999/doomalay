// Package jobmgr — v1.73.2 THE JOB LAYER (PLAN-V173 §v1.73.2).
//
// THE USER'S ARCHITECTURE (verbatim): "Wouldn't it make more sense if that
// long tool call gets its own pid with its own allocated resources, goes on
// for however long and then returns when its done? The model can execute and
// continue without a hinderance? That way a model can try one tool call, do
// other methods, decide weather to kill the old pid tool call or not. The UI
// be dealt with after the fact… none should interrupt it's flow. It should
// all feel like an extension not a rigid workflow."
//
// THE LAW (the researched spec shape — MCP Tasks, io.modelcontextprotocol/
// tasks): a tool call that outlives its grace window keeps running in its
// own lane (own goroutine, own cancellation context) while the model gets
// the JOB_STARTED ticket immediately and continues. States are terminal-
// never-transitioning: working → completed | failed | cancelled.
//
// The completions land in the chat AFTER THE FACT (the user's "the UI be
// dealt with after the fact"): the manager fires the event sink (the
// server wires it to the chat's event rail — persist + live push, the
// sentinel's pill path), the native loop injects settled jobs at the next
// round boundary, and the serve path's next opening text carries them.
//
// The kill is COOPERATIVE (MCP's law + Claude Code's honesty: "stopping
// doesn't guarantee the server stops"): job_kill cancels the lane's
// context — work that honors ctx aborts (web/webfetch/forge/HTTP calls);
// work that doesn't may still finish quietly, and a cancelled job STAYS
// cancelled (a late natural completion never transitions the state).
package jobmgr

import (
        "crypto/rand"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "os"
        "strings"
        "sync"
        "time"
)

// The terminal-never-transitions states (the MCP Tasks law).
const (
        StateWorking   = "working"
        StateCompleted = "completed"
        StateFailed    = "failed"
        StateCancelled = "cancelled"
)

// MaxPerSession is the runaway guard — the 9th concurrent lane per chat
// refuses honestly (the caller's message tells the model to clear with
// job_kill or let one finish).
const MaxPerSession = 8

// Job is one lane's record. Terminal jobs keep their Text/DurationMS for
// job_status; the settled ring carries them to the next round boundary.
// cancel is unexported (never marshals) — the lane's context killer.
type Job struct {
        ID         string    `json:"id"`
        SessionID  string    `json:"session_id"`
        Tool       string    `json:"tool"`
        ArgsJSON   string    `json:"args,omitempty"`
        StartedAt  time.Time `json:"started_at"`
        State      string    `json:"state"`
        Text       string    `json:"text,omitempty"`
        DurationMS int64     `json:"duration_ms"`

        cancel func()
}

type manager struct {
        mu      sync.Mutex
        jobs    map[string]*Job  // by ID (terminal jobs stay readable for job_status)
        running map[string]int   // per-session working count (the capacity guard)
        settled map[string][]Job // per-session ring of settled jobs awaiting delivery (DrainSettled)
        sink    func(sessionID, content string)
}

var (
        once   sync.Once
        theMgr *manager
)

// Default builds the engine-wide manager (one per process).
func Default() *manager {
        once.Do(func() {
                theMgr = &manager{
                        jobs:    map[string]*Job{},
                        running: map[string]int{},
                        settled: map[string][]Job{},
                }
        })
        return theMgr
}

// SetEventSink wires the completion rail (the server's emit — persist +
// live push). Idempotent; a nil sink keeps completions silent-but-stored
// (job_status still answers).
func SetEventSink(fn func(sessionID, content string)) {
        Default().setSink(fn)
}

func (m *manager) setSink(fn func(sessionID, content string)) {
        m.mu.Lock()
        m.sink = fn
        m.mu.Unlock()
}

// Grace is the lane window (DOOMALAY_JOB_GRACE_MS; default 10s — the
// researched number: comfortably under every MCP client timeout found
// (the TS SDK's 60s per request; Claude Code's 60s to first byte; the
// serve's 12h execution wall), while a phone chat never stares at a
// frozen pill for more than one breath. 0 disables the layer (the old
// blocking behavior — the rig's control arm).
func Grace() time.Duration {
        if v := strings.TrimSpace(os.Getenv("DOOMALAY_JOB_GRACE_MS")); v != "" {
                var ms int
                if _, err := fmt.Sscanf(v, "%d", &ms); err == nil {
                        return time.Duration(ms) * time.Millisecond
                }
        }
        return 10 * time.Second
}

// GraceEnabled answers whether the layer is on.
func GraceEnabled() bool { return Grace() > 0 }

// WrapEnabled answers whether one tool name rides the layer. The job_*
// tools never wrap (self-reference: job_status must answer while other
// jobs run).
func WrapEnabled(tool string) bool {
        return !strings.HasPrefix(tool, "job_")
}

// AtCapacity answers whether the session is at the lane guard.
func (m *manager) AtCapacity(sessionID string) bool {
        m.mu.Lock()
        n := m.running[sessionID]
        m.mu.Unlock()
        return n >= MaxPerSession
}

// Begin registers a working lane holding the lane's context killer —
// job_kill cancels through it; a natural settle cancels too (releasing
// the context either way; context cancel is idempotent). startedAt is
// the DISPATCH start (the grace window's beginning — the lane's honest
// clock covers the WHOLE call, the windowed wait included: the user's
// ask is "the time it took for each tool call").
func (m *manager) Begin(sessionID, tool, argsJSON string, cancel func(), startedAt time.Time) *Job {
        id := "j_" + randHex(6)
        j := &Job{
                ID: id, SessionID: sessionID, Tool: tool, ArgsJSON: argsJSON,
                StartedAt: startedAt, State: StateWorking, cancel: cancel,
        }
        m.mu.Lock()
        m.jobs[id] = j
        m.running[sessionID] = m.running[sessionID] + 1
        m.mu.Unlock()
        return j
}

// Settle transitions a lane to a terminal state. THE NEVER-TRANSITION
// LAW: a terminal job ignores every later settle (a cancelled job stays
// cancelled even if the work runs to completion — MCP's Tasks law; a
// completed job ignores a late kill). The settle fires the event sink
// (the after-the-fact chat row) exactly once per job.
func (m *manager) Settle(id, state, text string) {
        m.mu.Lock()
        j, ok := m.jobs[id]
        if !ok || j.State != StateWorking {
                m.mu.Unlock()
                return
        }
        j.State = state
        j.Text = text
        j.DurationMS = time.Since(j.StartedAt).Milliseconds()
        if m.running[j.SessionID] > 0 {
                m.running[j.SessionID]--
        }
        m.settled[j.SessionID] = append(m.settled[j.SessionID], *j)
        sink := m.sink
        m.mu.Unlock()
        if sink == nil {
                return
        }
        b, err := json.Marshal(j)
        if err != nil {
                return
        }
        sink(j.SessionID, string(b))
}

// Status answers one job for job_status: working (with the honest
// elapsed) or the terminal text.
func (m *manager) Status(id string) (Job, bool) {
        m.mu.Lock()
        j, has := m.jobs[id]
        var out Job
        if has {
                out = *j
                if j.State == StateWorking {
                        out.DurationMS = time.Since(j.StartedAt).Milliseconds()
                }
        }
        m.mu.Unlock()
        return out, has
}

// Kill settles a working lane as cancelled. The lane's context dies
// FIRST (the work that honors ctx aborts); the honest text says the stop
// is best-effort (the rest may still finish quietly, and a late natural
// completion never transitions the state back — MCP's Tasks law).
func (m *manager) Kill(id string) (ok bool, wasWorking bool) {
        m.mu.Lock()
        j, has := m.jobs[id]
        var cancel func()
        working := false
        if has {
                cancel = j.cancel
                working = j.State == StateWorking
        }
        m.mu.Unlock()
        if !has {
                return false, false
        }
        if !working {
                return true, false
        }
        if cancel != nil {
                cancel()
        }
        m.Settle(id, StateCancelled, "the job was stopped (best-effort — the stop kills the lane's context; work that already started may still finish quietly, but you will not hear from it again)")
        return true, true
}

// List snapshots a session's jobs (newest first) for job_list.
func (m *manager) List(sessionID string) []Job {
        m.mu.Lock()
        var out []Job
        for _, j := range m.jobs {
                if j.SessionID == sessionID {
                        out = append(out, *j)
                }
        }
        m.mu.Unlock()
        // newest first
        for i := 1; i < len(out); i++ {
                for k := i; k > 0 && out[k].StartedAt.After(out[k-1].StartedAt); k-- {
                        out[k], out[k-1] = out[k-1], out[k]
                }
        }
        return out
}

// DrainSettled returns + clears the session's settled ring — the
// delivery seam: the native loop calls it at every round boundary (the
// completions inject as LOUD rows), the serve path's opening text calls
// it once per new turn. Each settle delivers exactly once.
func (m *manager) DrainSettled(sessionID string) []Job {
        m.mu.Lock()
        ring := m.settled[sessionID]
        m.settled[sessionID] = nil
        m.mu.Unlock()
        return ring
}

// TicketText is the model-facing JOB_STARTED observation — the
// researched three-part law (opencode's own shell-ticket shape):
// (1) what happened + the handle, (2) keep working — anything that
// doesn't depend on this, (3) do NOT poll — the completion lands in
// this chat; job_status checks on demand, job_kill stops best-effort.
func TicketText(j *Job, grace time.Duration) string {
        return fmt.Sprintf(
                "JOB_STARTED — job %s (%s) is still running after %ds, so it moved to its own lane instead of blocking this chat.\n"+
                        "Keep working — do anything else that doesn't depend on this result.\n"+
                        "You do NOT need to poll: when it finishes, the result lands in this chat automatically. (job_status {\"id\":\"%s\"} checks on demand; job_kill {\"id\":\"%s\"} stops it — best-effort, the work may still finish quietly.)",
                j.ID, j.Tool, int(grace.Seconds()), j.ID, j.ID)
}

// Line is one settled job's delivery line — ONE shape on every surface
// (the native loop's round-boundary history row + the serve path's
// opening-text block): the id, the tool, the verb, the honest duration
// and the clamped result (rune-safe — never cuts mid-emoji).
func (j Job) Line(maxRunes int) string {
        verb := "finished"
        switch j.State {
        case StateFailed:
                verb = "FAILED"
        case StateCancelled:
                verb = "was stopped"
        }
        head := fmt.Sprintf("· job %s (%s) %s after %.1fs", j.ID, j.Tool, verb, float64(j.DurationMS)/1000)
        if j.State == StateCancelled || strings.TrimSpace(j.Text) == "" {
                return head
        }
        t := strings.TrimSpace(j.Text)
        if maxRunes > 0 {
                r := []rune(t)
                if len(r) > maxRunes {
                        t = string(r[:maxRunes]) + "…(clamped)"
                }
        }
        return head + ":\n" + t
}

// SettledBlock renders the drained ring's delivery block (the header +
// one Line per job — the shape both delivery surfaces inject).
func SettledBlock(jobs []Job, maxRunes int) string {
        var b strings.Builder
        b.WriteString("Background job result(s) from this chat — delivered automatically (no polling was needed):\n")
        for _, j := range jobs {
                b.WriteString(j.Line(maxRunes))
                b.WriteString("\n")
        }
        return strings.TrimRight(b.String(), "\n")
}

// randHex draws n crypto-random bytes as hex (2n chars).
func randHex(n int) string {
        b := make([]byte, n)
        if _, err := rand.Read(b); err != nil {
                // crypto/rand failing is catastrophic-environment; fall back to
                // the monotonic clock so an ID always exists.
                return fmt.Sprintf("%x", time.Now().UnixNano())
        }
        return hex.EncodeToString(b)
}
