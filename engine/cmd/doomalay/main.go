// Package main is the Doomalay Engine entry point.
//
// The Engine is the universal portable runtime: one Go binary that runs on
// Windows, macOS, Linux, and Android (via Termux). It serves the PWA over
// HTTP, handles WebSocket chat, manages sandboxes and secrets, persists
// events to SQLite, and proxies AI requests to the Python brain.
package main

import (
        "context"
        "flag"
        "fmt"
        "log"
        "os"
        "os/exec"
        "os/signal"
        "syscall"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/brain"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/config"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/server"
        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

func main() {
        cfgPath := flag.String("config", "", "path to config.yaml (default: ~/.config/doomalay/config.yaml)")
        port := flag.Int("port", 0, "override listen port (default: 8080, or $PORT)")
        bind := flag.String("bind", "", "override bind address (default: 127.0.0.1, or config bind; set to 0.0.0.0 for LAN)")
        dataDir := flag.String("data-dir", "", "override data directory for SQLite + workspaces (default: ~/.local/share/doomalay)")
        openBrowser := flag.Bool("open", false, "open the system browser on start (default: true on desktop, false on Android)")
        flag.Parse()

        cfg, err := config.Load(*cfgPath)
        if err != nil {
                log.Fatalf("config: %v", err)
        }
        if *port != 0 {
                cfg.Port = *port
        }
        if cfg.Port == 0 {
                cfg.Port = 8080
        }
        if *bind != "" {
                cfg.Bind = *bind
        }
        if *dataDir != "" {
                cfg.DataDir = *dataDir
        }
        if *openBrowser {
                cfg.OpenBrowser = true
        }

        log.Printf("doomalay engine starting (port %d, mode=%s)", cfg.Port, cfg.Mode)

        // Open the SQLite store (pure-Go driver, no CGO).
        db, err := store.Open(cfg.DataDir)
        if err != nil {
                log.Fatalf("store: %v", err)
        }
        defer db.Close()
        if err := db.Migrate(); err != nil {
                log.Fatalf("migrate: %v", err)
        }

        // Start the Python brain subprocess (best-effort; falls back to direct
        // cloud LLM proxy if Python is unavailable).
        br, err := brain.Start(cfg.BrainDir, cfg.BrainPort)
        if err != nil {
                log.Printf("warning: brain not started (%v) — falling back to direct cloud LLM proxy", err)
        }
        if br != nil {
                defer br.Stop()
                log.Printf("brain: python subprocess on localhost:%d", cfg.BrainPort)
        }

        // Build the HTTP server.
        srv := server.New(cfg, db, br)

        // Graceful shutdown on SIGINT/SIGTERM.
        ctx, cancel := context.WithCancel(context.Background())
        defer cancel()
        go func() {
                sigCh := make(chan os.Signal, 1)
                signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
                <-sigCh
                log.Printf("shutdown signal received")
                cancel()
                _ = srv.Shutdown(context.Background())
        }()

        addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port)
        log.Printf("listening on http://%s (bind=%s)", addr, cfg.Bind)
        if cfg.OpenBrowser {
                go func() {
                        time.Sleep(300 * time.Millisecond)
                        openBrowserURL(fmt.Sprintf("http://localhost:%d", cfg.Port))
                }()
        }
        if err := srv.ListenAndServe(addr); err != nil {
                log.Fatalf("server: %v", err)
        }
        _ = ctx
}

// openBrowserURL opens the system browser to a URL (best-effort, platform-specific).
func openBrowserURL(url string) {
        // Detect platform and use the right command.
        switch {
        case commandExists("xdg-open"):
                exec.Command("xdg-open", url).Start()
        case commandExists("open"): // macOS
                exec.Command("open", url).Start()
        case commandExists("start"): // Windows (cmd)
                exec.Command("cmd", "/c", "start", url).Start()
        case commandExists("termux-open-url"): // Android Termux
                exec.Command("termux-open-url", url).Start()
        }
}

func commandExists(name string) bool {
        _, err := exec.LookPath(name)
        return err == nil
}
