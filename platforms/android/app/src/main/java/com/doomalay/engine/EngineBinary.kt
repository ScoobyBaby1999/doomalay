package com.doomalay.engine

import android.content.Context
import java.io.File

/**
 * Resolves the Go engine binary path from the app's nativeLibraryDir.
 *
 * Android extracts .so files from jniLibs/ to nativeLibraryDir at install time.
 * The Go binary is named libdoomalayengine.so (the lib prefix + .so extension
 * are required for Android to extract it). We mark it executable and return
 * its path.
 */
object EngineBinary {

    /**
     * Get the absolute path to the Go engine binary.
     * Throws if the binary is not found.
     */
    fun getBinaryPath(context: Context): String {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val binary = File(nativeDir, "libdoomalayengine.so")

        if (!binary.exists()) {
            throw RuntimeException("Go engine binary not found at ${binary.absolutePath}")
        }

        // Mark as executable (Android may not set the +x bit).
        if (!binary.canExecute()) {
            binary.setExecutable(true)
        }

        return binary.absolutePath
    }
}
