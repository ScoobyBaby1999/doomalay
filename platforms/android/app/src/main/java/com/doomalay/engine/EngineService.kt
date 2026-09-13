package com.doomalay.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class EngineService : Service() {
    private var engineProcess: Process? = null
    @Volatile private var engineRunning = false
    private var restarts = 0

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppLog.log("EngineService.onStartCommand")

        // CRITICAL FIX: use startForeground with FOREGROUND_SERVICE_TYPE_DATA_SYNC
        // on Android 14+ (API 34). On older versions, the type is ignored.
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
        AppLog.log("Foreground service started")

        // v0.15: startEngine() is now guarded — calling onStartCommand twice
        // (app reopen while the service lives) must not double-spawn the
        // binary on port 8080 (the second instance would die and confuse
        // the watchdog).
        if (!engineRunning) startEngine()
        return START_STICKY
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

                val pb = ProcessBuilder(
                    binary,
                    "--port", "8080",
                    "--bind", "127.0.0.1",
                    "--data-dir", dataDir
                )
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

    private var serviceStopping = false

    override fun onDestroy() {
        AppLog.log("EngineService.onDestroy")
        serviceStopping = true
        engineProcess?.destroy()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel("doomalay", "Doomalay Engine", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, "doomalay")
        else Notification.Builder(this)
        return builder
            .setContentTitle("Doomalay")
            .setContentText("Engine running")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()
    }
}
