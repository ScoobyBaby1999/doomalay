package server

// screenshot.go — v0.62.4 (PLAN-V063 Phase E3): the T3 tier.
//
// High-resolution screenshots of PUBLIC pages (the "very high resolution
// screenshots" directive): `GET /api/preview/screenshot?url=…&w=1440&
// h=900&scale=2` shells out to a locally-detected Chromium
// (headless=new, --force-device-scale-factor — 1440×900 × 2 = a retina
// 2880×1800 PNG), caches 24h under <data-dir>/preview-cache/, and
// serves the PNG with long-lived cache headers.
//
// THE HONEST BOUNDARY (the v062 research): an auth-walled page
// screenshots as its LOGIN WALL, not its content — screenshots are for
// PUBLIC pages (docs, articles, repos, landing pages: exactly the "the
// LLM fetched a link, show me what it is" chat case). They never
// replace the T2 viewer for the key flow. On Android there is no CLI
// chromium — the tier cleanly 501s and the UI hides it (the APK's T2
// viewer covers what screenshots would).
//
// Detection: PATH probe (chromium | chromium-browser | google-chrome |
// google-chrome-stable | chrome) + the playwright cache locations (dev
// boxes). One probe per process. Detection feeds /api/preview, which
// stamps `screenshot_url` onto blocked-page verdicts so the UI knows
// its T3 options without a second round-trip.
//
// No Go deps — stdlib exec.Command (chromedp/go-rod are overkill for
// single-shot renders). --no-sandbox: the engine runs as the user; the
// chromium sandbox is not this tier's security boundary (the SSRF guard
// + public-page scope is), and containerized/self-host boxes need it.

import (
        "context"
        "crypto/sha256"
        "encoding/hex"
        "fmt"
        "net/http"
        "net/url"
        "os"
        "os/exec"
        "path/filepath"
        "strconv"
        "strings"
        "sync"
        "syscall"
        "time"
)

// detectScreenshot — overridable for tests (production runs
// detectScreenshotBinary once).
var detectScreenshot = detectScreenshotBinary

var (
        screenshotOnce sync.Once
        screenshotPath string
)

// screenshotBinaryPath — one probe per process, cached.
func screenshotBinaryPath() string {
        screenshotOnce.Do(func() { screenshotPath = detectScreenshot() })
        return screenshotPath
}

// detectScreenshotBinary — PATH first, then the playwright caches.
func detectScreenshotBinary() string {
        for _, name := range []string{"chromium", "chromium-browser", "google-chrome",
                "google-chrome-stable", "chrome"} {
                if p, err := exec.LookPath(name); err == nil {
                        return p
                }
        }
        home, err := os.UserHomeDir()
        if err == nil && home != "" {
                // prefer the NEWEST playwright build (glob sorts oldest
                // first — walk backwards)
                pick := func(pat string) string {
                        if hits, _ := filepath.Glob(filepath.Join(home, ".cache", "ms-playwright", pat)); len(hits) > 0 {
                                return hits[len(hits)-1]
                        }
                        return ""
                }
                if p := pick(filepath.Join("chromium-*", "chrome-linux*", "chrome")); p != "" {
                        return p
                }
                if p := pick(filepath.Join("chromium_headless_shell-*", "chrome-linux*", "headless_shell")); p != "" {
                        return p
                }
        }
        return ""
}

const (
        screenshotCacheTTL = 24 * time.Hour
        shotDefaultW       = 1440
        shotDefaultH       = 900
        shotDefaultScale   = 2
)

// handlePreviewScreenshot — GET /api/preview/screenshot?url=…[&w=&h=&scale=]
func (s *Server) handlePreviewScreenshot(w http.ResponseWriter, r *http.Request) {
        bin := screenshotBinaryPath()
        if bin == "" {
                writeError(w, 501, "screenshot tier unavailable (no chromium detected on this install)")
                return
        }
        raw := strings.TrimSpace(r.URL.Query().Get("url"))
        if raw == "" {
                writeError(w, 400, "url query param is required")
                return
        }
        target, err := url.Parse(raw)
        if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
                writeError(w, 400, "url must be a valid http(s) URL")
                return
        }
        if !previewHostAllowed(target.Hostname()) {
                writeError(w, 400, "screenshot refused: loopback/private hosts are not previewable")
                return
        }
        clamp := func(name string, def, lo, hi int) int {
                n, err := strconv.Atoi(r.URL.Query().Get(name))
                if err != nil || n < lo || n > hi {
                        return def
                }
                return n
        }
        wPx := clamp("w", shotDefaultW, 320, 1920)
        hPx := clamp("h", shotDefaultH, 240, 1200)
        scale := clamp("scale", shotDefaultScale, 1, 3)

        // the cache key covers the full render shape
        sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d|%d", raw, wPx, hPx, scale)))
        key := hex.EncodeToString(sum[:16])
        dir := filepath.Join(s.cfg.DataDir, "preview-cache")
        file := filepath.Join(dir, key+".png")

        if st, err := os.Stat(file); err == nil && time.Since(st.ModTime()) < screenshotCacheTTL {
                serveScreenshot(w, file)
                return
        }

        if err := os.MkdirAll(dir, 0o755); err != nil {
                writeError(w, 500, "cache dir: "+err.Error())
                return
        }
        tmp := file + ".tmp.png"
        _ = os.Remove(tmp)
        ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
        defer cancel()
        // a real Chrome UA — the default HeadlessChrome UA is
        // bot-walled by Cloudflare-fronted sites
        cmd := exec.CommandContext(ctx, bin,
                "--headless=new",
                "--screenshot="+tmp,
                fmt.Sprintf("--window-size=%d,%d", wPx, hPx),
                fmt.Sprintf("--force-device-scale-factor=%d", scale),
                "--hide-scrollbars",
                "--disable-gpu",
                "--no-sandbox",
                "--virtual-time-budget=8000",
                "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                raw,
        )
        // v0.62.4 robustness: chromium spawns zygotes/crash handlers — a
        // bare process kill on timeout/shutdown orphans them (observed:
        // a killed engine left a headless chrome burning CPU forever).
        // Own process group → kill the whole tree on cancel.
        cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
        cmd.Cancel = func() error {
                if cmd.Process != nil {
                        _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
                }
                return nil
        }
        out, err := cmd.CombinedOutput()
        if err != nil {
                _ = os.Remove(tmp)
                writeError(w, 502, fmt.Sprintf("screenshot failed: %v (%s)", err, lastLine(out)))
                return
        }
        if st, err := os.Stat(tmp); err != nil || st.Size() == 0 {
                _ = os.Remove(tmp)
                writeError(w, 502, "screenshot produced no output")
                return
        }
        if err := os.Rename(tmp, file); err != nil {
                writeError(w, 500, "cache write: "+err.Error())
                return
        }
        serveScreenshot(w, file)
}

func serveScreenshot(w http.ResponseWriter, file string) {
        data, err := os.ReadFile(file)
        if err != nil {
                writeError(w, 500, "cache read: "+err.Error())
                return
        }
        w.Header().Set("Content-Type", "image/png")
        w.Header().Set("Cache-Control", "public, max-age=86400")
        w.WriteHeader(200)
        _, _ = w.Write(data)
}

func lastLine(out []byte) string {
        lines := strings.Split(strings.TrimSpace(string(out)), "\n")
        if len(lines) == 0 {
                return ""
        }
        l := lines[len(lines)-1]
        if len(l) > 160 {
                l = l[:160]
        }
        return l
}

// screenshotURLFor — the /api/preview stamp: when the tier is live,
// blocked-page verdicts carry the ready-to-use <img src>.
func screenshotURLFor(raw string) string {
        if screenshotBinaryPath() == "" {
                return ""
        }
        return "/api/preview/screenshot?url=" + url.QueryEscape(raw)
}
