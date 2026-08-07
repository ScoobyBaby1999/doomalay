package com.doomalay.engine

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast

/**
 * Doomalay MainActivity — spatial canvas launcher with OTA hot-patch support.
 *
 * v0.4.1 changes:
 *  - Front-facing sync button (top-right) for manual OTA patch checks
 *  - Removed automatic background check — user controls when to sync
 *  - Safer service startup (notification built BEFORE foreground service)
 *  - Step-by-step logging with on-screen fallback if anything fails
 */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var syncBtn: ImageButton

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.log("=== Doomalay v0.4.1 starting ===")
        AppLog.log("Package: $packageName")
        AppLog.log("Files dir: ${filesDir.absolutePath}")
        AppLog.log("Native lib dir: ${applicationInfo.nativeLibraryDir}")

        // Global crash handler — writes stack trace to log file before dying
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            AppLog.error("UNCAUGHT EXCEPTION on ${thread.name}", throwable)
            prev?.uncaughtException(thread, throwable)
        }

        try {
            AppLog.log("Step 1: Starting EngineService...")
            startForegroundService(Intent(this, EngineService::class.java))
            AppLog.log("Step 1: OK")

            AppLog.log("Step 2: Setting up WebView + sync button...")

            // Root layout: FrameLayout so we can overlay the sync button
            val root = FrameLayout(this)

            webView = WebView(this)
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = true
            }
            webView.webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                    AppLog.error("WebView error: $errorCode $description ($failingUrl)")
                }
            }
            root.addView(webView, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))

            // Sync button — floating top-right
            syncBtn = ImageButton(this).apply {
                setImageResource(android.R.drawable.ic_popup_sync)
                setBackgroundColor(0x88000000.toInt())
                setColorFilter(0xFFFFFFFF.toInt())
                contentDescription = "Check for updates"
                alpha = 0.7f
                setOnClickListener { onSyncClicked() }
            }
            val btnParams = FrameLayout.LayoutParams(144, 144).apply {
                gravity = Gravity.TOP or Gravity.END
                topMargin = 64
                marginEnd = 32
            }
            root.addView(syncBtn, btnParams)

            setContentView(root)
            AppLog.log("Step 2: OK")

            AppLog.log("Step 3: Waiting for engine...")
            loadWhenReady()
        } catch (e: Exception) {
            AppLog.error("onCreate failed", e)
            showError("Startup failed: ${e.message}\n\nLog:\n${AppLog.read().takeLast(2000)}")
        }
    }

    private fun onSyncClicked() {
        syncBtn.isEnabled = false
        syncBtn.alpha = 0.3f
        Toast.makeText(this, "Checking for updates...", Toast.LENGTH_SHORT).show()

        Thread {
            val result = OtaUpdater.forceCheck(this)
            AppLog.log("OTA sync result: $result")
            runOnUiThread {
                syncBtn.isEnabled = true
                syncBtn.alpha = 0.7f
                Toast.makeText(this, result, Toast.LENGTH_LONG).show()
            }
        }.start()
    }

    private fun loadWhenReady() {
        Thread {
            for (i in 1..60) {
                try {
                    val conn = java.net.URL("http://localhost:8080/api/health")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 1000
                    conn.readTimeout = 1000
                    if (conn.responseCode == 200) {
                        val body = conn.inputStream.bufferedReader().readText()
                        AppLog.log("Engine ready! Health: $body")
                        runOnUiThread { webView.loadUrl("http://localhost:8080") }
                        return@Thread
                    }
                } catch (e: Exception) {
                    if (i % 5 == 0) AppLog.log("Health check $i: ${e.message}")
                }
                Thread.sleep(500)
            }
            AppLog.error("Engine didn't start in 30s")
            runOnUiThread {
                showError("Engine didn't start.\n\nLog:\n${AppLog.read().takeLast(3000)}")
            }
        }.start()
    }

    private fun showError(msg: String) {
        runOnUiThread {
            setContentView(TextView(this).apply {
                text = msg
                textSize = 12f
                setTextColor(0xFFE4E4E7.toInt())
                setBackgroundColor(0xFF0A0A0B.toInt())
                setPadding(48, 96, 48, 48)
                setTextIsSelectable(true)
            })
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
