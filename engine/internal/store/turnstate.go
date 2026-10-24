// turnstate.go — v1.73.0 TURN STATE PERSISTENCE
//
// Persists per-turn state to DB so it can survive engine restarts
// and be restored for auto-resume by RetrySentinel.

package store

import (
	"encoding/json"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
)

// TurnState represents the complete state of a chat turn at a point in time.
type TurnState struct {
	SessionID    string          `json:"session_id"`
	Turn         int64           `json:"turn"`
	Round        int             `json:"round"`
	Messages     []llm.Message   `json:"messages"`
	PartialOut   string          `json:"partial_out"`      // accumulated assistant content this turn
	ToolResults  []ToolResultLog `json:"tool_results"`     // executed tools + observations
	FSMPhase     string          `json:"fsm_phase"`        // turn FSM phase
	UpdatedAt    time.Time       `json:"updated_at"`
}

// ToolResultLog records one executed tool + its observation.
type ToolResultLog struct {
	Name        string    `json:"name"`
	Args        string    `json:"args"`
	Observation string    `json:"observation"`
	Round       int       `json:"round"`
	DurationMs  int64     `json:"duration_ms"`
	Phases      []string  `json:"phases"`
	CompletedAt time.Time `json:"completed_at"`
}

// turnStateKey prefixes the DB key.
func turnStateKey(sid string) string { return "turn.state." + sid }

// SaveTurnState persists the current turn state.
func (db *DB) SaveTurnState(ts TurnState) error {
	if db == nil {
		return nil
	}
	b, err := json.Marshal(ts)
	if err != nil {
		return err
	}
	return db.SetSetting(turnStateKey(ts.SessionID), string(b))
}

// LoadTurnState retrieves the persisted turn state.
func (db *DB) LoadTurnState(sid string) (TurnState, error) {
	var ts TurnState
	if db == nil {
		return ts, nil
	}
	raw, err := db.GetSetting(turnStateKey(sid))
	if err != nil || raw == "" {
		return ts, err
	}
	err = json.Unmarshal([]byte(raw), &ts)
	return ts, err
}

// DeleteTurnState removes the persisted turn state.
func (db *DB) DeleteTurnState(sid string) error {
	if db == nil {
		return nil
	}
	return db.DeleteSetting(turnStateKey(sid))
}

// AppendToolResult adds a tool result to the turn state and saves.
func (db *DB) AppendToolResult(sid string, log ToolResultLog) error {
	if db == nil {
		return nil
	}
	ts, err := db.LoadTurnState(sid)
	if err != nil {
		return err
	}
	ts.ToolResults = append(ts.ToolResults, log)
	ts.UpdatedAt = time.Now()
	return db.SaveTurnState(ts)
}

// UpdateTurnProgress updates the turn's progress (round, partial output, FSM phase).
func (db *DB) UpdateTurnProgress(sid string, round int, partialOut, fsmPhase string) error {
	if db == nil {
		return nil
	}
	ts, err := db.LoadTurnState(sid)
	if err != nil {
		return err
	}
	ts.Round = round
	ts.PartialOut = partialOut
	ts.FSMPhase = fsmPhase
	ts.UpdatedAt = time.Now()
	return db.SaveTurnState(ts)
}