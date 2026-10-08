package config

// config_termux_test.go — v1.17.2 THE BRIDGE: the Termux bridge URL config
// precedence (CLI flag > $DOOMALAY_TERMUX_BRIDGE > YAML > unset) + the
// trailing-slash hygiene the client relies on.

import (
	"path/filepath"
	"testing"
)

func loadForTermuxTest(t *testing.T, ov Overrides) *Config {
	t.Helper()
	// Point DOOMALAY_CONFIG at a nonexistent file so no machine-local
	// ~/.config/doomalay/config.yaml can leak into the test. The
	// DOOMALAY_TERMUX_BRIDGE env is the tests' own knob (t.Setenv restores
	// each one at test end).
	t.Setenv("DOOMALAY_CONFIG", filepath.Join(t.TempDir(), "nonexistent.yaml"))
	cfg, err := Load("", ov)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

func TestTermuxBridge_UnsetByDefault(t *testing.T) {
	t.Setenv("DOOMALAY_TERMUX_BRIDGE", "")
	cfg := loadForTermuxTest(t, Overrides{DataDir: t.TempDir()})
	if cfg.TermuxBridge != "" {
		t.Fatalf("termux bridge must be unset by default, got %q", cfg.TermuxBridge)
	}
}

func TestTermuxBridge_EnvSetsIt(t *testing.T) {
	t.Setenv("DOOMALAY_TERMUX_BRIDGE", "http://127.0.0.1:8081/tok")
	cfg := loadForTermuxTest(t, Overrides{DataDir: t.TempDir()})
	if cfg.TermuxBridge != "http://127.0.0.1:8081/tok" {
		t.Fatalf("env should set the bridge, got %q", cfg.TermuxBridge)
	}
}

func TestTermuxBridge_FlagWinsOverEnv(t *testing.T) {
	t.Setenv("DOOMALAY_TERMUX_BRIDGE", "http://127.0.0.1:8081/env-tok")
	cfg := loadForTermuxTest(t, Overrides{DataDir: t.TempDir(), TermuxBridge: "http://127.0.0.1:8082/flag-tok"})
	if cfg.TermuxBridge != "http://127.0.0.1:8082/flag-tok" {
		t.Fatalf("flag must beat env, got %q", cfg.TermuxBridge)
	}
}

func TestTermuxBridge_TrailingSlashTrimmed(t *testing.T) {
	t.Setenv("DOOMALAY_TERMUX_BRIDGE", "http://127.0.0.1:8081/tok//")
	cfg := loadForTermuxTest(t, Overrides{DataDir: t.TempDir()})
	if cfg.TermuxBridge != "http://127.0.0.1:8081/tok" {
		t.Fatalf("trailing slashes must be trimmed, got %q", cfg.TermuxBridge)
	}
}
