package server

// personas.go — v0.26 the MULTI-PERSONA system (user spec):
//
//   "Let's have a chat be able to have multiple personas. So a user can
//    click the personas pill and have a cloud provider style UI overlay
//    pop up displaying a list of all of that chats personas. Every chat
//    comes with our default persona, a user may click to add a new
//    persona... The user may rename and delete personas too."
//
//   Activation modes (the 'always active' pill in the editor):
//     always   — that persona is THE one used.
//     shuffle  — a random member of the shuffle pool is picked every time
//                the chat is re-established or the app restarts (the pick
//                is cached per engine process + re-rolled on restart).
//     trigger  — activated when a metric satisfies {key op value}
//                (op = | < | > | != , value = float). Keys: built-in
//                live metrics (messages, turns) or any custom
//                placeholder whose value parses as a number.
//
// Placeholders (substituted into every persona EVERY turn):
//   {name}     the chat's own name (Scooby, Lippy, Crippy…)
//   {model}    the live model (already v0.20)
//   {provider} the live provider label (already v0.20)
//   {skills}   stub — intentionally inert for now; later this points at
//              the chat's skills + MCP servers. Substitutes a short
//              "(none configured yet)" note so personas never carry
//              broken literal syntax to the model.
//   {custom}   any key the user defines on the chat (value from the
//              chat's placeholder map; numeric values also feed triggers).

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// PersonaTrigger is the active-by-trigger condition.
type PersonaTrigger struct {
	Key   string  `json:"key"`   // metric / custom placeholder key
	Op    string  `json:"op"`    // "=" | "<" | ">" | "!="
	Value float64 `json:"value"` // numeric threshold
}

// PersonaSpec is ONE persona of a chat (stored as a JSON array on the
// session's `personas` column).
type PersonaSpec struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Text    string          `json:"text"`
	Mode    string          `json:"mode"`    // always | shuffle | trigger
	Trigger *PersonaTrigger `json:"trigger"` // mode == trigger
}

// personaMetrics are the live numbers triggers evaluate against.
type personaMetrics struct {
	Messages int // folded messages in the model-visible history
	Turns    int // user turns
}

// shufflePicks caches this engine process's shuffle roll per session
// (re-rolled on restart — "selected at random every time the chat is
// re-established or the app is restarted").
var (
	shuffleMu    sync.Mutex
	shufflePicks = map[string]string{} // sessionID → persona ID
)

// countUserTurns counts the user messages in a history slice (the
// incoming message is appended by the caller, hence the +1 there).
func countUserTurns(history []llm.Message) int {
	n := 0
	for i := range history {
		if history[i].Role == "user" {
			n++
		}
	}
	return n
}

// parsePersonas decodes the session's personas JSON; empty/legacy sessions
// with a single persona text degrade to one "Default" always-active persona.
func parsePersonas(sess *store.Session) []PersonaSpec {
	raw := strings.TrimSpace(sess.Personas)
	if raw != "" {
		var specs []PersonaSpec
		if err := json.Unmarshal([]byte(raw), &specs); err == nil && len(specs) > 0 {
			for i := range specs {
				normalizeSpec(&specs[i])
			}
			return specs
		}
	}
	// Legacy single-persona migration: the v0.19 `persona` column.
	if p := strings.TrimSpace(sess.Persona); p != "" {
		return []PersonaSpec{{
			ID:   "p_default",
			Name: "Default",
			Text: p,
			Mode: "always",
		}}
	}
	return nil
}

func normalizeSpec(s *PersonaSpec) {
	s.ID = strings.TrimSpace(s.ID)
	if s.ID == "" {
		s.ID = fmt.Sprintf("p_%d", rand.Intn(1<<24))
	}
	s.Name = strings.TrimSpace(s.Name)
	if s.Name == "" {
		s.Name = "Persona"
	}
	switch s.Mode {
	case "always", "shuffle", "trigger":
	default:
		s.Mode = "always"
	}
	if s.Mode == "trigger" && s.Trigger == nil {
		// a trigger persona without a condition can never fire — treat as always
		s.Mode = "always"
	}
}

// parsePlaceholders decodes the chat's custom placeholder map
// ({"mood":"playful","level":"7"}). Malformed → empty map.
func parsePlaceholders(sess *store.Session) map[string]string {
	raw := strings.TrimSpace(sess.Placeholders)
	if raw == "" {
		return map[string]string{}
	}
	m := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return map[string]string{}
	}
	return m
}

// resolveActivePersona picks THE persona in effect for this turn:
//  1. the FIRST trigger persona whose condition is satisfied (list order
//     = priority — "when the number is met the persona is activated"),
//  2. else the first ALWAYS persona ("always active means that persona
//     is the one that is used" — deterministic beats random),
//  3. else the session's shuffle roll (one random shuffle persona,
//     cached per engine process — re-rolled on restart),
//  4. else nil → the app default persona.
func resolveActivePersona(sess *store.Session, m personaMetrics) *PersonaSpec {
	specs := parsePersonas(sess)
	if len(specs) == 0 {
		return nil
	}
	ph := parsePlaceholders(sess)

	// 1. trigger personas (in order).
	for i := range specs {
		if specs[i].Mode == "trigger" && triggerSatisfied(specs[i].Trigger, ph, m) {
			return &specs[i]
		}
	}
	// 2. always personas (first wins — deterministic).
	for i := range specs {
		if specs[i].Mode == "always" {
			return &specs[i]
		}
	}
	// 3. shuffle pool.
	var pool []*PersonaSpec
	for i := range specs {
		if specs[i].Mode == "shuffle" {
			pool = append(pool, &specs[i])
		}
	}
	if len(pool) > 0 {
		shuffleMu.Lock()
		pick, ok := shufflePicks[sess.ID]
		shuffleMu.Unlock()
		if ok {
			for i := range pool {
				if pool[i].ID == pick {
					return pool[i]
				}
			}
		}
		// (re-)roll — cached until the engine restarts or the pick vanishes.
		chosen := pool[rand.Intn(len(pool))]
		shuffleMu.Lock()
		shufflePicks[sess.ID] = chosen.ID
		shuffleMu.Unlock()
		return chosen
	}
	// 4. anything at all (all-trigger list with nothing satisfied).
	return &specs[0]
}

// triggerSatisfied evaluates {key op value} against the custom placeholders
// (numeric values) + the built-in metrics.
func triggerSatisfied(t *PersonaTrigger, ph map[string]string, m personaMetrics) bool {
	if t == nil || strings.TrimSpace(t.Key) == "" {
		return false
	}
	var cur float64
	switch strings.TrimSpace(t.Key) {
	case "messages", "message_count":
		cur = float64(m.Messages)
	case "turns", "turn_count":
		cur = float64(m.Turns)
	default:
		v, ok := ph[strings.TrimSpace(t.Key)]
		if !ok {
			return false
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return false
		}
		cur = n
	}
	switch t.Op {
	case "=", "==":
		return cur == t.Value
	case "<":
		return cur < t.Value
	case ">":
		return cur > t.Value
	case "!=", "<>":
		return cur != t.Value
	case "<=":
		return cur <= t.Value
	case ">=":
		return cur >= t.Value
	default:
		return false
	}
}

// substituteAllVars replaces every placeholder in a persona text:
// {name} {model} {provider} {skills} + the chat's custom {key}s.
// Unknown {keys} are left literal (the user may be writing about
// syntax, not using a placeholder).
func substituteAllVars(text, chatName, model, provider string, ph map[string]string) string {
	if !strings.Contains(text, "{") {
		return text
	}
	m := prettyModelName(model)
	if m == "" {
		m = "an AI assistant"
	}
	r := strings.NewReplacer(
		"{name}", strings.TrimSpace(chatName),
		"{model}", m,
		"{provider}", providerLabel(provider),
		"{skills}", "(no skills attached yet)",
	)
	out := r.Replace(text)
	// custom placeholders — longest keys first (a {a} must not eat {ab}).
	keys := make([]string, 0, len(ph))
	for k := range ph {
		if strings.TrimSpace(k) != "" {
			keys = append(keys, k)
		}
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if len(keys[j]) > len(keys[i]) {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	for _, k := range keys {
		out = strings.ReplaceAll(out, "{"+k+"}", ph[k])
	}
	return out
}
