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
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private val REQUEST_NOTIFICATION = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.log("=== Doomalay starting ===")
        AppLog.log("SDK: ${Build.VERSION.SDK_INT}, ABI: ${Build.SUPPORTED_ABIS.joinToString()}")

        // Global crash handler
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            AppLog.error("CRASH on ${thread.name}", throwable)
            prev?.uncaughtException(thread, throwable)
        }

        // Step 1: Request POST_NOTIFICATIONS permission (Android 13+)
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                AppLog.log("Requesting POST_NOTIFICATIONS permission...")
                ActivityCompat.requestPermissions(this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATION)
                // The service starts AFTER the user responds (onRequestPermissionsResult)
                showWaitingScreen("Requesting notification permission...\nPlease allow it.")
                return
            }
        }
        // Permission already granted (or Android < 13) — proceed
        startEngineAndLoadUI()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATION) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            AppLog.log("POST_NOTIFICATIONS: ${if (granted) "granted" else "denied"}")
            // Start service regardless — even if denied, we try (the notification just won't show)
            startEngineAndLoadUI()
        }
    }

    private fun startEngineAndLoadUI() {
        try {
            AppLog.log("Step 1: Starting EngineService...")
            startForegroundService(Intent(this, EngineService::class.java))
            AppLog.log("Step 1: OK")

            AppLog.log("Step 2: Setting up WebView...")
            webView = WebView(this)
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
            }
            webView.webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                    AppLog.error("WebView error: $errorCode $description ($failingUrl)")
                }
            }
            setContentView(webView)

            // Show a loading page while waiting for the engine
            webView.loadData(
                "<html><body style='background:#0a0a0b;color:#a78bfa;font-family:sans-serif;" +
                "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
                "<div style='text-align:center'><h2>Starting engine...</h2>" +
                "<p>Brick 2-5</p></div></body></html>",
                "text/html", "utf-8"
            )
            AppLog.log("Step 2: OK")

            AppLog.log("Step 3: Polling engine health...")
            pollEngineHealth()
        } catch (e: Exception) {
            AppLog.error("startEngineAndLoadUI failed", e)
            showError("Startup failed: ${e.message}\n\nLog:\n${AppLog.tail(30)}")
        }
    }

    private fun pollEngineHealth() {
        Thread {
            for (i in 1..60) {
                try {
                    val conn = java.net.URL("http://127.0.0.1:8080/api/health")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 1000
                    conn.readTimeout = 1000
                    if (conn.responseCode == 200) {
                        val body = conn.inputStream.bufferedReader().readText()
                        AppLog.log("Engine ready! Health: $body")
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
                showError("Engine didn't start in 30s.\n\nLog:\n${AppLog.tail(40)}")
            }
        }.start()
    }

    private fun showWaitingScreen(msg: String) {
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
