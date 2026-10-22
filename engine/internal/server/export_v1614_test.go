package server

// export_v1614_test.go — v1.61.4 THE RETRY PILL pins: the export folds
// the sentinel's lifecycle rows into readable lines (the user reads
// exports as ground truth — the probes are the turn's truth).

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func TestV1614_ExportFoldsRetryRows(t *testing.T) {
	events := []*store.Event{
		{Seq: 1, EventType: "retry", Content: retryRowJSON(t, "armed", "net", "openrouter", 0, "")},
		{Seq: 2, EventType: "retry", Content: retryRowJSON(t, "probe", "net", "openrouter", 1, "")},
		{Seq: 3, EventType: "retry", Content: retryRowJSON(t, "probe", "net", "openrouter", 2, "")},
		{Seq: 4, EventType: "retry", Content: retryRowJSON(t, "recovered", "net", "openrouter", 3, "7 minutes")},
	}
	rows := foldEvents(events)
	var retryRows, recovered int
	for _, r := range rows {
		if r.Type != "retry" {
			continue
		}
		retryRows++
		if strings.Contains(r.Text, "continued after 3 retries") && strings.Contains(r.Text, "7 minutes") {
			recovered++
		}
		if strings.Contains(r.Text, "probe 2 failed") {
			recovered += 0 // the probe line must exist somewhere
		}
	}
	if retryRows == 0 {
		t.Fatalf("no retry rows folded: %+v", rows)
	}
	foundProbe := false
	for _, r := range rows {
		if r.Type == "retry" && strings.Contains(r.Text, "probe 2 failed") {
			foundProbe = true
		}
	}
	if !foundProbe {
		t.Fatalf("the probe line is missing from the fold: %+v", rows)
	}
	if recovered == 0 {
		t.Fatalf("the recovered line with the honest elapsed is missing: %+v", rows)
	}
}

func retryRowJSON(t *testing.T, phase, class, provider string, attempts int, note string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"phase": phase, "class": class, "provider": provider,
		"attempts": attempts, "note": note, "next_at": 0, "started_at": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
