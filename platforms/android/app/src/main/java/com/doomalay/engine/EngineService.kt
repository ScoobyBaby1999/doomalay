package com.doomalay.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class EngineService : Service() {
    private var engineProcess: Process? = null
    @Volatile private var engineRunning = false
    private var restarts = 0

    companion object {
        // v1.39.2 THE AWAKE ENGINE: the last busyness the busy-poll saw —
        // MainActivity's exemption ladder reads it on onPause (a live turn
        // backgrounded while not battery-exempt arms the one-time ask).
        // Process-wide truth, updated only by the poll thread.
        @Volatile var busyTurns = 0
            private set
    }

    // v1.39.2 THE AWAKE ENGINE: the turn-gated CPU. A dataSync foreground
    // service keeps this process out of the cached/freezer class — it does
    // NOT keep the CPU scheduled: seconds after screen-off the kernel
    // suspends and the engine child simply stops being mid-turn (the
    // "backgrounding pauses all bots" report). The PARTIAL_WAKE_LOCK is
    // acquired ONLY while the busy gauge reports live turns and released
    // the moment the engine goes idle (the battery-honesty law: an idle
    // engine never holds the CPU awake; process death releases it too).
    private var wakeLock: PowerManager.WakeLock? = null
    private var busyPollThread: Thread? = null
    private var lastNotifText: String? = null

    // v1.17.2 THE BRIDGE: the Termux loopback server (the Kotlin half of
    // the RUN_COMMAND contract — PLAN-V117 §v1.17.2). Started once per
    // service lifetime, BEFORE the engine, so the URL stays stable across
    // watchdog restarts (the restarted engine gets the same --termux-bridge
    // URL). Failure is honest and non-fatal: the engine then runs without
    // the flag and /api/termux/status answers {"available":false}.
    private var bridgeServer: TermuxBridgeServer? = null
    private var bridgeUrl: String? = null

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppLog.log("EngineService.onStartCommand")

        // CRITICAL FIX: use startForeground with FOREGROUND_SERVICE_TYPE_DATA_SYNC
        // on Android 14+ (API 34). On older versions, the type is ignored.
        val notification = buildNotification("Engine running")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
        AppLog.log("Foreground service started")

        // v1.17.2 THE BRIDGE: host the Termux bridge loopback server
        // (127.0.0.1, token-authed) before the engine starts, and hand its
        // URL to the engine so /api/termux/status can aggregate through it.
        if (bridgeServer == null) {
            try {
                val server = TermuxBridgeServer(this)
                bridgeUrl = server.start()
                bridgeServer = server
            } catch (e: Exception) {
                AppLog.error("Termux bridge server failed to start (engine runs without it)", e)
                bridgeUrl = null
            }
        }

        // v0.15: startEngine() is now guarded — calling onStartCommand twice
        // (app reopen while the service lives) must not double-spawn the
        // binary on port 8080 (the second instance would die and confuse
        // the watchdog).
        if (!engineRunning) startEngine()

        // v1.39.2 THE AWAKE ENGINE: the wake lock (created once per service
        // lifetime — acquire/release is the poll's job, never a leak) + the
        // busy poll that drives it. The poll is the SELF-HEALING truth sync:
        // a missed announce can never wedge the wake lock, and an engine
        // crash (turns unreadable) reads as idle — hold nothing for a dead
        // engine.
        if (wakeLock == null) {
            wakeLock = getSystemService(POWER_SERVICE) as? PowerManager
                ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "doomalay:engine-turns")
        }
        startBusyPoll()
        startNetWatch()
        return START_STICKY
    }

    // v1.39.4 THE NET WAKE: Android's own connectivity truth, pushed into
    // the engine's retry machinery the moment it happens. The
    // NetworkCallback (a request with NET_CAPABILITY_INTERNET +
    // NET_CAPABILITY_VALIDATED) fires onAvailable when the OS validates a
    // network — the documented ~instant signal; the callback bumps the
    // bridge's net seq, the engine's /netwait long-poll releases, and every
    // suspended retry waiter (v1.39.3 THE PATIENT ENGINE) retries within
    // ~1s of the network's return instead of burning the next jittered rung
    // (fixed timers are the backstop, never the trigger). Multiple fires
    // (wifi↔cellular transitions, flaps) are harmless: a wake with healthy
    // net retries and succeeds; a wake into a flap retries and re-suspends
    // honestly.
    private var netWatchRegistered = false
    private fun startNetWatch() {
        if (netWatchRegistered) return
        try {
            val cm = getSystemService(CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager ?: return
            val request = android.net.NetworkRequest.Builder()
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                .build()
            cm.registerNetworkCallback(request, object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) {
                    AppLog.log("NET WAKE: connectivity validated — waking the engine's retry waiters")
                    bridgeServer?.netWake()
                }
            })
            netWatchRegistered = true
            AppLog.log("NET WAKE: NetworkCallback registered (validated-network wake armed)")
        } catch (e: Exception) {
            AppLog.error("NET WAKE: callback registration failed (the jittered rungs carry the wake alone)", e)
        }
    }

    private fun startEngine() {
        engineRunning = true
        Thread {
            try {
                AppLog.log("=== Starting Go engine (attempt ${restarts + 1}) ===")
                val binary = EngineBinary.getBinaryPath(this)
                val f = java.io.File(binary)
                AppLog.log("Binary: $binary exists=${f.exists()} size=${f.length()} exec=${f.canExecute()}")

                // Use the app's files dir as the engine data dir — it's writable,
                // persistent, and uninstall-safe. Defaults to /data/data/.../files/.
                val dataDir = filesDir.absolutePath
                AppLog.log("Data dir: $dataDir")

                val pbArgs = mutableListOf(
                    binary,
                    "--port", "8080",
                    "--bind", "127.0.0.1",
                    "--data-dir", dataDir
                )
                // v1.17.2: the Termux bridge URL when the loopback server
                // lives — the engine's termuxbridge client +
                // /api/termux/status aggregation key off it.
                bridgeUrl?.let { u ->
                    pbArgs.add("--termux-bridge")
                    pbArgs.add(u)
                }
                val pb = ProcessBuilder(pbArgs)
                pb.redirectErrorStream(true)
                engineProcess = pb.start()
                AppLog.log("Go process started")

                val reader = engineProcess!!.inputStream.bufferedReader()
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    AppLog.log("[engine] $line")
                }
                val exit = engineProcess!!.waitFor()
                AppLog.log("Go engine exited (code=$exit)")
            } catch (e: Exception) {
                AppLog.error("Go engine failed", e)
            } finally {
                engineRunning = false
                engineProcess = null

                // v0.15 — THE WATCHDOG: the v0.14 service logged the exit and
                // gave up. If the engine ever crashed, every API call failed
                // (model list stopped opening) and reopening the app landed
                // on a dead white screen. Now the engine restarts itself:
                //   - immediate for the first 5 restarts (fast recovery)
                //   - 10s backoff afterwards (crash-loop protection)
                //   - hard cap at 20 restarts per service lifetime
                if (restarts < 20 && !serviceStopping) {
                    val delay = if (restarts < 5) 500L else 10000L
                    restarts++
                    AppLog.log("Watchdog: restarting engine in ${delay}ms (restart #$restarts)")
                    Thread.sleep(delay)
                    if (!serviceStopping) startEngine()
                } else {
                    AppLog.error("Watchdog: restart limit reached — engine stays down")
                }
            }
        }.start()
    }

    // v1.39.2 THE AWAKE ENGINE: poll GET /api/engine/busy every 5s on the
    // loopback (≈100 bytes; the engine's OWN truth, no client claim). The
    // poll survives engine restarts (the watchdog's 10s backoff windows
    // simply read as idle-then-busy-again) and never dies for the service's
    // lifetime — START_STICKY can restart the service around it.
    private fun startBusyPoll() {
        if (busyPollThread?.isAlive == true) return
        busyPollThread = Thread {
            while (!serviceStopping) {
                var turns = -1
                try {
                    val conn = java.net.URL("http://127.0.0.1:8080/api/engine/busy")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 2000
                    conn.readTimeout = 2000
                    try {
                        if (conn.responseCode == 200) {
                            val body = conn.inputStream.bufferedReader().readText()
                            turns = org.json.JSONObject(body).optInt("turns", 0)
                        }
                    } finally {
                        conn.disconnect()
                    }
                } catch (e: Exception) {
                    // Engine down / mid-restart — reads as idle below (a
                    // dead engine holds no wake lock); the log stays quiet
                    // unless it persists (the watchdog owns that story).
                }
                applyBusy(if (turns > 0) turns else 0)
                try { Thread.sleep(5000) } catch (e: InterruptedException) { return@Thread }
            }
        }.also { it.start() }
    }

    // v1.39.2: the gauge→hardware translation. Acquire the PARTIAL wake
    // lock the moment turns go live (screen-off mid-turn no longer pauses
    // the bots); release the moment they drain. The FGS notification says
    // the same truth — "N bots working" while the work is real, "Engine
    // running" when idle (the user-visible receipt that work continued in
    // their absence). Notification updates are debounced by text change.
    private fun applyBusy(turns: Int) {
        busyTurns = turns
        val held = try { wakeLock?.isHeld == true } catch (e: Exception) { false }
        if (turns > 0) {
            if (!held) {
                try {
                    wakeLock?.acquire()
                    AppLog.log("AWAKE ENGINE: partial wake lock acquired ($turns turn(s) live)")
                } catch (e: Exception) {
                    AppLog.error("wake lock acquire failed", e)
                }
            }
        } else {
            if (held) {
                try {
                    wakeLock?.release()
                    AppLog.log("AWAKE ENGINE: partial wake lock released (engine idle)")
                } catch (e: Exception) {
                    AppLog.error("wake lock release failed", e)
                }
            }
        }
        val text = if (turns > 0) "$turns bot${if (turns == 1) "" else "s"} working" else "Engine running"
        if (text != lastNotifText) {
            lastNotifText = text
            try {
                getSystemService(NotificationManager::class.java).notify(1, buildNotification(text))
            } catch (e: Exception) {
                AppLog.error("busy notification update failed", e)
            }
        }
    }

    private var serviceStopping = false

    override fun onDestroy() {
        AppLog.log("EngineService.onDestroy")
        serviceStopping = true
        engineProcess?.destroy()
        // v1.39.2: the stuck-wake-lock law — never leave the CPU held. The
        // gauge reads idle for a dying service; the poll thread exits via
        // serviceStopping.
        try { wakeLock?.release() } catch (e: Exception) { /* already gone */ }
        wakeLock = null
        busyTurns = 0
        // v1.17.2: the Termux bridge loopback server dies with the service.
        bridgeServer?.stop()
        bridgeServer = null
        bridgeUrl = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel("doomalay", "Doomalay Engine", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, "doomalay")
        else Notification.Builder(this)
        return builder
            .setContentTitle("Doomalay")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()
    }
}
