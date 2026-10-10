package com.readlater.app.ui

import android.content.Context
import android.content.Intent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.readlater.app.data.ArticleEntity
import com.readlater.app.data.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Hand a link to the system share sheet. */
private fun shareLink(context: Context, link: String, title: String) {
    val send = Intent(Intent.ACTION_SEND)
        .setType("text/plain")
        .putExtra(Intent.EXTRA_TEXT, link)
        .putExtra(Intent.EXTRA_SUBJECT, title)
    try {
        context.startActivity(Intent.createChooser(send, null))
    } catch (_: Exception) { /* nothing to share to */ }
}

/**
 * The two "share" entries of an article's overflow menu: the page it was saved
 * from, and the public Earmark copy of it.
 *
 * [scope] is the screen's, not one remembered here: the menu leaves the
 * composition as it closes, which would cancel the request for the Earmark
 * link before it came back.
 */
@Composable
fun ShareMenuItems(
    article: ArticleEntity,
    repo: Repository,
    scope: CoroutineScope,
    snackbarHostState: SnackbarHostState,
    closeMenu: () -> Unit
) {
    val context = LocalContext.current
    // Emails and PDFs have no page to point anyone at.
    if (article.url.startsWith("http://") || article.url.startsWith("https://")) {
        DropdownMenuItem(
            text = { Text("Share original link") },
            leadingIcon = { Icon(Icons.Filled.Share, contentDescription = null) },
            onClick = { closeMenu(); shareLink(context, article.url, article.title) }
        )
    }
    DropdownMenuItem(
        text = { Text("Share Earmark link") },
        leadingIcon = { Icon(Icons.Filled.Link, contentDescription = null) },
        onClick = {
            closeMenu()
            scope.launch {
                runCatching { repo.shareLink(article.id) }
                    .onSuccess { shareLink(context, it, article.title) }
                    .onFailure { snackbarHostState.showSnackbar("Couldn't get an Earmark link (offline?)") }
            }
        }
    )
}
