package com.doomalay.engine

import android.content.Context
import java.io.File

object EngineBinary {
    fun getBinaryPath(context: Context): String {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val binary = File(nativeDir, "libdoomalayengine.so")
        if (!binary.exists()) throw RuntimeException("Go binary not found: ${binary.absolutePath}")
        if (!binary.canExecute()) binary.setExecutable(true)
        return binary.absolutePath
    }
}
