// Package config parses the engine's YAML config and applies defaults.
//
// Config locations (in priority order):
//  1. --config /path/to/config.yaml flag
//  2. $DOOMALAY_CONFIG env var
//  3. ~/.config/doomalay/config.yaml
//  4. built-in defaults
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config is the engine runtime configuration.
type Config struct {
	Mode        string `yaml:"mode"`         // "local" | "hf-demo"
	Port        int    `yaml:"port"`         // default 8080
	BrainDir    string `yaml:"brain_dir"`    // path to brain/ (default: sibling of engine)
	BrainPort   int    `yaml:"brain_port"`   // default 9090
	DataDir     string `yaml:"data_dir"`     // SQLite + workspaces (default: ~/.local/share/doomalay)
	OpenBrowser bool   `yaml:"open_browser"` // open system browser on start
	AuthToken   string `yaml:"auth_token"`   // bearer token (empty = no auth on localhost)
}

// Load resolves and parses the config.
func Load(path string) (*Config, error) {
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

	// Defaults for paths.
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

	// HF demo mode: data dir is /data, open browser off.
	if cfg.Mode == "hf-demo" {
		cfg.DataDir = "/data"
		cfg.OpenBrowser = false
	}

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir data_dir: %w", err)
	}
	return cfg, nil
}
