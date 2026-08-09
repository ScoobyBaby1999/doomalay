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

        startEngine()
        return START_STICKY
    }

    private fun startEngine() {
        Thread {
            try {
                AppLog.log("=== Starting Go engine ===")
                val binary = EngineBinary.getBinaryPath(this)
                val f = java.io.File(binary)
                AppLog.log("Binary: $binary exists=${f.exists()} size=${f.length()} exec=${f.canExecute()}")

                val pb = ProcessBuilder(binary, "--port", "8080", "--bind", "127.0.0.1")
                pb.redirectErrorStream(true)
                engineProcess = pb.start()
                AppLog.log("Go process started")

                val reader = engineProcess!!.inputStream.bufferedReader()
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    AppLog.log("[engine] $line")
                }
                AppLog.log("Go engine exited")
            } catch (e: Exception) {
                AppLog.error("Go engine failed", e)
            }
        }.start()
    }

    override fun onDestroy() {
        AppLog.log("EngineService.onDestroy")
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
