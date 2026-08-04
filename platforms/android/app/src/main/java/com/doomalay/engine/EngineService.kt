package com.doomalay.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File

/**
 * The foreground service that keeps the Doomalay engine + brain alive.
 *
 * On start:
 *   1. Extracts + starts the Go engine binary (libdoomalayengine.so)
 *   2. Starts the Python brain (Chaquopy) on a background thread
 *   3. Shows a persistent notification (required by Android)
 *
 * On destroy:
 *   1. Stops the Go engine process
 *   2. The Python brain stops with the process
 *
 * The service runs as foregroundServiceType="dataSync" (Android 14+ requirement).
 * START_STICKY tells Android to restart the service if killed.
 */
class EngineService : Service() {

    private var engineProcess: Process? = null
    private val channelId = "doomalay_engine"
    private val notificationId = 1

    companion object {
        private const val TAG = "DoomalayEngine"
        private const val ENGINE_PORT = 8080
        private const val BRAIN_PORT = 9090
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(notificationId, notification)

        // Start the Go engine + Python brain.
        startEngine()
        startBrain()

        return START_STICKY
    }

    /** Start the Go engine binary (libdoomalayengine.so → ProcessBuilder). */
    private fun startEngine() {
        Thread {
            try {
                val binary = EngineBinary.getBinaryPath(this)
                Log.i(TAG, "Starting Go engine: $binary")

                val pb = ProcessBuilder(
                    binary,
                    "--port", ENGINE_PORT.toString(),
                    "--bind", "127.0.0.1"
                )
                pb.redirectErrorStream(true)
                engineProcess = pb.start()

                // Log engine output (goes to logcat).
                val reader = engineProcess!!.inputStream.bufferedReader()
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    Log.i(TAG, "engine: $line")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start Go engine", e)
            }
        }.start()
    }

    /** Start the Python brain (Chaquopy) on a background thread. */
    private fun startBrain() {
        Thread {
            try {
                if (!Python.isStarted()) {
                    Python.start(AndroidPlatform(this))
                }
                val py = Python.getInstance()
                Log.i(TAG, "Starting Python brain on port $BRAIN_PORT")
                // This calls server_android.start_server(9090) which blocks
                // this thread forever (running the HTTP server).
                py.getModule("server_android").callAttr("start_server", BRAIN_PORT)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start Python brain", e)
            }
        }.start()
    }

    override fun onDestroy() {
        engineProcess?.destroy()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(getString(R.string.notification_text))
                .setSmallIcon(R.drawable.ic_notification)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(getString(R.string.notification_text))
                .setSmallIcon(R.drawable.ic_notification)
                .setOngoing(true)
                .build()
        }
    }
}
