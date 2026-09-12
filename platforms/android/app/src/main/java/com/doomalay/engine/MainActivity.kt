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
                }
            }
            setContentView(webView)
            webView.loadData(
                "<html><body style='background:#0a0a0b;color:#a78bfa;font-family:sans-serif;" +
                "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
                "<div style='text-align:center'><h2>Starting engine...</h2></div></body></html>",
                "text/html", "utf-8"
            )

            // Poll engine health
            Thread {
                for (i in 1..60) {
                    try {
                        val conn = java.net.URL("http://127.0.0.1:8080/api/health")
                            .openConnection() as java.net.HttpURLConnection
                        conn.connectTimeout = 1000
                        conn.readTimeout = 1000
                        if (conn.responseCode == 200) {
                            val body = conn.inputStream.bufferedReader().readText()
                            AppLog.log("Engine ready: $body")
                            handler.post { webView.loadUrl("http://127.0.0.1:8080") }
                            return@Thread
                        }
                    } catch (e: Exception) {
                        if (i % 5 == 0) AppLog.log("Health $i: ${e.message}")
                    }
                    Thread.sleep(500)
                }
                AppLog.error("Engine didn't start in 30s")
                handler.post {
                    webView.loadData(
                        "<html><body style='background:#0a0a0b;color:#f87171;font-family:sans-serif;padding:24px'>" +
                        "<h2>Engine failed to start</h2><pre style='font-size:11px;color:#71717a;white-space:pre-wrap'>" +
                        AppLog.tail(40).replace("<", "&lt;").replace(">", "&gt;") +
                        "</pre></body></html>",
                        "text/html", "utf-8"
                    )
                }
            }.start()
        } catch (e: Exception) {
            AppLog.error("proceed() failed", e)
            showError("Failed: ${e.message}\n\n${AppLog.tail(30)}")
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
        if (this::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
