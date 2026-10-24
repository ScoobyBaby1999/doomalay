package mcpbus

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/jobmgr"
	"github.com/mark3labs/mcp-go/mcp"
)

// jobwrap.go — v1.73.2 THE JOB LAYER (PLAN-V173 §v1.73.2).
//
// THE PATIENT FLOW: a tool call that outlives its grace window gets its
// own lane instead of blocking the chat. The wrap lives at handlerFor —
// the SINGLE execution point every path converges on (the native loop's
// in-process client, the external /mcp consumers, the serve's
// /mcp/oc/<chat> route) — so one wrap arms all surfaces at once.
//
// THE MECHANICS: the call runs in its own goroutine with its own
// cancellation context. A finish within the window returns the EXACT
// today result (byte-identical — zero behavior change for fast tools);
// a finish after the window returns the JOB_STARTED ticket and the work
// continues in the background. The settler goroutine lands the natural
// finish whenever it comes: the manager settles the lane (completed /
// failed), fires the event sink (the after-the-fact chat row — the
// server's emit, the sentinel's pill path), and cancels the context.
//
// job_kill cancels the lane's context FIRST (the work that honors ctx
// aborts — web/webfetch/forge/HTTP); a late natural completion never
// transitions a cancelled lane back (MCP's Tasks law).
//
// The researched numbers: the window is 10s default — comfortably under
// every MCP client timeout found (the TS SDK's 60s per request; Claude
// Code's 60s to first byte + 5min idle; the serve's 12h execution
// wall), so the ticket always arrives while every client is still
// waiting happily.

// sessionOf resolves the lane's session (the Turn's own id; external
// /mcp consumers without a turn park under "external").
func sessionOf(t *Turn) string {
	if t != nil && t.SessionID != "" {
		return t.SessionID
	}
	return "external"
}

// withGrace wraps ONE dispatch in the lane window.
func withGrace(ctx context.Context, t *Turn, name, argJSON string, dispatch func(context.Context) (*mcp.CallToolResult, error)) (*mcp.CallToolResult, error) {
	jm := jobmgr.Default()
	if !jobmgr.GraceEnabled() || !jobmgr.WrapEnabled(name) {
		return dispatch(ctx)
	}
	sess := sessionOf(t)
	if jm.AtCapacity(sess) {
		return mcp.NewToolResultError(fmt.Sprintf(
			"error: this chat already has %d background jobs running — job_list shows them, job_kill stops one, or let one finish first (the runaway guard)", jobmgr.DefaultMaxPerSession)), nil
	}
	// THE DETACHED LANE (the live conviction, caught by the wrap pins):
	// the lane's context must NOT ride the MCP request's cancellation —
	// when this handler returns the ticket, the in-process transport
	// cancels the REQUEST context, and a child ctx died with it (the lane
	// settled instantly as "(cancelled)"). The lane outlives the request
	// by design ("goes on for however long and then returns when it's
	// done"): WithoutCancel keeps the VALUES (the Turn rides ctx values —
	// session-scoped execution survives) while shedding the request's
	// deadline + cancellation. The lane's ONLY killers are job_kill and
	// the natural settle (both call the cancel below).
	dispatchStart := time.Now() // the lane's clock starts at DISPATCH (the whole call)
	jctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	type outcome struct {
		res *mcp.CallToolResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		// v1.13.2 THE CONTAINED PANIC, lane edition: the middleware's
		// recover lives on the CALLER's stack — a panic on THIS stack
		// would kill the engine. The lane carries the same law: a
		// panicking tool becomes the tool-level ERROR RESULT (the live
		// pin: the poisoned-workspace conviction), the lane settles
		// honestly, the engine never dies.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("PANIC recovered in mcpbus tool %s (lane): %v", name, r)
				done <- outcome{res: mcp.NewToolResultError(
					"error: the " + name + " tool failed internally — the engine recovered; re-send the same call (it may have partially run — check the result first if it matters)"), err: nil}
			}
		}()
		r, e := dispatch(jctx)
		done <- outcome{r, e}
	}()
	select {
	case o := <-done:
		cancel()
		return o.res, o.err
	case <-time.After(jobmgr.Grace()):
		// THE ONCE-DELIVERY LAW: when done AND the timer
		// are both ready, Go's select picks randomly — the old shape
		// could hand the caller the TICKET while the settler below
		// ALSO delivered the natural finish as a job row (the same
		// call reported twice). The non-blocking drain settles an
		// already-finished outcome as the plain result — the ticket
		// and the natural finish are mutually exclusive, ever.
		select {
		case o := <-done:
			cancel()
			return o.res, o.err
		default:
		}
		job := jm.Begin(sess, name, argJSON, cancel, dispatchStart)
		go func() {
			// the settler: the lane's finish lands whenever it lands.
			o := <-done
			cancel()
			if o.err != nil {
				jm.Settle(job.ID, jobmgr.StateFailed, "error: the lane failed — "+o.err.Error())
				return
			}
			text, isErr := extractToolText(o.res)
			if isErr {
				jm.Settle(job.ID, jobmgr.StateFailed, text)
				return
			}
			jm.Settle(job.ID, jobmgr.StateCompleted, text)
		}()
		return mcp.NewToolResultText(jobmgr.TicketText(job, jobmgr.Grace())), nil
	}
}

// jobDispatch — the job_* trio's own handler (never grace-wrapped:
// job_status must answer while other lanes run).
func jobDispatch(t *Turn, d *Def, argJSON string) (*mcp.CallToolResult, error) {
	jm := jobmgr.Default()
	sess := sessionOf(t)
	switch d.Name {
	case "job_status":
		id := argString(argJSON, "id")
		if id == "" {
			return mcp.NewToolResultError(`error: job_status needs {"id": "j_…"} — job_list shows every id`), nil
		}
		j, ok := jm.Status(id)
		if !ok {
			return mcp.NewToolResultError("error: no job " + id + " — job_list shows the live ids"), nil
		}
		switch j.State {
		case jobmgr.StateWorking:
			return mcp.NewToolResultText(fmt.Sprintf(
				"RUNNING — job %s (%s) is still working, %.1fs in. Keep doing other things; the completion lands in this chat automatically.",
				j.ID, j.Tool, float64(j.DurationMS)/1000)), nil
		case jobmgr.StateCompleted:
			return mcp.NewToolResultText(fmt.Sprintf(
				"COMPLETED — job %s (%s) finished in %.1fs:\n%s",
				j.ID, j.Tool, float64(j.DurationMS)/1000, j.Text)), nil
		case jobmgr.StateFailed:
			return mcp.NewToolResultError(fmt.Sprintf(
				"FAILED — job %s (%s) failed after %.1fs:\n%s",
				j.ID, j.Tool, float64(j.DurationMS)/1000, j.Text)), nil
		case jobmgr.StateCancelled:
			return mcp.NewToolResultText(fmt.Sprintf(
				"CANCELLED — job %s (%s) was stopped (best-effort — it may still have finished quietly; you will not hear from it again).",
				j.ID, j.Tool)), nil
		}
		return mcp.NewToolResultError("error: unknown job state " + j.State), nil

	case "job_kill":
		id := argString(argJSON, "id")
		if id == "" {
			return mcp.NewToolResultError(`error: job_kill needs {"id": "j_…"} — job_list shows every id`), nil
		}
		ok, wasWorking := jm.Kill(id)
		if !ok {
			return mcp.NewToolResultError("error: no job " + id + " — job_list shows the live ids"), nil
		}
		if !wasWorking {
			return mcp.NewToolResultText("the job was already terminal — job_status reads its final state"), nil
		}
		return mcp.NewToolResultText(fmt.Sprintf(
			"STOPPED — job %s's lane context is killed (best-effort: work already in flight may still finish quietly; you will not hear from it again).",
			id)), nil

	case "job_list":
		jobs := jm.List(sess)
		if len(jobs) == 0 {
			return mcp.NewToolResultText("no background jobs yet — a tool call that outlives its grace window automatically becomes one (the JOB_STARTED ticket teaches the handle)."), nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%d background job(s), newest first:\n", len(jobs))
		for _, j := range jobs {
			switch j.State {
			case jobmgr.StateWorking:
				fmt.Fprintf(&b, "  %s  %s  RUNNING (%.1fs in)\n", j.ID, j.Tool, float64(j.DurationMS)/1000)
			default:
				fmt.Fprintf(&b, "  %s  %s  %s (%.1fs)\n", j.ID, j.Tool, strings.ToUpper(j.State), float64(j.DurationMS)/1000)
			}
		}
		return mcp.NewToolResultText(strings.TrimRight(b.String(), "\n")), nil
	}
	return mcp.NewToolResultError("error: unhandled job tool \"" + d.Name + "\""), nil
}
