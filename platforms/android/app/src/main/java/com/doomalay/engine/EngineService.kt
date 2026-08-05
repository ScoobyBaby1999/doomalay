package com.doomalay.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File

class EngineService : Service() {
    private var engineProcess: Process? = null

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        AppLog.log("EngineService.onStartCommand")
        startForeground(1, buildNotification())
        startEngine()
        startBrain()
        return START_STICKY
    }

    private fun startEngine() {
        Thread {
            try {
                AppLog.log("=== Starting Go engine ===")
                val binary = EngineBinary.getBinaryPath(this)
                val f = File(binary)
                AppLog.log("Binary: $binary")
                AppLog.log("Exists: ${f.exists()}, Executable: ${f.canExecute()}, Size: ${f.length()}")

                val pb = ProcessBuilder(binary, "--port", "8080", "--bind", "127.0.0.1")
                pb.redirectErrorStream(true)
                engineProcess = pb.start()
                AppLog.log("Go process started, PID: ${engineProcess!!.pid}")

                val reader = engineProcess!!.inputStream.bufferedReader()
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    AppLog.log("[engine] $line")
                }
                AppLog.log("Go engine exited: code=${engineProcess!!.exitValue()}")
            } catch (e: Exception) {
                AppLog.error("Go engine failed", e)
            }
        }.start()
    }

    private fun startBrain() {
        Thread {
            try {
                AppLog.log("=== Starting Python brain ===")
                if (!Python.isStarted()) {
                    Python.start(AndroidPlatform(this))
                    AppLog.log("Chaquopy Python started")
                }
                val py = Python.getInstance()
                AppLog.log("Python instance obtained")

                // Check sys.path
                try {
                    val sys = py.getModule("sys")
                    val path = sys["path"]
                    AppLog.log("sys.path: $path")
                } catch (e: Exception) {
                    AppLog.log("sys.path check failed: ${e.message}")
                }

                // Try to load server_android
                try {
                    val mod = py.getModule("server_android")
                    AppLog.log("server_android module loaded!")
                    AppLog.log("Calling start_server(9090)...")
                    mod.callAttr("start_server", 9090)
                } catch (e: Exception) {
                    AppLog.error("server_android failed", e)
                    // List what's available
                    try {
                        val os = py.getModule("os")
                        val cwd = os.callAttr("getcwd").toString()
                        AppLog.log("CWD: $cwd")
                        val files = os.callAttr("listdir", cwd).toString()
                        AppLog.log("CWD files: $files")
                    } catch (e2: Exception) {
                        AppLog.log("Can't list CWD: ${e2.message}")
                    }
                }
            } catch (e: Exception) {
                AppLog.error("Python brain failed", e)
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
            val ch = NotificationChannel("doomalay", "Doomalay", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, "doomalay")
        else Notification.Builder(this)
        return b.setContentTitle("Doomalay Engine")
            .setContentText("Running")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()
    }
}
