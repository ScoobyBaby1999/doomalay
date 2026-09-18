// Package config parses the engine's YAML config and applies defaults.
//
// Config locations (in priority order):
//  1. --config /path/to/config.yaml flag
//  2. $DOOMALAY_CONFIG env var
//  3. ~/.config/doomalay/config.yaml
//  4. built-in defaults
//
// Override priority (highest wins):
//  1. CLI flags (Overrides struct passed to Load)
//  2. Environment variables ($PORT, $MODE)
//  3. YAML config file
//  4. Built-in defaults
//
// All overrides are resolved BEFORE any filesystem side effects
// (e.g. MkdirAll on DataDir) — so passing --data-dir on the CLI
// guarantees that directory is the one created, not the default.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the engine runtime configuration.
type Config struct {
	Mode           string   `yaml:"mode"`            // "local" | "hf-demo"
	Port           int      `yaml:"port"`            // default 8080
	BrainDir       string   `yaml:"brain_dir"`       // path to brain/ (default: sibling of engine)
	BrainPort      int      `yaml:"brain_port"`      // default 9090
	DataDir        string   `yaml:"data_dir"`        // SQLite + workspaces (default: ~/.local/share/doomalay)
	OpenBrowser    bool     `yaml:"open_browser"`    // open system browser on start
	AuthToken      string   `yaml:"auth_token"`      // bearer token (REQUIRED for non-localhost access)
	AllowedOrigins []string `yaml:"allowed_origins"` // CORS + WS origin allowlist (e.g. ["https://doomalay.mydomain.com"])
	Bind           string   `yaml:"bind"`            // bind address (default: 127.0.0.1 — localhost only; set to 0.0.0.0 for LAN)

	// v0.31: the Hub (modular library system). HFBase is the Hugging Face
	// instance the hub talks to (default https://huggingface.co; override
	// via DOOMALAY_HUB_HF_BASE — mock-server tests + self-hosted HF later).
	Hub Hub `yaml:"hub"`
}

// Hub is the hub (library system) configuration.
type Hub struct {
	HFBase string `yaml:"hf_base"` // huggingface.co-compatible base URL
}

// Overrides carries CLI flag values into Load. Zero values mean "no override";
// non-zero values take precedence over YAML and env. This struct exists so that
// CLI overrides are applied BEFORE any filesystem side effects (MkdirAll on
// DataDir, etc.) — without it, Load would try to mkdir the default data dir
// (~/.local/share/doomalay, which on Android is /sdcard/.local/share/doomalay
// and is not writable) even when --data-dir was passed on the command line.
type Overrides struct {
	Port        int    // --port
	Bind        string // --bind
	DataDir     string // --data-dir
	OpenBrowser bool   // --open (only overrides if true; default CLI value is false)
}

// Load resolves and parses the config, applying CLI overrides BEFORE any
// filesystem side effects. The path argument is the --config flag value
// (may be "" to use $DOOMALAY_CONFIG or the default ~/.config/doomalay/config.yaml).
func Load(path string, ov Overrides) (*Config, error) {
	cfg := &Config{
		Mode:      "local",
		Port:      8080,
		BrainPort: 9090,
	}

	// Find config file.
	if path == "" {
		path = os.Getenv("DOOMALAY_CONFIG")
	}
	if path == "" {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, ".config", "doomalay", "config.yaml")
		}
	}
	if path != "" {
		if data, err := os.ReadFile(path); err == nil {
			if err := yaml.Unmarshal(data, cfg); err != nil {
				return nil, fmt.Errorf("parse %s: %w", path, err)
			}
		}
	}

	// Apply env overrides (HF Space sets PORT, MODE).
	if p := os.Getenv("PORT"); p != "" {
		fmt.Sscanf(p, "%d", &cfg.Port)
	}
	if m := os.Getenv("MODE"); m != "" {
		cfg.Mode = m
	}
	// v0.31: the hub's Hugging Face base URL (mock-server tests + self-hosted).
	if b := os.Getenv("DOOMALAY_HUB_HF_BASE"); b != "" {
		cfg.Hub.HFBase = b
	}

	// Apply CLI overrides (highest priority, wins over YAML + env).
	if ov.Port != 0 {
		cfg.Port = ov.Port
	}
	if ov.Bind != "" {
		cfg.Bind = ov.Bind
	}
	if ov.DataDir != "" {
		cfg.DataDir = ov.DataDir
	}
	if ov.OpenBrowser {
		cfg.OpenBrowser = true
	}

	// Defaults for paths. Only applied if still empty after all overrides.
	if cfg.Port == 0 {
		cfg.Port = 8080
	}
	if cfg.DataDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cfg.DataDir = filepath.Join(home, ".local", "share", "doomalay")
		} else {
			cfg.DataDir = "./data"
		}
	}
	if cfg.BrainDir == "" {
		// Default: ../brain relative to the engine binary, or ./brain if running from repo root.
		candidates := []string{"../brain", "./brain", "../../brain"}
		for _, c := range candidates {
			if fi, err := os.Stat(c); err == nil && fi.IsDir() {
				cfg.BrainDir = c
				break
			}
		}
		if cfg.BrainDir == "" {
			cfg.BrainDir = "./brain"
		}
	}

	// HF demo mode: data dir is /data, open browser off, bind to all interfaces.
	if cfg.Mode == "hf-demo" {
		cfg.DataDir = "/data"
		cfg.OpenBrowser = false
		cfg.Bind = "0.0.0.0"
	}

	// Default bind: localhost only (secure default). User must explicitly set
	// bind: 0.0.0.0 in config to expose to LAN — and then MUST set auth_token.
	if cfg.Bind == "" {
		cfg.Bind = "127.0.0.1"
	}

	// v0.31: hub HF base default + trailing-slash hygiene (every client path
	// joins with "/" — a stray slash would double up).
	if cfg.Hub.HFBase == "" {
		cfg.Hub.HFBase = "https://huggingface.co"
	}
	for strings.HasSuffix(cfg.Hub.HFBase, "/") {
		cfg.Hub.HFBase = cfg.Hub.HFBase[:len(cfg.Hub.HFBase)-1]
	}

	// SECURITY: data dir is 0o700 (owner-only). secrets.json + master.key
	// inside are 0o600. Other users on the system cannot read your chats/keys.
	// This happens AFTER all overrides are applied, so --data-dir on the CLI
	// is the path that actually gets created.
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir data_dir %q: %w", cfg.DataDir, err)
	}

	// SECURITY WARNING: if bound non-localhost with no auth token, warn loudly.
	if cfg.Bind == "0.0.0.0" && cfg.AuthToken == "" && cfg.Mode != "hf-demo" {
		fmt.Fprintln(os.Stderr, "⚠️  WARNING: engine bound to 0.0.0.0 with no auth_token.")
		fmt.Fprintln(os.Stderr, "   Anyone on your network can read your chats and API keys.")
		fmt.Fprintln(os.Stderr, "   Set auth_token in config.yaml (a random string) before exposing.")
	}
	return cfg, nil
}
