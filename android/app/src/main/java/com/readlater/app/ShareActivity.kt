package com.readlater.app

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Handles "share a link to Earmark" without ever showing the app. Uses a
 * translucent, no-history theme, so from the user's point of view the share
 * sheet just dismisses and a toast confirms the save.
 *
 * The network call runs on lifecycleScope while this (invisible) activity stays
 * alive, so the save can't be lost to the process being reaped the instant we
 * finish; the toast then finishes it. Completion toasts use the application
 * context so they still appear after finish().
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val shared = intent
            ?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (shared.isEmpty()) { finish(); return }

        val app = application as ReadLaterApp
        if (app.settings.token.isBlank()) {
            Toast.makeText(applicationContext, "Sign in to Earmark in Settings first", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        Toast.makeText(applicationContext, "Saving to Earmark…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val title = app.apiClient.saveUrl(shared)
                Toast.makeText(applicationContext, "Saved: $title", Toast.LENGTH_LONG).show()
                runCatching { app.repository.syncNow() } // pull it into the list
            } catch (e: Exception) {
                Toast.makeText(applicationContext, "Couldn't save: ${e.message ?: "error"}", Toast.LENGTH_LONG).show()
            } finally {
                finish()
            }
        }
    }
}
