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

func sessionOf(t *Turn) string {
	if t != nil && t.SessionID != "" {
		return t.SessionID
	}
	return "external"
}

func withGrace(ctx context.Context, t *Turn, name, argJSON string, dispatch func(context.Context) (*mcp.CallToolResult, error)) (*mcp.CallToolResult, error) {
	jm := jobmgr.Default()
	sess := sessionOf(t)
	maxPerSess := jm.MaxPerSession(sess)
	if maxPerSess == 0 {
		maxPerSess = jobmgr.DefaultMaxPerSession
	}
	if jm.AtCapacity(sess) {
		return mcp.NewToolResultError(fmt.Sprintf(
			"error: this chat already has %d background jobs running - job_list shows them, job_kill stops one, or let one finish first (the runaway guard)", maxPerSess)), nil
	}
	dispatchStart := time.Now()
	jctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	type outcome struct {
		res *mcp.CallToolResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("PANIC recovered in mcpbus tool %s (lane): %v", name, r)
				done <- outcome{res: mcp.NewToolResultError(
					"error: the " + name + " tool failed internally - the engine recovered; re-send the same call (it may have partially run - check the result first if it matters)"), err: nil}
			}
		}()
		r, e := dispatch(jctx)
		done <- outcome{r, e}
	}()
	// v1.74.10: the window rides jobmgr.Grace() — the documented
	// DOOMALAY_JOB_GRACE_MS law (0 disables the layer; the UNBOUNDED
	// LANES rework had silently hardcoded 10s, breaking the knob its own
	// pins tested).
	if !jobmgr.GraceEnabled() {
		o := <-done
		cancel()
		return o.res, o.err
	}
	select {
	case o := <-done:
		cancel()
		return o.res, o.err
	case <-time.After(jobmgr.Grace()):
		// v1.74.1 THE ONCE-DELIVERY LAW (restored by the v1.74.10 wave
		// after the UNBOUNDED LANES rewrite dropped it): when done AND
		// the timer are both ready, Go's select picks randomly — the
		// old shape could hand the caller the TICKET while the settler
		// below ALSO delivered the natural finish as a job row (the
		// same call reported twice). The non-blocking drain settles an
		// already-finished outcome as the plain result — the ticket and
		// the natural finish are mutually exclusive, ever.
		select {
		case o := <-done:
			cancel()
			return o.res, o.err
		default:
		}
		job := jm.Begin(sess, name, argJSON, cancel, dispatchStart)
		go func() {
			o := <-done
			cancel()
			if o.err != nil {
				jm.Settle(job.ID, jobmgr.StateFailed, "error: the lane failed - "+o.err.Error())
				return
			}
			text, isErr := extractToolText(o.res)
			if isErr {
				jm.Settle(job.ID, jobmgr.StateFailed, text)
				return
			}
			jm.Settle(job.ID, jobmgr.StateCompleted, text)
		}()
		return mcp.NewToolResultText(jobmgr.TicketText(job, maxPerSess)), nil
	}
}

func jobDispatch(t *Turn, d *Def, argJSON string) (*mcp.CallToolResult, error) {
	jm := jobmgr.Default()
	sess := sessionOf(t)
	switch d.Name {
	case "job_status":
		id := argString(argJSON, "id")
		if id == "" {
			return mcp.NewToolResultError(`error: job_status needs {"id": "j_..."} - job_list shows every id`), nil
		}
		j, ok := jm.Status(id)
		if !ok {
			return mcp.NewToolResultError("error: no job " + id + " - job_list shows the live ids"), nil
		}
		switch j.State {
		case jobmgr.StateWorking:
			return mcp.NewToolResultText(fmt.Sprintf(
				"RUNNING - job %s (%s) is still working, %.1fs in. Keep doing other things; the completion lands in this chat automatically.",
				j.ID, j.Tool, float64(j.DurationMS)/1000)), nil
		case jobmgr.StateCompleted:
			return mcp.NewToolResultText(fmt.Sprintf(
				"COMPLETED - job %s (%s) finished in %.1fs:\n%s",
				j.ID, j.Tool, float64(j.DurationMS)/1000, j.Text)), nil
		case jobmgr.StateFailed:
			return mcp.NewToolResultError(fmt.Sprintf(
				"FAILED - job %s (%s) failed after %.1fs:\n%s",
				j.ID, j.Tool, float64(j.DurationMS)/1000, j.Text)), nil
		case jobmgr.StateCancelled:
			return mcp.NewToolResultText(fmt.Sprintf(
				"CANCELLED - job %s (%s) was stopped (best-effort - it may still have finished quietly; you will not hear from it again).",
				j.ID, j.Tool)), nil
		}
		return mcp.NewToolResultError("error: unknown job state " + j.State), nil

	case "job_kill":
		id := argString(argJSON, "id")
		if id == "" {
			return mcp.NewToolResultError(`error: job_kill needs {"id": "j_..."} - job_list shows every id`), nil
		}
		ok, wasWorking := jm.Kill(id)
		if !ok {
			return mcp.NewToolResultError("error: no job " + id + " - job_list shows the live ids"), nil
		}
		if !wasWorking {
			return mcp.NewToolResultText("the job was already terminal - job_status reads its final state"), nil
		}
		return mcp.NewToolResultText(fmt.Sprintf(
			"STOPPED - job %s's lane context is killed (best-effort: work already in flight may still finish quietly; you will not hear from it again).",
			id)), nil

	case "job_list":
		jobs := jm.List(sess)
		if len(jobs) == 0 {
			return mcp.NewToolResultText("no background jobs yet - a tool call that outlives its grace window automatically becomes one (the JOB_STARTED ticket teaches the handle)."), nil
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
