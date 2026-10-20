// pmwire.go — v1.44.3 THE WIRE (PLAN-V144 §3): llm.Chat speaks
// PrivateMode natively.
//
// When Provider == "privatemodeai", OpenAI-compatible requests route
// through the engine's pinned PM client (pmstate.Manager, wired by the
// server at boot) instead of the plain HTTPS POST: same ChatRequest →
// same body JSON → OAE-encrypted frames upstream → decrypted SSE
// downstream → the STANDARD chunk parser. The PM stream masquerades as
// an *http.Response whose Body synthesizes SSE framing from the
// decrypted event payloads, so EVERYTHING downstream works unmodified:
// the 429/503 retry ladder, the 400 effort/max_tokens/tools strips, the
// model-gone fallback routing, native tools, the FSM, tracing, usage —
// and the v1.39 net-pause ladder (PM transport failures carry the same
// net-class text isTransientNetErr matches, so an outage is a pause,
// not a verdict, for PM too).
//
// A PM request NEVER rides the plaintext path — even unwired (nil
// vault) it fails with the honest transport error rather than sending
// an un-encrypted body to a protocol endpoint that would reject it.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/obs"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// PMStream is the decrypted-SSE half of the vendored client's
// ChatCompletionsStream (Next yields ONE complete SSE event payload per
// call; io.EOF after [DONE]; io.ErrUnexpectedEOF on a cut without it).
type PMStream interface {
	Next() ([]byte, error)
	Close() error
}

// PMClient is the encrypted-transport surface the wire consumes
// (*privatemode.Client satisfies it structurally).
type PMClient interface {
	StreamChatCompletions(ctx context.Context, body []byte) (PMStream, error)
	ChatCompletions(ctx context.Context, body []byte) ([]byte, error)
}

// PMTransport is the engine-side PM source (pmstate.Manager implements
// it; the server wires it at boot via SetPMTransport — llm never
// imports the server package).
type PMTransport interface {
	// Client returns the per-key pinned client (TOFU pin, renewal,
	// drift check — pmstate owns every law).
	Client(ctx context.Context) (PMClient, error)
	// DropSecret clears the cached secret for the wire's exactly-once
	// "no secret for ID" recovery.
	DropSecret()
}

var pmTransport PMTransport // nil until the server wires it (tests inject fakes)

// SetPMTransport wires the engine's PM manager (server New(), after the
// vault + pmstate.Manager exist).
func SetPMTransport(t PMTransport) { pmTransport = t }

// PMwired reports whether the native PM transport is available.
func PMwired() bool { return pmTransport != nil }

// pmProvider is the internal provider id the wire intercepts.
const pmProvider = "privatemodeai"

// pmDoPostSSE is the PM arm of doPostSSE: same contract — a successful
// stream becomes a synthetic 200 *http.Response whose Body is the
// decrypted SSE; a non-2xx upstream becomes a synthetic response with
// the DECRYPTED error body (the vendored client already decrypts error
// bodies when they are encrypted), so every status ladder downstream
// (429/503 retry, 404 rotation, 400 strips, friendlyHTTPError) owns it
// exactly like any provider.
func pmDoPostSSE(ctx context.Context, req ChatRequest, bodyBytes []byte, ch chan<- ChatChunk) (*http.Response, error) {
	client, err := pmClient(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := client.StreamChatCompletions(ctx, bodyBytes)
	if err != nil {
		// The "no secret for ID" family: the deployment revoked our
		// cached secret server-side while it still looked valid here.
		// Drop + fresh exchange + ONE retry — exactly once per round.
		var rerr *privatemode.ResponseError
		if errors.As(err, &rerr) && pmSecretGone(rerr) && pmTransport != nil {
			pmTransport.DropSecret()
			client, err = pmClient(ctx)
			if err != nil {
				return nil, err
			}
			stream, err = client.StreamChatCompletions(ctx, bodyBytes)
		}
		if err != nil {
			return pmResponseError(req, err)
		}
	}
	obs.EmitS(ctx, obs.Dispatch, "path", "pm_wire", "provider", req.Provider, "model", req.Model)
	return &http.Response{
		Status:     "200 OK",
		StatusCode: http.StatusOK,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     make(http.Header), // the decrypted app headers ride the stream, not here
		Body:       &pmSSEBody{stream: stream},
		Request:    &http.Request{Method: http.MethodPost},
	}, nil
}

// pmCompleteSync is the PM arm of completeSync: ONE non-streaming
// (stream:false is forced by the wire) encrypted completion, decrypted
// body back, status ladders owned by the caller.
func pmCompleteSync(ctx context.Context, req ChatRequest, body map[string]any) (string, error) {
	// completeSync's shape must be non-streaming for the gateway.
	body["stream"] = false
	delete(body, "stream_options")
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}
	client, err := pmClient(ctx)
	if err != nil {
		return "", err
	}
	decrypted, err := client.ChatCompletions(ctx, bodyBytes)
	if err != nil {
		// the secret-revocation recovery: drop + fresh exchange + ONE retry
		var rerr *privatemode.ResponseError
		if errors.As(err, &rerr) && pmSecretGone(rerr) && pmTransport != nil {
			pmTransport.DropSecret()
			if client, err = pmClient(ctx); err != nil {
				return "", err
			}
			decrypted, err = client.ChatCompletions(ctx, bodyBytes)
		}
		if err != nil {
			return "", pmSyncError(err)
		}
	}
	var resp struct {
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				Reasoning string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(decrypted, &resp); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}
	if resp.Choices[0].Message.Content == "" && resp.Choices[0].Message.Reasoning != "" {
		return resp.Choices[0].Message.Reasoning, nil // reasoning-only response
	}
	return resp.Choices[0].Message.Content, nil
}

// pmClient resolves the pinned client, mapping the manager's honest
// verdicts to the wire's error contract (never the plaintext path).
func pmClient(ctx context.Context) (PMClient, error) {
	if pmTransport == nil {
		return nil, fmt.Errorf("PrivateMode transport not wired (the vault failed to initialize on this engine)")
	}
	c, err := pmTransport.Client(ctx)
	if err != nil {
		if errors.Is(err, pmstate.ErrNoKey) || errors.Is(err, pmstate.ErrPMDeploymentChanged) {
			// honest terminal verdicts — no net-ladder retry, no cooldown
			return nil, err
		}
		// transport-class (attest fetch / exchange / dial): record the
		// net cooldown so alternate routing + the pause ladder own it
		// (the string shape matches isTransientNetErr).
		RecordProviderFailure(pmProvider, "net", err.Error())
		return nil, fmt.Errorf("PrivateMode transport: %w", err)
	}
	return c, nil
}

// pmResponseError converts a failed PM call into the wire's contract:
// upstream non-2xx → the synthetic response (decrypted body) the
// downstream status ladders consume; anything else → the error itself.
// Returns (nil, resp, nil) for the response path, (nil, nil, err) for
// the terminal one.
func pmResponseError(req ChatRequest, err error) (*http.Response, error) {
	var rerr *privatemode.ResponseError
	if errors.As(err, &rerr) {
		return &http.Response{
			Status:     fmt.Sprintf("%d %s", rerr.StatusCode, http.StatusText(rerr.StatusCode)),
			StatusCode: rerr.StatusCode,
			Proto:      "HTTP/1.1",
			ProtoMajor: 1,
			ProtoMinor: 1,
			Header:     rerr.Header,
			Body:       io.NopCloser(bytes.NewReader(rerr.Body)),
			Request:    &http.Request{Method: http.MethodPost},
		}, nil
	}
	return nil, err
}

// pmSyncError converts a failed non-streaming PM call into completeSync's
// error shape ("HTTP %d: %s" with the DECRYPTED body when the gateway
// answered; the transport error otherwise).
func pmSyncError(err error) error {
	resp, terminal := pmResponseError(ChatRequest{}, err)
	if terminal != nil {
		return terminal
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
}

// pmSecretGone matches the server-side secret-revocation family the
// gateway answers with when the cached secret ID is no longer valid.
func pmSecretGone(rerr *privatemode.ResponseError) bool {
	if rerr == nil {
		return false
	}
	b := string(rerr.Body)
	return bytes.Contains(rerr.Body, []byte("no secret")) ||
		bytes.Contains(rerr.Body, []byte("secret for ID")) ||
		bytes.Contains(rerr.Body, []byte("UnknownSecret")) ||
		(len(b) > 0 && rerr.StatusCode == http.StatusNotFound && bytes.Contains(rerr.Body, []byte("secret")))
}

// pmSSEBody adapts the decrypted event stream to the raw SSE byte
// stream the standard parser consumes. io.EOF from Next means the
// upstream ended WITH [DONE] — a synthetic "data: [DONE]" frame rides
// the tail so the parser's done-path is exactly the plain-HTTP one;
// io.ErrUnexpectedEOF is the honest mid-stream cut (body EOF without
// [DONE] — the same shape a cut plain connection leaves).
type pmSSEBody struct {
	stream PMStream
	buf    []byte
	done   bool
	err    error
}

func (b *pmSSEBody) Read(p []byte) (int, error) {
	for {
		if len(b.buf) > 0 {
			n := copy(p, b.buf)
			b.buf = b.buf[n:]
			return n, nil
		}
		if b.done {
			return 0, io.EOF
		}
		if b.err != nil {
			return 0, b.err
		}
		chunk, err := b.stream.Next()
		switch {
		case err == nil:
			frame := make([]byte, 0, len(chunk)+8)
			frame = append(frame, "data: "...)
			frame = append(frame, chunk...)
			frame = append(frame, '\n', '\n')
			b.buf = frame
		case errors.Is(err, io.EOF):
			b.buf = []byte("data: [DONE]\n\n")
			b.done = true
		case errors.Is(err, io.ErrUnexpectedEOF):
			b.done = true // the honest cut: no [DONE] frame, body just ends
		default:
			b.err = err
		}
	}
}

func (b *pmSSEBody) Close() error { return b.stream.Close() }
