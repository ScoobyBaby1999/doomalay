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
import android.view.Choreographer
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

// PanelBrowserSheet — v0.68.0 THE BROWSER BAR WAVE (PLAN-V0680) on
// v0.64.3 THE TIDY PILL (PLAN-V0643) on top of v0.64.2 THE POLISH WAVE
// (PLAN-V0642) on top of v0.64.0 THE NATIVE PANEL BROWSER (PLAN-V0640).
//
// v0.68.0 SPEC ("Let's make the BIB (browser in browser) and panel have
// the same dash length, let's change the BIB to use the panels dash and
// length… the BIB's scrolling (how it detects weather to open close,
// ext, resemble the panels functionality and mimic it if not use it
// outright)… the BIB search bar (the one with the address of the site)
// 15% less wide and high or 15% smaller in size… let's add search
// functionality (browser either Google or something free like brave or
// duckduckgo). So it works like any browser lol."):
//
//   · THE DASH — the BIB wears the panel's own .handle-bar verbatim:
//     36×4dp (was 40) in the theme BORDER (index.html's var(--border)),
//     radius 2 — the neutral grab hint, the same length on both panels.
//   · THE SCROLLING — gesture.js mimicked outright, constant for
//     constant: THE BODY CHAIN (a downward pull on a page sitting at
//     its very top becomes the SHEET's drag past the 24dp slop — the
//     WebView gets a clean CANCEL, the finger never loses control, the
//     −6dp no-jump rebase lands at the hijack), THE DRAG FEEL (the
//     0.8/frame render chase, the rubber-band above full ×0.25, the EMA
//     velocity 0.7/0.3 over 4ms-floored samples, the activation rebase
//     that kills the mid-glide drift jump), THE SPRINGS (the settle:
//     stiffness 170 critically damped, quarter-velocity seeded; the
//     release-close: 440 at the fling's momentum, ≥900px/s), and THE
//     CURVE (open/close 170ms on cubic-bezier(0.32,0.72,0,1) — a
//     PathInterpolator). decide() was already verbatim (v0.64.0).
//   · THE CAPSULE — 15% smaller: 25.5dp tall (was 30), the text cap
//     130dp (was 153), the ↻ slot 25.5dp square with the glyph STILL
//     18dp (the v0.64.3 hitbox ask survives above the old 24dp).
//   · THE BROWSER BAR — tap the capsule and type: the sheet glides
//     FULL (the bar rides to the top, beyond any keyboard's reach), the
//     URL selected like Chrome's omnibox. GO resolves like any browser
//     — an explicit scheme passes, a host gets https://, anything else
//     SEARCHES (DuckDuckGo: free, keyless, no tracking). Back / a focus
//     loss cancels back to the dock the user came from; a committed
//     search stays at full. LONG-PRESS the capsule still copies the
//     link (the old tap affordance, reborn Android-style).
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
//   · THE DOCKED RULES (v0.65.1, the parity wave — "if the user
//     presses the panel while it is docked at 30%… if they press it
//     or slide up, the panel goes back to it's original position, if
//     they slide it down, it goes slides down and stops rendering"):
//     a grab that starts at the duck (dragFromDuck) owns a special
//     release — any DOWNWARD slide (past the slop) dismisses the sheet
//     AND pauses its WebView (a closed sheet stops rendering, not just
//     hides), anything else (an upward slide, or a no-slop tap on the
//     strip/pill/page) glides back to the ORIGINAL dock. A still press
//     on the ducked page itself restores too — the page still gets its
//     tap (the listener never eats it), and sustained page scrolling
//     keeps the peek (every MOVE retriggers the ~3s hold — "unless the
//     user is interacting"). The ↻ ‹ ⧉ acts restore after their own
//     action (attention is back on the panel); ✕ stays the dismiss.
//
// Everything else is v0.64.2/v0.64.3 verbatim: the strip contract (the
// pill tap = COPY + toast, ‹ walks the REAL WebView history, ⧉ is THE
// BOX+ARROW (ACTION_VIEW → Custom Tab → system browser), ✕ dismisses,
// the dash dead-center), gesture.js parity (FLING_VY 0.55, CLOSE_FRAC
// 0.32, velocity projection 140ms), the ViewerActivity-grade WebView
// (cookies shared, video fullscreen, downloads → system, doomalay://
// → dismiss + wakeSpa), resumable (close only hides — and now pauses),
// and THEME — the live CSS-var snapshot re-tints everything on every
// open; system theme attrs are the fallback, nothing hardcoded in use.
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
        // v0.68.0: gesture.js's own timings — RISE_MS is v0.45's 170ms
        // curve, and the dock-to-dock SNAP_MS glide is RETIRED (the
        // settle spring below owns every landing now)
        private const val RISE_MS = 170L           // the open rise + the class-close slide (gesture.js RISE_MS)
        private const val CLOSE_MS = 170L          // the dismiss slide (same curve)

        // v0.64.2: THE SECRET THIRD DOCK — the canvas-duck peek
        private const val DUCK_FRAC = 0.30f        // the sheet fills only ~30% of the screen
        private const val DUCK_HOLD_MS = 3000L     // the retriggerable temporary hold

        // v0.68.0: THE BODY CHAIN (gesture.js's scroll chain, constant
        // for constant) + THE SPRINGS (its settle + dismiss physics)
        private const val BODY_SLOP_DP = 24        // px of pull-down before the sheet grabs (gesture.js BODY_SLOP)
        // v0.72: THE EASY SLIDE-DOWN — while DUCKED, the WebView chain
        // grabs after 10dp (not 24) and DROPS the page-at-top gate: a
        // downward pull on the 30% peek is DISMISS intent, not content
        // scrolling (user spec: "if the user slides down when the panel
        // is 30% dock the panel should go away"). release()'s
        // dragFromDuck path already closes on any dy>0, so the slop is
        // the only thing between the finger and the away-slide.
        private const val DUCK_CHAIN_SLOP_DP = 10  // px of pull-down before a DUCKED page grabs
        private const val CHAIN_REBASE_DP = 6      // the no-jump rebase at hijack (gesture.js y0 = y − 6)
        private const val ANCHOR_SLOP_DP = 6       // the anchor's tap-vs-drag slop
        private const val SETTLE_STIFF = 170f      // the settle spring (critically damped)
        private const val SETTLE_DAMP = 1.02f      // …a hair over critical — no overshoot, no lag
        private const val DISMISS_STIFF = 440f     // the gesture-close spring (snappier, v0.45)

        // v0.68.0: gesture.js's rise curve — cubic-bezier(0.32,0.72,0,1)
        private val easeCurve = PathInterpolator(0.32f, 0.72f, 0f, 1f)

        // v0.68.0: THE SEARCH ENGINE — DuckDuckGo (the user's "Google or
        // something free like brave or duckduckgo": free, keyless, no
        // tracking — the in-app-browser default)
        private const val SEARCH_URL = "https://duckduckgo.com/?q="
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
    // v0.72: THE EXPIRY GUARD — a finger still ON the sheet (the strip,
    // the capsule, or the WebView page) IS interaction: the hold
    // RETRIGGERS instead of firing. The old behavior rose the sheet
    // mid-press, and the drag that followed started from the half dock
    // (not ducked), so the slide-down hit the hard decide() ladder —
    // the "hard to slide away" report's other half (gesture.js's
    // track.active/track.bodyStart guard, native).
    private val fingerOnSheet = java.util.concurrent.atomic.AtomicBoolean(false)
    private val unduckRunnable = Runnable {
        if (fingerOnSheet.get()) { resetDuckTimer(); return@Runnable }
        unduck()
    }

    // v0.64.2: the loading spins (the ring + the ↻ glyph)
    private var ringSpin: ValueAnimator? = null
    private var iconSpin: ObjectAnimator? = null
    private var dotsSpin: ValueAnimator? = null
    private var loadSeq = 0L

    // v0.68.0: THE GLIDE INTERFACE — the last glide owns the sheet, and a
    // glide is now either a timed ValueAnimator curve (the 170ms
    // rise/close) or a Choreographer spring (the settle + the dismiss).
    // One owner slot, one cancel rule: a cancel fires the end action
    // (ValueAnimator semantics — every end in this file is a no-op or
    // the GONE-guard, so the behavior matches the old animator exactly).
    private interface Glide { fun cancel() }
    private var snapAnim: Glide? = null

    // v0.68.0: THE BROWSER BAR (the capsule's editable twin)
    private var editor: EditText? = null
    private var editMode = false
    private var editPriorFull = false      // the dock the user came from (a cancel returns there)

    // v0.68.0: THE BODY CHAIN's DOWN bookkeeping (the WebView listener writes)
    private var chainDownY = 0f            // the gesture's origin Y
    private var chainMulti = false         // a second finger landed — never a chain gesture

    // v0.68.0: THE DRAG RENDER CHASE (gesture.js dragRender — the 0.8/frame
    // whisper of jitter smoothing between the finger and the sheet)
    private var dragTargetY = 0f           // where the finger puts the top edge
    private var dragNowY = 0f              // the smoothed render position
    private var dragRender: Choreographer.FrameCallback? = null

    // v0.68.0: THE LONG-PRESS (the capsule's copy, reborn Android-style —
    // the touch listener consumes, so the system long-click never fires)
    private var longRunnable: Runnable? = null
    private var longFired = false

    @Volatile private var showing = false
    @Volatile private var liveUrl = ""

    // drag tracking (the strip is the handle — 1:1 finger follow)
    private var dragStartY = 0f
    private var dragStartOffset = 0f
    private var dragFromFull = false
    // v0.65.1: THE DOCKED-GRAB RULES — the gesture STARTED at the duck
    // (set at ACTION_DOWN, survives the slop-crossing cancelDuck) so
    // release() can decide with the duck's special semantics.
    private var dragFromDuck = false
    // v0.65.1: the ducked page's still-press detector — the touch's
    // origin Y (a MOVE past the slop means a scroll, not a press)
    private var pageTapY = -1f
    private var lastMoveY = 0f
    private var lastMoveT = 0L
    private var velY = 0f
    private var dragging = false

    // theme (the live CSS-var snapshot; re-applied on every open)
    private var themeJson = JSONObject()

    // ─────────────────────────────────────────────────────── the surface
    fun open(url: String, optsJson: String) {
        if (editMode) exitEdit(restoreDock = false)   // v0.68.0: a fresh link — the typed draft is stale
        try { themeJson = JSONObject(optsJson) } catch (e: Exception) { themeJson = JSONObject() }
        ensureViews()
        applyTheme()
        val w = webView ?: return
        // v0.65.1: the dismiss paused the WebView — a resurfacing sheet
        // resumes it (no-op when it was never paused).
        try { w.onResume() } catch (e: Exception) {}
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
        if (editMode) exitEdit(restoreDock = false)   // v0.68.0: the keyboard goes with the sheet
        if (!showing) return
        beginClose()
        val h = if (fullH > 0) fullH.toFloat() else 1f
        // (the GONE end-action is guarded — a reopen inside the 170ms
        // slide cancels this glide, and the cancel-fired end must not
        // bury it)
        animateTo(h, CLOSE_MS) { if (!showing) overlay?.visibility = View.GONE }
        notifyState()
    }

    // v0.68.0: the RELEASE-CLOSE — gesture.js's dismiss spring (stiffness
    // 440, always chasing downward at the fling's momentum, never below
    // 900px/s): the same bookkeeping as the ✕ dismiss, but the motion is
    // the FINGER's momentum instead of a timed curve — a hard fling-down
    // leaves the screen fast, a slow deliberate drag closes gently.
    private fun dismissSpring(vy: Float) {
        if (editMode) exitEdit(restoreDock = false)
        if (!showing) return
        beginClose()
        val h = if (fullH > 0) fullH.toFloat() else 1f
        springDismiss(h, vy) { if (!showing) overlay?.visibility = View.GONE }
        notifyState()
    }

    // the shared close bookkeeping (✕ / Android back / the release-close)
    private fun beginClose() {
        duckHandler.removeCallbacks(unduckRunnable)
        ducked = false
        fingerOnSheet.set(false)   // v0.72: a closed sheet owes no expiry guard
        showing = false
        setLoading(false, null)
        // v0.65.1: "slides down and stops rendering" — the hidden sheet
        // also PAUSES its WebView (no compositing, no JS timers, no
        // battery burn while closed; open() pairs with onResume). The
        // history survives — the sheet stays resumable, exactly as before.
        try { webView?.onPause() } catch (e: Exception) {}
    }

    // Android back (native — consumed BEFORE the SPA is ever consulted):
    // video fullscreen → exit; the BAR's edit → cancel it (the keyboard
    // first, browser behavior); WebView history → walk; else dismiss.
    fun handleBack(): Boolean {
        if (customView != null) { hideCustomNow(); return true }
        if (!showing) return false
        if (editMode) { exitEdit(restoreDock = true); return true }
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

    // v0.69: the MOVE half of MainActivity's overlay guard — a moving
    // finger can only RETRIGGER a duck that already exists (keep the
    // ~3s peek alive through a continuous canvas drag); it can never
    // ENGAGE one, so a scroll inside an overlay screen never lowers the
    // sheet. The ENGAGE decision belongs to hitTestCanvasAsync (DOWN).
    fun onSpaMove() {
        if (!showing || !ducked) return
        resetDuckTimer()
    }

    // v0.69: read-only exposure of the full dock for MainActivity's
    // canvas hit-test (the full dock never ducks — checked before the
    // async probe is even sent).
    fun isAtFull(): Boolean = atFull

    private fun duckForCanvas() {
        if (!showing || atFull) return
        if (ducked) { resetDuckTimer(); return }
        ducked = true
        if (fullH > 0) springTo(offsetForDuck(), 0f) {}
        resetDuckTimer()
        notifyState()
    }

    // the ~3s hold expired — the sheet glides back to the half dock and
    // the canvas dim is restored (the SPA's scrim re-darkens).
    private fun unduck() {
        duckHandler.removeCallbacks(unduckRunnable)
        if (!showing || !ducked) return
        ducked = false
        if (!atFull && fullH > 0) springTo(offsetForDefault(), 0f) {}
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
            springTo(offsetForDefault(), 0f) {}
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
            // v0.68.0: the slot follows the 15%-smaller capsule (30→
            // 25.5dp); the glyph STAYS 18dp (3.75dp padding) — the
            // hitbox survives above the pre-v0.64.3 24dp and still
            // fills the capsule's height at its left edge
            setPadding(dipF(3.75f), dipF(3.75f), dipF(3.75f), dipF(3.75f))
            contentDescription = "Refresh page"
        }
        pillText = TextView(activity).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
            maxWidth = dip(130)     // v0.68.0: 153→130 — the capsule caps 15% narrower
            textSize = 12f
            setPadding(dip(3), 0, dip(4), 0)
        }
        // v0.68.0: THE BROWSER BAR — the capsule's editable twin (GONE
        // unless editing): textUri (the / and .com keys), GO, no
        // fullscreen extract — tap the capsule and type, like any
        // browser's address bar. Tinted by the theme snapshot per open.
        editor = EditText(activity).apply {
            setSingleLine(true)
            inputType = EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO or
                    EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            maxLines = 1
            textSize = 12f
            maxWidth = dip(130)
            setPadding(dip(3), 0, dip(4), 0)
            background = null
            visibility = View.GONE
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_GO) { commitEdit(); true } else false
            }
            setOnFocusChangeListener { _, hasFocus ->
                if (!hasFocus && editMode) exitEdit(restoreDock = true)
            }
        }
        loadDots = LoadDots(activity)
        val pillLocal = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            // v0.68.0: 15% smaller — (5,0,9,0)→(4,0,8,0); with the 25.5dp
            // refresh slot the capsule stands 25.5dp tall (was 30)
            setPadding(dip(4), 0, dip(8), 0)
            addView(refreshIcon, LinearLayout.LayoutParams(dipF(25.5f), dipF(25.5f)))
            addView(pillText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(editor, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(loadDots, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = dip(5)
            })
        }
        pill = pillLocal

        // the dash — the grab hint, dead-center (1fr · auto · 1fr);
        // v0.68.0: THE PANEL'S OWN — index.html's .handle-bar verbatim:
        // 36×4dp (was 40), the theme border, radius 2. The same dash
        // length on both panels, exactly as asked.
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
            addView(dash, LinearLayout.LayoutParams(dip(36), dip(4))
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
            // v0.68.0: the chain's partner — the overscroll glow never
            // fights the hijack (a pull at the page top belongs to the
            // SHEET now, gesture.js's body chain, not to the glow)
            overScrollMode = View.OVER_SCROLL_NEVER
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            // v0.65.1: THE DOCKED-PAGE RULES — activity on the ducked
            // panel keeps the peek (every DOWN *and* MOVE retriggers the
            // ~3s hold — a long scroll never expires mid-read, the
            // "unless the user is interacting" clause), and a STILL
            // press (UP without crossing the slop) restores the sheet
            // to its original dock — the page still gets its tap (the
            // listener returns false, the page handles it normally).
            // v0.68.0: THE CHAIN HANDOFF rides the same MOVE branch — at
            // the page's very top + a downward pull, the parent lock is
            // RELEASED so the body layout can intercept and the sheet
            // can follow the finger (gesture.js's scroll chain, the
            // native edition; the WebView gets a clean CANCEL).
            // v0.72: THE EASY SLIDE-DOWN — while DUCKED the handoff
            // DROPS the page-at-top gate (a downward pull on the peek
            // is dismiss intent even when the page is scrolled — the
            // 3-second glance never outranks the swipe-away), and the
            // page's DOWN/UP feed the fingerOnSheet expiry guard.
            setOnTouchListener { v, ev ->
                when (ev.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        chainDownY = ev.rawY
                        chainMulti = false
                        // the chain's grab-origin (THE DOCKED RULES — the
                        // same field the strip's DOWN captures; one driver)
                        dragFromDuck = ducked
                        if (ducked) resetDuckTimer()
                        fingerOnSheet.set(true)   // v0.72: the expiry guard — the finger is on the page
                        pageTapY = ev.rawY        // the tap origin
                    }
                    MotionEvent.ACTION_POINTER_DOWN -> { chainMulti = true }
                    MotionEvent.ACTION_MOVE -> {
                        if (ducked) resetDuckTimer()
                        // v0.72: ducked → no atTop gate (a downward pull
                        // on the peek hands off, wherever the page sits)
                        val atTopForChain = !ducked && !v.canScrollVertically(-1)
                        if (!chainMulti && ev.pointerCount == 1 &&
                                atTopForChain && ev.rawY > chainDownY) {
                            try {
                                v.parent.requestDisallowInterceptTouchEvent(false)
                            } catch (e: Exception) {}
                        }
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        fingerOnSheet.set(false)   // v0.72: the press ended
                        if (ev.actionMasked == MotionEvent.ACTION_UP && ducked && pageTapY >= 0f) {
                            if (Math.abs(ev.rawY - pageTapY) <= dip(6)) {
                                cancelDuck(restoreDock = true)
                            }
                        }
                        pageTapY = -1f
                    }
                }
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

        // v0.68.0: THE BODY CHAIN — the body is a DragBodyLayout now
        // (gesture.js's scroll chain, the native port): while the page
        // sits at its very top, a downward pull past the 24dp slop is
        // HIJACKED into the sheet's own drag — the WebView gets a clean
        // CANCEL, the finger never loses control, and release() decides
        // full/default/close exactly like the web panel's body.
        // v0.72: THE EASY SLIDE-DOWN — while DUCKED the rule DROPS the
        // at-top gate (a downward pull on the 30% peek is dismiss
        // intent wherever the page is scrolled) and the slop drops to
        // 10dp (release()'s dragFromDuck path closes on any dy>0, so
        // the slop is the whole distance between the finger and the
        // away-slide).
        val body = DragBodyLayout(activity).apply {
            addView(webView, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(loading, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            // the hijack rule (every MOVE until it fires): one finger,
            // the page at its very top (dropped while ducked), a
            // deliberate downward pull
            chainRule = { ev ->
                if (ev.pointerCount != 1 || chainMulti || dragging) false
                else {
                    val w = webView
                    val pull = ev.rawY - chainDownY
                    if (ducked) pull > dip(DUCK_CHAIN_SLOP_DP)
                    else {
                        val atTop = w == null || !w.canScrollVertically(-1)
                        atTop && pull > dip(BODY_SLOP_DP)
                    }
                }
            }
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
        // v0.68.0: an act press ends the edit first (attention is back
        // on the panel — the typed text is committed to nothing)
        refreshIcon?.setOnClickListener {
            if (editMode) exitEdit(restoreDock = false)
            webView?.reload()
            if (ducked) cancelDuck(restoreDock = true)
        }
        backBtn?.setOnClickListener {
            if (editMode) exitEdit(restoreDock = false)
            if (webView?.canGoBack() == true) webView?.goBack()
            if (ducked) cancelDuck(restoreDock = true)
        }
        extBtn?.setOnClickListener {
            if (editMode) exitEdit(restoreDock = false)
            openExternal(liveUrl)
            if (ducked) cancelDuck(restoreDock = true)
        }
        closeBtn?.setOnClickListener { dismiss() }

        // THE DRAG SURFACE: the strip + the pill follow the finger (a tap
        // on the pill OPENS THE BAR, a long-press COPIES — drag vs tap vs
        // long-press is disambiguated by the slop + the system long-press
        // timeout in makeDraggable). The act buttons consume their own
        // touches, so a drag never fights a ‹/⧉/✕ click and vice versa.
        makeDraggable(strip)
        makeDraggable(pillLocal, tap = { enterEdit() }, longPress = { copyLink() })

        backBtn?.isEnabled = false
        backBtn?.alpha = 0.38f
    }

    // drag + tap + long-press disambiguation on one view. `tap` fires only
    // when the touch never crossed the slop; `longPress` (the capsule's
    // copy, reborn Android-style) fires at the system long-press timeout —
    // cancelled by the slop, an early UP, or a second driver. The touch
    // listener consumes everything, so the system long-click (which needs
    // onTouchEvent) never fires — this IS the long-press. v0.65.1: a grab
    // that starts at the duck remembers it (dragFromDuck at DOWN) — the
    // shared drag machine's release() then applies THE DOCKED RULES, and a
    // no-slop TAP on the strip/pill restores the original dock.
    @SuppressLint("ClickableViewAccessibility")
    private fun makeDraggable(v: View, tap: (() -> Unit)? = null, longPress: (() -> Unit)? = null) {
        v.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (dragging) return@setOnTouchListener false   // one driver (a chain grab owns the finger)
                    fingerOnSheet.set(true)   // v0.72: the expiry guard — the finger is on the sheet
                    dragStartY = ev.rawY
                    dragFromDuck = ducked
                    lastMoveY = ev.rawY
                    lastMoveT = SystemClock.uptimeMillis()
                    velY = 0f
                    if (longPress != null) armLongPress(v, longPress)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (dragging) { dragFollow(ev.rawY); return@setOnTouchListener true }
                    if (longFired) return@setOnTouchListener true   // the copy owned this press
                    if (Math.abs(ev.rawY - dragStartY) > dip(ANCHOR_SLOP_DP)) {
                        cancelLongPress()
                        dragActivate(ev.rawY)
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    cancelLongPress()
                    val fired = longFired
                    longFired = false
                    fingerOnSheet.set(false)   // v0.72: the press ended (dragEnd clears its own)
                    if (dragging) {
                        dragEnd()
                    } else if (ev.actionMasked == MotionEvent.ACTION_UP && !fired) {
                        // v0.65.1: the press rule — a still press on the
                        // ducked sheet returns it to its ORIGINAL dock
                        if (dragFromDuck) cancelDuck(restoreDock = true)
                        tap?.invoke()
                    }
                    true
                }
                else -> false
            }
        }
    }

    // ── v0.68.0: THE DRAG MACHINE (gesture.js begin/move/end — one engine
    // for the anchor grabs AND the body chain) ──────────────────────────
    //
    // The activation REBASE is the web's begin() semantics: the slop
    // crossed (or the chain hijacked) — the origin is the CURRENT finger
    // position and the sheet's FROZEN offset, so a grab mid-flight takes
    // over from the exact on-screen spot (the old code captured both at
    // DOWN, and a glide running between DOWN and the slop drifted the
    // offset — a several-px jump the moment the finger became the boss).
    private fun dragActivate(y: Float) {
        dragging = true
        // the finger is boss — kill any glide still running (a spring, the
        // 170ms rise, a close) and the render chase
        snapAnim?.cancel()
        stopDragRender()
        dragStartY = y
        dragStartOffset = curOffset
        dragFromFull = atFull
        lastMoveY = y
        lastMoveT = SystemClock.uptimeMillis()
        velY = 0f
        // a REAL grab takes the sheet out of the duck — the hold dies and
        // release() owns the landing (dragFromDuck was captured at DOWN
        // and survives, exactly the v0.65.1 contract)
        if (ducked) cancelDuck(restoreDock = false)
    }

    // 1:1 finger tracking with a whisper of jitter smoothing (the 0.8/frame
    // chase — gesture.js dragRender), rubber-banded past full, never past
    // closed. Velocity: the EMA (0.7/0.3) over 4ms-floored samples — the
    // sub-frame guard that killed the rebase flings on the web.
    private fun dragFollow(y: Float) {
        if (fullH <= 0) return
        val now = SystemClock.uptimeMillis()
        if (now - lastMoveT > 4) {
            val inst = (y - lastMoveY) / (now - lastMoveT).toFloat()
            velY = velY * 0.7f + inst * 0.3f
        }
        lastMoveY = y
        lastMoveT = now
        val raw = dragStartOffset + (y - dragStartY)
        dragTargetY = when {
            raw < 0f -> raw * 0.25f              // the rubber-band above full
            raw > fullH -> fullH.toFloat()       // never past closed
            else -> raw
        }
        startDragRender()
    }

    private fun dragEnd() {
        dragging = false
        fingerOnSheet.set(false)   // v0.72: the drag (any driver) ended — the expiry guard stands down
        stopDragRender()
        // the FINGER's dy, not the rubber-banded sheet offset (gesture.js end)
        release(velY, lastMoveY - dragStartY)
    }

    private fun startDragRender() {
        if (dragRender != null) return
        dragNowY = curOffset
        val cb = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                dragRender = null
                dragNowY += (dragTargetY - dragNowY) * 0.8f
                if (Math.abs(dragTargetY - dragNowY) < 0.4f) dragNowY = dragTargetY
                curOffset = dragNowY
                sheet?.translationY = curOffset
                if (dragging && dragNowY != dragTargetY) {
                    dragRender = this
                    Choreographer.getInstance().postFrameCallback(this)
                }
            }
        }
        dragRender = cb
        Choreographer.getInstance().postFrameCallback(cb)
    }

    private fun stopDragRender() {
        dragRender?.let { Choreographer.getInstance().removeFrameCallback(it) }
        dragRender = null
    }

    // the manual long-press (the listener consumes — the system one never
    // fires). Arms at DOWN, dies on slop/UP/second-driver.
    private fun armLongPress(v: View, act: () -> Unit) {
        cancelLongPress()
        longFired = false
        val r = Runnable {
            longFired = true
            try { v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) } catch (e: Exception) {}
            act()
        }
        longRunnable = r
        duckHandler.postDelayed(r, ViewConfiguration.getLongPressTimeout().toLong())
    }

    private fun cancelLongPress() {
        longRunnable?.let { duckHandler.removeCallbacks(it) }
        longRunnable = null
    }

    // gesture.js decide(), ported verbatim: velocity projection leads,
    // the tuned intent thresholds confirm. Three landings on the
    // fraction line: 0 (closed) / .62 (default) / 1 (full). v0.65.1:
    // a grab that STARTED at the duck bypasses decide() entirely — THE
    // DOCKED RULES: a deliberate downward slide (the slop already
    // filtered jitter) slides the sheet down and STOPS RENDERING
    // (dismiss + onPause); an upward slide — or anything else — glides
    // back to the ORIGINAL dock (the half dock, never full: "the panel
    // goes back to it's original position"). v0.68.0: the landings ride
    // THE SPRINGS — the settle seeded with a quarter of the release
    // velocity, the close riding the fling's momentum (gesture.js end(),
    // motion for motion).
    private fun release(vy: Float, dy: Float) {
        if (fullH <= 0) { dismiss(); return }
        val h = fullH.toFloat()
        val seed = vy * 1000f * 0.25f
        if (dragFromDuck) {
            if (dy > 0) { dismissSpring(vy); return }
            atFull = false
            springTo(offsetForDefault(), seed) {}
            return
        }
        val downward = dy > 0
        val upward = dy < 0
        val projected = dy + vy * PROJECTION_MS
        val fromFrac = 1f - dragStartOffset / h
        val toFrac = fromFrac - projected / h
        // v0.69 — THE HALF-LINE GUARD (user spec: "The BIB panel should
        // dock at half view if the user lets go of holding it while
        // slightly above half view — currently it hides itself completely
        // if the user lets go before the dock threshold"): the sheet's
        // VISUAL position at release (the finger-true fraction; the rubber
        // band only differs past full) outranks the fling. A downward
        // release while the sheet still sits AT OR ABOVE the half dock
        // never closes — it springs to the half dock. Below the line the
        // existing ladder decides exactly as before (a genuine dismiss
        // fling released below half still closes). The tolerance (~3% of
        // the height) catches "released exactly at the dock" so the
        // landing never flips a coin.
        val curFrac = fromFrac - dy / h
        val target: String
        if (upward && (vy < -FLING_VY || Math.abs(dy) > h * UP_DRAG_FRAC || toFrac >= 0.82f)) {
            target = "full"
        } else if (dragFromFull) {
            target = when {
                downward && curFrac >= DEFAULT_FRAC - 0.03f -> "default"   // the half-line guard
                downward && vy > FLING_VY -> "close"
                downward && dy > h * FULL_CLOSE_FRAC -> "close"
                downward && (toFrac <= 0.30f || dy > h * FULL_DOCK_FRAC || vy > DOCK_VY) -> "default"
                else -> "full"
            }
        } else {
            target = when {
                downward && curFrac >= DEFAULT_FRAC - 0.03f -> "default"   // the half-line guard
                downward && vy > FLING_VY -> "close"
                downward && dy > h * CLOSE_FRAC -> "close"
                upward && toFrac >= 0.82f -> "full"
                else -> "default"
            }
        }
        when (target) {
            "full" -> { atFull = true; springTo(0f, seed) {} }
            "default" -> { atFull = false; springTo(offsetForDefault(), seed) {} }
            else -> dismissSpring(vy)
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
        // the last glide owns the sheet — cancel any glide still running
        // (duck↔undock↔spring↔close sequences overlap now).
        snapAnim?.cancel()
        val a = ValueAnimator.ofFloat(curOffset, target)
        a.duration = ms
        // v0.68.0: gesture.js's rise curve — cubic-bezier(0.32,0.72,0,1)
        // (the same 170ms the web panel opens and closes on)
        a.interpolator = easeCurve
        a.addUpdateListener { an ->
            curOffset = an.animatedValue as Float
            sh.translationY = curOffset
        }
        // (AnimatorListenerAdapter: the SDK's onAnimationEnd takes a
        // NON-NULL Animator — a nullable override "overrides nothing"
        // and fails the Kotlin build, the v0.64.0 CI lesson.)
        a.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                snapAnim = null
                end()
            }
        })
        snapAnim = object : Glide { override fun cancel() { a.cancel() } }
        a.start()
    }

    // ── v0.68.0: THE SPRINGS (gesture.js springY + dismiss, one driver) ──
    //
    // One Choreographer integrator in offset-from-target coordinates.
    // THE SETTLE: stiffness 170, critically damped ×1.02 (no overshoot,
    // no lag — ~260ms from typical drag deltas), release velocity seeded
    // at a quarter strength for the momentum feel, rest at |x|<1.5 &&
    // |v|<40 → the exact landing. THE DISMISSAL: stiffness 440, raw
    // critically damped, momentum ≥ 900px/s always downward, rest at
    // arrival (it never overshoots). Both register as the sheet's Glide —
    // the last one owns it, and a cancel fires the end action
    // (ValueAnimator semantics; every end here is a no-op or the
    // GONE-guard, so the behavior matches the old animator exactly).
    private fun springDrive(target: Float, v0: Float, stiffness: Float, damping: Float,
                            arrived: (Float, Float) -> Boolean, end: () -> Unit) {
        val sh = sheet ?: run { end(); return }
        snapAnim?.cancel()
        var x = curOffset - target
        var v = v0.coerceIn(-2400f, 2400f)
        var lastT = System.nanoTime()
        var done = false
        val cb = object : Choreographer.FrameCallback {
            override fun doFrame(now: Long) {
                if (done) return
                val dt = Math.min(0.05f, (now - lastT) / 1.0e9f)
                lastT = now
                val a = -stiffness * x - damping * v
                v += a * dt
                x += v * dt
                if (arrived(x, v)) {
                    done = true
                    curOffset = target
                    sh.translationY = curOffset
                    snapAnim = null
                    end()
                    return
                }
                curOffset = target + x
                sh.translationY = curOffset
                Choreographer.getInstance().postFrameCallback(this)
            }
        }
        snapAnim = object : Glide {
            override fun cancel() {
                if (done) return
                done = true
                Choreographer.getInstance().removeFrameCallback(cb)
                snapAnim = null
                end()
            }
        }
        Choreographer.getInstance().postFrameCallback(cb)
    }

    // the settle — every dock-to-dock landing, the duck glides, the
    // undock/restore, and the release settle (quarter-velocity seeded)
    private fun springTo(target: Float, v0: Float, end: () -> Unit) {
        springDrive(target, v0, SETTLE_STIFF,
            2f * Math.sqrt(SETTLE_STIFF.toDouble()).toFloat() * SETTLE_DAMP,
            { x, v -> Math.abs(x) < 1.5f && Math.abs(v) < 40f }, end)
    }

    // the dismissal — the release-close rides the fling's momentum
    private fun springDismiss(target: Float, vy: Float, end: () -> Unit) {
        val v = if (vy * 1000f * 0.5f > 900f) vy * 1000f * 0.5f else 900f
        springDrive(target, v, DISMISS_STIFF,
            2f * Math.sqrt(DISMISS_STIFF.toDouble()).toFloat(),
            { x, _ -> x >= -1f }, end)
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

    // ── v0.68.0: THE BROWSER BAR — the capsule's omnibox twin ────────
    //
    // TAP the capsule (makeDraggable's tap) → enterEdit: the duck dies,
    // the sheet glides FULL so the bar rides to the top of the screen
    // (a half-docked bar would sit under the keyboard), the URL arrives
    // pre-selected (Chrome's omnibox — type to replace), the IME is up.
    // GO → commitEdit: resolveEntry decides URL-vs-search and the
    // WebView takes it — the sheet STAYS at full (reading the results).
    // Back / focus loss → exitEdit: the IME folds, the TextView returns,
    // and a CANCEL glides back to the dock the user came from; the
    // ✕/act/open() calls pass restoreDock=false (the sheet is going
    // somewhere else anyway).
    private fun enterEdit() {
        if (editMode) return
        val ed = editor ?: return
        editPriorFull = atFull
        if (ducked) cancelDuck(restoreDock = false)
        editMode = true
        pillText?.visibility = View.GONE
        ed.visibility = View.VISIBLE
        ed.setText(liveUrl)
        ed.requestFocus()
        // Chrome's omnibox: the URL pre-selected — type to replace it
        ed.post { if (editMode) ed.selectAll() }
        atFull = true
        if (fullH > 0) springTo(0f, 0f) {}
        try {
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showSoftInput(ed, 0)
        } catch (e: Exception) { AppLog.error("panel ime show failed", e) }
    }

    private fun commitEdit() {
        val entry = editor?.text?.toString()?.trim() ?: ""
        if (entry.isEmpty()) { exitEdit(restoreDock = false); return }
        val target = resolveEntry(entry)
        exitEdit(restoreDock = false)   // the TextView back, the IME down
        atFull = true                   // GO reads at FULL — the results are the point
        if (fullH > 0) springTo(0f, 0f) {}
        liveUrl = target
        webView?.loadUrl(target)
    }

    // GO's brain — "it works like any browser lol": an explicit scheme
    // passes untouched; a spaceless dotted/coloned entry is an address
    // (https:// prepended — the modern default); EVERYTHING else is a
    // question for DuckDuckGo (free, keyless, no tracking — the user's
    // "Google or something free like brave or duckduckgo")
    private fun resolveEntry(entry: String): String {
        if (entry.startsWith("http://") || entry.startsWith("https://")) return entry
        if (!entry.contains(' ') && (entry.contains('.') || entry.contains(':'))) {
            return "https://" + entry
        }
        return SEARCH_URL + android.net.Uri.encode(entry)
    }

    private fun exitEdit(restoreDock: Boolean) {
        if (!editMode) return
        editMode = false
        try {
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.hideSoftInputFromWindow(editor?.windowToken, 0)
        } catch (e: Exception) {}
        editor?.clearFocus()
        editor?.visibility = View.GONE
        pillText?.visibility = View.VISIBLE
        if (restoreDock && showing && fullH > 0) {
            atFull = editPriorFull
            springTo(offsetFor(editPriorFull), 0f) {}
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
        // v0.68.0: the radii go FLOAT — the 15%-smaller capsule's 12.75dp
        // ripple circle is not a whole dp
        fun chipShape(fill: Int, radiusDp: Float, stroke: Int?): GradientDrawable = GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dipF(radiusDp).toFloat()
            if (stroke != null) setStroke(dip(1), stroke)
        }
        fun chip(fill: Int, radiusDp: Float, stroke: Int?): RippleDrawable = RippleDrawable(
            ripple, chipShape(fill, radiusDp, stroke), chipShape(Color.WHITE, radiusDp, null))

        pill?.background = chip(surface, 200f, border)
        pillText?.setTextColor(text3)
        refreshIcon?.imageTintList = ColorStateList.valueOf(text3)
        // v0.68.0: the ripple circle follows the 25.5dp slot (r15→12.75 —
        // exactly half, the circle stays full)
        refreshIcon?.background = RippleDrawable(ripple,
            chipShape(Color.TRANSPARENT, 12.75f, null), chipShape(Color.WHITE, 12.75f, null))
        // v0.68.0: the bar's editor wears the capsule's own text3 (the
        // snapshot re-tints it per open, like everything else here)
        editor?.setTextColor(text3)
        for (b in listOf(backBtn, extBtn, closeBtn)) {
            b?.background = chip(surface, 17f, border)
            b?.imageTintList = ColorStateList.valueOf(text1)
        }
        backBtn?.alpha = if (backBtn?.isEnabled == true) 1f else 0.38f

        // v0.68.0: the dash: THE PANEL'S OWN — index.html's .handle-bar
        // verbatim: the theme BORDER at full strength (var(--border)
        // parity — the same neutral grab hint on both panels, never the
        // accent, and no alpha tricks either)
        dash?.background = GradientDrawable().apply {
            setColor(border)
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

    // v0.68.0: the float twin — the 15%-smaller capsule's fractional
    // dimensions (25.5, 12.75, 3.75dp) land on exact pixels
    private fun dipF(v: Float): Int = (v * activity.resources.displayMetrics.density).toInt()

    // ── v0.68.0: THE BODY CHAIN (gesture.js's scroll chain, native) ──
    // The WebView's touch listener releases the parent lock once the
    // page sits at its very top and the finger pulls DOWN; this layout
    // then intercepts the stream — the WebView gets a clean CANCEL, the
    // finger never loses control — and hands it to the SAME drag machine
    // the strip uses: the −6dp rebase at hijack (gesture.js's
    // track.y0 = y − 6: the sheet springs into the grab instead of
    // lagging the 24dp the finger already pulled), 1:1 follow with the
    // jitter-smoothed chase, and release()'s decide() on the way down.
    // One driver both ways: the rule never fires mid-drag, and the
    // strip's DOWN refuses a finger while the chain owns one.
    private inner class DragBodyLayout(context: Context) : FrameLayout(context) {
        var chainRule: ((MotionEvent) -> Boolean)? = null
        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
            if (ev.actionMasked == MotionEvent.ACTION_MOVE && !dragging) {
                val rule = chainRule
                if (rule != null && rule(ev)) {
                    dragActivate(ev.rawY - dip(CHAIN_REBASE_DP))
                    return true
                }
            }
            return false
        }
        override fun onTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_MOVE -> if (dragging) dragFollow(ev.rawY)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragging) dragEnd()
            }
            return true
        }
    }

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
