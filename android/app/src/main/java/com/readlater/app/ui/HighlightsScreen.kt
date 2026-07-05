package com.readlater.app.ui

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.HighlightWithArticle
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HighlightsScreen(
    onBack: () -> Unit,
    onOpenArticle: (String) -> Unit
) {
    val context = LocalContext.current
    val app = context.applicationContext as ReadLaterApp
    val repo = app.repository
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    val clipboard = LocalClipboardManager.current

    val all by repo.allHighlights().collectAsState(initial = emptyList())
    // Group by article while preserving newest-first ordering across groups.
    val grouped = remember(all) {
        val map = LinkedHashMap<String, MutableList<HighlightWithArticle>>()
        for (h in all) map.getOrPut(h.articleId) { mutableListOf() }.add(h)
        map
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("Highlights") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(
                        enabled = all.isNotEmpty(),
                        onClick = {
                            clipboard.setText(AnnotatedString(exportMarkdown(all)))
                            scope.launch {
                                snackbarHostState.showSnackbar(
                                    "Copied ${all.size} highlights as Markdown"
                                )
                            }
                        }
                    ) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Export as Markdown")
                    }
                }
            )
        }
    ) { padding ->
        if (all.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No highlights yet. Long-press a paragraph in the reader to create one.",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                grouped.forEach { (articleId, group) ->
                    item(key = "header_$articleId") {
                        Text(
                            text = group.first().articleTitle,
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onOpenArticle(articleId) }
                                .padding(vertical = 8.dp)
                        )
                    }
                    items(group, key = { it.clientId }) { h ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onOpenArticle(h.articleId) }
                        ) {
                            Row(
                                modifier = Modifier.padding(
                                    start = 12.dp, top = 12.dp, bottom = 12.dp, end = 4.dp
                                ),
                                verticalAlignment = Alignment.Top
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = "“${h.text}”",
                                        style = MaterialTheme.typography.bodyMedium
                                    )
                                    h.note?.takeIf { it.isNotBlank() }?.let { note ->
                                        Text(
                                            text = note,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(top = 4.dp)
                                        )
                                    }
                                    Text(
                                        text = DateUtils.getRelativeTimeSpanString(h.createdAt)
                                            .toString(),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 4.dp)
                                    )
                                }
                                IconButton(onClick = {
                                    repo.deleteHighlight(h.clientId, h.serverId)
                                }) {
                                    Icon(Icons.Filled.Delete, contentDescription = "Delete highlight")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Format: `## Article title` then `> quote` then the optional note, per highlight. */
private fun exportMarkdown(all: List<HighlightWithArticle>): String {
    val grouped = LinkedHashMap<String, MutableList<HighlightWithArticle>>()
    for (h in all) grouped.getOrPut(h.articleTitle) { mutableListOf() }.add(h)

    val sb = StringBuilder()
    for ((title, group) in grouped) {
        sb.append("## ").append(title).append("\n\n")
        for (h in group) {
            sb.append("> ").append(h.text.replace("\n", "\n> ")).append("\n\n")
            if (!h.note.isNullOrBlank()) {
                sb.append(h.note).append("\n\n")
            }
        }
    }
    return sb.toString().trimEnd() + "\n"
}
