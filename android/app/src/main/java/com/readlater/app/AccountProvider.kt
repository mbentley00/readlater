package com.readlater.app

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import com.readlater.app.data.Settings

/**
 * Shares the server sign-in between the two apps of the pair — Earmark
 * (articles) and Hark (podcasts) — so signing in to one signs in the other.
 *
 * Each app exposes its own server URL and token here, readable only with the
 * signature-level SHARE_ACCOUNT permission, i.e. only by an app signed with the
 * same key. The other app asks once, when it has no sign-in of its own
 * ([importFromSibling]); after that each keeps its own copy.
 */
class AccountProvider : ContentProvider() {

    companion object {
        private val COLUMNS = arrayOf("serverUrl", "token")

        private fun uriFor(pkg: String): Uri = Uri.parse("content://$pkg.account")

        /**
         * Copy the other app's sign-in into [settings] when this app has none.
         * Returns true when it did. IPC to the other app's process — call off
         * the main thread.
         */
        fun importFromSibling(context: Context, settings: Settings): Boolean {
            if (settings.token.isNotBlank()) return false
            val (url, token) = siblingAccount(context) ?: return false
            settings.serverUrl = url
            settings.token = token
            return true
        }

        /** The other app's (serverUrl, token), or null if it isn't installed or
         *  isn't signed in. */
        fun siblingAccount(context: Context): Pair<String, String>? = runCatching {
            context.contentResolver.query(uriFor(BuildConfig.SIBLING_PACKAGE), null, null, null, null)?.use { c ->
                if (!c.moveToFirst()) return@use null
                val url = c.getString(0).orEmpty()
                val token = c.getString(1).orEmpty()
                if (url.isBlank() || token.isBlank()) null else url to token
            }
        }.getOrNull()

        /** Whether the other app of the pair is on this phone. */
        fun siblingInstalled(context: Context): Boolean = runCatching {
            context.packageManager.getPackageInfo(BuildConfig.SIBLING_PACKAGE, 0); true
        }.getOrDefault(false)
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?
    ): Cursor {
        // Settings, not the app's lazy instance: the provider can be created
        // before Application.onCreate finishes wiring things up.
        val settings = Settings(context!!)
        return MatrixCursor(COLUMNS).apply { addRow(arrayOf(settings.serverUrl, settings.token)) }
    }

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
