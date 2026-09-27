package com.doomalay.engine

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

// PanelBrowserSheet — v0.64.0 THE NATIVE PANEL BROWSER (PLAN-V0640).
//
// USER SPEC: "If we can somehow render the native WebView into a
// scrollable snapable panel, a feature or push that is solely reserved
// for the APK versions and other versions that support it.. let's do so
// it's worth it… The panel browser feature is meant for apk and phones
// only. For desktops, we should not hesitate to redirect users."
//
// THE VERDICT THIS CLASS EMBODIES: the v0.63.x dock rendered pages in an
// <iframe> inside the SPA — X-Frame-Options / CSP frame-ancestors
// (anti-clickjacking headers the ENGINE itself enforces on iframes)
// made most big sites refuse, and no JS can ever lift a third party's
// frame guards. The full-screen browser-in-browser (ViewerActivity)
// loads every page because it is a NATIVE WebView — a TOP-LEVEL
// browsing context those guards do not govern. So the panel browser is
// now THE SAME NATIVE WEBVIEW docked as a bottom sheet INSIDE
// MainActivity, floating over the untouched SPA:
//
//   · THE STRIP (the v0.63.4 spec, natively): [↻ url-pill] —— [‹][⧉][✕]
//     — the pill is surface-tinted @0.92 alpha with a theme border, tap
//     = COPY the link (+ toast); ↻ reloads; ‹ walks the WebView's own
//     history (a REAL history — in-page link clicks included, which the
//     iframe dock could never see); ⧉ is THE BOX+ARROW (leave the app:
//     ACTION_VIEW → Chrome Custom Tab → system browser); ✕ dismisses;
//     the dash stays dead-center (the 1fr·auto·1fr grid, natively).
//   · THE SNAPS — gesture.js parity, ported 1:1: two docks (full 100% /
//     default 62% of the content height), drag the strip, fling up →
//     full, fling down from full → default, fling down from default →
//     dismiss, deliberate drag past the tuned fractions → dismiss, the
//     scrim tap dismisses. The same constants (FLING_VY 0.55 px/ms,
//     CLOSE_FRAC 0.32 …) so the sheet FEELS like the same panel.
//   · THE WEBVIEW — the ViewerActivity engine: JS + DOM storage, pinch
//     zoom, the app-global cookie profile (logins shared with the main
//     WebView), http/https loads in place (frame guards never apply),
//     doomalay:// dismisses + wakes the SPA's visibilitychange
//     refetch, other schemes ride ACTION_VIEW, video fullscreen
//     (onShowCustomView) covers the activity, downloads (pdfs, files)
//     hand off to the system — the v0.62.3 export path.
//   · RESUMABLE — closing only hides the overlay; the WebView (its
//     history, its cookies, its media position) survives to the next
//     open at the SAME dock. A re-tap of a different link navigates the
//     living sheet; the same link just resurfaces it.
//   · THEME — the CSS-var snapshot arrives on EVERY openPanel call
//     (InAppBrowser v3's themeSnapshot()) and re-tints everything:
//     sheet/pill/WebView backgrounds, borders, icon + URL tints, the
//     dash, the loadbar accent. System theme attrs are the fallback —
//     nothing is hardcoded in use.
//
// The SPA never navigates and never paints a frame of the browsed page
// — browserdock.js just calls __doomalayKotlin.openPanel(url, opts) and
// this sheet docks over it. Every surface without that bridge method
// (desktop, HF Space, self-host, phone browsers, pre-v0.64 APKs) never
// sees a panel browser at all — InAppBrowser.open routes them straight
// to the popup/tab browser-in-browser.
class PanelBrowserSheet(private val activity: MainActivity) {

    // ── gesture.js parity (the web panel's two docks + release tuning) ──
    companion object {
        private const val DEFAULT_FRAC = 0.62f     // the half dock (bottom 62%)
        private const val FLING_VY = 0.55f         // px/ms — a genuinely hard swipe
        private const val DOCK_VY = 0.18f          // gentle downward motion docks (from full)
        private const val UP_DRAG_FRAC = 0.22f     // dragged up > 22% of height → full intent
        private const val FULL_DOCK_FRAC = 0.10f   // from full: > 10% down drag docks at default
        private const val FULL_CLOSE_FRAC = 0.55f  // from full: > 55% slow drag closes
        private const val CLOSE_FRAC = 0.32f       // from default: > 32% deliberate drag closes
        private const val PROJECTION_MS = 140f     // release velocity horizon
        private const val SNAP_MS = 220L           // dock-to-dock glide
        private const val RISE_MS = 250L           // the open rise (gesture.js's open curve)
        private const val CLOSE_MS = 200L          // the dismiss slide
        private const val MAX_SCRIM = 0.45f        // the dim over the app at full dock
    }

    // ── views (built once; re-added if an error screen swapped content) ──
    private var overlay: FrameLayout? = null
    private var scrim: View? = null
    private var sheet: LinearLayout? = null
    private var pill: LinearLayout? = null
    private var pillText: TextView? = null
    private var dash: View? = null
    private var backBtn: ImageButton? = null
    private var extBtn: ImageButton? = null
    private var closeBtn: ImageButton? = null
    private var loadbar: View? = null
    private var webView: WebView? = null

    // video fullscreen (the YouTube □ button)
    private var customView: View? = null
    private var customCover: FrameLayout? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    // geometry: curOffset = px the always-tall sheet is pushed DOWN
    // (0 = full dock · (1-DEFAULT_FRAC)*H = default · H = closed)
    private var fullH = 0
    private var curOffset = 0f
    private var atFull = false
    private var everOpened = false

    @Volatile private var showing = false
    @Volatile private var liveUrl = ""

    // drag tracking (the strip is the handle — 1:1 finger follow)
    private var dragStartY = 0f
    private var dragStartOffset = 0f
    private var dragFromFull = false
    private var lastMoveY = 0f
    private var lastMoveT = 0L
    private var velY = 0f
    private var dragging = false

    // theme (the live CSS-var snapshot; re-applied on every open)
    private var themeJson = JSONObject()

    // ─────────────────────────────────────────────────────── the surface
    fun open(url: String, optsJson: String) {
        try { themeJson = JSONObject(optsJson) } catch (e: Exception) { themeJson = JSONObject() }
        ensureViews()
        applyTheme()
        val w = webView ?: return
        liveUrl = url
        if (!showing) {
            // a fresh dock (or a resurface): the first ever open rides the
            // default (half) dock like the web panel; later opens resume
            // the dock the user last left the sheet at.
            if (w.url == null || w.url != url) w.loadUrl(url)
            showAt(if (everOpened) atFull else false)
            everOpened = true
        } else if (w.url != url) {
            w.loadUrl(url)
        }
    }

    fun isOpen(): Boolean = showing
    fun currentUrl(): String = liveUrl

    fun dismiss() {
        if (!showing) return
        showing = false
        val h = if (fullH > 0) fullH.toFloat() else 1f
        animateTo(h, CLOSE_MS) { overlay?.visibility = View.GONE }
    }

    // Android back (native — consumed BEFORE the SPA is ever consulted):
    // video fullscreen → exit; WebView history → walk; else dismiss.
    fun handleBack(): Boolean {
        if (customView != null) { hideCustomNow(); return true }
        if (!showing) return false
        val w = webView
        if (w != null && w.canGoBack()) { w.goBack(); return true }
        dismiss()
        return true
    }

    fun onPause() { try { webView?.onPause() } catch (e: Exception) {} }
    fun onResume() { try { webView?.onResume() } catch (e: Exception) {} }

    // rotation (configChanges — no recreate): re-measure + re-seat the
    // current dock instantly so the offsets never go stale.
    fun relayout() {
        if (!showing) return
        val ov = overlay ?: return
        ov.post {
            fullH = ov.height
            if (fullH > 0) {
                curOffset = offsetFor(atFull)
                sheet?.translationY = curOffset
                scrim?.alpha = scrimFor(curOffset)
            }
        }
    }

    // ─────────────────────────────────────────────────────────── view building
    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureViews() {
        if (overlay != null && overlay?.parent != null) return

        val bg = col("bgPanel", sysColor(android.R.attr.colorBackground, Color.BLACK))

        // the pill: [↻ url] — tap = copy, drag = the sheet (disambiguated
        // by the slop in makeDraggable)
        val refresh = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_refresh)
            background = null
            setPadding(dip(3), dip(3), dip(3), dip(3))
            contentDescription = "Refresh page"
        }
        pillText = TextView(activity).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
            maxWidth = dip(170)     // the pill shrinks to its text but caps
            textSize = 12f
            setPadding(dip(4), 0, dip(6), 0)
        }
        val pillLocal = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dip(6), dip(5), dip(10), dip(5))
            addView(refresh, LinearLayout.LayoutParams(dip(24), dip(24)))
            addView(pillText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        pill = pillLocal

        // the dash — the grab hint, dead-center (1fr · auto · 1fr)
        dash = View(activity)

        // ‹ ⧉ ✕ — the three acts. 34dp slots, theme border, icon tint.
        fun actBtn(drawableRes: Int, title: String): ImageButton {
            val b = ImageButton(activity)
            b.setImageResource(drawableRes)
            b.contentDescription = title
            b.setPadding(dip(8), dip(8), dip(8), dip(8))
            return b
        }
        backBtn = actBtn(R.drawable.ic_chevron_left, "Back")
        extBtn = actBtn(R.drawable.ic_external_link, "Open outside the app")
        closeBtn = actBtn(R.drawable.ic_close, "Close browser")
        val acts = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(backBtn, LinearLayout.LayoutParams(dip(34), dip(34)))
            addView(extBtn, LinearLayout.LayoutParams(dip(34), dip(34)))
            addView(closeBtn, LinearLayout.LayoutParams(dip(34), dip(34)))
        }

        val cellL = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            addView(pillLocal, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val cellR = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
            addView(acts, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val strip = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dip(10), dip(7), dip(10), dip(7))
            addView(cellL, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(dash, LinearLayout.LayoutParams(dip(36), dip(4))
                .apply { gravity = Gravity.CENTER_VERTICAL })
            addView(cellR, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        loadbar = View(activity)

        webView = WebView(activity).apply {
            setBackgroundColor(bg)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setSupportZoom(true)
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {
                // TOP-LEVEL navigation — the whole point: frame guards
                // (X-Frame-Options / CSP frame-ancestors) govern IFRAMES
                // and never apply here, so every page the full-screen
                // browser-in-browser loads loads here too.
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    return request?.url?.toString()?.let { handleNav(it) } ?: false
                }
                @Suppress("DEPRECATION")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    return url?.let { handleNav(it) } ?: false
                }
                private fun handleNav(u: String): Boolean {
                    if (u.startsWith("http://") || u.startsWith("https://")) return false
                    if (u.startsWith("doomalay://")) {
                        // an OAuth return page landed in the sheet — the
                        // SPA never lost visibility, so wake its
                        // visibilitychange refetch manually, then get out
                        // of the way (the v0.60 lesson, sheet edition).
                        activity.runOnUiThread {
                            dismiss()
                            activity.wakeSpa()
                        }
                        return true
                    }
                    return try { // mailto:, tel:, intent: …
                        activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)))
                        true
                    } catch (e: Exception) {
                        AppLog.error("panel external scheme failed: $u", e)
                        true
                    }
                }

                override fun onPageStarted(view: WebView?, u: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, u, favicon)
                    if (u != null) liveUrl = u
                    pillText?.text = u ?: liveUrl
                    loadbar?.visibility = View.VISIBLE
                }

                override fun onPageFinished(view: WebView?, u: String?) {
                    super.onPageFinished(view, u)
                    if (u != null) liveUrl = u
                    pillText?.text = u ?: liveUrl
                    loadbar?.visibility = View.GONE
                    val canBack = view != null && view.canGoBack()
                    backBtn?.isEnabled = canBack
                    backBtn?.alpha = if (canBack) 1f else 0.38f
                }
            }

            webChromeClient = object : WebChromeClient() {
                // video fullscreen (the YouTube □ button) — a black cover
                // over the whole activity; back / the site's exit restores
                // the sheet exactly as it was.
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    if (customView != null) { callback.onCustomViewHidden(); return }
                    customView = view
                    customViewCallback = callback
                    val cover = FrameLayout(activity).apply {
                        setBackgroundColor(Color.BLACK) // the video canvas, not UI chrome
                        addView(view, FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    }
                    customCover = cover
                    activity.addContentView(cover, FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                override fun onHideCustomView() { hideCustomNow() }
            }

            // downloads (a direct pdf/file link): hand off to the system,
            // exactly the v0.62.3 export path.
            setDownloadListener { url, _, _, _, _ ->
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                } catch (e: Exception) {
                    AppLog.error("panel download handoff failed: $url", e)
                }
            }
        }

        val body = FrameLayout(activity).apply {
            addView(loadbar, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dip(2), Gravity.TOP))
            addView(webView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        sheet = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(strip, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(body, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }

        scrim = View(activity).apply { setOnClickListener { dismiss() } }
        overlay = FrameLayout(activity).apply {
            addView(scrim, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(sheet, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            visibility = View.GONE
        }
        activity.addContentView(overlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // ── wire the chrome ──────────────────────────────────────────
        refresh.setOnClickListener { webView?.reload() }
        backBtn?.setOnClickListener { if (webView?.canGoBack() == true) webView?.goBack() }
        extBtn?.setOnClickListener { openExternal(liveUrl) }
        closeBtn?.setOnClickListener { dismiss() }

        // THE DRAG SURFACE: the strip + the pill follow the finger (a tap
        // on the pill still copies — drag vs tap is disambiguated by the
        // 6dp slop). The act buttons consume their own touches, so a drag
        // never fights a ‹/⧉/✕ click and vice versa.
        makeDraggable(strip)
        makeDraggable(pillLocal) { copyLink() }

        backBtn?.isEnabled = false
        backBtn?.alpha = 0.38f
    }

    // drag + tap disambiguation on one view. `tap` (optional) fires only
    // when the touch never crossed the slop — the pill both drags AND
    // copies.
    @SuppressLint("ClickableViewAccessibility")
    private fun makeDraggable(v: View, tap: (() -> Unit)? = null) {
        v.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragStartY = ev.rawY
                    dragStartOffset = curOffset
                    dragFromFull = atFull
                    lastMoveY = ev.rawY
                    lastMoveT = SystemClock.uptimeMillis()
                    velY = 0f
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = ev.rawY - dragStartY
                    if (!dragging && Math.abs(dy) > dip(6)) dragging = true
                    if (dragging && fullH > 0) {
                        curOffset = (dragStartOffset + dy).coerceIn(0f, fullH.toFloat())
                        sheet?.translationY = curOffset
                        scrim?.alpha = scrimFor(curOffset)
                    }
                    val now = SystemClock.uptimeMillis()
                    val dt = now - lastMoveT
                    if (dt > 0) velY = (ev.rawY - lastMoveY) / dt.toFloat()
                    lastMoveY = ev.rawY
                    lastMoveT = now
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        release(velY, curOffset - dragStartOffset)
                    } else if (ev.actionMasked == MotionEvent.ACTION_UP) {
                        tap?.invoke()
                    }
                    dragging = false
                    true
                }
                else -> false
            }
        }
    }

    // gesture.js decide(), ported verbatim: velocity projection leads,
    // the tuned intent thresholds confirm. Three landings on the
    // fraction line: 0 (closed) / .62 (default) / 1 (full).
    private fun release(vy: Float, dy: Float) {
        if (fullH <= 0) { dismiss(); return }
        val h = fullH.toFloat()
        val downward = dy > 0
        val upward = dy < 0
        val projected = dy + vy * PROJECTION_MS
        val fromFrac = 1f - dragStartOffset / h
        val toFrac = fromFrac - projected / h
        val target: String
        if (upward && (vy < -FLING_VY || Math.abs(dy) > h * UP_DRAG_FRAC || toFrac >= 0.82f)) {
            target = "full"
        } else if (dragFromFull) {
            target = when {
                downward && vy > FLING_VY -> "close"
                downward && dy > h * FULL_CLOSE_FRAC -> "close"
                downward && (toFrac <= 0.30f || dy > h * FULL_DOCK_FRAC || vy > DOCK_VY) -> "default"
                else -> "full"
            }
        } else {
            target = when {
                downward && vy > FLING_VY -> "close"
                downward && dy > h * CLOSE_FRAC -> "close"
                upward && toFrac >= 0.82f -> "full"
                else -> "default"
            }
        }
        when (target) {
            "full" -> { atFull = true; animateTo(0f, SNAP_MS) {} }
            "default" -> { atFull = false; animateTo(offsetForDefault(), SNAP_MS) {} }
            else -> dismiss()
        }
    }

    // ── geometry + motion ─────────────────────────────────────────────
    private fun offsetForDefault(): Float = fullH * (1f - DEFAULT_FRAC)
    private fun offsetFor(full: Boolean): Float = if (full) 0f else offsetForDefault()
    private fun scrimFor(offset: Float): Float =
        if (fullH > 0) MAX_SCRIM * (1f - offset / fullH) else 0f

    private fun showAt(full: Boolean) {
        val ov = overlay ?: return
        if (ov.parent == null) activity.addContentView(ov, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        showing = true
        atFull = full
        ov.visibility = View.VISIBLE
        // park fully off-screen first (a GONE view measures 0 — the real
        // height only exists once VISIBLE), then rise to the dock.
        curOffset = 100000f
        sheet?.translationY = curOffset
        scrim?.alpha = 0f
        ov.post {
            fullH = ov.height
            if (fullH <= 0) fullH = activity.resources.displayMetrics.heightPixels
            curOffset = fullH.toFloat()
            sheet?.translationY = curOffset
            animateTo(offsetFor(full), RISE_MS) {}
        }
    }

    private fun animateTo(target: Float, ms: Long, end: () -> Unit) {
        val sh = sheet ?: run { end(); return }
        val a = android.animation.ValueAnimator.ofFloat(curOffset, target)
        a.duration = ms
        a.interpolator = DecelerateInterpolator(1.2f)
        a.addUpdateListener { an ->
            curOffset = an.animatedValue as Float
            sh.translationY = curOffset
            scrim?.alpha = scrimFor(curOffset)
        }
        // (AnimatorListenerAdapter: the SDK's onAnimationEnd takes a
        // NON-NULL Animator — a nullable override "overrides nothing"
        // and fails the Kotlin build, the v0.64.0 CI lesson.)
        a.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) { end() }
        })
        a.start()
    }

    // ── the chrome actions ────────────────────────────────────────────
    private fun copyLink() {
        if (liveUrl.isEmpty()) return
        try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("link", liveUrl))
            Toast.makeText(activity, "Link copied", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            AppLog.error("panel copy failed", e)
        }
    }

    // THE BOX+ARROW: ACTION_VIEW lets the site's NATIVE app claim its
    // domain; a Chrome Custom Tab (the user's Chrome session) is the
    // fallback, the system browser the last resort.
    private fun openExternal(url: String) {
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        } catch (e: Exception) {
            AppLog.error("panel ACTION_VIEW failed — custom tab", e)
            try {
                val b = androidx.browser.customtabs.CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setToolbarColor(col("accent", sysColor(android.R.attr.colorAccent, Color.DKGRAY)))
                b.build().launchUrl(activity, android.net.Uri.parse(url))
            } catch (e2: Exception) {
                AppLog.error("panel custom tab also failed", e2)
            }
        }
    }

    private fun hideCustomNow() {
        (customCover?.parent as? ViewGroup)?.removeView(customCover)
        (customView?.parent as? ViewGroup)?.removeView(customView)
        customCover = null
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ── theme: the live CSS-var snapshot, re-applied per open ─────────
    private fun applyTheme() {
        val bg = col("bgPanel", sysColor(android.R.attr.colorBackground, Color.BLACK))
        val surface = col("surface", bg)
        val text1 = col("text1", sysColor(android.R.attr.colorForeground, Color.WHITE))
        val text3 = col("text3", text1)
        val border = col("border", text1)
        val accent = col("accent", sysColor(android.R.attr.colorAccent, Color.LTGRAY))

        // the sheet: the panel surface, top-rounded 16dp + clipped so the
        // WebView wears the same corners
        val r = dip(16).toFloat()
        sheet?.background = GradientDrawable().apply {
            setColor(bg)
            cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        }
        sheet?.clipToOutline = true
        sheet?.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                // extend the outline past the bottom so only the TOP
                // corners round (the bottom arcs fall out of bounds)
                val rr = 16f * view.resources.displayMetrics.density
                outline.setRoundRect(0, 0, view.width, view.height + rr.toInt(), rr)
            }
        }

        // the pill: surface @0.92, fully rounded, 1dp theme border
        pill?.background = GradientDrawable().apply {
            setColor(surface)
            cornerRadius = dip(200).toFloat()
            setStroke(dip(1), border)
        }
        pill?.alpha = 0.92f
        pillText?.setTextColor(text3)

        // the dash: the theme's own text color @ 30% — the grab hint
        dash?.background = GradientDrawable().apply {
            setColor((text1 and 0x00FFFFFF) or 0x4D000000)
            cornerRadius = dip(2).toFloat()
        }

        // the acts: transparent squares with the theme border + icon tint
        fun actBg(): GradientDrawable = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            cornerRadius = dip(9).toFloat()
            setStroke(dip(1), border)
        }
        for (b in listOf(backBtn, extBtn, closeBtn)) {
            b?.background = actBg()
            b?.imageTintList = ColorStateList.valueOf(text1)
        }
        backBtn?.alpha = if (backBtn?.isEnabled == true) 1f else 0.38f

        loadbar?.setBackgroundColor(accent)
        webView?.setBackgroundColor(bg)
    }

    // ── color helpers (the ViewerActivity recipe) ─────────────────────
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
        } catch (e: Exception) { fallback }
    }

    private fun sysColor(attr: Int, lastResort: Int): Int = try {
        val ta = activity.theme.obtainStyledAttributes(intArrayOf(attr))
        val c = ta.getColor(0, lastResort)
        ta.recycle()
        c
    } catch (e: Exception) { lastResort }

    private fun dip(v: Int): Int = (v * activity.resources.displayMetrics.density).toInt()
}
