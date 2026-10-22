package server

// retrysentinel.go — v1.61.3 THE RETRY SENTINEL (PLAN-V161 §v1.61.3,
// Class D). THE USER'S ORDER: "Whenever a turn gets dropped due to
// network or another thing that requires the user to press continue…
// start a timer that probes… the timer can be customisable, default to
// like 5-10 mins per signal… every chat that gets interrupted for the
// same reason can join and listen to the appropriate dynamic timer.
// When the signal triggers (429 works, network is back) auto-
// continuation occurs (user doesn't have to tap continue) and the
// dynamic timer is killed, all listeners have their convo continue."
//
// THE SHARED TIMER LAW: one hindrance, one timer, every interrupted
// chat its listener — probes are paid once, recoveries fan out.
//
// The registry keys timers by class|provider ("net|openrouter" ≠
// "net|mistral" — a provider outage is not the device's outage; the
// engine's anyOtherProviderHealthy distinction convicted that).
// Chats parking on the same signal JOIN the live timer. The probes
// are cheap and keyless where possible (a provider's /models endpoint;
// the device classes short-circuit on the WakeNet broadcast). The
// lifecycle pills ride persisted "retry" events the PWA merges into
// ONE live pill (armed → probe N → recovered with the honest elapsed).
//
// Durability: a kv row per armed chat (retry.sentinel.<sid>) survives
// engine restarts (the boot scan re-arms parked chats whose tail is a
// retryable terminal); the attempt count survives re-arms —
// "continued after X retries" counts honestly across restarts.

import (
	"context"
	"io"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/llm"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// sentinelKey prefixes the durability rows ("retry.sentinel.<sid>").
func sentinelKey(sid string) string { return "retry.sentinel." + sid }

// sentinelConfig is the ✦-tweaks row ("retry.sentinel", GLOBAL — the
// user's "all chats" wording). Seconds; default 300 (the user's 5-10
// min ask, the low end); env overrides exist for the rigs.
type sentinelConfig struct {
	Enabled   bool `json:"enabled"`
	NetSec    int  `json:"net"`
	QuotaSec  int  `json:"quota"`  // the 429 class
	ServerSec int  `json:"server"` // the 5xx class
}

func sentinelConfigOf(s *Server) sentinelConfig {
	cfg := sentinelConfig{Enabled: true, NetSec: 300, QuotaSec: 300, ServerSec: 300}
	if s.db != nil {
		if raw, err := s.db.GetSetting("retry.sentinel"); err == nil && raw != "" {
			var row sentinelConfig
			if json.Unmarshal([]byte(raw), &row) == nil {
				if row.NetSec > 0 {
					cfg.NetSec = row.NetSec
				}
				if row.QuotaSec > 0 {
					cfg.QuotaSec = row.QuotaSec
				}
				if row.ServerSec > 0 {
					cfg.ServerSec = row.ServerSec
				}
				cfg.Enabled = row.Enabled
			}
		}
	}
	// the rig knobs (DOOMALAY_SENTINEL_NET_S / _QUOTA_S / _SERVER_S / _ENABLED)
	if v := envInt("DOOMALAY_SENTINEL_NET_S"); v > 0 {
		cfg.NetSec = v
	}
	if v := envInt("DOOMALAY_SENTINEL_QUOTA_S"); v > 0 {
		cfg.QuotaSec = v
	}
	if v := envInt("DOOMALAY_SENTINEL_SERVER_S"); v > 0 {
		cfg.ServerSec = v
	}
	if v := os.Getenv("DOOMALAY_SENTINEL_ENABLED"); v == "0" || v == "false" {
		cfg.Enabled = false
	}
	return cfg
}

func envInt(key string) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return 0
}

// sentinelDur — the class's configured interval.
func (c sentinelConfig) intervalFor(class string) time.Duration {
	switch class {
	case "429":
		return time.Duration(c.QuotaSec) * time.Second
	case "5xx":
		return time.Duration(c.ServerSec) * time.Second
	default:
		return time.Duration(c.NetSec) * time.Second
	}
}

// retryTimer — ONE shared dynamic timer for one class|provider signal.
type retryTimer struct {
	rs           *retrySentinel
	key          string // class|provider
	class        string
	provider     string
	interval     time.Duration
	retryAfterMS int64 // the provider's own header clamp (first probe only)

	mu        sync.Mutex
	listeners map[string]bool // sids
	attempts  int             // probes made (kv-survived across re-arms)
	startedAt time.Time       // the honest elapsed anchor (first arm)
	nextAt    time.Time       // the next probe (pill countdown)
	stopped   bool
	stop      chan struct{}
}

// retrySentinel — the registry (lazy, one per Server).
type retrySentinel struct {
	s      *Server
	mu     sync.Mutex
	timers map[string]*retryTimer
}

// sentinelFor — the lazy singleton.
func (s *Server) sentinelFor() *retrySentinel {
	s.sentinelOnce.Do(func() {
		s.sentinel = &retrySentinel{s: s, timers: map[string]*retryTimer{}}
	})
	return s.sentinel
}

// sentinelDurRow — the per-chat durability row.
type sentinelDurRow struct {
	Class        string `json:"class"`
	Provider     string `json:"provider"`
	Attempts     int    `json:"attempts"`
	StartedAtMS  int64  `json:"started_at_ms"`
	RetryAfterMS int64  `json:"retry_after_ms"`
}

// Arm hooks one chat onto the shared dynamic timer for its retryable
// signal. pill controls the lifecycle row (armed / busy — the honest
// re-listen after a busy skip is quiet). The provider's Retry-After
// (OpenRouter-documented) clamps the FIRST probe only.
func (rs *retrySentinel) Arm(sid, provider, class string, retryAfterMS int64, pill string) {
	s := rs.s
	if sid == "" || class == "" {
		return
	}
	cfg := sentinelConfigOf(s)
	if !cfg.Enabled {
		return
	}
	if pill == "" {
		pill = "armed"
	}
	key := class + "|" + provider
	now := time.Now()

	var (
		startedAt time.Time
		attempts  int
		nextAtMS  int64
		start     bool
		stopCh    chan struct{}
	)
	rs.mu.Lock()
	t := rs.timers[key]
	if t != nil {
		t.mu.Lock()
		if t.stopped {
			t.mu.Unlock()
			delete(rs.timers, key) // a stopped timer lost the race — build fresh
		} else {
			t.listeners[sid] = true
			t.retryAfterMS = retryAfterMS
			next := t.interval
			if t.retryAfterMS > 0 && time.Duration(t.retryAfterMS)*time.Millisecond < next {
				next = time.Duration(t.retryAfterMS) * time.Millisecond
			}
			t.nextAt = now.Add(next)
			startedAt = t.startedAt
			attempts = t.attempts
			nextAtMS = t.nextAt.UnixMilli()
			t.mu.Unlock()
			rs.mu.Unlock()
			rs.saveRow(sid, class, provider, attempts, startedAt, retryAfterMS)
			rs.pill(sid, pill, class, provider, attempts, nextAtMS, startedAt.UnixMilli(), "")
			return
		}
	}
	// fresh timer — this listener is the first (the startedAt anchor)
	t = &retryTimer{
		rs: rs, key: key, class: class, provider: provider,
		interval:     cfg.intervalFor(class),
		retryAfterMS: retryAfterMS,
		listeners:    map[string]bool{sid: true},
		startedAt:    now,
		stop:         make(chan struct{}),
	}
	t.nextAt = now.Add(t.firstDelay())
	startedAt = t.startedAt
	attempts = t.attempts
	nextAtMS = t.nextAt.UnixMilli()
	rs.timers[key] = t
	stopCh = t.stop
	start = true
	rs.mu.Unlock()

	rs.saveRow(sid, class, provider, attempts, startedAt, retryAfterMS)
	rs.pill(sid, pill, class, provider, attempts, nextAtMS, startedAt.UnixMilli(), "")
	if start {
		_ = stopCh
		go t.loop()
	}
}

// firstDelay — the first probe's wait: the provider's own Retry-After
// (OpenRouter-documented) clamps below the configured interval.
func (t *retryTimer) firstDelay() time.Duration {
	if t.retryAfterMS > 0 {
		d := time.Duration(t.retryAfterMS) * time.Millisecond
		if d < t.interval {
			return d
		}
	}
	return t.interval
}

// listenersOf — the sid list (a copy) under the timer's lock.
func (rs *retrySentinel) listenersOf(key string) []string {
	rs.mu.Lock()
	t := rs.timers[key]
	rs.mu.Unlock()
	if t == nil {
		return nil
	}
	t.mu.Lock()
	out := make([]string, 0, len(t.listeners))
	for sid := range t.listeners {
		out = append(out, sid)
	}
	t.mu.Unlock()
	return out
}

// saveRow persists the per-chat durability row.
func (rs *retrySentinel) saveRow(sid, class, provider string, attempts int, started time.Time, retryAfterMS int64) {
	if rs.s.db == nil {
		return
	}
	row := sentinelDurRow{Class: class, Provider: provider, Attempts: attempts, StartedAtMS: started.UnixMilli(), RetryAfterMS: retryAfterMS}
	b, err := json.Marshal(row)
	if err != nil {
		return
	}
	if err := rs.s.db.SetSetting(sentinelKey(sid), string(b)); err != nil {
		log.Printf("sentinel: save row %s: %v", sid, err)
	}
}

// dropRow deletes the per-chat durability row.
func (rs *retrySentinel) dropRow(sid string) {
	if rs.s.db == nil {
		return
	}
	_ = rs.s.db.DeleteSetting(sentinelKey(sid))
}

// Disarm removes one listener (manual continue/send/delete). The LAST
// listener out kills the timer (the user's law: the dynamic timer dies
// when its signal resolves or nobody listens).
func (rs *retrySentinel) Disarm(sid string) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for key, t := range rs.timers {
		t.mu.Lock()
		had := t.listeners[sid]
		delete(t.listeners, sid)
		empty := len(t.listeners) == 0
		t.mu.Unlock()
		if had {
			rs.dropRow(sid)
		}
		if empty && !t.stopped {
			t.stopped = true
			close(t.stop)
			delete(rs.timers, key)
		}
	}
}

// pill emits one persisted "retry" lifecycle row (the PWA merges the
// consecutive rows into ONE live pill — v1.61.4's face).
func (rs *retrySentinel) pill(sid, phase, class, provider string, attempts int, nextAtMS, startedAtMS int64, note string) {
	s := rs.s
	if s.db == nil || sid == "" {
		return
	}
	ev := map[string]any{
		"phase":      phase,
		"class":      class,
		"provider":   provider,
		"attempts":   attempts,
		"next_at":    nextAtMS,
		"started_at": startedAtMS,
	}
	if note != "" {
		ev["note"] = note
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	s.emit(pipeFor(sid), sid, "retry", string(b), "")
}

// loop — the timer goroutine: wait → probe → fan-out or pace.
func (t *retryTimer) loop() {
	s := t.rs.s
	for {
		t.mu.Lock()
		next := time.Until(t.nextAt)
		t.mu.Unlock()
		if next < 250*time.Millisecond {
			next = 250 * time.Millisecond
		}
		var wakeCh <-chan struct{}
		if t.class == "net" {
			wakeCh = llm.WakeNetCh() // the device net classes short-circuit on the broadcast
		}
		var timerC <-chan time.Time
		if next > 0 {
			timerC = time.After(next)
		}
		select {
		case <-t.stop:
			return
		case <-wakeCh:
			// connectivity regained (the Kotlin NetworkCallback → the engine
			// route → llm.WakeNet) — probe NOW, not at the next rung
		case <-timerC:
		}
		t.mu.Lock()
		if t.stopped {
			t.mu.Unlock()
			return
		}
		t.mu.Unlock()

		ok := t.probe()
		t.mu.Lock()
		if t.stopped {
			t.mu.Unlock()
			return
		}
		if ok {
			t.stopped = true
			listeners := make([]string, 0, len(t.listeners))
			for sid := range t.listeners {
				listeners = append(listeners, sid)
			}
			started := t.startedAt
			attempts := t.attempts + 1
			t.listeners = map[string]bool{}
			t.mu.Unlock()
			t.rs.mu.Lock()
			if t.rs.timers[t.key] == t {
				delete(t.rs.timers, t.key)
			}
			t.rs.mu.Unlock()
			close(t.stop)
			// the recovery fans out: every listener auto-continues (staggered
			// 1.5s — the burst-429 protection), the timer is dead, the rows
			// drop, the honest elapsed rides the recovered pill.
			elapsed := time.Since(started)
			class, provider := t.class, t.provider
			for i, sid := range listeners {
				t.rs.dropRow(sid)
				t.rs.pill(sid, "recovered", class, provider, attempts, 0, started.UnixMilli(), durHumanMS(elapsed.Milliseconds()))
				go func(sid string, delay time.Duration) {
					time.Sleep(delay)
					t.rs.autoContinue(sid, class, provider)
				}(sid, time.Duration(i)*1500*time.Millisecond)
			}
			return
		}
		t.attempts++
		t.nextAt = time.Now().Add(t.interval)
		attempts := t.attempts
		nextAtMS := t.nextAt.UnixMilli()
		startedMS := t.startedAt.UnixMilli()
		prov := t.provider
		class := t.class
		t.mu.Unlock()
		// the probe row + the kv attempt count (the honest survival)
		for _, sid := range t.rs.listenersOf(t.key) {
			t.rs.pill(sid, "probe", class, prov, attempts, nextAtMS, startedMS, "")
			if row, ok := t.rs.loadRow(sid); ok {
				t.rs.saveRow(sid, row.Class, row.Provider, attempts, time.UnixMilli(row.StartedAtMS), row.RetryAfterMS)
			}
		}
		_ = s
	}
}

// loadRow reads the durability row (ok=false when absent/garbage).
func (rs *retrySentinel) loadRow(sid string) (sentinelDurRow, bool) {
	var row sentinelDurRow
	if rs.s.db == nil {
		return row, false
	}
	raw, err := rs.s.db.GetSetting(sentinelKey(sid))
	if err != nil || raw == "" {
		return row, false
	}
	if json.Unmarshal([]byte(raw), &row) != nil {
		return row, false
	}
	return row, true
}

// probe — ONE cheap signal check for the timer's class.
func (t *retryTimer) probe() bool {
	switch t.class {
	case "net":
		if t.provider == "" {
			// the device class: the wake broadcast is the primary signal
			// (the loop's wakeCh short-circuit); the probe checks the
			// resolver paths came back
			d := netx.Diag()
			return d["system_dns"] == true || d["doh"] == true
		}
		return t.probeProvider()
	case "429", "5xx":
		// the opencode free-limit: the bridge's own health is the cheap
		// probe (the window's state is unknowable without spending a turn
		// — the auto-continue IS the real test; a still-closed window
		// re-parks and re-arms with the attempts preserved, the pills
		// honest all the way).
		if t.provider == "opencode" {
			return t.rs.s.ocServeBridgeAvailable()
		}
		return t.probeProvider()
	}
	return false
}

// probeProvider — GET {base}/models (9s): ANY HTTP answer = the
// provider is reachable again (200 = healthy; even a 401/403 answers
// "reachable" — the auth classes never arm the sentinel anyway, so a
// non-5xx/non-429 answer here means the signal cleared). A transport
// error keeps waiting.
func (t *retryTimer) probeProvider() bool {
	s := t.rs.s
	keys := map[string]string{}
	if s.vault != nil {
		keys = s.vault.AsEnv()
	}
	base, apiKey, ok := llm.ProviderProbeTarget(t.provider, keys)
	if !ok || base == "" {
		// unknown/unkeyed provider: bare reachability via the engine's own
		// netx diag (a device with DNS answers nothing)
		d := netx.Diag()
		return d["system_dns"] == true || d["doh"] == true
	}
	client := &http.Client{Timeout: 9 * time.Second, Transport: netx.Transport()}
	url := strings.TrimSuffix(base, "/") + "/models"
	req, err := http.NewRequestWithContext(context.Background(), "GET", url, nil)
	if err != nil {
		return false
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return false // still down — the timer paces on
	}
	defer resp.Body.Close()
	// v1.61.3: a 429/503 on the probe itself says the signal is STILL
	// live — keep waiting (the window hasn't rolled / still overloaded).
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return false
	}
	return true
}

// autoContinue — the listener's auto-resume. A busy chat (a user turn
// in flight — the user was faster) re-listens QUIETLY: the pill says
// "waiting for your turn to finish" and the next timer pass (a fresh
// timer, re-armed) continues it when the user's turn lands.
func (rs *retrySentinel) autoContinue(sid, class, provider string) {
	s := rs.s
	if s.db == nil || sid == "" {
		return
	}
	if sessionBusy(sid) {
		// the user typed first — their turn owns the chat; re-listen
		// quietly for the next pass (the pill says the truth)
		rs.Arm(sid, provider, class, 0, "busy")
		return
	}
	sess, err := s.db.GetSession(sid)
	if err != nil || sess == nil {
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("PANIC recovered in sentinel auto-continue %s: %v", sid, rec)
			s.emit(pipeFor(sid), sid, "error", `{"error":"panic","message":"internal error — engine recovered"}`, "")
			s.emit(pipeFor(sid), sid, "status", `{"state":"error","usage":null}`, "")
		}
	}()
	log.Printf("sentinel: auto-continuing %s (the %s signal cleared)", sid, "retryable")
	s.continueCore(nil, pipeFor(sid), sid, sess)
}

// durHumanMS renders elapsed milliseconds in the user's grammar
// ("Z:Y hours/minutes elapsed" — hours when >1h, minutes otherwise).
func durHumanMS(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d >= time.Hour {
		h := int(d.Hours())
		m := int(d.Minutes()) % 60
		return fmt.Sprintf("%d:%02d hours", h, m)
	}
	if d >= time.Minute {
		return fmt.Sprintf("%d minutes", int(d.Minutes()))
	}
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}

// sentinelBootScan — the restart re-arm: every durability row whose
// chat still exists and whose tail is a retryable terminal re-arms
// (attempts preserved — "continued after X retries" counts honestly).
func (s *Server) sentinelBootScan() {
	rs := s.sentinelFor()
	if s.db == nil {
		return
	}
	rows, err := s.db.ListSettingsLike("retry.sentinel.")
	if err != nil || len(rows) == 0 {
		return
	}
	n := 0
	for sid, raw := range rows {
		var row sentinelDurRow
		if json.Unmarshal([]byte(raw), &row) != nil || row.Class == "" {
			continue
		}
		sess, err := s.db.GetSession(sid)
		if err != nil || sess == nil {
			s.db.DeleteSetting(sentinelKey(sid)) // the chat is gone — the row dies
			continue
		}
		// only a chat whose tail is STILL the parked terminal re-arms (a
		// chat the user already continued manually has an idle tail)
		events, err := s.db.ListEvents(sid, 0)
		if err != nil || len(events) == 0 {
			continue
		}
		tail := events[len(events)-1]
		if tail.EventType != "status" {
			continue
		}
		if !strings.Contains(tail.Content, `"state":"error"`) {
			// the turn ended idle (a manual continue already landed) — no arm
			continue
		}
		// re-arm with the preserved attempt count
		rs.mu.Lock()
		key := row.Class + "|" + row.Provider
		t := rs.timers[key]
		if t == nil {
			t = &retryTimer{
				rs: rs, key: key, class: row.Class, provider: row.Provider,
				interval:  sentinelConfigOf(s).intervalFor(row.Class),
				listeners: map[string]bool{},
				startedAt: time.UnixMilli(row.StartedAtMS),
				stop:      make(chan struct{}),
			}
			t.attempts = row.Attempts
			rs.timers[key] = t
			t.nextAt = time.Now().Add(t.interval)
			t.listeners[sid] = true
			go t.loop()
		} else {
			t.mu.Lock()
			t.listeners[sid] = true
			t.mu.Unlock()
		}
		rs.mu.Unlock()
		rs.pill(sid, "armed", row.Class, row.Provider, row.Attempts, time.Now().Add(sentinelConfigOf(s).intervalFor(row.Class)).UnixMilli(), row.StartedAtMS, "auto-retry re-armed after engine restart")
		n++
	}
	if n > 0 {
		log.Printf("sentinel: boot scan re-armed %d parked chat(s)", n)
	}
}

// handleRetrySentinelGet is GET /api/retry-sentinel — the ✦ Auto-retry
// section's read (the GLOBAL config row, "all chats").
func (s *Server) handleRetrySentinelGet(w http.ResponseWriter, r *http.Request) {
	cfg := sentinelConfigOf(s)
	writeJSON(w, 200, map[string]any{
		"enabled": cfg.Enabled,
		"net":     cfg.NetSec,
		"quota":   cfg.QuotaSec,
		"server":  cfg.ServerSec,
	})
}

// handleRetrySentinelPut is PUT /api/retry-sentinel — the section's
// write (minutes 1-15 clamped, the user's "customisable" ask).
func (s *Server) handleRetrySentinelPut(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, 500, "no store")
		return
	}
	var row sentinelConfig
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&row); err != nil {
		writeError(w, 400, "bad body: "+err.Error())
		return
	}
	clamp := func(v, dflt int) int {
		if v <= 0 {
			return dflt
		}
		if v < 60 {
			v = 60
		}
		if v > 15*60 {
			v = 15 * 60
		}
		return v
	}
	merged := sentinelConfig{
		Enabled:   row.Enabled, // absent/false = off (the toggle writes true when on)
		NetSec:    clamp(row.NetSec, 300),
		QuotaSec:  clamp(row.QuotaSec, 300),
		ServerSec: clamp(row.ServerSec, 300),
	}
	// the GET shape speaks seconds; keep the stored row the same shape
	b, err := json.Marshal(merged)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := s.db.SetSetting("retry.sentinel", string(b)); err != nil {
		writeError(w, 500, "save: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"enabled": merged.Enabled,
		"net":     merged.NetSec,
		"quota":   merged.QuotaSec,
		"server":  merged.ServerSec,
	})
}
