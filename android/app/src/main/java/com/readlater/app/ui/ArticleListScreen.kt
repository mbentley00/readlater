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
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FileDownloadOff
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Undo
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

/** A podcast episode: from a subscribed feed (it has audio to fetch), or
 *  shared out of a player (the server names those by the audio's hash). */
private fun ArticleEntity.isPodcast(): Boolean =
    audioUrl != null || url.startsWith(com.readlater.app.data.PodcastFiles.URL_PREFIX)

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

    // Saveable so the current tab/view survives opening an article and coming
    // back (e.g. after archiving) — otherwise you'd be kicked to the inbox.
    var showArchived by rememberSaveable { mutableStateOf(false) }
    // The Problems tab: saves the server flagged as not having worked. They are
    // absent from Inbox and Archive, so this is the only place they show up.
    var showProblems by rememberSaveable { mutableStateOf(false) }
    // The Podcasts tab: unarchived episodes, kept out of the Inbox so an hour
    // of audio doesn't sit among the articles. A setting puts them back.
    var showPodcasts by rememberSaveable { mutableStateOf(false) }
    val podcastsTab = remember { app.settings.podcastsTab }
    val onPodcasts = podcastsTab && showPodcasts
    var selectedViewId by rememberSaveable { mutableStateOf<String?>(null) }
    var views by remember { mutableStateOf(repo.cachedViews()) }
    val selectedView = remember(views, selectedViewId) { views.firstOrNull { it.id == selectedViewId } }
    var searchActive by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    // While searching, look across the whole library (incl. archived), not just
    // the current inbox/archive tab.
    val unsorted by remember(showArchived, showProblems, selectedView, searchActive) {
        when {
            selectedView != null || searchActive -> repo.allArticles()
            showProblems -> repo.problemArticles()
            // Inbox and Podcasts share these rows; `articles` splits them.
            else -> repo.articles(showArchived)
        }
    }.collectAsState(initial = emptyList())
    val hlCounts by repo.highlightCounts().collectAsState(initial = emptyList())
    var syncing by remember { mutableStateOf(false) }

    var sortMode by remember {
        mutableStateOf(runCatching { SortMode.valueOf(app.settings.listSort) }.getOrDefault(SortMode.NEWEST))
    }
    var sortMenuOpen by remember { mutableStateOf(false) }
    // Stable shuffle: the seed survives recomposition AND the order is derived
    // per-article from (seed, id), so the list does not reorder when its
    // contents change. A new seed (re-tapping Random) gives a fresh order.
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

    // How many articles sit behind each chip. Computed once in the background
    // rather than from a live flow: the inbox holds a few hundred articles while
    // the library holds tens of thousands, so keeping the whole library loaded
    // just to size the chips would slow down the screen you look at most. The
    // trade-off is that a count can lag a change by a moment — recomputed after
    // each sync and whenever the views change, which is close enough for a label.
    var inboxCount by remember { mutableStateOf<Int?>(null) }
    var archiveCount by remember { mutableStateOf<Int?>(null) }
    var problemCount by remember { mutableStateOf<Int?>(null) }
    var podcastCount by remember { mutableStateOf<Int?>(null) }
    var viewCounts by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }
    LaunchedEffect(views, syncing) {
        if (syncing) return@LaunchedEffect // recount once it settles, not mid-write
        runCatching { repo.articlesForCounting() }.onSuccess { (all, hl) ->
            inboxCount = all.count { !it.archived && !it.problem && !(podcastsTab && it.isPodcast()) }
            podcastCount = all.count { !it.archived && !it.problem && it.isPodcast() }
            archiveCount = all.count { it.archived }
            problemCount = all.count { it.problem && !it.archived }
            viewCounts = views.associate { v ->
                v.id to all.count { matchesView(it, v, hl[it.id] ?: 0) }
            }
        }
    }
    /** Chip label with its count once known — "Inbox" until then, never "Inbox (…)". */
    fun chipLabel(name: String, n: Int?): String = if (n == null) name else "$name  $n"
    // Publishers present in the loaded library, most common first (quick-picks).
    val topDomains = remember(unsorted) {
        unsorted.mapNotNull {
            runCatching { Uri.parse(it.url).host }.getOrNull()?.removePrefix("www.")?.takeIf { d -> d.isNotBlank() }
        }.groupingBy { it }.eachCount().entries.sortedByDescending { it.value }.take(15).map { it.key }
    }

    val articles = remember(unsorted, sortMode, selectedView, hlCounts, searchQuery, searchActive, shuffleSeed, showArchived, onPodcasts) {
        val counts = hlCounts.associate { it.articleId to it.n }
        val view = selectedView
        var filtered = when {
            view != null -> unsorted.filter { matchesView(it, view, counts[it.id] ?: 0) }
            searchActive || showArchived || showProblems || !podcastsTab -> unsorted
            else -> unsorted.filter { it.isPodcast() == onPodcasts }
        }
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
        // On the plain Archive tab, "newest/oldest" means most-/least-recently
        // archived, so it defaults to what you just archived. Elsewhere it's by
        // when the article was saved. (archivedAt falls back to updatedAt for rows
        // archived before it was tracked, or archived on another device.)
        val archiveOrder = showArchived && !showProblems && view == null && !searchActive
        val timeKey: (ArticleEntity) -> Long =
            if (archiveOrder) { a -> a.archivedAt ?: a.updatedAt } else { a -> a.savedAt }
        when (sortMode) {
            SortMode.NEWEST -> filtered.sortedByDescending(timeKey)
            SortMode.OLDEST -> filtered.sortedBy(timeKey)
            SortMode.LONGEST -> filtered.sortedByDescending { it.wordCount }
            SortMode.SHORTEST -> filtered.sortedBy { it.wordCount }
            SortMode.RANDOM -> filtered.sortedBy { randomOrderKey(shuffleSeed, it.id) }
        }
    }

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

    // ---- The Podcasts tab, Pocket Casts-style: New (not processed yet),
    // Processed, Downloaded — each narrowed to one show by its artwork.
    val podcastPane = onPodcasts && selectedView == null && !searchActive
    var podcasts by remember { mutableStateOf(repo.cachedPodcasts()) }
    var podcastListName by rememberSaveable { mutableStateOf(PodcastList.NEW.name) }
    val podcastList = runCatching { PodcastList.valueOf(podcastListName) }.getOrDefault(PodcastList.NEW)
    var showFilter by rememberSaveable { mutableStateOf<String?>(null) }
    var storedKeys by remember { mutableStateOf<Set<String>>(emptySet()) }
    var downloading by remember { mutableStateOf<Set<String>>(emptySet()) }
    var processing by remember { mutableStateOf<Set<String>>(emptySet()) }
    // Waiting episodes archived or processed here, hidden until the server's
    // list catches up (a refresh mid-request would otherwise bring them back).
    var hiddenWaiting by remember { mutableStateOf<Set<String>>(emptySet()) }
    LaunchedEffect(podcastPane, syncing) {
        if (!podcastsTab || syncing) return@LaunchedEffect
        runCatching { podcasts = repo.fetchPodcasts() }
    }
    val showOf: (ArticleEntity) -> String? = remember(podcasts) {
        val data = podcasts
        val byTitle = data?.shows.orEmpty().associate { it.title.lowercase() to it.id }
        val fn: (ArticleEntity) -> String? = { a ->
            data?.episodeShow?.get(a.id) ?: a.siteName?.lowercase()?.let { byTitle[it] }
        }
        fn
    }
    val waitingAll = remember(podcasts, hiddenWaiting) {
        podcasts?.waiting.orEmpty().filter { "${it.feedId}/${it.guid}" !in hiddenWaiting }
    }
    val waitingShown = remember(waitingAll, showFilter) {
        waitingAll.filter { showFilter == null || it.feedId == showFilter }
    }
    val processedShown = remember(articles, showFilter, showOf) {
        if (showFilter == null) articles else articles.filter { showOf(it) == showFilter }
    }
    val downloadedShown = remember(processedShown, storedKeys) {
        processedShown.filter { repo.isEpisodeStored(storedKeys, it) }
    }
    // Shows with something recent first: a new episode, else a processed one.
    val showsOrdered = remember(podcasts, articles, showOf) {
        val latest = mutableMapOf<String, Long>()
        podcasts?.waiting.orEmpty().forEach { w ->
            val t = w.publishedAt ?: 0L
            if (t > (latest[w.feedId] ?: -1L)) latest[w.feedId] = t
        }
        articles.forEach { a ->
            val s = showOf(a) ?: return@forEach
            if (a.savedAt > (latest[s] ?: -1L)) latest[s] = a.savedAt
        }
        podcasts?.shows.orEmpty().sortedWith(
            compareByDescending<com.readlater.app.data.PodcastShow> { latest[it.id] ?: -1L }
                .thenBy { it.title.lowercase() }
        )
    }
    val newCounts = remember(waitingAll) { waitingAll.groupingBy { it.feedId }.eachCount() }

    // Open an article, first capturing the exact order currently on screen so that
    // queued ("play through") playback started from it follows THIS view rather
    // than the global inbox (see Repository.playQueue / nextAfterInView).
    fun openArticle(id: String) {
        val onScreen = when {
            !podcastPane -> articles
            podcastList == PodcastList.DOWNLOADED -> downloadedShown
            else -> processedShown
        }
        repo.playQueue = onScreen.map { it.id }
        onOpenArticle(id)
    }

    fun processWaiting(ep: com.readlater.app.data.WaitingEpisode) {
        val key = "${ep.feedId}/${ep.guid}"
        processing = processing + key
        scope.launch {
            val r = repo.processEpisode(ep)
            processing = processing - key
            r.onSuccess {
                hiddenWaiting = hiddenWaiting + key
                sync(showErrors = false)
                snackbarHostState.showSnackbar("Processing “${ep.title}” — it moves to Processed")
            }.onFailure {
                snackbarHostState.showSnackbar("Couldn't process it: ${it.message ?: "unknown error"}")
            }
        }
    }

    fun archiveWaiting(ep: com.readlater.app.data.WaitingEpisode) {
        val key = "${ep.feedId}/${ep.guid}"
        hiddenWaiting = hiddenWaiting + key
        scope.launch {
            repo.archiveWaitingEpisode(ep).onFailure {
                hiddenWaiting = hiddenWaiting - key
                snackbarHostState.showSnackbar("Couldn't archive it (offline?)")
                return@launch
            }
            val undo = snackbarHostState.showSnackbar(
                "Archived “${ep.title}”", actionLabel = "Undo",
                duration = androidx.compose.material3.SnackbarDuration.Short,
            )
            if (undo == androidx.compose.material3.SnackbarResult.ActionPerformed) {
                repo.archiveWaitingEpisode(ep, undo = true).onSuccess {
                    runCatching { podcasts = repo.fetchPodcasts() }
                    hiddenWaiting = hiddenWaiting - key
                }
            }
        }
    }

    fun downloadAudio(a: ArticleEntity) {
        if (a.id in downloading) return
        downloading = downloading + a.id
        scope.launch {
            val r = repo.downloadEpisodeAudio(a)
            downloading = downloading - a.id
            storedKeys = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { repo.storedEpisodeKeys() }
            r.onFailure { snackbarHostState.showSnackbar("Download failed: ${it.message ?: "unknown error"}") }
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

    // Which episodes are on the phone: on entering the tab, and as playback
    // starts or stops (pressing play downloads an episode).
    LaunchedEffect(podcastPane, ttsState.articleId, ttsState.preparing, syncing) {
        if (!podcastPane) return@LaunchedEffect
        storedKeys = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { repo.storedEpisodeKeys() }
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
                            .clickable { openArticle(playingId) }
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
                    selected = !showArchived && !showProblems && !onPodcasts && selectedView == null,
                    onClick = { showArchived = false; showProblems = false; showPodcasts = false; selectedViewId = null },
                    label = { Text(chipLabel("Inbox", inboxCount), maxLines = 1) }
                )
                if (podcastsTab) {
                    FilterChip(
                        selected = onPodcasts && selectedView == null,
                        onClick = { showPodcasts = true; showArchived = false; showProblems = false; selectedViewId = null },
                        label = { Text(chipLabel("Podcasts", podcastCount?.plus(waitingAll.size)), maxLines = 1) }
                    )
                }
                FilterChip(
                    selected = showArchived && selectedView == null,
                    onClick = { showArchived = true; showProblems = false; showPodcasts = false; selectedViewId = null },
                    label = { Text(chipLabel("Archive", archiveCount), maxLines = 1) }
                )
                // Hidden until there is something in it — an empty Problems tab
                // is a chip asking about a problem you don't have.
                if ((problemCount ?: 0) > 0 || showProblems) {
                    FilterChip(
                        selected = showProblems && selectedView == null,
                        onClick = { showProblems = true; showArchived = false; showPodcasts = false; selectedViewId = null },
                        label = { Text(chipLabel("Problems", problemCount), maxLines = 1) }
                    )
                }
                views.forEach { v ->
                    FilterChip(
                        selected = selectedView?.id == v.id,
                        onClick = {
                            showProblems = false
                            selectedViewId = if (selectedViewId == v.id) null else v.id
                        },
                        label = { Text(chipLabel(v.name, viewCounts[v.id]), maxLines = 1) }
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
                                    selectedViewId = created.id
                                    showArchived = false
                                    showViewsDialog = false
                                }
                                .onFailure { scope.launch { snackbarHostState.showSnackbar("Couldn't create view (offline?)") } }
                        }
                    },
                    onDelete = { v ->
                        scope.launch {
                            runCatching { repo.deleteView(v.id) }
                            if (selectedViewId == v.id) selectedViewId = null
                            runCatching { views = repo.fetchViews() }
                        }
                    }
                )
            }

            if (podcastPane) {
                val shows = podcasts?.shows.orEmpty()
                val showById = remember(shows) { shows.associateBy { it.id } }
                if (shows.isNotEmpty()) {
                    ShowStrip(showsOrdered, newCounts, showFilter) { showFilter = it }
                }
                Row(
                    modifier = Modifier
                        .padding(horizontal = 16.dp, vertical = 2.dp)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    PodcastList.entries.forEach { l ->
                        val n = when (l) {
                            PodcastList.NEW -> waitingShown.size
                            PodcastList.PROCESSED -> processedShown.size
                            PodcastList.DOWNLOADED -> downloadedShown.size
                        }
                        FilterChip(
                            selected = podcastList == l,
                            onClick = { podcastListName = l.name },
                            label = { Text(chipLabel(l.label, n), maxLines = 1) }
                        )
                    }
                }
                val selShow = showById[showFilter]
                if (selShow != null) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(selShow.title, style = MaterialTheme.typography.titleSmall, maxLines = 1,
                                overflow = TextOverflow.Ellipsis)
                            Text(
                                if (selShow.autoProcess) "New episodes are processed automatically"
                                else "New episodes wait under New for you to pick",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = selShow.autoProcess,
                            onCheckedChange = { on ->
                                scope.launch {
                                    runCatching { app.apiClient.setFeedAutoProcess(selShow.id, on) }
                                        .onSuccess {
                                            podcasts = podcasts?.let { d ->
                                                d.copy(shows = d.shows.map { if (it.id == selShow.id) it.copy(autoProcess = on) else it })
                                            }
                                        }
                                        .onFailure { snackbarHostState.showSnackbar("Couldn't change that (offline?)") }
                                }
                            }
                        )
                    }
                }
                HorizontalDivider(
                    modifier = Modifier.padding(top = 4.dp),
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
                )

                if (podcastList == PodcastList.NEW) {
                    if (waitingShown.isEmpty()) {
                        PodcastEmptyNote(
                            "Nothing new",
                            if (shows.isEmpty()) "Subscribe to a show's feed in Settings."
                            else if (selShow?.autoProcess == true || (selShow == null && shows.all { it.autoProcess }))
                                "Shows set to process automatically skip this list — their new episodes go straight to Processed. " +
                                    "Turn that off for a show to pick its episodes here."
                            else "New episodes from shows you pick by hand appear here."
                        )
                    } else {
                        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                            itemsIndexed(waitingShown, key = { _, e -> "${e.feedId}/${e.guid}" }) { i, ep ->
                                if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                                WaitingEpisodeRow(
                                    ep = ep,
                                    show = showById[ep.feedId],
                                    busy = "${ep.feedId}/${ep.guid}" in processing,
                                    onProcess = { processWaiting(ep) },
                                    onArchive = { archiveWaiting(ep) }
                                )
                            }
                        }
                    }
                } else {
                    val list = if (podcastList == PodcastList.DOWNLOADED) downloadedShown else processedShown
                    if (list.isEmpty()) {
                        PodcastEmptyNote(
                            if (podcastList == PodcastList.DOWNLOADED) "Nothing downloaded" else "No processed episodes",
                            if (podcastList == PodcastList.DOWNLOADED)
                                "Download an episode from its ⋮ menu, or press play on Wi-Fi."
                            else "Process an episode from New, or share one here from your podcast player."
                        )
                    } else {
                        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                            itemsIndexed(list, key = { _, a -> a.id }) { i, article ->
                                if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                                val stored = repo.isEpisodeStored(storedKeys, article)
                                ArticleCard(
                                    article = article,
                                    onOpen = { openArticle(article.id) },
                                    onToggleArchive = { repo.toggleArchive(article) },
                                    onToggleFavorite = { repo.toggleFavorite(article) },
                                    onDelete = { repo.deleteArticle(article) },
                                    shareItems = { close -> ShareMenuItems(article, repo, scope, snackbarHostState, close) },
                                    episode = EpisodeBadge(
                                        transcribing = article.excerpt == "Transcribing…",
                                        downloaded = stored,
                                        downloading = article.id in downloading
                                    ),
                                    extraItems = { close ->
                                        if (stored) {
                                            DropdownMenuItem(
                                                text = { Text("Remove download") },
                                                leadingIcon = { Icon(Icons.Filled.FileDownloadOff, null) },
                                                onClick = {
                                                    close()
                                                    repo.removeEpisodeAudio(article)
                                                    storedKeys = repo.storedEpisodeKeys()
                                                }
                                            )
                                        } else if (article.audioUrl != null && article.id !in downloading) {
                                            DropdownMenuItem(
                                                text = { Text("Download episode") },
                                                leadingIcon = { Icon(Icons.Filled.Download, null) },
                                                onClick = { close(); downloadAudio(article) }
                                            )
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
            } else if (articles.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = when {
                                showArchived -> "No archived articles"
                                onPodcasts -> "No podcast episodes"
                                else -> "Your inbox is empty"
                            },
                            style = MaterialTheme.typography.titleMedium
                        )
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(
                            text = if (onPodcasts)
                                "Share an episode here from your podcast player, or subscribe " +
                                    "to a feed in Settings."
                            else "Save articles with the ReadLater Firefox extension, " +
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
                            onOpen = { openArticle(article.id) },
                            onToggleArchive = { repo.toggleArchive(article) },
                            onToggleFavorite = { repo.toggleFavorite(article) },
                            onDelete = { repo.deleteArticle(article) },
                            shareItems = { close -> ShareMenuItems(article, repo, scope, snackbarHostState, close) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PodcastEmptyNote(title: String, body: String) {
    Box(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.size(8.dp))
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/** Uppercase source label like Readwise (domain / EMAIL / PDF). */
// Newsletters have no host to show (email:<id>, mailto:reader-forwarded-email/…),
// so the server works out which publication they came from and puts it in
// siteName. Prefer that over a bare "EMAIL", which says nothing.
private fun sourceLabel(article: ArticleEntity): String = when {
    article.url.startsWith("pdf:") -> "PDF"
    else -> runCatching { Uri.parse(article.url).host }.getOrNull()
        ?.removePrefix("www.")?.uppercase()
        ?: article.siteName?.uppercase()
        ?: if (article.url.startsWith("email:") || article.url.startsWith("mailto:")) "EMAIL" else ""
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
    onDelete: () -> Unit,
    shareItems: @Composable (closeMenu: () -> Unit) -> Unit,
    /** On the Podcasts tab: processed / downloaded, shown under the title. */
    episode: EpisodeBadge? = null,
    /** Menu entries of its own (an episode's download / remove). */
    extraItems: (@Composable (closeMenu: () -> Unit) -> Unit)? = null
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
                        leadingIcon = {
                            Icon(
                                if (article.archived) Icons.Filled.Undo else Icons.Filled.Archive,
                                null,
                                tint = archiveTint(article.archived)
                            )
                        },
                        onClick = { menuOpen = false; onToggleArchive() }
                    )
                    DropdownMenuItem(
                        text = { Text(if (article.favorite) "Unfavorite" else "Favorite") },
                        leadingIcon = { Icon(if (article.favorite) Icons.Filled.Star else Icons.Filled.StarBorder, null) },
                        onClick = { menuOpen = false; onToggleFavorite() }
                    )
                    extraItems?.invoke { menuOpen = false }
                    shareItems { menuOpen = false }
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

                // Why this one is flagged as a bad save, wherever it turns up.
                if (article.problem) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "⚠ " + (article.problemDetail ?: "This didn't save properly"),
                        style = MaterialTheme.typography.labelMedium,
                        color = problemTint(),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                if (episode != null) {
                    Spacer(modifier = Modifier.height(4.dp))
                    EpisodeBadgeRow(episode)
                }

                // date · excerpt
                val date = cardDate(article.savedAt)
                val excerpt = article.excerpt?.takeIf {
                    it.isNotBlank() && it != "Fetching…" && !(episode != null && it == "Transcribing…")
                }
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

/**
 * Order key for [SortMode.RANDOM]. The position of an article is a hash of
 * (seed, id), so it does not move when anything else in the list changes.
 *
 * `shuffled(Random(seed))` derives the permutation from the list itself, so ANY
 * change to the list re-derived a completely different order — a sync, an
 * archive, or the TTS service writing a listening position, which happens
 * continuously while you listen. That is why Random still looked unstable after
 * the seed was made sticky, and why queued playback stopped after an article or
 * two: the queue is re-captured from the on-screen order, and the article now
 * playing had been thrown to the end of it. Mirrors the server's
 * shuffle(seed, id) SQL, so both clients shuffle the same way.
 */
private fun randomOrderKey(seed: Long, id: String): Long {
    var h = -3750763034362895579L xor seed // FNV-1a 64-bit offset basis, seeded
    for (ch in id) {
        h = h xor ch.code.toLong()
        h *= 1099511628211L // FNV-1a 64-bit prime
    }
    return h
}
