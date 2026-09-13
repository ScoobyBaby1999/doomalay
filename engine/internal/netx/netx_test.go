package netx

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// The DoH path must work with the system resolver completely bypassed —
// that is the exact situation on Android (pure-Go resolver, no resolv.conf).
func TestDoHLookupResolves(t *testing.T) {
	for _, host := range []string{"api.nvidia.com", "opencode.ai", "api.privatemode.ai"} {
		ips := dohLookup(context.Background(), host)
		if len(ips) == 0 {
			t.Errorf("dohLookup(%q) returned no IPs", host)
			continue
		}
		t.Logf("dohLookup(%q) → %v", host, ips)
	}
}

func TestDoHLookupRejectsBogusHost(t *testing.T) {
	ips := dohLookup(context.Background(), "this-domain-does-not-exist.invalid")
	if len(ips) != 0 {
		t.Errorf("expected no IPs for .invalid domain, got %v", ips)
	}
}

// Full LookupIP with forceDOH — simulates the Android resolver situation.
func TestLookupIPForcedDoH(t *testing.T) {
	old := forceDOH
	forceDOH = true
	defer func() { forceDOH = old }()

	ips := LookupIP(context.Background(), "integrate.api.nvidia.com")
	if len(ips) == 0 {
		t.Fatal("LookupIP via forced DoH returned no IPs")
	}
	for _, ip := range ips {
		if ip.To4() == nil {
			t.Logf("note: IPv6 result %v (fine — dialer tries all)", ip)
		}
	}
}

// End-to-end: Transport() with forced DoH must complete a real HTTPS GET
// against a provider endpoint — proving the whole chain (DoH → dial → TLS).
func TestTransportGETForcedDoH(t *testing.T) {
	old := forceDOH
	forceDOH = true
	defer func() { forceDOH = old }()
	// fresh cache so the DoH path is actually exercised
	cacheMu.Lock()
	saved := cache
	cache = map[string]cacheEntry{}
	cacheMu.Unlock()
	defer func() {
		cacheMu.Lock()
		cache = saved
		cacheMu.Unlock()
	}()

	client := &http.Client{Timeout: 15 * time.Second, Transport: Transport()}
	resp, err := client.Get("https://integrate.api.nvidia.com/v1/models")
	if err != nil {
		t.Fatalf("GET nvidia models via DoH transport failed: %v", err)
	}
	defer resp.Body.Close()
	t.Logf("nvidia /v1/models → HTTP %d (no key: public list)", resp.StatusCode)
	if resp.StatusCode == 0 {
		t.Fatal("no status")
	}
}

func TestDialContextLiteralIP(t *testing.T) {
	// Literal-IP addresses must bypass resolution entirely.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback listener")
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := DialContext(ctx, "tcp", "127.0.0.1:"+strconvItoa(ln.Addr().(*net.TCPAddr).Port))
	if err != nil {
		t.Fatalf("dial literal IP failed: %v", err)
	}
	conn.Close()
}

func strconvItoa(n int) string {
	// tiny helper to avoid importing strconv just for this
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
