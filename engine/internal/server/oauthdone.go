// oauthdone.go — v0.60: THE HOME-COMING SCREEN.
//
// THE v0.59->v0.60 BUG this file kills: after authorizing on the provider's
// page, the callback used to 302 the browser to /?…_connected=1 — i.e. LOAD
// THE FULL APP in whatever browser the flow ran in. On the APK that is the
// SYSTEM browser ("a separate instance of the app!"), and in a same-tab
// flow it reloads the SPA at its root screen (the "hardcoded screen" the
// back gesture then lands on). The user's spec: after authorizing, the
// browser should close itself / take me back to the REAL app, and the
// connect panel should update without me doing anything.
//
// THE FIX: the callback endpoints now SERVE this tiny terminal page — no
// redirect, no app load. One page, three self-picking behaviors:
//
//   • POPUP (desktop/PWA — hfconnect/ghconnect window.open the start URL):
//     postMessage {type:'doomalay-auth', …} to the opener (same engine
//     origin — the popup never left it, so the opener accepts), then
//     window.close() after 600ms. The app tab NEVER navigated: state kept,
//     back gesture untouched, panel repaints on the message.
//   • APK / external browser: opener is null and close() is a no-op, so
//     the page shows its "← return to the app" button → doomalay://return
//     (deep link, manifest intent filter + singleTop: the running app
//     foregrounds, the WebView's visibilitychange refetches the account,
//     the panel updates).
//   • Same-tab fallback (popup blocked): the "open the app" link carries
//     the old ?…_connected=1 query so the SPA's landing listener still
//     toasts; or the browser back button → bfcache → pageshow refetch.
package server

import (
        "encoding/json"
        "html/template"
        "net/http"
)

// oauthDonePage renders the terminal auth screen. provider is the human
// name ("Hugging Face"/"GitHub"), user the login ("" on error), errMsg the
// failure ("" on success), and backQuery the query string the "open the
// app" link appends to / (provider's *_connected=1 / *_error contract the
// SPA landing listeners understand).
func oauthDonePage(w http.ResponseWriter, provider, user, errMsg, backQuery string) {
        ok := errMsg == ""
        title, mark, markColor := "connected", "✓", "#4ade80"
        if !ok {
                title, mark, markColor = "sign-in failed", "✕", "#f87171"
        }
        // postMessage payload — the popup path's whole job. Sent on every
        // load (guarded by window.opener): harmless standalone, vital in a
        // popup. Same-origin only: targetOrigin = this page's own origin,
        // which for a popup IS the opener's origin (the callback lives on
        // the engine).
        payload := map[string]string{
                "type":     "doomalay-auth",
                "provider": provider,
                "user":     user,
                "error":    errMsg,
        }
        pJSON, err := json.Marshal(payload)
        if err != nil {
                pJSON = []byte(`{"type":"doomalay-auth"}`)
        }

        head := "<div style=\"font-size:44px;margin-bottom:12px;color:" + markColor + "\">" + mark + "</div>" +
                "<h2 style=\"font-size:17px;color:" + markColor + ";margin:0 0 6px;font-weight:600\">" +
                template.HTMLEscapeString(title) + " · " + template.HTMLEscapeString(provider) + "</h2>"
        body := ""
        if ok {
                body = "<p style=\"font-size:13px;color:#a1a1aa;margin:0 0 22px;line-height:1.5\">as <b style=\"color:#e0e0e8\">" +
                        template.HTMLEscapeString(user) + "</b> — the token is stored in the engine's encrypted vault.</p>"
        } else {
                body = "<p style=\"font-size:13px;color:#a1a1aa;margin:0 0 22px;line-height:1.5\">" +
                        template.HTMLEscapeString(errMsg) + "</p>" +
                        "<p style=\"font-size:12px;color:#71717a;margin:-14px 0 22px;line-height:1.5\">close this and press the connect button in the app to retry.</p>"
        }

        // the two ways out:
        //   1. the deep link — foregrounds the REAL app (APK case). Unknown
        //      scheme on desktop browsers: nothing happens, hence hint #2.
        //   2. the plain link — for the same-tab browser case: bring the
        //      SPA up in THIS tab with the landing query (toast + resume).
        href := "/"
        if backQuery != "" {
                href = "/?" + backQuery
        }
        btn := "" +
                "<button id=\"dp-return\" onclick=\"location.href='doomalay://return'\" " +
                "style=\"background:#a78bfa;border:none;color:#0a0a0b;padding:12px 26px;border-radius:12px;" +
                "font-size:14px;font-weight:600;font-family:inherit;cursor:pointer\">← return to the app</button>" +
                "<p style=\"font-size:11px;color:#71717a;margin:10px 0 0;line-height:1.5\">if nothing happens, switch to the Doomalay app — the panel updates on its own.</p>" +
                "<p style=\"margin:16px 0 0\"><a href=\"" + template.HTMLEscapeString(href) + "\" " +
                "style=\"font-size:12px;color:#a78bfa;text-decoration:none\">open the app in this tab ↗</a></p>"

        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        w.Header().Set("Cache-Control", "no-store")
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write([]byte("<!doctype html><html><head><meta charset=\"utf-8\">" +
                "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<title>Doomalay — " + template.HTMLEscapeString(title) + "</title></head>" +
                "<body style=\"background:#0a0a0b;color:#e0e0e8;font-family:system-ui,-apple-system,sans-serif;" +
                "display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">" +
                "<div style=\"text-align:center;max-width:360px;padding:24px\">" + head + body + btn + "</div>" +
                "<script>(function(){" +
                "var payload = " + string(pJSON) + ";" +
                "try { if (window.opener) window.opener.postMessage(payload, window.location.origin); } catch (e) {}" +
                // window.close() only works on script-opened windows — the
                // popup case. Standalone tabs ignore it, so the buttons above
                // remain; no auto-redirect to / EVER (that was the bug).
                "setTimeout(function(){ try { window.close(); } catch (e) {} }, 600);" +
                "})();</script>" +
                "</body></html>"))
}
