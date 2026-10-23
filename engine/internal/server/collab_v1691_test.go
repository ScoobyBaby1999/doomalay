package server

// collab_v1691_test.go — v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1):
// the document op-log's data plane, rig-proven at the HTTP layer:
//
//   (1)  POST ops happy path: the batch journals with contiguous per-canvas
//        seqs, the checkpoint folds ($.syncSeq stamped INSIDE the state),
//        fold_seq advances, the ack frames carry the server stamps;
//   (2)  THE TWIN LAW end-to-end: the folded row state's doc == the
//        client's own next state (the PWA twin derives the same ops);
//   (3)  invalid op → 400 and NOTHING lands (no journal rows, no fold);
//   (4)  unknown canvas → 404 (a shared doc is born from a host row);
//   (5)  GET ops?since= replays inclusive; the snapshot redirect fires
//        only when the GC trimmed below the cursor;
//   (6)  THE STALE-DOC GATE: a whole-state PUT with $.syncSeq behind the
//        journal → 409 {stale-doc}; a current syncSeq → 200 + watermark;
//   (7)  the old-shape PUT (no syncSeq) over a journal voids it — the
//        pre-collab last-write-wins law, made explicit;
//   (8)  concurrent POSTs from two devices: the seqs interleave batches
//        but stay contiguous per batch (the one-clock law);
//   (9)  the replay-safe law end-to-end: the same add twice → one icon.

import (
        "encoding/json"
        "fmt"
        "sync"
        "testing"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/collab"
)

func v1691Seed(t *testing.T, s *Server, id string) {
        t.Helper()
        code, body := v1424Send(t, s, "POST", "/api/canvases", map[string]any{
                "id":   id,
                "name": "Shared",
                "state": map[string]any{
                        "offset":        map[string]any{"x": 0, "y": 0},
                        "scale":         1.0,
                        "currentFamily": "default",
                        "icons":         []any{map[string]any{"id": "chat_a", "type": "chat", "x": 10, "y": 20}},
                        "dots":          []any{},
                        "settings":      map[string]any{"theme": "aurora"},
                        "savedAt":       111.0,
                },
        })
        if code != 201 {
                t.Fatalf("seed create code=%d body=%v", code, body)
        }
}

func v1691PostOps(t *testing.T, s *Server, canvas, device string, ops []collab.Op) (int, map[string]any) {
        t.Helper()
        return v1424Send(t, s, "POST", fmt.Sprintf("/api/collab/%s/ops", canvas), map[string]any{
                "device": device,
                "ops":    ops,
        })
}

func v1691IconSet(t *testing.T, id string, props map[string]any) collab.Op {
        return collab.Op{OpID: "t:" + id, Kind: collab.OpIconSet, ID: id, Props: mustJSON1691(t, props)}
}

func mustJSON1691(t *testing.T, v any) json.RawMessage {
        t.Helper()
        b, err := json.Marshal(v)
        if err != nil {
                t.Fatalf("marshal: %v", err)
        }
        return json.RawMessage(b)
}

func TestV1691_PostOpsFoldsAndStamps(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_x")
        batch := []collab.Op{
                {OpID: "b:1", Kind: collab.OpIconSet, ID: "chat_a", Props: mustJSON1691(t, map[string]any{"x": 15, "name": "Renamed"})},
                {OpID: "b:2", Kind: collab.OpIconAdd, Icon: mustJSON1691(t, map[string]any{"id": "chat_b", "type": "chat", "x": 50, "y": 60})},
                {OpID: "b:3", Kind: collab.OpDocSet, Path: collab.PathWorldSize, Value: mustJSON1691(t, 32768)},
        }
        code, body := v1691PostOps(t, s, "cv_x", "pixel9", batch)
        if code != 200 {
                t.Fatalf("post code=%d body=%v", code, body)
        }
        opsOut, _ := body["ops"].([]any)
        if len(opsOut) != 3 {
                t.Fatalf("ack must carry 3 frames, got %v", body["ops"])
        }
        first, _ := opsOut[0].(map[string]any)
        if first["seq"] != float64(1) || first["device"] != "pixel9" {
                t.Fatalf("ack stamps wrong: %v", first)
        }
        if body["latest"] != float64(3) {
                t.Fatalf("latest must be 3, got %v", body["latest"])
        }
        // the checkpoint: folded doc + $.syncSeq stamped inside the state
        code, body, _ = v1424Get(t, s, "/api/canvases/cv_x")
        if code != 200 {
                t.Fatalf("get canvas code=%d", code)
        }
        canvas, _ := body["canvas"].(map[string]any)
        if canvas["fold_seq"] != float64(3) {
                t.Fatalf("fold_seq must be 3, got %v", canvas["fold_seq"])
        }
        state, _ := canvas["state"].(map[string]any)
        if state == nil {
                t.Fatalf("state missing")
        }
        if state["syncSeq"] != float64(3) {
                t.Fatalf("state.syncSeq must be 3, got %v", state["syncSeq"])
        }
        icons, _ := state["icons"].([]any)
        if len(icons) != 2 {
                t.Fatalf("folded icons: want 2, got %d", len(icons))
        }
        a := icons[0].(map[string]any)
        if a["x"] != float64(15) || a["name"] != "Renamed" || a["type"] != "chat" {
                t.Fatalf("chat_a not folded: %v", a)
        }
        b := icons[1].(map[string]any)
        if b["id"] != "chat_b" {
                t.Fatalf("chat_b must append at the end: %v", icons)
        }
        if state["worldSize"] != float64(32768) {
                t.Fatalf("worldSize not folded: %v", state["worldSize"])
        }
        // the view plane untouched
        if state["savedAt"] != 111.0 {
                t.Fatalf("view plane clobbered: savedAt=%v", state["savedAt"])
        }
        st, _ := state["settings"].(map[string]any)
        if st == nil || st["theme"] != "aurora" {
                t.Fatalf("view plane clobbered: %v", state["settings"])
        }
}

func TestV1691_InvalidOpLandsNothing(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_y")
        bad := []collab.Op{
                {OpID: "b:1", Kind: collab.OpIconSet, ID: "chat_a", Props: json.RawMessage(`{}`)},
        }
        code, body := v1691PostOps(t, s, "cv_y", "pixel9", bad)
        if code != 400 {
                t.Fatalf("invalid op must 400, got %d body=%v", code, body)
        }
        // nothing landed: journal empty, state unchanged
        code, body, _ = v1424Get(t, s, "/api/collab/cv_y/ops?since=0")
        if code != 200 {
                t.Fatalf("ops list code=%d", code)
        }
        opsOut, _ := body["ops"].([]any)
        if len(opsOut) != 0 {
                t.Fatalf("journal must be empty, got %v", opsOut)
        }
        if body["latest"] != float64(0) {
                t.Fatalf("latest must be 0, got %v", body["latest"])
        }
        // a client-sent seq is NEVER trusted — the stamps are stripped
        forged := []collab.Op{{
                OpID: "b:2", Kind: collab.OpIconSet, ID: "chat_a",
                Props: mustJSON1691(t, map[string]any{"x": 99}),
                Seq:   777, Device: "evil", At: 999,
        }}
        code, body = v1691PostOps(t, s, "cv_y", "pixel9", forged)
        if code != 200 {
                t.Fatalf("forged-stamp op code=%d body=%v", code, body)
        }
        opsOut, _ = body["ops"].([]any)
        frame, _ := opsOut[0].(map[string]any)
        if frame["seq"] != float64(1) || frame["device"] != "pixel9" {
                t.Fatalf("client stamps must be overwritten: %v", frame)
        }
}

func TestV1691_UnknownCanvas404(t *testing.T) {
        s := newLongHaulServer(t)
        code, _ := v1691PostOps(t, s, "cv_missing", "pixel9", []collab.Op{v1691IconSet(t, "x", map[string]any{"x": 1})})
        if code != 404 {
                t.Fatalf("unknown canvas must 404, got %d", code)
        }
        code, body, _ := v1424Get(t, s, "/api/collab/cv_missing/ops?since=0")
        if code != 404 {
                t.Fatalf("unknown canvas list must 404, got %d %v", code, body)
        }
}

func TestV1691_ReplayInclusiveAndSnapshotRedirect(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_z")
        // two batches: seqs 1..2, then 3
        v1691PostOps(t, s, "cv_z", "d1", []collab.Op{v1691IconSet(t, "chat_a", map[string]any{"x": 1}), v1691IconSet(t, "chat_a", map[string]any{"x": 2})})
        v1691PostOps(t, s, "cv_z", "d2", []collab.Op{v1691IconSet(t, "chat_a", map[string]any{"x": 3})})
        // since=2 → inclusive replay: seqs 2,3 only
        code, body, _ := v1424Get(t, s, "/api/collab/cv_z/ops?since=2")
        if code != 200 {
                t.Fatalf("replay code=%d", code)
        }
        opsOut, _ := body["ops"].([]any)
        if len(opsOut) != 2 {
                t.Fatalf("since=2 must replay seqs 2..3, got %d: %v", len(opsOut), opsOut)
        }
        if body["latest"] != float64(3) {
                t.Fatalf("latest must be 3, got %v", body["latest"])
        }
        // the GC trims below a future cursor → the snapshot redirect
        if _, err := s.db.TrimCanvasOps("cv_z", 2); err != nil {
                t.Fatalf("trim: %v", err)
        }
        code, body, _ = v1424Get(t, s, "/api/collab/cv_z/ops?since=1")
        if code != 200 {
                t.Fatalf("redirect code=%d", code)
        }
        if body["snapshot"] != true {
                t.Fatalf("since below the GC watermark must redirect to snapshot, got %v", body)
        }
        // since=0 over a trimmed journal is an honest replay (the whole live
        // journal), NOT a redirect — the client adopting a snapshot starts at
        // the snapshot's own syncSeq anyway.
        code, body, _ = v1424Get(t, s, "/api/collab/cv_z/ops?since=0")
        if code != 200 {
                t.Fatalf("since0 code=%d", code)
        }
        if body["snapshot"] == true {
                t.Fatalf("since=0 must not redirect: %v", body)
        }
        opsOut, _ = body["ops"].([]any)
        if len(opsOut) != 1 || opsOut[0].(map[string]any)["seq"] != float64(3) {
                t.Fatalf("since=0 must replay the live journal (seq 3), got %v", opsOut)
        }
}

func TestV1691_StaleDocGate409(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_gate")
        // guest op lands (seq 1) while the host's flush was in flight
        v1691PostOps(t, s, "cv_gate", "guest", []collab.Op{v1691IconSet(t, "chat_a", map[string]any{"x": 42})})
        // the host PUTs a state stamped syncSeq=0 → STALE → 409
        stale := map[string]any{
                "currentFamily": "default",
                "icons":         []any{map[string]any{"id": "chat_a", "type": "chat", "x": 10}},
                "dots":          []any{},
                "syncSeq":       0,
                "savedAt":       222.0,
        }
        code, body := v1424Send(t, s, "PUT", "/api/canvases/cv_gate", map[string]any{"state": stale})
        if code != 409 {
                t.Fatalf("stale PUT must 409, got %d body=%v", code, body)
        }
        if body["error"] != "stale-doc" || body["ops_since"] != float64(0) || body["latest"] != float64(1) {
                t.Fatalf("409 shape wrong: %v", body)
        }
        // the rebased PUT (syncSeq=1, the guest op folded in) → 200 + watermark
        rebased := map[string]any{
                "currentFamily": "default",
                "icons":         []any{map[string]any{"id": "chat_a", "type": "chat", "x": 42}},
                "dots":          []any{},
                "syncSeq":       1,
                "savedAt":       223.0,
        }
        code, body = v1424Send(t, s, "PUT", "/api/canvases/cv_gate", map[string]any{"state": rebased})
        if code != 200 {
                t.Fatalf("rebased PUT code=%d body=%v", code, body)
        }
        canvas, _ := body["canvas"].(map[string]any)
        if canvas["fold_seq"] != float64(1) {
                t.Fatalf("watermark must advance to 1, got %v", canvas["fold_seq"])
        }
}

func TestV1691_OldShapePutVoidsJournal(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_void")
        v1691PostOps(t, s, "cv_void", "guest", []collab.Op{v1691IconSet(t, "chat_a", map[string]any{"x": 42})})
        // an old-shape PUT (no syncSeq) writes through as v1.67 did — and the
        // journal is void (the ops die with it; the replay invariant holds).
        old := map[string]any{
                "currentFamily": "default",
                "icons":         []any{map[string]any{"id": "chat_a", "type": "chat", "x": 10}},
                "dots":          []any{},
                "savedAt":       333.0,
        }
        code, body := v1424Send(t, s, "PUT", "/api/canvases/cv_void", map[string]any{"state": old})
        if code != 200 {
                t.Fatalf("old-shape PUT must write through, got %d body=%v", code, body)
        }
        code, body, _ = v1424Get(t, s, "/api/collab/cv_void/ops?since=0")
        if code != 200 {
                t.Fatalf("ops code=%d", code)
        }
        if body["latest"] != float64(0) {
                t.Fatalf("journal must be void, latest=%v", body["latest"])
        }
        opsOut, _ := body["ops"].([]any)
        if len(opsOut) != 0 {
                t.Fatalf("journal must be empty, got %v", opsOut)
        }
        // the state is the old-shape write (last-write-wins, the documented law)
        code, body, _ = v1424Get(t, s, "/api/canvases/cv_void")
        state, _ := body["canvas"].(map[string]any)["state"].(map[string]any)
        icons, _ := state["icons"].([]any)
        if icons[0].(map[string]any)["x"] != float64(10) {
                t.Fatalf("old-shape write must win: %v", icons)
        }
}

func TestV1691_OneClockConcurrentBatches(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_race")
        var wg sync.WaitGroup
        for d := 0; d < 4; d++ {
                wg.Add(1)
                go func(d int) {
                        defer wg.Done()
                        device := fmt.Sprintf("dev%d", d)
                        ops := []collab.Op{{
                                OpID: fmt.Sprintf("%s:1", device),
                                Kind: collab.OpIconAdd,
                                Icon: mustJSON1691(t, map[string]any{"id": fmt.Sprintf("icon_%d", d), "type": "chat", "x": d}),
                        }}
                        code, body := v1691PostOps(t, s, "cv_race", device, ops)
                        if code != 200 {
                                t.Errorf("concurrent post %d: code=%d", d, code)
                                return
                        }
                        // THE ONE-CLOCK LAW: each batch's ack seqs are contiguous
                        opsOut, _ := body["ops"].([]any)
                        if len(opsOut) != 1 {
                                t.Errorf("batch %d ack: %v", d, body)
                                return
                        }
                }(d)
        }
        wg.Wait()
        code, body, _ := v1424Get(t, s, "/api/collab/cv_race/ops?since=0")
        if code != 200 {
                t.Fatalf("ops code=%d", code)
        }
        if body["latest"] != float64(4) {
                t.Fatalf("4 batches must journal 4 ops, latest=%v", body["latest"])
        }
        // every batch's frame carries its own device; all 4 icons folded once
        code, body, _ = v1424Get(t, s, "/api/canvases/cv_race")
        state, _ := body["canvas"].(map[string]any)["state"].(map[string]any)
        icons, _ := state["icons"].([]any)
        if len(icons) != 5 { // chat_a + 4 adds
                t.Fatalf("5 icons must fold, got %d: %v", len(icons), icons)
        }
}

func TestV1691_ReplaySafeEndToEnd(t *testing.T) {
        s := newLongHaulServer(t)
        v1691Seed(t, s, "cv_replay")
        add := collab.Op{OpID: "r:1", Kind: collab.OpIconAdd, Icon: mustJSON1691(t, map[string]any{"id": "dup", "type": "chat", "x": 5})}
        v1691PostOps(t, s, "cv_replay", "d", []collab.Op{add})
        // the same add posted AGAIN (the retry law) → journaled, but folded to
        // a no-op: the icon count stays 2 (chat_a + dup)
        v1691PostOps(t, s, "cv_replay", "d", []collab.Op{add})
        _, body, _ := v1424Get(t, s, "/api/canvases/cv_replay")
        state, _ := body["canvas"].(map[string]any)["state"].(map[string]any)
        icons, _ := state["icons"].([]any)
        if len(icons) != 2 {
                t.Fatalf("redelivered add must not double-fold: %d icons", len(icons))
        }
}
