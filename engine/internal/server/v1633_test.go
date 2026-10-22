package server

// v1633_test.go — v1.63.3 THE UNLOST TAIL pins (PLAN-V163 §3).
//
// THE CONVICTION (the user's words): "long chats get preserved malformed,
// with messages unordered, the bottom chunk of tools and reasoning calls
// after the final response doesn't save and gets lost. Also opening a
// chat still points us at the top not the bottom… Opening the chat for a
// user should load bottom up not top down. The most recent chats are
// what's important, older messages can stay dormant until scrolled to."
//
// THE LAWS PINNED HERE:
//
//   (a) THE SERVE TRUTH RECONCILE — a healed-terminal log + a living
//       binding + the serve's COMPLETED turn → the dangling window is
//       REPLACED by the serve's whole turn (reasoning → thinking rows,
//       tool parts → tool_use/tool_result pill pairs, text → assistant
//       rows, the idle marker → the honest terminal); the user row
//       survives untouched; seqs stay monotonic; the splice is
//       idempotent (a real terminal never re-arms);
//   (b) THE HONEST DEGRADATION — a serve that never got the turn (its
//       last user message is OLDER than the engine's), a still-running
//       turn (no idle marker), a dead binding → NO splice, the healed
//       log stands;
//   (c) THE MAPPING SHAPES — the persisted payloads are byte-shaped like
//       the live pump's (tool_use {name,summary,args,tool_use_id},
//       tool_result {name,text,tool_use_id}, the failed outcome carries
//       the honest error + terminal, an unknown part type degrades to a
//       notice — never a silent drop);
//   (d) THE TAIL/PAGE API — ?tail=N answers the newest N + older flag;
//       ?before=SEQ&n=N answers one older page; the plain GET unchanged;
//   (e) THE RETENTION BUDGET — a session past the budget loses its
//       OLDEST rows (the newest window survives whole); a pending turn's
//       session is NEVER trimmed.

import (
        "encoding/json"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v1633HealedChat seeds the engine-death shape: a user row, a partial
// turn (one delta + one dangling tool_use), the boot heal's synthesized
// never-ran result, and the healed terminal as the LAST event.
func v1633HealedChat(t *testing.T, db *store.DB, chatID string) {
        t.Helper()
        if err := db.CreateSession(&store.Session{ID: chatID, Title: "the lost tail", Provider: "opencode", Model: "opencode/mimo-v2.6-flash-free"}); err != nil {
                t.Fatalf("create session: %v", err)
        }
        if _, err := db.AppendEvent(chatID, "user", "what does notes.txt say?", ""); err != nil {
                t.Fatalf("seed user: %v", err)
        }
        if _, err := db.AppendEvent(chatID, "assistant_delta", "Let me check the fil", ""); err != nil {
                t.Fatalf("seed delta: %v", err)
        }
        if _, err := db.AppendEvent(chatID, "tool_use", `{"name":"read","summary":"read | notes.txt","args":"{\"path\":\"notes.txt\"}","tool_use_id":"call_dead"}`, "call_dead"); err != nil {
                t.Fatalf("seed tool_use: %v", err)
        }
        if _, err := db.AppendEvent(chatID, "tool_result", `{"name":"read","text":"OBSERVATION:\ninterrupted by engine restart — this call never ran; re-issue it if still needed.","tool_use_id":"call_dead"}`, "call_dead"); err != nil {
                t.Fatalf("seed never-ran: %v", err)
        }
        if _, err := db.AppendEvent(chatID, "status", `{"state":"error","healed":true,"message":"interrupted by engine restart","hint":"continue"}`, ""); err != nil {
                t.Fatalf("seed healed terminal: %v", err)
        }
}

// v1633ServeTurn seeds the fake serve's COMPLETED turn for a session (the
// live-captured 2.1.2 shapes): a user prompt, an assistant message with
// reasoning + a completed tool call + text, and the idle marker.
func v1633ServeTurn(fake *fakeServe, serveSess, promptText string, atMs int64) {
        fake.v1592Msg(serveSess, map[string]any{"type": "user", "text": promptText, "time": map[string]any{"created": atMs}})
        fake.v1592Msg(serveSess, map[string]any{
                "type": "assistant",
                "time": map[string]any{"created": atMs + 500, "completed": atMs + 9000},
                "model": map[string]any{"id": "mimo-v2.6-flash-free", "providerID": "opencode", "variant": "default"},
                "content": []map[string]any{
                        {"type": "reasoning", "text": "Read notes.txt first.", "time": map[string]any{"created": atMs + 600}},
                        {"type": "tool", "id": "call_7b24", "name": "read", "state": map[string]any{
                                "status": "completed",
                                "input":  map[string]any{"path": "ws/notes.txt"},
                                "content": []map[string]any{
                                        {"type": "text", "text": "Read file ws/notes.txt, lines 1-1\n1: hello from the shape probe"},
                                },
                                "metadata": map[string]any{"truncated": false},
                        }, "time": map[string]any{"created": atMs + 700, "completed": atMs + 4000}},
                        {"type": "text", "text": "The file says: hello from the shape probe"},
                },
                "finish": "stop",
                "tokens": map[string]any{"input": 652, "output": 26, "reasoning": 5, "cache": map[string]any{"read": 4096, "write": 0}},
                "cost":   0,
        })
        fake.v1592Msg(serveSess, map[string]any{"type": "idle", "outcome": "succeeded", "time": map[string]any{"created": atMs + 9500}})
}

func TestV1633_ServeTruthReconcile(t *testing.T) {
        dataDir := t.TempDir()
        db, err := store.Open(dataDir)
        if err != nil {
                t.Fatalf("open db: %v", err)
        }
        defer db.Close()
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }

        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New(dataDir, "key", nil)
        m.SetBaseURL(srv.URL)

        chatID := "chat_recon_1"
        v1633HealedChat(t, db, chatID)

        // the binding + the serve's completed turn (the prompt rides AFTER the
        // engine's user row — the 5s grace window's shape)
        if err := db.SetSetting(ocServeBindKey(chatID), "ses_recon"); err != nil {
                t.Fatalf("binding: %v", err)
        }
        fake.mu.Lock()
        if fake.sessions == nil {
                fake.sessions = map[string]bool{}
        }
        fake.sessions["ses_recon"] = true
        fake.mu.Unlock()
        userAt := time.Now().UnixMilli()
        v1633ServeTurn(fake, "ses_recon", "what does notes.txt say?", userAt-500)

        s := &Server{db: db}
        s.ocServeMu.Lock()
        s.ocServe = m
        s.ocServeMu.Unlock()

        if !s.ocServeReconcileIfHealed(chatID, m) {
                t.Fatalf("the reconcile must run: the healed terminal is the last event, the binding lives, the serve completed the turn")
        }

        events, err := db.ListEvents(chatID, 0)
        if err != nil {
                t.Fatalf("list: %v", err)
        }
        var kinds []string
        for _, ev := range events {
                kinds = append(kinds, ev.EventType)
        }
        // the whole-truth order: user (intact) → thinking → tool_use →
        // tool_result → assistant → the real terminal. The healed terminal,
        // the partial delta, and the never-ran lie are ALL gone.
        want := []string{"user", "thinking", "tool_use", "tool_result", "assistant", "status"}
        if strings.Join(kinds, ",") != strings.Join(want, ",") {
                t.Fatalf("the spliced grammar:\n got %v\nwant %v", kinds, want)
        }
        if events[0].Seq != 1 {
                t.Fatalf("the user row must survive at seq 1 (got seq %d)", events[0].Seq)
        }
        for i := 1; i < len(events); i++ {
                if events[i].Seq != events[i-1].Seq+1 {
                        t.Fatalf("seqs must stay monotonic after the splice (row %d: %d after %d)", i, events[i].Seq, events[i-1].Seq)
                }
        }
        // the pill pair: the bare name + the args + the tool_use_id (the live
        // pump's persisted shape)
        var tu struct {
                Name      string `json:"name"`
                Args      string `json:"args"`
                ToolUseID string `json:"tool_use_id"`
        }
        if err := json.Unmarshal([]byte(events[2].Content), &tu); err != nil {
                t.Fatalf("tool_use payload: %v", err)
        }
        if tu.Name != "read" || tu.ToolUseID != "call_7b24" || !strings.Contains(tu.Args, "notes.txt") {
                t.Fatalf("tool_use payload shape: %+v", tu)
        }
        var tr struct {
                Name string `json:"name"`
                Text string `json:"text"`
        }
        if err := json.Unmarshal([]byte(events[3].Content), &tr); err != nil {
                t.Fatalf("tool_result payload: %v", err)
        }
        if tr.Name != "read" || !strings.Contains(tr.Text, "hello from the shape probe") {
                t.Fatalf("tool_result payload shape: %+v", tr)
        }
        if events[4].Content != "The file says: hello from the shape probe" {
                t.Fatalf("the assistant row must carry the text part whole: %q", events[4].Content)
        }
        var st struct {
                State  string `json:"state"`
                Usage  struct {
                        InputTokens  int64 `json:"input_tokens"`
                        TotalTokens  int64 `json:"total_tokens"`
                        CacheRead    int64 `json:"cache_read"`
                        FinishReason string `json:"finish_reason"`
                } `json:"usage"`
        }
        if err := json.Unmarshal([]byte(events[5].Content), &st); err != nil {
                t.Fatalf("terminal payload: %v", err)
        }
        if st.State != "idle" || st.Usage.InputTokens != 652 || st.Usage.FinishReason != "stop" || st.Usage.CacheRead != 4096 {
                t.Fatalf("the honest idle terminal with the serve's own usage: %+v", st)
        }

        // IDEMPOTENCE: a spliced log ends in a REAL terminal — the trigger dies
        if s.ocServeReconcileIfHealed(chatID, m) {
                t.Fatalf("a reconciled log must never re-splice")
        }
}

func TestV1633_ReconcileDegrades(t *testing.T) {
        dataDir := t.TempDir()
        db, err := store.Open(dataDir)
        if err != nil {
                t.Fatalf("open db: %v", err)
        }
        defer db.Close()
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        fake := &fakeServe{}
        srv := httptest.NewServer(http.HandlerFunc(fake.handler))
        defer srv.Close()
        m := ocserve.New(dataDir, "key", nil)
        m.SetBaseURL(srv.URL)
        s := &Server{db: db}
        s.ocServeMu.Lock()
        s.ocServe = m
        s.ocServeMu.Unlock()

        // (1) the serve never got the turn — its last user message is OLDER
        // than the engine's user row (the engine died before the prompt)
        chatID := "chat_nver"
        v1633HealedChat(t, db, chatID)
        if err := db.SetSetting(ocServeBindKey(chatID), "ses_old_turn"); err != nil {
                t.Fatalf("binding: %v", err)
        }
        fake.mu.Lock()
        if fake.sessions == nil {
                fake.sessions = map[string]bool{}
        }
        fake.sessions["ses_old_turn"] = true
        fake.mu.Unlock()
        v1633ServeTurn(fake, "ses_old_turn", "an OLDER turn's prompt", time.Now().Add(-time.Hour).UnixMilli())
        if s.ocServeReconcileIfHealed(chatID, m) {
                t.Fatalf("a serve that never got THIS turn must not splice")
        }
        evs, _ := db.ListEvents(chatID, 0)
        if evs[len(evs)-1].EventType != "status" || !strings.Contains(evs[len(evs)-1].Content, "interrupted by engine restart") {
                t.Fatalf("the healed log must stand untouched")
        }

        // (2) the serve is STILL RUNNING the turn (no idle marker) — the next
        // open retries
        chatID2 := "chat_running"
        v1633HealedChat(t, db, chatID2)
        if err := db.SetSetting(ocServeBindKey(chatID2), "ses_live"); err != nil {
                t.Fatalf("binding: %v", err)
        }
        at := time.Now().UnixMilli()
        fake.mu.Lock()
        fake.sessions["ses_live"] = true
        fake.v1592Msg("ses_live", map[string]any{"type": "user", "text": "what does notes.txt say?", "time": map[string]any{"created": at - 100}})
        fake.v1592Msg("ses_live", map[string]any{"type": "assistant", "time": map[string]any{"created": at - 50},
                "content": []map[string]any{{"type": "text", "text": "partial…"}}})
        fake.mu.Unlock()
        if s.ocServeReconcileIfHealed(chatID2, m) {
                t.Fatalf("a still-running turn must not splice (the next open retries)")
        }

        // (3) no binding at all → no splice
        chatID3 := "chat_unbound"
        v1633HealedChat(t, db, chatID3)
        if s.ocServeReconcileIfHealed(chatID3, m) {
                t.Fatalf("a binding-less chat must not splice")
        }
}

func TestV1633_MapTurnShapes(t *testing.T) {
        // the FAILED outcome: the honest error row (with the sentinel's 429
        // marker) + the error terminal — never an empty success
        failed := []ocserve.ServeMessage{
                {Type: "idle", Outcome: "failed", Time: struct {
                        Created   int64 `json:"created"`
                        Streaming int64 `json:"streamed"`
                        Completed int64 `json:"completed"`
                }{Created: 100},
                        Error: &struct {
                                Type    string `json:"type"`
                                Message string `json:"message"`
                                Status  int    `json:"status"`
                        }{Type: "provider.free-limit", Message: "Free usage limit reached", Status: 429}},
        }
        rows := ocServeMapTurn(failed)
        if len(rows) != 2 || rows[0].EventType != "error" || rows[1].EventType != "status" {
                t.Fatalf("the failed outcome maps to error+terminal (got %d rows)", len(rows))
        }
        if !strings.Contains(rows[0].Content, "retry_class") || !strings.Contains(rows[0].Content, "Free usage limit") {
                t.Fatalf("the 429 sentinel shape rides the error row: %s", rows[0].Content)
        }
        if !strings.Contains(rows[1].Content, `"state":"error"`) {
                t.Fatalf("the terminal is an honest error: %s", rows[1].Content)
        }

        // the unknown part type degrades to a notice — never a silent drop
        odd := []ocserve.ServeMessage{{
                Type: "assistant",
                Content: []ocserve.ServeContentPart{
                        {Type: "hologram", Text: "???"},
                },
        }}
        rows = ocServeMapTurn(odd)
        if len(rows) != 1 || rows[0].EventType != "notice" || !strings.Contains(rows[0].Content, "hologram") {
                t.Fatalf("an unknown part degrades to an honest notice (got %+v)", rows)
        }

        // the doomalay family strips its prefix (the pill grammar's bare name)
        fam := []ocserve.ServeMessage{{
                Type: "assistant",
                Content: []ocserve.ServeContentPart{{
                        Type: "tool", ID: "call_c1", Name: "doomalay_calculator",
                        State: &struct {
                                Status   string          `json:"status"`
                                Input    json.RawMessage `json:"input"`
                                Content  []struct {
                                        Type string `json:"type"`
                                        Text string `json:"text"`
                                } `json:"content"`
                                Metadata *struct {
                                        Truncated *bool `json:"truncated"`
                                } `json:"metadata"`
                                Error *struct {
                                        Type    string `json:"type"`
                                        Message string `json:"message"`
                                } `json:"error"`
                        }{Status: "completed", Input: json.RawMessage(`{"expression":"17*23"}`),
                                Content: []struct {
                                        Type string `json:"type"`
                                        Text string `json:"text"`
                                }{{Type: "text", Text: "391"}}},
                }},
        }}
        rows = ocServeMapTurn(fam)
        if len(rows) != 2 {
                t.Fatalf("the tool part maps to use+result (got %d rows)", len(rows))
        }
        if !strings.Contains(rows[0].Content, `"name":"calculator"`) {
                t.Fatalf("the doomalay_ prefix strips for the pill: %s", rows[0].Content)
        }
        if !strings.Contains(rows[0].Content, "17*23") {
                t.Fatalf("the summary derives from the args: %s", rows[0].Content)
        }
}

func TestV1633_TailAndBeforePages(t *testing.T) {
        db, err := store.Open(t.TempDir())
        if err != nil {
                t.Fatalf("open db: %v", err)
        }
        defer db.Close()
        if err := db.Migrate(); err != nil {
                t.Fatalf("migrate: %v", err)
        }
        s := &Server{db: db}
        chatID := "chat_pages"
        if err := db.CreateSession(&store.Session{ID: chatID, Title: "pages"}); err != nil {
                t.Fatalf("create: %v", err)
        }
        for i := 0; i < 120; i++ {
                if _, err := db.AppendEvent(chatID, "user", "m"+strings.Repeat("x", i+1), ""); err != nil {
                        t.Fatalf("seed: %v", err)
                }
        }

        // ?tail=50 → the newest 50 + older=true
        evs, older, err := db.ListEventsTailN(chatID, 50)
        if err != nil || len(evs) != 50 || !older {
                t.Fatalf("tail 50: len=%d older=%v err=%v", len(evs), older, err)
        }
        if evs[0].Seq != 71 || evs[49].Seq != 120 {
                t.Fatalf("tail window bounds: [%d..%d], want [71..120]", evs[0].Seq, evs[49].Seq)
        }

        // ?before=71&n=30 → the next older page (41..70) + older=true
        page, older2, err := db.ListEventsBefore(chatID, 71, 30)
        if err != nil || len(page) != 30 || !older2 {
                t.Fatalf("before page: len=%d older=%v err=%v", len(page), older2, err)
        }
        if page[0].Seq != 41 || page[29].Seq != 70 {
                t.Fatalf("page bounds: [%d..%d], want [41..70]", page[0].Seq, page[29].Seq)
        }

        // the last page: before=1 → nothing; before=41 with n=100 → 1..40 + older=false
        if evs2, older3, _ := db.ListEventsBefore(chatID, 1, 30); len(evs2) != 0 || older3 {
                t.Fatalf("before=1 must answer empty (got %d rows)", len(evs2))
        }
        last, older4, _ := db.ListEventsBefore(chatID, 41, 100)
        if len(last) != 40 || older4 {
                t.Fatalf("the head page: len=%d older=%v (want 40, false)", len(last), older4)
        }

        // the ROUTE shape: ?tail answers older:true on the wire
        req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+chatID+"/events?tail=10", nil)
        req.SetPathValue("id", chatID)
        rec := httptest.NewRecorder()
        s.handleSessionsEvents(rec, req)
        if rec.Code != 200 {
                t.Fatalf("route: HTTP %d", rec.Code)
        }
        var body struct {
                Events []struct {
                        Seq int `json:"seq"`
                } `json:"events"`
                Older bool `json:"older"`
        }
        if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
                t.Fatalf("route body: %v", err)
        }
        if len(body.Events) != 10 || !body.Older || body.Events[9].Seq != 120 {
                t.Fatalf("the route's tail shape: len=%d older=%v newest=%d", len(body.Events), body.Older, body.Events[len(body.Events)-1].Seq)
        }
}
