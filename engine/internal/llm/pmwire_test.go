// v1.44.3 THE WIRE — the offline battery. Fake transports/streams prove
// the wire's laws without any network:
//
//   - pmSSEBody frames decrypted payloads as SSE, synthesizes [DONE] on
//     a clean EOF, and leaves the honest cut (ErrUnexpectedEOF) as a
//     body that just ends — the same shape a cut plain connection leaves
//   - upstream non-2xx becomes the synthetic response the status
//     ladders own (decrypted body intact)
//   - "no secret for ID" → DropSecret + exactly one retry
//   - ErrPMDeploymentChanged / ErrNoKey are terminal (never net-ladder
//     class); transport failures carry net-class text (isTransientNetErr)
//   - completeSync forces stream:false and parses the decrypted body
package llm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/privatemode"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pmstate"
)

// fakePMStream scripts a sequence of Next results.
type fakePMStream struct {
	results []any // each: []byte payload, or error
	i       int
	closed  int
}

func (f *fakePMStream) Next() ([]byte, error) {
	if f.i >= len(f.results) {
		return nil, io.EOF
	}
	r := f.results[f.i]
	f.i++
	switch v := r.(type) {
	case []byte:
		return v, nil
	case error:
		return nil, v
	}
	return nil, fmt.Errorf("bad script entry %T", r)
}

func (f *fakePMStream) Close() error { f.closed++; return nil }

// fakePMClient scripts StreamChatCompletions / ChatCompletions results.
type fakePMClient struct {
	streamResults []any // each: PMStream, or error
	chatResults   []any
	streamCalls   int
	chatCalls     int
	lastStreamBod []byte
	lastChatBod   []byte
}

func (f *fakePMClient) StreamChatCompletions(ctx context.Context, body []byte) (PMStream, error) {
	f.streamCalls++
	f.lastStreamBod = append([]byte(nil), body...)
	if f.streamCalls > len(f.streamResults) {
		return nil, fmt.Errorf("no more scripted stream results")
	}
	r := f.streamResults[f.streamCalls-1]
	switch v := r.(type) {
	case PMStream:
		return v, nil
	case error:
		return nil, v
	}
	return nil, fmt.Errorf("bad script entry %T", r)
}

func (f *fakePMClient) ChatCompletions(ctx context.Context, body []byte) ([]byte, error) {
	f.chatCalls++
	f.lastChatBod = append([]byte(nil), body...)
	if f.chatCalls > len(f.chatResults) {
		return nil, fmt.Errorf("no more scripted chat results")
	}
	r := f.chatResults[f.chatCalls-1]
	switch v := r.(type) {
	case []byte:
		return v, nil
	case error:
		return nil, v
	}
	return nil, fmt.Errorf("bad script entry %T", r)
}

// fakePMTransport scripts Client results + counts DropSecret.
type fakePMTransport struct {
	clientResults []any // each: PMClient, or error
	calls         int
	drops         int
}

func (f *fakePMTransport) Client(ctx context.Context) (PMClient, error) {
	f.calls++
	if f.calls > len(f.clientResults) {
		return nil, fmt.Errorf("no more scripted clients")
	}
	r := f.clientResults[f.calls-1]
	switch v := r.(type) {
	case PMClient:
		return v, nil
	case error:
		return nil, v
	}
	return nil, fmt.Errorf("bad script entry %T", r)
}

func (f *fakePMTransport) DropSecret() { f.drops++ }

// withPMTransport swaps the package transport for a test and restores it.
func withPMTransport(t *testing.T, tr PMTransport) {
	t.Helper()
	old := pmTransport
	pmTransport = tr
	t.Cleanup(func() { pmTransport = old })
}

func pmTestReq() ChatRequest {
	return ChatRequest{Provider: pmProvider, Model: "glm-5.3-flash", APIKey: "k", SessionID: "pmtest"}
}

// ── pmSSEBody ──────────────────────────────────────────────────────

func TestV1443_SSEBody_FramingAndDone(t *testing.T) {
	s := &fakePMStream{results: []any{
		[]byte(`{"choices":[{"delta":{"content":"a"}}]}`),
		[]byte(`{"choices":[{"delta":{"content":"b"}}]}`),
	}}
	body := &pmSSEBody{stream: s}
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	want := "data: " + `{"choices":[{"delta":{"content":"a"}}]}` + "\n\n" +
		"data: " + `{"choices":[{"delta":{"content":"b"}}]}` + "\n\n" +
		"data: [DONE]\n\n"
	if string(got) != want {
		t.Fatalf("framing mismatch:\ngot:  %q\nwant: %q", string(got), want)
	}
	if s.closed != 0 {
		t.Fatalf("Close not called yet but stream closed early")
	}
	if err := body.Close(); err != nil || s.closed != 1 {
		t.Fatalf("close: %v (closed=%d)", err, s.closed)
	}
}

func TestV1443_SSEBody_CutWithoutDone(t *testing.T) {
	s := &fakePMStream{results: []any{
		[]byte(`{"x":1}`),
		io.ErrUnexpectedEOF,
	}}
	body := &pmSSEBody{stream: s}
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("a cut must read as clean body EOF: %v", err)
	}
	want := "data: " + `{"x":1}` + "\n\n"
	if string(got) != want {
		t.Fatalf("cut framing: %q", string(got))
	}
	if strings.Contains(string(got), "[DONE]") {
		t.Fatalf("a cut must NOT synthesize [DONE]")
	}
}

func TestV1443_SSEBody_MidError(t *testing.T) {
	boom := fmt.Errorf("decrypt failed: bad record mac")
	s := &fakePMStream{results: []any{boom}}
	body := &pmSSEBody{stream: s}
	_, err := io.ReadAll(body)
	if err == nil || !strings.Contains(err.Error(), "bad record mac") {
		t.Fatalf("mid-stream error must surface: %v", err)
	}
}

// ── pmDoPostSSE ────────────────────────────────────────────────────

func TestV1443_PostSSE_UpstreamErrorBecomesSyntheticResponse(t *testing.T) {
	rerr := &privatemode.ResponseError{
		StatusCode: 429,
		Header:     http.Header{"X-Rate": []string{"1"}},
		Body:       []byte(`{"error":{"message":"rate limited"}}`),
	}
	tr := &fakePMTransport{clientResults: []any{&fakePMClient{streamResults: []any{rerr}}}}
	withPMTransport(t, tr)
	ch := make(chan ChatChunk, 8)
	resp, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if err != nil {
		t.Fatalf("upstream 429 must become the synthetic response, got err: %v", err)
	}
	if resp.StatusCode != 429 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "rate limited") {
		t.Fatalf("decrypted body lost: %s", string(b))
	}
}

func TestV1443_PostSSE_SecretGoneDropsAndRetriesOnce(t *testing.T) {
	gone := &privatemode.ResponseError{StatusCode: http.StatusNotFound, Body: []byte(`{"error":{"message":"no secret for ID"}}`)}
	ok := &fakePMStream{results: []any{[]byte(`{"ok":1}`)}}
	cli := &fakePMClient{streamResults: []any{gone, ok}}
	tr := &fakePMTransport{clientResults: []any{cli, cli}}
	withPMTransport(t, tr)
	ch := make(chan ChatChunk, 8)
	resp, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if err != nil || resp == nil {
		t.Fatalf("retry after drop must succeed: %v", err)
	}
	if tr.drops != 1 {
		t.Fatalf("DropSecret must fire exactly once, got %d", tr.drops)
	}
	if cli.streamCalls != 2 {
		t.Fatalf("exactly one retry, got %d stream calls", cli.streamCalls)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), `{"ok":1}`) {
		t.Fatalf("retry payload: %s", string(b))
	}
}

func TestV1443_PostSSE_DeploymentChangedIsTerminal(t *testing.T) {
	tr := &fakePMTransport{clientResults: []any{pmstate.ErrPMDeploymentChanged}}
	withPMTransport(t, tr)
	ch := make(chan ChatChunk, 8)
	_, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if !errors.Is(err, pmstate.ErrPMDeploymentChanged) {
		t.Fatalf("must surface the drift verdict, got: %v", err)
	}
	if isTransientNetErr(err) {
		t.Fatalf("the drift verdict must NEVER ride the net ladder")
	}
}

func TestV1443_PostSSE_NoKeyIsTerminal(t *testing.T) {
	tr := &fakePMTransport{clientResults: []any{pmstate.ErrNoKey}}
	withPMTransport(t, tr)
	ch := make(chan ChatChunk, 8)
	_, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if !errors.Is(err, pmstate.ErrNoKey) {
		t.Fatalf("must surface the no-key verdict, got: %v", err)
	}
}

func TestV1443_PostSSE_NetClassRidesLadder(t *testing.T) {
	tr := &fakePMTransport{clientResults: []any{fmt.Errorf(`doing attest request: doing request: Post "https://api.privatemode.ai/privatemode/v1/attest": dial tcp: lookup: connection refused`)}}
	withPMTransport(t, tr)
	ch := make(chan ChatChunk, 8)
	_, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if err == nil {
		t.Fatalf("net failure must error")
	}
	if !isTransientNetErr(err) {
		t.Fatalf("net-class PM failures must ride the pause ladder: %v", err)
	}
}

func TestV1443_PostSSE_UnwiredRefusesPlaintext(t *testing.T) {
	withPMTransport(t, nil)
	ch := make(chan ChatChunk, 8)
	_, err := pmDoPostSSE(context.Background(), pmTestReq(), []byte("{}"), ch)
	if err == nil || !strings.Contains(err.Error(), "not wired") {
		t.Fatalf("unwired PM must refuse honestly, never plaintext: %v", err)
	}
}

// ── pmCompleteSync ─────────────────────────────────────────────────

func TestV1443_CompleteSync_HappyPath(t *testing.T) {
	payload := []byte(`{"choices":[{"message":{"content":"sync ok","reasoning_content":""}}]}`)
	cli := &fakePMClient{chatResults: []any{payload}}
	withPMTransport(t, &fakePMTransport{clientResults: []any{cli}})
	got, err := pmCompleteSync(context.Background(), pmTestReq(), map[string]any{
		"model":    "glm-5.3-flash",
		"messages": []Message{{Role: "user", Content: "hi"}},
		"stream":   true,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if got != "sync ok" {
		t.Fatalf("content: %q", got)
	}
	if strings.Contains(string(cli.lastChatBod), `"stream":true`) {
		t.Fatalf("the wire must force stream:false, body: %s", string(cli.lastChatBod))
	}
	if !strings.Contains(string(cli.lastChatBod), `"stream":false`) {
		t.Fatalf("stream:false missing, body: %s", string(cli.lastChatBod))
	}
}

func TestV1443_CompleteSync_UpstreamErrorShape(t *testing.T) {
	rerr := &privatemode.ResponseError{StatusCode: 401, Body: []byte(`{"error":{"message":"invalid api key"}}`)}
	cli := &fakePMClient{chatResults: []any{rerr}}
	withPMTransport(t, &fakePMTransport{clientResults: []any{cli}})
	_, err := pmCompleteSync(context.Background(), pmTestReq(), map[string]any{"model": "m"})
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || !strings.Contains(err.Error(), "invalid api key") {
		t.Fatalf("upstream error shape: %v", err)
	}
}

// ── the dispatch seam ──────────────────────────────────────────────

func TestV1443_DoPostSSE_RoutesPM(t *testing.T) {
	ok := &fakePMStream{results: []any{[]byte(`{}`)}}
	cli := &fakePMClient{streamResults: []any{ok}}
	withPMTransport(t, &fakePMTransport{clientResults: []any{cli}})
	ch := make(chan ChatChunk, 8)
	resp, err := doPostSSE(context.Background(), pmTestReq(), "https://api.privatemode.ai/v1/chat/completions", []byte("{}"), ch)
	if err != nil || resp == nil {
		t.Fatalf("the seam must route PM through the wire: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if cli.streamCalls != 1 {
		t.Fatalf("the wire client must carry the request: %d", cli.streamCalls)
	}
	resp.Body.Close()
}
