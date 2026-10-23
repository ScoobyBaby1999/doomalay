package server

// djournaltool.go — v1.47.1 THE JOURNAL HAND (PLAN-V147 §1): the
// direct-path runner behind llm.ChatRequest.DjournalToolFn.
//
// The server owns the two things the pure core never touches: the
// STATE PATH (one journal per install — <DataDir>/journal/entries.jsonl,
// a diary is not per-chat) and the ARTIFACT SINK (an export also lands
// in this session's drawer as a real download card — the docx/xlsx
// pattern; the state-dir export.md/export.json stays the Python law).
//
// The parse is tolerant the runSkillsAction way: a bare non-JSON string
// becomes action=write with that string as the text (models sometimes
// send just the words they want journaled — the tool's whole soul).

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/djournal"
)

// djournalStatePath is the app-global diary: <DataDir>/journal/entries.jsonl.
func (s *Server) djournalStatePath() string {
	dir := "./data"
	if s.cfg != nil && s.cfg.DataDir != "" {
		dir = s.cfg.DataDir
	}
	return filepath.Join(dir, "journal", djournal.StateFile)
}

// runDjournalAction (v1.47.1) — the DIRECT-PATH journal ACTION runner:
// the quick chats' djournal calls land here (via llm.ChatRequest.
// DjournalToolFn), parse their JSON args, ride the pure core, and sink
// exports into the artifact drawer. Returns OBSERVATION-ready text.
func (s *Server) runDjournalAction(ctx context.Context, sessionID, argJSON string) string {
	var args map[string]any
	if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
		trimmed := strings.TrimSpace(strings.Trim(argJSON, "\""))
		if trimmed != "" && !strings.HasPrefix(argJSON, "{") {
			// a bare string is a diary line — the tool's whole soul
			args = map[string]any{"action": "write", "text": trimmed}
		} else {
			return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
		}
	}
	get := func(k string) string {
		v, _ := args[k].(string)
		return v
	}
	res := djournal.RunAction(s.djournalStatePath(), djournal.Args{
		Action:     get("action"),
		Text:       get("text"),
		Date:       get("date"),
		Mood:       args["mood"],
		Tags:       args["tags"],
		Highlights: args["highlights"],
		Gratitude:  args["gratitude"],
		Energy:     args["energy"],
		Query:      get("query"),
		InField:    get("in_field"),
		DateRange:  get("date_range"),
		Period:     get("period"),
		Target:     get("target"),
		Format:     get("format"),
		Now:        time.Now().UTC(),
	})
	// An export ALSO sinks into this session's artifact drawer — a real
	// download card (the docx/xlsx law). The state-dir file stays the
	// Python law (export.md/export.json next to entries.jsonl).
	if res.Export != nil && res.Export.Wrote {
		sink := &sessionArtifactSink{s: s, sessID: sessionID}
		if _, size, err := sink.SaveArtifact(res.Export.FileName,
			[]byte(res.Export.Content), "djournal export"); err == nil {
			res.Text += fmt.Sprintf("\nSaved as artifact %q (%s) — the user can open/download it from the chat's artifact drawer. Tell the user the file is ready.",
				res.Export.FileName, humanBytes(size))
		} else {
			res.Text += fmt.Sprintf("\n(the artifact drawer copy failed: %s — the state-dir file %s is still written)", err.Error(), res.Export.Path)
		}
	}
	return "OBSERVATION:\n" + res.Text
}
