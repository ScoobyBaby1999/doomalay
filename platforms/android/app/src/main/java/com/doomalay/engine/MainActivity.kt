package com.doomalay.engine

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * The main activity — a full-screen WebView that loads the PWA from the
 * Go engine at http://localhost:8080.
 *
 * The engine + brain are started by EngineService (a foreground service).
 * This activity just shows the WebView and binds to the service to check
 * when the engine is ready.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Start the engine service (foreground service).
        val serviceIntent = Intent(this, EngineService::class.java)
        startForegroundService(serviceIntent)

        // Set up the WebView.
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                // Keep all URLs inside the WebView (no external browser).
                return false
            }
        }

        // Load the engine. Poll until it's ready (the engine takes ~2s to start).
        loadWhenReady()
    }

    private fun loadWhenReady() {
        val url = "http://localhost:8080"
        Thread {
            // Poll /api/health until the engine responds.
            for (i in 1..30) {
                try {
                    val conn = java.net.URL("$url/api/health").openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 1000
                    conn.readTimeout = 1000
                    if (conn.responseCode == 200) {
                        runOnUiThread { webView.loadUrl(url) }
                        return@Thread
                    }
                } catch (e: Exception) {
                    // Engine not ready yet — retry.
                }
                Thread.sleep(500)
            }
            // Timeout — show an error.
            runOnUiThread {
                webView.loadData(
                    "<html><body style='background:#0a0a0b;color:#e4e4e7;font-family:sans-serif;padding:2em'>" +
                    "<h2>Engine failed to start</h2><p>Check the app notification for details.</p></body></html>",
                    "text/html", "utf-8"
                )
            }
        }.start()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
