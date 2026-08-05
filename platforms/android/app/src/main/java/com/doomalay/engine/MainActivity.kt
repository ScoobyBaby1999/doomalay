package com.doomalay.engine

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.log("=== Doomalay starting ===")
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
            AppLog.log("Step 2: OK")

            AppLog.log("Step 3: Waiting for engine...")
            loadWhenReady()
        } catch (e: Exception) {
            AppLog.error("onCreate failed", e)
            showError("Startup failed: ${e.message}\n\nLog:\n${AppLog.read().takeLast(2000)}")
        }
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
