package com.doomalay.engine

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
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

// PanelBrowserSheet — v0.64.3 THE TIDY PILL (PLAN-V0643) on top of
// v0.64.2 THE POLISH WAVE (PLAN-V0642) on top of v0.64.0 THE NATIVE
// PANEL BROWSER (PLAN-V0640).
//
// v0.64.3 SPEC ("that was a job well done. Good job. Let's make the
// search pill… 10% less wide and high… the hitbox for the refresh
// icon bigger… the smooth loading icon… upward approx 35%… a loading
// pill, similar to the one we have when the chatbot is thinking… to
// the web link pill… only when the website is actively loading"):
//
//   · THE TIDY PILL — the URL capsule ("the search pill", the user's
//     name for it since the polish round) loses ~10% of its width and
//     height: 30dp tall (was 34: the refresh slot grew but the 2×5dp
//     vertical padding is gone), the text cap 170→153dp, the paddings
//     a hair tighter. It reads slimmer next to the 34dp act circles.
//   · THE REFRESH HITBOX — the ↻ ImageButton grows 24×24 → 30×30
//     (+25% a side, +56% area — much easier to press) while its glyph
//     stays 18dp (padding 3→6dp): the button now fills the pill's full
//     height at its left edge. Its ripple circle follows 12→15dp.
//   · THE RING LIFTED — the loading stack (ring + link text) moves up
//     by 35% of the overlay's height (center 50% → 15% — the spinner
//     sits just under the strip, where a browser's progress lives),
//     clamped so the stack's top never leaves the body (the 30% duck
//     peek has a short body; the clamp keeps ≥ ~13dp of headroom).
//   · THE LOADING PILL — the chatbot's thinking pill (chatpanel.js
//     v0.23, five pulsing accent dots — cwd-pulse: 0.9s cycle, 0.12s
//     stagger, opacity .18→1, scale .82→1.12) becomes a LoadDots view
//     at the END of the URL capsule: GONE unless a page is actively
//     loading, fading with the overlay's own 110/160ms timing, tinted
//     by the theme snapshot's accent per open. setLoading() is the
//     one truth — body overlay AND pill dots ride the same calls.
//
// v0.64.0 SPEC (still the foundation): "If we can somehow render the
// native WebView into a scrollable snapable panel, a feature or a push
// that is solely reserved for the APK versions and other versions that
// support it.. let's do so it's worth it… The panel browser feature is
// meant for apk and phones only. For desktops, we should not hesitate
// to redirect users." — the v0.63.x iframe dock could never load what
// the browser-in-browser loads (X-Frame-Options / CSP frame-ancestors
// are ENGINE-enforced on iframes; a native WebView is a TOP-LEVEL
// context those guards do not govern), so the panel browser IS the
// browser-in-browser's own engine docked as a native bottom sheet
// inside MainActivity, over the untouched SPA.
//
// v0.64.2 SPEC (this wave — "The panel browser in browser is actually
// incredible. It's amazing seriously. Just please let's polish…"):
//
//   · THE PILL POLISH — the four pills up-top ([↻ url] · ‹ · ⧉ · ✕)
//     become ONE chip family: surface fill + 1dp theme border + an
//     accent RippleDrawable clipped to each shape (the acts are 34dp
//     CIRCLES now; the URL pill keeps its capsule; the stray 0.92
//     alpha is gone so all four read identically). The ↻ glyph gets a
//     transparent-content circular ripple of its own AND spins while a
//     page loads. A 1dp hairline (border @ ~32%) under the strip gives
//     the chrome its edge; the dash widens 36→40dp.
//   · THE LOADING OVERLAY — "a very polished neat circular loading bar
//     that uses theme colors + a loading (website link) text while the
//     panel is loading instead of a black screen". The 2dp top loadbar
//     is retired; in its place a full-body overlay over the WebView:
//     a hand-drawn LoadRing (border-@~18% track + a 96° accent arc
//     with round caps, spun on a linear infinite animator) above the
//     loading URL (13sp, text3, middle-ellipsized, 280dp cap). Timing:
//     onPageStarted shows it, onPageCommitVisible (the FIRST PAINT —
//     a rendered page is never covered) hides it, onPageFinished is
//     the safety net; a sequence token kills the redirect race.
//   · THE SECRET THIRD DOCK — "while the panel is open and half docked,
//     the user can press the canvas and still move it… doing so puts
//     the canvas back into focus (undarknes it/removes the filter) and
//     docks the panel to a third secret position - a position that
//     fills only like 30% of the screen… temporary for ~3 seconds with
//     a retriggrable delay every time the user retouched the screen."
//     A press on the app behind the half-docked sheet (the canvas
//     strip it leaves visible) glides the sheet to the 30% peek;
//     MainActivity's SPA touch listener (returns FALSE — the touch
//     always flows on into the SPA, so the canvas pans immediately)
//     is the trigger; every retouch (canvas OR the ducked panel)
//     retriggers the 3s hold; expiry glides back to the 62% dock. The
//     "filter" over the canvas is the SPA's own #chat-scrim dim —
//     notifyState() broadcasts {open, ducked} to
//     window.__doomalayPanelState (browserdock.js), which suspends
//     the scrim's pointer-events while the sheet is up (taps must
//     reach the canvas) and lifts its opacity while ducked (canvas
//     focus). THE OLD SCRIM IS RETIRED with its tap-to-dismiss — a
//     canvas press is a duck now; dismiss stays ✕ / drag-fling /
//     Android back. The full dock never ducks (no canvas to press);
//     a hand on the strip cancels the duck (release() owns the
//     landing).
//
// Everything else is v0.64.0 verbatim: the strip contract (the pill
// tap = COPY + toast, ‹ walks the REAL WebView history, ⧉ is THE
// BOX+ARROW (ACTION_VIEW → Custom Tab → system browser), ✕ dismisses,
// the dash dead-center), gesture.js parity (FLING_VY 0.55, CLOSE_FRAC
// 0.32, velocity projection 140ms), the ViewerActivity-grade WebView
// (cookies shared, video fullscreen, downloads → system, doomalay://
// → dismiss + wakeSpa), resumable (close only hides), and THEME — the
// live CSS-var snapshot re-tints everything on every open; system
// theme attrs are the fallback, nothing hardcoded in use.
class PanelBrowserSheet(private val activity: MainActivity) {

    // ── gesture.js parity (the web panel's docks + release tuning) ──
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

        // v0.64.2: THE SECRET THIRD DOCK — the canvas-duck peek
        private const val DUCK_FRAC = 0.30f        // the sheet fills only ~30% of the screen
        private const val DUCK_HOLD_MS = 3000L     // the retriggerable temporary hold
    }

    // ── views (built once; re-added if an error screen swapped content) ──
    private var overlay: FrameLayout? = null
    private var sheet: LinearLayout? = null
    private var pill: LinearLayout? = null
    private var pillText: TextView? = null
    private var refreshIcon: ImageButton? = null
    private var dash: View? = null
    private var divider: View? = null
    private var backBtn: ImageButton? = null
    private var extBtn: ImageButton? = null
    private var closeBtn: ImageButton? = null
    private var loading: FrameLayout? = null
    private var loadRing: LoadRing? = null
    private var loadStack: LinearLayout? = null
    private var loadText: TextView? = null
    private var loadDots: LoadDots? = null
    private var webView: WebView? = null

    // video fullscreen (the YouTube □ button)
    private var customView: View? = null
    private var customCover: FrameLayout? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    // geometry: curOffset = px the always-tall sheet is pushed DOWN
    // (0 = full dock · (1-DEFAULT_FRAC)*H = default · (1-DUCK_FRAC)*H =
    // the duck peek · H = closed)
    private var fullH = 0
    private var curOffset = 0f
    private var atFull = false
    private var everOpened = false

    // v0.64.2: the canvas-duck state + its retriggerable hold
    private var ducked = false
    private val duckHandler = Handler(Looper.getMainLooper())
    private val unduckRunnable = Runnable { unduck() }

    // v0.64.2: the loading spins (the ring + the ↻ glyph)
    private var ringSpin: ValueAnimator? = null
    private var iconSpin: ObjectAnimator? = null
    private var dotsSpin: ValueAnimator? = null
    private var loadSeq = 0L

    // v0.64.2: the last glide owns the sheet — animateTo cancels the
    // prior animator (also fixes the pre-existing close→reopen race,
    // where a stale close's GONE end-action buried a fresh reopen)
    private var snapAnim: ValueAnimator? = null

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
        } else {
            // a tap on another (or the same) link while the sheet is up:
            // the attention is back on the panel — rise out of any duck
            if (ducked) cancelDuck(restoreDock = true)
            if (w.url != url) w.loadUrl(url)
        }
    }

    fun isOpen(): Boolean = showing
    fun currentUrl(): String = liveUrl

    fun dismiss() {
        if (!showing) return
        duckHandler.removeCallbacks(unduckRunnable)
        ducked = false
        showing = false
        setLoading(false, null)
        val h = if (fullH > 0) fullH.toFloat() else 1f
        // (the GONE end-action is guarded — a reopen inside CLOSE_MS
        // cancels this glide, and the cancel-fired end must not bury it)
        animateTo(h, CLOSE_MS) { if (!showing) overlay?.visibility = View.GONE }
        notifyState()
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
                curOffset = if (ducked) offsetForDuck() else offsetFor(atFull)
                sheet?.translationY = curOffset
            }
        }
    }

    // ── v0.64.2: THE SECRET THIRD DOCK (the canvas-duck) ─────────────
    //
    // MainActivity's SPA touch listener calls this on EVERY press that
    // lands on the app behind the sheet. At the half dock it ducks
    // (the 30% peek + the canvas focus broadcast); while ducked it is
    // the retrigger (the ~3s hold restarts). The full dock ignores it
    // (no canvas is visible to press). The touch itself is never
    // eaten — the listener returns false, so the canvas pans on the
    // very first press, under the gliding sheet.
    fun onSpaTouch() {
        if (!showing || atFull) return
        duckForCanvas()
    }

    private fun duckForCanvas() {
        if (!showing || atFull) return
        if (ducked) { resetDuckTimer(); return }
        ducked = true
        if (fullH > 0) animateTo(offsetForDuck(), SNAP_MS) {}
        resetDuckTimer()
        notifyState()
    }

    // the ~3s hold expired — the sheet glides back to the half dock and
    // the canvas dim is restored (the SPA's scrim re-darkens).
    private fun unduck() {
        duckHandler.removeCallbacks(unduckRunnable)
        if (!showing || !ducked) return
        ducked = false
        if (!atFull && fullH > 0) animateTo(offsetForDefault(), SNAP_MS) {}
        notifyState()
    }

    // a hand on the strip (a REAL drag, past the slop) or a new open():
    // the duck dies, and with restoreDock the sheet rises back to the
    // half dock (open()'s "attention is back on the panel" case).
    private fun cancelDuck(restoreDock: Boolean) {
        duckHandler.removeCallbacks(unduckRunnable)
        if (!ducked) return
        ducked = false
        if (restoreDock && showing && !atFull && fullH > 0) {
            animateTo(offsetForDefault(), SNAP_MS) {}
        }
        notifyState()
    }

    private fun resetDuckTimer() {
        duckHandler.removeCallbacks(unduckRunnable)
        duckHandler.postDelayed(unduckRunnable, DUCK_HOLD_MS)
    }

    private fun offsetForDuck(): Float = fullH * (1f - DUCK_FRAC)

    // the state broadcast — browserdock.js's window.__doomalayPanelState
    // suspends the SPA's scrim taps while the sheet is up and lifts its
    // dim while ducked (the canvas focus). Guarded so a dead web layer
    // (engine restarting, SPA not loaded) is a silent no-op.
    private fun notifyState() {
        try {
            val st = JSONObject()
            st.put("open", showing)
            st.put("ducked", ducked)
            activity.spaEval("window.__doomalayPanelState && window.__doomalayPanelState(" + st.toString() + ")")
        } catch (e: Exception) {
            AppLog.error("panel state notify failed", e)
        }
    }

    // ─────────────────────────────────────────────────────────── view building
    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun ensureViews() {
        if (overlay != null && overlay?.parent != null) return

        val bg = col("bgPanel", sysColor(android.R.attr.colorBackground, Color.BLACK))

        // the pill: [↻ url •••••] — tap = copy, drag = the sheet (disambiguated
        // by the slop in makeDraggable); the ↻ glyph spins while loading;
        // v0.64.3: the LoadDots (the chatbot-thinking pill's five dots)
        // appear at the capsule's end while a page actively loads
        refreshIcon = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_refresh)
            background = null
            // v0.64.3: the hitbox grows 24→30dp; the glyph STAYS 18dp
            setPadding(dip(6), dip(6), dip(6), dip(6))
            contentDescription = "Refresh page"
        }
        pillText = TextView(activity).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
            maxWidth = dip(153)     // v0.64.3: 170→153 — the capsule caps 10% narrower
            textSize = 12f
            setPadding(dip(3), 0, dip(5), 0)
        }
        loadDots = LoadDots(activity)
        val pillLocal = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            // v0.64.3: (6,5,10,5)→(5,0,9,0) — with the 30dp refresh slot
            // the capsule stands 30dp tall (was 34 — ~10% less high)
            setPadding(dip(5), 0, dip(9), 0)
            addView(refreshIcon, LinearLayout.LayoutParams(dip(30), dip(30)))
            addView(pillText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(loadDots, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dip(5)
            })
        }
        pill = pillLocal

        // the dash — the grab hint, dead-center (1fr · auto · 1fr);
        // v0.64.2: 36→40dp, a touch wider to read at a glance
        dash = View(activity)

        // ‹ ⧉ ✕ — the three acts. 34dp slots, theme border, icon tint
        // (v0.64.2: they become full CIRCLES in applyTheme's chip family).
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
            addView(dash, LinearLayout.LayoutParams(dip(40), dip(4))
                .apply { gravity = Gravity.CENTER_VERTICAL })
            addView(cellR, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        // v0.64.2: the hairline under the strip — the chrome's edge
        divider = View(activity)

        webView = WebView(activity).apply {
            setBackgroundColor(bg)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setSupportZoom(true)
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            // v0.64.2: activity on the DUCKED panel itself retriggers the
            // ~3s hold (reading/scrolling the peek keeps the peek) — the
            // listener returns false, the page handles the touch normally.
            setOnTouchListener { _, ev ->
                if (ev.actionMasked == MotionEvent.ACTION_DOWN && ducked) resetDuckTimer()
                false
            }

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
                    setLoading(true, u)
                }

                // v0.64.2: the FIRST PAINT — the exact moment the loading
                // overlay has done its job (a rendered page is never
                // covered; onPageFinished stays as the safety net).
                override fun onPageCommitVisible(view: WebView?, u: String?) {
                    super.onPageCommitVisible(view, u)
                    setLoading(false, null)
                }

                override fun onPageFinished(view: WebView?, u: String?) {
                    super.onPageFinished(view, u)
                    if (u != null) liveUrl = u
                    pillText?.text = u ?: liveUrl
                    setLoading(false, null)
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

        // v0.64.2: THE LOADING OVERLAY — the circular bar + the link
        // text, theme-tinted per open (applyTheme); never consumes a
        // touch (the strip — the drag surface — lives outside the body,
        // and taps on a half-painted page pass through).
        // v0.64.3: THE RING LIFTED — the stack rides 35% of the overlay's
        // height ABOVE its center (center 50% → 15% — just under the
        // strip, where a browser's progress lives), clamped so the
        // stack's top never leaves a short body (the 30% duck peek).
        loadRing = LoadRing(activity)
        loadText = TextView(activity).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
            maxWidth = dip(280)
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(dip(10), 0, dip(10), 0)
        }
        val stackLocal = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(loadRing, LinearLayout.LayoutParams(dip(40), dip(40)))
            addView(loadText, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dip(16)
            })
        }
        loadStack = stackLocal
        loading = FrameLayout(activity).apply {
            visibility = View.GONE
            addView(stackLocal, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER))
            addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
                val h = v.height.toFloat()
                if (h > 0f) {
                    val lift = -0.35f * h                    // 35% of the body, upward
                    val cap = dip(50) - h / 2f               // the stack's top stays ≥ ~13dp inside
                    stackLocal.translationY = if (lift < cap) cap else lift
                }
            }
        }

        val body = FrameLayout(activity).apply {
            addView(webView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(loading, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        sheet = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(strip, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(divider, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dip(1)))
            addView(body, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }

        // v0.64.2: THE SCRIM IS RETIRED — it never drew anything (the
        // dim over the canvas is the SPA's own #chat-scrim, managed via
        // notifyState/browserdock.js), and its tap-to-dismiss is now the
        // duck: a press on the app behind the sheet falls through the
        // bare overlay into the SPA WebView, pans the canvas, and ducks
        // the sheet. Dismiss stays ✕ / drag-fling / Android back.
        overlay = FrameLayout(activity).apply {
            addView(sheet, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            visibility = View.GONE
        }
        activity.addContentView(overlay, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // ── wire the chrome ──────────────────────────────────────────
        refreshIcon?.setOnClickListener { webView?.reload() }
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
                    if (!dragging && Math.abs(dy) > dip(6)) {
                        dragging = true
                        // a REAL grab takes the sheet out of the duck —
                        // the hold dies and release() owns the landing
                        // (a mere tap keeps the duck + its timer)
                        if (ducked) cancelDuck(restoreDock = false)
                    }
                    if (dragging && fullH > 0) {
                        curOffset = (dragStartOffset + dy).coerceIn(0f, fullH.toFloat())
                        sheet?.translationY = curOffset
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
    // fraction line: 0 (closed) / .62 (default) / 1 (full). (The duck
    // peek is a programmatic dock — release() still decides from
    // wherever the finger let go, so a deliberate 0.32·H drag from the
    // duck closes and a fling down closes, exactly like from default.)
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
        ov.post {
            fullH = ov.height
            if (fullH <= 0) fullH = activity.resources.displayMetrics.heightPixels
            curOffset = fullH.toFloat()
            sheet?.translationY = curOffset
            animateTo(offsetFor(full), RISE_MS) {}
        }
        // the sheet owns the layer now — the SPA suspends its scrim taps
        notifyState()
    }

    private fun animateTo(target: Float, ms: Long, end: () -> Unit) {
        val sh = sheet ?: run { end(); return }
        // v0.64.2: the last glide owns the sheet — cancel any animator
        // still running (duck↔undock↔snap↔close sequences overlap now).
        snapAnim?.cancel()
        val a = ValueAnimator.ofFloat(curOffset, target)
        a.duration = ms
        a.interpolator = DecelerateInterpolator(1.2f)
        a.addUpdateListener { an ->
            curOffset = an.animatedValue as Float
            sh.translationY = curOffset
        }
        // (AnimatorListenerAdapter: the SDK's onAnimationEnd takes a
        // NON-NULL Animator — a nullable override "overrides nothing"
        // and fails the Kotlin build, the v0.64.0 CI lesson.)
        a.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) { end() }
        })
        snapAnim = a
        a.start()
    }

    // ── v0.64.2: the loading overlay driver ──────────────────────────
    // Show: 110ms fade-in + the spins start. Hide: 160ms fade-out; the
    // sequence token makes a re-show (a redirect mid-fade) win over the
    // stale hide's GONE end-action. v0.64.3: the pill's LoadDots ride
    // the SAME calls — one loading truth, the capsule tells it too.
    private fun setLoading(on: Boolean, url: String?) {
        val ov = loading ?: return
        if (on) {
            loadSeq++
            if (url != null) loadText?.text = url
            if (ov.visibility != View.VISIBLE) {
                ov.alpha = 0f
                ov.visibility = View.VISIBLE
                ov.animate().alpha(1f).setDuration(110L).start()
            }
            val dots = loadDots
            if (dots != null && dots.visibility != View.VISIBLE) {
                dots.alpha = 0f
                dots.visibility = View.VISIBLE
                dots.animate().alpha(1f).setDuration(110L).start()
            }
            startSpins()
        } else {
            val seq = ++loadSeq
            if (ov.visibility == View.VISIBLE) {
                ov.animate().alpha(0f).setDuration(160L)
                    .withEndAction { if (loadSeq == seq) ov.visibility = View.GONE }
                    .start()
            }
            val dots = loadDots
            if (dots != null && dots.visibility == View.VISIBLE) {
                dots.animate().alpha(0f).setDuration(160L)
                    .withEndAction { if (loadSeq == seq) dots.visibility = View.GONE }
                    .start()
            }
            stopSpins()
        }
    }

    private fun startSpins() {
        if (ringSpin == null) {
            val a = ValueAnimator.ofFloat(0f, 360f)
            a.duration = 1100L
            a.interpolator = LinearInterpolator()
            a.repeatCount = ValueAnimator.INFINITE
            a.addUpdateListener { an -> loadRing?.setSpin(an.animatedValue as Float) }
            a.start()
            ringSpin = a
        }
        val r = refreshIcon
        if (iconSpin == null && r != null) {
            val b = ObjectAnimator.ofFloat(r, View.ROTATION, 0f, 360f)
            b.duration = 900L
            b.interpolator = LinearInterpolator()
            b.repeatCount = ValueAnimator.INFINITE
            b.start()
            iconSpin = b
        }
        // v0.64.3: the pill's five dots pulse on their own cycle (the
        // chatbot's cwd-pulse cadence — 0.9s, 0.12s stagger)
        if (dotsSpin == null) {
            val d = ValueAnimator.ofFloat(0f, 1f)
            d.duration = 900L
            d.interpolator = LinearInterpolator()
            d.repeatCount = ValueAnimator.INFINITE
            d.addUpdateListener { an -> loadDots?.setPhase(an.animatedValue as Float) }
            d.start()
            dotsSpin = d
        }
    }

    private fun stopSpins() {
        ringSpin?.cancel()
        ringSpin = null
        iconSpin?.cancel()
        iconSpin = null
        dotsSpin?.cancel()
        dotsSpin = null
        refreshIcon?.rotation = 0f
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

        // v0.64.2: ONE CHIP FAMILY — the four pills share the surface
        // fill + 1dp theme border + full rounding (the acts are 34dp
        // CIRCLES, radius 17; the pill keeps its capsule; the ↻ glyph a
        // 12dp hit circle). Every chip ripples in the ACCENT (gated by
        // state_enabled — the back pill's empty-history state ripples
        // nothing), clipped to its own shape via the mask.
        val ripple = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_enabled), intArrayOf()),
            intArrayOf((accent and 0x00FFFFFF) or 0x42000000, Color.TRANSPARENT))
        fun chipShape(fill: Int, radiusDp: Int, stroke: Int?): GradientDrawable = GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dip(radiusDp).toFloat()
            if (stroke != null) setStroke(dip(1), stroke)
        }
        fun chip(fill: Int, radiusDp: Int, stroke: Int?): RippleDrawable = RippleDrawable(
            ripple, chipShape(fill, radiusDp, stroke), chipShape(Color.WHITE, radiusDp, null))

        pill?.background = chip(surface, 200, border)
        pillText?.setTextColor(text3)
        refreshIcon?.imageTintList = ColorStateList.valueOf(text3)
        // v0.64.3: the ripple circle follows the grown 30dp hitbox (r12→15)
        refreshIcon?.background = RippleDrawable(ripple,
            chipShape(Color.TRANSPARENT, 15, null), chipShape(Color.WHITE, 15, null))
        for (b in listOf(backBtn, extBtn, closeBtn)) {
            b?.background = chip(surface, 17, border)
            b?.imageTintList = ColorStateList.valueOf(text1)
        }
        backBtn?.alpha = if (backBtn?.isEnabled == true) 1f else 0.38f

        // the dash: the theme's own text color @ 30% — the grab hint
        dash?.background = GradientDrawable().apply {
            setColor((text1 and 0x00FFFFFF) or 0x4D000000)
            cornerRadius = dip(2).toFloat()
        }

        // the hairline under the strip: border @ ~32%
        divider?.setBackgroundColor((border and 0x00FFFFFF) or 0x52000000)

        // the loading overlay: bg + the ring's arc/track + the link text
        loading?.setBackgroundColor(bg)
        loadRing?.arcColor = accent
        loadRing?.trackColor = (border and 0x00FFFFFF) or 0x2E000000
        loadText?.setTextColor(text3)
        // v0.64.3: the pill's dots are the accent too (the chatbot's
        // thinking dots follow --accent — same discipline)
        loadDots?.dotColor = accent

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

    // ── v0.64.2: THE RING — the circular loading bar ──────────────────
    // A full-circle track (theme border @ ~18%, applied per open) + a
    // 96° arc in the theme accent with round caps, spun by startSpins()
    // on a linear infinite animator. Pure framework — no ProgressBar
    // defaults, nothing but the snapshot's colors.
    private class LoadRing(context: Context) : View(context) {
        var arcColor = Color.LTGRAY
        var trackColor = Color.GRAY
        private var rot = 0f
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        init {
            paint.style = Paint.Style.STROKE
            paint.strokeCap = Paint.Cap.ROUND
        }
        fun setSpin(deg: Float) {
            rot = deg
            invalidate()
        }
        override fun onDraw(c: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            if (w <= 0f || h <= 0f) return
            val d = resources.displayMetrics.density
            val stroke = 3.5f * d
            paint.strokeWidth = stroke
            val inset = stroke / 2f + d
            val oval = RectF(inset, inset, w - inset, h - inset)
            paint.color = trackColor
            c.drawArc(oval, 0f, 360f, false, paint)
            paint.color = arcColor
            c.drawArc(oval, rot, 96f, false, paint)
        }
    }

    // ── v0.64.3: THE LOADING PILL — the capsule's five dots ─────────
    // The chatbot's thinking pill (chatpanel.js v0.23 "the no-silence
    // guarantee"), ported dot for dot: five accent dots pulsing on a
    // 0.9s cycle with a 0.12s stagger — opacity .18→1, scale .82→1.12
    // (the CSS cwd-pulse keyframes, raised-cosine flavoured). GONE
    // unless setLoading(true); tinted per open by applyTheme.
    private class LoadDots(context: Context) : View(context) {
        var dotColor = Color.LTGRAY
        private var phase = 0f   // 0..1 — the shared clock, dotsSpin drives it
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        fun setPhase(p: Float) {
            phase = p
            invalidate()
        }
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val d = resources.displayMetrics.density
            // 5 dots × 5dp + 4 gaps × 3.5dp (+ the 1.12 scale headroom) ≈ 40dp
            setMeasuredDimension((40f * d).toInt(), (14f * d).toInt())
        }
        override fun onDraw(c: Canvas) {
            val d = resources.displayMetrics.density
            val base = 2.5f * d                       // the dot's base radius
            val pitch = 2f * base + 3.5f * d          // FIXED center-to-center (dots pulse in place)
            val cy = height / 2f
            var cx = base * 1.15f                     // headroom for the 1.12 scale peak
            for (i in 0 until 5) {
                // dot i's local cycle point: the shared phase + the stagger
                var p = (phase + i * (120f / 900f)) % 1f
                if (p < 0f) p += 1f
                val s = (0.5 - 0.5 * Math.cos(2.0 * Math.PI * p.toDouble())).toFloat()  // ease-in-out
                paint.color = dotColor
                paint.alpha = (255 * (0.18f + 0.82f * s)).toInt().coerceIn(0, 255)
                c.drawCircle(cx, cy, base * (0.82f + 0.30f * s), paint)
                cx += pitch
            }
        }
    }
}
