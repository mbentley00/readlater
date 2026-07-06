package com.readlater.app.ui

import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.ArticleEntity
import com.readlater.app.data.RemoteView
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

enum class SortMode(val label: String) {
    NEWEST("Newest first"),
    OLDEST("Oldest first"),
    LONGEST("Longest first"),
    SHORTEST("Shortest first"),
}

/** ~225 words per minute; 0 when the word count is unknown. */
fun readingMinutes(wordCount: Int): Int =
    if (wordCount <= 0) 0 else max(1, (wordCount / 225.0).roundToInt())

/** Local evaluation of a server-defined saved view. `q` matches title/excerpt only. */
private fun matchesView(a: ArticleEntity, v: RemoteView, highlightCount: Int): Boolean {
    if (!v.includeArchived && a.archived) return false
    if (v.domain.isNotBlank()) {
        val host = runCatching { Uri.parse(a.url).host }.getOrNull()
            ?.lowercase()?.removePrefix("www.")
            ?: if (a.url.startsWith("email:")) "email" else if (a.url.startsWith("pdf:")) "" else ""
        val d = v.domain.lowercase().removePrefix("www.")
        if (host != d && !host.orEmpty().endsWith(".$d")) return false
    }
    if (v.minWords > 0 && a.wordCount < v.minWords) return false
    if (v.maxWords > 0 && a.wordCount > v.maxWords) return false
    if (v.minHighlights > 0 && highlightCount < v.minHighlights) return false
    if (v.highlighted && highlightCount == 0) return false
    if (v.q.isNotBlank()) {
        val hay = "${a.title} ${a.excerpt.orEmpty()}".lowercase()
        if (v.q.lowercase().split(Regex("\\s+")).any { it.isNotBlank() && it !in hay }) return false
    }
    return true
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArticleListScreen(
    onOpenArticle: (String) -> Unit,
    onOpenHighlights: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val context = LocalContext.current
    val app = context.applicationContext as ReadLaterApp
    val repo = app.repository
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var showArchived by remember { mutableStateOf(false) }
    var selectedView by remember { mutableStateOf<RemoteView?>(null) }
    var views by remember { mutableStateOf<List<RemoteView>>(emptyList()) }

    val unsorted by remember(showArchived, selectedView) {
        if (selectedView != null) repo.allArticles() else repo.articles(showArchived)
    }.collectAsState(initial = emptyList())
    val hlCounts by repo.highlightCounts().collectAsState(initial = emptyList())
    var syncing by remember { mutableStateOf(false) }

    var sortMode by remember {
        mutableStateOf(runCatching { SortMode.valueOf(app.settings.listSort) }.getOrDefault(SortMode.NEWEST))
    }
    var sortMenuOpen by remember { mutableStateOf(false) }
    val articles = remember(unsorted, sortMode, selectedView, hlCounts) {
        val counts = hlCounts.associate { it.articleId to it.n }
        val view = selectedView
        val filtered = if (view != null) {
            unsorted.filter { matchesView(it, view, counts[it.id] ?: 0) }
        } else unsorted
        when (sortMode) {
            SortMode.NEWEST -> filtered.sortedByDescending { it.savedAt }
            SortMode.OLDEST -> filtered.sortedBy { it.savedAt }
            SortMode.LONGEST -> filtered.sortedByDescending { it.wordCount }
            SortMode.SHORTEST -> filtered.sortedBy { it.wordCount }
        }
    }

    // Saved views come from the server; offline we just don't show new ones.
    LaunchedEffect(Unit) {
        runCatching { views = repo.fetchViews() }
    }

    fun sync(showErrors: Boolean) {
        if (syncing) return
        scope.launch {
            syncing = true
            val result = repo.syncNow()
            syncing = false
            if (showErrors) {
                result.onFailure {
                    snackbarHostState.showSnackbar("Sync failed: ${it.message ?: "unknown error"}")
                }
            }
        }
    }

    // Opportunistic sync on first open (silent — the app stays usable offline).
    LaunchedEffect(Unit) {
        if (app.settings.serverUrl.isNotBlank()) {
            sync(showErrors = false)
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text("ReadLater") },
                actions = {
                    Box {
                        IconButton(onClick = { sortMenuOpen = true }) {
                            Icon(Icons.AutoMirrored.Filled.Sort, contentDescription = "Sort")
                        }
                        DropdownMenu(expanded = sortMenuOpen, onDismissRequest = { sortMenuOpen = false }) {
                            SortMode.entries.forEach { mode ->
                                DropdownMenuItem(
                                    text = { Text(mode.label) },
                                    leadingIcon = {
                                        if (mode == sortMode) {
                                            Icon(Icons.Filled.Check, contentDescription = null)
                                        }
                                    },
                                    onClick = {
                                        sortMode = mode
                                        app.settings.listSort = mode.name
                                        sortMenuOpen = false
                                    }
                                )
                            }
                        }
                    }
                    IconButton(onClick = onOpenHighlights) {
                        Icon(Icons.Filled.FormatQuote, contentDescription = "Highlights")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                    if (syncing) {
                        Box(
                            modifier = Modifier.size(48.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                strokeWidth = 2.dp
                            )
                        }
                    } else {
                        IconButton(onClick = { sync(showErrors = true) }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Sync")
                        }
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Row(
                modifier = Modifier
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                FilterChip(
                    selected = !showArchived && selectedView == null,
                    onClick = { showArchived = false; selectedView = null },
                    label = { Text("Inbox") }
                )
                FilterChip(
                    selected = showArchived && selectedView == null,
                    onClick = { showArchived = true; selectedView = null },
                    label = { Text("Archive") }
                )
                views.forEach { v ->
                    FilterChip(
                        selected = selectedView?.id == v.id,
                        onClick = {
                            selectedView = if (selectedView?.id == v.id) null else v
                        },
                        label = { Text(v.name) }
                    )
                }
            }

            if (articles.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = if (showArchived) "No archived articles" else "Your inbox is empty",
                            style = MaterialTheme.typography.titleMedium
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(
                            text = "Save articles with the ReadLater Firefox extension, " +
                                "then tap refresh to sync them here.",
                            style = MaterialTheme.typography.bodyMedium,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(articles, key = { it.id }) { article ->
                        ArticleCard(
                            article = article,
                            onOpen = { onOpenArticle(article.id) },
                            onToggleArchive = { repo.toggleArchive(article) },
                            onToggleFavorite = { repo.toggleFavorite(article) },
                            onDelete = { repo.deleteArticle(article) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ArticleCard(
    article: ArticleEntity,
    onOpen: () -> Unit,
    onToggleArchive: () -> Unit,
    onToggleFavorite: () -> Unit,
    onDelete: () -> Unit
) {
    var menuOpen by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen)) {
        Column(modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (article.favorite) {
                            Icon(
                                Icons.Filled.Star,
                                contentDescription = "Favorite",
                                tint = MaterialTheme.colorScheme.tertiary,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                        }
                        Text(
                            text = article.title.ifBlank { article.url },
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    val site = article.siteName
                        ?: runCatching { Uri.parse(article.url).host }.getOrNull().orEmpty()
                    val time = DateUtils.getRelativeTimeSpanString(article.savedAt).toString()
                    val minutes = readingMinutes(article.wordCount)
                    Text(
                        text = listOf(site, time, if (minutes > 0) "$minutes min read" else "")
                            .filter { it.isNotBlank() }
                            .joinToString(" • "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More actions")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(if (article.archived) "Unarchive" else "Archive") },
                            leadingIcon = {
                                Icon(
                                    if (article.archived) Icons.Filled.Unarchive else Icons.Filled.Archive,
                                    contentDescription = null
                                )
                            },
                            onClick = {
                                menuOpen = false
                                onToggleArchive()
                            }
                        )
                        DropdownMenuItem(
                            text = { Text(if (article.favorite) "Unfavorite" else "Favorite") },
                            leadingIcon = {
                                Icon(
                                    if (article.favorite) Icons.Filled.Star else Icons.Filled.StarBorder,
                                    contentDescription = null
                                )
                            },
                            onClick = {
                                menuOpen = false
                                onToggleFavorite()
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Delete") },
                            leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null) },
                            onClick = {
                                menuOpen = false
                                onDelete()
                            }
                        )
                    }
                }
            }

            article.excerpt?.takeIf { it.isNotBlank() }?.let { excerpt ->
                Text(
                    text = excerpt,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 6.dp, end = 12.dp)
                )
            }

            if (article.readParagraph > 0) {
                val fraction = if (article.paragraphCount > 0) {
                    ((article.readParagraph + 1).toFloat() / article.paragraphCount).coerceIn(0.01f, 1f)
                } else null
                val label = if (fraction != null) {
                    val minutesLeft = readingMinutes((article.wordCount * (1 - fraction)).toInt())
                    "${(fraction * 100).roundToInt()}% read" +
                        if (minutesLeft > 0 && fraction < 1f) " — $minutesLeft min left" else ""
                } else {
                    "In progress — paragraph ${article.readParagraph + 1}"
                }
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 6.dp)
                )
                if (fraction != null) {
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp, end = 12.dp)
                    )
                }
            }
        }
    }
}
