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
d="$HOME/.doomalay/streams"
mkdir -p -- "$d" 2>/dev/null || d="$(mktemp -d)"
out="$d/o.$tok"
err="$d/e.$tok"
rm -f -- "$out" "$err" 2>/dev/null
bash -c "$cmd" >"$out" 2>"$err" &
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
curl -s -m 3 -X POST "$url?done=1&ec=$ec" >/dev/null 2>&1 || true
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

// termuxRunStreaming runs ONE long command through the streaming
// wrapper: registers the stream, blocks on the bridge round-trip (the
// curls feed the registry live), then composes the observation. The
// headline parameter rides the observation head ("EXEC DONE" / "PKG
// INSTALL DONE"); workdir "" (pkg) omits the workdir line.
func (s *Server) termuxRunStreaming(ctx context.Context, sessionID, headline, command, workdir string, timeoutMS int) string {
	st := s.txstreams.register(sessionID)
	url := s.termuxStreamURL(st.token)
	res, errObs := s.termuxRunOne(ctx, termuxCommand(termuxStreamScript, url, command, st.token), workdir, timeoutMS)
	if errObs != "" {
		s.txstreams.closeStream(st)
		return errObs
	}
	if res.Timeout {
		// the engine's budget fired: stop accepting chunks (the wrapper
		// may still run in Termux) + report the honest PARTIAL output —
		// the accumulated stream IS the partial. When the curls never
		// landed (the stream buffers are empty), the wrapper died before
		// its own cat — the logs live on disk under the token's name: ONE
		// recovery cat reads them (then cleans them up).
		s.txstreams.closeStream(st)
		st.mu.Lock()
		out, errB, outSeen, errSeen := st.out, st.errS, st.outSeen, st.errSeen
		st.mu.Unlock()
		if outSeen+errSeen == 0 {
			if rec := s.termuxStreamRecover(ctx, st.token); rec != nil {
				out, errB = rec.Stdout, rec.Stderr
			}
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "OBSERVATION:\nTIMEOUT — Termux killed the command at its %ds budget", timeoutMS/1000)
		if out != "" {
			sb.WriteString("; partial stdout:\n" + out)
		}
		if errB != "" {
			sb.WriteString("\nstderr:\n" + errB)
		}
		return sb.String()
	}
	// compose: the streamed buffers when chunks landed, the broadcast
	// fallback otherwise (the wrapper's cat carried the logs out).
	st.mu.Lock()
	out, errB, outSeen, errSeen, gotChunks, ec := st.out, st.errS, st.outSeen, st.errSeen, st.outSeen+st.errSeen > 0, st.ec
	st.mu.Unlock()
	if !gotChunks {
		out, errB, outSeen, errSeen = res.Stdout, res.Stderr, len(res.Stdout), len(res.Stderr)
	}
	if !st.done {
		// the done-curl never landed (the loopback curls failed) — the
		// wrapper's own exit code is the truth (the broadcast carried it).
		ec = res.ExitCode
		// and the entry must not outlive its run: complete it now (the GC
		// only sweeps done/closed streams — an abandoned never-done entry
		// would leak forever).
		s.txstreams.complete(st, ec)
	}
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
	// THE WHOLE-TRUTH LAW, both editions: the streamed path bypasses
	// Termux's 100KB bundle (the loopback curls are unbounded), so the cap
	// is enforced engine-side — the tail rides, the TRUE total reports.
	// The fallback path (no curls landed) IS the bundle physics — the
	// original termuxMaybeTrunc law applies byte-identically.
	if gotChunks {
		if outSeen > termuxCapBytes || errSeen > termuxCapBytes {
			fmt.Fprintf(&sb, "[termux: output truncated at 100KB — %d bytes stdout + %d bytes stderr streamed total]\n", outSeen, errSeen)
		}
		return sb.String()
	}
	return termuxMaybeTrunc(res, sb.String())
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
