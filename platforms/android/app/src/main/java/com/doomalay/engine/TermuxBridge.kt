package com.doomalay.engine

// TermuxBridge.kt — v1.17.2 THE BRIDGE (PLAN-V117 §v1.17.2).
//
// Two halves of the Termux contract, in one file:
//
//   1. `TermuxBridge` (object) — the RUN_COMMAND intent layer. It checks the
//      honest-state ladder (installed / versionCode / permission), fires the
//      open-* intents (Termux, F-Droid APK, our permission settings page),
//      and sends one-shot jailed bash commands to Termux with a per-command
//      PendingIntent result round-trip: Termux executes
//      `bash -c <command>` in background mode and calls our PendingIntent
//      back with a Bundle (stdout / stderr / exitCode / err / errmsg).
//
//   2. `TermuxBridgeServer` (class) — the token-authed loopback HTTP server
//      EngineService hosts on 127.0.0.1 (ports 8081..8090). The Go engine
//      gets its URL as `--termux-bridge http://127.0.0.1:<port>/<token>` and
//      its /api/termux/status aggregates through the four routes:
//      GET /status, POST /probe, POST /run, POST /act. Same-UID loopback
//      only — the token makes the URL unguessable from other apps anyway.
//
// THE HONESTY LAW: every Termux-side problem (not installed, permission
// missing, Termux refused, timeout) is a first-class status field, never a
// silent failure.
//
// No new gradle deps: androidx.core (ContextCompat.registerReceiver) +
// org.json + java.net — all already in the build.

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

// ──────────────────────────────────────────────────────────────────────────
// Half 1: the RUN_COMMAND intent layer
// ──────────────────────────────────────────────────────────────────────────

object TermuxBridge {
    private const val TERMUX_PACKAGE = "com.termux"
    private const val TERMUX_RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
    private const val PERM_RUN_COMMAND = "com.termux.permission.RUN_COMMAND"
    private const val RUN_COMMAND_INTENT = "com.termux.RUN_COMMAND"

    // Termux prefixes (the F-Droid 0.118.x layout — the only live build;
    // the Play build is dead at 0.101 and predates RUN_COMMAND results).
    private const val TERMUX_BASH = "/data/data/com.termux/files/usr/bin/bash"
    private const val TERMUX_HOME = "/data/data/com.termux/files/home"

    // v1.17.2: the verified F-Droid stable APK (versionCode 1002).
    private const val FDROID_APK_URL = "https://f-droid.org/repo/com.termux_1002.apk"

    // The one-shot verification script the probe runs inside Termux. Markers
    // are the ground truth the engine parses back out of stdout:
    //   __doomalay_probe__  → the round-trip executed our script
    //   storage_ok          → termux-setup-storage ran ($HOME/storage/shared)
    //   props_ok            → allow-external-apps is set in termux.properties
    private const val PROBE_MARKER = "__doomalay_probe__"
    private const val PROBE_SCRIPT = "echo __doomalay_probe__; " +
            "test -d \"\$HOME/storage/shared\" && echo storage_ok || echo storage_missing; " +
            "grep -q \"^allow-external-apps\" \"\$HOME/.termux/termux.properties\" 2>/dev/null " +
            "&& echo props_ok || echo props_missing"

    // The result-broadcast base action: a random UUID suffix generated ONCE
    // per process makes the action unguessable (the receiver must be
    // exported because Termux — a different UID — fires our PendingIntent;
    // unguessability is the gate). Each command appends ".<requestCode>" so
    // every result correlates to exactly one send.
    private val BASE_ACTION = "com.doomalay.engine.TERMUX_RESULT." + UUID.randomUUID().toString()

    private val requestCodes = AtomicInteger(1)
    private val main = Handler(Looper.getMainLooper())

    // The RUN_COMMAND round-trip outcome. delivered + sendError + timeout
    // describe OUR side; err/errmsg describe Termux's side; stdout/stderr/
    // exitCode are the command's own result. v1.20.1: stdoutOriginalLength/
    // stderrOriginalLength carry Termux's true pre-truncation sizes (-1 =
    // not reported) — the honest truncation data phase .3 reports.
    data class CommandResult(
        val delivered: Boolean,        // the result broadcast arrived
        val timeout: Boolean,          // our timeout fired first (no result ever came)
        val stdout: String? = null,
        val stderr: String? = null,
        val exitCode: Int = -1,        // bash's exit code (-1 = unknown)
        val err: Int = 0,              // Termux-side error code (non-zero = Termux refused/failed)
        val errmsg: String? = null,    // Termux-side error message
        val sendError: String? = null, // OUR-side send failure (not installed / no permission / SecurityException / …)
        val stdoutOriginalLength: Long = -1L, // Termux's true stdout size (-1 = absent)
        val stderrOriginalLength: Long = -1L  // Termux's true stderr size (-1 = absent)
    )

    // The parsed probe outcome (CommandResult + the stdout markers read).
    data class ProbeResult(
        val ok: Boolean,               // round-trip delivered AND our script ran
        val storageOk: Boolean,
        val propsOk: Boolean,
        val stdout: String,
        val stderr: String,
        val exitCode: Int,
        val err: Int,
        val errmsg: String?,
        val timeout: Boolean,
        val sendError: String?,
        val stdoutOriginalLength: Long = -1L, // v1.20.1 passthrough (see CommandResult)
        val stderrOriginalLength: Long = -1L
    )

    // ── The honest-state ladder ─────────────────────────────────────────

    fun isInstalled(ctx: Context): Boolean = packageInfo(ctx) != null

    // 0 when Termux is not installed (the setup UI treats 0 as "unknown").
    fun versionCode(ctx: Context): Long {
        val info = packageInfo(ctx) ?: return 0L
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    }

    fun versionName(ctx: Context): String? = packageInfo(ctx)?.versionName

    // The USER must grant this in Settings → Apps → Doomalay → Permissions
    // → Additional permissions (dangerous-level — no runtime dialog path).
    fun isPermissionGranted(ctx: Context): Boolean =
        ctx.checkSelfPermission(PERM_RUN_COMMAND) == PackageManager.PERMISSION_GRANTED

    // The PackageManager lookup shared by the ladder. API 33+ uses the
    // PackageInfoFlags overload; older versions the deprecated int-flags
    // overload (flags 0 = metadata only, versionCode always included).
    private fun packageInfo(ctx: Context): PackageInfo? = try {
        val pm = ctx.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(TERMUX_PACKAGE, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(TERMUX_PACKAGE, 0)
        }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: Exception) {
        null // a broken package state must never crash the bridge — honest null
    }

    // ── The open-* intents (the setup overlay's action surface) ─────────
    // All three add FLAG_ACTIVITY_NEW_TASK — they are fired from a SERVICE
    // context (the bridge server's /act route), where Android REQUIRES the
    // flag. They throw on failure; the /act handler catches + reports.

    fun openTermux(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)
            ?: throw IllegalStateException("termux not installed (no launch intent)")
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(launch)
    }

    fun openFdroid(ctx: Context) {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(FDROID_APK_URL))
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
    }

    fun openPermissionSettings(ctx: Context) {
        val i = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + ctx.packageName)
        )
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
    }

    // ── THE RUN_COMMAND SENDER ──────────────────────────────────────────
    //
    // Correlation: one receiver per command, registered for a per-command
    // unique action ("$BASE_ACTION.$requestCode") BEFORE the send. The
    // PendingIntent targets that same action + our package, ONE_SHOT (the
    // PI self-destructs after Termux fires it), MUTABLE on S+ (Termux fills
    // the result extras in). Delivery is exactly-once and ALWAYS on the main
    // thread: the AtomicBoolean claim guards the three racing paths (result
    // broadcast, timeout, send error), the first one to win unregisters the
    // receiver and delivers.
    //
    // onResult callbacks arrive on the main thread — bridge-server handler
    // threads suspend on a latch; UI callers get main-thread callbacks free.

    fun runCommand(
        ctx: Context,
        command: String,
        workdir: String?,
        timeoutMs: Long,
        stdin: String? = null, // v1.20.2: stdin — forwarded as the RUN_COMMAND_STDIN extra (null = no extra; default keeps every existing call site unchanged)
        onResult: (CommandResult) -> Unit
    ) {
        if (command.isEmpty()) {
            main.post { onResult(CommandResult(delivered = false, timeout = false, sendError = "empty command")) }
            return
        }
        if (!isInstalled(ctx)) {
            main.post { onResult(CommandResult(delivered = false, timeout = false, sendError = "termux not installed")) }
            return
        }
        if (!isPermissionGranted(ctx)) {
            main.post {
                onResult(CommandResult(delivered = false, timeout = false, sendError = "RUN_COMMAND permission not granted"))
            }
            return
        }

        val requestCode = requestCodes.incrementAndGet()
        val action = "$BASE_ACTION.$requestCode"
        val claimed = AtomicBoolean(false)
        var timeoutRunnable: Runnable? = null
        // Forward-reference holder: `finish` (declared first, so the receiver
        // object can call it) needs the receiver, which is created after.
        var receiverRef: BroadcastReceiver? = null

        fun finish(cleanup: Boolean, result: CommandResult) {
            if (!claimed.compareAndSet(false, true)) return
            if (cleanup) {
                timeoutRunnable?.let { main.removeCallbacks(it) }
                try { ctx.unregisterReceiver(receiverRef) } catch (_: Exception) {}
            }
            // Uniform delivery contract: onResult ALWAYS arrives on the main
            // thread (the send-error paths can fire on a caller worker thread).
            main.post { onResult(result) }
        }

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent?.action != action) return // foreign broadcast on the action — drop
                val b = intent.getBundleExtra("result")
                // onReceive runs on the main thread — deliver inline.
                finish(cleanup = true, bundleToResult(b))
            }
        }
        receiverRef = receiver

        // Register BEFORE sending: a fast Termux can beat an unregistered
        // receiver. RECEIVER_EXPORTED — the PendingIntent Termux fires is
        // ours, but exported keeps the contract identical across versions;
        // the UUID action makes unguessable the security boundary.
        ContextCompat.registerReceiver(
            ctx, receiver, IntentFilter(action), ContextCompat.RECEIVER_EXPORTED
        )

        timeoutRunnable = Runnable {
            // Still on the main thread (postDelayed on the main handler).
            finish(cleanup = true, CommandResult(delivered = false, timeout = true))
        }
        main.postDelayed(timeoutRunnable, timeoutMs)

        val pi = PendingIntent.getBroadcast(
            ctx,
            requestCode, // unique per command — the PendingIntent identity
            Intent(action).setPackage(ctx.packageName),
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        )

        val intent = Intent().apply {
            setClassName(TERMUX_PACKAGE, TERMUX_RUN_COMMAND_SERVICE)
            setAction(RUN_COMMAND_INTENT)
            putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BASH)
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", command))
            putExtra("com.termux.RUN_COMMAND_WORKDIR", workdir ?: TERMUX_HOME)
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", "doomalay")
            // v1.20.2: stdin — the file-write law (bash -c 'cat > "$1"' _
            // <path> with the content as stdin, zero shell-escaping surface).
            if (stdin != null) putExtra("com.termux.RUN_COMMAND_STDIN", stdin)
            putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pi)
        }

        try {
            // Plain startService (NOT startForegroundService — Termux's
            // service is theirs). We are a foreground service ourselves, so
            // background-start restrictions do not apply; the IllegalStateException
            // catch stays honest for every other caller context.
            ctx.startService(intent)
        } catch (e: SecurityException) {
            // The RUN_COMMAND permission was revoked between the pre-check
            // and the send — honest report, no result will come.
            finish(cleanup = true, CommandResult(delivered = false, timeout = false, sendError = "security: ${e.message}"))
        } catch (e: IllegalStateException) {
            finish(cleanup = true, CommandResult(delivered = false, timeout = false, sendError = "cannot start service: ${e.message}"))
        }
    }

    // The one-shot verification probe (the setup flow's step ④ and the
    // engine's cached /api/termux/status aggregation call this).
    fun probe(ctx: Context, timeoutMs: Long = 15000L, onResult: (ProbeResult) -> Unit) {
        runCommand(ctx, PROBE_SCRIPT, null, timeoutMs) { r ->
            val stdout = r.stdout ?: ""
            val ran = stdout.contains(PROBE_MARKER)
            onResult(
                ProbeResult(
                    ok = r.delivered && !r.timeout && r.sendError == null && ran,
                    storageOk = ran && stdout.contains("storage_ok"),
                    propsOk = ran && stdout.contains("props_ok"),
                    stdout = stdout,
                    stderr = r.stderr ?: "",
                    exitCode = r.exitCode,
                    err = r.err,
                    errmsg = r.errmsg,
                    timeout = r.timeout,
                    sendError = r.sendError,
                    stdoutOriginalLength = r.stdoutOriginalLength,
                    stderrOriginalLength = r.stderrOriginalLength
                )
            )
        }
    }

    // The Termux result Bundle (key "result"): stdout / stderr /
    // stdout_original_length / stderr_original_length / exitCode / err /
    // errmsg. Types are defensive — a Termux version storing a Long where we
    // read an Int must never crash the bridge.
    private fun bundleToResult(b: Bundle?): CommandResult {
        if (b == null) {
            // Termux fired the PendingIntent without a result bundle —
            // honest marker, delivered but empty.
            return CommandResult(delivered = true, timeout = false, sendError = "result bundle missing")
        }
        return CommandResult(
            delivered = true,
            timeout = false,
            stdout = b.getString("stdout"),
            stderr = b.getString("stderr"),
            exitCode = readInt(b, "exitCode", -1),
            err = readInt(b, "err", 0),
            errmsg = b.getString("errmsg"),
            stdoutOriginalLength = readLong(b, "stdout_original_length"),
            stderrOriginalLength = readLong(b, "stderr_original_length")
        )
    }

    private fun readInt(b: Bundle, key: String, def: Int): Int = try {
        b.getInt(key, def)
    } catch (_: Exception) {
        def
    }

    // v1.20.1: the original-length extras ride the Bundle as Long or Int
    // depending on the Termux build — read defensively, never crash, -1
    // when the key is absent (the honest "not reported").
    private fun readLong(b: Bundle, key: String): Long = try {
        val v: Any? = b.get(key)
        if (v is Number) v.toLong() else -1L
    } catch (_: Exception) {
        -1L
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Half 2: the loopback HTTP server (EngineService hosts it)
// ──────────────────────────────────────────────────────────────────────────

// A minimal HTTP/1.1 server on 127.0.0.1 serving the Termux bridge routes
// under a random UUID token: GET /<token>/status, POST /<token>/probe,
// POST /<token>/run, POST /<token>/act. One connection per thread — a slow
// probe never blocks a status poll; one bad request never kills the accept
// loop (each handler is guarded). JSON via org.json. `start()` returns the
// full base URL the engine receives as --termux-bridge.
//
// v1.20.1 THE QUIET GATE: a SECOND random token (checkinToken) adds exactly
// one route — GET /<checkinToken>/checkin?storage=0|1&props=0|1 — the setup
// script curls it when it finishes (zero RUN_COMMANDs, zero Termux
// notifications). Everything else under the checkin token answers 403
// exactly like a wrong token; /run, /probe, /act still require the MAIN
// token only.
class TermuxBridgeServer(private val ctx: Context) {

    // The per-boot random token: same-UID loopback only, but the token makes
    // other-UID guesses useless too (127.0.0.1 on Android IS per-UID, so
    // this is defense in depth, not the boundary).
    private val token: String = UUID.randomUUID().toString()

    // v1.20.1 THE QUIET GATE: the checkin token — a SECOND random UUID whose
    // single route lets the setup script report "the bootstrap finished"
    // over plain HTTP. It can never unlock /run, /probe, or /act: a
    // checkin-token request anywhere else answers 403 like a wrong token.
    // Worst case a checkin-token holder marks the bootstrap done — an honest
    // failed probe, never command execution.
    private val checkinToken: String = UUID.randomUUID().toString()

    // The checkin ladder (v1.20.1): written by the checkin route on ITS
    // worker thread, read by /status on another — the lock keeps the group
    // consistent, the @Volatile keeps single-field reads honest. checkin_at
    // is 0 until the first checkin lands (the honest "never").
    private val checkinLock = Any()
    @Volatile private var bootstrapDone = false
    @Volatile private var checkinAt = 0L
    @Volatile private var checkinStorage = false
    @Volatile private var checkinProps = false

    private var serverSocket: ServerSocket? = null
    @Volatile private var running = false
    // The bound port, captured at start() — statusJson builds the checkin
    // URL from it (the server knows its own port).
    @Volatile private var localPort = 0

    fun start(): String {
        check(serverSocket == null && !running) { "TermuxBridgeServer already started" }
        var sock: ServerSocket? = null
        for (port in 8081..8090) {
            try {
                sock = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
                break // first free port wins
            } catch (_: IOException) {
                // port busy — try the next
            }
        }
        if (sock == null) throw IOException("no free loopback port in 8081..8090")
        serverSocket = sock
        localPort = sock.localPort
        running = true
        Thread {
            acceptLoop(sock)
        }.apply {
            name = "TermuxBridgeServer"
            isDaemon = true
            start()
        }
        val url = "http://127.0.0.1:${sock.localPort}/$token"
        AppLog.log("TermuxBridgeServer: listening on $url")
        return url
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close() // unblocks accept()
        } catch (_: IOException) {}
        serverSocket = null
    }

    // ── The accept loop: one worker thread per connection ───────────────

    private fun acceptLoop(sock: ServerSocket) {
        while (running) {
            val client: Socket
            try {
                client = sock.accept()
            } catch (e: IOException) {
                if (running) AppLog.error("TermuxBridgeServer: accept failed", e)
                break // stop() closed the socket, or the listener is fatally broken
            }
            Thread {
                try {
                    handleConnection(client)
                } catch (e: Exception) {
                    // THE ACCEPT-LOOP LAW: one bad request must never take the
                    // bridge down. Logged honestly, connection dropped.
                    AppLog.error("TermuxBridgeServer: connection handler failed", e)
                } finally {
                    try { client.close() } catch (_: IOException) {}
                }
            }.apply {
                name = "TermuxBridgeConn"
                isDaemon = true
                start()
            }
        }
    }

    // ── One connection: parse, route, answer, close ─────────────────────

    private fun handleConnection(client: Socket) {
        client.soTimeout = 30_000 // abandoned/hung request cleanup
        val input = client.getInputStream()
        val out = client.getOutputStream()

        val req = try {
            readRequest(input)
        } catch (e: Exception) {
            writeResponse(out, 400, errJson("bad request: ${e.message}"))
            return
        }
        if (req == null) {
            writeResponse(out, 400, errJson("bad request"))
            return
        }

        // Token check FIRST: the path must be /<token>/<route>. The v1.20.1
        // checkin token is an alternate prefix that unlocks EXACTLY one
        // route (GET /checkin) — every other path under it answers 403 like
        // a wrong token, so a checkin-token holder can never run, probe,
        // or act.
        val prefix = "/$token"
        val checkinPrefix = "/$checkinToken"
        if (req.path == checkinPrefix || req.path.startsWith("$checkinPrefix/")) {
            val checkinRoute = req.path.removePrefix(checkinPrefix)
            if (req.method == "GET" && (checkinRoute == "/checkin" || checkinRoute.startsWith("/checkin?"))) {
                handleCheckin(out, req.path)
            } else {
                writeResponse(out, 403, errJson("forbidden"))
            }
            return
        }
        if (!req.path.startsWith("$prefix/") && req.path != prefix) {
            writeResponse(out, 403, errJson("forbidden"))
            return
        }
        val route = req.path.removePrefix(prefix)

        try {
            when {
                route == "/status" && req.method == "GET" ->
                    writeResponse(out, 200, statusJson())
                route == "/probe" && req.method == "POST" ->
                    handleProbe(out)
                route == "/run" && req.method == "POST" ->
                    handleRun(out, req.body)
                route == "/act" && req.method == "POST" ->
                    handleAct(out, req.body)
                else ->
                    writeResponse(out, 404, errJson("not found"))
            }
        } catch (e: Exception) {
            // Handler explosion — honest 500, accept loop untouched (this is
            // a worker thread).
            AppLog.error("TermuxBridgeServer: route ${req.method} ${req.path} failed", e)
            try { writeResponse(out, 500, errJson("internal: ${e.message}")) } catch (_: Exception) {}
        }
    }

    // GET /status — the honest-state ladder, straight from PackageManager.
    // v1.20.1: the checkin ladder rides along (read under the lock — the
    // checkin route writes from its own worker thread); every pre-v1.20.1
    // field keeps its exact shape.
    private fun statusJson(): String {
        val o = JSONObject()
        o.put("installed", TermuxBridge.isInstalled(ctx))
        o.put("version_code", TermuxBridge.versionCode(ctx))
        o.put("version_name", TermuxBridge.versionName(ctx) ?: JSONObject.NULL)
        o.put("permission", TermuxBridge.isPermissionGranted(ctx))
        synchronized(checkinLock) {
            o.put("checkin_url", "http://127.0.0.1:$localPort/$checkinToken/checkin")
            o.put("bootstrap_done", bootstrapDone)
            o.put("checkin_at", checkinAt)
            o.put("checkin_storage", checkinStorage)
            o.put("checkin_props", checkinProps)
        }
        return o.toString()
    }

    // GET /<checkinToken>/checkin?storage=0|1&props=0|1 — THE QUIET GATE's
    // arrival proof. The setup script curls this at its very end: zero
    // RUN_COMMANDs, zero Termux notifications. The params carry the
    // script's own honest step outcomes (missing or malformed = false —
    // parsed defensively, a broken query must never crash the bridge).
    private fun handleCheckin(out: OutputStream, path: String) {
        var storage = false
        var props = false
        try {
            val q = path.substringAfter('?', "")
            for (pair in q.split('&')) {
                if (pair.isEmpty()) continue
                val eq = pair.indexOf('=')
                if (eq <= 0) continue
                val name = pair.substring(0, eq)
                val value = pair.substring(eq + 1)
                if (name == "storage" && value == "1") storage = true
                if (name == "props" && value == "1") props = true
            }
        } catch (_: Exception) {
            // malformed query — flags stay false, the checkin still lands
        }
        synchronized(checkinLock) {
            bootstrapDone = true
            checkinAt = System.currentTimeMillis()
            checkinStorage = storage
            checkinProps = props
        }
        writeResponse(out, 200, """{"ok":true}""")
    }

    // POST /probe — the RUN_COMMAND round-trip; this handler thread
    // SUSPENDS on a latch while the result arrives on the main thread.
    private fun handleProbe(out: OutputStream) {
        val latch = CountDownLatch(1)
        val holder = arrayOfNulls<String>(1)
        TermuxBridge.probe(ctx, 15000L) { r ->
            synchronized(holder) { holder[0] = probeJson(r) }
            latch.countDown()
        }
        // probe's internal timeout (15s) guarantees a callback; +5s slack.
        val delivered = try { latch.await(20, TimeUnit.SECONDS) } catch (_: InterruptedException) { false }
        val json = synchronized(holder) { holder[0] }
            ?: """{"ok":false,"storage_ok":false,"props_ok":false,"stdout":"","stderr":"","exit_code":-1,"err":-1,"errmsg":"bridge probe never delivered a result","timeout":true,"stdout_original_length":-1,"stderr_original_length":-1}"""
        if (!delivered) AppLog.error("TermuxBridgeServer: probe latch timed out (honest fallback served)", null)
        writeResponse(out, 200, json)
    }

    private fun probeJson(r: TermuxBridge.ProbeResult): String {
        val o = JSONObject()
        o.put("ok", r.ok)
        o.put("storage_ok", r.storageOk)
        o.put("props_ok", r.propsOk)
        o.put("stdout", r.stdout)
        o.put("stderr", r.stderr)
        o.put("exit_code", r.exitCode)
        o.put("err", r.err)
        o.put("errmsg", r.errmsg ?: JSONObject.NULL)
        o.put("timeout", r.timeout)
        o.put("send_error", r.sendError ?: JSONObject.NULL)
        // v1.20.1: Termux's true pre-truncation sizes (-1 = not reported) —
        // data plumbing for the honest-truncation phase .3, harmless when
        // unused.
        o.put("stdout_original_length", r.stdoutOriginalLength)
        o.put("stderr_original_length", r.stderrOriginalLength)
        return o.toString()
    }

    // POST /run — the generic jailed exec. Body: {"command":str,
    // "workdir":str?, "timeout_ms":int?, "stdin":str? (v1.20.2 — forwarded
    // as RUN_COMMAND_STDIN)}. Default timeout 60s, hard cap 180s.
    private fun handleRun(out: OutputStream, body: ByteArray) {
        val command: String
        var workdir: String? = null
        var timeoutMs = DEFAULT_RUN_TIMEOUT_MS
        var stdinExtra: String? = null // v1.20.2: stdin — the body's optional "stdin" field
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            command = o.optString("command", "")
            val wd = o.optString("workdir", "")
            if (wd.isNotEmpty()) workdir = wd
            val t = o.optInt("timeout_ms", 0)
            if (t > 0) timeoutMs = t.toLong()
            // v1.20.2: stdin — rides the intent as RUN_COMMAND_STDIN
            // (absent/empty = no extra; the background session's own EOF
            // stdin is the empty-write contract).
            if (o.has("stdin") && !o.isNull("stdin") && o.optString("stdin", "").isNotEmpty()) {
                stdinExtra = o.optString("stdin", "")
            }
        } catch (e: JSONException) {
            writeResponse(out, 400, errJson("invalid JSON body: ${e.message}"))
            return
        }
        if (command.isEmpty()) {
            writeResponse(out, 400, errJson("missing command"))
            return
        }
        if (timeoutMs > MAX_RUN_TIMEOUT_MS) timeoutMs = MAX_RUN_TIMEOUT_MS
        if (timeoutMs < MIN_RUN_TIMEOUT_MS) timeoutMs = MIN_RUN_TIMEOUT_MS

        val latch = CountDownLatch(1)
        val holder = arrayOfNulls<String>(1)
        TermuxBridge.runCommand(ctx, command, workdir, timeoutMs, stdinExtra) { r ->
            synchronized(holder) { holder[0] = runJson(r) }
            latch.countDown()
        }
        // runCommand's internal timeout guarantees a callback; +5s slack.
        try { latch.await(timeoutMs + 5000, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
        val json = synchronized(holder) { holder[0] }
            ?: """{"ok":false,"stdout":"","stderr":"","exit_code":-1,"err":-1,"errmsg":"bridge run never delivered a result","timeout":true,"stdout_original_length":-1,"stderr_original_length":-1}"""
        writeResponse(out, 200, json)
    }

    private fun runJson(r: TermuxBridge.CommandResult): String {
        val o = JSONObject()
        // ok = the round-trip delivered (no timeout, no send-side failure);
        // the command's own exit code is honest data in its own field.
        o.put("ok", r.delivered && !r.timeout && r.sendError == null)
        o.put("stdout", r.stdout ?: "")
        o.put("stderr", r.stderr ?: "")
        o.put("exit_code", r.exitCode)
        o.put("err", r.err)
        o.put("errmsg", r.errmsg ?: JSONObject.NULL)
        o.put("timeout", r.timeout)
        o.put("send_error", r.sendError ?: JSONObject.NULL)
        // v1.20.1: same honest-truncation passthrough as the probe.
        o.put("stdout_original_length", r.stdoutOriginalLength)
        o.put("stderr_original_length", r.stderrOriginalLength)
        return o.toString()
    }

    // POST /act — the open-* intents. Body: {"what":"open_termux" |
    // "open_fdroid" | "open_permission_settings"}.
    private fun handleAct(out: OutputStream, body: ByteArray) {
        val what: String
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            what = o.optString("what", "")
        } catch (e: JSONException) {
            writeResponse(out, 400, errJson("invalid JSON body: ${e.message}"))
            return
        }
        when (what) {
            "open_termux" -> TermuxBridge.openTermux(ctx)
            "open_fdroid" -> TermuxBridge.openFdroid(ctx)
            "open_permission_settings" -> TermuxBridge.openPermissionSettings(ctx)
            else -> {
                writeResponse(out, 400, errJson("unknown what"))
                return
            }
        }
        writeResponse(out, 200, """{"ok":true}""")
    }

    // ── Minimal HTTP/1.1 request parsing ────────────────────────────────
    //
    // Byte-wise header reading (requests are tiny): a BufferedReader would
    // over-read body bytes past the \r\n\r\n terminator into its buffer and
    // the Content-Length body read would come up short. We track the last
    // four bytes for the terminator, then read the body exactly.

    private class ParsedRequest(val method: String, val path: String, val body: ByteArray)

    private fun readRequest(input: InputStream): ParsedRequest? {
        val header = ByteArrayOutputStream()
        var w = -1; var x = -1; var y = -1
        while (true) {
            val b = input.read()
            if (b < 0) return null
            header.write(b)
            if (w == '\r'.code && x == '\n'.code && y == '\r'.code && b == '\n'.code) break
            w = x; x = y; y = b
            if (header.size() > 16_384) return null // header flood guard
        }
        val lines = header.toString("ISO-8859-1").split("\r\n")
        val requestLine = lines.firstOrNull() ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val method = parts[0].uppercase()
        val path = parts[1]

        var contentLength = 0
        for (i in 1 until lines.size) {
            val line = lines[i]
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val name = line.substring(0, idx).trim().lowercase()
            if (name == "content-length") {
                contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
            }
        }
        if (contentLength < 0 || contentLength > 1_000_000) return null // body cap 1MB

        val body = ByteArray(contentLength)
        var off = 0
        while (off < contentLength) {
            val n = input.read(body, off, contentLength - off)
            if (n < 0) return null
            off += n
        }
        return ParsedRequest(method, path, body)
    }

    // ── Response writer ─────────────────────────────────────────────────

    private fun writeResponse(out: OutputStream, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            500 -> "Internal Server Error"
            else -> "Error"
        }
        val head = "HTTP/1.1 $status $reason\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
    }

    private fun errJson(msg: String): String {
        val o = JSONObject()
        o.put("error", msg)
        return o.toString()
    }

    companion object {
        private const val DEFAULT_RUN_TIMEOUT_MS = 60_000L
        private const val MAX_RUN_TIMEOUT_MS = 180_000L
        private const val MIN_RUN_TIMEOUT_MS = 1_000L
    }
}
