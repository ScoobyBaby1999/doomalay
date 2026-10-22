package server

// v1.51.1 THE SECOND TONGUE — the adapter pins. A FAKE serve (httptest)
// speaking the LIVE-CAPTURED 2.x frame shapes drives the engine's own
// mapping (reasoning deltas → thinking, text deltas → assistant_delta, the
// tool pill events → the pill grammar, session.usage.updated → the
// v1.46.2 ledger shape, the execution terminals) + THE RECYCLE LAW (a
// free-tier wall drops the poisoned serve session and retries ONCE on a
// fresh one) + the opening-text law (the persona rides the MESSAGE TEXT —
// the 2.x PromptInput is text-only, so the law carries over verbatim) +
// the basic-auth law (every call speaks the Manager's serve password) +
// the per-turn model law (SelectModel fires before EVERY prompt).

import (
        "context"
        "encoding/base64"
        "encoding/json"
        "fmt"
        "io"
        "net/http"
        "net/http/httptest"
        "strconv"
        "strings"
        "sync"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// fakeServe speaks the captured 2.x shapes: /api/session → {"data":{"id"}},
// /api/session/{id}/model → 204, /api/session/{id}/prompt {"text"} → 200,
// /api/event SSE (auth-checked) — mode "clean" streams a normal turn, the
// wall answers the free-tier refusal (poisonedTries consecutive turns).
type fakeServe struct {
        mu            sync.Mutex
        sessionN      int
        lastSess      string // the most-recent session id (the wall frames must carry it)
        promptTexts   []string
        modelBodies   []map[string]any
        poisonedTries int      // how many consecutive turns answer the wall
        authTries     int      // how many consecutive turns answer provider.auth
        sse           []string // the clean-turn frames
        sawAuth       []string // every Authorization header seen
        modelCatalog  string   // v1.55.4: the /api/model payload when armed
        // v1.59.2 THE SERVE MEMORY: the fake's own durable session store —
        // POST /api/session registers, GET /api/session/{id} answers the
        // LIVE-PROBED shape (200 {data:{id}} / 404 SessionNotFoundError),
        // DELETE /api/session/{id} answers 204 (the live-probed 2.1.2 truth —
        // the legacy /session route 405s).
        sessions map[string]bool
        deletes  []string
        // v1.59.2 THE NO-HANG GUARD: the volatile-miss simulation + the durable
        // message record. volatileMiss=true → the prompt marks the session
        // instantly idle-FAILED (or idle-succeeded with an assistant text) in the
        // message record while the /api/event stream NEVER carries the terminal
        // (the 2.x volatile contract: events fired before the stream connects
        // are missed) — the old pump spun forever on this shape.
        volatileMiss bool
        volatileOK   bool
        messages     map[string][]map[string]any
        // v1.60 THE WIDE SHELF: every POSTed /move body (the per-chat binding
        // law) + the reject switch (the graceful-degradation pin).
        moveBodies []map[string]any
        moveReject bool
}

// v1592Msg appends a message record (oldest→newest) to a session.
func (f *fakeServe) v1592Msg(sess string, m map[string]any) {
        if f.messages == nil {
                f.messages = map[string][]map[string]any{}
        }
        f.messages[sess] = append(f.messages[sess], m)
}

func (f *fakeServe) handler(w http.ResponseWriter, r *http.Request) {
        f.mu.Lock()
        defer f.mu.Unlock()
        f.sawAuth = append(f.sawAuth, r.Header.Get("Authorization"))
        switch {
        case r.URL.Path == "/api/provider":
                io.WriteString(w, `{"location":{},"data":[]}`)
        case strings.HasSuffix(r.URL.Path, "/model") && r.Method == "POST":
                var body map[string]any
                b, _ := io.ReadAll(r.Body)
                json.Unmarshal(b, &body)
                f.modelBodies = append(f.modelBodies, body)
                w.WriteHeader(204)
        case strings.HasSuffix(r.URL.Path, "/prompt") && r.Method == "POST":
                var body map[string]any
                b, _ := io.ReadAll(r.Body)
                json.Unmarshal(b, &body)
                f.promptTexts = append(f.promptTexts, body["text"].(string))
                // v1.59.2: the volatile-miss shape — the turn ends INSTANTLY (the
                // durable record carries it) but the stream never does
                if f.volatileMiss || f.volatileOK {
                        var rec map[string]any
                        if f.volatileOK {
                                f.v1592Msg(f.lastSess, map[string]any{"type": "assistant", "text": "the off-wire answer", "time": map[string]any{"created": time.Now().UnixMilli()}})
                                rec = map[string]any{"type": "idle", "outcome": "succeeded", "time": map[string]any{"created": time.Now().UnixMilli()}}
                        } else {
                                rec = map[string]any{"type": "idle", "outcome": "failed", "time": map[string]any{"created": time.Now().UnixMilli()},
                                        "error": map[string]any{"type": "provider.no-route", "message": "No route for model"}}
                        }
                        f.v1592Msg(f.lastSess, rec)
                }
                io.WriteString(w, `{"data":{"id":"msg_u1","type":"user"}}`)
        case r.URL.Path == "/api/model":
                // v1.55.4 THE VARIANT LAW: the fake serves the serve's own catalogue
                // (limits/cost/variants) when armed; the manager's LiveCatalog pins
                // against it.
                if f.modelCatalog != "" {
                        io.WriteString(w, f.modelCatalog)
                } else {
                        w.WriteHeader(404)
                }
        case r.URL.Path == "/api/session" && r.Method == "POST":
                f.sessionN++
                f.lastSess = "ses_fake_" + strconv.Itoa(f.sessionN)
                if f.sessions == nil {
                        f.sessions = map[string]bool{}
                }
                f.sessions[f.lastSess] = true
                io.WriteString(w, `{"data":{"id":"`+f.lastSess+`"}}`)
        case strings.HasPrefix(r.URL.Path, "/api/session/") && r.Method == "GET":
                // v1.59.2: the adoption check — the live-probed 2.1.2 shape
                id := strings.TrimPrefix(r.URL.Path, "/api/session/")
                if strings.Contains(id, "/message") {
                        // the durable message record (newest-first, ?limit honored)
                        sid := strings.TrimSuffix(id, "/message")
                        recs := f.messages[sid]
                        out := make([]map[string]any, 0, len(recs))
                        for i := len(recs) - 1; i >= 0; i-- {
                                out = append(out, recs[i])
                        }
                        if l := r.URL.Query().Get("limit"); l != "" {
                                if n2, err2 := strconv.Atoi(l); err2 == nil && n2 < len(out) {
                                        out = out[:n2]
                                }
                        }
                        b, _ := json.Marshal(map[string]any{"data": out})
                        w.Write(b)
                        return
                }
                if f.sessions != nil && f.sessions[id] {
                        io.WriteString(w, `{"data":{"id":"`+id+`"}}`)
                } else {
                        w.WriteHeader(404)
                        io.WriteString(w, `{"_tag":"SessionNotFoundError","sessionID":"`+id+`","message":"Session not found: `+id+`"}`)
                }
        case strings.HasPrefix(r.URL.Path, "/api/session/") && r.Method == "DELETE":
                // v1.59.2: the best-effort serve-side cleanup — 204, the session gone
                id := strings.TrimPrefix(r.URL.Path, "/api/session/")
                delete(f.sessions, id)
                f.deletes = append(f.deletes, id)
                w.WriteHeader(204)
        case strings.HasSuffix(r.URL.Path, "/move") && r.Method == "POST":
                // v1.60 THE WIDE SHELF: the per-chat binding's move route
                var body map[string]any
                b, _ := io.ReadAll(r.Body)
                json.Unmarshal(b, &body)
                f.moveBodies = append(f.moveBodies, body)
                if f.moveReject {
                        w.WriteHeader(404)
                        return
                }
                io.WriteString(w, `{}`)
        case r.URL.Path == "/api/event":
                w.Header().Set("Content-Type", "text/event-stream")
                if f.volatileMiss || f.volatileOK {
                        // the terminal never lands on the wire (the 2.x volatile
                        // contract — the turn ended before this stream connected);
                        // the stream itself stays OPEN like the real serve — the
                        // headers FLUSH so the client's connect truly lands, then
                        // the handler rides out its connection (heartbeats only)
                        if fl, okFlush := w.(http.Flusher); okFlush {
                                fl.Flush()
                        }
                        f.mu.Unlock()
                        <-r.Context().Done()
                        f.mu.Lock()
                        return
                }
                if f.poisonedTries > 0 {
                        f.poisonedTries--
                        io.WriteString(w, `data: {"id":"w1","type":"session.execution.failed","data":{"sessionID":"`+f.lastSess+`","error":{"type":"provider.error","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai","status":403}}}`+"\n\n")
                        return
                }
                if f.authTries > 0 {
                        f.authTries--
                        io.WriteString(w, `data: {"id":"w1","type":"session.execution.failed","data":{"sessionID":"`+f.lastSess+`","error":{"type":"provider.auth","message":"Reconnect OpenCode Console to continue.","status":401}}}`+"\n\n")
                        return
                }
                io.WriteString(w, strings.Join(f.sse, "\n\n")+"\n\n")
        default:
                w.WriteHeader(404)
        }
}

func cleanTurnFrames(sess string) []string {
        return []string{
                `data: {"id":"e0","type":"server.connected","data":{}}`,
                `data: {"id":"e1","type":"session.reasoning.delta","data":{"sessionID":"` + sess + `","assistantMessageID":"msg_a1","delta":"thinking hard"}}`,
                `data: {"id":"e2","type":"session.text.delta","data":{"sessionID":"` + sess + `","assistantMessageID":"msg_a1","delta":"the answer"}}`,
                `data: {"id":"e3","type":"session.tool.input.started","data":{"sessionID":"` + sess + `","id":"call_g1","name":"glob"}}`,
                `data: {"id":"e4","type":"session.tool.input.ended","data":{"sessionID":"` + sess + `","id":"call_g1","text":"{\"pattern\":\"*\"}"}}`,
                `data: {"id":"e5","type":"session.tool.success","data":{"sessionID":"` + sess + `","id":"call_g1","content":[{"type":"text","text":"one file"}]}}`,
                `data: {"id":"e6","type":"session.step.ended","data":{"sessionID":"` + sess + `","finish":"stop","cost":0,"tokens":{"input":80,"output":30,"reasoning":10}}}`,
                `data: {"id":"e7","type":"session.usage.updated","data":{"sessionID":"` + sess + `","cost":0,"tokens":{"input":80,"output":30,"reasoning":10,"cache":{"read":256,"write":0}}}}`,
                `data: {"id":"e8","type":"session.execution.succeeded","data":{"sessionID":"` + sess + `"}}`,
        }
}

// TestOcServeEventMapping drives the adapter against the fake serve and
// pins the engine-vocabulary mapping: reasoning→thinking, text→assistant_delta,
// tool input→tool_use (with the serialized args), tool success→tool_result,
// the usage rides the terminal in the v1.46.2 ledger shape — plus the
// per-turn model law and basic auth on every call.
func TestOcServeEventMapping(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{sse: nil}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)

        s := &Server{}
        // pre-seed the serve session so the turn skips the opening text
        s.ocServeSessions = map[string]string{"chat1": "ses_fake_pre"}

        events := make(chan map[string]any, 64)
        done := make(chan struct{})
        var got []map[string]any
        go func() {
                for ev := range events {
                        got = append(got, ev)
                }
                close(done)
        }()
        fake.mu.Lock()
        fake.sse = cleanTurnFrames("ses_fake_pre")
        fake.mu.Unlock()
        // StreamEvents needs the CURRENT /api/event frames; the fake serves them
        // fresh per connection, so run the pump directly
        recycled, err := s.ocServePump(context.Background(), m, "ses_fake_pre", "chat1", "opencode/big-pickle", events, time.Now().UnixMilli())
        close(events)
        <-done
        if err != nil {
                t.Fatalf("pump: %v", err)
        }
        if recycled {
                t.Fatalf("a clean turn must not trigger the recycle")
        }
        var kinds []string
        var usage map[string]any
        for _, ev := range got {
                kinds = append(kinds, ev["type"].(string))
                if ev["type"] == "status" {
                        usage, _ = ev["usage"].(map[string]any)
                }
        }
        want := []string{"thinking", "assistant_delta", "tool_use", "tool_result", "status"}
        if strings.Join(kinds, ",") != strings.Join(want, ",") {
                t.Fatalf("mapping wrong: got %v want %v", kinds, want)
        }
        if got[0]["text"] != "thinking hard" || got[1]["text"] != "the answer" {
                t.Fatalf("delta texts wrong: %v %v", got[0]["text"], got[1]["text"])
        }
        // v1.58.1 THE INFORMATIVE PILL: the name is BARE (the PWA titles the
        // pill with it — no "opencode:" prefix) + the summary is DERIVED
        // from the args (glob's pattern — never a static "running").
        if got[2]["name"] != "glob" || got[3]["name"] != "glob" {
                t.Fatalf("tool names wrong: %v %v", got[2]["name"], got[3]["name"])
        }
        if got[2]["summary"] != "*" {
                t.Fatalf("the summary must be the derived operand (glob's pattern): %v", got[2]["summary"])
        }
        if got[2]["args"] != `{"pattern":"*"}` {
                t.Fatalf("the tool args must ride input.ended's serialized text: %v", got[2]["args"])
        }
        if usage == nil || fmt.Sprint(usage["total_tokens"]) != "120" || fmt.Sprint(usage["reasoning_tokens"]) != "10" {
                t.Fatalf("usage ledger shape wrong: %v", usage)
        }
        if fmt.Sprint(usage["cache_read"]) != "256" || fmt.Sprint(usage["cost"]) != "0" {
                t.Fatalf("the 2.x ledger carries cache + cost: %v", usage)
        }
        if usage["finish_reason"] != "stop" {
                t.Fatalf("the finish must ride the terminal: %v", usage["finish_reason"])
        }
        if got[2]["tool_use_id"] != got[3]["tool_use_id"] || got[2]["tool_use_id"] != "call_g1" {
                t.Fatalf("the tool pair must share the call id: %v %v", got[2]["tool_use_id"], got[3]["tool_use_id"])
        }
}

// TestOcServeTurnShapeAndModelLaw drives a FULL turn through
// ocServeStreamTurn: the per-turn model law (SelectModel fires with the
// {model:{id,providerID}} body before EVERY prompt), the text-only prompt,
// and basic auth with the Manager's password on every request.
func TestOcServeTurnShapeAndModelLaw(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)

        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "opencode/big-pickle"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        fake.mu.Lock()
        fake.sse = cleanTurnFrames("ses_fake_1")
        fake.mu.Unlock()
        events := make(chan map[string]any, 64)
        collect := make(chan []map[string]any, 1)
        go func() {
                var got []map[string]any
                for ev := range events {
                        got = append(got, ev)
                }
                collect <- got
        }()
        if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello", events); err != nil {
                t.Fatalf("stream turn: %v", err)
        }
        close(events)
        <-collect
        fake.mu.Lock()
        models := append([]map[string]any(nil), fake.modelBodies...)
        auths := append([]string(nil), fake.sawAuth...)
        fake.mu.Unlock()
        if len(models) != 1 {
                t.Fatalf("the per-turn model law: SelectModel must fire before the prompt, got %d", len(models))
        }
        mod, _ := models[0]["model"].(map[string]any)
        if mod == nil || mod["id"] != "big-pickle" || mod["providerID"] != "opencode" {
                t.Fatalf("the model block must be {id, providerID}: %v", models[0])
        }
        for _, a := range auths {
                if a != "Basic "+basicAuthFor("opencode", "rig-pw") {
                        t.Fatalf("every client call must speak the serve password: %q", a)
                }
        }
}

// TestOcServeRecycleLaw pins THE RECYCLE LAW: a walled first attempt drops
// the poisoned serve session; the SECOND attempt opens a FRESH one whose
// prompt text carries the opening block (persona + history — the message
// text, never a system field). A second wall answers with the honest
// error + terminal — never a silent hang.
func TestOcServeRecycleLaw(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)

        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40, Personas: ""}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        db.AppendEvent("chat1", "user", "earlier turn", "")
        db.AppendEvent("chat1", "assistant", "earlier reply", "")

        fake.mu.Lock()
        fake.sse = cleanTurnFrames("ses_fake_2")
        fake.poisonedTries = 1 // wall once, clean after
        fake.mu.Unlock()

        events := make(chan map[string]any, 64)
        collect := make(chan []map[string]any, 1)
        go func() {
                var got []map[string]any
                for ev := range events {
                        got = append(got, ev)
                }
                collect <- got
        }()
        err = s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello now", events)
        close(events)
        got := <-collect
        if err != nil {
                t.Fatalf("stream turn: %v", err)
        }
        // TWO prompts fired: the first (walled) on ses_fake_1, the retry on
        // the FRESH ses_fake_2 — and the retry's text is the OPENING text
        // (persona + the replayed history + the message; the in-flight text
        // exactly once — v1.48.1's trim law rides the bridge too)
        fake.mu.Lock()
        texts := append([]string(nil), fake.promptTexts...)
        fake.mu.Unlock()
        if len(texts) != 2 {
                t.Fatalf("the recycle must fire exactly two prompts, got %d", len(texts))
        }
        if !strings.Contains(texts[1], "hello now") {
                t.Fatalf("the retry carries the message: %q", texts[1])
        }
        if strings.Count(texts[1], "hello now") != 1 {
                t.Fatalf("v1.48.1's law: the in-flight message rides the replay EXACTLY ONCE, got %d", strings.Count(texts[1], "hello now"))
        }
        if !strings.Contains(texts[1], "earlier turn") {
                t.Fatalf("the replayed history must ride the opening text")
        }
        // the terminal landed (idle from the clean retry)
        var sawIdle bool
        for _, ev := range got {
                if ev["type"] == "status" && ev["state"] == "idle" {
                        sawIdle = true
                }
        }
        if !sawIdle {
                t.Fatalf("the clean retry must end with the idle terminal")
        }
}

// TestOcServeRecycleGivesHonestTerminal pins the second-wall branch: the
// bridge answers with its OWN error + terminal — never a silent hang and
// never a fallthrough to the walled 403 (which would double-error).
func TestOcServeRecycleGivesHonestTerminal(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        fake.mu.Lock()
        fake.poisonedTries = 99 // wall every attempt
        fake.mu.Unlock()
        events := make(chan map[string]any, 64)
        collect := make(chan []map[string]any, 1)
        go func() {
                var got []map[string]any
                for ev := range events {
                        got = append(got, ev)
                }
                collect <- got
        }()
        if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello", events); err != nil {
                t.Fatalf("stream turn: %v", err)
        }
        close(events)
        got := <-collect
        var sawErr, sawTerminal bool
        for _, ev := range got {
                if ev["type"] == "error" && strings.Contains(fmt.Sprint(ev["message"]), "refused this turn twice") {
                        sawErr = true
                }
                if ev["type"] == "status" && ev["state"] == "error" {
                        sawTerminal = true
                }
        }
        if !sawErr || !sawTerminal {
                t.Fatalf("the second wall needs the honest error + terminal: err=%v terminal=%v", sawErr, sawTerminal)
        }
}

// TestOcServeAuthErrorIsHonest pins the provider.auth branch: a 401 from
// the serve answers the honest key-error copy + terminal — never the
// recycle (a bad key is not a gate refusal) and never a silent hang.
func TestOcServeAuthErrorIsHonest(t *testing.T) {
        t.Setenv("DOOMALAY_OPENCODE_SERVE_PASSWORD", "rig-pw")
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New("", "key", nil)
        m.SetBaseURL(srv.URL)
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle"}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        fake.mu.Lock()
        fake.authTries = 99 // 401 every attempt
        fake.mu.Unlock()
        events := make(chan map[string]any, 64)
        collect := make(chan []map[string]any, 1)
        go func() {
                var got []map[string]any
                for ev := range events {
                        got = append(got, ev)
                }
                collect <- got
        }()
        if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello", events); err != nil {
                t.Fatalf("stream turn: %v", err)
        }
        close(events)
        got := <-collect
        var sawAuth, sawTerminal bool
        prompts := 0
        fake.mu.Lock()
        prompts = len(fake.promptTexts)
        fake.mu.Unlock()
        for _, ev := range got {
                if ev["type"] == "error" {
                        if fmt.Sprint(ev["error"]) == "oc_bridge_auth" && strings.Contains(fmt.Sprint(ev["message"]), "rejected the bridge key") {
                                sawAuth = true
                        }
                }
                if ev["type"] == "status" && ev["state"] == "error" {
                        sawTerminal = true
                }
        }
        if !sawAuth || !sawTerminal {
                t.Fatalf("the 401 must answer the honest key error + terminal: auth=%v terminal=%v", sawAuth, sawTerminal)
        }
        if prompts != 1 {
                t.Fatalf("an auth failure answers ONCE with the honest error (a fresh session can't fix a bad key — got %d prompts)", prompts)
        }
}

// TestOcServeOpeningTextTrimLaw pins the opening composer against the
// v1.48.1 echo law: the persisted in-flight message is ALREADY in the
// compacted history (the emit runs before dispatch) — the composer trims
// it and appends exactly once.
func TestOcServeOpeningTextTrimLaw(t *testing.T) {
        dir := t.TempDir()
        db, err := store.Open(dir)
        if err != nil {
                t.Fatalf("store: %v", err)
        }
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        sess := &store.Session{ID: "chat1", Title: "t", Provider: "opencode", Model: "big-pickle", SlidingWindow: 40}
        if err := db.CreateSession(sess); err != nil {
                t.Fatalf("create: %v", err)
        }
        db.AppendEvent("chat1", "user", "first question", "")
        db.AppendEvent("chat1", "assistant", "first answer", "")
        // the in-flight emit (the turn persisted it before dispatch)
        db.AppendEvent("chat1", "user", "the new message", "")
        text := s.ocServeOpeningText(sess, "the new message", false)
        if n := strings.Count(text, "the new message"); n != 1 {
                t.Fatalf("the in-flight message must ride the opening text EXACTLY ONCE (v1.48.1's law), got %d", n)
        }
        if !strings.Contains(text, "first question") || !strings.Contains(text, "first answer") {
                t.Fatalf("the replayed history must ride the opening text")
        }
}

// TestIsOpenCodeFreeModelSlot pins the dispatch gate's LIVE law (v1.55.4:
// the old big-pickle + *-free literals with hand-carved exceptions are
// DEAD — the registry's cost-0/0 data decides). The seed carries the same
// verdicts the literals encoded: the LAW changed, not the answers.
func TestIsOpenCodeFreeModelSlot(t *testing.T) {
        seed := `{"opencode":{"name":"OpenCode","models":{
                "big-pickle":{"name":"Big Pickle","cost":{"input":0,"output":0}},
                "glm-5.3-flash-free":{"name":"GLM Flash Free","cost":{"input":0,"output":0}},
                "minimax-m3.1-flash-free":{"name":"MiniMax M3.1 Flash Free","cost":{"input":0,"output":0}},
                "minimax-m3-free":{"name":"MiniMax M3 Free","cost":{"input":0.3,"output":1.2}},
                "qwen3.6-plus-free":{"name":"Qwen Plus Free","cost":{"input":0.4,"output":1.4}},
                "glm-5.3":{"name":"GLM 5.3","cost":{"input":1.4,"output":4.4}}
        }}}`
        if err := llm.SetModelsDevForTest([]byte(seed)); err != nil {
                t.Fatalf("seed: %v", err)
        }
        defer llm.ClearModelsDevForTest()
        cases := map[string]bool{
                "big-pickle":              true,
                "opencode/big-pickle":     true,
                "glm-5.3-flash-free":      true,
                "minimax-m3.1-flash-free": true,
                "minimax-m3-free":         false, // paid despite the -free name (the registry's price)
                "qwen3.6-plus-free":       false, // paid despite the -free name (the registry's price)
                "glm-5.3":                 false, // paid
                "":                        false,
                "totally-unknown-model":   false, // honest false (no static fallback)
        }
        for slot, want := range cases {
                if got := llm.IsOpenCodeFreeModelSlot(slot); got != want {
                        t.Fatalf("IsOpenCodeFreeModelSlot(%q) = %v, want %v", slot, got, want)
                }
        }
}

// basicAuthFor mirrors the client's own header builder (the pin asserts
// byte-equality against it — no drift between the fake and the law).
func basicAuthFor(user, password string) string {
        return base64Std(user + ":" + password)
}

// base64Std is the test's own base64 (mirrors the client's encoding — the
// import stays local so the pin never drifts on a package reshuffle).
func base64Std(s string) string {
        return base64.StdEncoding.EncodeToString([]byte(s))
}
