package com.doomalay.engine

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * OTA Hot-Patch System for Doomalay.
 *
 * Instead of downloading a 50MB APK for every fix, the app checks GitHub
 * releases for a small patch-manifest.json (~5KB) and downloads only the
 * files that changed. Patches are applied at runtime — no reinstall needed.
 *
 * Patchable files:  Python brain (.py), PWA assets (HTML/JS/CSS), configs
 * Non-patchable:    Kotlin/Java source, native binaries (.so), manifest
 *
 * The engine loads files from the OTA directory first, falling back to
 * bundled assets. A restart of the engine (not the app) applies patches.
 */
object OtaUpdater {

    private const val PREFS_NAME = "doomalay_ota"
    private const val KEY_LAST_CHECK = "last_check_ms"
    private const val KEY_CURRENT_PATCH = "current_patch_version"
    private const val CHECK_INTERVAL_MS = 5 * 60 * 1000L  // 5 min
    private const val GITHUB_RAW = "https://raw.githubusercontent.com/ScoobyBaby1999/doomalay"
    private const val RELEASES_API = "https://api.github.com/repos/ScoobyBaby1999/doomalay/releases/latest"

    /** Directory where patched files live. Engine checks here first. */
    fun getOtaDir(context: Context): File {
        return File(context.filesDir, "ota").also { it.mkdirs() }
    }

    /** Full path to a file, preferring OTA copy if it exists. */
    fun resolvePath(context: Context, relativePath: String): String {
        val ota = File(getOtaDir(context), relativePath)
        return if (ota.exists()) ota.absolutePath else ""
    }

    /** Check if an OTA copy exists for a given relative path. */
    fun hasOtaCopy(context: Context, relativePath: String): Boolean {
        return File(getOtaDir(context), relativePath).exists()
    }

    /**
     * Check for patches. Returns a human-readable status string.
     * This runs on a background thread.
     */
    fun checkAndApply(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val lastCheck = prefs.getLong(KEY_LAST_CHECK, 0)

        if (now - lastCheck < CHECK_INTERVAL_MS) {
            return "OTA: checked recently, skipping (${(now - lastCheck) / 1000}s ago)"
        }
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply()

        AppLog.log("OTA: checking for patches...")

        return try {
            val release = fetchJson(RELEASES_API)
            val tag = release.optString("tag_name", "")
            val currentPatch = prefs.getString(KEY_CURRENT_PATCH, "") ?: ""

            if (tag.isEmpty()) {
                return "OTA: no release tag found"
            }

            // Find patch-manifest.json asset
            val assets = release.optJSONArray("assets") ?: JSONArray()
            var manifestUrl: String? = null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                if (asset.getString("name") == "patch-manifest.json") {
                    manifestUrl = asset.getString("browser_download_url")
                    break
                }
            }

            if (manifestUrl == null) {
                // Fallback: try raw GitHub URL
                manifestUrl = "$GITHUB_RAW/$tag/patch-manifest.json"
                AppLog.log("OTA: no manifest asset, trying raw URL: $manifestUrl")
            }

            val manifest = fetchJson(manifestUrl)
            val patchVersion = manifest.optString("version", tag)

            if (patchVersion == currentPatch) {
                return "OTA: already on latest patch ($patchVersion)"
            }

            AppLog.log("OTA: new patch available: $patchVersion (current: $currentPatch)")
            val files = manifest.optJSONArray("files") ?: JSONArray()
            var downloaded = 0
            var skipped = 0
            var failed = 0

            for (i in 0 until files.length()) {
                val fileObj = files.getJSONObject(i)
                val relPath = fileObj.getString("path")
                val expectedHash = fileObj.getString("sha256")
                val fileUrl = fileObj.getString("url")
                val size = fileObj.optInt("size", 0)

                val localFile = File(getOtaDir(context), relPath)
                localFile.parentFile?.mkdirs()

                // Skip if local hash matches
                if (localFile.exists() && sha256(localFile) == expectedHash) {
                    skipped++
                    continue
                }

                AppLog.log("OTA: downloading $relPath ($size bytes)")
                try {
                    downloadFile(fileUrl, localFile)
                    if (sha256(localFile) == expectedHash) {
                        downloaded++
                        AppLog.log("OTA: OK $relPath")
                    } else {
                        failed++
                        AppLog.error("OTA: hash mismatch for $relPath")
                        localFile.delete()
                    }
                } catch (e: Exception) {
                    failed++
                    AppLog.error("OTA: failed $relPath", e)
                    localFile.delete()
                }
            }

            if (failed == 0) {
                prefs.edit().putString(KEY_CURRENT_PATCH, patchVersion).apply()
                AppLog.log("OTA: patch $patchVersion applied. Downloaded $downloaded, skipped $skipped")
                return "OTA: updated to $patchVersion (+$downloaded files, skipped $skipped)"
            } else {
                AppLog.log("OTA: partial failure — $failed files failed")
                return "OTA: partial update ($downloaded OK, $failed failed, $skipped skipped)"
            }

        } catch (e: Exception) {
            AppLog.error("OTA check failed", e)
            return "OTA error: ${e.message}"
        }
    }

    /** Revert all OTA patches (e.g. if something is broken). */
    fun clearAll(context: Context) {
        getOtaDir(context).deleteRecursively()
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().remove(KEY_CURRENT_PATCH).remove(KEY_LAST_CHECK).apply()
        AppLog.log("OTA: all patches cleared")
    }

    /** List all currently patched files. */
    fun listPatches(context: Context): List<String> {
        val otaDir = getOtaDir(context)
        if (!otaDir.exists()) return emptyList()
        return otaDir.walkTopDown()
            .filter { it.isFile }
            .map { it.relativeTo(otaDir).path }
            .toList()
    }

    // ---- internal ----

    private fun fetchJson(urlString: String): JSONObject {
        val conn = URL(urlString).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        val code = conn.responseCode
        if (code != 200) {
            throw RuntimeException("HTTP $code from $urlString")
        }
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        return JSONObject(body)
    }

    private fun downloadFile(urlString: String, dest: File) {
        val conn = URL(urlString).openConnection() as HttpURLConnection
        conn.connectTimeout = 30000
        conn.readTimeout = 60000
        conn.inputStream.use { input ->
            dest.outputStream().use { output ->
                input.copyTo(output)
            }
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { it.copyTo(digest.outputStream()) }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
