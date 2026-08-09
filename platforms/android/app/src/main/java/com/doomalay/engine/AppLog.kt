package com.doomalay.engine

import android.content.Context
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.*

object AppLog {
    private const val TAG = "Doomalay"
    private lateinit var logFile: File
    private val df = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun init(context: Context) {
        logFile = File(context.filesDir, "doomalay.log")
        log("=== AppLog init. File: ${logFile.absolutePath} ===")
    }

    fun log(msg: String) {
        val line = "[${df.format(Date())}] $msg"
        Log.i(TAG, line)
        try { logFile.appendText(line + "\n") } catch (_: Exception) {}
    }

    fun error(msg: String, t: Throwable? = null) {
        val sw = StringWriter()
        sw.write("[${df.format(Date())}] ERROR: $msg\n")
        if (t != null) { sw.write("${t.javaClass.name}: ${t.message}\n"); t.printStackTrace(PrintWriter(sw)) }
        val line = sw.toString()
        Log.e(TAG, line)
        try { logFile.appendText(line) } catch (_: Exception) {}
    }

    fun read(): String = try { logFile.readText() } catch (e: Exception) { "No log: ${e.message}" }
    fun tail(n: Int): String = read().lines().takeLast(n).joinToString("\n")
}
