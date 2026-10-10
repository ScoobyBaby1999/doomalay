package server

// fdroid.go — v1.23.1 THE LINK (PLAN-V123 §1): the F-Droid Termux download
// link is resolved DYNAMICALLY, never hardcoded-forever.
//
// The old law was a frozen URL (f-droid.org/repo/com.termux_1002.apk) that
// needed a manual edit every F-Droid release. The new law: F-Droid's own
// package API answers which version is THE STABLE one.
//
//   GET https://f-droid.org/api/v1/packages/com.termux
//   {"packageName":"com.termux","suggestedVersionCode":1002,
//    "packages":[{"versionName":"0.119.0-beta.3","versionCode":1022},
//                {"versionName":"0.119.0-beta.2","versionCode":1021},
//                {"versionName":"0.118.3","versionCode":1002}]}
//
// RESEARCH RECEIPT (fetched live, this wave): the packages list sorts by
// versionCode DESC — packages[0] and even packages[1] are BETAS today, so
// "just take the second link" lands on a beta. F-Droid's own
// suggestedVersionCode (1002 → 0.118.3) is the stable pick. The derivation:
//
//   1. the entry whose versionCode == suggestedVersionCode   (the law)
//   2. else the first entry whose versionName carries no prerelease marker
//      (beta / rc / alpha — universal semver vocabulary, not a program list)
//   3. else the frozen fallback URL (offline / API shape changed)
//
// The APK URL is the F-Droid repo layout:
// https://f-droid.org/repo/com.termux_<versionCode>.apk
//
// HONESTY: a failed fetch NEVER errors a caller — the frozen URL answers.
// The cache lives for fdroidURLTTL; the first /api/termux/status probe warms
// it in the background so the Get-Termux tap answers instantly.

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// fdroidPackageAPI is F-Droid's live package endpoint; it is a VAR
	// shadowed by fdroidAPIBase so the tests can point it at a local
	// httptest server without monkey-patching the const block.
	fdroidPackageAPI = "https://f-droid.org/api/v1/packages/com.termux"
	// fdroidURLFallback is the frozen link — the last-resort answer when
	// F-Droid is unreachable or the API shape changed (verified stable:
	// versionCode 1002 = 0.118.3).
	fdroidURLFallback = "https://f-droid.org/repo/com.termux_1002.apk"
	// fdroidURLTTL — how long a resolved link is trusted (6h: F-Droid
	// publishes at most daily; an offline device re-falls to the fallback).
	fdroidURLTTL = 6 * time.Hour
	// fdroidFetchDeadline bounds one API fetch.
	fdroidFetchDeadline = 5 * time.Second
)

// fdroidAPIBase is the test injection point (the live default is the const).
var fdroidAPIBase = fdroidPackageAPI

// fdroidPrereleaseRE — the universal pre-release vocabulary (beta, rc,
// alpha in any case, with optional digits/dots). NOT a program list: these
// are semver markers every distributor shares.
var fdroidPrereleaseRE = regexp.MustCompile(`(?i)\b(?:beta|rc|alpha)`)

// fdroidAPIEntry is one package entry of F-Droid's v1 API.
type fdroidAPIEntry struct {
	VersionName string `json:"versionName"`
	VersionCode int    `json:"versionCode"`
}

// fdroidAPIResp is the response shape of the package endpoint.
type fdroidAPIResp struct {
	PackageName          string          `json:"packageName"`
	SuggestedVersionCode int             `json:"suggestedVersionCode"`
	Packages             []fdroidAPIEntry `json:"packages"`
}

// fdroidCache is the resolved-link cache (engine lifetime).
type fdroidCache struct {
	mu   sync.Mutex
	url  string
	at   time.Time
	flit bool // a fetch is in flight (one at a time — no thundering herd)
}

// pickFdroidURL derives the stable APK URL from an API response — the pure
// derivation (exported for tests): the suggestedVersionCode match first,
// then the first non-prerelease entry, then the fallback. Every URL is
// constructed from the entry's versionCode (the F-Droid repo layout).
func pickFdroidURL(r fdroidAPIResp) string {
	for _, e := range r.Packages {
		if e.VersionCode != 0 && e.VersionCode == r.SuggestedVersionCode {
			return fdroidURLForCode(e.VersionCode)
		}
	}
	for _, e := range r.Packages {
		if e.VersionCode != 0 && !fdroidPrereleaseRE.MatchString(e.VersionName) {
			return fdroidURLForCode(e.VersionCode)
		}
	}
	return fdroidURLFallback
}

// fdroidURLForCode builds the repo URL for a versionCode.
func fdroidURLForCode(code int) string {
	return "https://f-droid.org/repo/com.termux_" + strconv.Itoa(code) + ".apk"
}

// resolveFdroidTermuxURL returns the stable download URL (cached; a fetch
// runs only on a cold/expired cache — offline answers the fallback). ctx
// bounds the fetch; a nil client uses http.DefaultClient.
func (s *Server) resolveFdroidTermuxURL(ctx context.Context) string {
	s.fdroid.mu.Lock()
	if s.fdroid.url != "" && time.Since(s.fdroid.at) < fdroidURLTTL {
		u := s.fdroid.url
		s.fdroid.mu.Unlock()
		return u
	}
	if s.fdroid.flit {
		// A fetch is already running — answer the frozen link now rather
		// than serializing every caller behind one slow network hop.
		s.fdroid.mu.Unlock()
		return fdroidURLFallback
	}
	s.fdroid.flit = true
	s.fdroid.mu.Unlock()
	defer func() {
		s.fdroid.mu.Lock()
		s.fdroid.flit = false
		s.fdroid.mu.Unlock()
	}()

	fetchCtx, cancel := context.WithTimeout(ctx, fdroidFetchDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, fdroidAPIBase, nil)
	if err != nil {
		return fdroidURLFallback
	}
	req.Header.Set("Accept", "application/json")
	hc := http.DefaultClient
	resp, err := hc.Do(req)
	if err != nil {
		return fdroidURLFallback
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fdroidURLFallback
	}
	var api fdroidAPIResp
	dec := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20))
	if err := dec.Decode(&api); err != nil {
		return fdroidURLFallback
	}
	u := pickFdroidURL(api)
	s.fdroid.mu.Lock()
	s.fdroid.url = u
	s.fdroid.at = time.Now()
	s.fdroid.mu.Unlock()
	return u
}

// warmFdroidURL kicks a background resolve (the setup page's status poll
// warms the link so the Get-Termux tap answers instantly). Never blocks,
// never errors — one flight at a time.
func (s *Server) warmFdroidURL() {
	s.fdroid.mu.Lock()
	fresh := s.fdroid.url != "" && time.Since(s.fdroid.at) < fdroidURLTTL
	busy := s.fdroid.flit
	s.fdroid.mu.Unlock()
	if fresh || busy {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), fdroidFetchDeadline+2*time.Second)
		defer cancel()
		s.resolveFdroidTermuxURL(ctx)
	}()
}

// fdroidTermuxLink returns the CURRENT best link without fetching (the act
// path uses this: the cached value when fresh, else a synchronous resolve
// bounded by the request context, else the fallback).
func (s *Server) fdroidTermuxLink(ctx context.Context) string {
	return s.resolveFdroidTermuxURL(ctx)
}
