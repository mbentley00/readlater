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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.content.Context
import android.content.Intent
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Surface
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.ArticleEntity
import com.readlater.app.data.RemoteView
import com.readlater.app.tts.TtsService
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

private fun sendTts(context: Context, action: String) {
    context.startService(Intent(context, TtsService::class.java).setAction(action))
}

enum class SortMode(val label: String) {
    NEWEST("Newest first"),
    OLDEST("Oldest first"),
    LONGEST("Longest first"),
    SHORTEST("Shortest first"),
    RANDOM("Random"),
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
    var views by remember { mutableStateOf(repo.cachedViews()) }
    var searchActive by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    // While searching, look across the whole library (incl. archived), not just
    // the current inbox/archive tab.
    val unsorted by remember(showArchived, selectedView, searchActive) {
        if (selectedView != null || searchActive) repo.allArticles() else repo.articles(showArchived)
    }.collectAsState(initial = emptyList())
    val hlCounts by repo.highlightCounts().collectAsState(initial = emptyList())
    var syncing by remember { mutableStateOf(false) }

    var sortMode by remember {
        mutableStateOf(runCatching { SortMode.valueOf(app.settings.listSort) }.getOrDefault(SortMode.NEWEST))
    }
    var sortMenuOpen by remember { mutableStateOf(false) }
    // Stable shuffle so RANDOM doesn't reshuffle on every recomposition; a new
    // seed (re-tapping Random) gives a fresh order. Saveable so the order — and
    // the scroll position — survive navigating into an article and back.
    var shuffleSeed by rememberSaveable { mutableStateOf(0L) }

    // Jump to the top only when the sort actually CHANGES — not when returning
    // to the list (that re-enters composition and would otherwise reset the
    // scroll position the user was at).
    val listState = rememberLazyListState()
    var lastSortKey by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(sortMode, shuffleSeed) {
        val key = "${sortMode.name}:$shuffleSeed"
        if (lastSortKey.isEmpty()) { lastSortKey = key } // first composition — leave position
        else if (key != lastSortKey) { lastSortKey = key; listState.scrollToItem(0) }
    }

    var showViewsDialog by remember { mutableStateOf(false) }
    // Publishers present in the loaded library, most common first (quick-picks).
    val topDomains = remember(unsorted) {
        unsorted.mapNotNull {
            runCatching { Uri.parse(it.url).host }.getOrNull()?.removePrefix("www.")?.takeIf { d -> d.isNotBlank() }
        }.groupingBy { it }.eachCount().entries.sortedByDescending { it.value }.take(15).map { it.key }
    }

    val articles = remember(unsorted, sortMode, selectedView, hlCounts, searchQuery, searchActive, shuffleSeed) {
        val counts = hlCounts.associate { it.articleId to it.n }
        val view = selectedView
        var filtered = if (view != null) {
            unsorted.filter { matchesView(it, view, counts[it.id] ?: 0) }
        } else unsorted
        val q = searchQuery.trim()
        if (searchActive && q.length < 2) {
            filtered = emptyList() // waiting for a query
        } else if (q.length >= 2) {
            filtered = filtered.filter {
                it.title.contains(q, ignoreCase = true) ||
                    (it.excerpt?.contains(q, ignoreCase = true) == true) ||
                    (it.siteName?.contains(q, ignoreCase = true) == true) ||
                    it.url.contains(q, ignoreCase = true)
            }
        }
        when (sortMode) {
            SortMode.NEWEST -> filtered.sortedByDescending { it.savedAt }
            SortMode.OLDEST -> filtered.sortedBy { it.savedAt }
            SortMode.LONGEST -> filtered.sortedByDescending { it.wordCount }
            SortMode.SHORTEST -> filtered.sortedBy { it.wordCount }
            SortMode.RANDOM -> filtered.shuffled(kotlin.random.Random(shuffleSeed))
        }
    }

    // Saved views come from the server; offline we just don't show new ones.
    LaunchedEffect(Unit) {
        runCatching { views = repo.fetchViews() }
    }

    // Playback bar: visible whenever TTS is active, whichever article it's for.
    val ttsState by TtsService.stateFlow.collectAsState()
    val playingArticle by remember(ttsState.articleId) {
        ttsState.articleId?.let { repo.article(it) } ?: flowOf(null)
    }.collectAsState(initial = null)

    fun sync(showErrors: Boolean, full: Boolean = false) {
        if (syncing) return
        scope.launch {
            syncing = true
            val result = repo.syncNow(full)
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
                navigationIcon = {
                    if (searchActive) {
                        IconButton(onClick = { searchActive = false; searchQuery = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = "Close search")
                        }
                    }
                },
                title = {
                    if (searchActive) {
                        TextField(
                            value = searchQuery,
                            onValueChange = { searchQuery = it },
                            placeholder = { Text("Search your library") },
                            singleLine = true,
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Color.Transparent,
                                unfocusedContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                    } else {
                        Text("Earmark")
                    }
                },
                actions = {
                    if (!searchActive) {
                        IconButton(onClick = { searchActive = true }) {
                            Icon(Icons.Filled.Search, contentDescription = "Search")
                        }
                    }
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
                                        // Re-tapping Random reshuffles.
                                        if (mode == SortMode.RANDOM) shuffleSeed = System.currentTimeMillis()
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
                        // Manual refresh does the full reconciliation (incl.
                        // deletions); the automatic on-open sync is a delta.
                        IconButton(onClick = { sync(showErrors = true, full = true) }) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Sync")
                        }
                    }
                }
            )
        },
        bottomBar = {
            val playingId = ttsState.articleId
            if (playingId != null) {
                Surface(tonalElevation = 6.dp, color = MaterialTheme.colorScheme.secondaryContainer) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenArticle(playingId) }
                            .padding(start = 14.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
                    ) {
                        Icon(
                            Icons.Filled.GraphicEq,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = when {
                                    ttsState.preparing -> "PREPARING AUDIO…"
                                    ttsState.isPlaying -> "NOW PLAYING"
                                    else -> "PAUSED"
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Text(
                                text = playingArticle?.title ?: "Loading…",
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        if (ttsState.preparing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp).padding(end = 4.dp),
                                strokeWidth = 2.dp
                            )
                        }
                        IconButton(onClick = {
                            sendTts(context, if (ttsState.isPlaying) TtsService.ACTION_PAUSE else TtsService.ACTION_RESUME)
                        }) {
                            Icon(
                                if (ttsState.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                                contentDescription = "Play or pause"
                            )
                        }
                        IconButton(onClick = { sendTts(context, TtsService.ACTION_STOP) }) {
                            Icon(Icons.Filled.Close, contentDescription = "Stop and dismiss")
                        }
                    }
                }
            }
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // Update banner — checks the server's latest build on open.
            var latest by remember { mutableStateOf<Pair<String, Int>?>(null) }
            var updateDismissed by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) { latest = app.apiClient.latestAppVersion() }
            val newer = latest?.second ?: 0
            if (newer > com.readlater.app.BuildConfig.VERSION_CODE && !updateDismissed) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                runCatching {
                                    context.startActivity(
                                        Intent(
                                            Intent.ACTION_VIEW,
                                            android.net.Uri.parse(
                                                "${app.settings.serverUrl.ifBlank { "https://readlater-mbent.fly.dev" }}/app.apk"
                                            )
                                        )
                                    )
                                }
                            }
                            .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp)
                    ) {
                        Icon(
                            Icons.Filled.SystemUpdate,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Text(
                            text = "Update available — v${latest?.first} · tap to download",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.weight(1f)
                        )
                        IconButton(onClick = { updateDismissed = true }) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "Dismiss",
                                tint = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    }
                }
            }
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
                FilterChip(
                    selected = false,
                    onClick = { showViewsDialog = true },
                    label = { Text("View") },
                    leadingIcon = { Icon(Icons.Filled.Add, contentDescription = "New view", modifier = Modifier.size(18.dp)) }
                )
            }

            if (showViewsDialog) {
                ViewsDialog(
                    views = views,
                    topDomains = topDomains,
                    onDismiss = { showViewsDialog = false },
                    onCreate = { name, view ->
                        scope.launch {
                            runCatching { repo.createView(name, view) }
                                .onSuccess { created ->
                                    runCatching { views = repo.fetchViews() }
                                    selectedView = views.firstOrNull { it.id == created.id } ?: created
                                    showArchived = false
                                    showViewsDialog = false
                                }
                                .onFailure { scope.launch { snackbarHostState.showSnackbar("Couldn't create view (offline?)") } }
                        }
                    },
                    onDelete = { v ->
                        scope.launch {
                            runCatching { repo.deleteView(v.id) }
                            if (selectedView?.id == v.id) selectedView = null
                            runCatching { views = repo.fetchViews() }
                        }
                    }
                )
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
                LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                    itemsIndexed(articles, key = { _, a -> a.id }) { i, article ->
                        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
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

/** Uppercase source label like Readwise (domain / EMAIL / PDF). */
private fun sourceLabel(article: ArticleEntity): String = when {
    article.url.startsWith("email:") -> "EMAIL"
    article.url.startsWith("pdf:") -> "PDF"
    else -> runCatching { Uri.parse(article.url).host }.getOrNull()
        ?.removePrefix("www.")?.uppercase()
        ?: article.siteName?.uppercase() ?: ""
}

private val cardDateFmt = java.text.SimpleDateFormat("MMM d", java.util.Locale.US)
private val cardDateYearFmt = java.text.SimpleDateFormat("MMM d, yyyy", java.util.Locale.US)
private fun cardDate(ms: Long): String {
    if (ms <= 0) return ""
    val cal = java.util.Calendar.getInstance()
    val thisYear = cal.get(java.util.Calendar.YEAR)
    cal.timeInMillis = ms
    return (if (cal.get(java.util.Calendar.YEAR) == thisYear) cardDateFmt else cardDateYearFmt).format(java.util.Date(ms))
}

/** Byline · reading time / progress, Readwise-style footer. */
private fun cardFooter(article: ArticleEntity): String {
    val parts = mutableListOf<String>()
    article.byline?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
    if (article.readParagraph > 0 && article.paragraphCount > 0) {
        val frac = ((article.readParagraph + 1).toFloat() / article.paragraphCount).coerceIn(0.01f, 1f)
        val left = readingMinutes((article.wordCount * (1 - frac)).toInt())
        parts.add("${(frac * 100).roundToInt()}%" + if (left > 0 && frac < 1f) " · $left min left" else "")
    } else {
        val minutes = readingMinutes(article.wordCount)
        if (minutes > 0) parts.add("$minutes min")
    }
    return parts.joinToString(" · ")
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
    val unread = article.readParagraph == 0 && article.ttsParagraph == 0

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        // source (uppercase domain) + overflow menu
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = sourceLabel(article),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                letterSpacing = 0.6.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Box {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(28.dp)) {
                    Icon(
                        Icons.Filled.MoreVert, contentDescription = "More actions",
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(if (article.archived) "Unarchive" else "Archive") },
                        leadingIcon = { Icon(if (article.archived) Icons.Filled.Unarchive else Icons.Filled.Archive, null) },
                        onClick = { menuOpen = false; onToggleArchive() }
                    )
                    DropdownMenuItem(
                        text = { Text(if (article.favorite) "Unfavorite" else "Favorite") },
                        leadingIcon = { Icon(if (article.favorite) Icons.Filled.Star else Icons.Filled.StarBorder, null) },
                        onClick = { menuOpen = false; onToggleFavorite() }
                    )
                    DropdownMenuItem(
                        text = { Text("Delete") },
                        leadingIcon = { Icon(Icons.Filled.Delete, null) },
                        onClick = { menuOpen = false; onDelete() }
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(3.dp))

        Row(verticalAlignment = Alignment.Top) {
            Column(modifier = Modifier.weight(1f)) {
                // title (bold), with an unread dot and a favorite star
                Row(verticalAlignment = Alignment.Top) {
                    if (unread) {
                        Box(
                            modifier = Modifier
                                .padding(top = 8.dp, end = 8.dp)
                                .size(8.dp)
                                .background(MaterialTheme.colorScheme.primary, CircleShape)
                        )
                    }
                    Text(
                        text = article.title.ifBlank { article.url },
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (article.favorite) {
                        Icon(
                            Icons.Filled.Star, contentDescription = "Favorite",
                            tint = MaterialTheme.colorScheme.tertiary,
                            modifier = Modifier.padding(start = 6.dp, top = 3.dp).size(16.dp)
                        )
                    }
                }

                // date · excerpt
                val date = cardDate(article.savedAt)
                val excerpt = article.excerpt?.takeIf { it.isNotBlank() && it != "Fetching…" }
                if (date.isNotBlank() || excerpt != null) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = listOfNotNull(date.ifBlank { null }, excerpt).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            // thumbnail (og:image), Readwise-style
            article.imageUrl?.takeIf { it.isNotBlank() }?.let { img ->
                Spacer(modifier = Modifier.width(12.dp))
                coil.compose.AsyncImage(
                    model = img,
                    contentDescription = null,
                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    modifier = Modifier
                        .size(84.dp)
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                )
            }
        }

        // byline · reading time / progress
        val footer = cardFooter(article)
        if (footer.isNotBlank()) {
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = footer,
                style = MaterialTheme.typography.labelMedium,
                color = if (article.readParagraph > 0) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** Create a saved view (filter set) and manage existing ones. */
@Composable
private fun ViewsDialog(
    views: List<RemoteView>,
    topDomains: List<String>,
    onDismiss: () -> Unit,
    onCreate: (String, RemoteView) -> Unit,
    onDelete: (RemoteView) -> Unit
) {
    var name by remember { mutableStateOf("") }
    var domain by remember { mutableStateOf("") }
    var minWords by remember { mutableStateOf("") }
    var maxWords by remember { mutableStateOf("") }
    var highlighted by remember { mutableStateOf(false) }
    var includeArchived by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Saved views") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                if (views.isNotEmpty()) {
                    Text("Your views", style = MaterialTheme.typography.labelLarge)
                    views.forEach { v ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(v.name, modifier = Modifier.weight(1f))
                            IconButton(onClick = { onDelete(v) }) {
                                Icon(Icons.Filled.Delete, contentDescription = "Delete view")
                            }
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(vertical = 10.dp))
                }
                Text("New view", style = MaterialTheme.typography.labelLarge)
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = domain, onValueChange = { domain = it },
                    label = { Text("Publisher / domain") }, placeholder = { Text("e.g. slate.com") },
                    singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                if (topDomains.isNotEmpty()) {
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        topDomains.forEach { d ->
                            AssistChip(onClick = { domain = d }, label = { Text(d) })
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = minWords, onValueChange = { s -> minWords = s.filter { it.isDigit() } },
                        label = { Text("Min words") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = maxWords, onValueChange = { s -> maxWords = s.filter { it.isDigit() } },
                        label = { Text("Max words") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.weight(1f)
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                    Switch(checked = highlighted, onCheckedChange = { highlighted = it })
                    Spacer(modifier = Modifier.width(8.dp)); Text("Only highlighted")
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = includeArchived, onCheckedChange = { includeArchived = it })
                    Spacer(modifier = Modifier.width(8.dp)); Text("Include archived")
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank(),
                onClick = {
                    onCreate(
                        name.trim(),
                        RemoteView(
                            id = "", name = name.trim(), q = "",
                            domain = domain.trim().removePrefix("www."),
                            highlighted = highlighted,
                            minWords = minWords.toIntOrNull() ?: 0,
                            maxWords = maxWords.toIntOrNull() ?: 0,
                            minHighlights = 0,
                            includeArchived = includeArchived
                        )
                    )
                }
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } }
    )
}
