// netx.go — network egress plumbing for the engine.
//
// WHY THIS EXISTS (v0.14, the on-device egress fix):
//   The Android APK cross-compiles the engine with CGO_ENABLED=0. That is
//   correct for portability, but it means Go uses its PURE resolver, which
//   configures itself from /etc/resolv.conf — a file Android does not have.
//   Result: every outbound request (key validation, model sync, embed probe)
//   died with "dial tcp: lookup <host>: no such host" on the device, while
//   the same binary worked on desktop. That single root cause produced three
//   user-visible bugs: keys stuck "unverified (network: post …)", the Get
//   API key flow erroring, and model sync failing at runtime.
//
// THE FIX, still 100% dynamic and pure-Go:
//   DialContext  = system resolver first (desktop / HF / rooted envs) →
//                  DNS-over-HTTPS fallback against bootstrap IPs.
//   The DoH resolvers are reached by their literal IPs (1.1.1.1, 8.8.8.8 —
//   both serve TLS certificates that cover the IP itself), so the fallback
//   needs NO working DNS to bootstrap. Transport() returns an http.Transport
//   that every outbound engine client should use.
//
// No static host lists, no hardcoded provider IPs — only the two public
// resolver anycasts, which are infrastructure, not provider data.
package netx

import (
        "context"
        "encoding/json"
        "fmt"
        "log"
        "net"
        "net/http"
        "sync"
        "time"
)

const (
        dohTimeout  = 4 * time.Second
        cacheTTL    = 5 * time.Minute
        dialTimeout = 10 * time.Second
)

// resolver describes one DoH endpoint. The URL host MUST be a literal IP —
// that is the whole point (no DNS needed to reach the resolver).
type resolver struct {
        url    string // fmt template with one %s (the hostname)
        accept string // Accept header (Cloudflare's JSON API requires it)
        label  string
}

var dohResolvers = []resolver{
        {"https://1.1.1.1/dns-query?name=%s&type=A", "application/dns-json", "cloudflare"},
        {"https://8.8.8.8/resolve?name=%s&type=A", "application/dns-json", "google"},
        {"https://1.0.0.1/dns-query?name=%s&type=A", "application/dns-json", "cloudflare-2"},
        {"https://8.8.4.4/resolve?name=%s&type=A", "application/dns-json", "google-2"},
}

// dohClient is a plain client — the request URLs contain literal IPs, so
// nothing here needs DNS.
var dohClient = &http.Client{Timeout: dohTimeout}

// cache of successful lookups (either path). Small + TTL'd; misses are cheap.
var (
        cacheMu sync.Mutex
        cache   = map[string]cacheEntry{}
)

type cacheEntry struct {
        ips []net.IP
        at  time.Time
}

// forceDOH bypasses the system resolver (tests + diagnostics).
var forceDOH bool

var (
        fallbackOnce  sync.Once
        fallbackNoted bool
)

// noteFallback logs (once) that the system resolver failed and DoH is in
// use — the signature of the Android pure-Go resolver case.
func noteFallback(host string) {
        fallbackOnce.Do(func() {
                fallbackNoted = true
                log.Printf("netx: system DNS unavailable (pure-Go resolver without /etc/resolv.conf — expected on Android); falling back to DNS-over-HTTPS for %q", host)
        })
}

// LookupIP resolves a hostname to IPs: system resolver first, DoH fallback.
// Returns nil when both fail (caller dials nothing and reports the error).
func LookupIP(ctx context.Context, host string) []net.IP {
        if ip := net.ParseIP(host); ip != nil {
                return []net.IP{ip}
        }

        cacheMu.Lock()
        if e, ok := cache[host]; ok && time.Since(e.at) < cacheTTL {
                ips := e.ips
                cacheMu.Unlock()
                return ips
        }
        cacheMu.Unlock()

        if !forceDOH {
                if addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host); err == nil && len(addrs) > 0 {
                        ips := make([]net.IP, 0, len(addrs))
                        for _, a := range addrs {
                                ips = append(ips, a.IP)
                        }
                        cachePut(host, ips)
                        return ips
                }
        }

        ips := dohLookup(ctx, host)
        if len(ips) > 0 {
                if !forceDOH {
                        noteFallback(host)
                }
                cachePut(host, ips)
        }
        return ips
}

// dohLookup queries the DoH endpoints in order, first success wins.
// Both Cloudflare and Google speak the same JSON shape:
//
//      {"Status":0,"Answer":[{"name":"x.com","type":1,"TTL":60,"data":"1.2.3.4"}]}
func dohLookup(ctx context.Context, host string) []net.IP {
        for _, r := range dohResolvers {
                ips := dohQuery(ctx, r, host)
                if len(ips) > 0 {
                        return ips
                }
        }
        return nil
}

func dohQuery(ctx context.Context, r resolver, host string) []net.IP {
        url := fmt.Sprintf(r.url, host)
        req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
        if err != nil {
                return nil
        }
        req.Header.Set("Accept", r.accept)
        resp, err := dohClient.Do(req)
        if err != nil {
                return nil
        }
        defer resp.Body.Close()
        if resp.StatusCode != 200 {
                return nil
        }
        var out struct {
                Status int `json:"Status"`
                Answer []struct {
                        Type int    `json:"type"`
                        Data string `json:"data"`
                } `json:"Answer"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
                return nil
        }
        if out.Status != 0 {
                return nil // NXDOMAIN or similar — other resolvers won't help, but try
        }
        var ips []net.IP
        for _, a := range out.Answer {
                if a.Type == 1 { // A record
                        if ip := net.ParseIP(a.Data); ip != nil {
                                ips = append(ips, ip)
                        }
                }
        }
        return ips
}

func cachePut(host string, ips []net.IP) {
        cacheMu.Lock()
        cache[host] = cacheEntry{ips: ips, at: time.Now()}
        cacheMu.Unlock()
}

// DialContext is the drop-in dialer: resolve (system → DoH), then try each
// address until one connects. Works for "tcp", "tcp4", "tcp6".
func DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
        host, port, err := net.SplitHostPort(addr)
        if err != nil {
                host, port = addr, "443"
        }
        if net.ParseIP(host) != nil {
                var d net.Dialer
                d.Timeout = dialTimeout
                return d.DialContext(ctx, network, addr)
        }

        ips := LookupIP(ctx, host)
        if len(ips) == 0 {
                return nil, fmt.Errorf("netx: no address for %q (system resolver and DNS-over-HTTPS both failed)", host)
        }

        var d net.Dialer
        d.Timeout = dialTimeout
        var lastErr error
        for _, ip := range ips {
                conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
                if err == nil {
                        return conn, nil
                }
                lastErr = err
        }
        return nil, lastErr
}

// Transport returns the shared outbound transport. Every engine client that
// talks to the outside world (providers, DoH-grade endpoints, probes, search)
// should use this so the Android DNS fix applies everywhere.
func Transport() *http.Transport {
        return &http.Transport{
                DialContext:           DialContext,
                ForceAttemptHTTP2:     true,
                MaxIdleConns:          16,
                MaxIdleConnsPerHost:   4,
                IdleConnTimeout:       60 * time.Second,
                TLSHandshakeTimeout:   10 * time.Second,
                ExpectContinueTimeout: 1 * time.Second,
        }
}

// Diag reports resolver health — surfaced via GET /api/netdiag so the UI (and
// users debugging a device) can see exactly which path egress takes.
func Diag() map[string]any {
        ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
        defer cancel()

        systemOK := false
        if addrs, err := net.DefaultResolver.LookupIPAddr(ctx, "cloudflare.com"); err == nil && len(addrs) > 0 {
                systemOK = true
        }

        dohOK := false
        var via string
        for _, r := range dohResolvers {
                if ips := dohQuery(ctx, r, "cloudflare.com"); len(ips) > 0 {
                        dohOK = true
                        via = r.label
                        break
                }
        }

        return map[string]any{
                "system_dns": systemOK,
                "doh":        dohOK,
                "doh_via":    via,
                "doh_active": fallbackNoted,
                "forced_doh": forceDOH,
        }
}
