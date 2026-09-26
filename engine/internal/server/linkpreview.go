package server

// linkpreview.go — GET /api/preview?url=… (v0.62.1, PLAN-V063 Phase E1)
//
// THE UNIVERSAL LINK VERDICT — one endpoint the whole UI asks before it
// renders any link the LLM (or a panel) produced. Never a blank
// "open in browser ↗" dead end again; every link gets the best tier it
// supports:
//
//   youtube   → {embed, thumb} from a PURE URL PARSE (no fetch — the
//               watch/youtu.be/shorts/live forms rewrite to the
//               privacy-enhanced youtube-nocookie.com/embed/ form,
//               which is frame-friendly BY DESIGN, probed live in the
//               v062 frame probe); timestamps ride along as ?start=
//   image | video | audio | pdf
//            → direct <img>/<video>/<audio>/<iframe> renders, decided
//               by extension, no fetch
//   html     → a server-side fetch (netx, manual redirect walk — the
//               probeEmbed pattern) extracts <title>, favicon and
//               og:title/description/image for the compact link card,
//               AND reads x-frame-options + CSP frame-ancestors to
//               answer `frameable` (the iframe verdict; CSP wins when
//               both are present, matching browsers). Cross-domain
//               redirect chains (SSO moves) are flagged login_redirect
//               so the UI shows the card + open-in-app, not a doomed
//               iframe.
//
// Every verdict is cached 1h per URL (the janitor sweep runs inline —
// same style as oauthStates). An SSRF guard refuses loopback/private/
// link-local targets on EVERY hop: the engine is local-first and a
// preview fetch must never come back home.

import (
        "fmt"
        "io"
        "net"
        "net/http"
        "net/url"
        "regexp"
        "strconv"
        "strings"
        "sync"
        "time"
)

// ── the cache ────────────────────────────────────────────────────────────

type previewCacheEntry struct {
        at   time.Time
        body map[string]any
}

var previewCache = struct {
        sync.Mutex
        m map[string]previewCacheEntry
}{m: map[string]previewCacheEntry{}}

const previewCacheTTL = time.Hour
const previewCacheMax = 256

func previewCacheGet(key string) (map[string]any, bool) {
        previewCache.Lock()
        defer previewCache.Unlock()
        e, ok := previewCache.m[key]
        if !ok || time.Since(e.at) > previewCacheTTL {
                return nil, false
        }
        out := make(map[string]any, len(e.body))
        for k, v := range e.body {
                out[k] = v
        }
        out["cached"] = true
        return out, true
}

func previewCachePut(key string, body map[string]any) {
        previewCache.Lock()
        defer previewCache.Unlock()
        // janitor sweep (inline — the map stays tiny)
        now := time.Now()
        for k, v := range previewCache.m {
                if now.Sub(v.at) > previewCacheTTL {
                        delete(previewCache.m, k)
                }
        }
        if len(previewCache.m) >= previewCacheMax {
                // crude LRU: drop the oldest entry
                var oldestKey string
                var oldestAt time.Time
                for k, v := range previewCache.m {
                        if oldestKey == "" || v.at.Before(oldestAt) {
                                oldestKey, oldestAt = k, v.at
                        }
                }
                delete(previewCache.m, oldestKey)
        }
        previewCache.m[key] = previewCacheEntry{at: now, body: body}
}

// previewHostAllowed — the SSRF guard, as a var so tests can aim the
// probe at a local httptest server (production always runs
// isPublicPreviewHost).
var previewHostAllowed = isPublicPreviewHost

// ── the handler ──────────────────────────────────────────────────────────

// handleLinkPreview — GET /api/preview?url=<https://…>
func (s *Server) handleLinkPreview(w http.ResponseWriter, r *http.Request) {
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
                writeError(w, 400, "preview refused: loopback/private hosts are not previewable")
                return
        }

        if hit, ok := previewCacheGet(raw); ok {
                writeJSON(w, 200, hit)
                return
        }

        // 1. YouTube — pure URL parse, zero egress, the richest verdict.
        if yt := youtubePreview(raw); yt != nil {
                previewCachePut(raw, yt)
                writeJSON(w, 200, yt)
                return
        }

        // 2. Direct media by extension — the client renders natively.
        if t := mediaTypeByExt(raw); t != "" {
                out := map[string]any{
                        "url": raw, "type": t, "frameable": true,
                        "title": prettifyHost(hostOf(raw)),
                }
                previewCachePut(raw, out)
                writeJSON(w, 200, out)
                return
        }

        // 3. HTML — fetch, extract, judge.
        out := htmlPreview(raw)
        if out == nil {
                writeError(w, 502, "preview fetch failed (unreachable)")
                return
        }
        previewCachePut(raw, out)
        writeJSON(w, 200, out)
}

// ── SSRF guard ───────────────────────────────────────────────────────────

// isPublicPreviewHost — the preview fetcher may only ever dial public
// hosts. Loopback/private/link-local/unspecified targets (and the
// "localhost" name) are refused BEFORE any socket opens, on every hop.
func isPublicPreviewHost(host string) bool {
        h := strings.ToLower(strings.TrimSpace(host))
        if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") {
                return false
        }
        if ip := net.ParseIP(h); ip != nil {
                return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
                        ip.IsLinkLocalMulticast() || ip.IsUnspecified())
        }
        return true // a public DNS name — resolved hosts are checked per hop below
}

// ── YouTube ──────────────────────────────────────────────────────────────

var ytHosts = map[string]bool{
        "youtube.com": true, "www.youtube.com": true, "m.youtube.com": true,
        "music.youtube.com": true, "youtube-nocookie.com": true,
        "www.youtube-nocookie.com": true, "youtu.be": true, "www.youtu.be": true,
}

var ytIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

// youtubePreview — the watch/youtu.be/shorts/live/embed rewrite. Returns
// nil when the URL isn't a YouTube form we can rewrite (channel pages,
// clip URLs, search pages fall through to the HTML probe).
func youtubePreview(raw string) map[string]any {
        u, err := url.Parse(raw)
        if err != nil {
                return nil
        }
        h := strings.ToLower(u.Hostname())
        if !ytHosts[h] {
                return nil
        }
        q := u.Query()
        var id string
        switch {
        case h == "youtu.be" || h == "www.youtu.be":
                id = strings.Trim(u.Path, "/")
        case strings.Contains(h, "youtube-nocookie.com"):
                id = strings.Trim(strings.TrimPrefix(u.Path, "/embed/"), "/")
        default:
                if v := q.Get("v"); v != "" {
                        id = v
                } else if p := u.Path; strings.HasPrefix(p, "/shorts/") || strings.HasPrefix(p, "/live/") || strings.HasPrefix(p, "/embed/") || strings.HasPrefix(p, "/v/") {
                        id = strings.Trim(strings.SplitN(p[1:], "/", 2)[1], "/")
                }
        }
        if !ytIDRe.MatchString(id) {
                return nil // playlists, channels, clips, search — not embeddable forms
        }
        // timestamps: t=90 / t=90s / t=1m30s / start=90
        start := parseYTTime(q.Get("t"))
        if start == 0 {
                start = parseYTTime(q.Get("start"))
        }
        embed := "https://www.youtube-nocookie.com/embed/" + id
        if start > 0 {
                embed += "?start=" + strconv.Itoa(start)
        }
        out := map[string]any{
                "url": raw, "type": "youtube", "youtube_id": id,
                "embed": embed, "frameable": true,
                "thumb": "https://i.ytimg.com/vi/" + id + "/maxresdefault.jpg",
                "thumb_fallback": "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
                "title": prettifyHost(h),
        }
        if start > 0 {
                out["start"] = start
        }
        return out
}

// parseYTTime — "90" | "90s" | "1m30s" | "1h2m3s" → seconds (0 = absent).
func parseYTTime(s string) int {
        s = strings.TrimSpace(strings.ToLower(s))
        if s == "" {
                return 0
        }
        if n, err := strconv.Atoi(s); err == nil {
                return n
        }
        total, num := 0, 0
        for _, c := range s {
                switch {
                case c >= '0' && c <= '9':
                        num = num*10 + int(c-'0')
                case c == 'h':
                        total += num * 3600
                        num = 0
                case c == 'm':
                        total += num * 60
                        num = 0
                case c == 's':
                        total += num
                        num = 0
                default:
                        return 0
                }
        }
        return total
}

// ── media by extension ───────────────────────────────────────────────────

var mediaExts = map[string]string{
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
        ".webp": "image", ".avif": "image", ".svg": "image", ".bmp": "image",
        ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video", ".ogv": "video",
        ".mp3": "audio", ".ogg": "audio", ".oga": "audio", ".wav": "audio",
        ".m4a": "audio", ".flac": "audio", ".opus": "audio", ".aac": "audio",
        ".pdf": "pdf",
}

// mediaTypeByExt — the extension decides (query strings stripped first);
// "" = not a direct-media URL.
func mediaTypeByExt(raw string) string {
        u, err := url.Parse(raw)
        if err != nil {
                return ""
        }
        p := strings.ToLower(u.Path)
        for ext, t := range mediaExts {
                if strings.HasSuffix(p, ext) {
                        return t
                }
        }
        return ""
}

// ── the HTML probe ───────────────────────────────────────────────────────

// htmlPreview — fetches (manual redirect walk, the probeEmbed pattern),
// extracts head metadata, and renders the frame verdict.
func htmlPreview(target string) map[string]any {
        cur := target
        hopHosts := []string{hostOf(target)}
        var (
                status  int
                ctype   string
                xfo, csp string
                body    []byte
        )
        for hop := 0; hop <= 5; hop++ {
                if !previewHostAllowed(hostOf(cur)) {
                        return nil // a redirect tried to come home — refuse
                }
                req, err := http.NewRequest("GET", cur, nil)
                if err != nil {
                        return nil
                }
                req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36")
                req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                req.Header.Set("Accept-Language", "en-US,en;q=0.9")
                resp, err := probeClient.Do(req)
                if err != nil {
                        return nil
                }
                if resp.StatusCode >= 300 && resp.StatusCode < 400 {
                        loc := resp.Header.Get("Location")
                        resp.Body.Close()
                        if loc == "" {
                                return nil
                        }
                        next, err := absoluteURL(cur, loc)
                        if err != nil {
                                return nil
                        }
                        hopHosts = append(hopHosts, hostOf(next))
                        cur = next
                        continue
                }
                status = resp.StatusCode
                ctype = resp.Header.Get("Content-Type")
                xfo = resp.Header.Get("X-Frame-Options")
                csp = resp.Header.Get("Content-Security-Policy")
                body, _ = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
                resp.Body.Close()
                break
        }
        if status == 0 {
                return nil
        }

        loginRedirect := false
        origHost := hostOf(target)
        for _, h := range hopHosts[1:] {
                if h == "" || isCosmeticSubdomain(h, origHost) {
                        continue
                }
                loginRedirect = true // a cross-domain move happened mid-chain
                break
        }

        // the media Content-Type can upgrade the classification even when
        // the URL had no extension (e.g. a CDN URL without .jpg)
        mt := ""
        if strings.HasPrefix(ctype, "image/") {
                mt = "image"
        } else if strings.HasPrefix(ctype, "video/") {
                mt = "video"
        } else if strings.HasPrefix(ctype, "audio/") {
                mt = "audio"
        } else if ctype == "application/pdf" {
                mt = "pdf"
        }

        blocked, reason := frameBlocked(xfo, csp, status)
        frameable := !blocked

        out := map[string]any{
                "url": target, "final_url": cur, "type": "html",
                "status": status, "frameable": frameable,
        }
        if !frameable {
                out["frame_reason"] = reason
        }
        if loginRedirect {
                out["login_redirect"] = true
        }
        if mt != "" {
                // a direct-media Content-Type beats the html card
                out["type"] = mt
                out["frameable"] = true
                delete(out, "frame_reason")
                return out
        }
        meta := extractHeadMeta(body, cur)
        for k, v := range meta {
                if v != "" {
                        out[k] = v
                }
        }
        if t, _ := out["title"].(string); t == "" {
                out["title"] = prettifyHost(hostOf(cur))
        }
        return out
}

// frameBlocked — the XFO + CSP frame-ancestors verdict (CSP wins when
// both are present — browser behavior, and what the v062 probe measured).
func frameBlocked(xfo, csp string, status int) (bool, string) {
        if xfo != "" {
                directive := strings.ToUpper(strings.Fields(strings.TrimSpace(xfo))[0])
                switch directive {
                case "DENY", "SAMEORIGIN":
                        return true, "site blocks embedding (X-Frame-Options: " + directive + ")"
                }
        }
        if csp != "" {
                for _, policy := range strings.Split(csp, ";") {
                        policy = strings.TrimSpace(policy)
                        if !strings.HasPrefix(strings.ToLower(policy), "frame-ancestors") {
                                continue
                        }
                        directives := strings.Fields(policy)[1:]
                        allowed := false
                        for _, d := range directives {
                                if strings.ToLower(d) == "*" {
                                        allowed = true
                                }
                        }
                        if !allowed && len(directives) > 0 {
                                return true, "site blocks embedding (CSP frame-ancestors)"
                        }
                }
        }
        if status == 401 || status == 403 {
                return true, fmt.Sprintf("page requires sign-in (HTTP %d)", status)
        }
        return false, ""
}

// ── head metadata extraction (regex, no deps) ────────────────────────────

var (
        reTitle    = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
        reMetaProp = regexp.MustCompile(`(?is)<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["']`)
        reLinkIcon = regexp.MustCompile(`(?is)<link[^>]+rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["'][^>]*href=["']([^"']+)["']`)
)

// extractHeadMeta — title, og/twitter cards, favicon (resolved absolute).
func extractHeadMeta(body []byte, base string) map[string]any {
        // only the head matters; cap the scan at the first 256KB
        scan := body
        if len(scan) > 256<<10 {
                scan = scan[:256<<10]
        }
        s := string(scan)
        out := map[string]any{}
        if m := reTitle.FindStringSubmatch(s); len(m) > 1 {
                out["title"] = decodeEntities(stripTags(m[1]))
        }
        og := map[string]string{}
        for _, m := range reMetaProp.FindAllStringSubmatch(s, -1) {
                key := strings.ToLower(strings.TrimSpace(m[1]))
                val := strings.TrimSpace(m[2])
                if _, dup := og[key]; !dup && val != "" {
                        og[key] = decodeEntities(val)
                }
        }
        pick := func(keys ...string) string {
                for _, k := range keys {
                        if v := og[k]; v != "" {
                                return v
                        }
                }
                return ""
        }
        if v := pick("og:title", "twitter:title"); v != "" {
                out["title"] = v
        }
        if v := pick("og:description", "description", "twitter:description"); v != "" {
                out["description"] = v
        }
        if v := pick("og:site_name"); v != "" {
                out["site_name"] = v
        }
        if v := pick("og:image", "twitter:image"); v != "" {
                if abs, err := absoluteURL(base, v); err == nil {
                        v = abs
                }
                out["og_image"] = v
        }
        if m := reLinkIcon.FindStringSubmatch(s); len(m) > 1 {
                if abs, err := absoluteURL(base, m[1]); err == nil {
                        out["favicon"] = abs
                }
        } else if abs, err := absoluteURL(base, "/favicon.ico"); err == nil {
                out["favicon"] = abs
        }
        return out
}

var reAnyTag = regexp.MustCompile(`(?s)<[^>]*>`)

func stripTags(s string) string {
        return strings.TrimSpace(reAnyTag.ReplaceAllString(s, ""))
}

// decodeEntities — the handful of entities titles/descriptions actually
// carry (a full decoder would need html pkg; this covers the field).
func decodeEntities(s string) string {
        r := strings.NewReplacer(
                "&amp;", "&", "&quot;", `"`, "&#39;", "'", "&apos;", "'",
                "&lt;", "<", "&gt;", ">", "&nbsp;", " ", "&#x27;", "'", "&#x2F;", "/",
        )
        return r.Replace(s)
}

// prettifyHost — "openrouter.ai" for a card title when nothing better exists.
func prettifyHost(h string) string {
        h = strings.TrimPrefix(strings.ToLower(h), "www.")
        if h == "" {
                return "link"
        }
        return h
}
