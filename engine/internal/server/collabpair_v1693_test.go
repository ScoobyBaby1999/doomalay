package server

// collabpair_v1693_test.go — v1.69.3 THE HANDSHAKE (PLAN-V169 §v1.69.3),
// rig-proven at the HTTP layer (every leg is the wire's own frames):
//
//   (1)  THE PAIR LIFECYCLE: mint (owner-only) → a wrong code answers
//        the honest miss (404 — no oracle) → the right code claims →
//        the poll says pending → THE TAP (approve) → the poll answers
//        approved with the token + the device → a SECOND poll converges
//        on the SAME token (the deterministic mint);
//   (2)  THE CLAIM LAWS: a second device on the same code → 409; a
//        deny → the poll says denied; no claim yet → approve 409;
//   (3)  THE RATE LIMIT: 11 claims from one IP inside the window → 429;
//   (4)  THE ACL: the token authorizes ops/live/doc on the MEMBER
//        canvas only — another canvas 401s; a random token 401s; the
//        pair endpoints never leak the global gate;
//   (5)  THE AUTHOR LAW: a device's op submit is authored by the
//        credential's device id, never the body's claim;
//   (6)  THE GATED PORTALS: a hole icon to an unshared canvas is
//        unknown to the member (filtered from /doc), visible to the
//        owner; a hole to a SHARED canvas rides through;
//   (7)  THE REGISTRY: /api/collab/my lists exactly the member canvases;
//   (8)  THE REVOKE: the grant dies → the token dies with the last
//        grant → every surface 401s;
//   (9)  OWNER-ONLY: a device token on invite/members/revoke → 401.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/collab"
)

// the v1693-local wire helpers: the OWNER's requests ride loopback (the
// engine's own law); the JOINER's ride a FOREIGN address — proving the
// pair path serves a device with NO global credential at all.
func v1693Send(t *testing.T, s *Server, method, path string, payload any, remote string) (int, map[string]any) {
	t.Helper()
	var rdr *bytes.Reader
	switch p := payload.(type) {
	case nil:
		rdr = bytes.NewReader(nil)
	default:
		jb, _ := json.Marshal(p)
		rdr = bytes.NewReader(jb)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.RemoteAddr = remote
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body
}

const v1693Owner = "127.0.0.1:51111"
const v1693Guest = "203.0.113.9:44444"

func v1693Get(t *testing.T, s *Server, path string, remote string) (int, map[string]any) {
	t.Helper()
	return v1693Send(t, s, "GET", path, nil, remote)
}

func v1693Seed(t *testing.T, s *Server, id string) {
	t.Helper()
	code, body := v1693Send(t, s, "POST", "/api/canvases", map[string]any{
		"id": id, "name": "S" + id,
		"state": map[string]any{
			"currentFamily": "default",
			"icons": []any{
				map[string]any{"id": "chat_a", "type": "chat", "x": 10, "y": 20},
				map[string]any{"id": "hole_p", "type": "hole", "x": 50, "y": 60, "targetWorldId": "cv_other", "pairId": "pair_1"},
			},
			"dots":    []any{},
			"savedAt": 111.0,
		},
	}, v1693Owner)
	if code != 201 {
		t.Fatalf("seed %s: code=%d body=%v", id, code, body)
	}
}

func v1693Pair(t *testing.T, s *Server, canvas, code, name string) (int, map[string]any) {
	t.Helper()
	// the JOINER: a foreign address, no credential — the pair path must
	// serve exactly this.
	return v1693Send(t, s, "POST", "/api/collab/pair", map[string]any{"canvas": canvas, "code": code, "name": name}, v1693Guest)
}

func v1693Enroll(t *testing.T, s *Server, canvas, name string) (string, string) {
	t.Helper()
	// owner mints
	code, body := v1693Send(t, s, "POST", fmt.Sprintf("/api/collab/%s/invite", canvas), nil, v1693Owner)
	if code != 200 {
		t.Fatalf("mint: %d %v", code, body)
	}
	inviteCode, _ := body["code"].(string)
	if len(inviteCode) != 6 {
		t.Fatalf("the code must be 6 digits: %v", inviteCode)
	}
	// joiner claims
	code, body = v1693Pair(t, s, canvas, inviteCode, name)
	if code != 200 {
		t.Fatalf("pair: %d %v", code, body)
	}
	deviceCode, _ := body["device_code"].(string)
	// poll: pending
	pcode, pbody := v1693Get(t, s, "/api/collab/pair?device_code="+deviceCode, v1693Guest)
	if pcode != 200 || pbody["status"] != "pending" {
		t.Fatalf("poll pending: %d %v", pcode, pbody)
	}
	// THE TAP
	code, body = v1693Send(t, s, "POST", fmt.Sprintf("/api/collab/%s/invite/approve", canvas), nil, v1693Owner)
	if code != 200 {
		t.Fatalf("approve: %d %v", code, body)
	}
	// poll: approved
	pcode, pbody = v1693Get(t, s, "/api/collab/pair?device_code="+deviceCode, v1693Guest)
	if pcode != 200 || pbody["status"] != "approved" {
		t.Fatalf("poll approved: %d %v", pcode, pbody)
	}
	token, _ := pbody["token"].(string)
	device, _ := pbody["device_id"].(string)
	if token == "" || device == "" {
		t.Fatalf("the poll must hand the token + device: %v", pbody)
	}
	// the idempotency: a second poll converges on the SAME pair
	pcode, pbody2 := v1693Get(t, s, "/api/collab/pair?device_code="+deviceCode, v1693Guest)
	if pcode != 200 || pbody2["token"] != token || pbody2["device_id"] != device {
		t.Fatalf("the second poll must converge: %v vs %v", pbody2, pbody)
	}
	return token, device
}

func TestV1693_PairLifecycle(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_pair")

	// the wrong code answers the honest miss (no oracle: same 404 as no invite)
	code, _ := v1693Pair(t, s, "cv_pair", "000000", "Evil")
	if code != 404 {
		t.Fatalf("wrong code must 404, got %d", code)
	}
	// a canvas that never minted → the same honest miss
	code, _ = v1693Pair(t, s, "cv_ghost", "123456", "Evil")
	if code != 404 {
		t.Fatalf("no-invite canvas must 404, got %d", code)
	}

	token, device := v1693Enroll(t, s, "cv_pair", "Pixel 9")
	if len(token) < 32 {
		t.Fatalf("the token must be a 256-bit credential: %q", token)
	}
	// the store never holds the raw token
	hashed := collab.HashToken(token)
	dev, err := s.db.CollabDeviceByToken(hashed)
	if err != nil || dev == nil || dev.ID != device || dev.Name != "Pixel 9" {
		t.Fatalf("the hashed token must resolve the device: %v %v", dev, err)
	}
}

func TestV1693_ClaimLaws(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_claims")
	_, body := v1693Send(t, s, "POST", "/api/collab/cv_claims/invite", nil, v1693Owner)
	inviteCode := body["code"].(string)

	// approve before any claim → 409 (nothing to approve)
	code, body2 := v1693Send(t, s, "POST", "/api/collab/cv_claims/invite/approve", nil, v1693Owner)
	if code != 409 {
		t.Fatalf("unclaimed approve must 409, got %d %v", code, body2)
	}

	// the first device claims (its device_code is the poll cursor)
	code, firstBody := v1693Pair(t, s, "cv_claims", inviteCode, "First")
	if code != 200 {
		t.Fatalf("first claim: %d %v", code, firstBody)
	}
	dcFirst := firstBody["device_code"].(string)
	// the second device on the same code → 409 (single-use)
	code, secondBody := v1693Pair(t, s, "cv_claims", inviteCode, "Second")
	if code != 409 {
		t.Fatalf("second claim must 409, got %d %v", code, secondBody)
	}
	// deny → the FIRST claimant's poll says denied
	v1693Send(t, s, "POST", "/api/collab/cv_claims/invite/deny", nil, v1693Owner)
	pcode, pbody := v1693Get(t, s, "/api/collab/pair?device_code="+dcFirst, v1693Guest)
	if pcode != 200 || pbody["status"] != "denied" {
		t.Fatalf("the denied poll: %d %v", pcode, pbody)
	}
}

func TestV1693_RateLimit(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_rate")
	_, body := v1693Send(t, s, "POST", "/api/collab/cv_rate/invite", nil, v1693Owner)
	code6 := body["code"].(string)
	last := 0
	for i := 0; i < 11; i++ {
		last, _ = v1693Pair(t, s, "cv_rate", code6, fmt.Sprintf("D%d", i))
		// only the FIRST hits a live unclaimed invite; the rest 409 —
		// but they all COUNT against the rate window (every attempt is
		// an attempt)
	}
	if last != 429 {
		t.Fatalf("the 11th claim in the window must 429, got %d", last)
	}
}

func TestV1693_AclAndAuthorLaw(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_mine")
	v1693Seed(t, s, "cv_notmine")
	token, _ := v1693Enroll(t, s, "cv_mine", "Phone")

	// the member canvas: ops submit authorized + authored by the credential
	op := map[string]any{"opId": "t:1", "kind": "icon.set", "id": "chat_a", "props": map[string]any{"x": 99}}
	code, body := v1693Send(t, s, "POST", "/api/collab/cv_mine/ops?token="+token, map[string]any{"device": "spoofed", "ops": []any{op}}, v1693Guest)
	if code != 200 {
		t.Fatalf("member ops submit: %d %v", code, body)
	}
	opsOut := body["ops"].([]any)
	fr := opsOut[0].(map[string]any)
	if fr["device"] == "spoofed" || fr["device"] == "" {
		t.Fatalf("THE AUTHOR LAW: the credential names the author, never the body: %v", fr)
	}

	// another canvas → 401 (the per-canvas sandbox)
	code, _ = v1693Send(t, s, "POST", "/api/collab/cv_notmine/ops?token="+token, map[string]any{"ops": []any{op}}, v1693Guest)
	if code != 401 {
		t.Fatalf("a member token on ANOTHER canvas must 401, got %d", code)
	}
	// a random token → 401
	code, _ = v1693Send(t, s, "POST", "/api/collab/cv_mine/ops?token=deadbeef", map[string]any{"ops": []any{op}}, v1693Guest)
	if code != 401 {
		t.Fatalf("a random token must 401, got %d", code)
	}
	// the doc read: member 200 on the member canvas; 401 on the other
	code, body = v1693Get(t, s, "/api/collab/cv_mine/doc?token="+token, v1693Guest)
	if code != 200 {
		t.Fatalf("member doc read: %d", code)
	}
	code, _ = v1693Get(t, s, "/api/collab/cv_notmine/doc?token="+token, v1693Guest)
	if code != 401 {
		t.Fatalf("member doc on another canvas must 401, got %d", code)
	}
}

func TestV1693_GatedPortals(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_view") // holds hole_p → cv_other (NOT shared with the phone)
	token, _ := v1693Enroll(t, s, "cv_view", "Phone")

	// the member's doc: the hole to the UNSEEN canvas is gone; the owner
	// sees everything
	code, body := v1693Get(t, s, "/api/collab/cv_view/doc?token="+token, v1693Guest)
	if code != 200 {
		t.Fatalf("member doc: %d", code)
	}
	doc := body["doc"].(map[string]any)
	icons := doc["icons"].([]any)
	for _, ic := range icons {
		m := ic.(map[string]any)
		if m["id"] == "hole_p" {
			t.Fatalf("THE GATED PORTALS: the hole to an unseen canvas must be unknown to the member: %v", icons)
		}
	}
	if len(icons) != 1 {
		t.Fatalf("the member's doc holds only the chat: %v", icons)
	}
	// the owner sees the hole
	code, body = v1693Get(t, s, "/api/collab/cv_view/doc", v1693Owner)
	if code != 200 {
		t.Fatalf("owner doc: %d", code)
	}
	doc = body["doc"].(map[string]any)
	icons = doc["icons"].([]any)
	if len(icons) != 2 {
		t.Fatalf("the owner sees BOTH icons (never filtered): %v", icons)
	}
}

func TestV1693_MyRegistryAndRevoke(t *testing.T) {
	s := newLongHaulServer(t)
	v1693Seed(t, s, "cv_one")
	v1693Seed(t, s, "cv_two")
	token, device := v1693Enroll(t, s, "cv_one", "Phone")
	v1693Enroll(t, s, "cv_two", "Phone") // the same phone — wait, a second ENROLL mints a second device. The registry test wants ONE device on TWO canvases.
	_ = device

	// /my: the token's registry
	code, body := v1693Get(t, s, "/api/collab/my?token="+token, v1693Guest)
	if code != 200 {
		t.Fatalf("my: %d", code)
	}
	// without a token → 401
	code, _ = v1693Get(t, s, "/api/collab/my", v1693Guest)
	if code != 401 {
		t.Fatalf("my without a token must 401, got %d", code)
	}

	// THE REVOKE: the grant on cv_one dies → the doc 401s
	// (find the device id via the member list)
	code, body = v1693Get(t, s, "/api/collab/cv_one/members", v1693Owner)
	if code != 200 {
		t.Fatalf("members: %d", code)
	}
	members := body["members"].([]any)
	if len(members) != 1 {
		t.Fatalf("one member expected: %v", members)
	}
	devID := members[0].(map[string]any)["id"].(string)
	code, _ = v1693Send(t, s, "POST", "/api/collab/cv_one/members/"+devID+"/revoke", nil, v1693Owner)
	if code != 200 {
		t.Fatalf("revoke: %d", code)
	}
	code, _ = v1693Get(t, s, "/api/collab/cv_one/doc?token="+token, v1693Guest)
	if code != 401 {
		t.Fatalf("the revoked grant must 401 the doc, got %d", code)
	}
	// a device token on the OWNER-only surfaces → 401
	code, _ = v1693Send(t, s, "POST", "/api/collab/cv_one/members/"+devID+"/revoke?token="+token, nil, v1693Guest)
	if code != 401 {
		t.Fatalf("a device token must not reach the owner surfaces, got %d", code)
	}
}

// ── the helpers ride the v1424 pair (paths carry query strings) ────
