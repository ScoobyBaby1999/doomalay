package server

// collab_v1711_test.go — v1.71.1 THE DASHBOARD (PLAN-V169 §v1.169.4): the
// wire-level laws of the code-only pairing + the canvas-row probes.
//
//   (1)  THE CODE-ONLY CLAIM: POST /api/collab/pair with NO canvas — a
//        foreign guest (no global credential, no host rows) claims the
//        invite BY CODE; the claim + the approved poll carry the resolved
//        canvas + its name (the guest's activation truth);
//   (2)  THE CANVAS-ROW PROBES: GET /api/canvases rows carry the fork
//        lineage (imported/imported_uuid/imported_author) + the collab
//        member count (shared_count) — the manager's chips' truth.

import (
        "fmt"
        "testing"
)

func TestV1711_CodeOnlyPairWire(t *testing.T) {
        s := newLongHaulServer(t)
        v1693Seed(t, s, "cv_pair")

        // owner mints
        code, body := v1693Send(t, s, "POST", "/api/collab/cv_pair/invite", nil, v1693Owner)
        if code != 200 {
                t.Fatalf("mint: %d %v", code, body)
        }
        inviteCode, _ := body["code"].(string)

        // THE FOREIGN GUEST claims with NO canvas — the code is the locator
        code, body = v1693Send(t, s, "POST", "/api/collab/pair", map[string]any{
                "canvas": "", "code": inviteCode, "name": "Pixel 9",
        }, v1693Guest)
        if code != 200 {
                t.Fatalf("code-only pair: %d %v", code, body)
        }
        dc, _ := body["device_code"].(string)
        if dc == "" {
                t.Fatalf("the device_code must land")
        }
        if cv, _ := body["canvas"].(string); cv != "cv_pair" {
                t.Fatalf("the claim must carry the resolved canvas, got %v", body["canvas"])
        }
        if nm, _ := body["canvas_name"].(string); nm != "Scv_pair" {
                t.Fatalf("the claim must carry the canvas name, got %q", nm)
        }

        // THE TAP
        code, _ = v1693Send(t, s, "POST", "/api/collab/cv_pair/invite/approve", nil, v1693Owner)
        if code != 200 {
                t.Fatalf("approve: %d", code)
        }

        // the approved poll carries the token + the device + THE CANVAS
        code, body = v1693Get(t, s, "/api/collab/pair?device_code="+dc, v1693Guest)
        if code != 200 {
                t.Fatalf("poll: %d", code)
        }
        if body["status"] != "approved" {
                t.Fatalf("poll status = %v", body["status"])
        }
        if cv, _ := body["canvas"].(string); cv != "cv_pair" {
                t.Fatalf("the approved poll must carry the canvas, got %v", body["canvas"])
        }
        if tok, _ := body["token"].(string); tok == "" {
                t.Fatalf("the token must land")
        }
        // the guest is a MEMBER of the RESOLVED canvas (never the caller's claim)
        if code, _ = v1693Get(t, s, "/api/collab/cv_pair/doc?token="+fmt.Sprint(body["token"]), v1693Guest); code != 200 {
                t.Fatalf("the credentialed doc read on the resolved canvas: %d", code)
        }
}

func TestV1711_CanvasRowProbes(t *testing.T) {
        s := newLongHaulServer(t)
        // a fork-born canvas (the import stamp carries the 1.1 lineage) + a member
        v1693Send(t, s, "POST", "/api/canvases", map[string]any{
                "id": "cv_fork", "name": "Forked World",
                "state": map[string]any{
                        "icons": []any{}, "dots": []any{}, "savedAt": 111.0,
                        "imported": map[string]any{
                                "from": "Origin World", "author": "alice",
                                "at": "2026-10-01T00:00:00Z", "appVersion": "1.70.0",
                                "uuid": "cvb_origin01", "parentUuid": "",
                        },
                },
        }, v1693Owner)
        // a member joins cv_fork through the real enrollment
        v1693Send(t, s, "POST", "/api/collab/cv_fork/invite", nil, v1693Owner)
        _, ibody := v1693Send(t, s, "GET", "/api/collab/cv_fork/invite", nil, v1693Owner)
        inv := ibody["invite"].(map[string]any)
        inviteCode, _ := inv["code"].(string)
        _, pbody := v1693Pair(t, s, "", inviteCode, "Member Device") // code-only claim
        v1693Send(t, s, "POST", "/api/collab/cv_fork/invite/approve", nil, v1693Owner)
        // THE POLL mints the credential + the member row (the deterministic-mint
        // law: mintApproved runs at PairStatus, never at Approve)
        pdc, _ := pbody["device_code"].(string)
        v1693Get(t, s, "/api/collab/pair?device_code="+pdc, v1693Guest)

        code, body := v1693Get(t, s, "/api/canvases", v1693Owner)
        if code != 200 {
                t.Fatalf("list: %d", code)
        }
        rows, _ := body["canvases"].([]any)
        if rows == nil {
                t.Fatalf("the list must carry rows")
        }
        var forkRow map[string]any
        for _, r := range rows {
                if m, ok := r.(map[string]any); ok && m["id"] == "cv_fork" {
                        forkRow = m
                }
        }
        if forkRow == nil {
                t.Fatalf("cv_fork missing from the list")
        }
        if forkRow["imported"] != "Origin World" {
                t.Fatalf("imported probe = %v", forkRow["imported"])
        }
        if forkRow["imported_uuid"] != "cvb_origin01" {
                t.Fatalf("imported_uuid probe = %v", forkRow["imported_uuid"])
        }
        if forkRow["imported_author"] != "alice" {
                t.Fatalf("imported_author probe = %v", forkRow["imported_author"])
        }
        if forkRow["shared_count"] != float64(1) {
                t.Fatalf("shared_count probe = %v (want 1)", forkRow["shared_count"])
        }
}
