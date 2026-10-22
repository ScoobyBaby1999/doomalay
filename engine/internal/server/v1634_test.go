package server

// v1634_test.go — v1.63.4 THE WALL WALK pins (PLAN-V163 §4's engine piece,
// the live conviction the v1630 rig surfaced: the free-limit wall is
// PER-MODEL — each free model carries its own small window; a 429 on one
// says nothing about the roster).
//
// THE USER'S LAW VERBATIM: "We are not rate limited, if you hit rate
// limits it's a false positive." The engine answers: the wall walk — on a
// free-tier refusal the turn rides the NEXT cost-0 opencode-zen model
// from the LIVE catalogue, SAME serve session (the context survives, NO
// opening-text recap), ONE honest notice, ONE retry. A second wall (the
// roster exhausted) answers the honest per-model terminal. The walk is
// PER-TURN: the chat's own model choice never silently changes.
//
// These tests REPLACE the v1.48.5 RECYCLE LAW pins (the session-recycle
// for the free class is dead — the model walk is the correct vehicle: the
// wall follows the MODEL, not the session).

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/ocserve"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// v1634Catalog arms the fake's /api/model: the walled big-pickle + the
// free glm alternative + a PAID kimi (the walk must skip it).
const v1634Catalog = `{"data":[
  {"id":"big-pickle","modelID":"big-pickle","providerID":"opencode","name":"Big Pickle","status":"active","cost":[{"input":0,"output":0}],"capabilities":{"tools":true}},
  {"id":"glm-5.3-flash-free","modelID":"glm-5.3-flash-free","providerID":"opencode","name":"GLM Flash","status":"active","cost":[{"input":0,"output":0}],"capabilities":{"tools":true}},
  {"id":"kimi-k2.7-code","modelID":"kimi-k2.7-code","providerID":"opencode","name":"Kimi","status":"active","cost":[{"input":0.95,"output":4}],"capabilities":{"tools":true}}
]}`

// TestV1634_TheWallWalk pins the walk itself: a walled first attempt keeps
// the serve session (NO recycle, NO opening-text recap), selects the next
// FREE model, rides ONE honest notice, and the retry answers clean.
func TestV1634_TheWallWalk(t *testing.T) {
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
	fake.sse = cleanTurnFrames("ses_fake_1")
	fake.poisonedTries = 1 // wall once, clean after
	fake.modelCatalog = v1634Catalog
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
	if err := s.ocServeStreamTurn(context.Background(), m, "chat1", sess, "hello now", events); err != nil {
		t.Fatalf("stream turn: %v", err)
	}
	close(events)
	got := <-collect

	fake.mu.Lock()
	texts := append([]string(nil), fake.promptTexts...)
	models := append([]map[string]any(nil), fake.modelBodies...)
	fake.mu.Unlock()

	// TWO prompts: the first (walled, opening text — the fresh session), the
	// retry on the SAME session with the PLAIN text (the walk never recycles)
	if len(texts) != 2 {
		t.Fatalf("the walk fires exactly two prompts, got %d", len(texts))
	}
	if texts[1] != "hello now" {
		t.Fatalf("the retry carries the PLAIN message (no opening-text recap — the session survives the walk): %q", texts[1])
	}
	// the walk selected the FREE alternative (big-pickle → glm; kimi is paid)
	if len(models) != 2 {
		t.Fatalf("two model selections (the walled + the walk), got %d", len(models))
	}
	m0, _ := models[0]["model"].(map[string]any)
	m1, _ := models[1]["model"].(map[string]any)
	if m0 == nil || m0["id"] != "big-pickle" || m1 == nil || m1["id"] != "glm-5.3-flash-free" {
		t.Fatalf("the walk: big-pickle → glm-5.3-flash-free (never the paid kimi): %v → %v", m0, m1)
	}
	// the honest notice rode
	var sawNotice bool
	for _, ev := range got {
		if ev["type"] == "notice" && strings.Contains(fmt.Sprint(ev["message"]), "free window is full") &&
			strings.Contains(fmt.Sprint(ev["message"]), "glm-5.3-flash-free") {
			sawNotice = true
		}
	}
	if !sawNotice {
		t.Fatalf("the walk's honest notice must ride (the free-window story)")
	}
	// the clean retry ends idle
	var sawIdle bool
	for _, ev := range got {
		if ev["type"] == "status" && ev["state"] == "idle" {
			sawIdle = true
		}
	}
	if !sawIdle {
		t.Fatalf("the walk's retry must end with the idle terminal")
	}
	// NO recycle: the serve session count stays ONE (the same session both prompts)
	if fake.sessionN != 1 {
		t.Fatalf("the walk keeps the session (no recycle): serve sessions %d", fake.sessionN)
	}
}

// TestV1634_WallWalkHonestTerminal pins the exhausted-roster branch: the
// walk fires once, the SECOND wall answers the honest per-model terminal
// (never a silent hang, never a loop).
func TestV1634_WallWalkHonestTerminal(t *testing.T) {
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
	fake.modelCatalog = v1634Catalog
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
	fake.mu.Lock()
	prompts := len(fake.promptTexts)
	fake.mu.Unlock()
	if prompts != 2 {
		t.Fatalf("the walk bounds at ONE retry (2 prompts), got %d", prompts)
	}
	var sawErr, sawTerminal bool
	for _, ev := range got {
		if ev["type"] == "error" && strings.Contains(fmt.Sprint(ev["message"]), "per-model") {
			sawErr = true
		}
		if ev["type"] == "status" && ev["state"] == "error" {
			sawTerminal = true
		}
	}
	if !sawErr || !sawTerminal {
		t.Fatalf("the exhausted roster answers the honest per-model error + terminal: err=%v terminal=%v", sawErr, sawTerminal)
	}
}

// TestV1634_NoRosterNoWalk pins the empty-roster shape: a wall with no
// free alternative in the catalogue answers the honest terminal IMMEDIATELY
// (one prompt — the walk never fires without a destination).
func TestV1634_NoRosterNoWalk(t *testing.T) {
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
	fake.poisonedTries = 1 // wall once (and no catalogue armed)
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
	fake.mu.Lock()
	prompts := len(fake.promptTexts)
	fake.mu.Unlock()
	if prompts != 1 {
		t.Fatalf("no roster = no walk (1 prompt), got %d", prompts)
	}
	var sawErr bool
	for _, ev := range got {
		if ev["type"] == "error" && strings.Contains(fmt.Sprint(ev["message"]), "free-tier windows are all full") {
			sawErr = true
		}
	}
	if !sawErr {
		t.Fatalf("the no-roster wall answers the honest terminal")
	}
}
