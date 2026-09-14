package com.doomalay.engine

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val REQUEST_NOTIF = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.log("=== Doomalay starting ===")
        AppLog.log("SDK: ${Build.VERSION.SDK_INT}")

        // Crash handler
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            AppLog.error("CRASH on ${thread.name}", throwable)
            prev?.uncaughtException(thread, throwable)
        }

        // Request POST_NOTIFICATIONS on Android 13+
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            AppLog.log("Requesting notification permission...")
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIF)
            showScreen("Requesting notification permission...\nPlease allow it.")
            return
        }
        proceed()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        AppLog.log("Notification permission: ${if (grantResults.isNotEmpty() && grantResults[0] == 0) "granted" else "denied"}")
        proceed()
    }

    private fun proceed() {
        try {
            AppLog.log("Starting EngineService...")
            startForegroundService(Intent(this, EngineService::class.java))

            // Set up WebView immediately — show a loading page
            webView = WebView(this)
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.webViewClient = object : WebViewClient() {
                // Keep the app self-contained: engine URLs (127.0.0.1) load
                // inside the WebView; ANY external URL (the ↗ "open in browser"
                // button, an API-key page, a stray link) is handed to the
                // real browser — the user leaves the app completely.
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    return handleUrl(url)
                }
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    // Sub-frame (iframe) navigations — e.g. the in-app redirect
                    // browser embedding a provider's key page — must load in
                    // place, NOT pop open Chrome. Only main-frame navigations
                    // that leave the engine get handed to the browser.
                    if (request?.isForMainFrame == false) return false
                    return handleUrl(request?.url?.toString())
                }
                private fun handleUrl(url: String?): Boolean {
                    if (url == null) return false
                    if (url.startsWith("http://127.0.0.1:8080") || url.startsWith("about:")) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                    } catch (e: Exception) {
                        AppLog.error("external open failed: $url", e)
                    }
                    return true
                }
                override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                    AppLog.error("WebView error: $errorCode $description ($failingUrl)")
                    // v0.15: a failed main-frame load (e.g. the engine was
                    // mid-restart when the page loaded) must not leave a
                    // blank screen — retry once after a short delay.
                    if (failingUrl != null && failingUrl.startsWith("http://127.0.0.1:8080")) {
                        handler.postDelayed({ view?.loadUrl(failingUrl) }, 2500)
                    }
                }
            }
            setContentView(webView)
            webView.loadData(
                "<html><body style='background:#0a0a0b;color:#a78bfa;font-family:sans-serif;" +
                "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
                "<div style='text-align:center'><h2>Starting engine...</h2></div></body></html>",
                "text/html", "utf-8"
            )

            // v0.16: chat-log EXPORT. The WebView doesn't download files
            // itself — when the UI opens /api/sessions/{id}/export.csv the
            // engine responds with Content-Disposition: attachment and the
            // WebView fires onDownloadStart. Hand the URL to the system
            // browser: Chrome can reach the local engine (same device) and
            // saves the file. Desktop browsers download the same URL
            // natively.
            webView.setDownloadListener { url, _, _, mimeType, _ ->
                try {
                    AppLog.log("export download: $url ($mimeType)")
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                } catch (e: Exception) {
                    AppLog.error("export open failed: $url", e)
                }
            }

            // Poll engine health. v0.15: the EngineService watchdog restarts
            // a crashed engine automatically — so keep polling LONGER (60s
            // instead of 30s) and never dead-end: the failure screen has a
            // working Retry button that restarts the service + polls again.
            Thread {
                for (i in 1..120) {
                    try {
                        val conn = java.net.URL("http://127.0.0.1:8080/api/health")
                            .openConnection() as java.net.HttpURLConnection
                        conn.connectTimeout = 1000
                        conn.readTimeout = 1000
                        if (conn.responseCode == 200) {
                            val body = conn.inputStream.bufferedReader().readText()
                            AppLog.log("Engine ready: $body")
                            handler.post { if (retrying) retrying = false else webView.loadUrl("http://127.0.0.1:8080") }
                            return@Thread
                        }
                    } catch (e: Exception) {
                        if (i % 5 == 0) AppLog.log("Health $i: ${e.message}")
                    }
                    Thread.sleep(500)
                }
                AppLog.error("Engine didn't start in 60s")
                handler.post { showEngineRetry() }
            }.start()
        } catch (e: Exception) {
            AppLog.error("proceed() failed", e)
            showError("Failed: ${e.message}\n\n${AppLog.tail(30)}")
        }
    }

    @Volatile private var retrying = false

    /** v0.15: engine-down screen WITH a retry path (was a dead end). */
    @SuppressLint("SetJavaScriptEnabled")
    private fun showEngineRetry() {
        retrying = true
        val html = """
            <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body style="background:#0a0a0b;color:#e0e0e8;font-family:sans-serif;display:flex;
            align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center;max-width:300px">
              <div style="font-size:34px;margin-bottom:10px">🔌</div>
              <h2 style="font-size:16px;color:#f87171;margin:0 0 6px">Engine didn't respond</h2>
              <p style="font-size:12px;color:#71717a;line-height:1.5;margin:0 0 16px">
                It usually recovers on its own within a few seconds (the watchdog restarts it).
                If this screen stays, tap Retry.</p>
              <button onclick="doomalay.retry()" style="background:#4a4a5e;border:none;color:#e0e0e8;
              padding:10px 22px;border-radius:9px;font-size:14px;font-family:inherit">Retry</button>
            </div>
            <script>
              window.doomalay = { retry: function() {
                window.__doomalayKotlin && window.__doomalayKotlin.retryEngine();
              }};
            </script>
            </body></html>
        """.trimIndent()
        if (this::webView.isInitialized) {
            webView.addJavascriptInterface(object : Any() {
                @android.webkit.JavascriptInterface
                fun retryEngine() {
                    AppLog.log("User pressed engine Retry")
                    handler.post { retryEngine() }
                }
            }, "__doomalayKotlin")
            webView.loadData(html, "text/html", "utf-8")
        }
    }

    /** Restart the engine service and resume health polling. */
    private fun retryEngine() {
        try {
            startForegroundService(Intent(this, EngineService::class.java))
            Thread {
                for (i in 1..120) {
                    try {
                        val conn = java.net.URL("http://127.0.0.1:8080/api/health")
                            .openConnection() as java.net.HttpURLConnection
                        conn.connectTimeout = 1000
                        conn.readTimeout = 1000
                        if (conn.responseCode == 200) {
                            handler.post { webView.loadUrl("http://127.0.0.1:8080") }
                            return@Thread
                        }
                    } catch (e: Exception) { /* keep polling */ }
                    Thread.sleep(500)
                }
                AppLog.error("Retry: engine still down after 60s")
                handler.post { showEngineRetry() }
            }.start()
        } catch (e: Exception) {
            AppLog.error("retryEngine failed", e)
        }
    }

    private fun showScreen(msg: String) {
        val tv = TextView(this).apply {
            text = msg
            textSize = 16f
            setTextColor(0xFFE4E4E7.toInt())
            setBackgroundColor(0xFF0A0A0B.toInt())
            setPadding(64, 200, 64, 64)
        }
        setContentView(tv)
    }

    private fun showError(msg: String) {
        val tv = TextView(this).apply {
            text = msg
            textSize = 11f
            setTextColor(0xFFE4E4E7.toInt())
            setBackgroundColor(0xFF0A0A0B.toInt())
            setPadding(48, 96, 48, 48)
            setTextIsSelectable(true)
        }
        setContentView(tv)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // v0.14: the app is a single-page WebView — there is no navigation
        // history to walk "back" through. The old code called
        // webView.goBack(), which jumped to the leftover "Starting engine…"
        // data-URL (or an iframe about:blank entry) and left users on a
        // dead screen after the Android back gesture. Instead:
        //   1. ask the app to close whatever overlay/panel is open
        //      (window.doomalay.handleBack), and
        //   2. if nothing was open, move the task to the background so the
        //      gesture feels native (swipe back in from recents to return).
        if (this::webView.isInitialized) {
            webView.evaluateJavascript(
                "(window.doomalay && window.doomalay.handleBack) ? window.doomalay.handleBack() : false"
            ) { result ->
                val handled = result == "true"
                if (!handled) moveTaskToBack(true)
            }
        } else {
            super.onBackPressed()
        }
    }
}
