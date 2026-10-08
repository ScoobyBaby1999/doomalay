package config

// config_ota_test.go — v1.17.4 THE LIVE UPDATE: the OTA manifest URL
// config precedence ($DOOMALAY_OTA_URL env > YAML > the GitHub release
// default) + the DOOMALAY_OTA_DISABLE=1 kill switch.

import (
	"os"
	"path/filepath"
	"testing"
)

func loadForOtaTest(t *testing.T, ov Overrides) *Config {
	t.Helper()
	// Point DOOMALAY_CONFIG at a nonexistent file so no machine-local
	// ~/.config/doomalay/config.yaml can leak into the test (the same
	// guard as the termux config tests).
	t.Setenv("DOOMALAY_CONFIG", filepath.Join(t.TempDir(), "nonexistent.yaml"))
	cfg, err := Load("", ov)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

func TestOtaURL_DefaultIsTheGitHubRelease(t *testing.T) {
	t.Setenv("DOOMALAY_OTA_URL", "")
	cfg := loadForOtaTest(t, Overrides{DataDir: t.TempDir()})
	want := "https://github.com/ScoobyBaby1999/doomalay/releases/latest/download/patch-manifest.json"
	if cfg.OTAURL != want {
		t.Fatalf("the default manifest URL must be the release latest asset, got %q", cfg.OTAURL)
	}
	if cfg.OTADisable {
		t.Fatal("OTA must be enabled by default")
	}
}

func TestOtaURL_EnvOverridesTheDefault(t *testing.T) {
	t.Setenv("DOOMALAY_OTA_URL", "http://127.0.0.1:9/patch-manifest.json")
	cfg := loadForOtaTest(t, Overrides{DataDir: t.TempDir()})
	if cfg.OTAURL != "http://127.0.0.1:9/patch-manifest.json" {
		t.Fatalf("DOOMALAY_OTA_URL must win over the default, got %q", cfg.OTAURL)
	}
}

func TestOtaDisable_KillSwitch(t *testing.T) {
	t.Setenv("DOOMALAY_OTA_URL", "")
	t.Setenv("DOOMALAY_OTA_DISABLE", "1")
	cfg := loadForOtaTest(t, Overrides{DataDir: t.TempDir()})
	if !cfg.OTADisable {
		t.Fatal("DOOMALAY_OTA_DISABLE=1 must flip OTADisable")
	}
	// Any other value is not the kill switch.
	t.Setenv("DOOMALAY_OTA_DISABLE", "0")
	cfg = loadForOtaTest(t, Overrides{DataDir: t.TempDir()})
	if cfg.OTADisable {
		t.Fatal("DOOMALAY_OTA_DISABLE=0 must NOT flip OTADisable")
	}
}

func TestOtaURL_YamlIsOverriddenByEnv(t *testing.T) {
	dir := t.TempDir()
	yamlPath := filepath.Join(dir, "config.yaml")
	yaml := "ota_url: https://mirror.example.com/ota/patch-manifest.json\n"
	if err := os.WriteFile(yamlPath, []byte(yaml), 0o644); err != nil {
		t.Fatalf("write yaml: %v", err)
	}
	t.Setenv("DOOMALAY_OTA_URL", "http://127.0.0.1:9/stub-manifest.json")
	cfg, err := Load(yamlPath, Overrides{DataDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Load(yaml): %v", err)
	}
	if cfg.OTAURL != "http://127.0.0.1:9/stub-manifest.json" {
		t.Fatalf("env must beat the yaml ota_url, got %q", cfg.OTAURL)
	}
	// And without the env, the yaml value rides.
	t.Setenv("DOOMALAY_OTA_URL", "")
	cfg, err = Load(yamlPath, Overrides{DataDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Load(yaml, no env): %v", err)
	}
	if cfg.OTAURL != "https://mirror.example.com/ota/patch-manifest.json" {
		t.Fatalf("yaml ota_url must ride without the env, got %q", cfg.OTAURL)
	}
}
