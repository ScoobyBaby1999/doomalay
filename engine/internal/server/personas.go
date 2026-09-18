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
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// PersonaTrigger is the active-by-trigger condition.
//
// v0.29 (user spec): the KEY comes from a fixed list (the built-in globals
// {name} {model} {provider}, the live metrics messages/turns, plus every
// custom placeholder — global or local) and the VALUE may be a string
// ("anthropic") or a number (10). Older sessions stored numeric JSON
// values; UnmarshalJSON below converts them so nothing breaks.
type PersonaTrigger struct {
	Key   string `json:"key"`   // built-in / global / local placeholder key
	Op    string `json:"op"`    // "=" | "<" | ">" | "!=" (<=, >= tolerated)
	Value string `json:"value"` // string or numeric threshold
}

// UnmarshalJSON accepts value as string OR number (legacy personas stored
// {"value": 10}); numbers become their shortest decimal string.
func (t *PersonaTrigger) UnmarshalJSON(b []byte) error {
	var raw struct {
		Key   string `json:"key"`
		Op    string `json:"op"`
		Value any    `json:"value"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t.Key = raw.Key
	t.Op = raw.Op
	switch v := raw.Value.(type) {
	case nil:
		t.Value = ""
	case string:
		t.Value = v
	case float64:
		t.Value = strconv.FormatFloat(v, 'g', -1, 64)
	case bool:
		t.Value = strconv.FormatBool(v)
	default:
		t.Value = fmt.Sprintf("%v", v)
	}
	return nil
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
			enforceSingleActive(specs) // v0.28: one always-active persona, max
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
	case "always", "shuffle", "trigger", "inactive":
	default:
		s.Mode = "always"
	}
	if s.Mode == "trigger" && s.Trigger == nil {
		// a trigger persona without a condition can never fire — treat as always
		s.Mode = "always"
	}
}

// enforceSingleActive keeps the v0.28 user rule — exactly ONE persona is
// ever "always active": the first always stays, every later one is demoted
// to inactive (a fresh persona defaults to inactive; activating one demotes
// the previous). Runs on every parse so stored lists migrate lazily.
func enforceSingleActive(specs []PersonaSpec) {
	seen := false
	for i := range specs {
		if specs[i].Mode == "always" {
			if seen {
				specs[i].Mode = "inactive"
			}
			seen = true
		}
	}
}

// parsePlaceholders decodes the chat's LOCAL custom placeholder map
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

// globalPlaceholderKey is the app_settings row that holds the GLOBAL
// custom placeholders (the ones every chatbot recognizes) as one JSON map.
const globalPlaceholderKey = "global_placeholders"

// globalPlaceholders reads the engine-wide custom placeholder map.
// Nil-DB safe (unit tests construct Servers without one).
func (s *Server) globalPlaceholders() map[string]string {
	if s == nil || s.db == nil {
		return map[string]string{}
	}
	raw, err := s.db.GetSetting(globalPlaceholderKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		return map[string]string{}
	}
	m := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return map[string]string{}
	}
	return m
}

// setGlobalPlaceholder upserts one global placeholder (persisted).
func (s *Server) setGlobalPlaceholder(key, value string) error {
	ph := s.globalPlaceholders()
	ph[key] = value
	raw, err := json.Marshal(ph)
	if err != nil {
		return err
	}
	return s.db.SetSetting(globalPlaceholderKey, string(raw))
}

// deleteGlobalPlaceholder removes one global placeholder (idempotent).
func (s *Server) deleteGlobalPlaceholder(key string) error {
	ph := s.globalPlaceholders()
	if _, ok := ph[key]; !ok {
		return nil
	}
	delete(ph, key)
	raw, err := json.Marshal(ph)
	if err != nil {
		return err
	}
	return s.db.SetSetting(globalPlaceholderKey, string(raw))
}

// mergedPlaceholders = the GLOBAL customs + this chat's LOCAL customs,
// local winning on key collisions (the chat is the more specific scope).
// This is the map that substitutes into personas AND feeds trigger keys.
func (s *Server) mergedPlaceholders(sess *store.Session) map[string]string {
	ph := s.globalPlaceholders()
	for k, v := range parsePlaceholders(sess) {
		ph[k] = v
	}
	return ph
}

// resolveActivePersona picks THE persona in effect for this turn:
//  1. the FIRST trigger persona whose condition is satisfied (list order
//     = priority — "when the number is met the persona is activated"),
//  2. else the first ALWAYS persona ("always active means that persona
//     is the one that is used" — deterministic beats random; v0.28: the
//     single-active rule guarantees there is at most one),
//  3. else the session's shuffle roll (one random shuffle persona,
//     cached per engine process — re-rolled on restart),
//  4. else nil → the app default persona (v0.28: an all-inactive list is
//     the user's explicit way of saying "run on the app default").
func resolveActivePersona(sess *store.Session, m personaMetrics) *PersonaSpec {
	return currentServer.resolveActivePersonaMerged(parsePersonas(sess), sess, m)
}

// resolveActivePersonaMerged — v0.29: needs the Server for the GLOBAL
// custom placeholders (trigger keys may live there).
func (s *Server) resolveActivePersonaMerged(specs []PersonaSpec, sess *store.Session, m personaMetrics) *PersonaSpec {
	if len(specs) == 0 {
		return nil
	}
	ph := s.mergedPlaceholders(sess)

	// 1. trigger personas (in order).
	for i := range specs {
		if specs[i].Mode == "trigger" && s.triggerSatisfied(sess, specs[i].Trigger, ph, m) {
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
	// 4. v0.28: all-inactive (or all-trigger with nothing satisfied) —
	// the app's built-in default persona takes over. Returning an
	// INACTIVE persona here would silently ignore the user's off switch.
	if specs[0].Mode == "inactive" {
		return nil
	}
	return &specs[0]
}

// currentServer is set by New() so the package-level resolveActivePersona
// (kept for the tests + older call shapes) can reach the DB-backed GLOBAL
// placeholders. Single-server process — as everywhere else in the engine.
var currentServer *Server

// runPersonaTool executes the persona_* local tools against a session —
// the bot's hands for its own personality (v0.28 user spec: "the bot
// should be able to [switch/create/edit its persona] easily").
// Returns an OBSERVATION-shaped string; errors are observations too.
func (s *Server) runPersonaTool(sessID, name, argJSON string) string {
	sess, err := s.db.GetSession(sessID)
	if err != nil || sess == nil {
		return "OBSERVATION:\nerror: session not found"
	}
	var args map[string]any
	if strings.TrimSpace(argJSON) != "" {
		if err := json.Unmarshal([]byte(argJSON), &args); err != nil {
			return "OBSERVATION:\nerror: arguments must be a JSON object — " + err.Error()
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	getStr := func(k string) string {
		v, _ := args[k].(string)
		return strings.TrimSpace(v)
	}

	switch name {
	case "persona_list":
		specs := parsePersonas(sess)
		out := make([]map[string]any, 0, len(specs))
		for i := range specs {
			p := specs[i]
			entry := map[string]any{"id": p.ID, "name": p.Name, "mode": p.Mode}
			if p.Trigger != nil {
				entry["trigger"] = p.Trigger
			}
			if p.Text != "" {
				n := len(p.Text)
				if n > 80 {
					entry["text_preview"] = p.Text[:80] + "…"
				} else {
					entry["text_preview"] = p.Text
				}
				entry["text_chars"] = n
			}
			out = append(out, entry)
		}
		ph := parsePlaceholders(sess)
		b, _ := json.Marshal(map[string]any{
			"personas":            out,
			"placeholders":        ph,                     // this chat's local customs
			"global_placeholders": s.globalPlaceholders(), // engine-wide customs
		})
		return "OBSERVATION:\n" + string(b)

	case "persona_set":
		specs := parsePersonas(sess)
		id := getStr("id")
		var target *PersonaSpec
		if id != "" {
			for i := range specs {
				if specs[i].ID == id {
					target = &specs[i]
					break
				}
			}
		}
		isNew := target == nil
		if isNew {
			specs = append(specs, PersonaSpec{ID: fmt.Sprintf("p_%d", rand.Intn(1<<30)), Mode: "inactive"})
			target = &specs[len(specs)-1]
		}
		if v := getStr("name"); v != "" {
			target.Name = v
		}
		if v, ok := args["text"].(string); ok { // "" clears → app default text
			target.Text = v
		}
		// activate: true promotes it to THE always persona (single-active).
		if act, _ := args["activate"].(bool); act {
			for i := range specs {
				if specs[i].Mode == "always" {
					specs[i].Mode = "inactive"
				}
			}
			target.Mode = "always"
		}
		for i := range specs {
			normalizeSpec(&specs[i])
		}
		enforceSingleActive(specs)
		raw, _ := json.Marshal(specs)
		sess.Personas = string(raw)
		if err := s.db.UpdateSession(sess); err != nil {
			return "OBSERVATION:\nerror: " + err.Error()
		}
		verb := "updated"
		if isNew {
			verb = "created (inactive — pass activate:true to make it the active one)"
		}
		return fmt.Sprintf("OBSERVATION:\npersona %s: %s. Current list: %s", target.Name, verb, personaNameList(specs))

	case "persona_activate":
		id := getStr("id")
		if id == "" {
			// no id → deactivate everything (back to the app default)
			specs := parsePersonas(sess)
			for i := range specs {
				specs[i].Mode = "inactive"
			}
			raw, _ := json.Marshal(specs)
			sess.Personas = string(raw)
			if err := s.db.UpdateSession(sess); err != nil {
				return "OBSERVATION:\nerror: " + err.Error()
			}
			return "OBSERVATION:\nall personas deactivated — the app's default persona is now in effect"
		}
		specs := parsePersonas(sess)
		var target *PersonaSpec
		for i := range specs {
			if specs[i].ID == id {
				target = &specs[i]
				break
			}
		}
		if target == nil {
			return "OBSERVATION:\nerror: no persona with id " + id + " — list them with persona_list"
		}
		for i := range specs {
			if specs[i].Mode == "always" {
				specs[i].Mode = "inactive"
			}
		}
		target.Mode = "always"
		raw, _ := json.Marshal(specs)
		sess.Personas = string(raw)
		if err := s.db.UpdateSession(sess); err != nil {
			return "OBSERVATION:\nerror: " + err.Error()
		}
		return fmt.Sprintf("OBSERVATION:\n%s is now the always-active persona (any previous one was deactivated). List: %s", target.Name, personaNameList(specs))

	case "placeholder_set":
		key := getStr("key")
		if key == "" {
			return "OBSERVATION:\nerror: placeholder_set needs {\"key\": \"...\", \"value\": \"...\"}"
		}
		value, _ := args["value"].(string)
		// v0.29: scope — "local" (this chat only, the default) or
		// "global" (recognized by every chatbot).
		scope := getStr("scope")
		if scope == "" {
			scope = "local"
		}
		if scope != "local" && scope != "global" {
			return "OBSERVATION:\nerror: scope must be \"local\" or \"global\""
		}
		if err := s.setPlaceholder(sess, key, value, scope); err != nil {
			return "OBSERVATION:\nerror: " + err.Error()
		}
		where := "this chat"
		if scope == "global" {
			where = "every chat (global)"
		}
		return "OBSERVATION:\nplaceholder {" + key + "} set for " + where + " — usable in personas and as a trigger key"
	}
	return "OBSERVATION:\nerror: unknown persona tool " + name
}

// setPlaceholder writes one custom placeholder, local (the session's map)
// or global (the engine-wide map).
func (s *Server) setPlaceholder(sess *store.Session, key, value, scope string) error {
	if scope == "global" {
		return s.setGlobalPlaceholder(key, value)
	}
	ph := parsePlaceholders(sess)
	ph[key] = value
	raw, err := json.Marshal(ph)
	if err != nil {
		return err
	}
	sess.Placeholders = string(raw)
	return s.db.UpdateSession(sess)
}

func personaNameList(specs []PersonaSpec) string {
	parts := make([]string, 0, len(specs))
	for i := range specs {
		parts = append(parts, specs[i].Name+" ("+specs[i].Mode+")")
	}
	return strings.Join(parts, ", ")
}

// triggerSatisfied evaluates {key op value}. v0.29 keys:
//   - the built-in GLOBALS  {name} {model} {provider} (string compares,
//     case-insensitive equality)
//   - the live METRICS      messages / turns (numeric)
//   - any custom placeholder (global or local; numeric when both sides
//     parse as numbers, else string)
//
// Ordering ops on non-numeric values are false — never an error, the
// persona simply doesn't fire.
func (s *Server) triggerSatisfied(sess *store.Session, t *PersonaTrigger, ph map[string]string, m personaMetrics) bool {
	if t == nil || strings.TrimSpace(t.Key) == "" {
		return false
	}
	key := strings.TrimSpace(t.Key)
	cur, isStr := "", false
	switch key {
	case "messages", "message_count":
		cur = strconv.Itoa(m.Messages)
	case "turns", "turn_count":
		cur = strconv.Itoa(m.Turns)
	case "name":
		cur = strings.TrimSpace(sess.Title)
		isStr = true
	case "model":
		cur = prettyModelName(sess.Model)
		isStr = true
	case "provider":
		cur = providerLabel(sess.Provider)
		isStr = true
	default:
		v, ok := ph[key]
		if !ok {
			return false
		}
		cur = strings.TrimSpace(v)
		if _, err := strconv.ParseFloat(cur, 64); err != nil {
			isStr = true // a text-valued custom placeholder
		}
	}
	want := strings.TrimSpace(t.Value)
	// Numeric comparison when BOTH sides are numbers.
	if !isStr {
		if cn, err1 := strconv.ParseFloat(cur, 64); err1 == nil {
			if wn, err2 := strconv.ParseFloat(want, 64); err2 == nil {
				return cmpNum(cn, t.Op, wn)
			}
		}
	}
	// String comparison: = / != are case-insensitive; ordering is false.
	switch t.Op {
	case "=", "==":
		return strings.EqualFold(cur, want)
	case "!=", "<>":
		return !strings.EqualFold(cur, want)
	}
	return false
}

func cmpNum(cur float64, op string, want float64) bool {
	switch op {
	case "=", "==":
		return cur == want
	case "<":
		return cur < want
	case ">":
		return cur > want
	case "!=", "<>":
		return cur != want
	case "<=":
		return cur <= want
	case ">=":
		return cur >= want
	}
	return false
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

// ── v0.29: the GLOBAL placeholders API ──────────────────────────────
//
//   GET    /api/placeholders           {"placeholders": {k: v, …}}
//   PUT    /api/placeholders           {"key": "k", "value": "v"} → upsert
//   DELETE /api/placeholders/{key}     remove
//
// The UI merges these with the chat's LOCAL map (session PATCH, unchanged);
// the engine does the same on every turn (mergedPlaceholders).

func (s *Server) handlePlaceholdersGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"placeholders": s.globalPlaceholders(),
		"builtin":      []string{"name", "model", "provider", "skills", "messages", "turns"},
	})
}

func (s *Server) handlePlaceholdersSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad JSON: "+err.Error())
		return
	}
	req.Key = strings.TrimSpace(strings.Trim(req.Key, "{}"))
	if req.Key == "" || !validPlaceholderKey(req.Key) {
		writeError(w, 400, "key must be letters, numbers and _ (built-ins are reserved)")
		return
	}
	switch req.Key {
	case "name", "model", "provider", "skills", "messages", "turns":
		writeError(w, 400, req.Key+" is built-in — pick another key")
		return
	}
	if err := s.setGlobalPlaceholder(req.Key, req.Value); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "key": req.Key, "value": req.Value})
}

func (s *Server) handlePlaceholdersDelete(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(strings.Trim(r.PathValue("key"), "{}"))
	if key == "" {
		writeError(w, 400, "key is required")
		return
	}
	if err := s.deleteGlobalPlaceholder(key); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// validPlaceholderKey: [A-Za-z0-9_]+ (mirrors the web UI's add box).
func validPlaceholderKey(k string) bool {
	if k == "" {
		return false
	}
	for _, c := range k {
		if !(c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}
