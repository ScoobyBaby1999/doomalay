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
import android.view.MotionEvent
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

    // v0.64.0: THE NATIVE PANEL BROWSER (PanelBrowserSheet) — a native
    // WebView docked as a snappable bottom sheet over the untouched SPA
    // (PLAN-V0640). Built lazily on the first __doomalayKotlin.openPanel
    // call from browserdock.js (InAppBrowser v3); every surface without
    // that bridge method never sees a panel browser at all.
    private var panelSheet: PanelBrowserSheet? = null
    private fun panelBrowser(): PanelBrowserSheet {
        if (panelSheet == null) panelSheet = PanelBrowserSheet(this)
        return panelSheet!!
    }

    // v0.64.0: an OAuth return page landing in the panel sheet's WebView
    // (doomalay://) — the SPA never lost visibility, so its
    // visibilitychange refetch has to be woken manually.
    fun wakeSpa() {
        if (this::webView.isInitialized) {
            try {
                webView.evaluateJavascript(
                    "try{document.dispatchEvent(new Event('visibilitychange'))}catch(e){}", null)
            } catch (e: Exception) {
                AppLog.error("wakeSpa failed", e)
            }
        }
    }

    // v0.64.2: run JS in the SPA's WebView — the native panel sheet's
    // state broadcasts ({open, ducked} → window.__doomalayPanelState in
    // browserdock.js, which manages the SPA's own #chat-scrim dim)
    // ride this. Guarded so a dead web layer (engine restarting, the
    // SPA not yet loaded — the hook won't exist) is a silent no-op.
    fun spaEval(js: String) {
        if (this::webView.isInitialized) {
            try {
                webView.evaluateJavascript(js, null)
            } catch (e: Exception) {
                AppLog.error("spaEval failed", e)
            }
        }
    }

    // v0.62.3: the main WebView's video fullscreen (onShowCustomView)
    private var fullscreenView: android.view.View? = null
    private var fullscreenCallback: android.webkit.WebChromeClient.CustomViewCallback? = null

    // v0.31: the WebView FILE CHOOSER (a real v0.30 bug — <input type=file>
    // was dead in the APK: onShowFileChooser was never implemented, so the
    // tweaks background picker AND the hub's card-image picker did
    // nothing). The system picker (ACTION_GET_CONTENT) needs NO storage
    // permission.
    private val REQUEST_FILECHOOSER = 1002
    private var filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null

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

    @SuppressLint("ClickableViewAccessibility")
    private fun proceed() {
        try {
            AppLog.log("Starting EngineService...")
            startForegroundService(Intent(this, EngineService::class.java))

            // Set up WebView immediately — show a loading page
            webView = WebView(this)
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true

            // v0.18: WebChromeClient — WITHOUT it the WebView silently
            // swallows window.confirm()/window.prompt() (returns false/null,
            // shows nothing). The web UI is now fully in-DOM for its
            // dialogs, but this keeps ANY future native dialog functional
            // instead of a silent dead tap.
            webView.webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onJsAlert(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult): Boolean {
                    android.app.AlertDialog.Builder(this@MainActivity)
                        .setMessage(message ?: "")
                        .setPositiveButton("OK") { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }
                override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult): Boolean {
                    android.app.AlertDialog.Builder(this@MainActivity)
                        .setMessage(message ?: "")
                        .setPositiveButton("OK") { _, _ -> result.confirm() }
                        .setNegativeButton("Cancel") { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }
                override fun onJsPrompt(view: WebView?, url: String?, message: String?, defaultValue: String?, result: android.webkit.JsPromptResult): Boolean {
                    val input = android.widget.EditText(this@MainActivity).apply {
                        setText(defaultValue ?: "")
                        setTextIsSelectable(true)
                    }
                    android.app.AlertDialog.Builder(this@MainActivity)
                        .setMessage(message ?: "")
                        .setView(input)
                        .setPositiveButton("OK") { _, _ -> result.confirm(input.text.toString()) }
                        .setNegativeButton("Cancel") { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }
                // v0.31: THE FILE CHOOSER — hands <input type=file> to the
                // system picker (image/* for the hub card art + the tweaks
                // backgrounds). The callback MUST be answered exactly once,
                // so a second pick while one is pending cancels the first
                // (WebView refuses to fire a new chooser otherwise).
                // SIGNATURE: the framework's is 3-arg — (WebView,
                // ValueCallback<Uri[]>, FileChooserParams) — and the params
                // class is NESTED: WebChromeClient.FileChooserParams, not a
                // top-level android.webkit.FileChooserParams (that was the
                // v0.31.0 CI failure: 'overrides nothing').
                override fun onShowFileChooser(
                    view: WebView?,
                    callback: android.webkit.ValueCallback<Array<android.net.Uri>>?,
                    params: android.webkit.WebChromeClient.FileChooserParams?
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    return try {
                        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "image/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                        }
                        @Suppress("DEPRECATION")
                        startActivityForResult(intent, REQUEST_FILECHOOSER)
                        true
                    } catch (e: Exception) {
                        AppLog.error("file chooser failed", e)
                        // returning false lets WebView cancel the chooser
                        // itself — drop our copy so it is never answered twice
                        filePathCallback = null
                        false
                    }
                }

                // v0.62.3: VIDEO FULLSCREEN in the main WebView — the E1
                // YouTube embed's □ button (and any <video> going full-
                // screen). The custom view overlays the whole activity;
                // back / the site's exit restores the app exactly as it
                // was (the WebView itself never navigated).
                override fun onShowCustomView(view: android.view.View, callback: android.webkit.WebChromeClient.CustomViewCallback) {
                    if (fullscreenView != null) {
                        callback.onCustomViewHidden()
                        return
                    }
                    fullscreenView = view
                    fullscreenCallback = callback
                    addContentView(view, android.widget.FrameLayout.LayoutParams(
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        android.view.ViewGroup.LayoutParams.MATCH_PARENT))
                    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }

                override fun onHideCustomView() {
                    (fullscreenView?.parent as? android.view.ViewGroup)?.removeView(fullscreenView)
                    fullscreenView = null
                    fullscreenCallback?.onCustomViewHidden()
                    fullscreenCallback = null
                    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }

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
                    // v0.63.5: THE PANEL GETS THE LINK FIRST. The web UI's
                    // docked browser (browserdock.js) renders links as a
                    // PANEL SCREEN — the user's clarified spec: no new
                    // full-screen browser unless the page demands it. We
                    // hand the URL to the live JS layer; InAppBrowser.open()
                    // docks it on the panel (or rides its own fallback
                    // tiers — the key consoles still reach the viewer via
                    // the bridge). Only a DEAD web layer (engine restarting,
                    // SPA not loaded: result null/undefined) opens the
                    // full-screen ViewerActivity directly.
                    try {
                        val js = "(window.InAppBrowser ? window.InAppBrowser.open(" +
                            org.json.JSONObject.quote(url) + ") : null)"
                        webView.evaluateJavascript(js) { res ->
                            val handled = res != null && res != "null" && res != "undefined"
                            if (!handled) openInViewer(url, hostile = false)
                        }
                    } catch (e: Exception) {
                        AppLog.error("dock handoff failed — native viewer: $url", e)
                        openInViewer(url, hostile = false)
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
            // v0.64.2: THE SECRET THIRD DOCK — while the native panel
            // browser sits at the half dock, ANY press on the app behind
            // it (the canvas strip the sheet leaves visible) ducks the
            // sheet to a 30% peek and hands the canvas its focus back
            // (PanelBrowserSheet.duckForCanvas → the __doomalayPanelState
            // broadcast lifts the SPA's scrim dim). The listener returns
            // FALSE — the touch ALWAYS flows on into the SPA, so the
            // canvas pans immediately under the gliding sheet — and every
            // retouch retriggers the ~3s re-dock delay.
            // v0.65.1: ACTION_MOVE joins the trigger — a CONTINUOUS
            // canvas drag is "the user is interacting" and must not let
            // the hold expire mid-gesture (onSpaTouch is idempotent:
            // already ducked → just the timer reset).
            webView.setOnTouchListener { _, ev ->
                val a = ev.actionMasked
                if (a == MotionEvent.ACTION_DOWN || a == MotionEvent.ACTION_MOVE) {
                    panelSheet?.onSpaTouch()
                }
                false
            }
            // v0.62.3: THE JS BRIDGE — the web UI's InAppBrowser tier calls
            // __doomalayKotlin.openInApp(url, opts) with a live theme
            // snapshot (CSS vars) so the viewer's toolbar follows the app's
            // theme system — nothing hardcoded on the Kotlin side.
            webView.addJavascriptInterface(bridgeObject(), "__doomalayKotlin")
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

    // v0.62.3: the bridge object — shared by proceed() and the error
    // screen (addJavascriptInterface replaces by name, so both call
    // sites must install the SAME surface: retryEngine + openInApp).
    private fun bridgeObject(): Any = object : Any() {
        @android.webkit.JavascriptInterface
        fun retryEngine() {
            AppLog.log("User pressed engine Retry")
            handler.post { retryEngine() }
        }

        @android.webkit.JavascriptInterface
        fun openInApp(url: String, optsJson: String) {
            AppLog.log("openInApp: $url")
            handler.post {
                val opts = try { org.json.JSONObject(optsJson) } catch (e: Exception) { org.json.JSONObject() }
                openInViewer(url, hostile = opts.optBoolean("hostile", false), themeJson = optsJson)
            }
        }

        // v0.63.4: THE BOX+ARROW — the panel browser's ⧉ strip button.
        // "Leave the app for the real browser / the site's app": ACTION_VIEW
        // lets the site's NATIVE app claim its domain (YouTube et al.);
        // a Chrome Custom Tab is the fallback, the system browser the last
        // resort (openCustomTab's own catch). Our manifest only claims the
        // doomalay:// scheme, so this can never loop back into the app.
        @android.webkit.JavascriptInterface
        fun openExternal(url: String) {
            AppLog.log("openExternal: $url")
            handler.post {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                } catch (e: Exception) {
                    AppLog.error("ACTION_VIEW failed — custom tab", e)
                    openCustomTab(url)
                }
            }
        }

        // v0.64.0: THE NATIVE PANEL BROWSER — browserdock.js (InAppBrowser
        // v3) routes every plain link tap here on shells that carry the
        // method; optsJson carries the live CSS-var theme snapshot. The
        // sheet is RESUMABLE: close only hides it, so its WebView history
        // + cookies survive to the next open.
        @android.webkit.JavascriptInterface
        fun openPanel(url: String, optsJson: String) {
            AppLog.log("openPanel: $url")
            handler.post { panelBrowser().open(url, optsJson) }
        }

        // the JS-side state getters (isOpen/currentURL/close consult
        // these — the native sheet owns the browser state now)
        @android.webkit.JavascriptInterface
        fun panelClose() {
            handler.post { panelSheet?.dismiss() }
        }

        @android.webkit.JavascriptInterface
        fun panelOpen(): Boolean = panelSheet?.isOpen() == true

        @android.webkit.JavascriptInterface
        fun panelUrl(): String = panelSheet?.currentUrl() ?: ""
    }

    // openInViewer — THE IN-APP BROWSER (PLAN-V063 E2). hostile pages
    // (Google-only OAuth — disallowed_useragent in a WebView) go to a
    // Chrome Custom Tab instead (the user's Chrome session, usually
    // already logged in).
    private fun openInViewer(url: String, hostile: Boolean, themeJson: String? = null) {
        if (hostile) {
            openCustomTab(url)
            return
        }
        if (themeJson != null) {
            startActivity(Intent(this, ViewerActivity::class.java).apply {
                putExtra("url", url)
                putExtra("theme", themeJson)
            })
            return
        }
        // no snapshot yet (the handleUrl path) — read the live CSS vars
        // from the main WebView, THEN open. evaluateJavascript returns
        // the JSON representation, ready for the viewer's JSONObject.
        if (this::webView.isInitialized) {
            webView.evaluateJavascript(
                "(function(){try{var cs=getComputedStyle(document.documentElement);" +
                    "var p=function(v){var s=cs.getPropertyValue(v).trim();return (s&&s.indexOf('var(')<0)?s:''};" +
                    "return {accent:p('--accent'),bgPanel:p('--bg-panel')||p('--bg-app')," +
                    "surface:p('--surface-2'),text1:p('--text-1'),text3:p('--text-3'),border:p('--border')}}" +
                    "catch(e){return {}}})()"
            ) { res ->
                startActivity(Intent(this, ViewerActivity::class.java).apply {
                    putExtra("url", url)
                    putExtra("theme", res ?: "{}")
                })
            }
        }
    }

    // the webview-hostile escape hatch: a Chrome Custom Tab (the user's
    // Chrome session). Falls back to the system browser — never to the
    // viewer (a Google login wall can't complete in a WebView).
    private fun openCustomTab(url: String) {
        val launch = { accent: Int? ->
            try {
                val b = androidx.browser.customtabs.CustomTabsIntent.Builder().setShowTitle(true)
                if (accent != null) b.setToolbarColor(accent)
                b.build().launchUrl(this, android.net.Uri.parse(url))
            } catch (e: Exception) {
                AppLog.error("custom tab failed — system browser", e)
                try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) } catch (e2: Exception) {
                    AppLog.error("system browser also failed", e2)
                }
            }
        }
        if (this::webView.isInitialized) {
            webView.evaluateJavascript(
                "(function(){try{return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()}catch(e){return ''}})()"
            ) { res -> launch(parseCssColor(res)) }
        } else {
            launch(null)
        }
    }

    // "#a78bfa" or "rgb(167,139,250)" (evaluateJavascript returns the JSON
    // representation — a quoted string — so trim the quotes) → a color.
    private fun parseCssColor(v: String?): Int? {
        val s = (v ?: "").trim().trim('"')
        if (s.isEmpty() || (!s.startsWith("#") && !s.startsWith("rgb"))) return null
        return try {
            if (s.startsWith("#")) android.graphics.Color.parseColor(s)
            else {
                val nums = Regex("-?\\d+").findAll(s).map { it.value.toInt() }.toList()
                if (nums.size >= 3) android.graphics.Color.rgb(
                    nums[0].coerceIn(0, 255), nums[1].coerceIn(0, 255), nums[2].coerceIn(0, 255))
                else null
            }
        } catch (e: Exception) {
            null
        }
    }

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
            // v0.62.3: the SAME bridge surface as proceed() — the old
            // retry-only object would have clobbered openInApp when the
            // error screen re-registered the name.
            webView.addJavascriptInterface(bridgeObject(), "__doomalayKotlin")
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
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // v0.31: answer the pending file chooser (null it out first so a
        // cancel leaves no stale callback — a second pick works right away).
        if (requestCode == REQUEST_FILECHOOSER) {
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    // v0.60: the auth done page (external browser) deep-links back with
    // doomalay://return. With launchMode=singleTop an already-running app
    // receives THIS callback instead of being recreated — the WebView and
    // its SPA state (open connect panel included) survive untouched, and
    // the WebView's own visibilitychange listener refetches the account so
    // the panel flips to connected by itself.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        AppLog.log("deep link / re-launch: ${intent.data}")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // v0.62.3: video fullscreen exits FIRST (the custom view covers
        // everything — the app underneath never moved)
        if (fullscreenView != null) {
            (fullscreenView?.parent as? android.view.ViewGroup)?.removeView(fullscreenView)
            fullscreenView = null
            fullscreenCallback?.onCustomViewHidden()
            fullscreenCallback = null
            window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            return
        }
        // v0.64.0: THE NATIVE PANEL BROWSER owns back FIRST — video
        // fullscreen → the WebView's own history → dismiss the sheet —
        // all natively, before the SPA (doomalay.handleBack) is ever
        // consulted. The SPA underneath stays exactly as left.
        if (panelSheet != null && panelSheet?.handleBack() == true) return
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

    // v0.64.0: the sheet's WebView pauses its media/timers with the app
    // (same lifecycle the main WebView gets for free).
    override fun onPause() {
        super.onPause()
        panelSheet?.onPause()
    }

    override fun onResume() {
        super.onResume()
        panelSheet?.onResume()
    }

    // v0.64.0: configChanges means no recreate — re-seat the sheet's
    // dock on rotation so the offsets never go stale.
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        panelSheet?.relayout()
    }
}
