package server

// fdroid_test.go — v1.23.1 THE LINK (PLAN-V123 §1): the dynamic F-Droid
// stable-APK derivation. The pure picker matrix (the suggestedVersionCode
// law, the no-suggested fallback, the prerelease skip, the frozen last
// resort) + the live-fetch behaviors through a local httptest server
// (cache hit, offline fallback, one-flight dedup).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestV1231_PickFdroidURL pins the derivation matrix.
func TestV1231_PickFdroidURL(t *testing.T) {
	cases := []struct {
		name string
		resp fdroidAPIResp
		want string
	}{
		{
			// the LIVE shape (fetched this wave): suggested 1002 while the
			// list's head is a beta — the suggested match wins.
			"suggested-match beats the betas above it",
			fdroidAPIResp{SuggestedVersionCode: 1002, Packages: []fdroidAPIEntry{
				{VersionName: "0.119.0-beta.3", VersionCode: 1022},
				{VersionName: "0.119.0-beta.2", VersionCode: 1021},
				{VersionName: "0.118.3", VersionCode: 1002},
			}},
			"https://f-droid.org/repo/com.termux_1002.apk",
		},
		{
			// no suggested match: the first non-prerelease entry.
			"no-suggested → first stable entry",
			fdroidAPIResp{Packages: []fdroidAPIEntry{
				{VersionName: "0.119.0-beta.1", VersionCode: 1020},
				{VersionName: "0.118.5", VersionCode: 1005},
				{VersionName: "0.117.9", VersionCode: 999},
			}},
			"https://f-droid.org/repo/com.termux_1005.apk",
		},
		{
			// prerelease markers in any case/form are skipped.
			"rc/alpha markers are prereleases too",
			fdroidAPIResp{Packages: []fdroidAPIEntry{
				{VersionName: "0.120-RC1", VersionCode: 1030},
				{VersionName: "0.119.1-alpha.2", VersionCode: 1025},
				{VersionName: "0.118.3", VersionCode: 1002},
			}},
			"https://f-droid.org/repo/com.termux_1002.apk",
		},
		{
			// every entry prerelease → the frozen fallback.
			"all-betas → the frozen link",
			fdroidAPIResp{Packages: []fdroidAPIEntry{
				{VersionName: "0.119.0-beta.3", VersionCode: 1022},
			}},
			fdroidURLFallback,
		},
		{
			// empty/changed shape → the frozen fallback.
			"empty packages → the frozen link",
			fdroidAPIResp{SuggestedVersionCode: 1002},
			fdroidURLFallback,
		},
	}
	for _, c := range cases {
		if got := pickFdroidURL(c.resp); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

// TestV1231_ResolveFdroid_FetchAndCache drives the live-fetch path against
// a local httptest endpoint: first call fetches, second call serves the
// cache (the endpoint counts hits), and a dead endpoint answers the frozen
// fallback without erroring.
func TestV1231_ResolveFdroid_FetchAndCache(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"packageName":"com.termux","suggestedVersionCode":1002,"packages":[
			{"versionName":"0.119.0-beta.3","versionCode":1022},
			{"versionName":"0.118.3","versionCode":1002}]}`))
	}))
	defer srv.Close()

	s := &Server{}
	old := fdroidAPIBase
	fdroidAPIBase = srv.URL
	t.Cleanup(func() { fdroidAPIBase = old })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	u1 := s.resolveFdroidTermuxURL(ctx)
	if u1 != "https://f-droid.org/repo/com.termux_1002.apk" {
		t.Fatalf("first resolve: got %s", u1)
	}
	u2 := s.resolveFdroidTermuxURL(ctx)
	if u2 != u1 {
		t.Fatalf("cache: second resolve must match the first (got %s)", u2)
	}
	if hits != 1 {
		t.Fatalf("the second resolve must serve the CACHE (hits=%d)", hits)
	}

	// A fresh server with a cold cache pointed at a dead port → the frozen
	// fallback, never an error.
	s2 := &Server{}
	fdroidAPIBase = "http://127.0.0.1:1/nope"
	u3 := s2.resolveFdroidTermuxURL(ctx)
	if u3 != fdroidURLFallback {
		t.Fatalf("dead endpoint must answer the frozen fallback, got %s", u3)
	}
	if !strings.HasPrefix(u3, "https://f-droid.org/") {
		t.Fatalf("the fallback must stay under the f-droid.org allowlist: %s", u3)
	}
}

// TestV1231_WarmFdroidURL pins the warm guard: a fresh cache kicks exactly
// one background flight; a warm cache kicks none.
func TestV1231_WarmFdroidURL(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"suggestedVersionCode":1002,"packages":[{"versionName":"0.118.3","versionCode":1002}]}`))
	}))
	defer srv.Close()

	s := &Server{}
	old := fdroidAPIBase
	fdroidAPIBase = srv.URL
	t.Cleanup(func() { fdroidAPIBase = old })

	s.warmFdroidURL()
	s.warmFdroidURL() // warm + one-flight → no second fetch
	// let the background flight land (bounded)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.fdroid.mu.Lock()
		done := s.fdroid.url != ""
		s.fdroid.mu.Unlock()
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s.fdroid.mu.Lock()
	u := s.fdroid.url
	s.fdroid.mu.Unlock()
	if u != "https://f-droid.org/repo/com.termux_1002.apk" {
		t.Fatalf("warm flight must land the resolved URL, got %q", u)
	}
	if hits != 1 {
		t.Fatalf("double warm must run ONE fetch (hits=%d)", hits)
	}
	// warm again with a fresh cache → still one fetch (the URL is cached now)
	s.warmFdroidURL()
	time.Sleep(150 * time.Millisecond)
	if hits != 1 {
		t.Fatalf("a warm cache must not re-fetch (hits=%d)", hits)
	}
}
