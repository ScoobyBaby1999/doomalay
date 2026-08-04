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
        Mode           string   `yaml:"mode"`            // "local" | "hf-demo"
        Port           int      `yaml:"port"`            // default 8080
        BrainDir       string   `yaml:"brain_dir"`       // path to brain/ (default: sibling of engine)
        BrainPort      int      `yaml:"brain_port"`      // default 9090
        DataDir        string   `yaml:"data_dir"`        // SQLite + workspaces (default: ~/.local/share/doomalay)
        OpenBrowser    bool     `yaml:"open_browser"`    // open system browser on start
        AuthToken      string   `yaml:"auth_token"`      // bearer token (REQUIRED for non-localhost access)
        AllowedOrigins []string `yaml:"allowed_origins"` // CORS + WS origin allowlist (e.g. ["https://doomalay.mydomain.com"])
        Bind           string   `yaml:"bind"`            // bind address (default: 127.0.0.1 — localhost only; set to 0.0.0.0 for LAN)
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

        // SECURITY: data dir is 0o700 (owner-only). secrets.json + master.key
        // inside are 0o600. Other users on the system cannot read your chats/keys.
        if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
                return nil, fmt.Errorf("mkdir data_dir: %w", err)
        }

        // SECURITY WARNING: if bound non-localhost with no auth token, warn loudly.
        if cfg.Bind == "0.0.0.0" && cfg.AuthToken == "" && cfg.Mode != "hf-demo" {
                fmt.Fprintln(os.Stderr, "⚠️  WARNING: engine bound to 0.0.0.0 with no auth_token.")
                fmt.Fprintln(os.Stderr, "   Anyone on your network can read your chats and API keys.")
                fmt.Fprintln(os.Stderr, "   Set auth_token in config.yaml (a random string) before exposing.")
        }
        return cfg, nil
}
