package server

// termuxstreamrun.go — v1.23.3 THE LIVE STREAM (PLAN-V123 §3): the
// streaming runner for the long-running verbs (exec + pkg).
//
// THE WRAPPER (ONE bridge /run call — the whole physics): the command
// rides a POSITIONAL ARG (the zero-interpolation law), runs with
// stdout→out.log / stderr→err.log, and a 0.5s poll loop flushes each
// log's increment to the engine's loopback stream route
// (tail -c +N | curl --data-binary @- — twice a second, the user's
// ask); on exit: the final flush + the done-curl (the TRUE exit code)
// + `cat` both logs to the wrapper's own stdout/stderr — THE FALLBACK:
// when the curls never landed (a dead loopback, a pre-curl Termux), the
// result broadcast carries the full output and the observation composes
// from the broadcast exactly like the pre-stream law.
//
// THE OBSERVATION: identical shape to the one-shot law (EXEC DONE /
// PKG DONE, workdir, exit_code, stdout, stderr) — composed from the
// STREAMED buffers when chunks arrived (they bypass Termux's 100KB
// bundle cap, so the cap is enforced engine-side on the tail with the
// TRUE total in the honest marker), from the broadcast otherwise.
//
// THE EMITTER: every chunk append fires the session's WS emitter (the
// tool_stream events — chat.go sets it for the turn's lifetime) and
// lands in the PM poll's display buffer (pmsdk.js polls while the /mcp
// tools/call blocks).

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/termuxbridge"
)

// termuxStreamScript is THE WRAPPER — $1 = the stream URL, $2 = the
// command. Static body only (the zero-interpolation law); the curl
// failures are non-fatal (the cat fallback carries the output).
// $3 = the token (the log names are derivable from it — the timeout
// recovery cats them by name when the wrapper died before its own cat).
const termuxStreamScript = `set -u
url="$1"
cmd="$2"
tok="$3"
shift 3
d="$HOME/.doomalay/streams"
mkdir -p -- "$d" 2>/dev/null || d="$(mktemp -d)"
out="$d/o.$tok"
err="$d/e.$tok"
rm -f -- "$out" "$err" 2>/dev/null
bash -c "$cmd" bash "$@" >"$out" 2>"$err" &
p=$!
o=0
e=0
flush() {
  sz=$(stat -c %s "$out" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$o" ]; then
    tail -c +$((o+1)) "$out" 2>/dev/null | curl -s -m 3 --data-binary @- "$url?ch=o" >/dev/null 2>&1 || true
    o=$sz
  fi
  sz=$(stat -c %s "$err" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$e" ]; then
    tail -c +$((e+1)) "$err" 2>/dev/null | curl -s -m 3 --data-binary @- "$url?ch=e" >/dev/null 2>&1 || true
    e=$sz
  fi
}
while kill -0 "$p" 2>/dev/null; do
  sleep 0.5
  flush
done
wait "$p"
ec=$?
flush
# v1.56.1 THE WHOLE OUTPUT: the final POST carries the COMPLETE log
# files (the incremental flushes can be cut by a fast burst — the full
# POST is the truth). The engine replaces its buffer with it, so the
# observation rides every byte, not just the flushed tail. The cat
# below stays as THE FALLBACK (when the loopback curls never landed).
curl -s -m 120 --data-binary @"$out" "$url?ch=o&full=1" >/dev/null 2>&1 || true
curl -s -m 120 --data-binary @"$err" "$url?ch=e&full=1" >/dev/null 2>&1 || true
curl -s -m 3 -X POST "$url?done=1&ec=$ec" >/dev/null 2>&1 || true
# THE FALLBACK: the broadcast Bundle is 100KB-capped, so this carries
# as much as fits (the HEAD of each log — the whole output already rode
# the loopback HTTP above; the Bundle is only the safety net when the
# loopback never answered).
cat "$out" 2>/dev/null
cat "$err" >&2 2>/dev/null
rm -f -- "$out" "$err" 2>/dev/null
exit "$ec"
`

// termuxStreamURL builds the loopback chunk URL for a token. The engine
// serves 127.0.0.1:<port> (the APK law; the checkin precedent proves
// Termux reaches it).
func (s *Server) termuxStreamURL(token string) string {
	host := "127.0.0.1"
	if s.cfg != nil && s.cfg.Bind != "" && s.cfg.Bind != "0.0.0.0" {
		host = s.cfg.Bind
	}
	port := 8080
	if s.cfg != nil && s.cfg.Port != 0 {
		port = s.cfg.Port
	}
	return fmt.Sprintf("http://%s:%d/api/termux/stream/%s", host, port, token)
}

// termuxStreamParts is the raw streaming outcome: the WHOLE stdout and
// stderr (the streamed buffers — Termux's 100KB PendingIntent bundle
// never sees them), the TRUE totals, the exit code, and the flags.
type termuxStreamParts struct {
	out       string
	errB      string
	outSeen   int
	errSeen   int
	ec        int
	gotChunks bool
	timedOut  bool
	errObs    string
	// bundleTrunc: the FALLBACK path (no loopback chunks landed) read the
	// output out of Termux's 100KB result Bundle — the honest marker must
	// say so (the streamed path is NOT bundle-bound).
	bundleTrunc bool
	// tailOnly: the output came from the wrapper's FALLBACK TAIL (the
	// loopback curls never landed) — the whole output is elsewhere.
	tailOnly bool
}

// termuxStreamRun — the shared streaming core: registers the stream,
// blocks on the bridge round-trip (the curls feed the registry live),
// and returns the WHOLE output.
//
// v1.56.1 THE UNBOUNDED DEVICE OUTPUT: EVERY jailed verb rides this
// core (the file verbs too — ls/read/grep/find used to read their
// output out of Termux's 100KB result Bundle, which amputated a big
// listing or a big grep; now the output rides the loopback HTTP and
// the bundle never touches it).
func (s *Server) termuxStreamRun(ctx context.Context, sessionID, command, workdir string, timeoutMS int, vargs ...string) termuxStreamParts {
	var parts termuxStreamParts
	st := s.txstreams.register(sessionID)
	url := s.termuxStreamURL(st.token)
	// the wrapper's own args: the stream URL, the command, the token —
	// then the command's OWN positional args (the jailed verbs' path +
	// roots) ride after them (the wrapper shifts past its three).
	wrapperArgs := append([]string{url, command, st.token}, vargs...)
	res, errObs := s.termuxRunOne(ctx, termuxCommand(termuxStreamScript, wrapperArgs...), workdir, timeoutMS)
	if errObs != "" {
		s.txstreams.closeStream(st)
		parts.errObs = errObs
		return parts
	}
	if res.Timeout {
		s.txstreams.closeStream(st)
		st.mu.Lock()
		out, errB, outSeen, errSeen := st.out, st.errS, st.outSeen, st.errSeen
		st.mu.Unlock()
		if outSeen+errSeen == 0 {
			if rec := s.termuxStreamRecover(ctx, st.token); rec != nil {
				out, errB = rec.Stdout, rec.Stderr
			}
		}
		parts.out, parts.errB, parts.outSeen, parts.errSeen = out, errB, outSeen, errSeen
		parts.timedOut = true
		return parts
	}
	st.mu.Lock()
	out, errB, outSeen, errSeen, gotChunks, ec := st.out, st.errS, st.outSeen, st.errSeen, st.outSeen+st.errSeen > 0, st.ec
	st.mu.Unlock()
	if !gotChunks {
		// the loopback curls never landed: the broadcast carried the
		// wrapper's FALLBACK TAIL (the last 32KB of each log) — the whole
		// output is NOT here, and the observation must say so (the honest
		// tail marker carries the true length when the bridge knows it).
		out, errB, outSeen, errSeen = res.Stdout, res.Stderr, len(res.Stdout), len(res.Stderr)
		parts.bundleTrunc = termuxTruncated(res)
		parts.tailOnly = true
	}
	if !st.done {
		ec = res.ExitCode
		s.txstreams.complete(st, ec)
	}
	parts.out, parts.errB = out, errB
	parts.outSeen, parts.errSeen = outSeen, errSeen
	parts.ec = ec
	parts.gotChunks = gotChunks
	return parts
}

// termuxRunStreaming runs ONE long command through the streaming
// wrapper and composes the observation. The headline parameter rides
// the observation head ("EXEC DONE" / "PKG INSTALL DONE"); workdir ""
// (pkg) omits the workdir line.
func (s *Server) termuxRunStreaming(ctx context.Context, sessionID, headline, command, workdir string, timeoutMS int) string {
	parts := s.termuxStreamRun(ctx, sessionID, command, workdir, timeoutMS)
	if parts.errObs != "" {
		return parts.errObs
	}
	if parts.timedOut {
		var sb strings.Builder
		fmt.Fprintf(&sb, "OBSERVATION:\nTIMEOUT — the %ds exec budget ended; the command may still be running in Termux (pass timeout_ms up to 1800000, or session_start it for unbounded)", timeoutMS/1000)
		if parts.out != "" {
			sb.WriteString("; partial stdout:\n" + parts.out)
		}
		if parts.errB != "" {
			sb.WriteString("\nstderr:\n" + parts.errB)
		}
		// v1.74.7 THE PHOENIX HEART: the dead-shell teach rides the
		// streaming timeout too — when the gauge convicts death, the model
		// learns the auto-revive state instead of burning calls against a
		// dead shell (the boonboon transcript's 13-blind-retry conviction).
		sb.WriteString(s.termuxPhoenixNoteLine())
		return sb.String()
	}
	out, errB, outSeen, errSeen, ec, gotChunks := parts.out, parts.errB, parts.outSeen, parts.errSeen, parts.ec, parts.gotChunks
	var sb strings.Builder
	sb.WriteString("OBSERVATION:\n" + headline)
	if workdir != "" {
		sb.WriteString(" — workdir " + workdir)
	}
	fmt.Fprintf(&sb, "\nexit_code: %d\nstdout:\n", ec)
	if out == "" {
		sb.WriteString("(empty)\n")
	} else {
		sb.WriteString(out)
		if !strings.HasSuffix(out, "\n") {
			sb.WriteString("\n")
		}
	}
	sb.WriteString("stderr:\n")
	if errB == "" {
		sb.WriteString("(empty)\n")
	} else {
		sb.WriteString(errB)
		if !strings.HasSuffix(errB, "\n") {
			sb.WriteString("\n")
		}
	}
	if gotChunks {
		if outSeen > termuxStreamMemCap || errSeen > termuxStreamMemCap {
			fmt.Fprintf(&sb, "[termux: output truncated at the engine's 8MB buffer — %d bytes stdout + %d bytes stderr streamed total]\n", outSeen, errSeen)
		}
		return sb.String()
	}
	// the FALLBACK path: the output came out of Termux's 100KB result
	// Bundle (the loopback curls never landed) — the honest marker says
	// so (the bundle physics is real there).
	if parts.bundleTrunc {
		sb.WriteString("\n" + termuxTruncatedMarker)
	} else if parts.tailOnly {
		sb.WriteString("\n[termux: the live stream did not answer — this is the broadcast fallback, bounded by Termux's 100KB result bundle]")
	}
	return sb.String()
}

// termuxStreamRecover cats a timed-out wrapper's logs by token (the
// wrapper names them o.<token>/e.<token> and rm's them on natural exit —
// only a timeout death leaves them behind). ONE quick bridge call, 5s
// budget; nil when the bridge fails (the partial is best-effort honesty).
func (s *Server) termuxStreamRecover(ctx context.Context, token string) *termuxbridge.RunResult {
	script := `set -u
d="$HOME/.doomalay/streams"
cat "$d/o.$1" 2>/dev/null
cat "$d/e.$1" >&2 2>/dev/null
rm -f -- "$d/o.$1" "$d/e.$1" 2>/dev/null
`
	recCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, errObs := s.termuxRunOne(recCtx, termuxCommand(script, token), "", 5000)
	if errObs != "" || res == nil || res.Timeout {
		return nil
	}
	return res
}

// termuxRunStreamingWithProgress wraps termuxRunStreaming with ToolRunner
// isolation + progress emission for executeAction integration.
func (s *Server) termuxRunStreamingWithProgress(ctx context.Context, sessionID, headline, command, workdir string, timeoutMS int) string {
	tr := llm.NewToolRunner(ctx, sessionID, 0, "termux")
	go tr.RunWithContext(func(ctx context.Context) (string, error) {
		return s.termuxRunStreaming(ctx, sessionID, headline, command, workdir, timeoutMS), nil
	})
	// Note: progress is emitted by the caller (executeAction's runWithProgress)

	result := <-tr.Done
	if result.Err != nil {
		return "OBSERVATION:\nerror: " + result.Err.Error()
	}
	return result.Observation
}
