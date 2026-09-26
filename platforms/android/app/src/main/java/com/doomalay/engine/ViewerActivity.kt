package com.doomalay.engine

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

// ViewerActivity — v0.62.3 (PLAN-V063 Phase E2): THE IN-APP BROWSER.
//
// "Press any link and stay in the app." A second, full-screen WebView:
//   - TOP-LEVEL navigation — x-frame-options / CSP frame-ancestors do NOT
//     apply (they govern iframes only), so the API-key consoles that are
//     frame-blocked everywhere (openrouter, anthropic, together, nvidia,
//     privatemode — the v062 frame probe) render FULLY in-app;
//   - our own toolbar: ‹ back · host · ↻ reload · ⤢ Custom Tab · ✕ close;
//   - cookies persist (CookieManager is the app-global profile, shared
//     with the main WebView — logins survive across opens);
//   - video fullscreen via WebChromeClient.onShowCustomView (YouTube
//     embeds' □ button);
//   - back gesture: fullscreen exit → viewer history → finish().
//
// THE MAIN WebView NEVER NAVIGATES while this is open — MainActivity, its
// SPA state, the open panel and the back-gesture stack stay exactly as
// left (the v0.60 OAuth lesson, applied to browsing).
//
// THEME: the colors arrive from the web UI's live CSS vars via the bridge
// (InAppBrowser.open passes a snapshot) — nothing is hardcoded. When the
// snapshot is missing (edge case), the activity falls back to the SYSTEM
// theme's own background/accent attributes, never to literals.
//
// webview-hostile pages (Google-only OAuth: disallowed_useragent) never
// reach this activity — the bridge routes them straight to a Chrome
// Custom Tab (the user's Chrome session, usually already logged in).
class ViewerActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var toolbar: LinearLayout
    private lateinit var webView: WebView
    private lateinit var hostLabel: TextView
    private var themeJson = JSONObject()

    // video fullscreen (onShowCustomView)
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        val url = intent.getStringExtra("url") ?: run { finish(); return }
        try {
            themeJson = JSONObject(intent.getStringExtra("theme") ?: "{}")
        } catch (e: Exception) {
            themeJson = JSONObject()
        }
        AppLog.log("Viewer: opening $url")

        // ── colors: web-theme snapshot first, system theme as the fallback ──
        val bg = col("bgPanel", sysColor(android.R.attr.colorBackground, Color.BLACK))
        val accent = col("accent", sysColor(android.R.attr.colorAccent, Color.LTGRAY))
        val text1 = col("text1", sysColor(android.R.attr.colorForeground, Color.WHITE))
        val text3 = col("text3", text1)
        val border = col("border", text1)

        // ── the toolbar (‹ host ↻ ⤢ ✕) ─────────────────────────────────
        toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(bg)
            setPadding(0, statusBarPad(), 0, 0)
        }
        fun toolBtn(label: String, title: String, onClick: (TextView) -> Unit): TextView {
            val b = TextView(this)
            b.text = label
            b.contentDescription = title
            b.setTextColor(text1)
            b.textSize = 20f
            b.gravity = Gravity.CENTER
            b.setPadding(dip(16), dip(10), dip(16), dip(10))
            b.setOnClickListener { onClick(b) }
            toolbar.addView(b, LinearLayout.LayoutParams(dip(48), ViewGroup.LayoutParams.WRAP_CONTENT))
            return b
        }
        hostLabel = TextView(this).apply {
            text = hostOf(url)
            setTextColor(text3)
            textSize = 13f
            gravity = Gravity.CENTER_VERTICAL
            maxLines = 1
        }
        toolbar.addView(hostLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
            .apply { marginStart = dip(4); marginEnd = dip(4) })

        // ── the WebView ───────────────────────────────────────────────
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.setSupportZoom(true)
        webView.settings.builtInZoomControls = true
        webView.settings.displayZoomControls = false
        // the app-global cookie profile: logins made here persist for the
        // next open AND for the main WebView
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return false
                return handleNav(u)
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return url?.let { handleNav(it) } ?: false
            }

            // everything loads IN the viewer (top-level nav — the whole
            // point). Only non-web schemes leave it.
            private fun handleNav(u: String): Boolean {
                if (u.startsWith("http://") || u.startsWith("https://")) return false
                if (u.startsWith("doomalay://")) {
                    // the OAuth done page's return link — hand it to the
                    // main activity and get out of the way
                    try {
                        startActivity(Intent(this@ViewerActivity, MainActivity::class.java).apply {
                            data = android.net.Uri.parse(u)
                            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        })
                    } catch (e: Exception) {
                        AppLog.error("viewer deep-link forward failed", e)
                    }
                    finish()
                    return true
                }
                return try { // mailto:, tel:, intent: …
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)))
                    true
                } catch (e: Exception) {
                    AppLog.error("viewer external scheme failed: $u", e)
                    true
                }
            }

            override fun onPageFinished(view: WebView?, u: String?) {
                super.onPageFinished(view, u)
                hostLabel.text = hostOf(u ?: url)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // video fullscreen (the YouTube □ button) — cover everything
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                toolbar.visibility = View.GONE
                root.addView(view, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }

            override fun onHideCustomView() {
                (customView?.parent as? ViewGroup)?.removeView(customView)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                toolbar.visibility = View.VISIBLE
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        root = FrameLayout(this).apply {
            setBackgroundColor(bg)
            addView(webView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bg)
            addView(toolbar, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(root, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        // a hairline under the toolbar so it reads as chrome over content
        val hairline = View(this)
        hairline.setBackgroundColor(border)
        hairline.alpha = 0.35f
        column.addView(hairline, 1, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 1))

        // ── wire the toolbar ──────────────────────────────────────────
        toolBtn("‹", "back") {
            when {
                customView != null -> hideCustomNow()
                webView.canGoBack() -> webView.goBack()
                else -> finish()
            }
        }
        toolBtn("↻", "reload") { webView.reload() }
        toolBtn("⤢", "open in a browser tab") { openCustomTab(url, accent) }
        toolBtn("✕", "close") { finish() }

        setContentView(column)
        webView.loadUrl(url)
    }

    // the escape hatch for pages that misbehave in a WebView (Google
    // login walls): a Chrome Custom Tab rides the user's Chrome session.
    private fun openCustomTab(url: String, accent: Int) {
        try {
            val builder = androidx.browser.customtabs.CustomTabsIntent.Builder()
                .setShowTitle(true)
                .setToolbarColor(accent)
            builder.build().launchUrl(this, android.net.Uri.parse(url))
        } catch (e: Exception) {
            AppLog.error("custom tab failed, falling back to system browser", e)
            try {
                startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
            } catch (e2: Exception) {
                AppLog.error("system browser also failed", e2)
            }
        }
    }

    private fun hideCustomNow() {
        (customView?.parent as? ViewGroup)?.removeView(customView)
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        toolbar.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> hideCustomNow()
            this::webView.isInitialized && webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // persist this session's cookies for the next open
        if (this::webView.isInitialized) CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    // ── helpers ──────────────────────────────────────────────────────

    // a CSS var value from the web UI's snapshot ("#a78bfa" or
    // "rgb(167,139,250)"), or the fallback when absent
    private fun col(key: String, fallback: Int): Int {
        val v = themeJson.optJSONObject("theme")?.optString(key) ?: themeJson.optString(key, "")
        return parseCssColor(v, fallback)
    }

    private fun parseCssColor(v: String, fallback: Int): Int {
        val s = v.trim()
        if (s.isEmpty()) return fallback
        return try {
            if (s.startsWith("#")) Color.parseColor(s)
            else if (s.startsWith("rgb", ignoreCase = true)) {
                val nums = Regex("-?\\d+").findAll(s).map { it.value.toInt() }.toList()
                if (nums.size >= 3) Color.rgb(
                    nums[0].coerceIn(0, 255), nums[1].coerceIn(0, 255), nums[2].coerceIn(0, 255))
                else fallback
            } else fallback
        } catch (e: Exception) {
            fallback
        }
    }

    // the SYSTEM theme's own attributes — the no-hardcode fallback
    private fun sysColor(attr: Int, lastResort: Int): Int {
        return try {
            val ta = getTheme().obtainStyledAttributes(intArrayOf(attr))
            val c = ta.getColor(0, lastResort)
            ta.recycle()
            c
        } catch (e: Exception) {
            lastResort
        }
    }

    private fun hostOf(u: String?): String {
        return try {
            java.net.URI(u ?: "").host ?: u?.take(40) ?: ""
        } catch (e: Exception) {
            (u ?: "").take(40)
        }
    }

    private fun dip(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun statusBarPad(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else dip(8)
    }
}
