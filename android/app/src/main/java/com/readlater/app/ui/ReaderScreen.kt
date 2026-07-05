package com.readlater.app.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.readlater.app.ReadLaterApp
import com.readlater.app.data.Block
import com.readlater.app.data.HighlightEntity
import com.readlater.app.data.HtmlParser
import com.readlater.app.tts.TtsService
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.util.Locale

/** What the reader's bottom sheet is currently showing. */
private sealed class SheetTarget {
    data class Create(val index: Int, val text: String) : SheetTarget()
    data class View(val index: Int) : SheetTarget()
}

private fun sendTtsCommand(
    context: Context,
    action: String,
    articleId: String? = null,
    startParagraph: Int? = null
) {
    val intent = Intent(context, TtsService::class.java).setAction(action)
    if (action == TtsService.ACTION_PLAY) {
        intent.putExtra(TtsService.EXTRA_ARTICLE_ID, articleId)
        intent.putExtra(TtsService.EXTRA_START_PARAGRAPH, startParagraph ?: -1)
        // PLAY must go through startForegroundService so the service may promote itself.
        ContextCompat.startForegroundService(context, intent)
    } else {
        context.startService(intent)
    }
}

@OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)
@Composable
fun ReaderScreen(articleId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as ReadLaterApp
    val repo = app.repository
    val settings = app.settings
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    val article by repo.article(articleId).collectAsState(initial = null)
    val highlights by repo.highlightsFor(articleId).collectAsState(initial = emptyList())
    val blocks = remember(article?.html) {
        article?.html?.let { HtmlParser.parse(it) } ?: emptyList()
    }
    val currentBlocks by rememberUpdatedState(blocks)
    val highlightsByPara = remember(highlights) { highlights.groupBy { it.paragraphIndex } }

    val ttsState by TtsService.stateFlow.collectAsState()
    val isTtsThisArticle = ttsState.articleId == articleId

    val listState = rememberLazyListState()
    var didInitialScroll by remember { mutableStateOf(false) }

    // Restore the saved read position once the body is available.
    LaunchedEffect(blocks) {
        if (!didInitialScroll && blocks.isNotEmpty()) {
            val target = (article?.readParagraph ?: 0).coerceIn(0, blocks.size - 1)
            listState.scrollToItem(target)
            didInitialScroll = true
        }
    }

    // Follow the paragraph currently being spoken.
    LaunchedEffect(ttsState.paragraphIndex, ttsState.isPlaying, isTtsThisArticle) {
        if (isTtsThisArticle && ttsState.isPlaying && ttsState.paragraphIndex in blocks.indices) {
            listState.animateScrollToItem(ttsState.paragraphIndex)
        }
    }

    // Continuously persist the scroll position while reading (debounced, local-only;
    // the dirty flag gets it pushed on the next sync). Survives the app being killed
    // mid-read. Suspended while TTS is reading this article — the spoken position wins.
    LaunchedEffect(didInitialScroll, isTtsThisArticle, ttsState.isPlaying) {
        if (!didInitialScroll || (isTtsThisArticle && ttsState.isPlaying)) return@LaunchedEffect
        snapshotFlow { listState.firstVisibleItemIndex }
            .distinctUntilChanged()
            .debounce(800)
            .collect { index ->
                if (currentBlocks.isNotEmpty()) {
                    repo.saveReadPositionLocal(articleId, index.coerceIn(0, currentBlocks.size - 1))
                }
            }
    }

    // Persist the reading position when leaving the screen (works without TTS too).
    DisposableEffect(articleId) {
        onDispose {
            if (didInitialScroll && currentBlocks.isNotEmpty()) {
                val index = listState.firstVisibleItemIndex.coerceIn(0, currentBlocks.size - 1)
                repo.saveReadPosition(articleId, index)
            }
        }
    }

    var speechRate by remember { mutableStateOf(settings.ttsSpeechRate) }
    var sheetTarget by remember { mutableStateOf<SheetTarget?>(null) }
    var menuOpen by remember { mutableStateOf(false) }

    fun changeRate(delta: Float) {
        val newRate = (speechRate + delta).coerceIn(0.5f, 2.0f)
        if (newRate == speechRate) return
        speechRate = newRate
        settings.ttsSpeechRate = newRate
        // Restart the current paragraph so the new rate takes effect immediately.
        if (isTtsThisArticle && ttsState.isPlaying) {
            sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, ttsState.paragraphIndex)
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = article?.title.orEmpty(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    val a = article
                    if (a != null) {
                        IconButton(onClick = { repo.toggleFavorite(a) }) {
                            Icon(
                                if (a.favorite) Icons.Filled.Star else Icons.Filled.StarBorder,
                                contentDescription = if (a.favorite) "Unfavorite" else "Favorite",
                                tint = if (a.favorite) MaterialTheme.colorScheme.tertiary
                                else LocalContentColor.current
                            )
                        }
                        IconButton(onClick = { repo.toggleArchive(a) }) {
                            Icon(
                                if (a.archived) Icons.Filled.Unarchive else Icons.Filled.Archive,
                                contentDescription = if (a.archived) "Unarchive" else "Archive"
                            )
                        }
                        Box {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(
                                expanded = menuOpen,
                                onDismissRequest = { menuOpen = false }
                            ) {
                                DropdownMenuItem(
                                    text = { Text("Open original") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.OpenInBrowser, contentDescription = null)
                                    },
                                    onClick = {
                                        menuOpen = false
                                        try {
                                            context.startActivity(
                                                Intent(Intent.ACTION_VIEW, Uri.parse(a.url))
                                            )
                                        } catch (_: Exception) {
                                            // No browser available — ignore.
                                        }
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text("Delete") },
                                    leadingIcon = {
                                        Icon(Icons.Filled.Delete, contentDescription = null)
                                    },
                                    onClick = {
                                        menuOpen = false
                                        repo.deleteArticle(a)
                                        onBack()
                                    }
                                )
                            }
                        }
                    }
                }
            )
        },
        bottomBar = {
            BottomAppBar {
                IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_PREV) }) {
                    Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous paragraph")
                }
                IconButton(
                    enabled = article?.html != null,
                    onClick = {
                        when {
                            isTtsThisArticle && ttsState.isPlaying ->
                                sendTtsCommand(context, TtsService.ACTION_PAUSE)
                            isTtsThisArticle ->
                                sendTtsCommand(context, TtsService.ACTION_RESUME)
                            else -> sendTtsCommand(
                                context,
                                TtsService.ACTION_PLAY,
                                articleId,
                                article?.readParagraph ?: 0
                            )
                        }
                    }
                ) {
                    Icon(
                        if (isTtsThisArticle && ttsState.isPlaying) Icons.Filled.Pause
                        else Icons.Filled.PlayArrow,
                        contentDescription = "Play or pause"
                    )
                }
                IconButton(onClick = { sendTtsCommand(context, TtsService.ACTION_NEXT) }) {
                    Icon(Icons.Filled.SkipNext, contentDescription = "Next paragraph")
                }
                Spacer(modifier = Modifier.weight(1f))
                IconButton(onClick = { changeRate(-0.25f) }, enabled = speechRate > 0.5f) {
                    Icon(Icons.Filled.Remove, contentDescription = "Slower")
                }
                Text(
                    text = String.format(Locale.US, "%.2f×", speechRate),
                    style = MaterialTheme.typography.labelLarge
                )
                IconButton(onClick = { changeRate(0.25f) }, enabled = speechRate < 2.0f) {
                    Icon(Icons.Filled.Add, contentDescription = "Faster")
                }
            }
        }
    ) { padding ->
        val a = article
        when {
            a == null -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }

            a.html == null -> {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "Not downloaded yet — sync to fetch this article.",
                            style = MaterialTheme.typography.bodyLarge,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(horizontal = 32.dp)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(onClick = {
                            scope.launch {
                                repo.fetchArticleBody(articleId).onFailure {
                                    snackbarHostState.showSnackbar(
                                        "Download failed: ${it.message ?: "unknown error"}"
                                    )
                                }
                            }
                        }) {
                            Text("Download now")
                        }
                    }
                }
            }

            else -> {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)
                ) {
                    itemsIndexed(blocks) { index, block ->
                        BlockItem(
                            block = block,
                            paraHighlights = highlightsByPara[index].orEmpty(),
                            isSpoken = isTtsThisArticle && ttsState.paragraphIndex == index,
                            onLongPress = { text ->
                                sheetTarget = SheetTarget.Create(index, text)
                            },
                            onTap = {
                                if (highlightsByPara.containsKey(index)) {
                                    sheetTarget = SheetTarget.View(index)
                                }
                            }
                        )
                    }
                }
            }
        }
    }

    val target = sheetTarget
    if (target != null) {
        ModalBottomSheet(onDismissRequest = { sheetTarget = null }) {
            when (target) {
                is SheetTarget.Create -> CreateHighlightSheet(
                    initialText = target.text,
                    onPlayFromHere = {
                        sendTtsCommand(context, TtsService.ACTION_PLAY, articleId, target.index)
                        sheetTarget = null
                    },
                    onSave = { text, note ->
                        repo.addHighlight(articleId, text, note, target.index)
                        sheetTarget = null
                    }
                )

                is SheetTarget.View -> ViewHighlightsSheet(
                    highlights = highlightsByPara[target.index].orEmpty(),
                    onDelete = { h -> repo.deleteHighlight(h.clientId, h.serverId) }
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BlockItem(
    block: Block,
    paraHighlights: List<HighlightEntity>,
    isSpoken: Boolean,
    onLongPress: (String) -> Unit,
    onTap: () -> Unit
) {
    when (block) {
        is Block.Heading -> {
            val style = when (block.level) {
                1 -> MaterialTheme.typography.headlineMedium
                2 -> MaterialTheme.typography.headlineSmall
                3 -> MaterialTheme.typography.titleLarge
                else -> MaterialTheme.typography.titleMedium
            }
            Text(
                text = block.text,
                style = style,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.small)
                    .background(
                        if (isSpoken) MaterialTheme.colorScheme.secondaryContainer
                        else Color.Transparent
                    )
                    .padding(vertical = 12.dp)
            )
        }

        is Block.ImageBlock -> {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
            ) {
                Text(
                    text = "[image: ${block.alt ?: block.src}]",
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }

        is Block.Paragraph -> HighlightableText(
            text = block.text,
            isQuote = false,
            paraHighlights = paraHighlights,
            isSpoken = isSpoken,
            onLongPress = onLongPress,
            onTap = onTap
        )

        is Block.Quote -> HighlightableText(
            text = block.text,
            isQuote = true,
            paraHighlights = paraHighlights,
            isSpoken = isSpoken,
            onLongPress = onLongPress,
            onTap = onTap
        )
    }
}

private val HighlightSpanColor = Color(0x66FFE082)
private val HighlightTintColor = Color(0x33FFE082)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HighlightableText(
    text: String,
    isQuote: Boolean,
    paraHighlights: List<HighlightEntity>,
    isSpoken: Boolean,
    onLongPress: (String) -> Unit,
    onTap: () -> Unit
) {
    // Render each highlight whose text is a substring of the paragraph as an inline
    // background span; if any highlight doesn't match, tint the whole paragraph.
    val annotated = remember(text, paraHighlights) {
        buildAnnotatedString {
            append(text)
            for (h in paraHighlights) {
                val start = text.indexOf(h.text)
                if (start >= 0) {
                    addStyle(SpanStyle(background = HighlightSpanColor), start, start + h.text.length)
                }
            }
        }
    }
    val hasUnmatchedHighlight = remember(text, paraHighlights) {
        paraHighlights.any { text.indexOf(it.text) < 0 }
    }
    val backgroundColor = when {
        isSpoken -> MaterialTheme.colorScheme.secondaryContainer
        paraHighlights.isNotEmpty() && hasUnmatchedHighlight -> HighlightTintColor
        else -> Color.Transparent
    }

    if (isQuote) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(MaterialTheme.shapes.small)
                .background(backgroundColor)
                .combinedClickable(onClick = onTap, onLongClick = { onLongPress(text) })
                .height(IntrinsicSize.Min)
        ) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .background(MaterialTheme.colorScheme.primary)
            )
            Text(
                text = annotated,
                style = ReadingTextStyle.copy(fontStyle = FontStyle.Italic),
                modifier = Modifier.padding(start = 14.dp, top = 4.dp, bottom = 4.dp, end = 4.dp)
            )
        }
    } else {
        Text(
            text = annotated,
            style = ReadingTextStyle,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp)
                .clip(MaterialTheme.shapes.small)
                .background(backgroundColor)
                .combinedClickable(onClick = onTap, onLongClick = { onLongPress(text) })
                .padding(4.dp)
        )
    }
}

@Composable
private fun CreateHighlightSheet(
    initialText: String,
    onPlayFromHere: () -> Unit,
    onSave: (text: String, note: String?) -> Unit
) {
    var text by remember(initialText) { mutableStateOf(initialText) }
    var note by remember(initialText) { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("New highlight", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text("Highlighted text (trim to what you want)") },
            minLines = 3,
            maxLines = 8,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note (optional)") },
            modifier = Modifier.fillMaxWidth()
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onPlayFromHere) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null)
                Spacer(modifier = Modifier.width(4.dp))
                Text("Play from here")
            }
            Spacer(modifier = Modifier.weight(1f))
            Button(
                enabled = text.isNotBlank(),
                onClick = { onSave(text.trim(), note.trim().ifBlank { null }) }
            ) {
                Text("Save highlight")
            }
        }
    }
}

@Composable
private fun ViewHighlightsSheet(
    highlights: List<HighlightEntity>,
    onDelete: (HighlightEntity) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Highlights on this paragraph", style = MaterialTheme.typography.titleMedium)
        if (highlights.isEmpty()) {
            Text(
                text = "No highlights here anymore.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        highlights.forEach { h ->
            Row(verticalAlignment = Alignment.Top) {
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
                }
                IconButton(onClick = { onDelete(h) }) {
                    Icon(Icons.Filled.Delete, contentDescription = "Delete highlight")
                }
            }
        }
    }
}
